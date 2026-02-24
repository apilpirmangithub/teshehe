import { getWallet, getSigningAddress } from "./src/identity/wallet.js";
import { initHyperliquid, checkAgentAuthorization } from "./src/survival/hyperliquid.js";

async function main() {
    console.log("=== HYPERLIQUID AUTH DEBUG ===");

    // Explicitly set the API key for the script context
    process.env.CONWAY_API_KEY = 'cnwy_k_r_JKLuqBsl6weHtPmbEjPMWHKzFJVI8A';

    const { account } = await getWallet();
    const signerAddress = getSigningAddress();

    console.log(`Canonical (User) Address: ${account.address}`);
    console.log(`Signer (Agent) Address:    ${signerAddress}`);

    if (account.address.toLowerCase() === signerAddress?.toLowerCase()) {
        console.log("WARNING: Canonical and Signer addresses are IDENTICAL.");
        console.log("This means the agent is acting as the main wallet, not as an authorized agent.");
    }

    console.log("\nChecking Hyperliquid Role...");
    const auth = await checkAgentAuthorization();
    console.log("Result:", JSON.stringify(auth, null, 2));

    if (!auth.authorized) {
        console.log("\n[!] ACTION REQUIRED:");
        console.log(`You need to authorize the Agent Address (${signerAddress}) on Hyperliquid for the User Address (${account.address}).`);
        console.log("Go to: https://app.hyperliquid.xyz/info and click 'Authorize an Agent'");
    }
}

main().catch(console.error);
