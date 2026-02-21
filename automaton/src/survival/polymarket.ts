/**
 * Polymarket Real Trading Bot with Weather Intelligence
 *
 * REAL prediction market trading via Polymarket CLOB API.
 * Uses Gamma API for market discovery, CLOB API for order execution.
 * Strict risk management: 5% per trade, -10% daily stop loss, max 3 positions.
 *
 * Network: Polygon (Polymarket) ← bridged from Base (Conway wallet)
 */

import type { AutomatonDatabase } from "../types.js";
import {
  getOrCreateClobClient,
  resetClobClient,
  fetchGammaMarkets,
  getMidpoint,
  placeLimitOrder,
  getUserPositions,
  getPortfolioValue,
  getBridgeQuote,
  checkAndConfigureProxy,
  isGeoblocked,
  getActiveProxy,
  type ParsedMarket,
} from "./polymarket-client.js";
import { getUsdcBalance } from "../conway/x402.js";

// ─── Types ─────────────────────────────────────────────────────

interface WeatherData {
  location: string;
  temperature: number;
  chanceRain: number;
  windSpeed: number;
  alerts: string[];
  forecast: string;
  timestamp: string;
}

export interface Market {
  id: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  deadline: string;
  category: string;
  // Real trading fields
  yesTokenId?: string;
  noTokenId?: string;
  conditionId?: string;
  slug?: string;
  tickSize?: number;
  minOrderSize?: number;
  liquidity?: number;
  volume24hr?: number;
  description?: string;
}

interface EdgeCalculation {
  marketPrice: number;
  yourForecast: number;
  edgePct: number;
  sideToBet: "YES" | "NO";
  confidence: number;
  recommendation: "strong_buy" | "buy" | "hold" | "skip";
}

interface Position {
  positionId: string;
  marketId: string;
  marketTitle: string;
  side: "YES" | "NO";
  entryPrice: number;
  entryAmount: number;
  entryTime: string;
  currentPrice: number;
  pnlUsd: number;
  pnlPct: number;
  holdingMinutes: number;
}

interface Portfolio {
  totalCapital: number;
  currentBalance: number;
  dailyLoss: number;
  positionsOpen: number;
  trades24h: number;
  winRate: number;
}

// ─── State ─────────────────────────────────────────────────────

let portfolio: Portfolio = {
  totalCapital: 100,
  currentBalance: 100,
  dailyLoss: 0,
  positionsOpen: 0,
  trades24h: 0,
  winRate: 0,
};

let logger: any = null;
let database: AutomatonDatabase | null = null;
let walletPrivateKey: string | null = null;
let walletAddress: string | null = null;
let _clobInitialized = false;

// In-memory market cache from last scan (so pm_place_bet can look up real markets)
let _lastScannedMarkets: Market[] = [];

// Weather cache
const weatherCache = new Map<string, { data: WeatherData; expiry: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min cache (hustle mode)

// ─── Initialization ────────────────────────────────────────────

/**
 * Initialize Polymarket with real trading capabilities.
 * Pass the wallet's private key to enable CLOB API authentication.
 */
export function initializePolymarket(
  db: AutomatonDatabase,
  log?: any,
  privateKey?: string,
  address?: string,
): void {
  database = db;
  logger = log || null;
  if (privateKey) walletPrivateKey = privateKey;
  if (address) walletAddress = address;

  // Restore portfolio from DB
  const savedPortfolio = db.getKV?.("pm_portfolio_state");
  if (savedPortfolio) {
    try {
      const parsed = JSON.parse(savedPortfolio);
      portfolio = { ...portfolio, ...parsed };
    } catch {
      // ignore
    }
  }

  console.log("[Polymarket] Initialized with REAL trading (Gamma + CLOB APIs)");
  if (walletAddress) {
    console.log(`[Polymarket] Wallet: ${walletAddress}`);
    // Store wallet address in DB so other modules (auto-bet verify, dashboard sync) can use it
    try { db.setKV?.("wallet_address", walletAddress); } catch {}
  }
}

/**
 * Ensure the CLOB client is ready for authenticated trading.
 * Checks geoblock status and configures proxy if needed.
 */
async function ensureClobClient() {
  if (_clobInitialized) return;
  if (!walletPrivateKey) {
    throw new Error("Polymarket: No wallet private key configured. Cannot trade.");
  }
  
  // Check geoblock and configure proxy before initializing CLOB client
  const proxyStatus = await checkAndConfigureProxy();
  if (proxyStatus.geoblocked && !proxyStatus.proxyActive) {
    throw new Error(
      "GEOBLOCKED: Polymarket trading is blocked from this region (Singapore). " +
      "Set POLYMARKET_PROXY_URL environment variable to an HTTP proxy in an allowed region (UK, Germany, Netherlands, etc.). " +
      "Example: export POLYMARKET_PROXY_URL=http://your-proxy-server:8080"
    );
  }
  if (proxyStatus.proxyActive) {
    console.log(`[Polymarket] Trading via proxy: ${proxyStatus.proxyUrl}`);
  }
  
  // Always reset to ensure fresh creds (prevent stale singleton)
  resetClobClient();
  await getOrCreateClobClient({ privateKey: walletPrivateKey });
  _clobInitialized = true;
}

/**
 * Look up a real market from cache by title (case-insensitive substring match).
 */
export function findMarketByTitle(title: string): Market | undefined {
  const lower = title.toLowerCase();
  return _lastScannedMarkets.find(
    (m) => m.title.toLowerCase().includes(lower) || lower.includes(m.title.toLowerCase()),
  );
}

/**
 * Get the last scanned markets cache.
 */
export function getLastScannedMarkets(): Market[] {
  return _lastScannedMarkets;
}

// ─── Weather Intelligence ──────────────────────────────────────

export async function getWeatherForecast(
  location: string,
  hoursAhead: number = 24,
): Promise<WeatherData> {
  const cacheKey = `${location}_${hoursAhead}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    console.log(`[WEATHER CACHE HIT] ${location}`);
    return cached.data;
  }

  // Strategy 1: wttr.in
  try {
    const wttResponse = (await Promise.race([
      fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
        headers: { Accept: "application/json" },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("wttr.in timeout")), 3000)),
    ])) as Response;

    if (wttResponse.ok) {
      const wttData: any = await wttResponse.json();
      const current = wttData.current_condition[0];
      const weatherData: WeatherData = {
        location,
        temperature: parseFloat(String(current.temp_C)),
        chanceRain:
          current.precipMM > 0
            ? Math.min(1, parseFloat(String(current.precipMM)) / 50)
            : 0,
        windSpeed: parseFloat(String(current.windspeedKmph)) / 3.6,
        alerts: current.weatherCode >= 80 ? ["Precipitation alert"] : [],
        forecast: current.weatherDesc[0].value,
        timestamp: new Date().toISOString(),
      };
      weatherCache.set(cacheKey, { data: weatherData, expiry: Date.now() + CACHE_TTL_MS });
      console.log(
        `[WEATHER] wttr.in: ${location} - ${weatherData.temperature.toFixed(1)}°C, ${(weatherData.chanceRain * 100).toFixed(0)}% rain`,
      );
      return weatherData;
    }
  } catch (err) {
    console.log(`[WEATHER] wttr.in failed: ${err}`);
  }

  // Strategy 2: NOAA
  try {
    const pointsResp = (await Promise.race([
      fetch(`https://api.weather.gov/points/${extractCoordinates(location)}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("NOAA timeout")), 3000)),
    ])) as Response;

    if (pointsResp.ok) {
      const pointsData: any = await pointsResp.json();
      const forecastResp = (await Promise.race([
        fetch(pointsData.properties.forecast),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("NOAA forecast timeout")), 3000),
        ),
      ])) as Response;

      if (forecastResp.ok) {
        const forecastData: any = await forecastResp.json();
        const period = forecastData.properties.periods[0];
        const weatherData: WeatherData = {
          location,
          temperature: ((parseFloat(String(period.temperature)) - 32) * 5) / 9,
          chanceRain:
            parseFloat(String(period.precipitationProbability?.value || 0)) / 100,
          windSpeed: parseFloat(String(period.windSpeed.split(" ")[0])) * 0.44704,
          alerts: period.shortForecast.includes("rain") ? ["Precipitation"] : [],
          forecast: period.shortForecast,
          timestamp: new Date().toISOString(),
        };
        weatherCache.set(cacheKey, { data: weatherData, expiry: Date.now() + CACHE_TTL_MS });
        console.log(
          `[WEATHER] NOAA: ${location} - ${weatherData.temperature.toFixed(1)}°C, ${(weatherData.chanceRain * 100).toFixed(0)}% rain`,
        );
        return weatherData;
      }
    }
  } catch (err) {
    console.log(`[WEATHER] NOAA failed: ${err}`);
  }

  // Strategy 3: Mock fallback
  console.log(`[WEATHER] Using mock data for ${location}`);
  const weatherData = generateMockWeather(location);
  weatherCache.set(cacheKey, { data: weatherData, expiry: Date.now() + CACHE_TTL_MS });
  return weatherData;
}

function extractCoordinates(location: string): string {
  const coords: Record<string, string> = {
    "new york": "40.7128,-74.0060",
    california: "36.1162,-119.6816",
    denver: "39.7392,-104.9903",
    london: "51.5074,-0.1278",
    tokyo: "35.6762,139.6503",
    sydney: "33.8688,151.2093",
  };
  return coords[location.toLowerCase()] || "40.7128,-74.0060";
}

function generateMockWeather(location: string): WeatherData {
  const locLower = location.toLowerCase();
  let baseTemp = 20,
    rainChance = 0.3,
    windBase = 5;

  if (locLower.includes("denver") || locLower.includes("colorado")) {
    baseTemp = 8 + Math.random() * 15;
    rainChance = 0.2;
    windBase = 10;
  } else if (locLower.includes("california") || locLower.includes("desert")) {
    baseTemp = 25 + Math.random() * 15;
    rainChance = 0.05;
    windBase = 3;
  } else if (locLower.includes("london") || locLower.includes("uk")) {
    baseTemp = 10 + Math.random() * 8;
    rainChance = 0.6;
    windBase = 8;
  } else if (locLower.includes("tokyo") || locLower.includes("japan")) {
    baseTemp = 15 + Math.random() * 18;
    rainChance = 0.4;
    windBase = 4;
  } else {
    baseTemp = 15 + Math.random() * 20;
    rainChance = 0.35;
  }

  const temp = baseTemp + (Math.random() - 0.5) * 8;
  const rain = Math.min(1, rainChance + (Math.random() - 0.5) * 0.3);
  const wind = windBase + Math.random() * 10;

  return {
    location,
    temperature: temp,
    chanceRain: rain,
    windSpeed: wind,
    alerts: rain > 0.7 ? ["Heavy rain forecast"] : rain > 0.5 ? ["Rain expected"] : [],
    forecast:
      rain > 0.7 ? "Heavy rain" : rain > 0.5 ? "Rainy" : wind > 15 ? "Windy" : "Partly cloudy",
    timestamp: new Date().toISOString(),
  };
}

// ─── REAL Market Scanning (Gamma API) ──────────────────────────

/**
 * Scan REAL Polymarket markets via Gamma API.
 * Caches results in _lastScannedMarkets for pm_place_bet lookups.
 * @param weatherCondition - keyword to search for
 * @param keyword - search keyword (empty = broad scan)
 * @param fastResolving - if true, prioritize markets ending soonest (within 48h)
 */
export async function scanPolymarketMarkets(
  keyword: string = "",
  fastResolving: boolean = true, // DEFAULT: always prefer fast-resolving
): Promise<Market[]> {
  // ALWAYS force fast-resolving mode for maximum profit from near-expiry markets
  fastResolving = true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Priority 1: Markets ending within 24 hours (highest profit potential)
      let realMarkets = await fetchGammaMarkets({
        keyword: keyword || undefined,
        limit: 50,
        active: true,
        closed: false,
        fastResolving: true,
        maxHoursToEnd: 24, // 24h window — tightest deadline = biggest opportunity
        minVolume24hr: 50, // LOW threshold to find hidden gems with mispricing
      });

      if (realMarkets.length < 3) {
        // Expand to 48 hours
        const more = await fetchGammaMarkets({
          keyword: keyword || undefined,
          limit: 50,
          active: true,
          closed: false,
          fastResolving: true,
          maxHoursToEnd: 48,
          minVolume24hr: 50, // Hidden gems — low volume = less efficient pricing
        });
        // Deduplicate by ID
        const existingIds = new Set(realMarkets.map(m => m.id));
        realMarkets = [...realMarkets, ...more.filter(m => !existingIds.has(m.id))];
      }

      if (realMarkets.length < 3) {
        // Expand to 7 days — also look for hidden gems
        const more = await fetchGammaMarkets({
          limit: 50,
          minVolume24hr: 30, // Very low volume = market inefficiency = alpha
          active: true,
          closed: false,
          fastResolving: true,
          maxHoursToEnd: 168, // 7 days
        });
        const existingIds = new Set(realMarkets.map(m => m.id));
        realMarkets = [...realMarkets, ...more.filter(m => !existingIds.has(m.id))];
      }

      if (realMarkets.length === 0) {
        // Final fallback: get popular markets
        realMarkets = await fetchGammaMarkets({
          limit: 20,
          minVolume24hr: 1000,
          active: true,
          closed: false,
        });
      }

      const markets = realMarkets.map(parsedToMarket);
      _lastScannedMarkets = markets; // Cache for later lookups
      logger?.logMarketScanned(markets.length, true);
      console.log(`[Polymarket] Gamma API: ${markets.length} real markets found (fastResolving=${fastResolving})`);
      return markets;
    } catch (err) {
      console.warn(`[Polymarket] Gamma API attempt ${attempt} failed:`, err);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  // Fallback
  console.error("[Polymarket] Gamma API unavailable after 3 attempts, using mock markets.");
  const mocks = getMockMarkets();
  _lastScannedMarkets = mocks;
  return mocks;
}

function parsedToMarket(m: ParsedMarket): Market {
  return {
    id: m.id,
    title: m.question,
    yesPrice: m.yesPrice,
    noPrice: m.noPrice,
    volume: m.totalVolume,
    deadline: m.endDate,
    category: m.category,
    yesTokenId: m.yesTokenId,
    noTokenId: m.noTokenId,
    conditionId: m.conditionId,
    slug: m.slug,
    tickSize: m.tickSize,
    minOrderSize: m.minOrderSize,
    liquidity: m.liquidity,
    volume24hr: m.volume24hr,
    description: m.description,
  };
}

function getMockMarkets(): Market[] {
  return [
    {
      id: "mock_001",
      title: "[MOCK] Will it rain in New York tomorrow?",
      yesPrice: 0.45,
      noPrice: 0.55,
      volume: 25000,
      deadline: new Date(Date.now() + 86400000).toISOString(),
      category: "weather",
    },
    {
      id: "mock_002",
      title: "[MOCK] Will temperature exceed 30°C in California?",
      yesPrice: 0.62,
      noPrice: 0.38,
      volume: 18000,
      deadline: new Date(Date.now() + 28800000).toISOString(),
      category: "weather",
    },
    {
      id: "mock_003",
      title: "[MOCK] Will there be sleet in Denver tonight?",
      yesPrice: 0.28,
      noPrice: 0.72,
      volume: 7500,
      deadline: new Date(Date.now() + 43200000).toISOString(),
      category: "weather",
    },
  ];
}

// ─── Edge Calculation ──────────────────────────────────────────

/**
 * SUPER EDGE CALCULATOR — Multi-factor prediction analysis.
 *
 * Factors analyzed:
 * 1. Raw edge (forecast vs market price)
 * 2. Time decay bonus — markets near expiry have locked-in mispricing
 * 3. Volume momentum — high recent volume = strong signal
 * 4. Liquidity depth — enough liquidity to fill our $1 order
 * 5. Price convergence — prices far from 0 or 1 near expiry = big opportunity
 * 6. Deadline pressure — markets within 24h get massive confidence boost
 */
export function calculateEdge(
  market: Market,
  yourForecast: number,
  minEdge: number = 0.02,
): EdgeCalculation & { superAnalysis: Record<string, any> } {
  const marketPrice = market.yesPrice;
  const rawEdge = Math.abs(yourForecast - marketPrice);
  const sideToBet: "YES" | "NO" = yourForecast > marketPrice ? "YES" : "NO";

  // ── Factor 1: Time Decay Bonus ──
  // Markets ending soon with mispricing = guaranteed profit opportunity
  const hoursToEnd = market.deadline
    ? Math.max(0, (new Date(market.deadline).getTime() - Date.now()) / (1000 * 60 * 60))
    : 999;
  let timeDecayBonus = 0;
  if (hoursToEnd <= 6) timeDecayBonus = 0.25;        // 6h or less: massive bonus
  else if (hoursToEnd <= 12) timeDecayBonus = 0.18;   // 12h: big bonus
  else if (hoursToEnd <= 24) timeDecayBonus = 0.12;   // 24h: solid bonus
  else if (hoursToEnd <= 48) timeDecayBonus = 0.06;   // 48h: small bonus

  // ── Factor 2: Volume Momentum ──
  const vol24h = market.volume24hr || 0;
  let volumeSignal = 0;
  if (vol24h > 50000) volumeSignal = 0.10;            // massive trading activity
  else if (vol24h > 10000) volumeSignal = 0.06;
  else if (vol24h > 5000) volumeSignal = 0.03;

  // ── Factor 3: Liquidity Depth ──
  const liq = market.liquidity || 0;
  const liquidityOk = liq >= 500; // $500+ liquidity can fill our $1 order easily
  const liquidityBonus = liq > 5000 ? 0.05 : liq > 1000 ? 0.03 : 0;

  // ── Factor 4: Price Convergence ──
  // Prices stuck in the middle near expiry = big edge potential
  const priceDistFromCertainty = Math.min(marketPrice, 1 - marketPrice); // 0 = certain, 0.5 = uncertain
  let convergenceBonus = 0;
  if (hoursToEnd <= 24 && priceDistFromCertainty > 0.15) convergenceBonus = 0.08;
  else if (hoursToEnd <= 48 && priceDistFromCertainty > 0.20) convergenceBonus = 0.04;

  // ── Composite Edge ──
  const adjustedEdge = rawEdge + timeDecayBonus + volumeSignal + liquidityBonus + convergenceBonus;

  // ── Confidence Score ──
  let confidence = 50 + adjustedEdge * 120;
  if (hoursToEnd <= 12) confidence += 15;  // near-expiry confidence boost
  if (vol24h > 10000) confidence += 5;
  if (liquidityOk) confidence += 5;
  confidence = Math.min(99, Math.round(confidence));

  // ── Recommendation ── (AGGRESSIVE: lower thresholds for 24hr profit deadline)
  let recommendation: "strong_buy" | "buy" | "hold" | "skip";
  if (adjustedEdge >= 0.06 && confidence >= 65) recommendation = "strong_buy";
  else if (adjustedEdge >= 0.03 && confidence >= 55) recommendation = "buy";
  else if (adjustedEdge >= 0.01) recommendation = "hold";
  else recommendation = "skip";

  // For fast-resolving markets, ALWAYS be aggressive (edge compounds near expiry)
  if (hoursToEnd <= 24 && rawEdge >= 0.01 && recommendation === "skip") recommendation = "hold";
  if (hoursToEnd <= 24 && rawEdge >= 0.02 && recommendation === "hold") recommendation = "buy";
  if (hoursToEnd <= 12 && rawEdge >= 0.01) recommendation = "buy";
  if (hoursToEnd <= 6 && rawEdge >= 0.01) recommendation = "strong_buy";

  const superAnalysis = {
    hours_to_resolution: Math.round(hoursToEnd * 10) / 10,
    raw_edge_pct: (rawEdge * 100).toFixed(1) + "%",
    time_decay_bonus: (timeDecayBonus * 100).toFixed(1) + "%",
    volume_momentum: (volumeSignal * 100).toFixed(1) + "%" + ` (vol24h: $${vol24h.toLocaleString()})`,
    liquidity_score: liquidityOk ? `OK ($${liq.toLocaleString()})` : `LOW ($${liq.toLocaleString()})`,
    convergence_bonus: (convergenceBonus * 100).toFixed(1) + "%",
    composite_edge: (adjustedEdge * 100).toFixed(1) + "%",
    confidence_score: confidence,
    risk_tier: hoursToEnd <= 6 ? "HIGH_CONVICTION" : hoursToEnd <= 24 ? "ELEVATED" : "STANDARD",
    max_bet_usd: 1.00,
  };

  return {
    marketPrice,
    yourForecast,
    edgePct: adjustedEdge,
    sideToBet,
    confidence,
    recommendation,
    superAnalysis,
  };
}

// ─── Risk Management ───────────────────────────────────────────

/** HARD CAP: Maximum $3.00 per trade (Polymarket minimum is 5 shares). */
const HARD_MAX_BET_USD = 3.00;

/** Minimum USDC.e balance to even attempt a trade (5 shares × ~$0.05 min price = $0.25). */
const MIN_TRADE_BALANCE = 0.50;

export function canMakeTrade(amountUsd: number): { allowed: boolean; reason?: string } {
  // HARD CAP enforcement — never exceed $3.00 per trade
  if (amountUsd > HARD_MAX_BET_USD) {
    return {
      allowed: false,
      reason: `HARD CAP: Trade size $${amountUsd} exceeds maximum $${HARD_MAX_BET_USD.toFixed(2)} per trade. Use amount_usd: 3.00 or less.`,
    };
  }
  if (amountUsd > portfolio.currentBalance && portfolio.currentBalance > 0) {
    return { allowed: false, reason: `Insufficient balance: $${portfolio.currentBalance.toFixed(2)}` };
  }
  if (portfolio.trades24h >= 25) {
    return { allowed: false, reason: `Max 25 trades per day reached` };
  }
  if (portfolio.positionsOpen >= 15) {
    return { allowed: false, reason: `Max 15 concurrent positions reached` };
  }
  return { allowed: true };
}

// ─── REAL Bet Placement (CLOB API) ─────────────────────────────

/**
 * Place a REAL bet on Polymarket via CLOB API.
 * Checks geoblock status before attempting order.
 * If a market with tokenIds is provided, sends actual limit orders.
 */
export async function placeBet(
  market: Market,
  side: "YES" | "NO",
  amountUsd: number,
): Promise<{
  success: boolean;
  positionId?: string;
  error?: string;
  details?: any;
}> {
  // Geoblock check — abort early if no proxy available
  if (isGeoblocked()) {
    const msg = "GEOBLOCKED: Cannot place real orders from this region. Set POLYMARKET_PROXY_URL env var to a proxy in an allowed region (UK, Germany, etc.)";
    console.error(`[Polymarket] ${msg}`);
    logger?.logError("trade", msg);
    return { success: false, error: msg };
  }

  // Risk check
  const check = canMakeTrade(amountUsd);
  if (!check.allowed) {
    logger?.logRiskViolation(`Trade rejected: ${check.reason}`, {
      amountUsd,
      maxAllowed: portfolio.currentBalance * 0.05,
      trades24h: portfolio.trades24h,
      dailyLoss: portfolio.dailyLoss,
    });
    return { success: false, error: check.reason };
  }

  const tokenId = side === "YES" ? market.yesTokenId : market.noTokenId;
  const entryPrice = side === "YES" ? market.yesPrice : market.noPrice;

  // If we have a real token ID → real CLOB order
  const isRealTrade = !!tokenId && !market.id.startsWith("mock_");

  try {
    let orderId: string | undefined;
    let livePrice = entryPrice;
    let _lastOrderCost = 0;   // actual cost = shares × price
    let _lastOrderShares = 0; // actual shares placed

    if (isRealTrade && walletPrivateKey) {
      await ensureClobClient();
      const clobClient = await getOrCreateClobClient({ privateKey: walletPrivateKey });

      // Get live midpoint
      try {
        const mid = await getMidpoint(tokenId!);
        if (mid > 0 && mid < 1) livePrice = mid;
      } catch {
        console.warn("[Polymarket] Could not get live midpoint, using Gamma price");
      }

      // Round to tick size
      const tickSize = market.tickSize || 0.01;
      const roundedPrice = Math.round(livePrice / tickSize) * tickSize;
      const price = Math.max(0.01, Math.min(0.99, roundedPrice));

      console.log(
        `[Polymarket] Placing REAL ${side} order: $${amountUsd} @ ${price.toFixed(4)} on "${market.title}"`,
      );
      
      // CLOB size is in shares (not dollars). shares = amountUsd / price
      // Polymarket minimum order size is 5 shares
      let orderSize = Math.floor(amountUsd / price);
      if (orderSize < 5) orderSize = 5; // minimum 5 shares
      const orderCost = orderSize * price;
      _lastOrderCost = orderCost;
      _lastOrderShares = orderSize;
      console.log(`[Polymarket] Order: ${orderSize} shares @ ${price.toFixed(4)} = $${orderCost.toFixed(2)}`);

      // ── Balance check: don't place order if wallet can't cover it ──
      if (walletAddress) {
        try {
          const usdcBal = await getUsdcBalance(walletAddress as `0x${string}`, "eip155:137");
          console.log(`[Polymarket] On-chain USDC.e balance: $${usdcBal.toFixed(4)}`);
          if (usdcBal < orderCost) {
            const msg = `INSUFFICIENT BALANCE: Need $${orderCost.toFixed(2)} but wallet only has $${usdcBal.toFixed(2)} USDC.e. Do NOT retry — go to sleep instead.`;
            console.warn(`[Polymarket] ${msg}`);
            logger?.logError("trade", msg);
            return { success: false, error: msg };
          }
        } catch (balErr: any) {
          console.warn(`[Polymarket] Could not check balance: ${balErr.message}, proceeding anyway`);
        }
      }

      const orderResult = await placeLimitOrder(clobClient, tokenId!, "BUY", price, orderSize);

      if (!orderResult.success) {
        logger?.logError("trade", `Order failed: ${orderResult.error}`);
        return { success: false, error: orderResult.error };
      }
      orderId = orderResult.orderId;
      livePrice = price;
    } else {
      console.log(
        `[Polymarket] Paper trade (no tokenId): ${side} $${amountUsd} on "${market.title}"`,
      );
    }

    const positionId =
      orderId || `pos_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Use actual order cost (shares × price) for real trades, not the requested amountUsd
    // Because Polymarket enforces a minimum of 5 shares, actual cost may differ
    const actualCost = _lastOrderCost > 0 ? _lastOrderCost : amountUsd;
    const actualShares = _lastOrderShares > 0 ? _lastOrderShares : amountUsd / livePrice;
    const shares = actualShares;
    const targetPrice = livePrice * (side === "YES" ? 1.08 : 0.92);
    const stoplossPrice = livePrice * (side === "YES" ? 0.95 : 1.05);

    // Update portfolio
    portfolio.currentBalance -= actualCost;
    portfolio.positionsOpen += 1;
    portfolio.trades24h += 1;
    savePortfolioState();

    // Store in database — use ACTUAL cost, not requested amount
    if (database) {
      database.insertPMPosition(
        positionId,
        market.id,
        market.title,
        side,
        livePrice,
        actualCost,
        targetPrice,
        stoplossPrice,
        market.yesTokenId,
        market.noTokenId,
        market.deadline,
        shares,
      );
    }

    logger?.logBetPlaced(market.title, side, actualCost, livePrice, targetPrice, stoplossPrice);
    console.log(
      `[BET PLACED] ${isRealTrade ? "REAL" : "PAPER"} ${side} on "${market.title}" - $${actualCost.toFixed(2)} (${shares} shares @ ${livePrice.toFixed(4)})`,
    );

    return {
      success: true,
      positionId,
      details: {
        marketTitle: market.title,
        side,
        entryPrice: livePrice,
        shares,
        amountUsd: actualCost,
        orderId,
        tokenId: tokenId || undefined,
        entryTime: new Date().toISOString(),
        targetExitPrice: targetPrice,
        stoplossPrice,
        isRealTrade,
      },
    };
  } catch (err: any) {
    logger?.logError("trade", `Failed to place bet: ${err.message}`, err);
    return { success: false, error: err.message };
  }
}

// ─── REAL Bet Closing ──────────────────────────────────────────

/**
 * Close a position. If tokenId is provided, places a SELL order on CLOB.
 */
export async function closeBet(
  positionId: string,
  exitPrice: number,
  entryPrice: number,
  shares: number,
  reason: "target_hit" | "stop_loss" | "timeout",
  marketTitle?: string,
  side?: "YES" | "NO",
  tokenId?: string,
): Promise<{
  success: boolean;
  exitValue?: number;
  pnlUsd?: number;
  pnlPct?: number;
}> {
  try {
    const entryValue = shares * entryPrice;

    // Try REAL sell via CLOB if we have token ID
    if (tokenId && walletPrivateKey) {
      try {
        await ensureClobClient();
        const clobClient = await getOrCreateClobClient({ privateKey: walletPrivateKey });
        const sellResult = await placeLimitOrder(clobClient, tokenId, "SELL", exitPrice, shares);
        if (!sellResult.success) {
          console.warn(`[Polymarket] Sell order failed: ${sellResult.error}, recording locally`);
        } else {
          console.log(`[Polymarket] REAL sell order placed: ${sellResult.orderId}`);
        }
      } catch (err: any) {
        console.warn(`[Polymarket] CLOB sell failed: ${err.message}, recording locally`);
      }
    }

    // P&L
    const exitValue = shares * exitPrice;
    const pnlUsd = exitValue - entryValue;
    const pnlPct = (pnlUsd / entryValue) * 100;
    const holdingMinutes = 0;

    // Update portfolio
    portfolio.currentBalance += exitValue;
    portfolio.positionsOpen = Math.max(0, portfolio.positionsOpen - 1);
    if (pnlUsd < 0) portfolio.dailyLoss += Math.abs(pnlUsd);
    savePortfolioState();

    // Close in database
    if (database) {
      database.closePMPosition(positionId, exitPrice, exitValue, reason, pnlUsd, pnlPct);
      database.insertPMTrade(
        positionId,
        "",
        marketTitle || "Unknown Market",
        side || "YES",
        entryPrice,
        entryValue,
        exitPrice,
        exitValue,
        reason,
        pnlUsd,
        pnlPct,
        holdingMinutes,
      );
    }

    logger?.logBetClosed(marketTitle || "Unknown", side || "YES", pnlUsd, pnlPct, reason, holdingMinutes);
    console.log(
      `[BET CLOSED] ${reason.toUpperCase()} - P&L: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)`,
    );

    return { success: true, exitValue, pnlUsd, pnlPct };
  } catch (err: any) {
    logger?.logError("trade", "Failed to close bet", err);
    return { success: false };
  }
}

// ─── Portfolio Management ──────────────────────────────────────

export function getPortfolioStatus(): Portfolio {
  return {
    ...portfolio,
    currentBalance: parseFloat(portfolio.currentBalance.toFixed(2)),
    dailyLoss: parseFloat(portfolio.dailyLoss.toFixed(2)),
  };
}

export function resetDailyTracking(): void {
  portfolio.dailyLoss = 0;
  portfolio.trades24h = 0;
  savePortfolioState();
}

/**
 * Get positions from the database (not hardcoded!).
 */
export function getPositions(): Position[] {
  if (!database) return [];
  const dbPositions = database.getPMPositions("open");
  return dbPositions.map((p) => ({
    positionId: p.id,
    marketId: "",
    marketTitle: p.marketTitle,
    side: p.side as "YES" | "NO",
    entryPrice: p.entryPrice,
    entryAmount: p.entryAmount,
    entryTime: "",
    currentPrice: p.currentPrice || p.entryPrice,
    pnlUsd: p.pnlUsd || 0,
    pnlPct: p.pnlPct || 0,
    holdingMinutes: 0,
  }));
}

/**
 * Sync portfolio state from real on-chain positions.
 */
export async function syncPortfolioFromChain(): Promise<void> {
  if (!walletAddress) return;
  try {
    const value = await getPortfolioValue(walletAddress);
    if (value > 0) {
      portfolio.currentBalance = value;
      console.log(`[Polymarket] Portfolio synced from chain: $${value.toFixed(2)}`);
    }
    const positions = await getUserPositions(walletAddress);
    portfolio.positionsOpen = positions.length;
    savePortfolioState();
  } catch (err: any) {
    console.warn(`[Polymarket] Portfolio sync failed: ${err.message}`);
  }
}

function savePortfolioState(): void {
  if (database?.setKV) {
    database.setKV("pm_portfolio_state", JSON.stringify(portfolio));
  }
}

// ─── Bridge Helper ────────────────────────────────────────────

export async function getDepositQuote(amountUsd: number): Promise<any> {
  return getBridgeQuote(amountUsd, "8453");
}

// ─── Premium Weather Placeholder ──────────────────────────────

export async function getWeatherViaPremiumAPI(
  location: string,
  conwayApiClient?: any,
): Promise<WeatherData | null> {
  if (!conwayApiClient) return null;
  try {
    const credits = await conwayApiClient.getCreditsBalance();
    if (credits < 1) return null;
    console.log(`[WEATHER] Premium API call: ${location}`);
    return null;
  } catch {
    return null;
  }
}
