const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { createHash } = require('crypto');
const fs = require('fs');

const HELIUS_RPC = 'https://devnet.helius-rpc.com/?api-key=cfd79774-43dd-4cf4-a2dd-aefefe55e6f1';
const PROGRAM_ID = new PublicKey('FSenbAEVTgTdfM2723xkk8A2Y5oD8wtmB2EhiWXzpqSg');
const STAKE_RECORD_SIZE = 86;
const STAKE_OWNER_OFFSET = 8;
const STAKE_ASSET_OFFSET = 40;

// Anchor instruction discriminator: sha256("global:admin_unstake")[:8]
const ADMIN_UNSTAKE_DISC = createHash('sha256').update('global:admin_unstake').digest().slice(0, 8);

(async () => {
    const skipWallet = process.argv[2] || null;
    const adminKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
        fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf-8')
    )));
    console.log('[admin-unstake-all] admin:', adminKey.publicKey.toBase58());
    if (skipWallet) console.log('[admin-unstake-all] preserving stakes for wallet:', skipWallet);

    const connection = new Connection(HELIUS_RPC, 'confirmed');

    const [programConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('program_config')],
        PROGRAM_ID
    );

    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: STAKE_RECORD_SIZE }],
    });
    console.log(`[admin-unstake-all] found ${accounts.length} stake records on chain\n`);

    let closed = 0, skipped = 0, failed = 0;

    for (const acct of accounts) {
        const data = acct.account.data;
        const owner = new PublicKey(data.slice(STAKE_OWNER_OFFSET, STAKE_OWNER_OFFSET + 32));
        const assetId = new PublicKey(data.slice(STAKE_ASSET_OFFSET, STAKE_ASSET_OFFSET + 32));

        if (skipWallet && owner.toBase58() === skipWallet) {
            console.log(`  ⏭  skip ${owner.toBase58().slice(0,8)}.. (preserved)`);
            skipped++;
            continue;
        }

        try {
            const ix = new TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                    { pubkey: adminKey.publicKey, isSigner: true, isWritable: true },
                    { pubkey: programConfig, isSigner: false, isWritable: false },
                    { pubkey: acct.pubkey, isSigner: false, isWritable: true },  // stake_record
                    { pubkey: owner, isSigner: false, isWritable: false },
                    { pubkey: assetId, isSigner: false, isWritable: false },
                ],
                data: Buffer.from(ADMIN_UNSTAKE_DISC),
            });

            const tx = new Transaction().add(ix);
            const sig = await sendAndConfirmTransaction(connection, tx, [adminKey]);
            console.log(`  ✅ ${owner.toBase58().slice(0,8)}.. asset ${assetId.toBase58().slice(0,8)}.. closed | ${sig.slice(0,16)}..`);
            closed++;
        } catch (err) {
            const msg = (err.message || String(err)).slice(0, 200);
            console.warn(`  ❌ ${owner.toBase58().slice(0,8)}.. failed: ${msg}`);
            failed++;
        }
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n[admin-unstake-all] done — closed=${closed} skipped=${skipped} failed=${failed}`);
})();
