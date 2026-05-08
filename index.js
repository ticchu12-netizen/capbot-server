/**
 * Capbot Server — Phase 2 (stub battles) + Phase 4 (Pattern 2 brain upgrades)
 *
 * Each cron tick:
 *   1. Query players with stakedTier >= 0
 *   2. For each: stub battle (always-win) — credits Cap Coins via Admin SDK txn
 *   3. If brain_steps < tier ceiling: sign Ed25519 message, submit upgrade_brain_v2 tx
 *      so the on-chain stake_record.brain_steps actually grows. This is the iNFT pitch.
 */

require('dotenv').config();
const admin = require('firebase-admin');
const { runBattle } = require('./battleSim');
const cron = require('node-cron');
const { randomUUID, createHash } = require('crypto');
const {
    Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
    sendAndConfirmTransaction, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY,
} = require('@solana/web3.js');
const nacl = require('tweetnacl');
const fs = require('fs');

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
        process.exit(1);
    }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ============================================================
// SOLANA SETUP
// ============================================================
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=cfd79774-43dd-4cf4-a2dd-aefefe55e6f1";
const STAKING_PROGRAM_ID = new PublicKey("FSenbAEVTgTdfM2723xkk8A2Y5oD8wtmB2EhiWXzpqSg");
const MESSAGE_PREFIX = Buffer.from("capmon_upgrade_brain_v1", "utf-8");
const UPGRADE_BRAIN_V2_DISC = createHash('sha256').update('global:upgrade_brain_v2').digest().slice(0, 8);

// Tier ceilings — mirror constants.rs in the Anchor program. brain_steps grows
// monotonically up to the ceiling for the locked tier; never overflows.
const TIER_CEILINGS = [14_000_000, 39_000_000, 54_000_000, 60_000_000];

const connection = new Connection(HELIUS_RPC, "confirmed");

let upgradeAuthorityKey;
try {
    upgradeAuthorityKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
        fs.readFileSync('./upgradeAuthority.json', 'utf-8')
    )));
    console.log('[Capbot] Upgrade authority:', upgradeAuthorityKey.publicKey.toBase58());
} catch (e) {
    console.error('[Capbot] FATAL: upgradeAuthority.json not found in capbot-server/.');
    process.exit(1);
}

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
    BASE_BET: parseInt(process.env.BASE_BET || '5000', 10),
    CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/1 * * * *',
    BRAIN_STEPS_PER_UPGRADE: parseInt(process.env.BRAIN_STEPS_PER_UPGRADE || '500000', 10),

    TIER_MULTIPLIERS: [1.0, 1.4, 1.9, 2.8],
    TIER_TYPES: ['Healspike', 'Tsunami', 'Rageblaze', 'Rageblaze'],

    AI_POOL_STARTING: 10_000_000,
    AI_POOL_REFILL_PER_DAY: 1_000_000,
    AI_POOL_MAX_CAP: 50_000_000,

    RANK_THRESHOLDS: {
        SILVER: 165_000, GOLD: 825_000, PLATINUM: 3_300_000, DIAMOND: 11_000_000,
    },

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
// PATTERN 2 — Ed25519 signed brain upgrade on Solana
// ============================================================
async function upgradeBrainOnChain(uid) {
    // Fetch latest player state — stakedBrainSteps may have grown in a prior tick
    const playerSnap = await db.collection('players').doc(uid).get();
    if (!playerSnap.exists) return;
    const player = playerSnap.data();

    const tier = player.stakedTier;
    if (tier < 0 || tier >= TIER_CEILINGS.length) return;
    if (!player.solanaWalletAddress || !player.stakedAssetId) return;

    const currentBrainSteps = player.stakedBrainSteps ?? 0;
    const ceiling = TIER_CEILINGS[tier];
    if (currentBrainSteps >= ceiling) {
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. brain at ceiling (${currentBrainSteps})`);
        return;
    }

    const newBrainSteps = Math.min(currentBrainSteps + CONFIG.BRAIN_STEPS_PER_UPGRADE, ceiling);

    // Must be > current to satisfy on-chain monotonic check
    if (newBrainSteps <= currentBrainSteps) return;

    const ownerPubkey = new PublicKey(player.solanaWalletAddress);
    const assetIdPubkey = new PublicKey(player.stakedAssetId);
    const timestamp = BigInt(Date.now());

    // Build message: PREFIX || asset_id (32) || new_brain_steps (u32 LE) || timestamp (i64 LE)
    const newBrainStepsBuf = Buffer.alloc(4);
    newBrainStepsBuf.writeUInt32LE(newBrainSteps, 0);
    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigInt64LE(timestamp, 0);

    const messageBuffer = Buffer.concat([
        MESSAGE_PREFIX,
        assetIdPubkey.toBuffer(),
        newBrainStepsBuf,
        timestampBuf,
    ]);

    // Sign with upgrade authority hot key
    const signature = nacl.sign.detached(messageBuffer, upgradeAuthorityKey.secretKey);

    // Ix 0: Ed25519 sigverify (must be first)
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: upgradeAuthorityKey.publicKey.toBytes(),
        message: messageBuffer,
        signature: signature,
    });

    // Ix 1: upgrade_brain_v2 (introspects ix 0)
    const [stakeRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_record"), ownerPubkey.toBuffer(), assetIdPubkey.toBuffer()],
        STAKING_PROGRAM_ID
    );
    const [programConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("program_config")],
        STAKING_PROGRAM_ID
    );

    const args = Buffer.concat([
        UPGRADE_BRAIN_V2_DISC,
        newBrainStepsBuf,
        timestampBuf,
    ]);

    const upgradeIx = new TransactionInstruction({
        programId: STAKING_PROGRAM_ID,
        keys: [
            { pubkey: upgradeAuthorityKey.publicKey, isSigner: true, isWritable: true }, // payer
            { pubkey: programConfig, isSigner: false, isWritable: false },
            { pubkey: ownerPubkey, isSigner: false, isWritable: false },
            { pubkey: assetIdPubkey, isSigner: false, isWritable: false },
            { pubkey: stakeRecord, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: args,
    });

    const tx = new Transaction().add(ed25519Ix).add(upgradeIx);

    try {
        const sig = await sendAndConfirmTransaction(connection, tx, [upgradeAuthorityKey]);
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. brain ${currentBrainSteps} -> ${newBrainSteps} | tx: ${sig.slice(0,16)}..`);

        await db.collection('players').doc(uid).update({ stakedBrainSteps: newBrainSteps });
        await db.collection('brain_upgrades').add({
            uid,
            walletAddress: player.solanaWalletAddress,
            stakedAssetId: player.stakedAssetId,
            oldBrainSteps: currentBrainSteps,
            newBrainSteps,
            tier,
            txSignature: sig,
            timestamp: Date.now(),
        });
    } catch (err) {
        console.warn(`[Capbot] 🧠 brain upgrade failed for ${uid.slice(0,6)}..:`, err.message);
    }
}

// ============================================================
// SINGLE-BATTLE RESOLVER (existing Phase 2 logic, unchanged)
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
    let playerWon;
    try {
        playerWon = await runBattle(capbotType, aiType);
    } catch (err) {
        console.error('[Capbot] battle sim error, defaulting to loss:', err.message);
        playerWon = false;
    }
    const winnings = Math.floor(CONFIG.BASE_BET * multiplier);

    const idempotencyKey = `capbot_${uid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const playerRef = db.collection('players').doc(uid);
    const idempRef = db.collection('battle_idempotency_keys').doc(idempotencyKey);
    const activityRef = db.collection('capbot_activity').doc();

    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(playerRef);
            if (!snap.exists) throw new Error('player doc disappeared');
            const data = snap.data();

            const starterField = `${capbotType.toLowerCase()}Coins`;
            const aiPoolField = `ai${aiType}Coins`;
            const lastRefillField = `ai${aiType}LastRefill`;

            let currentAiPool = data[aiPoolField] ?? CONFIG.AI_POOL_STARTING;
            const lastRefillMs = data[lastRefillField] ?? Date.now();
            const hoursSince = (Date.now() - lastRefillMs) / (1000 * 60 * 60);
            if (hoursSince > 0) {
                const refill = Math.floor((CONFIG.AI_POOL_REFILL_PER_DAY * hoursSince) / 24);
                currentAiPool = Math.min(currentAiPool + refill, CONFIG.AI_POOL_MAX_CAP);
            }

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
                uid, source: 'capbot', createdAt: now,
                expiresAt: now + (24 * 60 * 60 * 1000),
            });

            tx.set(activityRef, {
                uid,
                walletAddress: data.solanaWalletAddress ?? null,
                stakedAssetId: data.stakedAssetId ?? null,
                stakedTier, capbotType, defeatedAi: aiType,
                betAmount: CONFIG.BASE_BET,
                multiplier, payout: playerDelta, playerWon,
                timestamp: now,
            });
        });

        console.log(
            `[Capbot] ${uid.slice(0,6)}.. tier=${stakedTier} (${capbotType}) ` +
            `vs ${aiType} → ${playerWon ? '+' : ''}${playerWon ? winnings : -CONFIG.BASE_BET} ` +
            `(${multiplier}×)`
        );

        // Pattern 2: bump on-chain brain_steps after a successful battle
        await upgradeBrainOnChain(uid);
    } catch (err) {
        console.warn(`[Capbot] battle failed for ${uid.slice(0,6)}..: ${err.message}`);
    }
}

// ============================================================
// CRON LOOP
// ============================================================
async function tick() {
    const start = Date.now();
    try {
        const snap = await db.collection('players').where('stakedTier', '>=', 0).get();
        if (snap.size === 0) {
            console.log('[Capbot] tick — no stakers');
            return;
        }
        console.log(`[Capbot] tick — ${snap.size} active stakers`);
        for (const doc of snap.docs) {
            await runBattleForPlayer(doc);
        }
        console.log(`[Capbot] tick complete in ${Date.now() - start}ms`);
    } catch (err) {
        console.error('[Capbot] tick error:', err);
    }
}

console.log(`[Capbot] starting | cron='${CONFIG.CRON_SCHEDULE}' | base bet=${CONFIG.BASE_BET} | brain step bump=${CONFIG.BRAIN_STEPS_PER_UPGRADE}`);
tick();
cron.schedule(CONFIG.CRON_SCHEDULE, tick);