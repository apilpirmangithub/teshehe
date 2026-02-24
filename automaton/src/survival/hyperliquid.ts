/**
 * Hyperliquid Perpetual Trading Integration
 *
 * Uses @nktkas/hyperliquid SDK for high-performance perpetual futures trading.
 * Supports ALL assets available on Hyperliquid with deep technical analysis.
 */

import {
    InfoClient,
    ExchangeClient,
    HttpTransport,
} from "@nktkas/hyperliquid";
import { userRole } from "@nktkas/hyperliquid/api/info";
import { PrivateKeySigner } from "@nktkas/hyperliquid/signing";
import { loadWalletAccount, getWalletPrivateKey, getSigningAddress } from "../identity/wallet.js";
import { analyze, type Candle, type TASignal } from "./technicals.js";

/**
 * Robust request wrapper with exponential backoff for rate limits (429).
 */
async function safeRequest<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        // Inspect multiple possible error structures (axios-like, fetch-like, etc.)
        const status = err.status || err.statusCode || (err.response && err.response.status);
        const statusText = err.statusText || (err.response && err.response.statusText);
        const message = err.message || "";

        const isRateLimit = status === 429 ||
            statusText === "Too Many Requests" ||
            message.includes("429");

        if (isRateLimit && retries > 0) {
            console.warn(`[Hyperliquid] Rate limited (429). Retrying in ${delay / 1000}s... (Attempts left: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return safeRequest(fn, retries - 1, delay * 2);
        }

        // Final fallback: check for status in object if it's a Response object thrown.
        if (err.status === undefined && typeof err.text === "function" && retries > 0) {
            console.warn(`[Hyperliquid] Unexpected error object detected. Retrying once...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return safeRequest(fn, retries - 1, delay * 2);
        }

        throw err;
    }
}

// ─── Constants ──────────────────────────────────────────────────

const IS_TESTNET = false;

export const SCALP_CONFIG = {
    maxOpenPositions: 6,      // BERSERKER: 6 concurrent trades
    maxMarginPct: 0.15,       // 15% per slot for survival (self-aware scaling)
    minConfidence: 35,        // Hyper-aggressive entry
    compoundRatio: 0.90,      // Aggressive reinvestment
    atrTpMultiplier: 1.5,
    atrSlMultiplier: 0.8,
    trailActivation: 1.0,
    minVolume24h: 50_000,     // Target high-volatility small caps
    defaultLeverage: 20,      // High leverage (20x)
};

// ─── Types ──────────────────────────────────────────────────────

export interface HyperliquidPosition {
    asset: string;
    side: "LONG" | "SHORT";
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
    marginUsed: number;
}

export interface HyperliquidBalance {
    withdrawable: number;
    totalValue: number;
    accountValue: number;
}

export interface HyperliquidMarketInfo {
    name: string;
    price: number;
    funding: number;
    szDecimals: number;
}

export interface AssetOpportunity {
    market: string;
    signal: TASignal;
    volume24h: number;
    funding: number;
    price: number;
    szDecimals: number;
    assetIndex: number;
}

// ─── Client Setup ───────────────────────────────────────────────

let transport: HttpTransport | null = null;
let infoClient: InfoClient | null = null;
let exchangeClient: ExchangeClient | null = null;
let signer: PrivateKeySigner | null = null;

// Authorization Caching to prevent dashboard flicker on 429s
let cachedAuth: { authorized: boolean; agentAddress: string | null; userAddress: string | null; timestamp: number } | null = null;
const AUTH_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

export function initHyperliquid() {
    if (infoClient && exchangeClient) return { infoClient, exchangeClient };

    const account = loadWalletAccount();
    const privateKey = getWalletPrivateKey();
    if (!account || !privateKey) {
        throw new Error("Wallet account or private key not loaded. Cannot initialize Hyperliquid.");
    }

    transport = new HttpTransport({ isTestnet: IS_TESTNET });
    infoClient = new InfoClient({ transport });

    const privKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    signer = new PrivateKeySigner(privKey as `0x${string}`);

    exchangeClient = new ExchangeClient({ wallet: signer, transport, user: account.address as `0x${string}` });

    return { infoClient, exchangeClient };
}

// ─── Public Data Methods ─────────────────────────────────────────

/**
 * Fetch mid-price for a given asset.
 */
export async function getMidPrice(asset: string): Promise<number> {
    const { infoClient } = initHyperliquid();
    const allMids = await safeRequest(() => infoClient!.allMids());
    const price = allMids[asset];
    if (!price) throw new Error(`Price not found for asset: ${asset}`);
    return parseFloat(price);
}

/**
 * Checks if the agent's deterministic address is authorized to trade on behalf of the user.
 */
export async function checkAgentAuthorization(): Promise<{ authorized: boolean; agentAddress: string | null; userAddress: string | null }> {
    const { infoClient } = initHyperliquid();
    const userAccount = loadWalletAccount();
    const agentAddress = getSigningAddress();

    if (!userAccount || !agentAddress) return { authorized: false, agentAddress, userAddress: userAccount?.address || null };

    // An agent is authorized if userRole(agentAddress) returns { role: 'agent', data: { user: userAddress } }
    try {
        const role = await safeRequest(() => infoClient!.userRole({ user: agentAddress as `0x${string}` }));
        const isAuth = role.role === "agent" && role.data.user.toLowerCase() === userAccount.address.toLowerCase();

        // Update cache
        cachedAuth = {
            authorized: isAuth,
            agentAddress,
            userAddress: userAccount.address,
            timestamp: Date.now()
        };

        return {
            authorized: isAuth,
            agentAddress,
            userAddress: userAccount.address
        };
    } catch (err) {
        // If we hit a rate limit or error, but we have a cached 'true', trust it for stability
        if (cachedAuth && cachedAuth.authorized && (Date.now() - cachedAuth.timestamp < AUTH_CACHE_TTL)) {
            console.warn("[Hyperliquid] Using cached TRUE authorization status due to request failure.");
            return {
                authorized: true,
                agentAddress: cachedAuth.agentAddress,
                userAddress: cachedAuth.userAddress
            };
        }

        console.error("[Hyperliquid] Error checking agent authorization:", err);
        return { authorized: false, agentAddress, userAddress: userAccount.address };
    }
}

/**
 * Fetch market metadata and asset context.
 */
export async function getMarketInfo(asset: string): Promise<HyperliquidMarketInfo> {
    const { infoClient } = initHyperliquid();
    const [meta, assetCtxs] = await infoClient.metaAndAssetCtxs();

    const assetIndex = meta.universe.findIndex((a) => a.name === asset);
    if (assetIndex === -1) throw new Error(`Asset ${asset} not found in Hyperliquid universe.`);

    const universeAsset = meta.universe[assetIndex];
    const ctx = assetCtxs[assetIndex];

    return {
        name: asset,
        price: parseFloat(ctx.prevDayPx || "0"),
        funding: parseFloat(ctx.funding || "0"),
        szDecimals: universeAsset.szDecimals,
    };
}

/**
 * Fetch 15m candle data for an asset.
 */
export async function getCandles(asset: string, interval: "15m" | "1h" | "5m" = "15m", count: number = 100): Promise<Candle[]> {
    const { infoClient } = initHyperliquid();
    const intervalMs = interval === "15m" ? 15 * 60_000 : interval === "5m" ? 5 * 60_000 : 60 * 60_000;
    const startTime = Date.now() - (count * intervalMs);

    const raw = await safeRequest(() => infoClient.candleSnapshot({
        coin: asset,
        interval,
        startTime,
    }));

    return raw.map((c: any) => ({
        t: Number(c.t),
        o: parseFloat(c.o),
        h: parseFloat(c.h),
        l: parseFloat(c.l),
        c: parseFloat(c.c),
        v: parseFloat(c.v),
        n: Number(c.n),
    }));
}

/**
 * Get all tradable perp assets with sufficient volume.
 */
export async function getAllTradableAssets(): Promise<{
    assets: { name: string; index: number; szDecimals: number; volume24h: number; funding: number; price: number }[];
}> {
    const { infoClient } = initHyperliquid();
    const [meta, assetCtxs] = await safeRequest(() => infoClient.metaAndAssetCtxs());

    const assets = meta.universe.map((u, i) => {
        const ctx = assetCtxs[i];
        if (!ctx) return null;
        const price = parseFloat(ctx.markPx || ctx.prevDayPx || "0");
        const vol24h = parseFloat(ctx.dayNtlVlm || "0");
        const funding = parseFloat(ctx.funding || "0");
        return {
            name: u.name,
            index: i,
            szDecimals: u.szDecimals,
            volume24h: vol24h,
            funding,
            price,
        };
    }).filter((a): a is NonNullable<typeof a> => a !== null && a.volume24h >= SCALP_CONFIG.minVolume24h && a.price > 0);

    // Sort by volume descending
    assets.sort((a, b) => b.volume24h - a.volume24h);

    return { assets };
}

/**
 * Set leverage for an asset.
 */
export async function setLeverage(assetIndex: number, leverage: number, isCross: boolean = true): Promise<void> {
    const { exchangeClient } = initHyperliquid();
    try {
        await exchangeClient.updateLeverage({
            asset: assetIndex,
            isCross,
            leverage,
        });
        console.log(`[Hyperliquid] Leverage set to ${leverage}x for asset ${assetIndex}`);
    } catch (e: any) {
        // May fail if leverage is already set — that's OK
        console.log(`[Hyperliquid] Leverage update note: ${e.message}`);
    }
}

// ─── Private Data Methods ────────────────────────────────────────

/**
 * Fetch user account balance (unified account: Spot + Perps combined).
 */
export async function getBalance(): Promise<HyperliquidBalance> {
    const { infoClient } = initHyperliquid();
    const account = loadWalletAccount();
    if (!account) throw new Error("Wallet not loaded");

    // For unified accounts, we need both clearinghouses
    console.log(`[Hyperliquid] Fetching balance for address: ${account.address}`);
    const [userState, spotState] = await safeRequest(() => Promise.all([
        infoClient.clearinghouseState({ user: account.address }),
        infoClient.spotClearinghouseState({ user: account.address }),
    ]));

    const perpValue = parseFloat(userState.marginSummary?.accountValue || "0");
    const perpWithdrawable = parseFloat(userState.withdrawable || "0");
    console.log(`[Hyperliquid] Perp Account Value: ${perpValue}, Withdrawable: ${perpWithdrawable}`);

    // Spot USDC (unified accounts share this with perps)
    let spotUsdc = 0;
    console.log(`[Hyperliquid] Spot Balances: ${JSON.stringify(spotState.balances)}`);
    for (const b of spotState.balances) {
        if (b.coin === "USDC") {
            spotUsdc = parseFloat(b.total || "0");
            break;
        }
    }
    console.log(`[Hyperliquid] Final Spot USDC found: ${spotUsdc}`);

    // Unified account: total capital = perp account value + spot USDC
    // withdrawable = perp withdrawable + spot USDC (since unified shares)
    const totalValue = perpValue + spotUsdc;
    const withdrawable = perpWithdrawable + spotUsdc;
    console.log(`[Hyperliquid] Total Calculated Value: ${totalValue}`);

    return {
        withdrawable,
        totalValue,
        accountValue: totalValue,
    };
}

/**
 * Fetch open positions for the user.
 */
export async function getOpenPositions(): Promise<HyperliquidPosition[]> {
    const { infoClient } = initHyperliquid();
    const account = loadWalletAccount();
    if (!account) throw new Error("Wallet not loaded");

    const userState = await safeRequest(() => infoClient!.clearinghouseState({ user: account.address }));

    return userState.assetPositions.map((pos) => {
        const size = parseFloat(pos.position.szi);
        return {
            asset: pos.position.coin,
            side: size > 0 ? "LONG" : "SHORT",
            size: Math.abs(size),
            entryPrice: parseFloat(pos.position.entryPx),
            unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
            leverage: pos.position.leverage.value,
            marginUsed: parseFloat(pos.position.marginUsed),
        };
    });
}

/**
 * Helper to format price to Hyperliquid standards (5 significant figures).
 */
export function formatPrice(price: number): string {
    // Hyperliquid requires at most 5 significant figures
    // and at most 6 decimal places.
    let formatted = price.toPrecision(5);
    // Remove trailing zeros after decimal
    if (formatted.includes(".")) {
        formatted = formatted.replace(/\.?0+$/, "");
    }
    return formatted;
}

// ─── Trading Methods ─────────────────────────────────────────────

/**
 * Place a market order (using IOC limit order).
 */
export async function marketOrder(
    asset: string,
    isBuy: boolean,
    size: number,
    slippagePct: number = 1.0
): Promise<any> {
    const { infoClient, exchangeClient } = initHyperliquid();

    const [metaData, midPrice] = await Promise.all([
        infoClient.meta(),
        getMidPrice(asset),
    ]);

    const assetIndex = metaData.universe.findIndex((a: any) => a.name === asset);
    if (assetIndex === -1) throw new Error(`Asset ${asset} not found.`);

    const limitPrice = isBuy
        ? midPrice * (1 + slippagePct / 100)
        : midPrice * (1 - slippagePct / 100);

    const szDecimals = metaData.universe[assetIndex].szDecimals;
    const formattedSize = Number(size.toFixed(szDecimals));
    const formattedPrice = formatPrice(limitPrice);

    console.log(`[Hyperliquid] Executing ${isBuy ? "BUY" : "SELL"} ${formattedSize} ${asset} at approx ${midPrice} (Limit: ${formattedPrice})`);

    return await exchangeClient!.order({
        orders: [{
            a: assetIndex,
            b: isBuy,
            p: formattedPrice,
            s: String(formattedSize),
            r: false,
            t: {
                limit: { tif: "Ioc" }
            }
        }],
        grouping: "na"
    } as const);
}

/**
 * Close all positions for a specific asset.
 */
export async function closePosition(asset: string): Promise<any> {
    const positions = await getOpenPositions();
    const pos = positions.find(p => p.asset === asset);
    if (!pos) {
        console.log(`[Hyperliquid] No open position found for ${asset} to close.`);
        return null;
    }

    const isBuy = pos.side === "SHORT";
    const { infoClient, exchangeClient } = initHyperliquid();
    const [metaData, midPrice] = await Promise.all([
        infoClient.meta(),
        getMidPrice(asset),
    ]);

    const assetIndex = metaData.universe.findIndex((a: any) => a.name === asset);
    if (assetIndex === -1) {
        console.error(`[Hyperliquid] Asset ${asset} not found in universe during close.`);
        return null;
    }
    const slippagePct = 1.0;
    const limitPrice = isBuy
        ? midPrice * (1 + slippagePct / 100)
        : midPrice * (1 - slippagePct / 100);

    const szDecimals = metaData.universe[assetIndex].szDecimals;
    const formattedSize = Number(pos.size.toFixed(szDecimals));
    const formattedPrice = formatPrice(limitPrice);

    console.log(`[Hyperliquid] Closing ${pos.side} position for ${asset}: ${formattedSize} unit(s)`);

    return await exchangeClient!.order({
        orders: [{
            a: assetIndex,
            b: isBuy,
            p: formattedPrice,
            s: String(formattedSize),
            r: true,
            t: {
                limit: { tif: "Ioc" }
            }
        }],
        grouping: "na"
    });
}

// ─── Smart Scanning ─────────────────────────────────────────────

/**
 * Full-universe TA scan: fetch candles for top-volume assets, run TA,
 * return ranked opportunities above confidence threshold.
 */
export async function scanBestOpportunity(_inference?: any): Promise<{
    all: AssetOpportunity[];
    topPick: AssetOpportunity | null;
    scannedCount: number;
}> {
    const { assets } = await getAllTradableAssets();
    console.log(`[Hyperliquid] Scanning ${assets.length} assets with volume ≥ $${(SCALP_CONFIG.minVolume24h / 1000).toFixed(0)}K...`);

    // Scan top 60 by volume for better coverage
    const topAssets = assets.slice(0, 60);

    const results: AssetOpportunity[] = [];
    const batchSize = 10;
    let processedCount = 0;

    for (let i = 0; i < topAssets.length; i += batchSize) {
        const batch = topAssets.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (a) => {
            try {
                const candles = await getCandles(a.name, "5m", 100);
                processedCount++;
                if (candles.length < 30) {
                    console.log(`[Hyperliquid] ${a.name} skipped: Not enough candle data (${candles.length}/30)`);
                    return null;
                }

                const signal = analyze(candles, SCALP_CONFIG.defaultLeverage);
                if (signal.direction === "NEUTRAL") {
                    console.log(`[Hyperliquid] ${a.name} neutral: Score ${signal.score} (RSI: ${signal.indicators.rsi.toFixed(1)})`);
                    return null;
                }
                if (signal.confidence < SCALP_CONFIG.minConfidence) {
                    console.log(`[Hyperliquid] ${a.name} low confidence: ${signal.confidence}% < ${SCALP_CONFIG.minConfidence}%`);
                    return null;
                }

                return {
                    market: a.name,
                    signal,
                    volume24h: a.volume24h,
                    funding: a.funding,
                    price: a.price,
                    szDecimals: a.szDecimals,
                    assetIndex: a.index,
                } as AssetOpportunity;
            } catch (err: any) {
                console.warn(`[Hyperliquid] Error scanning ${a.name}: ${err.message}`);
                return null;
            }
        }));
        results.push(...batchResults.filter((r): r is AssetOpportunity => r !== null));
    }

    // Sort by confidence descending
    results.sort((a, b) => b.signal.confidence - a.signal.confidence);

    console.log(`[Hyperliquid] Scan complete. Processed: ${processedCount} | Opportunities found: ${results.length}`);

    return {
        all: results,
        topPick: results.length > 0 ? results[0] : null,
        scannedCount: processedCount,
    };
}

/**
 * Check if a position should be closed based on dynamic TP/SL.
 */
export async function checkPositionTPSL(pos: any, _inference?: any): Promise<any> {
    const currentPrice = await getMidPrice(pos.market);
    const pnlPct = pos.side === "LONG"
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;

    // Use stored dynamic TP/SL (or defaults)
    const tp = (pos.dynamicTP || 2.5) * pos.leverage;
    const sl = (pos.dynamicSL || 0.8) * pos.leverage;

    // Trailing SL: if profit > activation threshold, tighten SL
    const trailActivation = (pos.dynamicTP || 2.5) * pos.leverage * 0.5;
    let effectiveSL = sl;
    if (pnlPct > trailActivation) {
        // Trail SL to lock in at least 30% of current profit
        effectiveSL = pnlPct * 0.7; // e.g. if profit is 10%, trail SL at 7%
    }

    if (pnlPct >= tp) {
        return { shouldClose: true, reason: "Take Profit ✅", pnlPct, currentPrice, tp, sl: effectiveSL };
    }
    if (pnlPct <= -sl) {
        return { shouldClose: true, reason: "Stop Loss 🛑", pnlPct, currentPrice, tp, sl: effectiveSL };
    }

    // Trailing stop: after activation, if profit drops below the trailing threshold, close
    if (pnlPct > 0 && pnlPct < effectiveSL && effectiveSL > sl * 0.5) {
        return { shouldClose: true, reason: "Trailing Stop 📉", pnlPct, currentPrice, tp, sl: effectiveSL };
    }

    return { shouldClose: false, pnlPct, currentPrice, tp, sl: effectiveSL };
}

/**
 * Calculate compounded margin for a new position.
 * Uses compoundRatio of total capital, capped at maxMarginPct.
 * SAFEGUARD: Ensures balance - margin >= 1.0.
 */
export function getCompoundedMargin(balance: number): number {
    if (balance <= 1.0) return 0;

    // Allocate margin based on config
    let margin = balance * SCALP_CONFIG.maxMarginPct * SCALP_CONFIG.compoundRatio;

    // Protect $1.00 reserve: balance - margin must be >= 1.0
    // So margin must be <= balance - 1.0
    const maxSafeMargin = Math.max(0, balance - 1.01); // 1.01 to leave a tiny buffer

    margin = Math.min(margin, maxSafeMargin);

    return Math.max(0, margin);
}
