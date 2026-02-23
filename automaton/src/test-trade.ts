/**
 * Test Trade Script — Open a small leveraged position and close it immediately.
 * Run inside the cloud sandbox where the wallet keys are available.
 * 
 * Usage: node dist/test-trade.js
 */
import {
    initHyperliquid,
    getBalance,
    getOpenPositions,
    getMidPrice,
    marketOrder,
    closePosition,
    setLeverage,
    formatPrice,
} from "./survival/hyperliquid.js";
import { getWallet, loadWalletAccount } from "./identity/wallet.js";

async function main() {
    console.log("=== TEST TRADE: Open & Close ===\n");

    // 1. Load wallet
    const { account } = await getWallet();
    console.log(`Wallet: ${account.address}`);

    // 2. Get balance
    const balance = await getBalance();
    console.log(`Balance: $${balance.accountValue.toFixed(2)} (Withdrawable: $${balance.withdrawable.toFixed(2)})`);

    if (balance.withdrawable < 1.5) {
        console.log("❌ Balance too low for test trade. Need at least $1.50.");
        process.exit(1);
    }

    // 3. Pick asset: ETH (most liquid)
    const asset = "ETH";
    const leverage = 5;
    const marginUSD = 1.0; // Use only $1 for test

    // 4. Get price
    const midPrice = await getMidPrice(asset);
    console.log(`\n${asset} Mid Price: $${midPrice.toFixed(2)}`);

    // 5. Set leverage
    const { infoClient } = initHyperliquid();
    const meta = await infoClient.meta();
    const assetIndex = meta.universe.findIndex((a: any) => a.name === asset);
    if (assetIndex === -1) {
        console.log(`❌ Asset ${asset} not found`);
        process.exit(1);
    }
    console.log(`Asset index: ${assetIndex}`);

    try {
        await setLeverage(assetIndex, leverage);
        console.log(`Leverage set to ${leverage}x`);
    } catch (e: any) {
        console.log(`Leverage note: ${e.message}`);
    }

    // 6. Calculate size
    const sizeAsset = (marginUSD * leverage) / midPrice;
    const szDecimals = meta.universe[assetIndex].szDecimals;
    const formattedSize = Number(sizeAsset.toFixed(szDecimals));
    console.log(`\nOpening LONG ${formattedSize} ${asset} (Margin: $${marginUSD}, Lev: ${leverage}x)`);

    // 7. Open position
    console.log("\n--- OPENING POSITION ---");
    const openResult = await marketOrder(asset, true, formattedSize);
    console.log("Open result:", JSON.stringify(openResult, null, 2));

    if (!openResult || openResult.status !== "ok") {
        console.log("❌ Failed to open position. Result:", openResult);
        // Check if there's a partial fill or if the order was rejected
        console.log("\nChecking open positions anyway...");
    }

    // 8. Wait 2 seconds
    console.log("\n⏳ Waiting 2 seconds before closing...");
    await new Promise(r => setTimeout(r, 2000));

    // 9. Check positions
    const positions = await getOpenPositions();
    console.log(`\nOpen positions: ${positions.length}`);
    for (const p of positions) {
        console.log(`  ${p.side} ${p.asset}: ${p.size} @ $${p.entryPrice.toFixed(2)} (PnL: $${p.unrealizedPnl.toFixed(4)}, Lev: ${p.leverage}x)`);
    }

    const ethPos = positions.find(p => p.asset === asset);
    if (!ethPos) {
        console.log(`\n⚠️ No ${asset} position found. Order may have been too small or rejected.`);
        console.log("This likely means the Spot USDC needs to be transferred to Perp first.");
        console.log("\nFinal balance:");
        const finalBal = await getBalance();
        console.log(`  Account Value: $${finalBal.accountValue.toFixed(2)}`);
        process.exit(0);
    }

    // 10. Close position
    console.log("\n--- CLOSING POSITION ---");
    const closeResult = await closePosition(asset);
    console.log("Close result:", JSON.stringify(closeResult, null, 2));

    // 11. Final check
    console.log("\n--- FINAL STATE ---");
    const finalBalance = await getBalance();
    console.log(`Balance: $${finalBalance.accountValue.toFixed(4)}`);
    const finalPositions = await getOpenPositions();
    console.log(`Open positions: ${finalPositions.length}`);

    // 5. Verify Position
    console.log("STEP: VERIFY_START");
    try {
        const positionsAfterClose = await getOpenPositions();
        const found = positionsAfterClose.find(p => p.asset === asset);
        if (found) {
            console.log("STEP: POSITION_FOUND: " + found.size + " " + asset);
        } else {
            console.log("STEP: POSITION_NOT_FOUND");
        }
    } catch (e: any) {
        console.log("STEP: VERIFY_ERROR: " + e.message);
    }

    console.log("=== TEST FINISHED ===");
}

main().catch(err => {
    console.error("FATAL ERROR: " + err.message);
    process.exit(1);
});
