/**
 * Capbot Server — Phase 2 (stub battles) + Phase 4 (TEE-attested Pattern 2 brain upgrades)
 *
 * Each cron tick:
 *   1. Query players with stakedTier >= 0
 *   2. For each: stub battle (always-win) — credits Cap Coins via Admin SDK txn
 *   3. If brain_steps < tier ceiling: sign Ed25519 message with TEE-derived key,
 *      generate TDX attestation quote, submit upgrade_brain_v2 tx so the on-chain
 *      stake_record.brain_steps actually grows. Quote stored in Firestore.
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
const { DstackClient } = require('@phala/dstack-sdk');
const { toKeypairSecure } = require('@phala/dstack-sdk/solana');

// ============================================================
// FIREBASE INIT — local file OR env var (Railway / Phala)
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
const STAKE_RECORD_SIZE = 86;
const STAKE_OWNER_OFFSET = 8;
const STAKE_ASSET_OFFSET = 40;
const STAKE_TIER_OFFSET = 72;
const STAKE_BRAIN_STEPS_OFFSET = 73;

// Tier ceilings — mirror constants.rs in the Anchor program. brain_steps grows
// monotonically up to the ceiling for the locked tier; never overflows.
const TIER_CEILINGS = [14_000_000, 39_000_000, 54_000_000, 60_000_000];
const TIER_FLOORS = [0, 15_000_000, 40_000_000, 55_000_000];

const connection = new Connection(HELIUS_RPC, "confirmed");

// ============================================================
// UPGRADE AUTHORITY — TEE-derived (Phala CVM) with file fallback
// ============================================================
let upgradeAuthorityKey;
let dstackClient = null;

async function loadUpgradeAuthority() {
    try {
        dstackClient = new DstackClient();
        const info = await dstackClient.info();
        console.log('[TEE] App ID:', info.app_id);
        console.log('[TEE] Instance ID:', info.instance_id);
        const keyResult = await dstackClient.getKey('capmon/upgrade-authority', 'mainnet');
        upgradeAuthorityKey = toKeypairSecure(keyResult);
        console.log('[TEE] Upgrade authority (TEE-derived):', upgradeAuthorityKey.publicKey.toBase58());
        return;
    } catch (err) {
        console.warn('[TEE] TEE key derivation failed, falling back to file/env:', err.message);
        dstackClient = null;
    }

    if (process.env.UPGRADE_AUTHORITY_JSON) {
        try {
            const parsed = JSON.parse(process.env.UPGRADE_AUTHORITY_JSON);
            upgradeAuthorityKey = Keypair.fromSecretKey(Uint8Array.from(parsed));
            console.log('[Capbot] Using UPGRADE_AUTHORITY_JSON env var');
            return;
        } catch (e) {
            console.error('[Capbot] FATAL: failed to parse UPGRADE_AUTHORITY_JSON:', e.message);
            process.exit(1);
        }
    }
    try {
        upgradeAuthorityKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
            fs.readFileSync('./upgradeAuthority.json', 'utf-8')
        )));
        console.log('[Capbot] Using local upgradeAuthority.json');
    } catch (e) {
        console.error('[Capbot] FATAL: no upgrade authority available.');
        process.exit(1);
    }
}

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
    BASE_BET: parseInt(process.env.BASE_BET || '5000', 10),
    CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/1 * * * *',
    BRAIN_UPGRADE_BURN_PCT: parseFloat(process.env.BRAIN_UPGRADE_BURN_PCT) || 0.5,
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
// PATTERN 2 — TEE-attested Ed25519 brain upgrade on Solana
// ============================================================
async function upgradeBrainOnChain(uid, winnings, battleId) {
    // Fetch latest player state — stakedBrainSteps may have grown in a prior tick
    const playerSnap = await db.collection('players').doc(uid).get();
    if (!playerSnap.exists) return;
    const player = playerSnap.data();

    const tier = player.stakedTier;
    if (tier < 0 || tier >= TIER_CEILINGS.length) return;
    if (!player.solanaWalletAddress || !player.stakedAssetId) return;

    // Read authoritative brain_steps from on-chain StakeRecord (Firestore mirror can lag)
    const ownerPubkey = new PublicKey(player.solanaWalletAddress);
    const assetIdPubkey = new PublicKey(player.stakedAssetId);
    const [stakeRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_record"), ownerPubkey.toBuffer(), assetIdPubkey.toBuffer()],
        STAKING_PROGRAM_ID
    );
    const stakeRecordAccount = await connection.getAccountInfo(stakeRecord);
    if (!stakeRecordAccount) {
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. no on-chain stake record (unstaked?)`);
        return;
    }
    // Read authoritative tier + brain_steps from on-chain StakeRecord (Firestore can lag)
    // Layout: tier at offset 72 (u8), brain_steps at offset 73 (u32 LE)
    const onChainTier = stakeRecordAccount.data[72];
    const currentBrainSteps = stakeRecordAccount.data.readUInt32LE(73);

    // If Firestore tier diverges from on-chain, log + skip — let discovery cron resync
    if (onChainTier !== tier) {
        console.warn(`[Capbot] 🧠 ${uid.slice(0,6)}.. tier mismatch (chain=${onChainTier}, firestore=${tier}) — skipping upgrade`);
        return;
    }
    const ceiling = TIER_CEILINGS[tier];
    if (currentBrainSteps >= ceiling) {
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. brain at ceiling (${currentBrainSteps})`);
        return;
    }

    const tierFloor = TIER_FLOORS[tier];
    let newBrainSteps = Math.min(currentBrainSteps + CONFIG.BRAIN_STEPS_PER_UPGRADE, ceiling);
    // On-chain bug workaround: stake instruction initializes brain_steps to 0 regardless
    // of tier. For tier 1+ stakes, jump to the tier floor first to satisfy the range check.
    if (newBrainSteps < tierFloor) newBrainSteps = tierFloor;
    if (newBrainSteps <= currentBrainSteps) return;

    // === PROOF-OF-BURN: deduct half the winnings to fund the brain upgrade ===
    // The Ed25519 attestation only fires after the player has paid for it.
    // Burn currency is the starter coin matching the staked Capbot's type.
    const capbotType = CONFIG.TIER_TYPES[tier];
    const balanceField = `${capbotType.toLowerCase()}Coins`;
    const currentBalance = player[balanceField] ?? 0;
    const burnCost = Math.floor((winnings || 0) * CONFIG.BRAIN_UPGRADE_BURN_PCT);

    if (burnCost <= 0) {
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. upgrade skipped — zero burn cost`);
        return;
    }
    if (currentBalance < burnCost) {
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. upgrade skipped — insufficient ${capbotType} (have ${currentBalance}, need ${burnCost})`);
        return;
    }

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

    const signature = nacl.sign.detached(messageBuffer, upgradeAuthorityKey.secretKey);

    // === TDX ATTESTATION QUOTE ===
    // Proof that the Ed25519 signature was produced inside the TEE enclave.
    // report_data = sha256(messageBuffer) — binds the quote to this specific upgrade.
    let tdxQuote = null;
    if (dstackClient) {
        try {
            const reportData = createHash('sha256').update(messageBuffer).digest();
            const quoteResult = await dstackClient.getQuote(reportData);
            tdxQuote = quoteResult.quote;
        } catch (err) {
            console.warn(`[TEE] getQuote failed for ${uid.slice(0,6)}..:`, err.message);
        }
    }

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: upgradeAuthorityKey.publicKey.toBytes(),
        message: messageBuffer,
        signature: signature,
    });

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
            { pubkey: upgradeAuthorityKey.publicKey, isSigner: true, isWritable: true },
            { pubkey: programConfig, isSigner: false, isWritable: false },
            { pubkey: ownerPubkey, isSigner: false, isWritable: false },
            { pubkey: assetIdPubkey, isSigner: false, isWritable: false },
            { pubkey: stakeRecord, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: args,
    });
    console.log(`[DEBUG] ${uid.slice(0,6)}.. tier=${tier} onChainTier=${onChainTier} currentBrainSteps=${currentBrainSteps} newBrainSteps=${newBrainSteps} tierFloor=${tierFloor} ceiling=${ceiling}`);

    const tx = new Transaction().add(ed25519Ix).add(upgradeIx);

    try {
        // Send the on-chain attestation FIRST. If this fails, no coins burned.
        const sig = await sendAndConfirmTransaction(connection, tx, [upgradeAuthorityKey]);
        const attestedTag = tdxQuote ? ' (TEE-attested)' : '';
        console.log(`[Capbot] 🧠 ${uid.slice(0,6)}.. brain ${currentBrainSteps} -> ${newBrainSteps} (burned ${burnCost} ${capbotType})${attestedTag} | tx: ${sig.slice(0,16)}..`);

        // Then atomically: bump on-chain brain_steps mirror + deduct burn cost
        await db.collection('players').doc(uid).update({
            stakedBrainSteps: newBrainSteps,
            [balanceField]: admin.firestore.FieldValue.increment(-burnCost),
        });

        // Record the burn alongside the upgrade for /proof + Unity My Capbots tab
        await db.collection('brain_upgrades').add({
            uid,
            walletAddress: player.solanaWalletAddress,
            stakedAssetId: player.stakedAssetId,
            oldBrainSteps: currentBrainSteps,
            newBrainSteps,
            tier,
            txSignature: sig,
            timestamp: Date.now(),
            coinsBurned: burnCost,
            burnCurrency: capbotType,
            battleId: battleId || null,
            tdxQuote,
            teeAttested: tdxQuote !== null,
        });
    } catch (err) {
        console.warn(`[Capbot] 🧠 brain upgrade failed for ${uid.slice(0,6)}..:`, err.message);
    }
}

// ============================================================
// On-chain discovery backstop — trustless safety net
// Catches wallets that staked but bypassed signInWithWallet/linkWallet
// (e.g. minted via Blink and never opened the game). Also detects
// unstakes that happened on-chain but didn't sync to Firestore.
// ============================================================
async function discoverOnChainStakers() {
    const start = Date.now();
    try {
        const accounts = await connection.getProgramAccounts(STAKING_PROGRAM_ID, {
            filters: [{ dataSize: STAKE_RECORD_SIZE }],
        });

        // owner → Array<{assetId, tier, brainSteps}>
        const stakesByOwner = new Map();
        for (const acct of accounts) {
            const data = acct.account.data;
            if (data.length < STAKE_RECORD_SIZE) continue;
            const owner = new PublicKey(data.slice(STAKE_OWNER_OFFSET, STAKE_OWNER_OFFSET + 32)).toBase58();
            const assetId = new PublicKey(data.slice(STAKE_ASSET_OFFSET, STAKE_ASSET_OFFSET + 32)).toBase58();
            const tier = data[STAKE_TIER_OFFSET];
            const brainSteps = data.readUInt32LE(STAKE_BRAIN_STEPS_OFFSET);
            if (!stakesByOwner.has(owner)) stakesByOwner.set(owner, []);
            stakesByOwner.get(owner).push({ assetId, tier, brainSteps });
        }

        let registered = 0, updated = 0, cleared = 0;
        let addedStakes = 0, updatedStakes = 0, removedStakes = 0;

        for (const [owner, stakes] of stakesByOwner) {
            const top = stakes.reduce((a, b) => (b.tier > a.tier ? b : a));
            const querySnap = await db.collection('players')
                .where('solanaWalletAddress', '==', owner)
                .limit(1)
                .get();

            let playerRef;
            if (!querySnap.empty) {
                const doc = querySnap.docs[0];
                playerRef = doc.ref;
                const existing = doc.data();
                if (existing.stakedTier !== top.tier ||
                    existing.stakedAssetId !== top.assetId ||
                    existing.stakedBrainSteps !== top.brainSteps) {
                    await playerRef.update({
                        stakedTier: top.tier,
                        stakedAssetId: top.assetId,
                        stakedBrainSteps: top.brainSteps,
                    });
                    updated++;
                }
            } else {
                playerRef = db.collection('players').doc(owner);
                await playerRef.set({
                    playerId: owner,
                    displayName: `Wallet ${owner.slice(0, 4)}..${owner.slice(-4)}`,
                    isGuest: false,
                    currentStarter: 'Rageblaze',
                    rageblazeCoins: 50000,
                    tsunamiCoins: 50000,
                    healspikeCoins: 50000,
                    aiRageblazeCoins: 10000000,
                    aiTsunamiCoins: 10000000,
                    aiHealspikeCoins: 10000000,
                    totalWon: 0,
                    rank: 0,
                    createdAt: Date.now(),
                    solanaWalletAddress: owner,
                    stakedTier: top.tier,
                    stakedBrainSteps: top.brainSteps,
                    stakedAssetId: top.assetId,
                    walletLinkedAt: Date.now(),
                    authMethod: 'discovery',
                    discoveredAt: Date.now(),
                });
                console.log(`[discovery] 🎯 Registered new staker ${owner.slice(0,8)}.. (${stakes.length} stake${stakes.length>1?'s':''}, top tier=${top.tier})`);
                registered++;
            }

            // Sync subcollection: add new, update changed, delete unstaked
            const stakesCol = playerRef.collection('stakes');
            const existingSnap = await stakesCol.get();
            const existingMap = new Map();
            existingSnap.forEach(d => existingMap.set(d.id, d.data()));
            const onChainIds = new Set(stakes.map(s => s.assetId));

            for (const s of stakes) {
                const existing = existingMap.get(s.assetId);
                if (!existing) {
                    await stakesCol.doc(s.assetId).set({
                        assetId: s.assetId,
                        tier: s.tier,
                        brainSteps: s.brainSteps,
                        lastBattleAt: 0,
                    });
                    addedStakes++;
                } else if (existing.tier !== s.tier || existing.brainSteps !== s.brainSteps) {
                    await stakesCol.doc(s.assetId).update({
                        tier: s.tier,
                        brainSteps: s.brainSteps,
                    });
                    updatedStakes++;
                }
            }
            for (const [id] of existingMap) {
                if (!onChainIds.has(id)) {
                    await stakesCol.doc(id).delete();
                    removedStakes++;
                }
            }
        }

        // Cleanup: players marked staked in Firestore but no on-chain records
        const stakerSnap = await db.collection('players')
            .where('stakedTier', '>=', 0)
            .get();

        for (const doc of stakerSnap.docs) {
            const data = doc.data();
            const wallet = data.solanaWalletAddress;
            if (!wallet) continue;
            if (!stakesByOwner.has(wallet)) {
                const stakesCol = doc.ref.collection('stakes');
                const stakesSnap = await stakesCol.get();
                for (const s of stakesSnap.docs) await s.ref.delete();
                await doc.ref.update({
                    stakedTier: -1,
                    stakedBrainSteps: 0,
                    stakedAssetId: null,
                });
                console.log(`[discovery] 🧹 Cleared stake for ${wallet.slice(0,8)}.. (unstaked on-chain)`);
                cleared++;
            }
        }

        console.log(`[discovery] ${stakesByOwner.size} owners | players: reg=${registered} upd=${updated} clr=${cleared} | stakes: +${addedStakes} ~${updatedStakes} -${removedStakes} | ${Date.now() - start}ms`);
    } catch (err) {
        console.error('[discovery] error:', err);
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
    let turnLog = [];
    try {
        const battleResult = await runBattle(capbotType, aiType);
        playerWon = battleResult.result;
        turnLog = battleResult.turnLog || [];
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
                battleId: activityRef.id,
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

        try {
            await db.collection('battle_replays').doc(activityRef.id).set({
                battleId: activityRef.id,
                uid,
                walletAddress: player.solanaWalletAddress ?? null,
                capbotName: capbotType,
                capbotTier: stakedTier,
                opponentName: aiType,
                result: playerWon ? 'win' : 'lose',
                turns: turnLog,
                capCoinDelta: playerWon ? winnings : -CONFIG.BASE_BET,
                multiplier,
                timestamp: Date.now(),
            });
        } catch (err) {
            console.warn(`[Capbot] failed to save replay for ${uid.slice(0,6)}..:`, err.message);
        }
        // Pattern 2: brain upgrades only fire on wins, with proof-of-burn deduction.
        // Pass activityRef.id for cross-doc linkage (brain_upgrades -> battle_replays).
        if (playerWon) {
            await upgradeBrainOnChain(uid, winnings, activityRef.id);
        }
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

// ============================================================
// BOOT
// ============================================================
async function boot() {
    await loadUpgradeAuthority();
    console.log(`[Capbot] starting | cron='${CONFIG.CRON_SCHEDULE}' | base bet=${CONFIG.BASE_BET} | brain step bump=${CONFIG.BRAIN_STEPS_PER_UPGRADE}`);
    tick();
    cron.schedule(CONFIG.CRON_SCHEDULE, tick);

    console.log('[Capbot] discovery cron every 5 min');
    discoverOnChainStakers();
    cron.schedule('*/5 * * * *', discoverOnChainStakers);
}
boot();