/**
 * 🌪️ Storm Sniper Elite — Main Orchestrator
 *
 * Ultra Selective · Adaptive · Capital Preserving
 * Aggressive ONLY when statistical edge is extreme.
 *
 * Flow: Scan → Weather → Shock → Lag → Conviction → Risk → Fire/Skip
 * 90–97% of scans → NO TRADE. Only fires when ALL signals align.
 */

import type {
  StormSniperConfig,
  SniperPortfolio,
  SniperPosition,
  DrawdownState,
  VolatilityState,
  SniperEntry,
  ConvictionScore,
  ShockScore,
  ExitSignal,
} from "./types.js";
import { DEFAULT_SNIPER_CONFIG } from "./types.js";
import {
  fetchEnsembleForecast,
  analyzePressure,
  historicalDb,
} from "./data.js";
import {
  computeShockScore,
  detectMarketLag,
  computeConviction,
} from "./alpha.js";
import {
  calculatePositionSize,
  runMonteCarloGuard,
  evaluateDrawdown,
  computeVolatility,
} from "./risk.js";
import {
  checkLiquidity,
  buildSniperEntry,
  evaluateExit,
} from "./execution.js";
import {
  fetchGammaMarkets,
  getMidpoint,
  getOrCreateClobClient,
  placeLimitOrder,
  type ParsedMarket,
} from "../polymarket-client.js";

// ─── State ─────────────────────────────────────────────────────

let portfolio: SniperPortfolio = {
  bankroll: 0,
  availableBalance: 0,
  openPositions: [],
  todayTrades: 0,
  todayPnlUsd: 0,
  todayPnlPct: 0,
  weekPnlUsd: 0,
  weekPnlPct: 0,
  totalTrades: 0,
  totalWins: 0,
  totalLosses: 0,
  winRate: 0,
  avgRR: 0,
  drawdown: {
    consecutiveLosses: 0,
    dailyLossUsd: 0,
    dailyLossPct: 0,
    weeklyLossUsd: 0,
    weeklyLossPct: 0,
    isPaused: false,
    isShutdown: false,
    sizeMultiplier: 1.0,
  },
};

let config: StormSniperConfig = { ...DEFAULT_SNIPER_CONFIG };
let walletPrivateKey: string | null = null;
let walletAddress: string | null = null;
let _initialized = false;

// Day tracking for daily/weekly resets
let _dayKey = "";
let _weekKey = "";

// ─── Initialization ────────────────────────────────────────────

export function initStormSniper(opts: {
  bankroll: number;
  privateKey?: string;
  address?: string;
  config?: Partial<StormSniperConfig>;
}): void {
  portfolio.bankroll = opts.bankroll;
  portfolio.availableBalance = opts.bankroll;
  if (opts.privateKey) walletPrivateKey = opts.privateKey;
  if (opts.address) walletAddress = opts.address;
  if (opts.config) config = { ...DEFAULT_SNIPER_CONFIG, ...opts.config };
  _initialized = true;

  // Day/week tracking
  const now = new Date();
  _dayKey = now.toISOString().slice(0, 10);
  _weekKey = `${now.getFullYear()}-W${getWeekNumber(now)}`;

  console.log(`[🌪️ Storm Sniper] Initialized | bankroll: $${opts.bankroll.toFixed(2)} | config: shock≥${config.shockThreshold}, conviction≥${config.convictionThreshold}`);
}

function getWeekNumber(d: Date): number {
  const oneJan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7);
}

function resetDailyIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _dayKey) {
    _dayKey = today;
    portfolio.todayTrades = 0;
    portfolio.todayPnlUsd = 0;
    portfolio.todayPnlPct = 0;
    portfolio.drawdown.dailyLossUsd = 0;
    portfolio.drawdown.dailyLossPct = 0;
    console.log(`[🌪️ Storm Sniper] Daily reset — new day: ${today}`);
  }
  const now = new Date();
  const weekKey = `${now.getFullYear()}-W${getWeekNumber(now)}`;
  if (weekKey !== _weekKey) {
    _weekKey = weekKey;
    portfolio.weekPnlUsd = 0;
    portfolio.weekPnlPct = 0;
    portfolio.drawdown.weeklyLossUsd = 0;
    portfolio.drawdown.weeklyLossPct = 0;
    portfolio.drawdown.isShutdown = false;
    console.log(`[🌪️ Storm Sniper] Weekly reset — new week: ${weekKey}`);
  }
}

// ─── Core Scan Pipeline ────────────────────────────────────────

export interface ScanResult {
  market: ParsedMarket;
  shock: ShockScore;
  conviction: ConvictionScore;
  entry: SniperEntry | null;
  decision: "FIRE" | "WATCH" | "SKIP";
  reason: string;
}

/**
 * Full storm scan pipeline:
 * 1. Fetch weather-related markets from Gamma API
 * 2. For each market: weather → shock → lag → conviction → risk → decision
 * 3. Returns sorted by conviction (highest first)
 *
 * This is the heart of the system.
 */
export async function stormScan(
  keyword: string = "weather",
  locations: string[] = ["New York", "London", "Tokyo", "Sydney"],
): Promise<ScanResult[]> {
  resetDailyIfNeeded();

  // Pre-check: are we paused or shut down?
  const ddState = evaluateDrawdown(portfolio, config);
  portfolio.drawdown = ddState;
  if (ddState.isShutdown) {
    return [{
      market: {} as any,
      shock: {} as any,
      conviction: {} as any,
      entry: null,
      decision: "SKIP",
      reason: `🛑 SHUTDOWN: ${ddState.reason}`,
    }];
  }
  if (ddState.isPaused) {
    const resumeTime = ddState.pauseUntil
      ? new Date(ddState.pauseUntil).toLocaleString()
      : "unknown";
    return [{
      market: {} as any,
      shock: {} as any,
      conviction: {} as any,
      entry: null,
      decision: "SKIP",
      reason: `⏸️ PAUSED until ${resumeTime}: ${ddState.reason}`,
    }];
  }

  // Max trades per day
  if (portfolio.todayTrades >= config.maxTradesPerDay) {
    return [{
      market: {} as any,
      shock: {} as any,
      conviction: {} as any,
      entry: null,
      decision: "SKIP",
      reason: `📊 Max daily trades reached (${portfolio.todayTrades}/${config.maxTradesPerDay})`,
    }];
  }

  console.log(`[🌪️ Storm Sniper] Scanning — keyword="${keyword}", locations=${locations.length}`);

  // 1. Fetch weather ensemble for each location
  const ensembles = await Promise.all(
    locations.map((loc) => fetchEnsembleForecast(loc)),
  );

  // 2. Analyze pressure for each location (use ensemble mean pressure)
  const pressures = locations.map((loc, i) => analyzePressure(loc, ensembles[i].meanPressure));

  // 3. Compute shock scores
  const shockByLocation = new Map<string, ShockScore>();
  for (let i = 0; i < locations.length; i++) {
    const shock = computeShockScore(ensembles[i], pressures[i], locations[i], config);
    shockByLocation.set(locations[i].toLowerCase(), shock);
    console.log(`[🌪️] ${locations[i]}: shock=${shock.composite.toFixed(3)} ${shock.triggered ? "🔥" : "⬜"}`);
  }

  // 4. Fetch markets
  let markets: ParsedMarket[];
  try {
    markets = await fetchGammaMarkets({
      keyword,
      limit: 30,
      minVolume24hr: 500,
      active: true,
      closed: false,
    });
    // Also broaden search if few results
    if (markets.length < 5) {
      const broader = await fetchGammaMarkets({
        limit: 30,
        minVolume24hr: 5000,
        active: true,
        closed: false,
      });
      // Merge without duplicates
      const ids = new Set(markets.map((m) => m.id));
      for (const m of broader) {
        if (!ids.has(m.id)) markets.push(m);
      }
    }
  } catch (err) {
    console.error(`[🌪️ Storm Sniper] Market fetch failed: ${err}`);
    return [];
  }

  if (markets.length === 0) {
    return [{
      market: {} as any,
      shock: {} as any,
      conviction: {} as any,
      entry: null,
      decision: "SKIP",
      reason: "No active markets found",
    }];
  }

  console.log(`[🌪️ Storm Sniper] Found ${markets.length} markets, analyzing...`);

  // 5. For each market, run the full analysis pipeline
  const results: ScanResult[] = [];

  for (const market of markets) {
    try {
      const result = await analyzeMarket(market, shockByLocation, ensembles[0], config);
      results.push(result);
    } catch (err) {
      // Skip failed analyses silently
    }
  }

  // Sort by conviction (highest first)
  results.sort((a, b) => {
    if (a.decision === "FIRE" && b.decision !== "FIRE") return -1;
    if (b.decision === "FIRE" && a.decision !== "FIRE") return 1;
    return (b.conviction?.composite ?? 0) - (a.conviction?.composite ?? 0);
  });

  const fireCount = results.filter((r) => r.decision === "FIRE").length;
  console.log(`[🌪️ Storm Sniper] Analysis complete: ${results.length} markets → ${fireCount} FIRE signals`);

  return results;
}

// ─── Single Market Analysis ────────────────────────────────────

async function analyzeMarket(
  market: ParsedMarket,
  shockByLocation: Map<string, ShockScore>,
  defaultEnsemble: any,
  cfg: StormSniperConfig,
): Promise<ScanResult> {
  // Try to detect location from market question
  const location = extractLocationFromQuestion(market.question);
  const shock = shockByLocation.get(location.toLowerCase())
    || shockByLocation.values().next().value
    || { zScore: 0, forecastAcceleration: 0, ensembleDivergence: 0, pressureAnomaly: 0, composite: 0, triggered: false };

  // Get live midpoint
  let yesPrice = market.yesPrice;
  try {
    const mid = await getMidpoint(market.yesTokenId);
    if (mid > 0.01 && mid < 0.99) yesPrice = mid;
  } catch {}

  // Record price for history
  historicalDb.pushPrice(market.id, yesPrice);

  // Determine forecast probability from weather
  // Simple heuristic: if question mentions rain/snow/storm → use rain prob
  const weatherProb = estimateWeatherProbability(market.question, defaultEnsemble);

  // Edge: |forecast - market|
  const edge = Math.abs(weatherProb - yesPrice);
  const side: "YES" | "NO" = weatherProb > yesPrice ? "YES" : "NO";
  const tokenId = side === "YES" ? market.yesTokenId : market.noTokenId;
  const entryPrice = side === "YES" ? yesPrice : (1 - yesPrice);

  // Check if edge meets minimum
  if (edge < cfg.minEdge) {
    return {
      market,
      shock,
      conviction: { edge, shockScore: shock.composite, liquidityQuality: 0, composite: 0, triggered: false, recommendation: "SKIP" },
      entry: null,
      decision: "SKIP",
      reason: `Edge too low: ${(edge * 100).toFixed(1)}% < ${(cfg.minEdge * 100).toFixed(0)}% min`,
    };
  }

  // Liquidity check
  const liquidity = await checkLiquidity(tokenId, portfolio.bankroll * cfg.baseSizePct);

  // Conviction
  const conviction = computeConviction(edge, shock, liquidity, cfg);

  // Not enough conviction
  if (!conviction.triggered) {
    return {
      market,
      shock,
      conviction,
      entry: null,
      decision: conviction.composite >= 0.6 ? "WATCH" : "SKIP",
      reason: `Conviction ${conviction.composite.toFixed(3)} < ${cfg.convictionThreshold} threshold`,
    };
  }

  // Risk checks
  const volatility = computeVolatility(market.id);
  const proposedSize = portfolio.availableBalance * cfg.baseSizePct;
  const mcResult = runMonteCarloGuard(portfolio, proposedSize, cfg);

  const posSize = calculatePositionSize(
    portfolio.availableBalance,
    conviction,
    volatility,
    portfolio.drawdown,
    mcResult,
    cfg,
  );

  // Minimum order size check
  if (posSize.finalSize < (market.minOrderSize || 1)) {
    return {
      market,
      shock,
      conviction,
      entry: null,
      decision: "SKIP",
      reason: `Size too small: $${posSize.finalSize.toFixed(2)} < min $${market.minOrderSize}`,
    };
  }

  // Build entry
  const entry = buildSniperEntry(
    market.id,
    market.question,
    side,
    tokenId,
    entryPrice,
    posSize.finalSize,
    conviction,
    shock,
    volatility,
    cfg,
  );

  return {
    market,
    shock,
    conviction,
    entry,
    decision: "FIRE",
    reason: `🎯 FIRE | edge=${(edge * 100).toFixed(1)}% | conviction=${conviction.composite.toFixed(3)} | shock=${shock.composite.toFixed(3)} | size=$${posSize.finalSize.toFixed(2)} | TP=${entry.takeProfit.toFixed(4)} SL=${entry.stopLoss.toFixed(4)}`,
  };
}

// ─── Execute a Sniper Trade ────────────────────────────────────

export interface TradeResult {
  success: boolean;
  position?: SniperPosition;
  orderId?: string;
  error?: string;
  entry: SniperEntry;
}

/**
 * Execute a sniper trade: place limit order via CLOB API.
 * Only call this after stormScan returns a FIRE signal.
 */
export async function fireSniper(entry: SniperEntry): Promise<TradeResult> {
  if (!walletPrivateKey) {
    return { success: false, error: "No wallet configured", entry };
  }

  // Final safety checks
  const ddState = evaluateDrawdown(portfolio, config);
  if (ddState.isPaused || ddState.isShutdown) {
    return { success: false, error: `Risk block: ${ddState.reason}`, entry };
  }
  if (portfolio.todayTrades >= config.maxTradesPerDay) {
    return { success: false, error: "Daily trade limit reached", entry };
  }

  console.log(`[🌪️ FIRE] ${entry.side} ${entry.marketTitle} @ ${entry.entryPrice.toFixed(4)} | $${entry.sizeUsd.toFixed(2)}`);

  try {
    // Get authenticated CLOB client
    const client = await getOrCreateClobClient({ privateKey: walletPrivateKey });

    // Calculate shares from USD size
    const shares = entry.sizeUsd / entry.entryPrice;

    // Place limit order
    const result = await placeLimitOrder(
      client,
      entry.tokenId,
      "BUY",
      entry.entryPrice,
      Math.round(shares),
    );

    if (!result.success) {
      return { success: false, error: result.error, entry };
    }

    // Create position
    const position: SniperPosition = {
      id: result.orderId || `ss_${Date.now()}`,
      marketId: entry.marketId,
      marketTitle: entry.marketTitle,
      side: entry.side,
      tokenId: entry.tokenId,
      entryPrice: entry.entryPrice,
      sizeUsd: entry.sizeUsd,
      entryTime: new Date().toISOString(),
      currentPrice: entry.entryPrice,
      pnlUsd: 0,
      pnlPct: 0,
      stopLoss: entry.stopLoss,
      takeProfit: entry.takeProfit,
      maxHoldHours: entry.maxHoldHours,
      conviction: entry.conviction.composite,
      shockScore: entry.shock.composite,
    };

    // Update portfolio
    portfolio.openPositions.push(position);
    portfolio.availableBalance -= entry.sizeUsd;
    portfolio.todayTrades++;
    portfolio.totalTrades++;

    console.log(`[🌪️ FIRE] ✅ Order placed: ${result.orderId} | ${entry.side} ${entry.marketTitle}`);

    return { success: true, position, orderId: result.orderId, entry };
  } catch (err: any) {
    console.error(`[🌪️ FIRE] ❌ Order failed: ${err.message}`);
    return { success: false, error: err.message, entry };
  }
}

// ─── Monitor & Exit ────────────────────────────────────────────

export interface MonitorResult {
  position: SniperPosition;
  exitSignal: ExitSignal;
  closed: boolean;
  pnlUsd: number;
}

/**
 * Monitor all open positions and execute exits when triggered.
 */
export async function monitorPositions(): Promise<MonitorResult[]> {
  resetDailyIfNeeded();
  const results: MonitorResult[] = [];

  for (const pos of [...portfolio.openPositions]) {
    try {
      // Update current price
      try {
        const mid = await getMidpoint(pos.tokenId);
        if (mid > 0.01 && mid < 0.99) {
          pos.currentPrice = mid;
          pos.pnlPct = pos.side === "YES"
            ? (mid - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - mid) / pos.entryPrice;
          pos.pnlUsd = pos.sizeUsd * pos.pnlPct;
        }
      } catch {}

      // Record price
      historicalDb.pushPrice(pos.marketId, pos.currentPrice);

      // Evaluate exit
      const exitSignal = await evaluateExit(pos, config);

      let closed = false;
      if (exitSignal.shouldExit) {
        closed = await closePosition(pos, exitSignal);
      }

      results.push({
        position: { ...pos },
        exitSignal,
        closed,
        pnlUsd: pos.pnlUsd,
      });
    } catch (err) {
      // Position monitoring error — don't crash
      console.error(`[🌪️] Monitor error for ${pos.marketTitle}: ${err}`);
    }
  }

  return results;
}

/**
 * Close a position: place SELL order and update portfolio.
 */
async function closePosition(pos: SniperPosition, signal: ExitSignal): Promise<boolean> {
  console.log(`[🌪️ EXIT] ${signal.type.toUpperCase()} | ${pos.marketTitle} | ${signal.reason}`);

  if (walletPrivateKey) {
    try {
      const client = await getOrCreateClobClient({ privateKey: walletPrivateKey });
      const shares = pos.sizeUsd / pos.entryPrice;
      await placeLimitOrder(
        client,
        pos.tokenId,
        "SELL",
        pos.currentPrice,
        Math.round(shares),
      );
    } catch (err: any) {
      console.error(`[🌪️ EXIT] Sell order failed: ${err.message}`);
      // Still mark as closed internally
    }
  }

  // Update portfolio
  portfolio.openPositions = portfolio.openPositions.filter((p) => p.id !== pos.id);
  portfolio.availableBalance += pos.sizeUsd + pos.pnlUsd;

  const pnl = pos.pnlUsd;
  portfolio.todayPnlUsd += pnl;
  portfolio.weekPnlUsd += pnl;
  if (portfolio.bankroll > 0) {
    portfolio.todayPnlPct = portfolio.todayPnlUsd / portfolio.bankroll;
    portfolio.weekPnlPct = portfolio.weekPnlUsd / portfolio.bankroll;
  }

  if (pnl >= 0) {
    portfolio.totalWins++;
    portfolio.drawdown.consecutiveLosses = 0;
    portfolio.drawdown.sizeMultiplier = 1.0;
  } else {
    portfolio.totalLosses++;
    portfolio.drawdown.consecutiveLosses++;
    portfolio.drawdown.dailyLossUsd += Math.abs(pnl);
    portfolio.drawdown.weeklyLossUsd += Math.abs(pnl);
    if (portfolio.bankroll > 0) {
      portfolio.drawdown.dailyLossPct = portfolio.drawdown.dailyLossUsd / portfolio.bankroll;
      portfolio.drawdown.weeklyLossPct = portfolio.drawdown.weeklyLossUsd / portfolio.bankroll;
    }
    // Apply consecutive loss multiplier
    if (portfolio.drawdown.consecutiveLosses === 1) {
      portfolio.drawdown.sizeMultiplier = config.lossReductionFactor; // 0.7
    }
  }

  // Win rate
  const total = portfolio.totalWins + portfolio.totalLosses;
  portfolio.winRate = total > 0 ? portfolio.totalWins / total : 0;

  // Recalculate bankroll
  portfolio.bankroll = portfolio.availableBalance
    + portfolio.openPositions.reduce((sum, p) => sum + p.sizeUsd + p.pnlUsd, 0);

  console.log(`[🌪️ EXIT] PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${signal.type} | bankroll: $${portfolio.bankroll.toFixed(2)}`);

  return true;
}

// ─── Status ────────────────────────────────────────────────────

/**
 * Get full portfolio status.
 */
export function getSniperStatus(): SniperPortfolio {
  return { ...portfolio };
}

/**
 * Get formatted status string.
 */
export function formatSniperStatus(): string {
  const p = portfolio;
  const dd = p.drawdown;

  let status = "🌪️ STORM SNIPER ELITE STATUS\n";
  status += "═══════════════════════════════════\n";
  status += `💰 Bankroll:     $${p.bankroll.toFixed(2)}\n`;
  status += `💵 Available:    $${p.availableBalance.toFixed(2)}\n`;
  status += `📊 Positions:    ${p.openPositions.length} open\n`;
  status += `📈 Today PnL:    ${p.todayPnlUsd >= 0 ? "+" : ""}$${p.todayPnlUsd.toFixed(2)} (${(p.todayPnlPct * 100).toFixed(1)}%)\n`;
  status += `📈 Week PnL:     ${p.weekPnlUsd >= 0 ? "+" : ""}$${p.weekPnlUsd.toFixed(2)} (${(p.weekPnlPct * 100).toFixed(1)}%)\n`;
  status += `🎯 Win Rate:     ${(p.winRate * 100).toFixed(0)}% (${p.totalWins}W/${p.totalLosses}L)\n`;
  status += `📊 Trades Today: ${p.todayTrades}/${config.maxTradesPerDay}\n`;

  if (dd.isPaused) {
    status += `⏸️ PAUSED until ${dd.pauseUntil || "?"}: ${dd.reason}\n`;
  }
  if (dd.isShutdown) {
    status += `🛑 SHUTDOWN: ${dd.reason}\n`;
  }
  if (dd.consecutiveLosses > 0) {
    status += `⚠️ Consec Losses: ${dd.consecutiveLosses} | Size mult: ${dd.sizeMultiplier}\n`;
  }

  if (p.openPositions.length > 0) {
    status += "\n── Open Positions ──\n";
    for (const pos of p.openPositions) {
      const hold = ((Date.now() - new Date(pos.entryTime).getTime()) / 3600000).toFixed(1);
      status += `  ${pos.side} ${pos.marketTitle.slice(0, 40)}...\n`;
      status += `    Entry: ${pos.entryPrice.toFixed(4)} → Now: ${pos.currentPrice.toFixed(4)} | PnL: ${pos.pnlPct >= 0 ? "+" : ""}${(pos.pnlPct * 100).toFixed(1)}% | ${hold}h\n`;
      status += `    SL: ${pos.stopLoss.toFixed(4)} | TP: ${pos.takeProfit.toFixed(4)}\n`;
    }
  }

  return status;
}

// ─── Helpers ───────────────────────────────────────────────────

function extractLocationFromQuestion(question: string): string {
  const q = question.toLowerCase();
  const locations = [
    "new york", "los angeles", "chicago", "houston", "phoenix",
    "london", "tokyo", "sydney", "paris", "berlin",
    "miami", "denver", "seattle", "san francisco", "dallas",
    "toronto", "melbourne", "mumbai", "singapore", "hong kong",
  ];
  for (const loc of locations) {
    if (q.includes(loc)) return loc;
  }
  // Try to extract "in <City>" pattern
  const match = q.match(/\bin\s+([a-z\s]+?)(?:\s+on|\s+by|\s+before|\s+after|\?|$)/i);
  if (match) return match[1].trim();
  return "new york"; // default
}

function estimateWeatherProbability(question: string, ensemble: any): number {
  const q = question.toLowerCase();

  // Rain-related
  if (q.includes("rain") || q.includes("precipitation") || q.includes("wet")) {
    return ensemble?.meanRain ?? 0.5;
  }
  // Temperature-related
  if (q.includes("temperature") || q.includes("hot") || q.includes("cold") || q.includes("heat")) {
    // Heuristic: above 30°C → higher prob for "hot" questions
    const temp = ensemble?.meanTemp ?? 20;
    if (q.includes("above") || q.includes("over") || q.includes("hot") || q.includes("heat")) {
      return Math.min(0.95, Math.max(0.05, (temp - 20) / 20));
    }
    return 0.5;
  }
  // Snow
  if (q.includes("snow") || q.includes("blizzard") || q.includes("ice")) {
    const temp = ensemble?.meanTemp ?? 20;
    return temp < 2 ? Math.min(0.8, (ensemble?.meanRain ?? 0) * 1.5) : 0.1;
  }
  // Storm/wind
  if (q.includes("storm") || q.includes("wind") || q.includes("hurricane") || q.includes("tornado")) {
    const pressure = ensemble?.meanPressure ?? 1013;
    return Math.min(0.9, Math.max(0.05, (1013 - pressure) / 30));
  }

  // Generic: use rain as proxy
  return ensemble?.meanRain ?? 0.5;
}
