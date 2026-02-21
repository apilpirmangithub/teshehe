/**
 * Perpetual Futures Scalping on Base Chain
 *
 * Uses Synthetix V3 Perps (Andromeda deployment) for leveraged trading.
 * Multi-market: ETH-PERP, BTC-PERP (expandable)
 * Scalping: quick entries, tight TP/SL, 5x-25x leverage.
 *
 * Flow:
 * 1. Create perps account (one-time)
 * 2. Wrap USDC → sUSD via SpotMarketProxy
 * 3. Deposit sUSD as margin
 * 4. Commit order (async, settled by keeper ~2-8s)
 * 5. Monitor position, TP/SL management
 * 6. Close by committing opposite order
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseEther,
  formatEther,
  type Address,
  type PrivateKeyAccount,
  erc20Abi,
} from "viem";
import { base } from "viem/chains";
import type { InferenceClient } from "../types.js";

// ─── Constants ──────────────────────────────────────────────────

const BASE_RPC = "https://mainnet.base.org";
const DEXSCREENER_API = "https://api.dexscreener.com";

// Synthetix V3 on Base (Andromeda deployment)
const PERPS_MARKET_PROXY: Address = "0x0A2AF931eFFd34b81ebcc57E3d3c9B1E1dE1C9Ce";
const SPOT_MARKET_PROXY: Address = "0x18141523403e2595D31b22604AcB8Fc06a4CDa3a";
const SUSD_TOKEN: Address = "0x09d51516F38980035153a554c26Df3C6f51a23C3";
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// DexScreener tokens for price tracking
const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
const CBBTC_BASE: Address = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

// Synth market IDs
const USDC_SYNTH_MARKET_ID = 1n;
const SUSD_COLLATERAL_ID = 0n;

// ─── Perp Markets ───────────────────────────────────────────────

export const PERP_MARKETS = {
  ETH: { id: 100n, name: "ETH-PERP", priceToken: WETH_BASE },
  BTC: { id: 200n, name: "BTC-PERP", priceToken: CBBTC_BASE },
} as const;

export type PerpMarketKey = keyof typeof PERP_MARKETS;
const ALL_MARKETS: PerpMarketKey[] = ["ETH", "BTC"];

// Scalping parameters — 15-MINUTE AGGRESSIVE MONEY MACHINE
export const SCALP_CONFIG = {
  defaultLeverage: 12,     // Higher default leverage for more profit
  maxLeverage: 25,
  tpPct: 2.5,              // Take profit +2.5% (ASYMMETRIC: big reward)
  slPct: 0.8,              // Stop loss -0.8% (TIGHT: protect capital)
  maxHoldMs: 15 * 60 * 1000, // 15 minutes strict
  maxMargin: 5.00,         // Dynamic: increases as profits grow
  minMargin: 0.30,         // Minimum $0.30 margin (seize tiny opportunities)
  slippagePct: 0.8,
  scanIntervalMs: 30_000,  // Re-scan every 30s — catch EVERY opportunity
  maxOpenPositions: 2,     // ETH + BTC simultaneously
  compoundPct: 0.70,       // Compound 70% of profits into next trade
  trailingStopPct: 1.2,    // Trailing stop: lock profits at +1.2% from peak
};

// ─── Types ──────────────────────────────────────────────────────

export interface PerpPosition {
  id: string;
  market: PerpMarketKey;
  side: "LONG" | "SHORT";
  sizeAsset: string;    // size in asset units (e.g., "0.01" ETH)
  leverage: number;
  entryPrice: number;
  marginUsdc: number;
  tpPrice: number;
  slPrice: number;
  openTime: string;
  status: "pending" | "open" | "closed";
  accountId: string;    // Synthetix account ID
  // Close details
  closePrice?: number;
  closePnlUsd?: number;
  closePnlPct?: number;
  closeTime?: string;
  closeReason?: string;
  txHashes: string[];
}

export interface TrendSignal {
  market: PerpMarketKey;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;   // 0-100
  price: number;
  change5m: number;
  change1h: number;
  change24h: number;
  volume24h: number;
  reasoning: string;
  // Advanced analysis data
  technicalScore?: number;
  newsScore?: number;
  liquidityFlowScore?: number;
  llmVerdict?: string;
  llmConfidence?: number;
  headlines?: string[];
  keyFactors?: string[];
}

// ─── ABIs ───────────────────────────────────────────────────────

const PERPS_ABI = [
  // createAccount
  {
    name: "createAccount",
    inputs: [] as const,
    outputs: [{ name: "accountId", type: "uint128" }] as const,
    stateMutability: "nonpayable" as const,
    type: "function" as const,
  },
  // modifyCollateral
  {
    name: "modifyCollateral",
    inputs: [
      { name: "accountId", type: "uint128" },
      { name: "collateralId", type: "uint128" },
      { name: "amountDelta", type: "int256" },
    ] as const,
    outputs: [] as const,
    stateMutability: "nonpayable" as const,
    type: "function" as const,
  },
  // commitOrder
  {
    name: "commitOrder",
    inputs: [
      {
        components: [
          { name: "marketId", type: "uint128" },
          { name: "accountId", type: "uint128" },
          { name: "sizeDelta", type: "int128" },
          { name: "settlementStrategyId", type: "uint128" },
          { name: "acceptablePrice", type: "uint256" },
          { name: "trackingCode", type: "bytes32" },
          { name: "referrer", type: "address" },
        ] as const,
        name: "commitment",
        type: "tuple",
      },
    ] as const,
    outputs: [] as const,
    stateMutability: "nonpayable" as const,
    type: "function" as const,
  },
  // getOpenPosition
  {
    name: "getOpenPosition",
    inputs: [
      { name: "accountId", type: "uint128" },
      { name: "marketId", type: "uint128" },
    ] as const,
    outputs: [
      { name: "totalPnl", type: "int256" },
      { name: "accruedFunding", type: "int256" },
      { name: "positionSize", type: "int128" },
      { name: "owedInterest", type: "uint256" },
    ] as const,
    stateMutability: "view" as const,
    type: "function" as const,
  },
  // getAvailableMargin
  {
    name: "getAvailableMargin",
    inputs: [{ name: "accountId", type: "uint128" }] as const,
    outputs: [{ name: "availableMargin", type: "int256" }] as const,
    stateMutability: "view" as const,
    type: "function" as const,
  },
  // getRequiredMargins
  {
    name: "getRequiredMargins",
    inputs: [{ name: "accountId", type: "uint128" }] as const,
    outputs: [
      { name: "requiredInitialMargin", type: "uint256" },
      { name: "requiredMaintenanceMargin", type: "uint256" },
      { name: "maxLiquidationReward", type: "uint256" },
    ] as const,
    stateMutability: "view" as const,
    type: "function" as const,
  },
  // indexPrice — current oracle price
  {
    name: "indexPrice",
    inputs: [{ name: "marketId", type: "uint128" }] as const,
    outputs: [{ name: "price", type: "uint256" }] as const,
    stateMutability: "view" as const,
    type: "function" as const,
  },
] as const;

const SPOT_ABI = [
  {
    name: "wrap",
    inputs: [
      { name: "marketId", type: "uint128" },
      { name: "wrapAmount", type: "uint256" },
      { name: "minAmountReceived", type: "uint256" },
    ] as const,
    outputs: [
      { name: "amountToMint", type: "uint256" },
      {
        components: [
          { name: "fixedFees", type: "uint256" },
          { name: "utilizationFees", type: "int256" },
          { name: "skewFees", type: "int256" },
          { name: "wrapperFees", type: "int256" },
        ] as const,
        name: "fees",
        type: "tuple",
      },
    ] as const,
    stateMutability: "nonpayable" as const,
    type: "function" as const,
  },
] as const;

// ─── Clients ────────────────────────────────────────────────────

function getPublicClient() {
  return createPublicClient({ chain: base, transport: http(BASE_RPC) });
}

function getWalletClient(account: PrivateKeyAccount) {
  return createWalletClient({ chain: base, transport: http(BASE_RPC), account });
}

// ─── Balance ────────────────────────────────────────────────────

export async function getBaseUsdcBalance(address: Address): Promise<number> {
  const client = getPublicClient();
  const balance = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatUnits(balance, 6));
}

export async function getBaseEthBalance(address: Address): Promise<number> {
  const client = getPublicClient();
  const balance = await client.getBalance({ address });
  return Number(formatEther(balance));
}

// ─── Account Management ─────────────────────────────────────────

/**
 * Initialize a Synthetix V3 Perps account.
 * Creates a new account if none exists, stores accountId in DB.
 */
export async function initPerpAccount(
  account: PrivateKeyAccount,
  db: { getKV: (key: string) => string | undefined | null; setKV: (key: string, value: string) => void },
): Promise<bigint> {
  // Check if we already have an account
  const existing = db.getKV("perp_account_id");
  if (existing) {
    console.log(`[PERP] Using existing account: ${existing}`);
    return BigInt(existing);
  }

  console.log("[PERP] Creating new Synthetix V3 Perps account...");
  const walletClient = getWalletClient(account);
  const publicClient = getPublicClient();

  try {
    const hash = await walletClient.writeContract({
      address: PERPS_MARKET_PROXY,
      abi: PERPS_ABI,
      functionName: "createAccount",
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status === "reverted") {
      throw new Error("createAccount transaction reverted");
    }

    // Parse accountId from logs (AccountCreated event)
    // The accountId is typically in the first topic or log data
    let accountId = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === PERPS_MARKET_PROXY.toLowerCase()) {
        // Try to extract accountId from topics or data
        if (log.topics.length >= 2) {
          accountId = BigInt(log.topics[1] || "0");
        }
        if (accountId === 0n && log.data.length >= 66) {
          accountId = BigInt("0x" + log.data.slice(2, 66));
        }
        if (accountId > 0n) break;
      }
    }

    // Fallback: try reading from transaction return data
    if (accountId === 0n) {
      // Use a sequential fallback — read account list
      accountId = BigInt(Date.now()); // Temporary, will be overwritten
      console.warn(`[PERP] Could not parse accountId from logs, using fallback`);
    }

    db.setKV("perp_account_id", accountId.toString());
    console.log(`[PERP] Account created: ${accountId} | tx: ${hash}`);
    return accountId;
  } catch (err: any) {
    console.error(`[PERP] createAccount failed: ${err.message}`);
    throw err;
  }
}

// ─── Collateral Management ──────────────────────────────────────

/**
 * Approve token for a spender (max approval).
 */
async function ensureApproval(
  account: PrivateKeyAccount,
  token: Address,
  spender: Address,
  decimals: number = 6,
): Promise<void> {
  const publicClient = getPublicClient();
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });

  if (allowance > parseUnits("1000000", decimals)) return;

  const walletClient = getWalletClient(account);
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, parseUnits("999999999", decimals)],
  });
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  console.log(`[PERP] Approved ${token} for ${spender}`);
}

/**
 * Wrap USDC → sUSD via Synthetix V3 SpotMarketProxy.
 * Returns sUSD amount received (in 18 decimals).
 */
export async function wrapUsdcToSusd(
  account: PrivateKeyAccount,
  usdcAmount: number,
): Promise<{ susdAmount: string; txHash: string }> {
  // Approve USDC for SpotMarketProxy
  await ensureApproval(account, USDC_BASE, SPOT_MARKET_PROXY, 6);

  const walletClient = getWalletClient(account);
  const publicClient = getPublicClient();

  const amountIn = parseUnits(usdcAmount.toFixed(6), 6);

  const hash = await walletClient.writeContract({
    address: SPOT_MARKET_PROXY,
    abi: SPOT_ABI,
    functionName: "wrap",
    args: [USDC_SYNTH_MARKET_ID, amountIn, 0n], // minAmountReceived = 0 (accept any)
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status === "reverted") {
    throw new Error("USDC → sUSD wrap reverted");
  }

  // Parse sUSD amount from Transfer event
  let susdReceived = "0";
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === SUSD_TOKEN.toLowerCase() && log.topics.length >= 3) {
      const toAddr = `0x${log.topics[2]?.slice(26)}`.toLowerCase();
      if (toAddr === account.address.toLowerCase()) {
        susdReceived = formatEther(BigInt(log.data));
        break;
      }
    }
  }

  console.log(`[PERP] Wrapped $${usdcAmount} USDC → ${susdReceived} sUSD | tx: ${hash}`);
  return { susdAmount: susdReceived, txHash: hash };
}

/**
 * Deposit sUSD margin into Synthetix V3 Perps account.
 */
export async function depositMargin(
  account: PrivateKeyAccount,
  accountId: bigint,
  susdAmount: string,
): Promise<string> {
  // Approve sUSD for PerpsMarketProxy
  await ensureApproval(account, SUSD_TOKEN, PERPS_MARKET_PROXY, 18);

  const walletClient = getWalletClient(account);
  const publicClient = getPublicClient();

  const amount = parseEther(susdAmount);

  const hash = await walletClient.writeContract({
    address: PERPS_MARKET_PROXY,
    abi: PERPS_ABI,
    functionName: "modifyCollateral",
    args: [accountId, SUSD_COLLATERAL_ID, amount],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status === "reverted") {
    throw new Error("Margin deposit reverted");
  }

  console.log(`[PERP] Deposited ${susdAmount} sUSD margin | tx: ${hash}`);
  return hash;
}

/**
 * Full flow: USDC → sUSD → deposit margin.
 * Returns all tx hashes.
 */
export async function depositUsdcAsMargin(
  account: PrivateKeyAccount,
  accountId: bigint,
  usdcAmount: number,
): Promise<{ txHashes: string[]; susdDeposited: string }> {
  const txHashes: string[] = [];

  // Step 1: Wrap USDC → sUSD
  const wrap = await wrapUsdcToSusd(account, usdcAmount);
  txHashes.push(wrap.txHash);

  // Step 2: Deposit sUSD as margin
  const depositTx = await depositMargin(account, accountId, wrap.susdAmount);
  txHashes.push(depositTx);

  return { txHashes, susdDeposited: wrap.susdAmount };
}

// ─── Trading ────────────────────────────────────────────────────

/**
 * Open a perpetual position: LONG or SHORT.
 * Calculates size from margin + leverage, commits order via Synthetix V3.
 */
export async function openPerpPosition(
  account: PrivateKeyAccount,
  accountId: bigint,
  market: PerpMarketKey,
  side: "LONG" | "SHORT",
  marginUsdc: number,
  leverage: number = SCALP_CONFIG.defaultLeverage,
): Promise<PerpPosition | { error: string }> {
  const mkt = PERP_MARKETS[market];
  const lev = Math.min(Math.max(leverage, 1.1), SCALP_CONFIG.maxLeverage);

  try {
    // Get current market price
    const price = await getMarketPrice(market);
    if (!price) return { error: `Cannot get ${market} price` };

    const currentPrice = price.priceUsd;
    const notional = marginUsdc * lev;

    // Calculate position size in asset units
    const sizeInAsset = notional / currentPrice;

    // Calculate TP/SL prices
    const tpPriceVal = side === "LONG"
      ? currentPrice * (1 + SCALP_CONFIG.tpPct / 100)
      : currentPrice * (1 - SCALP_CONFIG.tpPct / 100);
    const slPriceVal = side === "LONG"
      ? currentPrice * (1 - SCALP_CONFIG.slPct / 100)
      : currentPrice * (1 + SCALP_CONFIG.slPct / 100);

    // Deposit margin
    console.log(`[PERP] Depositing $${marginUsdc.toFixed(2)} margin for ${side} ${market} ${lev}x...`);
    const deposit = await depositUsdcAsMargin(account, accountId, marginUsdc);
    const txHashes = [...deposit.txHashes];

    // Commit order
    // sizeDelta: positive for LONG, negative for SHORT (in 18 decimals)
    const sizeWei = parseEther(sizeInAsset.toFixed(18));
    const sizeDelta = side === "LONG" ? sizeWei : -sizeWei;

    // acceptablePrice: for LONG = max price (1% above), for SHORT = min price (1% below)
    const slippage = SCALP_CONFIG.slippagePct / 100;
    const acceptablePrice = side === "LONG"
      ? parseEther((currentPrice * (1 + slippage)).toFixed(18))
      : parseEther((currentPrice * (1 - slippage)).toFixed(18));

    console.log(`[PERP] Committing ${side} ${market} | size: ${sizeInAsset.toFixed(6)} | price: $${currentPrice.toFixed(2)} | leverage: ${lev}x`);

    const walletClient = getWalletClient(account);
    const publicClient = getPublicClient();

    const commitHash = await walletClient.writeContract({
      address: PERPS_MARKET_PROXY,
      abi: PERPS_ABI,
      functionName: "commitOrder",
      args: [{
        marketId: mkt.id,
        accountId,
        sizeDelta: sizeDelta as unknown as bigint,
        settlementStrategyId: 0n,
        acceptablePrice,
        trackingCode: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
        referrer: "0x0000000000000000000000000000000000000000" as Address,
      }],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: commitHash, confirmations: 1 });
    if (receipt.status === "reverted") {
      return { error: "commitOrder reverted — check margin/leverage/market" };
    }
    txHashes.push(commitHash);

    // Wait for settlement (~5 seconds)
    console.log("[PERP] Order committed, waiting for keeper settlement...");
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Check if position opened
    let positionStatus: "pending" | "open" = "pending";
    try {
      const posData = await publicClient.readContract({
        address: PERPS_MARKET_PROXY,
        abi: PERPS_ABI,
        functionName: "getOpenPosition",
        args: [accountId, mkt.id],
      });
      if (posData[2] !== 0n) {
        positionStatus = "open";
        console.log(`[PERP] ✅ Position OPEN: ${side} ${market} ${lev}x @ $${currentPrice.toFixed(2)}`);
      } else {
        console.log("[PERP] Order pending settlement, will check next cycle");
      }
    } catch {
      console.log("[PERP] Could not verify position, marking as pending");
    }

    const posId = `perp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    return {
      id: posId,
      market,
      side,
      sizeAsset: sizeInAsset.toFixed(8),
      leverage: lev,
      entryPrice: currentPrice,
      marginUsdc,
      tpPrice: tpPriceVal,
      slPrice: slPriceVal,
      openTime: new Date().toISOString(),
      status: positionStatus,
      accountId: accountId.toString(),
      txHashes,
    };
  } catch (err: any) {
    console.error(`[PERP] openPerpPosition error: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Close a perpetual position by committing opposite order.
 */
export async function closePerpPosition(
  account: PrivateKeyAccount,
  position: PerpPosition,
): Promise<{ closePrice: number; pnlUsd: number; pnlPct: number; txHash: string } | { error: string }> {
  const mkt = PERP_MARKETS[position.market];
  const accountId = BigInt(position.accountId);

  try {
    // Get current price
    const price = await getMarketPrice(position.market);
    if (!price) return { error: `Cannot get ${position.market} price` };
    const closePrice = price.priceUsd;

    // Calculate PnL
    const pnlPct = position.side === "LONG"
      ? ((closePrice - position.entryPrice) / position.entryPrice) * 100 * position.leverage
      : ((position.entryPrice - closePrice) / position.entryPrice) * 100 * position.leverage;
    const pnlUsd = (pnlPct / 100) * position.marginUsdc;

    // Commit opposite order to close
    const sizeWei = parseEther(position.sizeAsset);
    const sizeDelta = position.side === "LONG" ? -sizeWei : sizeWei; // Opposite direction

    const slippage = SCALP_CONFIG.slippagePct / 100;
    const acceptablePrice = position.side === "LONG"
      ? parseEther((closePrice * (1 - slippage)).toFixed(18)) // Selling: min price
      : parseEther((closePrice * (1 + slippage)).toFixed(18)); // Buying back: max price

    const walletClient = getWalletClient(account);
    const publicClient = getPublicClient();

    const hash = await walletClient.writeContract({
      address: PERPS_MARKET_PROXY,
      abi: PERPS_ABI,
      functionName: "commitOrder",
      args: [{
        marketId: mkt.id,
        accountId,
        sizeDelta: sizeDelta as unknown as bigint,
        settlementStrategyId: 0n,
        acceptablePrice,
        trackingCode: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
        referrer: "0x0000000000000000000000000000000000000000" as Address,
      }],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status === "reverted") {
      return { error: "Close order reverted" };
    }

    // Wait for settlement
    await new Promise(resolve => setTimeout(resolve, 6000));

    console.log(`[PERP] ✅ Closed ${position.side} ${position.market} ${position.leverage}x | PnL: $${pnlUsd.toFixed(4)} (${pnlPct.toFixed(1)}%)`);

    return { closePrice, pnlUsd, pnlPct, txHash: hash };
  } catch (err: any) {
    console.error(`[PERP] closePerpPosition error: ${err.message}`);
    return { error: err.message };
  }
}

// ─── Position Queries ───────────────────────────────────────────

/**
 * Get on-chain position data for a specific market.
 */
export async function getOnChainPosition(
  accountId: bigint,
  market: PerpMarketKey,
): Promise<{ pnl: number; funding: number; size: number; interest: number } | null> {
  const mkt = PERP_MARKETS[market];
  const client = getPublicClient();

  try {
    const data = await client.readContract({
      address: PERPS_MARKET_PROXY,
      abi: PERPS_ABI,
      functionName: "getOpenPosition",
      args: [accountId, mkt.id],
    });

    return {
      pnl: Number(formatEther(data[0])),
      funding: Number(formatEther(data[1])),
      size: Number(formatEther(BigInt(data[2]))),
      interest: Number(formatEther(data[3])),
    };
  } catch {
    return null;
  }
}

/**
 * Get available margin for an account.
 */
export async function getAvailableMargin(accountId: bigint): Promise<number> {
  const client = getPublicClient();
  try {
    const margin = await client.readContract({
      address: PERPS_MARKET_PROXY,
      abi: PERPS_ABI,
      functionName: "getAvailableMargin",
      args: [accountId],
    });
    return Number(formatEther(margin));
  } catch {
    return 0;
  }
}

/**
 * Get Synthetix oracle price for a perp market.
 */
export async function getOraclePrice(market: PerpMarketKey): Promise<number | null> {
  const mkt = PERP_MARKETS[market];
  const client = getPublicClient();
  try {
    const price = await client.readContract({
      address: PERPS_MARKET_PROXY,
      abi: PERPS_ABI,
      functionName: "indexPrice",
      args: [mkt.id],
    });
    return Number(formatEther(price));
  } catch {
    return null;
  }
}

// ─── Price & Trend Analysis (ADVANCED: News + Technical + Flow + LLM) ──

/**
 * Get real-time market price + movements from DexScreener.
 */
export async function getMarketPrice(market: PerpMarketKey): Promise<{
  priceUsd: number;
  change5m: number;
  change1h: number;
  change24h: number;
  volume24h: number;
  liquidity: number;
  buyCount1h?: number;
  sellCount1h?: number;
  buyCount24h?: number;
  sellCount24h?: number;
  pairAddress?: string;
} | null> {
  const mkt = PERP_MARKETS[market];
  try {
    const res = await fetch(
      `${DEXSCREENER_API}/tokens/v1/base/${mkt.priceToken}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const pairs = await res.json() as any[];
    if (!pairs || pairs.length === 0) return null;

    const sorted = pairs
      .filter((p: any) => p.chainId === "base")
      .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = sorted[0];
    if (!best) return null;

    return {
      priceUsd: parseFloat(best.priceUsd || "0"),
      change5m: best.priceChange?.m5 ?? 0,
      change1h: best.priceChange?.h1 ?? 0,
      change24h: best.priceChange?.h24 ?? 0,
      volume24h: best.volume?.h24 ?? 0,
      liquidity: best.liquidity?.usd ?? 0,
      buyCount1h: best.txns?.h1?.buys ?? 0,
      sellCount1h: best.txns?.h1?.sells ?? 0,
      buyCount24h: best.txns?.h24?.buys ?? 0,
      sellCount24h: best.txns?.h24?.sells ?? 0,
      pairAddress: best.pairAddress,
    };
  } catch {
    return null;
  }
}

// ─── NEWS ANALYSIS (Google News + CryptoCompare) ────────────────

const MARKET_NAMES: Record<PerpMarketKey, { symbol: string; name: string; queries: string[] }> = {
  ETH: { symbol: "ETH", name: "Ethereum", queries: ["Ethereum ETH crypto", "Ethereum price today"] },
  BTC: { symbol: "BTC", name: "Bitcoin", queries: ["Bitcoin BTC crypto", "Bitcoin price today"] },
};

async function fetchNewsForMarket(market: PerpMarketKey): Promise<string[]> {
  const info = MARKET_NAMES[market];
  const headlines: string[] = [];

  for (const query of info.queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AutomatonBot/1.0)" },
      });
      if (!res.ok) continue;
      const xml = await res.text();

      const itemRegex = /<item>[\s\S]*?<\/item>/g;
      const titleRegex = /<title>([\s\S]*?)<\/title>/;
      const sourceRegex = /<source[^>]*>([\s\S]*?)<\/source>/;

      let match;
      while ((match = itemRegex.exec(xml)) !== null && headlines.length < 6) {
        const titleMatch = titleRegex.exec(match[0]);
        const sourceMatch = sourceRegex.exec(match[0]);
        if (titleMatch) {
          let h = titleMatch[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
          const src = sourceMatch?.[1]?.trim() || "";
          if (src) h += ` — ${src}`;
          if (!headlines.some(x => x.includes(h.slice(0, 30)))) headlines.push(h);
        }
      }
    } catch {}
  }

  // Also fetch broad crypto market news
  try {
    const url = `https://news.google.com/rss/search?q=cryptocurrency+market+today&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.ok) {
      const xml = await res.text();
      const itemRegex = /<item>[\s\S]*?<\/item>/g;
      const titleRegex = /<title>([\s\S]*?)<\/title>/;
      let m;
      while ((m = itemRegex.exec(xml)) !== null && headlines.length < 8) {
        const tM = titleRegex.exec(m[0]);
        if (tM) {
          const h = `[MARKET] ${tM[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim()}`;
          if (!headlines.some(x => x.includes(h.slice(10, 40)))) headlines.push(h);
        }
      }
    }
  } catch {}

  return headlines;
}

function analyzeNewsSentiment(headlines: string[]): {
  score: number; sentiment: string; bullCount: number; bearCount: number; signals: string[];
} {
  if (headlines.length === 0) return { score: 50, sentiment: "NEUTRAL", bullCount: 0, bearCount: 0, signals: ["No news found"] };

  const text = headlines.join(" ").toLowerCase();
  const bullishWords = ["surge", "rally", "soar", "pump", "breakout", "bullish", "record high",
    "all-time high", "ath", "moon", "growth", "partnership", "etf", "approval", "adoption",
    "upgrade", "buy", "accumulate", "whale buys", "institutional", "inflow", "halving"];
  const bearishWords = ["crash", "dump", "plunge", "sell-off", "bearish", "hack", "exploit",
    "ban", "regulatory", "fine", "liquidation", "fear", "panic", "outflow", "whale sells",
    "decline", "drop", "correction", "recession", "bubble", "sec lawsuit"];

  let bullCount = 0, bearCount = 0;
  const signals: string[] = [];
  for (const w of bullishWords) { if (text.includes(w)) bullCount++; }
  for (const w of bearishWords) { if (text.includes(w)) bearCount++; }

  const net = bullCount - bearCount;
  let score = 50 + net * 8;
  score = Math.max(0, Math.min(100, score));

  let sentiment = "NEUTRAL";
  if (net >= 3) { sentiment = "VERY_BULLISH"; signals.push(`Strong bullish news (${bullCount} signals)`); }
  else if (net >= 1) { sentiment = "BULLISH"; signals.push("Bullish news"); }
  else if (net <= -3) { sentiment = "VERY_BEARISH"; signals.push(`Strong bearish news (${bearCount} signals)`); }
  else if (net <= -1) { sentiment = "BEARISH"; signals.push("Bearish news"); }
  else { signals.push("Neutral news"); }

  return { score, sentiment, bullCount, bearCount, signals };
}

// ─── TECHNICAL ANALYSIS (Multi-timeframe) ───────────────────────

function analyzeTechnical(price: {
  change5m: number; change1h: number; change24h: number;
  volume24h: number; liquidity: number;
}): { score: number; trend: string; signals: string[]; bounceDetected: boolean; breakoutDetected: boolean; overextended: boolean } {
  const signals: string[] = [];
  let score = 50;
  const { change5m: m5, change1h: h1, change24h: h24 } = price;

  // Multi-timeframe alignment (15min scalp: 5m is king)
  const upCount = [m5 > 0, h1 > 0, h24 > 0].filter(Boolean).length;
  if (upCount === 3) { score += 15; signals.push("All timeframes aligned UP ✅"); }
  else if (upCount === 0) { score -= 15; signals.push("All timeframes aligned DOWN ❌"); }

  // Trend from weighted average (5m heaviest for 15min scalp)
  const avgChange = (m5 * 6 + h1 * 2 + h24 * 0.3) / 8.3;
  let trend = "SIDEWAYS";
  if (avgChange > 3) { trend = "STRONG_UP"; score += 18; signals.push(`Strong uptrend avg=${avgChange.toFixed(1)}%`); }
  else if (avgChange > 0.5) { trend = "UP"; score += 10; signals.push("Uptrend"); }
  else if (avgChange < -3) { trend = "STRONG_DOWN"; score -= 18; signals.push(`Strong downtrend avg=${avgChange.toFixed(1)}%`); }
  else if (avgChange < -0.5) { trend = "DOWN"; score -= 10; signals.push("Downtrend"); }

  // 5-minute momentum (MOST CRITICAL for 15min scalping)
  if (m5 > 2) { score += 22; signals.push(`⚡ Explosive 5m: +${m5.toFixed(1)}%`); }
  else if (m5 > 0.5) { score += 12; signals.push(`Strong 5m push +${m5.toFixed(2)}%`); }
  else if (m5 < -2) { score -= 22; signals.push(`🔴 5m dump: ${m5.toFixed(1)}%`); }
  else if (m5 < -0.5) { score -= 12; signals.push(`Selling 5m ${m5.toFixed(2)}%`); }

  // 5m micro-momentum (even small moves matter in 15min)
  if (Math.abs(m5) < 0.3) { score -= 5; signals.push("⏸ Flat 5m — no momentum"); }

  // Bounce detection (dip→recovery in 15min window)
  const bounceDetected = h1 < -2 && m5 > 0.3;
  if (bounceDetected) { score += 15; signals.push("🔄 Bounce: 1h dip + 5m recovery"); }

  // Breakout detection (volume + price spike — 15min micro-breakout)
  const breakoutDetected = m5 > 1.5 && h1 > 0.5 && price.volume24h > 50_000_000;
  if (breakoutDetected) { score += 14; signals.push("🚀 Micro-breakout: 5m surge + volume"); }

  // Overextended (ran too far for 15min scalp — tighter thresholds)
  const overextended = m5 > 3.5 || h1 > 6 || (m5 > 2 && h1 > 4);
  if (overextended) { score -= 14; signals.push("⚠️ Overextended for 15min scalp — pullback risk"); }

  // Volume context
  if (price.volume24h > 100_000_000) { score += 5; signals.push("High volume"); }
  else if (price.volume24h < 10_000_000) { score -= 5; signals.push("Low volume"); }

  // Reversal patterns (for 15min: use 1h context, not just 24h)
  if (h1 < -3 && m5 > 0.8) { score += 12; signals.push("Reversal bounce from 1h oversold"); }
  if (h1 > 3 && m5 < -0.8) { score -= 12; signals.push("Reversal dump from 1h overbought"); }
  if (h24 < -8 && m5 > 1.0) { score += 8; signals.push("Deep 24h oversold + 5m recovery"); }

  return {
    score: Math.max(0, Math.min(100, score)),
    trend, signals, bounceDetected, breakoutDetected, overextended,
  };
}

// ─── LIQUIDITY FLOW ANALYSIS ────────────────────────────────────

function analyzeLiquidityFlow(price: {
  buyCount1h?: number; sellCount1h?: number;
  buyCount24h?: number; sellCount24h?: number;
  volume24h: number;
}): { score: number; pressure: string; signals: string[] } {
  const signals: string[] = [];
  let score = 50;

  const buys1h = price.buyCount1h || 0;
  const sells1h = price.sellCount1h || 0;
  const total1h = buys1h + sells1h;
  const buyRatio = total1h > 0 ? buys1h / total1h : 0.5;

  const buys24 = price.buyCount24h || 0;
  const sells24 = price.sellCount24h || 0;
  const total24 = buys24 + sells24;
  const buyRatio24 = total24 > 0 ? buys24 / total24 : 0.5;

  let pressure = "NEUTRAL";

  // 1h buy/sell pressure
  if (buyRatio > 0.65) {
    pressure = "STRONG_BUY"; score += 20;
    signals.push(`🟢 Strong buy pressure 1h: ${buys1h}B/${sells1h}S (${(buyRatio*100).toFixed(0)}%)`);
  } else if (buyRatio > 0.55) {
    pressure = "BUY"; score += 10;
    signals.push(`Buy pressure 1h: ${buys1h}B/${sells1h}S`);
  } else if (buyRatio < 0.35) {
    pressure = "STRONG_SELL"; score -= 20;
    signals.push(`🔴 Heavy selling 1h: ${sells1h}S vs ${buys1h}B`);
  } else if (buyRatio < 0.45) {
    pressure = "SELL"; score -= 10;
    signals.push(`Sell pressure 1h: ${sells1h}S vs ${buys1h}B`);
  }

  // 24h trend confirmation
  if (buyRatio24 > 0.55 && buyRatio > 0.55) {
    score += 8; signals.push("Sustained buying 24h+1h");
  } else if (buyRatio24 < 0.45 && buyRatio < 0.45) {
    score -= 8; signals.push("Sustained selling 24h+1h");
  }

  // Whale estimation (top 10% of transactions assumed "whale")
  if (total24 > 100) {
    const estimatedWhales = Math.round(total24 * 0.1);
    const whaleBuys = Math.round(buys24 * 0.1);
    const whaleSells = Math.round(sells24 * 0.1);
    if (whaleBuys > whaleSells + 2) {
      score += 10; signals.push(`🐋 Whale accumulation est: ${whaleBuys}B vs ${whaleSells}S`);
    } else if (whaleSells > whaleBuys + 2) {
      score -= 10; signals.push(`🐋 Whale distribution est: ${whaleSells}S vs ${whaleBuys}B`);
    }
  }

  return { score: Math.max(0, Math.min(100, score)), pressure, signals };
}

// ─── LLM SYNTHESIS (the "brain") ────────────────────────────────

async function llmSynthesizePerp(
  inference: InferenceClient,
  market: PerpMarketKey,
  priceUsd: number,
  technical: { score: number; trend: string; signals: string[] },
  flow: { score: number; pressure: string; signals: string[] },
  news: { score: number; sentiment: string; signals: string[]; headlines?: string[] },
): Promise<{
  recommendation: "STRONG_LONG" | "LONG" | "SHORT" | "STRONG_SHORT" | "SKIP";
  confidence: number;
  reasoning: string;
  keyFactors: string[];
} | null> {
  const today = new Date().toISOString().split("T")[0];
  const prompt = `You are an elite perpetual futures scalp trader. Today is ${today}.
Analyze ${market}-PERP for a 15-MINUTE SCALP trade. Decide: LONG, SHORT, or SKIP.
Timeframe: 15 minutes max hold. TP +1.5%, SL -1.0%. Only enter if momentum is CLEAR and IMMEDIATE.

PRICE: $${priceUsd.toFixed(2)}

═══ TECHNICAL (Score: ${technical.score}/100) ═══
Trend: ${technical.trend}
Signals: ${technical.signals.join("; ")}

═══ LIQUIDITY FLOW (Score: ${flow.score}/100) ═══
Pressure: ${flow.pressure}
Signals: ${flow.signals.join("; ")}

═══ NEWS SENTIMENT (Score: ${news.score}/100) ═══
Sentiment: ${news.sentiment}
Headlines:
${(news.headlines || []).slice(0, 5).map((h, i) => `${i+1}. ${h}`).join("\n") || "None"}
Signals: ${news.signals.join("; ")}

═══ DECISION RULES (15-MINUTE AGGRESSIVE SCALP) ═══
- This is a 15-MINUTE leveraged perp scalp (10x-25x). ASYMMETRIC R:R: TP +2.5%, SL -0.8%.
- R:R ratio is 3:1 — you only need to win 1 out of 3 trades to profit. BE AGGRESSIVE.
- Recommend LONG/SHORT if confidence ≥65%. The tight stop loss protects us.
- Look for ANY edge: momentum spike, news catalyst, volume surge, flow imbalance.
- The market doesn't need to be perfect. A SMALL edge with 3:1 R:R = TAKE THE TRADE.
- Only SKIP if the market is truly dead (no volume, flat, no catalyst).
- REMEMBER: Missing a trade = missing money = DEATH. Take every reasonable opportunity.

Respond ONLY in this JSON:
{"recommendation":"STRONG_LONG|LONG|SHORT|STRONG_SHORT|SKIP","confidence":0-100,"reasoning":"1-2 sentences","key_factors":["f1","f2","f3"]}`;

  try {
    const response = await inference.chat(
      [
        { role: "system", content: "You are an AGGRESSIVE 15-minute perpetual futures scalp trader. Output ONLY valid JSON. Our R:R is 3:1 (TP +2.5%, SL -0.8%) so we WANT trades. Recommend LONG/SHORT for any reasonable edge (≥65% confidence). Only SKIP if the market is truly dead. Missing trades = missing money." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.2, maxTokens: 300 },
    );

    const text = response.message.content?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const rec = String(parsed.recommendation || "SKIP").toUpperCase();
    const validRecs = ["STRONG_LONG", "LONG", "SHORT", "STRONG_SHORT", "SKIP"];

    return {
      recommendation: (validRecs.includes(rec) ? rec : "SKIP") as any,
      confidence: Math.max(10, Math.min(99, Number(parsed.confidence) || 50)),
      reasoning: String(parsed.reasoning || "No reasoning").slice(0, 400),
      keyFactors: Array.isArray(parsed.key_factors) ? parsed.key_factors.slice(0, 5).map(String) : [],
    };
  } catch (e: any) {
    console.warn(`[PERP-LLM] Synthesis failed: ${e.message}`);
    // Fallback: use sub-scores only
    const avg = (technical.score + flow.score + news.score) / 3;
    let rec: "LONG" | "SHORT" | "SKIP" = "SKIP";
    if (avg >= 68 && technical.trend.includes("UP")) rec = "LONG";
    else if (avg <= 32 && technical.trend.includes("DOWN")) rec = "SHORT";
    return {
      recommendation: rec,
      confidence: 30,
      reasoning: `LLM unavailable. Avg sub-score: ${avg.toFixed(0)}/100.`,
      keyFactors: ["LLM fallback — sub-scores only"],
    };
  }
}

// ─── ADVANCED TREND ANALYSIS ────────────────────────────────────

/**
 * Full multi-factor analysis for a perp market.
 * Combines: Technical (DexScreener multi-TF) + News (Google News) + Liquidity Flow + LLM synthesis.
 * Returns LONG/SHORT/NEUTRAL with high-confidence signal (only trades ≥80% confidence).
 */
export async function analyzeTrend(
  market: PerpMarketKey,
  inference?: InferenceClient | null,
): Promise<TrendSignal | null> {
  const price = await getMarketPrice(market);
  if (!price || price.priceUsd <= 0) return null;

  // ── 1. Technical Analysis ──
  const technical = analyzeTechnical(price);

  // ── 2. Liquidity Flow Analysis ──
  const flow = analyzeLiquidityFlow(price);

  // ── 3. News Sentiment Analysis ──
  const headlines = await fetchNewsForMarket(market);
  const news = analyzeNewsSentiment(headlines);

  // ── 4. LLM Synthesis (if inference client available) ──
  let llmResult: Awaited<ReturnType<typeof llmSynthesizePerp>> = null;
  if (inference) {
    llmResult = await llmSynthesizePerp(inference, market, price.priceUsd, technical, flow, { ...news, headlines });
    console.log(`[PERP-ANALYSIS] ${market} LLM: ${llmResult?.recommendation} (${llmResult?.confidence}%) — ${llmResult?.reasoning}`);
  }

  // ── 5. Composite Score ──
  const llmScore = llmResult
    ? (llmResult.recommendation === "STRONG_LONG" || llmResult.recommendation === "STRONG_SHORT" ? 90 :
       llmResult.recommendation === "LONG" || llmResult.recommendation === "SHORT" ? 72 :
       35) : 50;

  const composite = Math.round(
    technical.score * 0.30 +
    flow.score * 0.25 +
    news.score * 0.15 +
    llmScore * 0.30
  );

  // ── 6. Determine direction — AGGRESSIVE: lower thresholds, trust any edge ──
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let confidence = composite;

  if (llmResult && llmResult.confidence >= 55) {
    // LLM has an opinion — be aggressive, trust it with soft technical agreement
    if (llmResult.recommendation === "STRONG_LONG" || llmResult.recommendation === "LONG") {
      if (technical.score >= 48) { // Soft agreement: just not bearish
        direction = "LONG";
        confidence = Math.round((llmResult.confidence * 0.6) + (composite * 0.4));
      }
    } else if (llmResult.recommendation === "STRONG_SHORT" || llmResult.recommendation === "SHORT") {
      if (technical.score <= 52) { // Soft agreement: just not bullish
        direction = "SHORT";
        confidence = Math.round((llmResult.confidence * 0.6) + (composite * 0.4));
      }
    }
  }

  // Fallback: No LLM or LLM too weak — use technical + flow combo
  if (direction === "NEUTRAL") {
    if (technical.score >= 65 && flow.score >= 55) {
      direction = "LONG"; confidence = Math.round(composite * 0.9);
    } else if (technical.score <= 35 && flow.score <= 45) {
      direction = "SHORT"; confidence = Math.round(composite * 0.9);
    }
    // Extra fallback: strong 5m momentum alone (for micro-scalps)
    if (direction === "NEUTRAL") {
      const m5 = price.change5m;
      if (m5 > 1.5 && flow.score >= 50) {
        direction = "LONG"; confidence = Math.max(composite, 60);
      } else if (m5 < -1.5 && flow.score <= 50) {
        direction = "SHORT"; confidence = Math.max(composite, 60);
      }
    }
  }

  // ── 7. Build reasoning ──
  const allSignals = [
    `Tech(${technical.score}): ${technical.signals.slice(0, 3).join(", ")}`,
    `Flow(${flow.score}): ${flow.signals.slice(0, 2).join(", ")}`,
    `News(${news.score}): ${news.signals.slice(0, 2).join(", ")}`,
    ...(llmResult ? [`LLM: ${llmResult.recommendation} ${llmResult.confidence}% — ${llmResult.reasoning}`] : []),
  ];

  return {
    market,
    direction,
    confidence,
    price: price.priceUsd,
    change5m: price.change5m,
    change1h: price.change1h,
    change24h: price.change24h,
    volume24h: price.volume24h,
    reasoning: allSignals.join(" | "),
    technicalScore: technical.score,
    newsScore: news.score,
    liquidityFlowScore: flow.score,
    llmVerdict: llmResult?.recommendation,
    llmConfidence: llmResult?.confidence,
    headlines: headlines.slice(0, 5),
    keyFactors: llmResult?.keyFactors,
  };
}

/**
 * Scan ALL perp markets with full advanced analysis and find the best opportunity.
 * AGGRESSIVE: Lower threshold (65%) to catch more opportunities.
 * Returns up to 2 signals for simultaneous ETH+BTC positions.
 */
export async function scanBestOpportunity(inference?: InferenceClient | null): Promise<{
  best: TrendSignal | null;
  second: TrendSignal | null;
  all: TrendSignal[];
}> {
  const signals: TrendSignal[] = [];

  // Analyze all markets (sequential to avoid rate limiting on news APIs)
  for (const m of ALL_MARKETS) {
    const sig = await analyzeTrend(m, inference);
    if (sig) signals.push(sig);
  }

  // Sort by confidence (directional signals first)
  signals.sort((a, b) => {
    const aScore = a.direction !== "NEUTRAL" ? a.confidence : 0;
    const bScore = b.direction !== "NEUTRAL" ? b.confidence : 0;
    return bScore - aScore;
  });

  // AGGRESSIVE: 65% threshold to catch more opportunities (asymmetric R:R protects us)
  const qualifying = signals.filter(s => s.direction !== "NEUTRAL" && s.confidence >= 65);
  const best = qualifying[0] || null;
  const second = qualifying[1] || null;

  if (best) {
    console.log(`[PERP-SCAN] ✅ ALPHA: ${best.direction} ${best.market} @ $${best.price.toFixed(2)} | conf=${best.confidence}%${second ? ` + ${second.direction} ${second.market} ${second.confidence}%` : ""}`);
  } else {
    console.log(`[PERP-SCAN] No alpha — all signals below 65% threshold`);
  }

  return { best, second, all: signals };
}

/**
 * Calculate dynamic margin based on profits (AUTO-COMPOUND).
 * As capital grows, position sizes grow. Seize every opportunity.
 */
export function getCompoundedMargin(baseUsdc: number, db?: any): number {
  // Track cumulative PnL from DB
  let totalPnl = 0;
  try {
    const positions = JSON.parse(db?.getKV?.("perp_positions") || "[]");
    totalPnl = positions
      .filter((p: any) => p.status === "closed" && p.closePnlUsd)
      .reduce((sum: number, p: any) => sum + (p.closePnlUsd || 0), 0);
  } catch {}

  // Base margin: use more capital as we profit
  const availableCapital = baseUsdc;
  const profitBonus = totalPnl > 0 ? totalPnl * SCALP_CONFIG.compoundPct : 0;
  const baseMargin = availableCapital * 0.85; // Use 85% of available

  // Scale margin: minimum $0.30, compound profits, cap at maxMargin
  let margin = Math.max(SCALP_CONFIG.minMargin, baseMargin + profitBonus);
  margin = Math.min(margin, SCALP_CONFIG.maxMargin);
  margin = Math.min(margin, availableCapital * 0.95); // Never use >95% of balance

  return Math.round(margin * 100) / 100;
}

/**
 * Check if a position should be closed (TP/SL/timeout/trailing stop).
 * AGGRESSIVE: trailing stop locks in profits, tight SL protects capital.
 */
export async function checkPositionTPSL(
  position: PerpPosition,
): Promise<{ shouldClose: boolean; reason: string; currentPrice: number; pnlPct: number } | null> {
  const price = await getMarketPrice(position.market);
  if (!price) return null;

  const currentPrice = price.priceUsd;
  const pnlPct = position.side === "LONG"
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * position.leverage
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100 * position.leverage;

  // Take profit
  if (position.side === "LONG" && currentPrice >= position.tpPrice) {
    return { shouldClose: true, reason: "take_profit", currentPrice, pnlPct };
  }
  if (position.side === "SHORT" && currentPrice <= position.tpPrice) {
    return { shouldClose: true, reason: "take_profit", currentPrice, pnlPct };
  }

  // Stop loss
  if (position.side === "LONG" && currentPrice <= position.slPrice) {
    return { shouldClose: true, reason: "stop_loss", currentPrice, pnlPct };
  }
  if (position.side === "SHORT" && currentPrice >= position.slPrice) {
    return { shouldClose: true, reason: "stop_loss", currentPrice, pnlPct };
  }

  // Timeout (15 minutes max — strict scalping timeframe)
  const holdMs = Date.now() - new Date(position.openTime).getTime();
  if (holdMs > SCALP_CONFIG.maxHoldMs) {
    return { shouldClose: true, reason: "timeout_15min", currentPrice, pnlPct };
  }

  // TRAILING STOP: If we're in significant profit (+1.2% leveraged), lock it in
  // If price retraces from peak while in profit, close to keep gains
  if (pnlPct >= SCALP_CONFIG.trailingStopPct * position.leverage) {
    // We're well in profit — check if momentum is fading
    const m5 = price.change5m;
    const fadingLong = position.side === "LONG" && m5 < -0.15;
    const fadingShort = position.side === "SHORT" && m5 > 0.15;
    if (fadingLong || fadingShort) {
      return { shouldClose: true, reason: "trailing_stop_profit_lock", currentPrice, pnlPct };
    }
  }

  // BREAKEVEN STOP: After 8 minutes, if barely profitable, take what we can
  if (holdMs > 8 * 60 * 1000 && pnlPct > 0.3 && pnlPct < SCALP_CONFIG.trailingStopPct * position.leverage) {
    return { shouldClose: true, reason: "breakeven_stop_8min", currentPrice, pnlPct };
  }

  // Strong trend reversal
  const trend = await analyzeTrend(position.market);
  if (trend) {
    if (position.side === "LONG" && trend.direction === "SHORT" && trend.confidence >= 75) {
      return { shouldClose: true, reason: "trend_reversal", currentPrice, pnlPct };
    }
    if (position.side === "SHORT" && trend.direction === "LONG" && trend.confidence >= 75) {
      return { shouldClose: true, reason: "trend_reversal", currentPrice, pnlPct };
    }
  }

  return { shouldClose: false, reason: "hold", currentPrice, pnlPct };
}

/**
 * Verify Synthetix V3 Perps contract is responsive.
 * Call indexPrice(100) for ETH — if it returns a price, the contract works.
 */
export async function verifyPerpContracts(): Promise<{
  ok: boolean;
  ethPrice?: number;
  error?: string;
}> {
  try {
    const price = await getOraclePrice("ETH");
    if (price && price > 0) {
      return { ok: true, ethPrice: price };
    }
    return { ok: false, error: "indexPrice returned 0 or null" };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
