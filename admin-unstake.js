const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { AnchorProvider, Program, Wallet } = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const HELIUS_RPC = 'https://devnet.helius-rpc.com/?api-key=cfd79774-43dd-4cf4-a2dd-aefefe55e6f1';
const PROGRAM_ID = new PublicKey('FSenbAEVTgTdfM2723xkk8A2Y5oD8wtmB2EhiWXzpqSg');
const IDL = require(path.resolve(process.env.HOME, 'capmon-solana/test-page/capmon_staking.json'));

(async () => {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error('Usage: node admin-unstake.js <owner_pubkey> <asset_id>');
        process.exit(1);
    }
    const [ownerArg, assetArg] = args;

    const adminKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
        fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf-8')
    )));
    console.log('[admin-unstake] admin:', adminKey.publicKey.toBase58());

    const owner = new PublicKey(ownerArg);
    const assetId = new PublicKey(assetArg);

    const connection = new Connection(HELIUS_RPC, 'confirmed');
    const provider = new AnchorProvider(connection, new Wallet(adminKey), { commitment: 'confirmed' });
    const program = new Program(IDL, PROGRAM_ID, provider);

    const [stakeRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from('stake_record'), owner.toBuffer(), assetId.toBuffer()],
        PROGRAM_ID
    );
    const [programConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('program_config')],
        PROGRAM_ID
    );

    const acct = await connection.getAccountInfo(stakeRecord);
    if (!acct) {
        console.error('[admin-unstake] No stake record at PDA — already unstaked?');
        process.exit(1);
    }

    const sig = await program.methods
        .adminUnstake()
        .accounts({
            admin: adminKey.publicKey,
            programConfig,
            stakeRecord,
            owner,
            nftAssetId: assetId,
        })
        .rpc();

    console.log('[admin-unstake] ✅ closed. tx:', sig);
    console.log(`[admin-unstake] verify: https://solana.fm/tx/${sig}?cluster=devnet-solana`);
})();
