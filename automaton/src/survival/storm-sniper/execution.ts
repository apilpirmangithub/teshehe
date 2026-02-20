/**
 * Storm Sniper Elite — Execution Layer
 *
 * Sniper entry, liquidity checks, smart exits, time decay handling.
 * Precise entry with dynamic TP/SL based on volatility.
 */

import type {
  StormSniperConfig,
  SniperEntry,
  SniperPosition,
  ExitSignal,
  LiquidityReport,
  ConvictionScore,
  ShockScore,
  VolatilityState,
} from "./types.js";
import {
  getOrderBook,
  getMidpoint,
} from "../polymarket-client.js";
import { historicalDb } from "./data.js";

// ─── Liquidity Check ───────────────────────────────────────────

/**
 * Check orderbook depth and spread for a token.
 * Quality score 0–1 based on depth, spread, and our intended size.
 */
export async function checkLiquidity(
  tokenId: string,
  intendedSizeUsd: number,
): Promise<LiquidityReport> {
  try {
    const book = await getOrderBook(tokenId);

    // Parse orderbook
    let bidDepthUsd = 0;
    let askDepthUsd = 0;
    let bestBid = 0;
    let bestAsk = 1;

    if (book && typeof book === "object") {
      const bids = (book as any).bids || [];
      const asks = (book as any).asks || [];

      for (const bid of bids) {
        const price = parseFloat(bid.price || bid.p || "0");
        const size = parseFloat(bid.size || bid.s || "0");
        bidDepthUsd += price * size;
        if (price > bestBid) bestBid = price;
      }

      for (const ask of asks) {
        const price = parseFloat(ask.price || ask.p || "0");
        const size = parseFloat(ask.size || ask.s || "0");
        askDepthUsd += price * size;
        if (price < bestAsk) bestAsk = price;
      }
    }

    const spread = bestAsk - bestBid;
    const totalDepth = bidDepthUsd + askDepthUsd;

    // Quality: low spread + deep book + our size fits
    const spreadScore = Math.max(0, 1 - spread / 0.05);       // 0.05 spread = 0 quality
    const depthScore = Math.min(1, totalDepth / 5000);         // $5k depth = max
    const sizeScore = totalDepth > 0
      ? Math.min(1, (totalDepth * 0.1) / intendedSizeUsd)     // our size < 10% of depth
      : 0;

    const qualityScore = spreadScore * 0.4 + depthScore * 0.3 + sizeScore * 0.3;

    return {
      tokenId,
      bidDepthUsd,
      askDepthUsd,
      spread,
      qualityScore,
      sufficient: qualityScore > 0.4 && totalDepth > intendedSizeUsd * 3,
    };
  } catch {
    // Can't read orderbook → assume moderate quality
    return {
      tokenId,
      bidDepthUsd: 0,
      askDepthUsd: 0,
      spread: 0.02,
      qualityScore: 0.5,
      sufficient: true, // don't block on orderbook failure
    };
  }
}

// ─── Sniper Entry ──────────────────────────────────────────────

/**
 * Build the precise entry parameters for a sniper trade.
 * Dynamic take-profit based on volatility (6–9%).
 * Tight stop loss at 3%.
 */
export function buildSniperEntry(
  marketId: string,
  marketTitle: string,
  side: "YES" | "NO",
  tokenId: string,
  currentPrice: number,
  sizeUsd: number,
  conviction: ConvictionScore,
  shock: ShockScore,
  volatility: VolatilityState,
  cfg: StormSniperConfig,
): SniperEntry {
  // Dynamic take profit: 6% base, up to 9% if volatility is low
  // Lower vol = wider target (market is calm, can hold longer)
  const tpRange = cfg.takeProfitMaxPct - cfg.takeProfitMinPct;
  const tpPct = cfg.takeProfitMinPct + tpRange * (1 - volatility.scaler); // inverse: low vol → higher TP
  const slPct = cfg.stopLossPct;

  const takeProfit = side === "YES"
    ? currentPrice * (1 + tpPct)
    : currentPrice * (1 - tpPct);

  const stopLoss = side === "YES"
    ? currentPrice * (1 - slPct)
    : currentPrice * (1 + slPct);

  // Clamp to valid range (0.01 – 0.99)
  const clamp = (v: number) => Math.max(0.01, Math.min(0.99, v));

  return {
    marketId,
    marketTitle,
    side,
    tokenId,
    entryPrice: currentPrice,
    sizeUsd,
    conviction,
    shock,
    stopLoss: clamp(stopLoss),
    takeProfit: clamp(takeProfit),
    maxHoldHours: cfg.maxHoldHours,
    timestamp: new Date().toISOString(),
  };
}

// ─── Smart Exit Engine ─────────────────────────────────────────

/**
 * Check all exit conditions for a position.
 * Returns the strongest exit signal (or shouldExit=false).
 *
 * Exit triggers:
 * 1. Take Profit: +6–9% (dynamic)
 * 2. Stop Loss: -3%
 * 3. Momentum Reversal: price reversed from peak
 * 4. Forecast Collapse: weather no longer supports trade
 * 5. Time Decay: max 4 hours
 */
export async function evaluateExit(
  position: SniperPosition,
  cfg: StormSniperConfig,
): Promise<ExitSignal> {
  // Fetch live price
  let currentPrice = position.currentPrice;
  try {
    const mid = await getMidpoint(position.tokenId);
    if (mid > 0.01 && mid < 0.99) currentPrice = mid;
  } catch {}

  const pnlPct = position.side === "YES"
    ? (currentPrice - position.entryPrice) / position.entryPrice
    : (position.entryPrice - currentPrice) / position.entryPrice;

  // 1. Take Profit
  if (position.side === "YES" && currentPrice >= position.takeProfit) {
    return {
      type: "take_profit",
      currentPrice,
      entryPrice: position.entryPrice,
      pnlPct,
      shouldExit: true,
      reason: `TP hit: ${(pnlPct * 100).toFixed(1)}% gain (target: ${position.takeProfit.toFixed(4)})`,
    };
  }
  if (position.side === "NO" && currentPrice <= position.takeProfit) {
    return {
      type: "take_profit",
      currentPrice,
      entryPrice: position.entryPrice,
      pnlPct,
      shouldExit: true,
      reason: `TP hit: ${(pnlPct * 100).toFixed(1)}% gain (target: ${position.takeProfit.toFixed(4)})`,
    };
  }

  // 2. Stop Loss
  if (position.side === "YES" && currentPrice <= position.stopLoss) {
    return {
      type: "stop_loss",
      currentPrice,
      entryPrice: position.entryPrice,
      pnlPct,
      shouldExit: true,
      reason: `SL hit: ${(pnlPct * 100).toFixed(1)}% loss (stop: ${position.stopLoss.toFixed(4)})`,
    };
  }
  if (position.side === "NO" && currentPrice >= position.stopLoss) {
    return {
      type: "stop_loss",
      currentPrice,
      entryPrice: position.entryPrice,
      pnlPct,
      shouldExit: true,
      reason: `SL hit: ${(pnlPct * 100).toFixed(1)}% loss (stop: ${position.stopLoss.toFixed(4)})`,
    };
  }

  // 3. Momentum Reversal: was profitable but now giving back > 50% of gains
  const priceHistory = historicalDb.getPriceHistory(position.marketId, 20);
  if (priceHistory.length >= 5) {
    const recentPrices = priceHistory.map((p) => p.price);
    const peak = position.side === "YES"
      ? Math.max(...recentPrices)
      : Math.min(...recentPrices);
    const peakPnl = position.side === "YES"
      ? (peak - position.entryPrice) / position.entryPrice
      : (position.entryPrice - peak) / position.entryPrice;

    if (peakPnl > 0.02 && pnlPct < peakPnl * 0.5) {
      return {
        type: "momentum_reversal",
        currentPrice,
        entryPrice: position.entryPrice,
        pnlPct,
        shouldExit: true,
        reason: `Momentum reversal: was +${(peakPnl * 100).toFixed(1)}%, now +${(pnlPct * 100).toFixed(1)}% (gave back >50% of gains)`,
      };
    }
  }

  // 4. Time Decay: max hold period exceeded
  const holdMs = Date.now() - new Date(position.entryTime).getTime();
  const holdHours = holdMs / (1000 * 60 * 60);
  if (holdHours >= position.maxHoldHours) {
    return {
      type: "time_decay",
      currentPrice,
      entryPrice: position.entryPrice,
      pnlPct,
      shouldExit: true,
      reason: `Time exit: held ${holdHours.toFixed(1)}h (max: ${position.maxHoldHours}h). No hope holding.`,
    };
  }

  // No exit signal
  return {
    type: "take_profit",
    currentPrice,
    entryPrice: position.entryPrice,
    pnlPct,
    shouldExit: false,
    reason: `Holding: ${(pnlPct * 100).toFixed(1)}%, ${holdHours.toFixed(1)}h elapsed`,
  };
}
