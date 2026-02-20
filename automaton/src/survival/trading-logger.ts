/**
 * Polymarket Trading Monitoring & Logging
 *
 * Comprehensive logging, metrics tracking, and performance monitoring
 * for Polymarket trading bot.
 */

import type { AutomatonDatabase } from "../types.js";
import fs from "fs";
import path from "path";

export interface TradeMetrics {
  timestamp: string;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRatePct: number;
  totalPnlUsd: number;
  avgPnlPct: number;
  bestTrade: number;
  worstTrade: number;
  openPositions: number;
  dailyPnlUsd: number;
  creditsCents: number;
  usdcBalance: number;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error" | "success";
  category: string; // "trade", "weather", "edge", "error", "market", "portfolio"
  message: string;
  data?: Record<string, unknown>;
}

class TradingLogger {
  private logFile: string;
  private metricsFile: string;
  private logs: LogEntry[] = [];
  private maxLogsInMemory = 10000;

  constructor(logDir: string = "~/.automaton") {
    const expandedDir = logDir.replace("~", process.env.HOME || "");
    this.logFile = path.join(expandedDir, "logs", `pm-trading-${new Date().toISOString().split("T")[0]}.log`);
    this.metricsFile = path.join(expandedDir, "metrics", `pm-metrics-${new Date().toISOString().split("T")[0]}.jsonl`);

    // Ensure directories exist
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    fs.mkdirSync(path.dirname(this.metricsFile), { recursive: true });
  }

  /**
   * Log a trading event
   */
  log(
    level: "debug" | "info" | "warn" | "error" | "success",
    category: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogsInMemory) {
      this.logs = this.logs.slice(-this.maxLogsInMemory);
    }

    // Write to file
    const logLine = JSON.stringify(entry);
    try {
      fs.appendFileSync(this.logFile, logLine + "\n");
    } catch (err) {
      console.error("Failed to write log file:", err);
    }

    // Console output with colors
    this.consolLog(entry);
  }

  /**
   * Log specific trading events
   */
  logMarketScanned(count: number, weather?: boolean): void {
    this.log(
      "info",
      "market",
      `Scanned ${count} Polymarket markets${weather ? " with weather data" : ""}`,
      { marketsScanned: count, withWeather: weather },
    );
  }

  logWeatherFetched(location: string, temp: number, rainChance: number, source: string): void {
    this.log("success", "weather", `Fetched weather for ${location}`, {
      location,
      temperature: temp,
      rainChance: rainChance * 100,
      source,
    });
  }

  logEdgeCalculated(
    market: string,
    edgePct: number,
    recommendation: string,
    betPlaced: boolean,
  ): void {
    const level = edgePct >= 0.15 ? "success" : edgePct >= 0.08 ? "info" : "debug";
    this.log(level, "edge", `Edge ${(edgePct * 100).toFixed(1)}% on ${market}: ${recommendation}`, {
      market,
      edge: edgePct * 100,
      recommendation,
      betPlaced,
    });
  }

  logBetPlaced(
    market: string,
    side: "YES" | "NO",
    size: number,
    price: number,
    target: number,
    stoploss: number,
  ): void {
    this.log("success", "trade", `BET PLACED: ${side} on "${market}"`, {
      market,
      side,
      sizeUsd: size,
      entryPrice: price,
      targetExit: target,
      stopLoss: stoploss,
      potentialGain: ((target / price - 1) * 100).toFixed(1),
    });
  }

  logBetClosed(
    market: string,
    side: string,
    pnlUsd: number,
    pnlPct: number,
    reason: string,
    holdMinutes: number,
  ): void {
    const isWin = pnlUsd > 0;
    this.log(
      isWin ? "success" : "warn",
      "trade",
      `BET CLOSED: ${side} ${isWin ? "WIN" : "LOSS"} ${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(1)}%)`,
      {
        market,
        side,
        pnl: pnlUsd,
        pnlPct,
        reason,
        holdMinutes,
      },
    );
  }

  logPortfolioSnapshot(metrics: TradeMetrics): void {
    const message =
      `Portfolio: $${metrics.totalPnlUsd.toFixed(2)} | ` +
      `Win Rate: ${metrics.winRatePct.toFixed(1)}% | ` +
      `Open: ${metrics.openPositions} | ` +
      `Credits: $${(metrics.creditsCents / 100).toFixed(2)}`;

    this.log("info", "portfolio", message, metrics as unknown as Record<string, unknown>);
  }

  logError(category: string, message: string, error?: Error): void {
    this.log("error", category, message, { error: error?.message });
  }

  logRiskViolation(violation: string, details: Record<string, unknown>): void {
    this.log("warn", "risk", `RISK ALERT: ${violation}`, details);
  }

  /**
   * Record trade metrics snapshot
   */
  recordMetrics(metrics: TradeMetrics): void {
    const line = JSON.stringify(metrics);
    try {
      fs.appendFileSync(this.metricsFile, line + "\n");
    } catch (err) {
      console.error("Failed to write metrics file:", err);
    }
  }

  /**
   * Get recent logs
   */
  getRecentLogs(limit: number = 100, category?: string): LogEntry[] {
    let filtered = this.logs;
    if (category) {
      filtered = filtered.filter((l) => l.category === category);
    }
    return filtered.slice(-limit);
  }

  /**
   * Generate summary report
   */
  generateReport(db: AutomatonDatabase): string {
    const stats = db.getPMPortfolioStats();
    const recent = db.getPMTradeHistory(10);
    const edges = db.getPMEdgeAnalysis(24);

    let report = `
╔════════════════════════════════════════════════════════════════╗
║          POLYMARKET TRADING PERFORMANCE REPORT                 ║
║                     ${new Date().toISOString().split("T")[0]}                                   ║
╚════════════════════════════════════════════════════════════════╝

📊 LIFETIME STATISTICS:
  Total Trades: ${stats.totalTrades}
  Win/Loss: ${stats.winCount}W / ${stats.lossCount}L
  Win Rate: ${typeof stats.winRate === "string" ? stats.winRate : `${stats.winRate}%`}
  Total P&L: $${stats.totalPnl.toFixed(2)}
  Avg P&L: ${stats.avgPnlPct.toFixed(2)}%
  Best Trade: $${stats.bestTrade.toFixed(2)}
  Worst Trade: $${stats.worstTrade.toFixed(2)}

📈 RECENT TRADES (Last 10):
`;

    recent.forEach((t, i) => {
      const sign = t.pnlUsd >= 0 ? "+" : "";
      report += `  ${i + 1}. ${t.side} ${t.marketTitle}: ${sign}$${t.pnlUsd.toFixed(2)} (${t.pnlPct.toFixed(1)}%) via ${t.reason}\n`;
    });

    report += `
🎯 EDGE ANALYSIS (Last 24 Hours):
`;

    edges.forEach((e) => {
      report += `  ${e.recommendation}: ${e.totalOpportunities} opportunities, ${e.betsMade} bets placed (${(e.edgePct * 100).toFixed(1)}% avg edge)\n`;
    });

    report += `
📋 RECENT LOGS:
`;

    this.getRecentLogs(5).forEach((l) => {
      report += `  [${l.timestamp}] ${l.level.toUpperCase()} | ${l.category} | ${l.message}\n`;
    });

    report += `
═══════════════════════════════════════════════════════════════════\n`;

    return report;
  }

  /**
   * Output logs with visual formatting
   */
  private consolLog(entry: LogEntry): void {
    const colors: Record<string, string> = {
      debug: "\x1b[90m", // gray
      info: "\x1b[36m", // cyan
      warn: "\x1b[33m", // yellow
      error: "\x1b[31m", // red
      success: "\x1b[32m", // green
    };

    const reset = "\x1b[0m";
    const color = colors[entry.level] || reset;
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    const dataStr = entry.data ? ` | ${JSON.stringify(entry.data).slice(0, 80)}` : "";

    console.log(`${color}[${timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${dataStr}${reset}`);
  }
}

/**
 * Metrics collector for aggregated stats
 */
export class MetricsCollector {
  private logger: TradingLogger;
  private startTime = Date.now();
  private lastMetricsSnapshot = 0;

  constructor(logDir?: string) {
    this.logger = new TradingLogger(logDir);
  }

  /**
   * Collect current metrics from database
   */
  async collectMetrics(
    db: AutomatonDatabase,
    creditsCents: number,
    usdcBalance: number,
  ): Promise<TradeMetrics> {
    const stats = db.getPMPortfolioStats();
    const positions = db.getPMPositions("open");

    // Calculate daily P&L (from today's trades)
    const today = new Date().toISOString().split("T")[0];
    const allTrades = db.getPMTradeHistory(1000);
    const todayTrades = allTrades.filter((t) => t.createdAt.includes(today));
    const dailyPnl = todayTrades.reduce((sum, t) => sum + t.pnlUsd, 0);

    const metrics: TradeMetrics = {
      timestamp: new Date().toISOString(),
      totalTrades: stats.totalTrades,
      winCount: stats.winCount,
      lossCount: stats.lossCount,
      winRatePct: typeof stats.winRate === "string" ? parseFloat(stats.winRate) : stats.winRate,
      totalPnlUsd: stats.totalPnl,
      avgPnlPct: stats.avgPnlPct,
      bestTrade: stats.bestTrade,
      worstTrade: stats.worstTrade,
      openPositions: positions.length,
      dailyPnlUsd: dailyPnl,
      creditsCents,
      usdcBalance,
    };

    return metrics;
  }

  /**
   * Get logger instance
   */
  getLogger(): TradingLogger {
    return this.logger;
  }

  /**
   * Get uptime
   */
  getUptime(): { seconds: number; formatted: string } {
    const seconds = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    return {
      seconds,
      formatted: `${hours}h ${minutes}m ${secs}s`,
    };
  }
}

export { TradingLogger };
