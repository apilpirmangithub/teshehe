/**
 * Storm Sniper Elite — Type Definitions
 *
 * Ultra selective, adaptive, capital preserving trading system.
 * 90–97% of the time → NO TRADE. Only fires when statistical edge is extreme.
 */

// ─── Weather Data ──────────────────────────────────────────────

export interface WeatherSnapshot {
  location: string;
  timestamp: string;
  temperature: number;        // °C
  pressure: number;           // hPa
  humidity: number;           // 0–100
  windSpeed: number;          // m/s
  precipMm: number;           // mm
  chanceRain: number;         // 0–1
  cloudCover: number;         // 0–100
  source: string;
}

export interface EnsembleForecast {
  location: string;
  timestamp: string;
  sources: WeatherSnapshot[];
  meanTemp: number;
  stdTemp: number;
  meanRain: number;
  stdRain: number;
  meanPressure: number;
  stdPressure: number;
  divergenceScore: number;    // how much sources disagree (0–1)
}

export interface PressureAnomaly {
  current: number;
  historical24hMean: number;
  historical7dMean: number;
  zScore: number;
  changeRate: number;         // hPa/hr
  isAnomaly: boolean;
}

// ─── Alpha Signals ─────────────────────────────────────────────

export interface ShockScore {
  zScore: number;                  // weather z-score
  forecastAcceleration: number;    // rate of change in forecast
  ensembleDivergence: number;      // disagreement between sources
  pressureAnomaly: number;         // pressure z-score
  composite: number;               // weighted final: 0–1+
  triggered: boolean;              // composite >= 0.8
}

export interface MarketLag {
  weatherProbNow: number;
  marketProbNow: number;
  marketProb30mAgo: number;
  weatherDelta: number;            // weather change
  marketDelta: number;             // market change in same period
  lagScore: number;                // 0–1, higher = market lagging more
  lagDetected: boolean;
}

export interface ConvictionScore {
  edge: number;                    // |forecast - market| 
  shockScore: number;              // from ShockScore.composite
  liquidityQuality: number;        // 0–1
  composite: number;               // 0.5*edge + 0.3*shock + 0.2*liq
  triggered: boolean;              // composite >= 0.78
  recommendation: "FIRE" | "WATCH" | "SKIP";
}

// ─── Risk Management ───────────────────────────────────────────

export interface PositionSize {
  baseSize: number;                // bankroll * 0.12
  adjustedSize: number;            // base * (1 + conviction * 0.5)
  finalSize: number;               // after vol scaling & MC guard
  cappedAt20Pct: boolean;
  volScaled: boolean;
  mcReduced: boolean;
  reductionReason?: string;
}

export interface MonteCarloResult {
  simulations: number;
  estimatedMaxDrawdown: number;    // % 
  estimatedAvgReturn: number;
  percentWin: number;
  shouldReduceSize: boolean;       // maxDD > 25%
  reductionFactor: number;         // 0.6 if should reduce
}

export interface DrawdownState {
  consecutiveLosses: number;
  dailyLossUsd: number;
  dailyLossPct: number;
  weeklyLossUsd: number;
  weeklyLossPct: number;
  isPaused: boolean;
  pauseUntil?: string;             // ISO timestamp
  isShutdown: boolean;
  sizeMultiplier: number;          // 1.0 normal, 0.7 after 1 loss
  reason?: string;
}

export interface VolatilityState {
  currentVol: number;              // recent price volatility
  historicalVol: number;           // longer-term
  volRatio: number;                // current/historical
  scaler: number;                  // 0.5–1.0 (lower if vol is high)
}

// ─── Execution ─────────────────────────────────────────────────

export interface SniperEntry {
  marketId: string;
  marketTitle: string;
  side: "YES" | "NO";
  tokenId: string;
  entryPrice: number;
  sizeUsd: number;
  conviction: ConvictionScore;
  shock: ShockScore;
  stopLoss: number;
  takeProfit: number;
  maxHoldHours: number;
  timestamp: string;
}

export interface ExitSignal {
  type: "take_profit" | "stop_loss" | "momentum_reversal" | "forecast_collapse" | "time_decay";
  currentPrice: number;
  entryPrice: number;
  pnlPct: number;
  shouldExit: boolean;
  reason: string;
}

export interface LiquidityReport {
  tokenId: string;
  bidDepthUsd: number;
  askDepthUsd: number;
  spread: number;                  // bid-ask spread
  qualityScore: number;            // 0–1
  sufficient: boolean;             // enough liquidity for our size
}

// ─── Portfolio & State ─────────────────────────────────────────

export interface SniperPortfolio {
  bankroll: number;                // total capital
  availableBalance: number;        // free cash
  openPositions: SniperPosition[];
  todayTrades: number;
  todayPnlUsd: number;
  todayPnlPct: number;
  weekPnlUsd: number;
  weekPnlPct: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  avgRR: number;                   // risk:reward ratio
  lastTradeTime?: string;
  drawdown: DrawdownState;
}

export interface SniperPosition {
  id: string;
  marketId: string;
  marketTitle: string;
  side: "YES" | "NO";
  tokenId: string;
  entryPrice: number;
  sizeUsd: number;
  entryTime: string;
  currentPrice: number;
  pnlUsd: number;
  pnlPct: number;
  stopLoss: number;
  takeProfit: number;
  maxHoldHours: number;
  conviction: number;
  shockScore: number;
}

// ─── Config ────────────────────────────────────────────────────

export interface StormSniperConfig {
  // Alpha thresholds
  shockThreshold: number;          // default 0.8
  convictionThreshold: number;     // default 0.78
  minEdge: number;                 // default 0.08 (8%)

  // Shock weights
  shockWeightZ: number;            // 0.4
  shockWeightAccel: number;        // 0.3
  shockWeightDivergence: number;   // 0.2
  shockWeightPressure: number;     // 0.1

  // Conviction weights
  convictionWeightEdge: number;    // 0.5
  convictionWeightShock: number;   // 0.3
  convictionWeightLiq: number;     // 0.2

  // Risk
  baseSizePct: number;             // 0.12 (12%)
  maxSizePct: number;              // 0.20 (20%)
  stopLossPct: number;             // 0.03 (3%)
  takeProfitMinPct: number;        // 0.06 (6%)
  takeProfitMaxPct: number;        // 0.09 (9%)
  maxHoldHours: number;            // 4

  // Discipline
  maxTradesPerDay: number;         // 3
  dailyStopLossPct: number;        // 0.06 (6%)
  weeklyStopLossPct: number;       // 0.12 (12%)
  lossReductionFactor: number;     // 0.7 (30% size reduction after 1 loss)
  pauseAfterConsecLosses: number;  // 2 → pause 24h
  pauseHours: number;              // 24

  // Monte Carlo
  mcSimulations: number;           // 1000
  mcMaxDrawdownPct: number;        // 0.25 (25%)
  mcReductionFactor: number;       // 0.6 (40% size cut)
}

export const DEFAULT_SNIPER_CONFIG: StormSniperConfig = {
  shockThreshold: 0.8,
  convictionThreshold: 0.78,
  minEdge: 0.08,

  shockWeightZ: 0.4,
  shockWeightAccel: 0.3,
  shockWeightDivergence: 0.2,
  shockWeightPressure: 0.1,

  convictionWeightEdge: 0.5,
  convictionWeightShock: 0.3,
  convictionWeightLiq: 0.2,

  baseSizePct: 0.12,
  maxSizePct: 0.20,
  stopLossPct: 0.03,
  takeProfitMinPct: 0.06,
  takeProfitMaxPct: 0.09,
  maxHoldHours: 4,

  maxTradesPerDay: 3,
  dailyStopLossPct: 0.06,
  weeklyStopLossPct: 0.12,
  lossReductionFactor: 0.7,
  pauseAfterConsecLosses: 2,
  pauseHours: 24,

  mcSimulations: 1000,
  mcMaxDrawdownPct: 0.25,
  mcReductionFactor: 0.6,
};
