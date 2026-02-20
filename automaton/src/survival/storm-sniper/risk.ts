/**
 * Storm Sniper Elite — Risk Management
 *
 * Adaptive position sizing, Monte Carlo guard, drawdown kill switch, volatility scaler.
 * This is what keeps the system ALIVE long-term.
 *
 * Position Size = base * (1 + conviction * 0.5), capped at 20%
 * Monte Carlo: simulate 1000 scenarios → if max DD > 25% → cut size 40%
 * Discipline: 1 loss → -30% size, 2 losses → 24h pause, 6% daily DD → stop
 */

import type {
  StormSniperConfig,
  ConvictionScore,
  PositionSize,
  MonteCarloResult,
  DrawdownState,
  VolatilityState,
  SniperPortfolio,
} from "./types.js";
import { historicalDb } from "./data.js";

// ─── Adaptive Position Sizer ───────────────────────────────────

/**
 * Calculate position size based on conviction, volatility, drawdown, and MC guard.
 * Conservative by default, aggressive only when ALL signals align.
 */
export function calculatePositionSize(
  bankroll: number,
  conviction: ConvictionScore,
  volatility: VolatilityState,
  drawdown: DrawdownState,
  mcResult: MonteCarloResult,
  cfg: StormSniperConfig,
): PositionSize {
  // Base: 12% of bankroll
  const baseSize = bankroll * cfg.baseSizePct;

  // Adjust by conviction: higher conviction → bigger size
  const convictionAdjust = conviction.composite * 0.5;
  let adjustedSize = baseSize * (1 + convictionAdjust);

  // Track modifications
  let volScaled = false;
  let mcReduced = false;
  let reductionReason: string | undefined;

  // Volatility scaling: high vol → smaller size
  adjustedSize *= volatility.scaler;
  if (volatility.scaler < 1) {
    volScaled = true;
    reductionReason = `Vol scaler: ${volatility.scaler.toFixed(2)}`;
  }

  // Drawdown discipline: consecutive losses reduce size
  adjustedSize *= drawdown.sizeMultiplier;
  if (drawdown.sizeMultiplier < 1) {
    reductionReason = (reductionReason ? reductionReason + " | " : "") +
      `DD multiplier: ${drawdown.sizeMultiplier.toFixed(2)} (${drawdown.consecutiveLosses} consec losses)`;
  }

  // Monte Carlo guard: if estimated max DD > threshold → cut 40%
  if (mcResult.shouldReduceSize) {
    adjustedSize *= mcResult.reductionFactor;
    mcReduced = true;
    reductionReason = (reductionReason ? reductionReason + " | " : "") +
      `MC guard: est DD ${(mcResult.estimatedMaxDrawdown * 100).toFixed(1)}% > ${(cfg.mcMaxDrawdownPct * 100).toFixed(0)}%`;
  }

  // Hard cap: never more than 20% of bankroll
  const maxSize = bankroll * cfg.maxSizePct;
  const cappedAt20Pct = adjustedSize > maxSize;
  const finalSize = Math.max(0, Math.min(adjustedSize, maxSize));

  return {
    baseSize,
    adjustedSize: adjustedSize,
    finalSize: Math.round(finalSize * 100) / 100,
    cappedAt20Pct,
    volScaled,
    mcReduced,
    reductionReason,
  };
}

// ─── Monte Carlo Risk Guard ───────────────────────────────────

/**
 * Simulate N random scenarios to estimate worst-case drawdown.
 * Uses historical win rate and P&L distribution.
 * If estimated max drawdown > 25% → reduce size by 40%.
 */
export function runMonteCarloGuard(
  portfolio: SniperPortfolio,
  proposedSizeUsd: number,
  cfg: StormSniperConfig,
): MonteCarloResult {
  const simulations = cfg.mcSimulations;

  // Historical win rate (or default 45%)
  const winRate = portfolio.totalTrades > 5
    ? portfolio.winRate
    : 0.45;

  // Average win/loss in percentage terms
  const avgWinPct = (cfg.takeProfitMinPct + cfg.takeProfitMaxPct) / 2; // ~7.5%
  const avgLossPct = cfg.stopLossPct; // 3%

  const drawdowns: number[] = [];
  const returns: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let balance = portfolio.bankroll;
    let peak = balance;
    let maxDD = 0;

    // Simulate 20 trades (roughly a month at our frequency)
    for (let t = 0; t < 20; t++) {
      const isWin = Math.random() < winRate;
      const pnl = isWin
        ? proposedSizeUsd * avgWinPct * (0.8 + Math.random() * 0.4) // some variance
        : -proposedSizeUsd * avgLossPct * (0.8 + Math.random() * 0.4);

      balance += pnl;
      peak = Math.max(peak, balance);
      const dd = (peak - balance) / peak;
      maxDD = Math.max(maxDD, dd);
    }

    drawdowns.push(maxDD);
    returns.push((balance - portfolio.bankroll) / portfolio.bankroll);
  }

  const estimatedMaxDrawdown = percentile(drawdowns, 0.95); // 95th percentile worst DD
  const estimatedAvgReturn = mean(returns);
  const percentWin = returns.filter((r) => r > 0).length / simulations;

  const shouldReduceSize = estimatedMaxDrawdown > cfg.mcMaxDrawdownPct;
  const reductionFactor = shouldReduceSize ? cfg.mcReductionFactor : 1.0;

  return {
    simulations,
    estimatedMaxDrawdown,
    estimatedAvgReturn,
    percentWin,
    shouldReduceSize,
    reductionFactor,
  };
}

// ─── Drawdown Kill Switch ──────────────────────────────────────

/**
 * Enforce hard discipline rules:
 * - 1 consecutive loss → size -30%
 * - 2 consecutive losses → pause 24h
 * - Daily DD 6% → stop for the day
 * - Weekly DD 12% → full shutdown
 */
export function evaluateDrawdown(
  portfolio: SniperPortfolio,
  cfg: StormSniperConfig,
): DrawdownState {
  const state: DrawdownState = {
    consecutiveLosses: 0,
    dailyLossUsd: Math.abs(portfolio.todayPnlUsd < 0 ? portfolio.todayPnlUsd : 0),
    dailyLossPct: 0,
    weeklyLossUsd: Math.abs(portfolio.weekPnlUsd < 0 ? portfolio.weekPnlUsd : 0),
    weeklyLossPct: 0,
    isPaused: false,
    isShutdown: false,
    sizeMultiplier: 1.0,
  };

  // Count consecutive losses from trade history
  state.consecutiveLosses = portfolio.drawdown.consecutiveLosses;

  // Daily loss percentage
  state.dailyLossPct = portfolio.bankroll > 0
    ? state.dailyLossUsd / portfolio.bankroll
    : 0;

  // Weekly loss percentage
  state.weeklyLossPct = portfolio.bankroll > 0
    ? state.weeklyLossUsd / portfolio.bankroll
    : 0;

  // Check if still paused from previous losses
  if (portfolio.drawdown.pauseUntil) {
    const pauseEnd = new Date(portfolio.drawdown.pauseUntil).getTime();
    if (Date.now() < pauseEnd) {
      state.isPaused = true;
      state.pauseUntil = portfolio.drawdown.pauseUntil;
      state.reason = `Paused until ${portfolio.drawdown.pauseUntil} (${state.consecutiveLosses} consecutive losses)`;
      state.sizeMultiplier = 0;
      return state;
    }
  }

  // Rule 1: 1 loss → size -30%
  if (state.consecutiveLosses >= 1) {
    state.sizeMultiplier = cfg.lossReductionFactor; // 0.7
  }

  // Rule 2: 2+ consecutive losses → pause 24h
  if (state.consecutiveLosses >= cfg.pauseAfterConsecLosses) {
    state.isPaused = true;
    state.pauseUntil = new Date(Date.now() + cfg.pauseHours * 60 * 60 * 1000).toISOString();
    state.sizeMultiplier = 0;
    state.reason = `${state.consecutiveLosses} consecutive losses → paused ${cfg.pauseHours}h`;
    return state;
  }

  // Rule 3: Daily DD > 6%  → stop for the day
  if (state.dailyLossPct >= cfg.dailyStopLossPct) {
    state.isPaused = true;
    const midnight = new Date();
    midnight.setHours(23, 59, 59, 999);
    state.pauseUntil = midnight.toISOString();
    state.sizeMultiplier = 0;
    state.reason = `Daily DD ${(state.dailyLossPct * 100).toFixed(1)}% >= ${(cfg.dailyStopLossPct * 100).toFixed(0)}% limit`;
    return state;
  }

  // Rule 4: Weekly DD > 12% → full shutdown
  if (state.weeklyLossPct >= cfg.weeklyStopLossPct) {
    state.isShutdown = true;
    state.sizeMultiplier = 0;
    state.reason = `Weekly DD ${(state.weeklyLossPct * 100).toFixed(1)}% >= ${(cfg.weeklyStopLossPct * 100).toFixed(0)}% limit → SHUTDOWN`;
    return state;
  }

  return state;
}

// ─── Volatility Scaler ─────────────────────────────────────────

/**
 * Measure market price volatility and produce a scaling factor.
 * High volatility → smaller position (0.5–1.0 multiplier).
 */
export function computeVolatility(marketId: string): VolatilityState {
  const prices = historicalDb.getPriceHistory(marketId, 120); // last ~10 hours

  if (prices.length < 5) {
    return {
      currentVol: 0,
      historicalVol: 0,
      volRatio: 1,
      scaler: 1.0,
    };
  }

  // Recent volatility: last 12 prices (~1 hour)
  const recentPrices = prices.slice(-12).map((p: { price: number }) => p.price);
  const currentVol = computePriceVol(recentPrices);

  // Historical volatility: all available prices
  const allPrices = prices.map((p: { price: number }) => p.price);
  const historicalVol = computePriceVol(allPrices);

  // Ratio: current vol relative to historical
  const volRatio = historicalVol > 0 ? currentVol / historicalVol : 1;

  // Scaler: if vol is 2x normal → 0.5x size; if normal → 1.0x
  // Linear scaling between 0.5 and 1.0
  const scaler = Math.max(0.5, Math.min(1.0, 1.5 - volRatio * 0.5));

  return {
    currentVol,
    historicalVol,
    volRatio,
    scaler,
  };
}

function computePriceVol(prices: number[]): number {
  if (prices.length < 2) return 0;
  // Log returns
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  if (returns.length === 0) return 0;
  const m = mean(returns);
  const variance = returns.reduce((sum, r) => sum + (r - m) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// ─── Math Helpers ──────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}
