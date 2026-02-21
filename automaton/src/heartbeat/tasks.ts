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

    // Wake every 3 minutes for aggressive trading (hustle mode)
    if (minutesSinceLastScan < 3) {
      return { shouldWake: false };
    }

    // ── SMART ROUTING: Check BOTH chains, pick BEST opportunity ──
    let polygonBal = -1;
    let baseBal = -1;
    try {
      const { getUsdcBalance } = await import("../conway/x402.js");
      const walletAddr = ctx.db.getKV("wallet_address") || ctx.db.getIdentity?.("address") || "";
      if (walletAddr) {
        const addr = walletAddr as `0x${string}`;
        [polygonBal, baseBal] = await Promise.all([
          getUsdcBalance(addr, "eip155:137").catch(() => -1),
          getUsdcBalance(addr, "eip155:8453").catch(() => -1),
        ]);
      }
    } catch {}

    // Count open positions on each chain
    let pmOpenCount = 0;
    let scalpOpenCount = 0;
    let perpOpen = false;
    try { pmOpenCount = parseInt(ctx.db.getKV("pm_open_positions_count") || "0", 10); } catch {}
    try {
      const pp = JSON.parse(ctx.db.getKV("perp_positions") || "[]");
      scalpOpenCount = pp.filter((p: any) => p.status === "open" || p.status === "pending").length;
      perpOpen = scalpOpenCount > 0;
    } catch {}

    const polymarketReady = polygonBal >= 0.50;
    const scalpReady = baseBal >= 0.10 || perpOpen; // perp position open = must manage
    const lastType = ctx.db.getKV("last_scan_type") || "";

    // ── Decision matrix: SCALP now includes leveraged ETH + altcoins ──
    let choice: "polymarket" | "scalp" = "scalp";
    let reason = "";

    if (!polymarketReady && !scalpReady) {
      choice = "scalp";
      reason = `⚠️ All chains low (Polygon $${polygonBal >= 0 ? polygonBal.toFixed(2) : "?"}, Base $${baseBal >= 0 ? baseBal.toFixed(2) : "?"}). Trying scalp_scan for micro opportunity.`;
    } else if (!polymarketReady && scalpReady) {
      choice = "scalp";
      reason = `💰 Polygon low → Base $${baseBal >= 0 ? baseBal.toFixed(2) : "?"} perp scalping${perpOpen ? " (⚡ perp position open!)" : ""}.`;
    } else if (polymarketReady && !scalpReady) {
      choice = "polymarket";
      reason = `💰 Base too low → Polygon $${polygonBal >= 0 ? polygonBal.toFixed(2) : "?"} Polymarket.`;
    } else {
      // ALL ready — score each strategy
      const pmScore =
        (polygonBal >= 0 ? Math.min(polygonBal, 3) : 0) * 1.0 +
        Math.max(0, 3 - pmOpenCount) * 0.5 +
        (lastType === "scalp" ? 1.5 : 0);

      const scScore =
        (baseBal >= 0 ? Math.min(baseBal, 5) : 0) * 1.0 +
        Math.max(0, 2 - scalpOpenCount) * 0.8 +
        (perpOpen ? 3.0 : 0) +                                    // must check open perp position!
        (lastType === "polymarket" || lastType === "" ? 1.5 : 0);

      // If leverage position is open, ALWAYS go to scalp (scalp_scan manages leverage)
      if (perpOpen) {
        choice = "scalp";
        reason = `🔒 Open perp position → must monitor via scalp_scan. Sc ${scScore.toFixed(1)} vs PM ${pmScore.toFixed(1)}`;
      } else if (pmScore >= scScore) {
        choice = "polymarket";
        reason = `🧠 Smart pick: PM ${pmScore.toFixed(1)} vs Sc ${scScore.toFixed(1)} (Polygon $${polygonBal.toFixed(2)}/${pmOpenCount} pos)`;
      } else {
        choice = "scalp";
        reason = `🧠 Smart pick: Sc ${scScore.toFixed(1)} vs PM ${pmScore.toFixed(1)} (Base $${baseBal.toFixed(2)}/${scalpOpenCount} pos)`;
      }
    }

    console.log(`[HEARTBEAT] ${reason} → ${choice}`);

    // Store the decision so tools can enforce it if LLM disobeys
    try { ctx.db.setKV("next_best_opportunity", choice); } catch {}

    const toolMap = {
      polymarket: `⚡ BEST OPPORTUNITY → POLYMARKET: ${reason}. Call pm_scan_markets({"fast_resolving": true}). Then sleep 2min.`,
      scalp: `🔥 BEST OPPORTUNITY → SCALP: ${reason}. Call scalp_scan(). Then sleep 2min.`,
    };

    return {
      shouldWake: true,
      message: toolMap[choice],
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
