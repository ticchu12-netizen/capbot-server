/**
 * Capbot Server — Phase 2 (Stub Battles)
 *
 * Autonomous server that runs battles on behalf of staked Capmon NFTs.
 * Cron tick: queries players where stakedTier >= 0, simulates a battle
 * for each, credits the player's Cap Coin balance, logs activity.
 *
 * Phase 2 (this file): stub battle resolver — random win/loss (50/50)
 *   actually no, always-win for cleaner demo. Phase 3 swaps for ONNX.
 *
 * Architecture:
 *   - Firebase Admin SDK writes directly to Firestore (bypasses rules)
 *   - Logic mirrors resolveMatch Cloud Function (tier multiplier, AI pool draw)
 *   - Each battle is its own Firestore transaction
 *   - capbot_activity collection logs every battle for Unity tab to display
 *   - Skips battle_stats anti-cheat tracking (autonomous != manual play)
 */

require('dotenv').config();
const admin = require('firebase-admin');
const cron = require('node-cron');
const { randomUUID } = require('crypto');

// ============================================================
// FIREBASE INIT — local file OR env var (Railway)
// ============================================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('[Capbot] Using FIREBASE_SERVICE_ACCOUNT env var');
} else {
    try {
        serviceAccount = require('./serviceAccount.json');
        console.log('[Capbot] Using local serviceAccount.json');
    } catch (e) {
        console.error('[Capbot] FATAL: no service account credentials found.');
        console.error('  Local: place serviceAccount.json in this folder.');
        console.error('  Railway: set FIREBASE_SERVICE_ACCOUNT env var to JSON contents.');
        process.exit(1);
    }
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ============================================================
// CONFIG — must mirror Cloud Function CONFIG (functions/index.js)
// ============================================================
const CONFIG = {
    BASE_BET: parseInt(process.env.BASE_BET || '5000', 10),
    CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/1 * * * *',

    // Tier multipliers — mirrors Cloud Function + Unity tables
    TIER_MULTIPLIERS: [1.0, 1.4, 1.9, 2.8],

    // Tier → starter type mapping. NFT tier determines which Cap Coin balance
    // the Capbot earns into AND the type the Capbot battles as.
    TIER_TYPES: ['Healspike', 'Tsunami', 'Rageblaze', 'Rageblaze'],

    // AI pool economics (mirror functions/index.js)
    AI_POOL_STARTING: 10_000_000,
    AI_POOL_REFILL_PER_DAY: 1_000_000,
    AI_POOL_MAX_CAP: 50_000_000,

    // Cosmetic rank thresholds
    RANK_THRESHOLDS: {
        SILVER: 165_000,
        GOLD: 825_000,
        PLATINUM: 3_300_000,
        DIAMOND: 11_000_000,
    },

    // Phase 2 stub: always-win for demo polish. Phase 3 ONNX adds real variance.
    STUB_WIN_RATE: 1.0,
};

const VALID_STARTERS = ['Rageblaze', 'Tsunami', 'Healspike'];

function computeRankFromTotalWon(totalWon) {
    const t = CONFIG.RANK_THRESHOLDS;
    if (totalWon >= t.DIAMOND) return 4;
    if (totalWon >= t.PLATINUM) return 3;
    if (totalWon >= t.GOLD) return 2;
    if (totalWon >= t.SILVER) return 1;
    return 0;
}

function pickOpponentType(capbotType) {
    const others = VALID_STARTERS.filter(s => s !== capbotType);
    return others[Math.floor(Math.random() * others.length)];
}

// ============================================================
// SINGLE-BATTLE RESOLVER
// ============================================================
async function runBattleForPlayer(playerDoc) {
    const uid = playerDoc.id;
    const player = playerDoc.data();
    const stakedTier = player.stakedTier;

    if (stakedTier < 0 || stakedTier >= CONFIG.TIER_TYPES.length) {
        console.log(`[Capbot] Skipping ${uid} — invalid tier ${stakedTier}`);
        return;
    }

    const capbotType = CONFIG.TIER_TYPES[stakedTier];
    const aiType = pickOpponentType(capbotType);
    const multiplier = CONFIG.TIER_MULTIPLIERS[stakedTier];
    const playerWon = Math.random() < CONFIG.STUB_WIN_RATE;
    const winnings = Math.floor(CONFIG.BASE_BET * multiplier);

    const idempotencyKey = `capbot_${uid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const playerRef = db.collection('players').doc(uid);
    const idempRef = db.collection('battle_idempotency_keys').doc(idempotencyKey);
    const activityRef = db.collection('capbot_activity').doc(); // auto-id

    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(playerRef);
            if (!snap.exists) throw new Error('player doc disappeared');
            const data = snap.data();

            const starterField = `${capbotType.toLowerCase()}Coins`;
            const aiPoolField = `ai${aiType}Coins`;
            const lastRefillField = `ai${aiType}LastRefill`;

            // Lazy AI pool refill (mirrors resolveMatch logic)
            let currentAiPool = data[aiPoolField] ?? CONFIG.AI_POOL_STARTING;
            const lastRefillMs = data[lastRefillField] ?? Date.now();
            const hoursSince = (Date.now() - lastRefillMs) / (1000 * 60 * 60);
            if (hoursSince > 0) {
                const refill = Math.floor((CONFIG.AI_POOL_REFILL_PER_DAY * hoursSince) / 24);
                currentAiPool = Math.min(currentAiPool + refill, CONFIG.AI_POOL_MAX_CAP);
            }

            // Sufficiency check on win
            if (playerWon && currentAiPool < winnings) {
                throw new Error(`AI pool ${aiType} empty — skip this tick`);
            }

            const currentBalance = data[starterField] ?? 0;
            const playerDelta = playerWon ? winnings : -CONFIG.BASE_BET;
            const aiDelta = playerWon ? -winnings : CONFIG.BASE_BET;

            const newBalance = Math.max(currentBalance + playerDelta, 0);
            const newAiPool = Math.min(Math.max(currentAiPool + aiDelta, 0), CONFIG.AI_POOL_MAX_CAP);

            const newTotalWon = playerWon
                ? (data.totalWon ?? 0) + winnings
                : (data.totalWon ?? 0);
            const newRank = computeRankFromTotalWon(newTotalWon);

            const now = Date.now();

            tx.update(playerRef, {
                [starterField]: newBalance,
                [aiPoolField]: newAiPool,
                [lastRefillField]: now,
                totalWon: newTotalWon,
                rank: newRank,
                lastUpdated: now,
            });

            tx.set(idempRef, {
                uid,
                source: 'capbot',
                createdAt: now,
                expiresAt: now + (24 * 60 * 60 * 1000),
            });

            tx.set(activityRef, {
                uid,
                walletAddress: data.solanaWalletAddress ?? null,
                stakedAssetId: data.stakedAssetId ?? null,
                stakedTier,
                capbotType,
                defeatedAi: aiType,
                betAmount: CONFIG.BASE_BET,
                multiplier,
                payout: playerDelta,    // signed: + on win, - on loss
                playerWon,
                timestamp: now,
            });
        });

        console.log(
            `[Capbot] ${uid.slice(0,6)}.. tier=${stakedTier} (${capbotType}) ` +
            `vs ${aiType} → ${playerWon ? '+' : ''}${playerWon ? winnings : -CONFIG.BASE_BET} ` +
            `(${multiplier}×)`
        );
    } catch (err) {
        console.warn(`[Capbot] battle failed for ${uid.slice(0,6)}..: ${err.message}`);
    }
}

// ============================================================
// CRON LOOP
// ============================================================
async function tick() {
    const start = Date.now();
    let stakerCount = 0;
    try {
        // Query all players with a staked NFT
        const snap = await db.collection('players')
            .where('stakedTier', '>=', 0)
            .get();

        stakerCount = snap.size;
        if (stakerCount === 0) {
            console.log('[Capbot] tick — no stakers, skipping');
            return;
        }

        console.log(`[Capbot] tick — ${stakerCount} active stakers`);
        for (const doc of snap.docs) {
            await runBattleForPlayer(doc);
        }

        const elapsedMs = Date.now() - start;
        console.log(`[Capbot] tick complete in ${elapsedMs}ms`);
    } catch (err) {
        console.error('[Capbot] tick error:', err);
    }
}

// ============================================================
// BOOT
// ============================================================
console.log(`[Capbot] starting | cron='${CONFIG.CRON_SCHEDULE}' | base bet=${CONFIG.BASE_BET}`);
console.log('[Capbot] Tier types:', CONFIG.TIER_TYPES.map((t, i) => `${i}=${t}(${CONFIG.TIER_MULTIPLIERS[i]}×)`).join(' '));

// Run once on boot for fast feedback
tick();

// Then every minute (or whatever CRON_SCHEDULE says)
cron.schedule(CONFIG.CRON_SCHEDULE, tick);