/**
 * Conway Automaton — Real-Time Trading Dashboard
 *
 * FULLY REAL-TIME:
 *  - Live midpoint prices from Polymarket CLOB API
 *  - Real-time P&L computed from live price vs entry
 *  - On-chain USDC.e balance (Polygon)
 *  - Countdown timers to market resolution
 *  - Auto-refresh every 10s
 */

import chalk from "chalk";

// ─── Types ─────────────────────────────────────────────────────

interface LivePosition {
  id: string;
  marketId: string;
  marketTitle: string;
  side: string;
  entryPrice: number;
  entryAmount: number;
  entryTime: string;
  shares: number;
  // Live data (fetched in real-time)
  livePrice: number;
  livePnlUsd: number;
  livePnlPct: number;
  priceChange: number; // vs entry
  // Targets
  targetExitPrice: number | null;
  stopLossPrice: number | null;
  // Market info
  deadline: string | null;
  deadlineCountdown: string;
  marketClosed: boolean;
  // Token IDs for price fetching
  yesTokenId: string | null;
  noTokenId: string | null;
  status: string;
  closeReason: string | null;
  closedAt: string | null;
}

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
}

interface DashboardData {
  walletAddress: string;
  agentName: string;
  agentState: string;
  usdcBalance: number;
  baseUsdcBalance: number;
  polBalance: number;
  conwayCredits: number;
  openPositions: LivePosition[];
  closedPositions: LivePosition[];
  recentTrades: DashboardTrade[];
  stats: PortfolioStats;
  turnCount: number;
  proxyStatus: string;
  totalLiveValue: number;
  totalUnrealizedPnl: number;
  // Scalper (Base chain)
  scalperOpenPositions: ScalperDashPosition[];
  scalperClosedCount: number;
  scalperTotalPnl: number;
  scalperWinRate: string;
  fetchTime: number; // ms to fetch all live data
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

function priceArrow(change: number): string {
  if (change > 0.005) return chalk.green("▲");
  if (change < -0.005) return chalk.red("▼");
  return chalk.gray("─");
}

function sideTag(side: string): string {
  return side === "YES"
    ? chalk.bgGreen.black.bold(" YES ")
    : chalk.bgRed.white.bold(" NO  ");
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

function timeAgo(dateStr: string): string {
  try {
    const then = new Date(dateStr + (dateStr.includes("Z") ? "" : "Z")).getTime();
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ago`;
    if (h > 0) return `${h}h ${m % 60}m ago`;
    if (m > 0) return `${m}m ago`;
    return "just now";
  } catch { return dateStr; }
}

function countdown(deadlineStr: string | null): string {
  if (!deadlineStr) return chalk.dim("unknown");
  try {
    const end = new Date(deadlineStr).getTime();
    const diff = end - Date.now();
    if (diff <= 0) return chalk.red.bold("ENDED");
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (d > 0) return chalk.yellow(`${d}d ${h}h ${m}m`);
    if (h > 0) return chalk.yellow(`${h}h ${m}m`);
    return chalk.red.bold(`${m}m`);
  } catch { return chalk.dim("?"); }
}

function bar(pct: number, w: number): string {
  const f = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return chalk.green("█".repeat(f)) + chalk.gray("░".repeat(w - f));
}

function sparkline(entry: number, live: number, target: number | null, stop: number | null): string {
  const lo = Math.min(entry, live, stop || entry, target || entry) - 0.02;
  const hi = Math.max(entry, live, stop || entry, target || entry) + 0.02;
  const range = hi - lo || 0.1;
  const width = 20;
  const pos = (v: number) => Math.max(0, Math.min(width - 1, Math.round(((v - lo) / range) * (width - 1))));

  const chars: string[] = Array(width).fill(chalk.dim("·"));
  if (stop) chars[pos(stop)] = chalk.red("S");
  chars[pos(entry)] = chalk.white("E");
  if (target) chars[pos(target)] = chalk.green("T");
  // Live on top
  const livePos = pos(live);
  if (live >= entry) {
    chars[livePos] = chalk.green.bold("●");
  } else {
    chars[livePos] = chalk.red.bold("●");
  }
  return chars.join("");
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
    [chalk.dim("Polygon"), `${chalk.green.bold("$" + data.usdcBalance.toFixed(4))} USDC.e  ${chalk.dim("|")}  ${chalk.magenta(data.polBalance.toFixed(4) + " POL")}`],
    [chalk.dim("Base"), `${chalk.green.bold("$" + data.baseUsdcBalance.toFixed(4))} USDC  ${chalk.dim("|")}  ${chalk.cyan("Scalper: " + data.scalperOpenPositions.length + " open")}`],
    [chalk.dim("Credits"), chalk.cyan("$" + (data.conwayCredits / 100).toFixed(2))],
    [chalk.dim("Proxy"), data.proxyStatus.includes("Tor") ? chalk.green("🧅 " + data.proxyStatus) : chalk.yellow(data.proxyStatus)],
    [chalk.dim("Turns"), chalk.white(String(data.turnCount))],
  ];
  for (const [label, value] of info) {
    L.push(row(`  ${pad(label, 10)} ${value}`));
  }

  // Portfolio Value (combined)
  const hasPositions = data.openPositions.length > 0 || data.scalperOpenPositions.length > 0;
  if (hasPositions) {
    L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
    const scalperVal = data.scalperOpenPositions.reduce((s, p) => s + p.entryAmountUsdc + p.livePnlUsd, 0);
    const totalVal = chalk.cyan.bold("$" + (data.totalLiveValue + scalperVal).toFixed(2));
    const combinedPnl = data.totalUnrealizedPnl + data.scalperTotalPnl;
    const totalPnl = pnl$(combinedPnl);
    const polyVal = chalk.dim(`Poly: $${data.totalLiveValue.toFixed(2)}`);
    const baseVal = chalk.dim(`Base: $${scalperVal.toFixed(2)}`);
    L.push(row(`  ${chalk.dim("Portfolio")}  Live: ${totalVal}  ${chalk.dim("|")}  P&L: ${totalPnl}  ${chalk.dim("|")}  ${polyVal}  ${baseVal}`));
  }

  // ── Open Positions ──────────────────────────────────────────
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
  L.push(row(center(chalk.yellow.bold("📊 OPEN POSITIONS (LIVE)"), W - 2)));
  L.push(row(hLine(B.tl2, B.h2, B.tr2)));

  if (data.openPositions.length === 0) {
    L.push(rowInner(center(chalk.dim("No open positions — waiting for next scan cycle"), W - 4)));
  } else {
    for (let i = 0; i < data.openPositions.length; i++) {
      const p = data.openPositions[i];
      const num = chalk.white.bold(String(i + 1));
      const title = chalk.white(trunc(p.marketTitle, 50));

      // Row 1: Market title + side
      L.push(rowInner(`  ${num}. ${title}  ${sideTag(p.side)}`));

      // Row 2: Live price with arrow, entry, P&L
      const arrow = priceArrow(p.priceChange);
      const liveP = p.livePrice > 0
        ? (p.livePrice >= p.entryPrice
          ? chalk.green.bold("$" + p.livePrice.toFixed(4))
          : chalk.red.bold("$" + p.livePrice.toFixed(4)))
        : chalk.dim("fetching…");
      const entryP = chalk.dim("$" + p.entryPrice.toFixed(4));
      const pnlStr = pnl$(p.livePnlUsd);
      const pctStr = pnlPct(p.livePnlPct);

      L.push(rowInner(`     ${chalk.dim("Price:")} ${arrow} ${liveP} ${chalk.dim("(entry:")} ${entryP}${chalk.dim(")")}  ${chalk.dim("P&L:")} ${pnlStr} ${pctStr}`));

      // Row 3: Amount, shares, sparkline
      const amt = chalk.cyan("$" + p.entryAmount.toFixed(2));
      const shares = chalk.white(p.shares.toFixed(0) + " shares");
      const spark = sparkline(p.entryPrice, p.livePrice || p.entryPrice, p.targetExitPrice, p.stopLossPrice);
      L.push(rowInner(`     ${chalk.dim("Cost:")} ${amt} ${chalk.dim("(")}${shares}${chalk.dim(")")}  ${spark}`));

      // Row 4: Target, stop, time remaining
      const tgt = p.targetExitPrice ? chalk.green("$" + p.targetExitPrice.toFixed(4)) : chalk.dim("—");
      const stp = p.stopLossPrice ? chalk.red("$" + p.stopLossPrice.toFixed(4)) : chalk.dim("—");
      const cdwn = p.deadlineCountdown;
      const held = chalk.dim(timeAgo(p.entryTime));

      L.push(rowInner(`     ${chalk.dim("Target:")} ${tgt}  ${chalk.dim("Stop:")} ${stp}  ${chalk.dim("Ends:")} ${cdwn}  ${chalk.dim("Held:")} ${held}`));

      if (i < data.openPositions.length - 1) {
        L.push(rowInner("  " + chalk.dim("─".repeat(W - 8))));
      }
    }
  }

  L.push(row(hLine(B.bl2, B.h2, B.br2)));

  // ── Closed Trades ───────────────────────────────────────────
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
  L.push(row(center(chalk.yellow.bold("📜 TRADE HISTORY"), W - 2)));
  L.push(row(hLine(B.tl2, B.h2, B.tr2)));

  if (data.closedPositions.length === 0 && data.recentTrades.length === 0) {
    L.push(rowInner(center(chalk.dim("No completed trades yet"), W - 4)));
  } else {
    const closedToShow = data.closedPositions.slice(0, 5);
    L.push(rowInner(`  ${pad(chalk.dim("MARKET"), 34)}${pad(chalk.dim("SIDE"), 7)}${pad(chalk.dim("P&L"), 14)}${pad(chalk.dim("RESULT"), 12)}${pad(chalk.dim("WHEN"), 8)}`));
    L.push(rowInner("  " + chalk.dim("─".repeat(W - 8))));

    for (const p of closedToShow) {
      const title = trunc(p.marketTitle, 32);
      const side = sideTag(p.side);
      const pnlV = pnl$(p.livePnlUsd);
      const reason = p.closeReason ? chalk.dim(p.closeReason.replace("_", " ")) : chalk.dim("—");
      const when = p.closedAt ? chalk.dim(timeAgo(p.closedAt)) : chalk.dim("—");

      L.push(rowInner(`  ${pad(title, 34)}${pad(side, 7)}${pad(pnlV, 14)}${pad(reason, 12)}${pad(when, 8)}`));
    }
  }

  L.push(row(hLine(B.bl2, B.h2, B.br2)));

  // ── Scalper Positions (Base Chain) ──────────────────────────
  L.push(chalk.cyan.bold(hLine(B.lt, B.h, B.rt)));
  L.push(row(center(chalk.yellow.bold("🧠 SMART SCALPER (Base Chain)"), W - 2)));
  L.push(row(hLine(B.tl2, B.h2, B.tr2)));

  if (data.scalperOpenPositions.length === 0) {
    L.push(rowInner(center(chalk.dim("No open scalper positions — scalp_scan uses AI analysis"), W - 4)));
  } else {
    L.push(rowInner(`  ${pad(chalk.dim("TOKEN"), 12)}${pad(chalk.dim("ENTRY"), 14)}${pad(chalk.dim("LIVE"), 14)}${pad(chalk.dim("P&L"), 16)}${pad(chalk.dim("TP/SL"), 12)}${pad(chalk.dim("HELD"), 6)}`));
    L.push(rowInner("  " + chalk.dim("─".repeat(W - 8))));

    for (const sp of data.scalperOpenPositions) {
      const sym = chalk.white.bold(trunc(sp.tokenSymbol, 8));
      const entryP = chalk.dim("$" + sp.entryPrice.toPrecision(4));
      const liveP = sp.livePrice > 0
        ? (sp.livePnlPct >= 0
          ? chalk.green.bold("$" + sp.livePrice.toPrecision(4))
          : chalk.red.bold("$" + sp.livePrice.toPrecision(4)))
        : chalk.dim("—");
      const pnlV = pnl$(sp.livePnlUsd);
      const pctV = pnlPct(sp.livePnlPct);
      const tpsl = `${chalk.green("+" + sp.targetProfitPct + "%")}/${chalk.red("-" + sp.stopLossPct + "%")}`;
      const held = sp.heldMinutes < 60 ? `${sp.heldMinutes}m` : `${Math.floor(sp.heldMinutes / 60)}h${sp.heldMinutes % 60}m`;

      L.push(rowInner(`  ${pad(sym, 12)}${pad(entryP, 14)}${pad(liveP, 14)}${pad(pnlV + " " + pctV, 16)}${pad(tpsl, 12)}${pad(chalk.dim(held), 6)}`));

      // Show smart analysis summary if available
      const smartInfo = (sp as any).smartAnalysis;
      if (smartInfo) {
        const scores = [
          `T:${chalk.cyan(smartInfo.technical)}`,
          `F:${chalk.magenta(smartInfo.fundamental)}`,
          `L:${chalk.blue(smartInfo.liquidityFlow)}`,
          `N:${chalk.yellow(smartInfo.news)}`,
        ].join(" ");
        L.push(rowInner(`  ${chalk.dim("  AI:")} ${scores} ${chalk.dim("LLM:")} ${chalk.white(smartInfo.llmConfidence + "%")} ${chalk.dim("Score:")} ${chalk.white.bold(smartInfo.compositeScore)}`));
      }
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

  L.push(row(`  ${pad(`Trades: ${chalk.white.bold(String(s.totalTrades))}`, 24)}${pad(`Win Rate: ${bar(wr, 15)} ${chalk.white(wr.toFixed(1) + "%")}`, 40)}`));
  L.push(row(`  ${pad(`${chalk.green("W:" + s.winCount)} ${chalk.red("L:" + s.lossCount)}`, 24)}${pad(`Total P&L: ${pnl$(s.totalPnl)}`, 40)}`));
  L.push(row(`  ${pad(`Best: ${chalk.green("$" + s.bestTrade.toFixed(2))}`, 24)}${pad(`Worst: ${chalk.red("$" + s.worstTrade.toFixed(2))}`, 40)}`));

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

/**
 * Fetch live midpoint price for a position from Polymarket CLOB.
 * Falls back to Gamma API price if CLOB fails.
 */
async function fetchLivePrice(pos: {
  side: string;
  yesTokenId: string | null;
  noTokenId: string | null;
  marketId: string;
  entryPrice: number;
}): Promise<{ price: number; closed: boolean }> {
  const tokenId = pos.side === "YES" ? pos.yesTokenId : pos.noTokenId;

  // Try CLOB midpoint first (fastest, most accurate)
  if (tokenId) {
    try {
      const { getMidpoint } = await import("../survival/polymarket-client.js");
      const mid = await getMidpoint(tokenId);
      if (mid > 0 && mid < 1) return { price: mid, closed: false };
    } catch {}
  }

  // Fallback: Gamma API for current market price
  try {
    const { fetchMarketById } = await import("../survival/polymarket-client.js");
    const market = await fetchMarketById(pos.marketId);
    if (market) {
      const price = pos.side === "YES" ? market.yesPrice : market.noPrice;
      return { price, closed: market.closed };
    }
  } catch {}

  // Last resort: use entry price
  return { price: pos.entryPrice, closed: false };
}

/**
 * Gather ALL data for the dashboard, including live prices for each open position.
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

  // ── Parallel fetch: balance + positions + credits + proxy ──
  const [balanceResult, polResult, creditResult, proxyResult] = await Promise.allSettled([
    // USDC.e balance
    (async () => {
      const { getUsdcBalance } = await import("../conway/x402.js");
      return getUsdcBalance(walletAddress as `0x${string}`, "eip155:137");
    })(),
    // POL balance
    (async () => {
      const resp = await fetch("https://polygon-bor-rpc.publicnode.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getBalance",
          params: [walletAddress, "latest"],
          id: 1,
        }),
      });
      const json = (await resp.json()) as any;
      return json.result ? parseInt(json.result, 16) / 1e18 : 0;
    })(),
    // Conway credits
    (async () => {
      const { createConwayClient } = await import("../conway/client.js");
      const conway = createConwayClient({
        apiUrl: config.conwayApiUrl,
        apiKey: config.conwayApiKey,
        sandboxId: config.sandboxId,
      });
      return conway.getCreditsBalance();
    })(),
    // Proxy status
    (async () => {
      const { getActiveProxy } = await import("../survival/polymarket-client.js");
      const proxy = getActiveProxy();
      if (proxy && proxy.includes("9050")) return "Tor SOCKS5 (EU exit nodes)";
      if (proxy) return proxy;
      return "Direct (no proxy)";
    })(),
  ]);

  const usdcBalance = balanceResult.status === "fulfilled" ? balanceResult.value : 0;
  const polBalance = polResult.status === "fulfilled" ? polResult.value : 0;
  const conwayCredits = creditResult.status === "fulfilled" ? creditResult.value : 0;
  const proxyStatus = proxyResult.status === "fulfilled" ? proxyResult.value : "Unknown";

  // ── Get positions: PRIMARY source = Polymarket Data API (on-chain truth) ──
  // Fall back to DB if API fails
  let dbOpenPositions = db.getPMPositions("open") as any[];
  const dbClosedPositions = db.getPMPositions("closed") as any[];
  const recentTrades = db.getPMTradeHistory(5) as DashboardTrade[];
  const stats = db.getPMPortfolioStats() as PortfolioStats;

  // Try to sync with on-chain positions
  let chainPositions: any[] = [];
  try {
    const { getUserPositions } = await import("../survival/polymarket-client.js");
    chainPositions = await getUserPositions(walletAddress);
  } catch {}

  // If we got chain data, use it as ground truth for live prices + reconcile ghost positions
  const chainAssetSet = new Set(chainPositions.map((cp: any) => cp.asset));

  // Remove DB positions that don't exist on-chain (ghost positions from failed bets)
  if (chainPositions.length > 0 || dbOpenPositions.length > 0) {
    for (const dbPos of dbOpenPositions) {
      const tokenId = dbPos.side === "YES" ? dbPos.yesTokenId : dbPos.noTokenId;
      if (tokenId && !chainAssetSet.has(tokenId) && chainPositions.length > 0) {
        // Ghost position — exists in DB but not on-chain. Close it.
        try {
          db.closePMPosition(dbPos.id, 0, 0, "timeout", -dbPos.entryAmount, -100);
          console.log(`[SYNC] Closed ghost position: ${dbPos.marketTitle} (not on-chain)`);
        } catch {}
      }
    }
    // Refresh after cleanup
    dbOpenPositions = db.getPMPositions("open") as any[];
  }

  // Build enriched open positions using chain data where available
  let totalLiveValue = 0;
  let totalUnrealizedPnl = 0;

  const openPositions: LivePosition[] = dbOpenPositions.map((p: any) => {
    const tokenId = p.side === "YES" ? p.yesTokenId : p.noTokenId;
    // Find matching chain position for ground truth
    const chainPos = chainPositions.find((cp: any) => cp.asset === tokenId);

    let livePrice = p.entryPrice;
    let marketClosed = false;
    let shares = p.shares || (p.entryAmount > 0 && p.entryPrice > 0 ? p.entryAmount / p.entryPrice : 0);

    if (chainPos) {
      // USE ON-CHAIN DATA as ground truth
      livePrice = chainPos.curPrice || p.entryPrice;
      shares = chainPos.size || shares;
      // Update DB with on-chain truth (fire & forget)
      try {
        // Sync entry price and shares from chain if significantly different
        if (Math.abs(chainPos.avgPrice - p.entryPrice) > 0.001) {
          // entry price mismatch — chain is authoritative
        }
      } catch {}
    } else {
      // No chain data — try CLOB midpoint
      // (done in parallel below for non-chain positions)
    }

    const currentValue = shares * livePrice;
    const entryValue = chainPos ? chainPos.initialValue : p.entryAmount;
    const pnlUsd = chainPos ? chainPos.cashPnl : (currentValue - p.entryAmount);
    const pnlPctVal = chainPos ? chainPos.percentPnl : (p.entryAmount > 0 ? (pnlUsd / p.entryAmount) * 100 : 0);
    const priceChange = livePrice - p.entryPrice;

    totalLiveValue += currentValue;
    totalUnrealizedPnl += pnlUsd;

    return {
      id: p.id,
      marketId: p.marketId,
      marketTitle: chainPos?.title || p.marketTitle,
      side: p.side,
      entryPrice: chainPos?.avgPrice || p.entryPrice,
      entryAmount: chainPos?.initialValue || p.entryAmount,
      entryTime: p.entryTime,
      shares,
      livePrice,
      livePnlUsd: pnlUsd,
      livePnlPct: pnlPctVal,
      priceChange,
      targetExitPrice: p.targetExitPrice,
      stopLossPrice: p.stopLossPrice,
      deadline: chainPos?.endDate || p.deadline,
      deadlineCountdown: countdown(chainPos?.endDate || p.deadline),
      marketClosed,
      yesTokenId: p.yesTokenId,
      noTokenId: p.noTokenId,
      status: p.status,
      closeReason: p.closeReason,
      closedAt: p.closedAt,
    };
  });

  // For positions WITHOUT chain data, fetch live prices via CLOB
  const needsPriceFetch = openPositions.filter((p, i) => {
    const tokenId = p.side === "YES" ? p.yesTokenId : p.noTokenId;
    return !chainPositions.find((cp: any) => cp.asset === tokenId);
  });
  if (needsPriceFetch.length > 0) {
    const pricePromises = needsPriceFetch.map((p: any) =>
      fetchLivePrice({
        side: p.side,
        yesTokenId: p.yesTokenId,
        noTokenId: p.noTokenId,
        marketId: p.marketId,
        entryPrice: p.entryPrice,
      })
    );
    const prices = await Promise.allSettled(pricePromises);
    needsPriceFetch.forEach((p, i) => {
      const result = prices[i];
      if (result.status === "fulfilled" && result.value.price > 0) {
        p.livePrice = result.value.price;
        p.marketClosed = result.value.closed;
        p.livePnlUsd = p.shares * p.livePrice - p.entryAmount;
        p.livePnlPct = p.entryAmount > 0 ? (p.livePnlUsd / p.entryAmount) * 100 : 0;
        p.priceChange = p.livePrice - p.entryPrice;
      }
    });
    // Recalculate totals
    totalLiveValue = openPositions.reduce((sum, p) => sum + p.shares * p.livePrice, 0);
    totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + p.livePnlUsd, 0);
  }

  const closedPositions: LivePosition[] = dbClosedPositions.map((p: any) => ({
    id: p.id,
    marketId: p.marketId,
    marketTitle: p.marketTitle,
    side: p.side,
    entryPrice: p.entryPrice,
    entryAmount: p.entryAmount,
    entryTime: p.entryTime,
    shares: p.shares || (p.entryAmount / p.entryPrice),
    livePrice: p.currentPrice || p.entryPrice,
    livePnlUsd: p.pnlUsd ?? 0,
    livePnlPct: p.pnlPct ?? 0,
    priceChange: 0,
    targetExitPrice: p.targetExitPrice,
    stopLossPrice: p.stopLossPrice,
    deadline: p.deadline,
    deadlineCountdown: countdown(p.deadline),
    marketClosed: true,
    yesTokenId: p.yesTokenId,
    noTokenId: p.noTokenId,
    status: p.status,
    closeReason: p.closeReason,
    closedAt: p.closedAt,
  }));

  const fetchTime = Date.now() - startTime;

  // ── Scalper positions (Base chain) ──────────────────────────
  let baseUsdcBalance = 0;
  let scalperOpenPositions: ScalperDashPosition[] = [];
  let scalperClosedCount = 0;
  let scalperTotalPnl = 0;
  let scalperWinRate = "N/A";

  try {
    const { getBaseUsdcBalance } = await import("../survival/perpetual.js");
    baseUsdcBalance = await getBaseUsdcBalance(walletAddress as `0x${string}`);
  } catch {}

  try {
    const allScalp = JSON.parse(db.getKV?.("perp_positions") || "[]");
    const openScalp = allScalp.filter((p: any) => p.status === "open");
    const closedScalp = allScalp.filter((p: any) => p.status !== "open");
    scalperClosedCount = closedScalp.length;

    // Get live prices for open perpetual positions
    const { getOraclePrice } = await import("../survival/perpetual.js");
    for (const sp of openScalp) {
      let livePrice = sp.entryPrice;
      let livePnlUsd = 0;
      let livePnlPct = 0;
      try {
        const market = sp.market || "ETH";
        const oraclePrice = await getOraclePrice(market);
        if (oraclePrice && oraclePrice > 0) {
          livePrice = oraclePrice;
          const direction = sp.direction === "SHORT" ? -1 : 1;
          livePnlPct = direction * ((livePrice - sp.entryPrice) / sp.entryPrice) * 100;
          livePnlUsd = (livePnlPct / 100) * (sp.marginUsdc || sp.entryAmountUsdc || 0) * (sp.leverage || 10);
        }
      } catch {}

      scalperTotalPnl += livePnlUsd;
      scalperOpenPositions.push({
        id: sp.id,
        tokenSymbol: sp.tokenSymbol || "???",
        tokenName: sp.tokenName || "Unknown",
        side: "LONG",
        entryPrice: sp.entryPrice,
        entryAmountUsdc: sp.entryAmountUsdc || 0,
        livePrice,
        livePnlUsd,
        livePnlPct,
        targetProfitPct: sp.targetProfitPct || 5,
        stopLossPct: sp.stopLossPct || 4,
        heldMinutes: Math.floor((Date.now() - new Date(sp.entryTime).getTime()) / 60000),
        status: sp.status,
        txHash: sp.txHash,
      });
    }

    // Add closed PnL
    for (const cp of closedScalp) {
      scalperTotalPnl += (cp.closePnlUsd || 0);
    }

    if (closedScalp.length > 0) {
      const wins = closedScalp.filter((p: any) => (p.closePnlUsd || 0) > 0).length;
      scalperWinRate = `${((wins / closedScalp.length) * 100).toFixed(0)}%`;
    }
  } catch {}

  return {
    walletAddress,
    agentName,
    agentState,
    usdcBalance,
    baseUsdcBalance,
    polBalance,
    conwayCredits,
    openPositions,
    closedPositions,
    recentTrades,
    stats,
    turnCount,
    proxyStatus,
    totalLiveValue,
    totalUnrealizedPnl,
    scalperOpenPositions,
    scalperClosedCount,
    scalperTotalPnl,
    scalperWinRate,
    fetchTime,
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
