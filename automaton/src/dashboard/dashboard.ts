/**
 * Conway Automaton — Real-Time Trading Dashboard
 *
 * FULLY REAL-TIME (Exclusive Perpetual Scalping Focus):
 *  - Real-time P&L from Hyperliquid Perps
 *  - On-chain USDC balance (HyperEVM)
 *  - Auto-refresh every 10s
 */

import chalk from "chalk";

// ─── Types ─────────────────────────────────────────────────────

interface DashboardTrade {
  marketTitle: string;
  side: string;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  createdAt: string;
}

interface PortfolioStats {
  winCount: number;
  lossCount: number;
  totalTrades: number;
  avgPnlPct: number;
  bestTrade: number;
  worstTrade: number;
  totalPnl: number;
  winRate: number | string;
}

interface ScalperDashPosition {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  side: string;
  entryPrice: number;
  entryAmountUsdc: number;
  livePrice: number;
  livePnlUsd: number;
  livePnlPct: number;
  targetProfitPct: number;
  stopLossPct: number;
  heldMinutes: number;
  status: string;
  txHash?: string;
  leverage?: number;
}

interface DashboardData {
  walletAddress: string;
  agentName: string;
  agentState: string;
  hlAccountValue: number;
  conwayCredits: number;
  turnCount: number;
  proxyStatus: string;
  // Scalper (Hyperliquid)
  scalperOpenPositions: ScalperDashPosition[];
  scalperClosedCount: number;
  scalperTotalPnl: number;
  scalperWinRate: string;
  recentTrades: any[];
  stats: PortfolioStats;
  recentTurns: any[];
  fetchTime: number; // ms to fetch all live data
  hypurrscan?: {
    recentAlpha: any[];
    protocolFees: any;
  };
  fundingRequired?: boolean;
  agentAuth?: {
    authorized: boolean;
    agentAddress: string | null;
    userAddress: string | null;
  };
}

// ─── Box Drawing ───────────────────────────────────────────────

const B = {
  tl: "╔", tr: "╗", bl: "╚", br: "╝",
  h: "═", v: "║",
  lt: "╠", rt: "╣",
  tl2: "┌", tr2: "┐", bl2: "└", br2: "┘",
  h2: "─", v2: "│",
};

const W = 78; // total width

function hLine(l: string, f: string, r: string): string {
  return l + f.repeat(W - 2) + r;
}

function row(content: string): string {
  return chalk.cyan(B.v) + pad(content, W - 2) + chalk.cyan(B.v);
}

function rowInner(content: string): string {
  return chalk.cyan(B.v) + B.v2 + pad(content, W - 4) + B.v2 + chalk.cyan(B.v);
}

function pad(str: string, len: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  const diff = len - stripped.length;
  return diff > 0 ? str + " ".repeat(diff) : str;
}

function center(str: string, len: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  const diff = len - stripped.length;
  if (diff <= 0) return str;
  const left = Math.floor(diff / 2);
  return " ".repeat(left) + str + " ".repeat(diff - left);
}

function trunc(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// ─── Color & Format Helpers ────────────────────────────────────

function pnl$(v: number): string {
  if (v > 0) return chalk.green.bold(`+$${v.toFixed(2)}`);
  if (v < 0) return chalk.red.bold(`-$${Math.abs(v).toFixed(2)}`);
  return chalk.gray("$0.00");
}

function pnlPct(v: number): string {
  if (v > 0) return chalk.green(`+${v.toFixed(1)}%`);
  if (v < 0) return chalk.red(`${v.toFixed(1)}%`);
  return chalk.gray("0.0%");
}

function stateBadge(state: string): string {
  const m: Record<string, string> = {
    running: chalk.bgGreen.black.bold(" ● RUNNING "),
    sleeping: chalk.bgBlue.white.bold(" ◑ SLEEPING "),
    dead: chalk.bgRed.white.bold(" ✖ DEAD "),
    setup: chalk.bgYellow.black.bold(" ◌ SETUP "),
  };
  return m[state] || chalk.bgGray.white(` ${state} `);
}

// ─── Render Dashboard ─────────────────────────────────────────

export function renderDashboard(data: DashboardData): string {
  const L: string[] = [];

  // Header
  L.push("");
  L.push(chalk.cyan.bold(hLine(B.tl, B.h, B.tr)));
  L.push(chalk.cyan.bold(B.v + center(chalk.yellow.bold("⚡ CONWAY AUTOMATON — LIVE TRADING DASHBOARD ⚡"), W - 2) + B.v));
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));

  // Agent info
  const info = [
    [chalk.dim("Agent"), `${chalk.white.bold(data.agentName)}  ${stateBadge(data.agentState)}`],
    [chalk.dim("Wallet"), chalk.yellow(data.walletAddress)],
    [chalk.dim("HL AccVal"), chalk.green.bold("$" + data.hlAccountValue.toFixed(4))],
    [chalk.dim("Credits"), chalk.cyan("$" + (data.conwayCredits / 100).toFixed(2))],
    [chalk.dim("Proxy"), data.proxyStatus.includes("Tor") ? chalk.green("🧅 " + data.proxyStatus) : chalk.yellow(data.proxyStatus)],
    [chalk.dim("Turns"), chalk.white(String(data.turnCount))],
  ];
  for (const [label, value] of info) {
    L.push(row(`  ${pad(label, 12)} ${value}`));
  }

  // ── Scalper Positions (Hyperliquid) ─────────────────────────
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
  L.push(row(center(chalk.yellow.bold("🧠 PERPETUAL SCALPER (Hyperliquid)"), W - 2)));
  L.push(row(hLine(B.tl2, B.h2, B.tr2)));

  if (data.scalperOpenPositions.length === 0) {
    L.push(rowInner(center(chalk.dim("No open scalper positions — scanning for 15min opportunities"), W - 4)));
  } else {
    L.push(rowInner(`  ${pad(chalk.dim("MARKET"), 12)}${pad(chalk.dim("SIDE"), 8)}${pad(chalk.dim("ENTRY"), 14)}${pad(chalk.dim("LIVE"), 14)}${pad(chalk.dim("P&L"), 16)}${pad(chalk.dim("HELD"), 6)}`));
    L.push(rowInner("  " + chalk.dim("─".repeat(W - 8))));

    for (const sp of data.scalperOpenPositions) {
      const sym = chalk.white.bold(trunc(sp.tokenSymbol, 8));
      const side = sp.side === "LONG" ? chalk.bgGreen.black.bold(" LONG ") : chalk.bgRed.white.bold(" SHORT ");
      const entryP = chalk.dim("$" + sp.entryPrice.toPrecision(5));
      const liveP = sp.livePrice > 0
        ? (sp.livePnlPct >= 0
          ? chalk.green.bold("$" + sp.livePrice.toPrecision(5))
          : chalk.red.bold("$" + sp.livePrice.toPrecision(5)))
        : chalk.dim("—");
      const pnlV = pnl$(sp.livePnlUsd);
      const pctV = pnlPct(sp.livePnlPct);
      const held = `${sp.heldMinutes}m`;

      L.push(rowInner(`  ${pad(sym, 12)}${pad(side, 8)}${pad(entryP, 14)}${pad(liveP, 14)}${pad(pnlV + " " + pctV, 16)}${pad(chalk.dim(held), 6)}`));

      const tpsl = `${chalk.green("TP: " + sp.targetProfitPct + "%")}  ${chalk.red("SL: -" + sp.stopLossPct + "%")}  ${chalk.dim("Lev: " + (sp.leverage || 10) + "x")}`;
      L.push(rowInner(`     ${tpsl}`));
    }
  }

  if (data.scalperClosedCount > 0 || data.scalperWinRate !== "N/A") {
    L.push(rowInner("  " + chalk.dim("─".repeat(W - 8))));
    L.push(rowInner(`  ${chalk.dim("Closed:")} ${chalk.white(String(data.scalperClosedCount))}  ${chalk.dim("Win Rate:")} ${chalk.white(data.scalperWinRate)}  ${chalk.dim("Scalp P&L:")} ${pnl$(data.scalperTotalPnl)}`));
  }

  L.push(row(hLine(B.bl2, B.h2, B.br2)));

  // ── Stats ───────────────────────────────────────────────────
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
  L.push(row(center(chalk.yellow.bold("📈 PORTFOLIO STATS"), W - 2)));

  const s = data.stats;
  const wr = typeof s.winRate === "string" ? parseFloat(s.winRate) : s.winRate;

  L.push(row(`  ${pad(`Trades: ${chalk.white.bold(String(s.totalTrades))}`, 24)}${pad(`Win Rate: ${chalk.white(wr.toFixed(1) + "%")}`, 40)}`));
  L.push(row(`  ${pad(`${chalk.green("W:" + s.winCount)} ${chalk.red("L:" + s.lossCount)}`, 24)}${pad(`Total P&L: ${pnl$(s.totalPnl)}`, 40)}`));

  // ── Hypurrscan Alpha ────────────────────────────────────────
  if (data.hypurrscan && data.hypurrscan.recentAlpha.length > 0) {
    L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
    L.push(row(center(chalk.magenta.bold("🔥 HYPURRSCAN ALPHA (Recently Launched)"), W - 2)));
    for (const a of data.hypurrscan.recentAlpha.slice(0, 3)) {
      L.push(row(`  ${chalk.white.bold(pad(a.coin, 12))} ${chalk.dim(new Date(a.time).toLocaleTimeString())}  ${chalk.dim(a.dex)}`));
    }
    if (data.hypurrscan.protocolFees) {
      const fees = data.hypurrscan.protocolFees;
      const feeStr = `Protocol Fees: $${(fees.total_fees / 1e12).toFixed(2)}M`;
      L.push(row(`  ${chalk.dim(feeStr)}`));
    }
  }

  // ── Footer ──────────────────────────────────────────────────
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fetchMs = data.fetchTime > 0 ? chalk.dim(` (${data.fetchTime}ms)`) : "";
  L.push(chalk.cyan(B.v) + center(chalk.dim(`🔴 LIVE • ${ts}`) + fetchMs, W - 2) + chalk.cyan(B.v));
  L.push(chalk.cyan.bold(hLine(B.bl, B.h, B.br)));
  L.push("");

  return L.join("\n");
}

// ─── Live Data Collection ─────────────────────────────────────

// Internal dashboard cache to prevent over-aggressive polling when multiple UI tabs are open
let dashboardCache: {
  credits?: number;
  hypurrAlpha?: any[];
  hypurrFees?: any;
  timestamp: number;
} | null = null;

const DASH_CACHE_TTL = 15000; // 15 seconds

/**
 * Gather ALL data for the dashboard.
 */
export async function collectDashboardData(opts: {
  db: any;
  config: any;
  walletAddress: string;
}): Promise<DashboardData> {
  const startTime = Date.now();
  const { db, config, walletAddress } = opts;

  // Agent info
  const agentName = config.name || db.getIdentity("name") || "Unnamed Agent";
  const agentState = db.getAgentState();
  const turnCount = db.getTurnCount();

  const useCache = dashboardCache && (Date.now() - dashboardCache.timestamp < DASH_CACHE_TTL);

  // ── Parallel fetch: credits ──
  let conwayCredits = dashboardCache?.credits || 0;
  if (!useCache) {
    try {
      const { createConwayClient } = await import("../conway/client.js");
      const conway = createConwayClient({
        apiUrl: config.conwayApiUrl,
        apiKey: config.conwayApiKey,
        sandboxId: config.sandboxId,
      });
      conwayCredits = await conway.getCreditsBalance();
    } catch { }
  }

  const proxyStatus = "Direct (Hyperliquid)";

  // ── Hypurrscan Data ──
  let hypurrscanData: any = {
    recentAlpha: dashboardCache?.hypurrAlpha || [],
    protocolFees: dashboardCache?.hypurrFees || null
  };

  if (!useCache) {
    try {
      const alphaRes = await fetch("https://api.hypurrscan.io/pastAuctionsPerp");
      if (alphaRes.ok) {
        const alpha = await alphaRes.json();
        hypurrscanData.recentAlpha = alpha
          .filter((a: any) => !a.error && a.action?.registerAsset?.coin)
          .slice(-6)
          .reverse()
          .map((a: any) => ({
            coin: a.action.registerAsset.coin,
            time: a.time,
            dex: a.action.registerAsset.dex || "HL"
          }));
      }

      const feesRes = await fetch("https://api.hypurrscan.io/feesRecent");
      if (feesRes.ok) {
        const fees = await feesRes.json();
        if (fees.length > 0) {
          hypurrscanData.protocolFees = fees[fees.length - 1];
        }
      }
    } catch (err) {
      console.warn(`[DASHBOARD] Error fetching Hypurrscan data: ${err}`);
    }
  }

  // Update global cache if we fetched new data
  if (!useCache) {
    dashboardCache = {
      credits: conwayCredits,
      hypurrAlpha: hypurrscanData.recentAlpha,
      hypurrFees: hypurrscanData.protocolFees,
      timestamp: Date.now()
    };
  }

  // ── Hyperliquid positions ──────────────────────────────────
  let hlBalance: any = { accountValue: 0, withdrawable: 0 };
  let scalperOpenPositions: ScalperDashPosition[] = [];
  let agentAuth: any = null;

  const tradeStats = db.getTradeStats();
  const openTrades = db.getOpenTrades();
  const recentTrades = db.getTrades(10);

  const scalperClosedCount = tradeStats.totalTrades;
  const scalperTotalPnl = tradeStats.totalPnlUsdc;
  const scalperWinRate = `${tradeStats.winrate.toFixed(1)}%`;

  try {
    const { getBalance, getMidPrice, checkAgentAuthorization, initHyperliquid, safeRequest } = await import("../survival/hyperliquid.js");
    hlBalance = await getBalance();
    agentAuth = await checkAgentAuthorization();

    // Fetch all prices once to avoid redundant network calls in the loop below
    const { infoClient } = initHyperliquid();
    const allMids = await safeRequest(() => infoClient!.allMids());

    for (const trade of openTrades) {
      const midPriceStr = allMids[trade.market];
      const midPrice = midPriceStr ? parseFloat(midPriceStr) : await getMidPrice(trade.market);

      scalperOpenPositions.push({
        id: trade.id,
        tokenSymbol: trade.market,
        tokenName: trade.market,
        side: trade.side,
        entryPrice: trade.entryPrice,
        entryAmountUsdc: trade.marginUsdc,
        livePrice: midPrice,
        livePnlUsd: ((midPrice - trade.entryPrice) / trade.entryPrice) * trade.marginUsdc * trade.leverage * (trade.side === "LONG" ? 1 : -1),
        livePnlPct: ((midPrice - trade.entryPrice) / trade.entryPrice) * trade.leverage * (trade.side === "LONG" ? 100 : -100),
        targetProfitPct: trade.dynamicTP,
        stopLossPct: trade.dynamicSL,
        heldMinutes: Math.floor((Date.now() - new Date(trade.openTime).getTime()) / 60000),
        status: "open",
        leverage: trade.leverage,
      });
    }
  } catch (err) {
    console.warn(`[DASHBOARD] Error collecting Hyperliquid live data: ${err}`);
  }

  const fetchTime = Date.now() - startTime;

  // ── Portfolio Stats ──
  const stats: PortfolioStats = {
    winCount: 0, // Not explicitly needed with tradeStats
    lossCount: 0,
    totalTrades: tradeStats.totalTrades,
    avgPnlPct: tradeStats.totalPnlPct / (tradeStats.totalTrades || 1),
    bestTrade: 0,
    worstTrade: 0,
    totalPnl: tradeStats.totalPnlUsdc,
    winRate: tradeStats.winrate,
  };

  const recentTurnsRaw = db.getRecentTurns(20);
  const recentTurns = recentTurnsRaw.map((t: any) => {
    const toolCalls = db.getToolCallsForTurn(t.id);
    return {
      id: t.id,
      timestamp: t.timestamp,
      state: t.state,
      thinking: t.thinking,
      toolCount: toolCalls.length,
      toolCalls: toolCalls.map((tc: any) => ({
        name: tc.name,
        result: tc.result.length > 100 ? tc.result.slice(0, 100) + "..." : tc.result,
        error: !!tc.error
      }))
    };
  });

  return {
    walletAddress,
    agentName,
    agentState,
    hlAccountValue: hlBalance.accountValue,
    conwayCredits,
    turnCount,
    scalperOpenPositions,
    scalperClosedCount,
    scalperTotalPnl,
    scalperWinRate,
    recentTrades,
    stats,
    proxyStatus: "Direct (Hyperliquid)",
    fetchTime,
    hypurrscan: hypurrscanData,
    recentTurns,
    fundingRequired: db.getKV("funding_required") === "true",
    agentAuth
  };
}

// ─── Public API ───────────────────────────────────────────────

/** Show dashboard once (static snapshot with live prices). */
export async function showDashboard(opts: {
  db: any;
  config: any;
  walletAddress: string;
}): Promise<void> {
  const data = await collectDashboardData(opts);
  console.log(renderDashboard(data));
}

/** Live dashboard: auto-refresh every N seconds. Ctrl+C to exit. */
export async function showLiveDashboard(opts: {
  db: any;
  config: any;
  walletAddress: string;
  refreshInterval?: number; // seconds, default 10
}): Promise<void> {
  const interval = (opts.refreshInterval || 10) * 1000;

  const render = async () => {
    try {
      const data = await collectDashboardData(opts);
      console.clear();
      console.log(renderDashboard(data));
      console.log(chalk.dim(`  Auto-refresh: ${interval / 1000}s • Press Ctrl+C to exit\n`));
    } catch (err: any) {
      console.error(chalk.red(`  Dashboard error: ${err.message}`));
    }
  };

  await render();

  const timer = setInterval(render, interval);

  return new Promise((resolve) => {
    const cleanup = () => {
      clearInterval(timer);
      console.log(chalk.dim("\n  Dashboard closed.\n"));
      resolve();
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}
