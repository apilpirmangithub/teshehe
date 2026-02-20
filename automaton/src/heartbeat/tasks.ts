/**
 * Built-in Heartbeat Tasks
 *
 * These tasks run on the heartbeat schedule even while the agent sleeps.
 * They can trigger the agent to wake up if needed.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  SocialClientInterface,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";

export interface HeartbeatTaskContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  social?: SocialClientInterface;
}

export type HeartbeatTaskFn = (
  ctx: HeartbeatTaskContext,
) => Promise<{ shouldWake: boolean; message?: string }>;

/**
 * Registry of built-in heartbeat tasks.
 */
export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (ctx) => {
    const credits = await ctx.conway.getCreditsBalance();
    const state = ctx.db.getAgentState();
    const startTime =
      ctx.db.getKV("start_time") || new Date().toISOString();
    const uptimeMs = Date.now() - new Date(startTime).getTime();

    const tier = getSurvivalTier(credits);

    const payload = {
      name: ctx.config.name,
      address: ctx.identity.address,
      state,
      creditsCents: credits,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: ctx.config.version,
      sandboxId: ctx.identity.sandboxId,
      timestamp: new Date().toISOString(),
      tier,
    };

    ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));

    // If critical or dead, record a distress signal
    if (tier === "critical" || tier === "dead") {
      const distressPayload = {
        level: tier,
        name: ctx.config.name,
        address: ctx.identity.address,
        creditsCents: credits,
        fundingHint:
          "Use credit transfer API from a creator runtime to top this wallet up.",
        timestamp: new Date().toISOString(),
      };
      ctx.db.setKV("last_distress", JSON.stringify(distressPayload));

      return {
        shouldWake: true,
        message: `Distress: ${tier}. Credits: $${(credits / 100).toFixed(2)}. Need funding.`,
      };
    }

    return { shouldWake: false };
  },

  check_credits: async (ctx) => {
    const credits = await ctx.conway.getCreditsBalance();
    const tier = getSurvivalTier(credits);

    ctx.db.setKV("last_credit_check", JSON.stringify({
      credits,
      tier,
      timestamp: new Date().toISOString(),
    }));

    // Wake the agent if credits dropped to a new tier
    const prevTier = ctx.db.getKV("prev_credit_tier");
    ctx.db.setKV("prev_credit_tier", tier);

    if (prevTier && prevTier !== tier && (tier === "critical" || tier === "dead")) {
      return {
        shouldWake: true,
        message: `Credits dropped to ${tier} tier: $${(credits / 100).toFixed(2)}`,
      };
    }

    return { shouldWake: false };
  },

  check_usdc_balance: async (ctx) => {
    let balanceBase = 0;
    let balancePolygon = 0;
    try { balanceBase = await getUsdcBalance(ctx.identity.address, "eip155:8453"); } catch {}
    try { balancePolygon = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
    const totalBalance = balanceBase + balancePolygon;

    ctx.db.setKV("last_usdc_check", JSON.stringify({
      balanceBase,
      balancePolygon,
      total: totalBalance,
      timestamp: new Date().toISOString(),
    }));

    // Only wake if TOTAL USDC across all chains is very low (< $0.10)
    // Having low Base but healthy Polygon is NORMAL — Polygon is for Polymarket trading
    const credits = await ctx.conway.getCreditsBalance();
    if (totalBalance < 0.10 && credits < 500) {
      return {
        shouldWake: true,
        message: `⚠️ TOTAL USDC critically low: $${totalBalance.toFixed(4)} (Base: ${balanceBase.toFixed(4)} + Polygon: ${balancePolygon.toFixed(4)}). Credits: $${(credits / 100).toFixed(2)}. Need funding.`,
      };
    }

    // Log balance but don't wake — having USDC on Polygon is perfectly fine
    return { shouldWake: false };
  },

  check_social_inbox: async (ctx) => {
    if (!ctx.social) return { shouldWake: false };

    const cursor = ctx.db.getKV("social_inbox_cursor") || undefined;
    const { messages, nextCursor } = await ctx.social.poll(cursor);

    if (messages.length === 0) return { shouldWake: false };

    // Persist to inbox_messages table for deduplication
    let newCount = 0;
    for (const msg of messages) {
      const existing = ctx.db.getKV(`inbox_seen_${msg.id}`);
      if (!existing) {
        ctx.db.insertInboxMessage(msg);
        ctx.db.setKV(`inbox_seen_${msg.id}`, "1");
        newCount++;
      }
    }

    if (nextCursor) ctx.db.setKV("social_inbox_cursor", nextCursor);

    if (newCount === 0) return { shouldWake: false };

    return {
      shouldWake: true,
      message: `${newCount} new message(s) from: ${messages.map((m) => m.from.slice(0, 10)).join(", ")}`,
    };
  },

  check_for_updates: async (ctx) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      ctx.db.setKV("upstream_status", JSON.stringify({
        ...upstream,
        ...repo,
        checkedAt: new Date().toISOString(),
      }));
      if (upstream.behind > 0) {
        return {
          shouldWake: true,
          message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick what you want with pull_upstream.`,
        };
      }
      return { shouldWake: false };
    } catch (err: any) {
      // Not a git repo or no remote — silently skip
      ctx.db.setKV("upstream_status", JSON.stringify({
        error: err.message,
        checkedAt: new Date().toISOString(),
      }));
      return { shouldWake: false };
    }
  },

  health_check: async (ctx) => {
    // Check that the sandbox is healthy
    try {
      const result = await ctx.conway.exec("echo alive", 5000);
      if (result.exitCode !== 0) {
        return {
          shouldWake: true,
          message: "Health check failed: sandbox exec returned non-zero",
        };
      }
    } catch (err: any) {
      return {
        shouldWake: true,
        message: `Health check failed: ${err.message}`,
      };
    }

    ctx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },

  scout_aerodrome: async (ctx) => {
    // DEPRECATED - Replaced by Polymarket
    return { shouldWake: false };
  },

  execute_trades: async (ctx) => {
    // DEPRECATED - Replaced by Polymarket
    return { shouldWake: false };
  },

  scan_polymarket: async (ctx) => {
    // Only wake agent to scan if not already recently scanned (avoid constant waking)
    const lastScan = ctx.db.getKV("last_pm_scan_time");
    const lastScanTime = lastScan ? new Date(lastScan).getTime() : 0;
    const minutesSinceLastScan = (Date.now() - lastScanTime) / 60_000;

    // Only wake every 10 minutes for active trading
    if (minutesSinceLastScan < 10) {
      return { shouldWake: false };
    }

    // NOTE: Do NOT set last_pm_scan_time here — only pm_scan_markets tool sets it
    // after the actual scan runs and populates the market cache
    return {
      shouldWake: true,
      message: "Scan Polymarket: pm_scan_markets → pm_calculate_edge → pm_place_bet. Edge threshold: 3%. Be bold with forecasts!",
    };
  },

  check_pm_positions: async (ctx) => {
    // Only wake if there are actually open positions to monitor
    const lastPositions = ctx.db.getKV("pm_open_positions_count");
    const posCount = lastPositions ? parseInt(lastPositions, 10) : 0;

    if (posCount > 0) {
      return {
        shouldWake: true,
        message: `Monitor ${posCount} open position(s). Use ss_monitor or pm_positions. Exit: TP +6-9%, SL -3%, or time decay > 4h.`,
      };
    }
    return { shouldWake: false };
  },

  enforce_daily_stop: async (ctx) => {
    // Only wake for daily stop check if agent has traded today
    const lastTradeCheck = ctx.db.getKV("pm_trades_today");
    const tradesToday = lastTradeCheck ? parseInt(lastTradeCheck, 10) : 0;

    if (tradesToday > 0) {
      return {
        shouldWake: true,
        message: `Daily risk check: ${tradesToday} trade(s) today. Use ss_status to verify daily loss < -6% limit. If hit: STOP trading.`,
      };
    }
    return { shouldWake: false };
  },

};
