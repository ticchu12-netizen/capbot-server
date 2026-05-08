/**
 * Capbot autonomous battle simulator — JS port of:
 *   - BattleCharacter.cs (stat blocks, moves, passives, intimidateCount, debuff system)
 *   - BattleUtils.cs     (CalculateDamage, GetTypeEffectiveness, ApplyMoveEffect)
 *   - AIBrain.cs         (192-input observation, ONNX inference, Bayesian opponent
 *                         modeling, MCTS planning, 4 hard-coded override rules)
 *
 * Both sides of every battle use the same brain (the .onnx was trained on all 3
 * types in random matchups). Each character has its own AiBrain instance tracking
 * its OWN view of the opponent — no shared state.
 *
 * Faithful to the C# source: same stats, same damage formula, same passive %,
 * same Intimidate ramp logic (9 + intimidateCount, fall back to 1 at 65%, Fire
 * uses effective debuff %), same MCTS scoring (50 sims, RL bias 20×, type-adv
 * Intimidate boost 5, opp-survival passive penalty), same override rule order.
 *
 * Returns: true if capbot won, false otherwise.
 */

const { pickMoveViaOnnx } = require('./brain');

// ============================================================
// CONSTANTS (mirror BattleCharacter.cs / BattleUtils.cs exactly)
// ============================================================
const TYPE = { FIRE: 0, WATER: 1, GRASS: 2, NORMAL: 3 };
const TYPE_NAME = ['Fire', 'Water', 'Grass', 'Normal'];

const STATS = {
    [TYPE.FIRE]:  { maxHP: 380, attack: 105, defense: 55, speed: 115 },
    [TYPE.WATER]: { maxHP: 400, attack:  85, defense: 80, speed:  75 },
    [TYPE.GRASS]: { maxHP: 350, attack:  90, defense: 60, speed: 100 },
};

// 5 moves per type — index 4 (Heal) starts pp=0 so it's permanently disabled
// unless explicitly granted (revive flow). Brain only ever picks from 0..3.
function makeMoves(type) {
    const typeAttackName = type === TYPE.FIRE  ? 'Ember'
                         : type === TYPE.WATER ? 'Watergun'
                         : 'Vine Whip';
    const ultName        = type === TYPE.FIRE  ? 'Fire Blaze'
                         : type === TYPE.WATER ? 'Hydroblast'
                         : 'Leaf Storm';
    return [
        { name: 'Headbutt',     type: TYPE.NORMAL, power: 30, pp: -1, isStatus: false },
        { name: typeAttackName, type,              power: 30, pp: -1, isStatus: false },
        { name: 'Intimidate',   type: TYPE.NORMAL, power: 0,  pp: -1, isStatus: true  },
        { name: ultName,        type,              power: 60, pp: 1,  isStatus: false },
        { name: 'Heal',         type: TYPE.NORMAL, power: 0,  pp: 0,  isStatus: true  },
    ];
}

function nameToType(name) {
    if (name === 'Rageblaze') return TYPE.FIRE;
    if (name === 'Tsunami')   return TYPE.WATER;
    if (name === 'Healspike') return TYPE.GRASS;
    return TYPE.NORMAL;
}

function createCharacter(type) {
    const s = STATS[type];
    return {
        type,
        maxHP: s.maxHP, currentHP: s.maxHP,
        attack: s.attack,
        defense: s.defense, baseDefense: s.defense,
        speed: s.speed,     baseSpeed: s.speed,
        defenseStage: 0,
        defenseDebuffPercentage: 0,
        speedDebuffPercentage: 0,
        intimidateCount: 0,
        moves: makeMoves(type),
        lastUsedMove: null,
        isDefeated: false,
    };
}

// ============================================================
// BATTLE MATH (port of BattleUtils.cs)
// ============================================================
function getTypeEffectiveness(attackType, defType) {
    if (attackType === defType) return 1;
    if (attackType === TYPE.FIRE)  { if (defType === TYPE.GRASS) return 1.05; if (defType === TYPE.WATER) return 0.8; }
    if (attackType === TYPE.WATER) { if (defType === TYPE.FIRE)  return 1.05; if (defType === TYPE.GRASS) return 0.8; }
    if (attackType === TYPE.GRASS) { if (defType === TYPE.WATER) return 1.05; if (defType === TYPE.FIRE)  return 0.8; }
    return 1;
}

function getDefenseMultiplier(ch) {
    if (ch.defenseStage >= 0) return (2 + ch.defenseStage) / 2;
    return 2 / (2 + -ch.defenseStage);
}

function calculateDamage(attacker, defender, move) {
    if (move.power === 0) return { damage: 0, isCritical: false };
    const baseDamage = (move.power * attacker.attack) / (defender.defense * getDefenseMultiplier(defender));
    const typeEff = getTypeEffectiveness(move.type, defender.type);
    const stab    = (move.type === attacker.type) ? 1.05 : 1;
    const critChance = (move.name === 'Headbutt') ? 0.15 : 0.1;
    const isCritical = Math.random() < critChance;
    const crit    = isCritical ? 1.5 : 1;
    const totalModifier = typeEff * stab * crit;
    const randomNum = Math.floor(Math.random() * 39) + 217; // 217..255 inclusive
    const randomFactor = randomNum / 255;
    const damage = Math.floor(baseDamage * totalModifier * randomFactor);
    return { damage, isCritical };
}

function applyDamage(ch, dmg) {
    ch.currentHP -= dmg;
    if (ch.currentHP <= 0) { ch.currentHP = 0; ch.isDefeated = true; }
}
function applyHeal(ch, amount) {
    ch.currentHP += amount;
    if (ch.currentHP > ch.maxHP) ch.currentHP = ch.maxHP;
}
function applyDefenseChange(ch, newDef) { ch.defense = Math.min(newDef, ch.baseDefense * 3); }
function applySpeedChange(ch, newSpd)   { ch.speed   = Math.min(newSpd, ch.baseSpeed * 3); }

function applyMoveEffect(user, target, move) {
    if (move.name === 'Intimidate') {
        if (target.defenseDebuffPercentage < 65) {
            target.intimidateCount++;
            let debuffAmount = 9 + target.intimidateCount; // normal ramp

            if (target.type === TYPE.FIRE) {
                // Fire-specific: switch to 1% increments once EFFECTIVE debuff hits 65%
                const effectiveDebuffPct = (target.baseDefense - target.defense) / target.baseDefense * 100;
                if (effectiveDebuffPct >= 65) debuffAmount = 1;
            } else {
                if (target.defenseDebuffPercentage >= 65) debuffAmount = 1;
            }

            target.defenseDebuffPercentage += debuffAmount;
            if (target.defenseDebuffPercentage > 65) target.defenseDebuffPercentage = 65;

            const newDef = Math.floor(target.baseDefense * (1 - target.defenseDebuffPercentage / 100));
            applyDefenseChange(target, newDef);
        }
        // else: max-debuff branch is a no-op in the sim (just skips the empty-turn animation in C#)
    } else if (move.name === 'Heal') {
        applyHeal(user, Math.floor(user.maxHP * 0.25));
    }
}

function applyPassive(ch) {
    if (ch.isDefeated) return;
    if (ch.type === TYPE.GRASS) {
        const heal = Math.floor(ch.maxHP * 0.05);
        if (heal > 0) applyHeal(ch, heal);
    } else if (ch.type === TYPE.WATER) {
        const inc = Math.floor(ch.baseSpeed * 0.05);
        if (inc > 0) applySpeedChange(ch, ch.speed + inc);
    } else if (ch.type === TYPE.FIRE) {
        const inc = Math.floor(ch.baseDefense * 0.05);
        if (inc > 0) applyDefenseChange(ch, ch.defense + inc);
    }
}

function isMoveUsable(ch, idx) {
    if (idx < 0 || idx >= ch.moves.length) return false;
    const m = ch.moves[idx];
    return m.pp === -1 || m.pp > 0;
}

// Map a Move object back to its categorical index 0..3 (matches AIBrain.GetMoveIdx)
function getMoveIdx(move) {
    if (!move) return -1;
    if (move.name === 'Headbutt')   return 0;
    if (move.type === TYPE.FIRE || move.type === TYPE.WATER || move.type === TYPE.GRASS) return 1;
    if (move.name === 'Intimidate') return 2;
    return 3;
}

// ============================================================
// AI BRAIN (port of AIBrain.cs)
// ============================================================
function createAiBrain() {
    return {
        oppMoveProbs:    [0.25, 0.25, 0.25, 0.25],
        oppPPEstimates:  [1, 1, 1, 1],
        oppTypeProbs:    { [TYPE.FIRE]: 0.33, [TYPE.WATER]: 0.33, [TYPE.GRASS]: 0.34 },
        obsQueue:        [],
        currentTurn:     0,
        hasUsedUlt:      false,
    };
}

function updateOppModel(brain, oppLastMove) {
    if (!oppLastMove) return;
    const idx = getMoveIdx(oppLastMove);
    if (idx < 0) return;
    brain.oppMoveProbs[idx] += 0.1;
    const sum = brain.oppMoveProbs.reduce((a, b) => a + b, 0);
    for (let m = 0; m < 4; m++) brain.oppMoveProbs[m] /= sum;
}

function updateOppPPEstimates(brain, oppLastMove) {
    if (!oppLastMove) return;
    const idx = getMoveIdx(oppLastMove);
    if (idx < 0) return;
    brain.oppPPEstimates[idx] = Math.max(0, brain.oppPPEstimates[idx] - 0.2);
}

function updateOppTypeProbs(brain, opp) {
    if (!opp.lastUsedMove) return;
    const types = [TYPE.FIRE, TYPE.WATER, TYPE.GRASS];
    const priorSum = types.reduce((s, t) => s + brain.oppTypeProbs[t], 0);
    for (const t of types) {
        const lh = getTypeEffectiveness(opp.lastUsedMove.type, t);
        brain.oppTypeProbs[t] = (brain.oppTypeProbs[t] * lh) / priorSum;
    }
    const newSum = types.reduce((s, t) => s + brain.oppTypeProbs[t], 0);
    for (const t of types) brain.oppTypeProbs[t] /= newSum;
}

function estimateCritProb(ch) {
    if (!ch.moves || ch.moves.length === 0) return 0;
    let s = 0;
    for (const m of ch.moves) s += m.power > 50 ? 0.1 : 0.05;
    return s / ch.moves.length;
}

function estimatePassiveValue(type) {
    if (type === TYPE.GRASS || type === TYPE.WATER || type === TYPE.FIRE) return 0.05;
    return 0;
}

// 64-dim per-frame observation, then stack last 3 frames (oldest first) → 192-dim
function buildObservation(brain, self, opp) {
    const obs = new Array(64).fill(0);
    let i = 0;

    obs[i++] = self.currentHP / self.maxHP;
    obs[i++] = self.speed / 150;
    obs[i++] = self.defense / 150;
    obs[i++] = self.intimidateCount / 10;
    obs[i++] = self.defenseDebuffPercentage / 100;
    obs[i++] = self.speedDebuffPercentage / 100;
    obs[i++] = opp.currentHP / opp.maxHP;
    obs[i++] = opp.speed / 150;
    obs[i++] = opp.defense / 150;
    obs[i++] = opp.defenseDebuffPercentage / 100;

    // Move usability + value + isStatus (3 per move = 12)
    for (let m = 0; m < 4; m++) {
        const move = self.moves[m];
        obs[i++] = (move.pp > 0 || move.pp === -1) ? 1 : 0;
        let p = move.power / 100;
        if (move.name === 'Intimidate') p = opp.defenseDebuffPercentage < 75 ? 0.6 : 0.05;
        const stab = move.type === self.type ? 1.05 : 1;
        const eff  = getTypeEffectiveness(move.type, opp.type);
        obs[i++] = p * stab * eff;
        obs[i++] = move.isStatus ? 1 : 0;
    }
    // Normalized PP for conservation (1 per move)
    for (let m = 0; m < 4; m++) {
        const move = self.moves[m];
        obs[i++] = (move.pp === -1) ? 1 : move.pp / 1;
    }
    obs[i++] = self.speed >= opp.speed ? 1 : 0;
    obs[i++] = brain.currentTurn / 50;

    updateOppTypeProbs(brain, opp);
    obs[i++] = brain.oppTypeProbs[TYPE.FIRE];
    obs[i++] = brain.oppTypeProbs[TYPE.WATER];
    obs[i++] = brain.oppTypeProbs[TYPE.GRASS];

    // Last move one-hot (own + opp, 4 each)
    for (let j = 0; j < 4; j++) obs[i++] = (self.lastUsedMove && getMoveIdx(self.lastUsedMove) === j) ? 1 : 0;
    for (let j = 0; j < 4; j++) obs[i++] = (opp.lastUsedMove  && getMoveIdx(opp.lastUsedMove)  === j) ? 1 : 0;

    // Type one-hot (own + opp, 3 each — Normal not represented)
    for (let j = 0; j < 3; j++) obs[i++] = (self.type === j) ? 1 : 0;
    for (let j = 0; j < 3; j++) obs[i++] = (opp.type  === j) ? 1 : 0;

    obs[i++] = estimateCritProb(self);
    obs[i++] = estimatePassiveValue(self.type);
    // remaining indices already 0

    // Stack: shift queue, append current, take last 3 (oldest first)
    brain.obsQueue.push(obs.slice());
    if (brain.obsQueue.length > 3) brain.obsQueue.shift();

    const stacked = new Array(192).fill(0);
    let offset = (3 - brain.obsQueue.length) * 64; // pre-pad if fewer than 3 frames
    for (let k = 0; k < brain.obsQueue.length; k++) {
        for (let z = 0; z < 64; z++) stacked[offset + z] = brain.obsQueue[k][z];
        offset += 64;
    }
    return stacked;
}

// Non-mutating damage estimate used by MCTS + override rules. Mirrors AIBrain.SimulateDamage.
function simulateDamage(attacker, defender, move, applyPassiveSim) {
    let simDefDebuff = defender.defenseDebuffPercentage;
    let simDef = defender.defense * (1 - simDefDebuff / 100);
    if (move.name === 'Intimidate' && simDefDebuff < 75) {
        simDefDebuff = Math.min(simDefDebuff + 10, 75);
        simDef = defender.baseDefense * (1 - simDefDebuff / 100);
    }
    let damage = 0;
    if (move.power > 0) {
        const typeEff = getTypeEffectiveness(move.type, defender.type);
        const stab    = (move.type === attacker.type) ? 1.05 : 1;
        const crit    = Math.random() < 0.05 ? 1.5 : 1;
        damage = (move.power * attacker.attack / Math.max(simDef, 1)) * typeEff * stab * crit;
    }
    if (applyPassiveSim) {
        if (attacker.type === TYPE.GRASS) damage += attacker.maxHP * 0.05;
        else if (attacker.type === TYPE.WATER || attacker.type === TYPE.FIRE) damage *= 1.05;
    }
    return damage;
}

function sampleOppMove(brain) {
    const r = Math.random();
    let s = 0;
    for (let m = 0; m < 4; m++) {
        s += brain.oppMoveProbs[m] * brain.oppPPEstimates[m];
        if (r < s) return m;
    }
    return 0;
}

// 50 sims per move, score = avg(myDmg - oppDmg) + RL bias + Intimidate type-adv boost
function mctsPlanning(brain, self, opp, rlProbs) {
    const SIMS = 50;
    const scores = [0, 0, 0, 0];
    const typeAdv = getTypeEffectiveness(self.type, opp.type) - getTypeEffectiveness(opp.type, self.type);
    for (let m = 0; m < 4; m++) {
        let total = 0;
        for (let sim = 0; sim < SIMS; sim++) {
            const oppMoveIdx = sampleOppMove(brain);
            const myDmg  = simulateDamage(self, opp, self.moves[m], true);
            const oppDmg = simulateDamage(opp, self, opp.moves[oppMoveIdx], false);
            let s = (myDmg - oppDmg) + rlProbs[m] * 20;
            if (m === 2 && typeAdv < 0) s += 5;
            if (oppDmg < opp.currentHP * 0.3) s += estimatePassiveValue(opp.type) * -2;
            total += s;
        }
        scores[m] = total / SIMS;
    }
    let best = 0;
    for (let m = 1; m < 4; m++) if (scores[m] > scores[best]) best = m;
    return best;
}

async function chooseMove(brain, self, opp) {
    if (opp.lastUsedMove) {
        updateOppModel(brain, opp.lastUsedMove);
        updateOppPPEstimates(brain, opp.lastUsedMove);
    }
    brain.currentTurn++;

    const validMoves = [];
    for (let i = 0; i < 4; i++) if (isMoveUsable(self, i)) validMoves.push(i);
    if (validMoves.length === 0) return 0; // safety — Headbutt has -1 PP so this never trips

    // RL policy: ONNX argmax → one-hot rlProbs; on failure fall back to uniform
    const stacked = buildObservation(brain, self, opp);
    const masks = [
        isMoveUsable(self, 0) ? 1 : 0,
        isMoveUsable(self, 1) ? 1 : 0,
        isMoveUsable(self, 2) ? 1 : 0,
        isMoveUsable(self, 3) ? 1 : 0,
    ];

    let rlProbs;
    try {
        const actionIdx = await pickMoveViaOnnx(stacked, masks);
        rlProbs = [0, 0, 0, 0];
        if (actionIdx >= 0 && actionIdx < 4) rlProbs[actionIdx] = 1;
        else rlProbs = [0.25, 0.25, 0.25, 0.25];
    } catch (err) {
        console.warn('[brain] inference failed, uniform fallback:', err.message);
        rlProbs = [0.25, 0.25, 0.25, 0.25];
    }

    const probs = rlProbs.slice();
    for (let i = 0; i < 4; i++) if (!isMoveUsable(self, i)) probs[i] = 0;

    let bestMove = mctsPlanning(brain, self, opp, probs);

    // ---- Hard-coded override rules (applied AFTER MCTS, mirror C# order) ----
    const oppHpNorm = opp.currentHP / opp.maxHP;
    const debuffPct = opp.defenseDebuffPercentage;
    const typeAdv   = getTypeEffectiveness(self.type, opp.type) - getTypeEffectiveness(opp.type, self.type);

    // Ultimate: must use at least once per battle, but NEVER as the first 5 moves
    if (!brain.hasUsedUlt && isMoveUsable(self, 3) && brain.currentTurn > 5) {
        const ultDmg = simulateDamage(self, opp, self.moves[3], false);
        const isOneShot = opp.currentHP <= ultDmg;
        const nearEnd   = opp.currentHP <= ultDmg + 30;
        if (isOneShot || nearEnd || (self.currentHP / self.maxHP) < 0.4) {
            bestMove = 3;
            brain.hasUsedUlt = true;
        }
    }
    // Rule 1: save ult for finishing blow
    else if (isMoveUsable(self, 3) && oppHpNorm <= 0.30 && debuffPct >= 40) {
        bestMove = 3;
    }
    // Rule 2: force Intimidate stacking when type-disadvantaged
    else if (typeAdv < 0 && debuffPct < 55) {
        bestMove = 2;
    }
    // Rule 3: stop intimidating, swing for KO
    else if (debuffPct >= 55) {
        const estDmg = simulateDamage(self, opp, self.moves[1], false);
        if (estDmg >= opp.currentHP) bestMove = 1;
    }
    // Rule 4: prefer type-advantage move over neutral Headbutt
    else {
        const typeEff = getTypeEffectiveness(self.moves[1].type, opp.type);
        if (typeEff > 1) bestMove = 1;
    }

    // Final safety: if override picked something unusable (e.g. ult after spent), fall back
    if (!isMoveUsable(self, bestMove)) bestMove = validMoves[0];

    return bestMove;
}

// ============================================================
// BATTLE LOOP
// ============================================================
async function executeMove(actor, target, moveIdx) {
    const move = actor.moves[moveIdx];
    actor.lastUsedMove = move;
    if (move.pp > 0) move.pp--;

    if (move.power > 0) {
        const { damage } = calculateDamage(actor, target, move);
        applyDamage(target, damage);
    }
    applyMoveEffect(actor, target, move);
}

async function runBattle(capbotName, opponentName) {
    const capbot   = createCharacter(nameToType(capbotName));
    const opponent = createCharacter(nameToType(opponentName));
    const capbotBrain   = createAiBrain();
    const opponentBrain = createAiBrain();

    const MAX_ROUNDS = 50;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        // Speed determines order. Capbot wins ties (arbitrary, doesn't really matter).
        const capbotFirst = capbot.speed >= opponent.speed;
        const order = capbotFirst
            ? [{ a: capbot,   t: opponent, b: capbotBrain   },
               { a: opponent, t: capbot,   b: opponentBrain }]
            : [{ a: opponent, t: capbot,   b: opponentBrain },
               { a: capbot,   t: opponent, b: capbotBrain   }];

        for (const { a, t, b } of order) {
            if (a.isDefeated || t.isDefeated) continue;
            const moveIdx = await chooseMove(b, a, t);
            await executeMove(a, t, moveIdx);
            if (t.isDefeated) return a === capbot;
        }

        applyPassive(capbot);
        applyPassive(opponent);
    }

    // Timeout: HP fraction tiebreak; tie → capbot loses (conservative)
    return (capbot.currentHP / capbot.maxHP) > (opponent.currentHP / opponent.maxHP);
}

module.exports = { runBattle, TYPE, TYPE_NAME };