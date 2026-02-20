/**
 * Storm Sniper Elite — Alpha Engine
 *
 * Multi-layer shock detection, market lag detection, conviction scoring.
 * This is what makes the system "elite" — fires ONLY on extreme distortions.
 *
 * Shock Score = 0.4*Z + 0.3*Acceleration + 0.2*Divergence + 0.1*Pressure
 * Conviction  = 0.5*Edge + 0.3*Shock + 0.2*Liquidity
 */

import type {
  StormSniperConfig,
  ShockScore,
  MarketLag,
  ConvictionScore,
  EnsembleForecast,
  PressureAnomaly,
  LiquidityReport,
} from "./types.js";
import { historicalDb, mean, std } from "./data.js";

// ─── Shock Index ───────────────────────────────────────────────

/**
 * Compute the multi-layer shock score.
 * Combines weather z-score, forecast acceleration, ensemble divergence,
 * and pressure anomaly into a single composite signal.
 */
export function computeShockScore(
  ensemble: EnsembleForecast,
  pressure: PressureAnomaly,
  location: string,
  cfg: StormSniperConfig,
): ShockScore {
  // 1. Weather Z-Score: how abnormal is current weather vs recent history
  const history = historicalDb.getWeatherHistory(location, 48);
  const histRains = history.map((h) => h.chanceRain);
  const histTemps = history.map((h) => h.temperature);

  let zScore = 0;
  if (histRains.length >= 3) {
    const rainMean = mean(histRains);
    const rainStd = std(histRains) || 0.1;
    const rainZ = Math.abs(ensemble.meanRain - rainMean) / rainStd;

    const tempMean = mean(histTemps);
    const tempStd = std(histTemps) || 1;
    const tempZ = Math.abs(ensemble.meanTemp - tempMean) / tempStd;

    zScore = Math.min(1, (rainZ * 0.6 + tempZ * 0.4) / 3); // normalize to 0–1
  }

  // 2. Forecast Acceleration: is the forecast changing rapidly?
  const forecastAcceleration = computeForecastAcceleration(location);

  // 3. Ensemble Divergence: how much do sources disagree?
  const ensembleDivergence = ensemble.divergenceScore;

  // 4. Pressure Anomaly: normalized 0–1
  const pressureScore = Math.min(1, Math.abs(pressure.zScore) / 3);

  // Weighted composite
  const composite =
    cfg.shockWeightZ * zScore +
    cfg.shockWeightAccel * forecastAcceleration +
    cfg.shockWeightDivergence * ensembleDivergence +
    cfg.shockWeightPressure * pressureScore;

  return {
    zScore,
    forecastAcceleration,
    ensembleDivergence,
    pressureAnomaly: pressureScore,
    composite,
    triggered: composite >= cfg.shockThreshold,
  };
}

// ─── Forecast Acceleration Model ───────────────────────────────

/**
 * How fast is the weather forecast changing?
 * Looks at recent forecast history and computes rate of change.
 * Returns 0–1 (1 = very rapid change).
 */
function computeForecastAcceleration(location: string): number {
  const history = historicalDb.getWeatherHistory(location, 12); // last hour
  if (history.length < 3) return 0;

  // Compute first derivative (rate of change) of rain probability
  const diffs: number[] = [];
  for (let i = 1; i < history.length; i++) {
    diffs.push(Math.abs(history[i].chanceRain - history[i - 1].chanceRain));
  }

  // Compute second derivative (acceleration)
  const accelDiffs: number[] = [];
  for (let i = 1; i < diffs.length; i++) {
    accelDiffs.push(Math.abs(diffs[i] - diffs[i - 1]));
  }

  const avgAccel = accelDiffs.length > 0 ? mean(accelDiffs) : mean(diffs);
  // Normalize: 0.1 change per interval is very high
  return Math.min(1, avgAccel / 0.1);
}

// ─── Market Lag Detector ───────────────────────────────────────

/**
 * Detect when the market is lagging behind weather changes.
 * If weather probability changed significantly but market price hasn't moved
 * proportionally → the market is slow → opportunity.
 */
export function detectMarketLag(
  marketId: string,
  weatherProbNow: number,
  marketProbNow: number,
): MarketLag {
  // Get market price from 30 min ago
  const marketProb30mAgo = historicalDb.getPriceNMinutesAgo(marketId, 30);

  // Store current price for future lookups
  historicalDb.pushPrice(marketId, marketProbNow);

  if (marketProb30mAgo === null) {
    return {
      weatherProbNow,
      marketProbNow,
      marketProb30mAgo: marketProbNow,
      weatherDelta: 0,
      marketDelta: 0,
      lagScore: 0,
      lagDetected: false,
    };
  }

  // Weather delta: how much did weather prob change?
  // We approximate by comparing current ensemble rain prob vs what market implies
  const weatherDelta = Math.abs(weatherProbNow - marketProbNow);

  // Market delta: how much did the market move in 30 min?
  const marketDelta = Math.abs(marketProbNow - marketProb30mAgo);

  // Lag: weather says big change, but market barely moved
  let lagScore = 0;
  if (weatherDelta > 0.05) {
    // If weather says 20% change but market only moved 5%, lag is high
    const expectedMove = weatherDelta * 0.6; // market should capture ~60% of weather signal
    const actualMove = marketDelta;
    if (expectedMove > 0) {
      lagScore = Math.min(1, Math.max(0, 1 - actualMove / expectedMove));
    }
  }

  return {
    weatherProbNow,
    marketProbNow,
    marketProb30mAgo,
    weatherDelta,
    marketDelta,
    lagScore,
    lagDetected: lagScore > 0.4,
  };
}

// ─── Ensemble Divergence Scorer ────────────────────────────────

/**
 * Score how much ensemble sources disagree.
 * High divergence + one source changing fast = information asymmetry.
 */
export function scoreEnsembleDivergence(ensemble: EnsembleForecast): number {
  if (ensemble.sources.length < 2) return 0;

  // Max difference between any two sources' rain probability
  const rains = ensemble.sources.map((s) => s.chanceRain);
  const maxDiff = Math.max(...rains) - Math.min(...rains);

  // Weighted by how extreme the readings are (bigger signal near 0 or 1)
  const extremity = Math.max(
    Math.abs(ensemble.meanRain - 0.5) * 2, // how far from 50/50
    0.1,
  );

  return Math.min(1, (maxDiff * extremity) / 0.15);
}

// ─── Conviction Engine ─────────────────────────────────────────

/**
 * The final gate. Combines edge, shock score, and liquidity quality.
 * Entry ONLY if conviction >= 0.78.
 *
 * Conviction = 0.5*Edge + 0.3*ShockScore + 0.2*LiquidityQuality
 */
export function computeConviction(
  edge: number,
  shock: ShockScore,
  liquidity: LiquidityReport,
  cfg: StormSniperConfig,
): ConvictionScore {
  // Normalize edge to 0–1 (edge of 0.3 = 1.0)
  const normalizedEdge = Math.min(1, edge / 0.3);

  const composite =
    cfg.convictionWeightEdge * normalizedEdge +
    cfg.convictionWeightShock * shock.composite +
    cfg.convictionWeightLiq * liquidity.qualityScore;

  let recommendation: "FIRE" | "WATCH" | "SKIP";
  if (composite >= cfg.convictionThreshold && edge >= cfg.minEdge && shock.triggered) {
    recommendation = "FIRE";
  } else if (composite >= cfg.convictionThreshold * 0.8 && edge >= cfg.minEdge * 0.7) {
    recommendation = "WATCH";
  } else {
    recommendation = "SKIP";
  }

  return {
    edge,
    shockScore: shock.composite,
    liquidityQuality: liquidity.qualityScore,
    composite,
    triggered: recommendation === "FIRE",
    recommendation,
  };
}
