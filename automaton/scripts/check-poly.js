
import { createDatabase } from '../dist/state/database.js';
import { getPositions, getPortfolioStatus, initializePolymarket } from '../dist/survival/polymarket.js';
import { getWallet } from '../dist/identity/wallet.js';
import { loadConfig, resolvePath } from '../dist/config.js';

async function check() {
    const config = loadConfig();
    const dbPath = resolvePath(config.dbPath);
    const db = createDatabase(dbPath);
    const { account } = await getWallet();

    initializePolymarket(db, console, account.privateKey, account.address);

    const positions = getPositions();
    const portfolio = getPortfolioStatus();

    console.log("=== POLYMARKET STATUS ===");
    console.log("Balance:", portfolio.currentBalance);
    console.log("Open Positions:", positions.length);
    positions.forEach(p => {
        console.log(`- ${p.marketTitle} | ${p.side} | Entry: ${p.entryPrice}`);
    });

    process.exit(0);
}
check();
