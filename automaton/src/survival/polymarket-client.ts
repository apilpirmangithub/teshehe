/**
 * Polymarket CLOB Client Wrapper
 *
 * Manages the connection to Polymarket's Central Limit Order Book (CLOB).
 * Handles API key derivation, order creation, and market data fetching.
 * Includes automatic proxy discovery and geoblock bypass.
 *
 * Architecture:
 *   - Gamma API (https://gamma-api.polymarket.com): Market discovery (public)
 *   - CLOB API  (https://clob.polymarket.com):      Trading & pricing (auth for orders)
 *   - Data API  (https://data-api.polymarket.com):   User data (public)
 *   - Bridge API(https://bridge.polymarket.com):     Deposits/withdrawals
 *
 * The automaton's wallet lives on Base. USDC is bridged to Polygon for trading.
 */

import { ClobClient, Chain, Side, type OrderType } from "@polymarket/clob-client";
import { Wallet as EthersV5Wallet } from "@ethersproject/wallet";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import * as https from "https";
import * as http from "http";

// ─── Geoblock Detection & Proxy System ────────────────────────
// Polymarket blocks trading from certain regions (US, Singapore, etc.)
// This system detects geoblock and attempts proxy bypass.

let _isGeoblocked: boolean | null = null;  // null = unknown
let _proxyAgent: HttpsProxyAgent<string> | null = null;
let _proxyUrl: string | null = null;
let _geoblockCheckDone = false;

// Set POLYMARKET_PROXY_URL env var to route CLOB API through a proxy
// Example: export POLYMARKET_PROXY_URL=http://proxy-host:8080
const ENV_PROXY_URL = process.env.POLYMARKET_PROXY_URL;

/**
 * Check if we're geoblocked by Polymarket, and set up proxy if needed.
 * Called once on startup before any order placement.
 */
export async function checkAndConfigureProxy(): Promise<{ geoblocked: boolean; proxyActive: boolean; proxyUrl?: string }> {
  if (_geoblockCheckDone && _isGeoblocked === false) {
    return { geoblocked: false, proxyActive: !!_proxyAgent, proxyUrl: _proxyUrl || undefined };
  }

  console.log("[Polymarket] Checking geoblock status...");

  // Step 1: Test direct connection
  try {
    const resp = await axios.post("https://clob.polymarket.com/order", {}, { timeout: 10000, proxy: false });
    // If we get here without error, we're not geoblocked (though order will fail for other reasons)
    _isGeoblocked = false;
    _geoblockCheckDone = true;
    console.log("[Polymarket] ✓ Not geoblocked — direct connection works");
    return { geoblocked: false, proxyActive: false };
  } catch (err: any) {
    const errMsg = err.response?.data?.error || err.message || "";
    if (errMsg.includes("Trading restricted in your region") || errMsg.includes("geoblock")) {
      _isGeoblocked = true;
      console.warn("[Polymarket] ⚠ GEOBLOCKED — Trading restricted from this region");
    } else {
      // Other error (auth, etc.) — we're probably not geoblocked
      _isGeoblocked = false;
      _geoblockCheckDone = true;
      console.log("[Polymarket] ✓ Not geoblocked (got non-geoblock error: probably auth)");
      return { geoblocked: false, proxyActive: false };
    }
  }

  // Step 2: If geoblocked, try configured proxy
  const proxyUrl = ENV_PROXY_URL;
  if (proxyUrl) {
    console.log(`[Polymarket] Testing configured proxy: ${proxyUrl}`);
    const works = await testProxy(proxyUrl);
    if (works) {
      activateProxy(proxyUrl);
      _geoblockCheckDone = true;
      return { geoblocked: true, proxyActive: true, proxyUrl };
    } else {
      console.warn(`[Polymarket] Configured proxy failed: ${proxyUrl}`);
    }
  }

  // Step 3: Try auto-discovering working proxies
  console.log("[Polymarket] Attempting auto-proxy discovery...");
  const proxySources = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=DE,GB,NL,FR,JP,AU,BR&ssl=all&anonymity=elite",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=DE,GB,NL,FR&ssl=all&anonymity=anonymous",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=DE,GB&ssl=all&anonymity=all",
  ];

  for (const source of proxySources) {
    let proxies: string[] = [];
    try {
      const resp = await axios.get(source, { timeout: 8000, proxy: false });
      proxies = String(resp.data).trim().split("\n").filter(Boolean).slice(0, 20);
      console.log(`[Polymarket] Found ${proxies.length} proxy candidates from source, testing in batches...`);
    } catch {
      console.log(`[Polymarket] Proxy source unavailable, trying next...`);
      continue;
    }

    // Test proxies in parallel batches of 5 for speed
    for (let i = 0; i < proxies.length; i += 5) {
      const batch = proxies.slice(i, i + 5).map(p => `http://${p.trim()}`);
      const results = await Promise.allSettled(batch.map(url => testProxy(url).then(ok => ({ url, ok }))));
      
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.ok) {
          const url = result.value.url;
          try {
            activateProxy(url);
          } catch (activationErr: any) {
            console.error(`[Polymarket] Proxy activation error: ${activationErr.message}`);
            _proxyUrl = url;
            _isGeoblocked = true;
          }
          _geoblockCheckDone = true;
          return { geoblocked: true, proxyActive: true, proxyUrl: url };
        }
      }
    }
  }

  // No proxy found
  _geoblockCheckDone = true;
  console.error("[Polymarket] ❌ GEOBLOCKED and no working proxy found!");
  console.error("[Polymarket] Set POLYMARKET_PROXY_URL env var to an HTTP proxy in an allowed region.");
  console.error("[Polymarket] Example: export POLYMARKET_PROXY_URL=http://your-proxy:8080");
  console.error("[Polymarket] Tip: Use a VPS in Germany/UK/Netherlands as a simple SOCKS/HTTP proxy.");
  return { geoblocked: true, proxyActive: false };
}

/**
 * Test if a proxy can reach Polymarket CLOB without geoblock.
 */
async function testProxy(proxyUrl: string): Promise<boolean> {
  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    const resp = await axios.post("https://clob.polymarket.com/order", {}, {
      timeout: 6000,
      httpsAgent: agent,
      httpAgent: agent,
      proxy: false,
    });
    return true; // No error = not blocked
  } catch (err: any) {
    const errMsg = err.response?.data?.error || err.message || "";
    // If we get an auth error (not geoblock), the proxy works!
    if (errMsg.includes("geoblock") || errMsg.includes("Trading restricted")) {
      console.log(`  ✗ ${proxyUrl} — still geoblocked`);
      return false;
    }
    if (err.response?.status === 400 || err.response?.status === 401 || err.response?.status === 403) {
      // Got a real API error = proxy works (not geoblocked), order just needs auth
      console.log(`  ✓ ${proxyUrl} — proxy works! (got auth error, not geoblock)`);
      return true;
    }
    if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" || err.code === "ENOTFOUND") {
      console.log(`  ✗ ${proxyUrl} — connection failed`);
      return false;
    }
    // Unknown error — might work
    console.log(`  ? ${proxyUrl} — unknown response: ${errMsg.substring(0, 80)}`);
    return false;
  }
}

/**
 * Activate a proxy for all Polymarket CLOB requests.
 * Sets env vars, patches axios defaults, and monkey-patches axios.create
 * so ClobClient's internal HTTP calls route through the proxy.
 */
function activateProxy(proxyUrl: string): void {
  _proxyUrl = proxyUrl;
  _proxyAgent = new HttpsProxyAgent<string>(proxyUrl);
  
  // Set environment variables — many HTTP libs respect these
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  
  // Patch axios defaults
  axios.defaults.httpsAgent = _proxyAgent;
  axios.defaults.httpAgent = _proxyAgent;
  axios.defaults.proxy = false;
  
  // Monkey-patch axios.create to inject proxy agent into all new instances
  // This ensures ClobClient's internal axios instance uses our proxy
  const originalCreate = axios.create.bind(axios);
  axios.create = function patchedCreate(config?: any) {
    const instance = originalCreate({
      ...config,
      httpsAgent: _proxyAgent,
      httpAgent: _proxyAgent,
      proxy: false,
    });
    return instance;
  } as any;
  
  // Try patching global agents (may fail in ESM mode, that's OK)
  try { (https as any).globalAgent = _proxyAgent; } catch { /* read-only in ESM */ }
  try { (http as any).globalAgent = _proxyAgent; } catch { /* read-only in ESM */ }
  
  console.log(`[Polymarket] ✓ Proxy ACTIVATED: ${proxyUrl}`);
  console.log(`[Polymarket]   HTTP_PROXY=${proxyUrl}`);
}

/** Check if we're currently geoblocked (with no working proxy). */
export function isGeoblocked(): boolean {
  return _isGeoblocked === true && !_proxyUrl;
}

/** Get the active proxy URL, if any. */
export function getActiveProxy(): string | null {
  return _proxyUrl;
}

// ─── Constants ─────────────────────────────────────────────────

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const BRIDGE_API = "https://bridge.polymarket.com";

// USDC on Polygon (Polymarket's collateral)
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
// USDC.e on Polygon
const USDCE_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

// ─── Types ─────────────────────────────────────────────────────

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  category: string;
  liquidity: string;
  volume: string;
  active: boolean;
  closed: boolean;
  outcomes: string; // JSON string: '["Yes", "No"]'
  outcomePrices: string; // JSON string: '["0.45", "0.55"]'
  clobTokenIds: string; // JSON string with YES/NO token IDs
  volume24hr: number;
  volumeNum: number;
  liquidityNum: number;
  description: string;
  enableOrderBook: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  restricted: boolean;
  events?: Array<{
    id: string;
    title: string;
    slug: string;
    category: string;
  }>;
}

export interface ParsedMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  volume24hr: number;
  totalVolume: number;
  liquidity: number;
  endDate: string;
  category: string;
  description: string;
  tickSize: number;
  minOrderSize: number;
  active: boolean;
  closed: boolean;
  restricted: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  details?: {
    tokenId: string;
    side: string;
    price: number;
    size: number;
    orderType: string;
  };
}

export interface PolymarketClientConfig {
  privateKey: string; // hex private key from wallet
  chainId?: number;   // default: 137 (Polygon)
}

// ─── Client Singleton ──────────────────────────────────────────

let _clobClient: ClobClient | null = null;
let _apiKeyCreds: { key: string; secret: string; passphrase: string } | null = null;
let _ethersWallet: EthersV5Wallet | null = null;

/**
 * Initialize or get the CLOB client with full trading capabilities.
 * Derives API key from the wallet's private key (deterministic).
 */
export async function getOrCreateClobClient(
  config: PolymarketClientConfig,
): Promise<ClobClient> {
  if (_clobClient) return _clobClient;

  const chainId = config.chainId ?? Chain.POLYGON;

  // Create ethers v5 wallet (required by @polymarket/clob-client for _signTypedData)
  _ethersWallet = new EthersV5Wallet(config.privateKey);
  const address = _ethersWallet.address;

  console.log(`[Polymarket] Initializing CLOB client for ${address} on chain ${chainId}`);

  // Step 1: Create a signer-enabled client (L1 auth for deriveApiKey)
  const signerClient = new ClobClient(CLOB_API, chainId, _ethersWallet as any);

  // Step 2: Derive API key deterministically from wallet
  try {
    _apiKeyCreds = (await signerClient.deriveApiKey()) as any;
    console.log(`[Polymarket] API key derived successfully`);
  } catch (err: any) {
    console.warn(`[Polymarket] deriveApiKey failed: ${err.message}, trying createOrDeriveApiKey...`);
    try {
      _apiKeyCreds = (await signerClient.createOrDeriveApiKey()) as any;
      console.log(`[Polymarket] API key created/derived successfully`);
    } catch (err2: any) {
      console.error(`[Polymarket] Failed to create API key: ${err2.message}`);
      // Fall back to signer-only client (can read but not place orders)
      _clobClient = signerClient;
      return _clobClient;
    }
  }

  // Step 3: Create fully authenticated client with API creds (L2 auth for orders)
  if (_apiKeyCreds) {
    _clobClient = new ClobClient(
      CLOB_API,
      chainId,
      _ethersWallet as any,
      _apiKeyCreds,
    );
  } else {
    _clobClient = signerClient;
  }

  return _clobClient;
}

/**
 * Get a read-only (public) CLOB client for market data.
 * No authentication needed.
 */
export function getPublicClobClient(): ClobClient {
  return new ClobClient(CLOB_API, Chain.POLYGON);
}

// ─── Market Discovery (Gamma API) ─────────────────────────────

/**
 * Fetch active, open markets from the Gamma API.
 * Supports filtering by keyword, category, and minimum volume.
 */
export async function fetchGammaMarkets(opts?: {
  keyword?: string;
  category?: string;
  limit?: number;
  minVolume24hr?: number;
  active?: boolean;
  closed?: boolean;
  fastResolving?: boolean; // prioritize markets ending soonest
  maxHoursToEnd?: number;  // only markets ending within N hours
}): Promise<ParsedMarket[]> {
  const {
    keyword,
    category,
    limit = 20,
    minVolume24hr = 1000,
    active = true,
    closed = false,
    fastResolving = false,
    maxHoursToEnd,
  } = opts || {};

  // Build query params
  const params = new URLSearchParams();
  params.set("limit", String(fastResolving ? Math.min(limit * 3, 100) : limit)); // fetch more when filtering by time
  params.set("active", String(active));
  params.set("closed", String(closed));
  // For fast-resolving, sort by end_date ascending (soonest first)
  if (fastResolving) {
    params.set("order", "endDate");
    params.set("ascending", "true");
  } else {
    params.set("order", "volume24hr");
    params.set("ascending", "false");
  }
  if (category) params.set("tag_slug", category);

  const url = `${GAMMA_API}/markets?${params.toString()}`;
  console.log(`[Polymarket] Fetching markets: ${url}`);

  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Gamma API failed: HTTP ${response.status} ${response.statusText}`);
  }

  const raw: GammaMarket[] = await response.json();

  // Parse and filter
  const markets: ParsedMarket[] = [];
  for (const m of raw) {
    // Note: restricted=true is now default for most Polymarket markets, so we don't filter it
    if (!m.enableOrderBook) continue;
    if (!m.clobTokenIds) continue;

    // Parse prices
    let yesPrice = 0.5;
    let noPrice = 0.5;
    try {
      const prices = JSON.parse(m.outcomePrices);
      yesPrice = parseFloat(prices[0]) || 0.5;
      noPrice = parseFloat(prices[1]) || 0.5;
    } catch {}

    // Parse token IDs
    let yesTokenId = "";
    let noTokenId = "";
    try {
      const tokens = JSON.parse(m.clobTokenIds);
      yesTokenId = tokens[0] || "";
      noTokenId = tokens[1] || "";
    } catch {}

    if (!yesTokenId || !noTokenId) continue;

    // Filter by volume
    if ((m.volume24hr || 0) < minVolume24hr) continue;

    // Filter by max hours to end (fast-resolving filter)
    if (maxHoursToEnd && m.endDate) {
      const endTime = new Date(m.endDate).getTime();
      const hoursLeft = (endTime - Date.now()) / (1000 * 60 * 60);
      if (hoursLeft <= 0 || hoursLeft > maxHoursToEnd) continue;
    }

    // Filter by keyword
    if (keyword) {
      const kw = keyword.toLowerCase();
      const matchesQuestion = m.question.toLowerCase().includes(kw);
      const matchesCategory = (m.category || "").toLowerCase().includes(kw);
      const matchesDescription = (m.description || "").toLowerCase().includes(kw);
      if (!matchesQuestion && !matchesCategory && !matchesDescription) continue;
    }

    markets.push({
      id: m.id,
      question: m.question,
      slug: m.slug,
      conditionId: m.conditionId,
      yesTokenId,
      noTokenId,
      yesPrice,
      noPrice,
      volume24hr: m.volume24hr || 0,
      totalVolume: m.volumeNum || 0,
      liquidity: m.liquidityNum || 0,
      endDate: m.endDate,
      category: m.category || "",
      description: m.description || "",
      tickSize: m.orderPriceMinTickSize || 0.01,
      minOrderSize: m.orderMinSize || 5,
      active: m.active,
      closed: m.closed,
      restricted: m.restricted,
    });
  }

  return markets;
}

/**
 * Search markets via Gamma API search endpoint.
 */
export async function searchGammaMarkets(query: string, limit: number = 10): Promise<ParsedMarket[]> {
  const url = `${GAMMA_API}/markets?_q=${encodeURIComponent(query)}&limit=${limit}&active=true&closed=false`;
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Gamma search failed: HTTP ${response.status}`);
  }
  const raw: GammaMarket[] = await response.json();
  return raw
    .filter((m) => m.enableOrderBook && m.clobTokenIds)
    .map((m) => {
      let yesPrice = 0.5, noPrice = 0.5;
      try {
        const p = JSON.parse(m.outcomePrices);
        yesPrice = parseFloat(p[0]) || 0.5;
        noPrice = parseFloat(p[1]) || 0.5;
      } catch {}
      let yesTokenId = "", noTokenId = "";
      try {
        const t = JSON.parse(m.clobTokenIds);
        yesTokenId = t[0] || "";
        noTokenId = t[1] || "";
      } catch {}
      return {
        id: m.id,
        question: m.question,
        slug: m.slug,
        conditionId: m.conditionId,
        yesTokenId,
        noTokenId,
        yesPrice,
        noPrice,
        volume24hr: m.volume24hr || 0,
        totalVolume: m.volumeNum || 0,
        liquidity: m.liquidityNum || 0,
        endDate: m.endDate,
        category: m.category || "",
        description: m.description || "",
        tickSize: m.orderPriceMinTickSize || 0.01,
        minOrderSize: m.orderMinSize || 5,
        active: m.active,
        closed: m.closed,
        restricted: m.restricted,
      };
    });
}

// ─── Pricing (CLOB API, public) ────────────────────────────────

/**
 * Get live midpoint price for a token.
 */
export async function getMidpoint(tokenId: string): Promise<number> {
  const client = getPublicClobClient();
  const mid = await client.getMidpoint(tokenId);
  return parseFloat(String(mid));
}

/**
 * Get the full order book for a token.
 */
export async function getOrderBook(tokenId: string) {
  const client = getPublicClobClient();
  return client.getOrderBook(tokenId);
}

/**
 * Get last trade price for a token.
 */
export async function getLastTradePrice(tokenId: string): Promise<number> {
  const client = getPublicClobClient();
  const p = await client.getLastTradePrice(tokenId);
  return parseFloat(String(p));
}

// ─── Trading (CLOB API, authenticated) ─────────────────────────

/**
 * Place a limit order on Polymarket.
 *
 * @param clobClient - Authenticated CLOB client
 * @param tokenId    - The CLOB token ID (YES or NO token)
 * @param side       - BUY or SELL
 * @param price      - Limit price (0.01 - 0.99)
 * @param size       - Amount in USDC
 */
export async function placeLimitOrder(
  clobClient: ClobClient,
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
): Promise<OrderResult> {
  try {
    // Create the signed order
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price,
      size,
      side: side === "BUY" ? Side.BUY : Side.SELL,
    });

    // Post to the CLOB
    const resp = await clobClient.postOrder(order);
    const orderId = (resp as any)?.orderID || (resp as any)?.id || "";

    if (!orderId) {
      const errorMsg = (resp as any)?.error || (resp as any)?.message || JSON.stringify(resp);
      console.error(`[Polymarket] Order returned empty orderId. Response: ${errorMsg}`);
      return { success: false, error: `Order rejected: ${errorMsg}` };
    }

    console.log(`[Polymarket] Order placed: ${side} ${size} @ ${price} → ${orderId}`);
    return {
      success: true,
      orderId,
      details: {
        tokenId,
        side,
        price,
        size,
        orderType: "limit",
      },
    };
  } catch (err: any) {
    console.error(`[Polymarket] Order failed: ${err.message}`);
    console.error(`[Polymarket] Stack: ${err.stack?.split('\n').slice(0, 3).join('\n')}`);
    console.error(`[Polymarket] Order params: tokenId=${tokenId}, side=${side}, price=${price}, size=${size}`);
    console.error(`[Polymarket] Client has creds: ${!!(clobClient as any).creds}`);
    return { success: false, error: err.message };
  }
}

/**
 * Place a market order (FOK - Fill or Kill).
 */
export async function placeMarketOrder(
  clobClient: ClobClient,
  tokenId: string,
  side: "BUY" | "SELL",
  size: number,
): Promise<OrderResult> {
  try {
    const order = await clobClient.createMarketOrder({
      tokenID: tokenId,
      amount: size,
      side: side === "BUY" ? Side.BUY : Side.SELL,
    });

    const resp = await clobClient.postOrder(order);
    const orderId = (resp as any)?.orderID || (resp as any)?.id || "";

    console.log(`[Polymarket] Market order placed: ${side} $${size} → ${orderId}`);
    return {
      success: true,
      orderId,
      details: {
        tokenId,
        side,
        price: 0, // market price
        size,
        orderType: "market",
      },
    };
  } catch (err: any) {
    console.error(`[Polymarket] Market order failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(
  clobClient: ClobClient,
  orderId: string,
): Promise<boolean> {
  try {
    await clobClient.cancelOrder({ orderID: orderId });
    console.log(`[Polymarket] Order cancelled: ${orderId}`);
    return true;
  } catch (err: any) {
    console.error(`[Polymarket] Cancel failed: ${err.message}`);
    return false;
  }
}

/**
 * Cancel all open orders.
 */
export async function cancelAllOrders(
  clobClient: ClobClient,
): Promise<boolean> {
  try {
    await clobClient.cancelAll();
    console.log(`[Polymarket] All orders cancelled`);
    return true;
  } catch (err: any) {
    console.error(`[Polymarket] Cancel all failed: ${err.message}`);
    return false;
  }
}

/**
 * Get open orders for the authenticated user.
 */
export async function getOpenOrders(clobClient: ClobClient) {
  return clobClient.getOpenOrders();
}

/**
 * Get trade history for the authenticated user.
 */
export async function getTradeHistory(clobClient: ClobClient) {
  return clobClient.getTrades();
}

// ─── User Data (Data API, public) ──────────────────────────────

/**
 * Get current positions for a wallet address.
 */
export async function getUserPositions(address: string): Promise<any[]> {
  const url = `${DATA_API}/positions?user=${address.toLowerCase()}`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  return resp.json();
}

/**
 * Get total portfolio value for a wallet.
 */
export async function getPortfolioValue(address: string): Promise<number> {
  const url = `${DATA_API}/value?user=${address.toLowerCase()}`;
  const resp = await fetch(url);
  if (!resp.ok) return 0;
  const data = await resp.json();
  return parseFloat(data?.value || "0");
}

// ─── Bridge (Base ↔ Polygon) ───────────────────────────────────

/**
 * Get a bridge quote for depositing USDC from Base to Polymarket (Polygon).
 */
export async function getBridgeQuote(
  amountUsd: number,
  fromChain: string = "8453", // Base
): Promise<any> {
  const url = `${BRIDGE_API}/quote`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromChainId: fromChain,
      fromTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
      toChainId: "137", // Polygon
      amount: String(Math.floor(amountUsd * 1e6)), // USDC has 6 decimals
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge quote failed: ${resp.status} - ${text}`);
  }
  return resp.json();
}

/**
 * Reset the singleton client (useful for testing or re-auth).
 */
export function resetClobClient(): void {
  _clobClient = null;
  _apiKeyCreds = null;
  _ethersWallet = null;
}
