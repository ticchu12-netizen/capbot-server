const {
    Connection, Keypair, PublicKey,
    Transaction, TransactionInstruction, sendAndConfirmTransaction
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

const PROGRAM_ID = new PublicKey("FSenbAEVTgTdfM2723xkk8A2Y5oD8wtmB2EhiWXzpqSg");
const NEW_AUTHORITY = new PublicKey("65uP1ZernjBQaqTTnmfnykcJWqRU6a7LnQKe8abRWQLd");
const HELIUS = "https://devnet.helius-rpc.com/?api-key=cfd79774-43dd-4cf4-a2dd-aefefe55e6f1";

(async () => {
    const connection = new Connection(HELIUS, "confirmed");

    // Solana CLI's default keypair (your admin / deployer)
    const adminKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
        fs.readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")
    )));
    console.log("Admin:", adminKey.publicKey.toBase58());

    // Anchor discriminator = first 8 bytes of SHA256("global:set_upgrade_authority")
    const disc = crypto.createHash("sha256")
        .update("global:set_upgrade_authority").digest().slice(0, 8);
    const data = Buffer.concat([disc, NEW_AUTHORITY.toBuffer()]);

    const [programConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("program_config")], PROGRAM_ID
    );

    const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: adminKey.publicKey, isSigner: true, isWritable: false },
            { pubkey: programConfig, isSigner: false, isWritable: true },
        ],
        data,
    });

    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [adminKey]);
    console.log("✅ tx:", sig);
    console.log("Explorer:", `https://solana.fm/tx/${sig}?cluster=devnet-solana`);
    console.log("upgrade_authority is now:", NEW_AUTHORITY.toBase58());
})().catch(e => { console.error(e); process.exit(1); });
