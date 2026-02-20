/**
 * Automaton Database
 *
 * SQLite-backed persistent state for the automaton.
 * Uses better-sqlite3 for synchronous, single-process access.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type {
  AutomatonDatabase,
  AgentTurn,
  AgentState,
  ToolCallResult,
  HeartbeatEntry,
  Transaction,
  InstalledTool,
  ModificationEntry,
  Skill,
  ChildAutomaton,
  ChildStatus,
  RegistryEntry,
  ReputationEntry,
  InboxMessage,
} from "../types.js";
import { SCHEMA_VERSION, CREATE_TABLES, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4 } from "./schema.js";

export function createDatabase(dbPath: string): AutomatonDatabase {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Initialize schema
  db.exec(CREATE_TABLES);

  // Check and apply schema version
  const versionRow = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null } | undefined;
  const currentVersion = versionRow?.v ?? 0;

  if (currentVersion < 2) {
    db.exec(MIGRATION_V2);
  }

  if (currentVersion < 3) {
    db.exec(MIGRATION_V3);
  }

  if (currentVersion < 4) {
    db.exec(MIGRATION_V4);
  }

  if (currentVersion < SCHEMA_VERSION) {
    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
    ).run(SCHEMA_VERSION);
  }

  // ─── Identity ────────────────────────────────────────────────

  const getIdentity = (key: string): string | undefined => {
    const row = db
      .prepare("SELECT value FROM identity WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  };

  const setIdentity = (key: string, value: string): void => {
    db.prepare(
      "INSERT OR REPLACE INTO identity (key, value) VALUES (?, ?)",
    ).run(key, value);
  };

  // ─── Turns ───────────────────────────────────────────────────

  const insertTurn = (turn: AgentTurn): void => {
    db.prepare(
      `INSERT INTO turns (id, timestamp, state, input, input_source, thinking, tool_calls, token_usage, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turn.id,
      turn.timestamp,
      turn.state,
      turn.input ?? null,
      turn.inputSource ?? null,
      turn.thinking,
      JSON.stringify(turn.toolCalls),
      JSON.stringify(turn.tokenUsage),
      turn.costCents,
    );
  };

  const getRecentTurns = (limit: number): AgentTurn[] => {
    const rows = db
      .prepare(
        "SELECT * FROM turns ORDER BY timestamp DESC LIMIT ?",
      )
      .all(limit) as any[];
    return rows.map(deserializeTurn).reverse();
  };

  const getTurnById = (id: string): AgentTurn | undefined => {
    const row = db
      .prepare("SELECT * FROM turns WHERE id = ?")
      .get(id) as any | undefined;
    return row ? deserializeTurn(row) : undefined;
  };

  const getTurnCount = (): number => {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM turns")
      .get() as { count: number };
    return row.count;
  };

  // ─── Tool Calls ──────────────────────────────────────────────

  const insertToolCall = (
    turnId: string,
    call: ToolCallResult,
  ): void => {
    db.prepare(
      `INSERT INTO tool_calls (id, turn_id, name, arguments, result, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.id,
      turnId,
      call.name,
      JSON.stringify(call.arguments),
      call.result,
      call.durationMs,
      call.error ?? null,
    );
  };

  const getToolCallsForTurn = (turnId: string): ToolCallResult[] => {
    const rows = db
      .prepare("SELECT * FROM tool_calls WHERE turn_id = ?")
      .all(turnId) as any[];
    return rows.map(deserializeToolCall);
  };

  // ─── Heartbeat ───────────────────────────────────────────────

  const getHeartbeatEntries = (): HeartbeatEntry[] => {
    const rows = db
      .prepare("SELECT * FROM heartbeat_entries")
      .all() as any[];
    return rows.map(deserializeHeartbeatEntry);
  };

  const upsertHeartbeatEntry = (entry: HeartbeatEntry): void => {
    db.prepare(
      `INSERT OR REPLACE INTO heartbeat_entries (name, schedule, task, enabled, last_run, next_run, params, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      entry.name,
      entry.schedule,
      entry.task,
      entry.enabled ? 1 : 0,
      entry.lastRun ?? null,
      entry.nextRun ?? null,
      JSON.stringify(entry.params ?? {}),
    );
  };

  const updateHeartbeatLastRun = (
    name: string,
    timestamp: string,
  ): void => {
    db.prepare(
      "UPDATE heartbeat_entries SET last_run = ?, updated_at = datetime('now') WHERE name = ?",
    ).run(timestamp, name);
  };

  // ─── Transactions ────────────────────────────────────────────

  const insertTransaction = (txn: Transaction): void => {
    db.prepare(
      `INSERT INTO transactions (id, type, amount_cents, balance_after_cents, description)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      txn.id,
      txn.type,
      txn.amountCents ?? null,
      txn.balanceAfterCents ?? null,
      txn.description,
    );
  };

  const getRecentTransactions = (limit: number): Transaction[] => {
    const rows = db
      .prepare(
        "SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as any[];
    return rows.map(deserializeTransaction).reverse();
  };

  // ─── Installed Tools ─────────────────────────────────────────

  const getInstalledTools = (): InstalledTool[] => {
    const rows = db
      .prepare("SELECT * FROM installed_tools WHERE enabled = 1")
      .all() as any[];
    return rows.map(deserializeInstalledTool);
  };

  const installTool = (tool: InstalledTool): void => {
    db.prepare(
      `INSERT OR REPLACE INTO installed_tools (id, name, type, config, installed_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      tool.id,
      tool.name,
      tool.type,
      JSON.stringify(tool.config ?? {}),
      tool.installedAt,
      tool.enabled ? 1 : 0,
    );
  };

  const removeTool = (id: string): void => {
    db.prepare(
      "UPDATE installed_tools SET enabled = 0 WHERE id = ?",
    ).run(id);
  };

  // ─── Modifications ───────────────────────────────────────────

  const insertModification = (mod: ModificationEntry): void => {
    db.prepare(
      `INSERT INTO modifications (id, timestamp, type, description, file_path, diff, reversible)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mod.id,
      mod.timestamp,
      mod.type,
      mod.description,
      mod.filePath ?? null,
      mod.diff ?? null,
      mod.reversible ? 1 : 0,
    );
  };

  const getRecentModifications = (
    limit: number,
  ): ModificationEntry[] => {
    const rows = db
      .prepare(
        "SELECT * FROM modifications ORDER BY timestamp DESC LIMIT ?",
      )
      .all(limit) as any[];
    return rows.map(deserializeModification).reverse();
  };

  // ─── Key-Value Store ─────────────────────────────────────────

  const getKV = (key: string): string | undefined => {
    const row = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  };

  const setKV = (key: string, value: string): void => {
    db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(key, value);
  };

  const deleteKV = (key: string): void => {
    db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  };

  // ─── Skills ─────────────────────────────────────────────────

  const getSkills = (enabledOnly?: boolean): Skill[] => {
    const query = enabledOnly
      ? "SELECT * FROM skills WHERE enabled = 1"
      : "SELECT * FROM skills";
    const rows = db.prepare(query).all() as any[];
    return rows.map(deserializeSkill);
  };

  const getSkillByName = (name: string): Skill | undefined => {
    const row = db
      .prepare("SELECT * FROM skills WHERE name = ?")
      .get(name) as any | undefined;
    return row ? deserializeSkill(row) : undefined;
  };

  const upsertSkill = (skill: Skill): void => {
    db.prepare(
      `INSERT OR REPLACE INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      skill.name,
      skill.description,
      skill.autoActivate ? 1 : 0,
      JSON.stringify(skill.requires ?? {}),
      skill.instructions,
      skill.source,
      skill.path,
      skill.enabled ? 1 : 0,
      skill.installedAt,
    );
  };

  const removeSkill = (name: string): void => {
    db.prepare("UPDATE skills SET enabled = 0 WHERE name = ?").run(name);
  };

  // ─── Children ──────────────────────────────────────────────

  const getChildren = (): ChildAutomaton[] => {
    const rows = db
      .prepare("SELECT * FROM children ORDER BY created_at DESC")
      .all() as any[];
    return rows.map(deserializeChild);
  };

  const getChildById = (id: string): ChildAutomaton | undefined => {
    const row = db
      .prepare("SELECT * FROM children WHERE id = ?")
      .get(id) as any | undefined;
    return row ? deserializeChild(row) : undefined;
  };

  const insertChild = (child: ChildAutomaton): void => {
    db.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, creator_message, funded_amount_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      child.id,
      child.name,
      child.address,
      child.sandboxId,
      child.genesisPrompt,
      child.creatorMessage ?? null,
      child.fundedAmountCents,
      child.status,
      child.createdAt,
    );
  };

  const updateChildStatus = (id: string, status: ChildStatus): void => {
    db.prepare(
      "UPDATE children SET status = ?, last_checked = datetime('now') WHERE id = ?",
    ).run(status, id);
  };

  // ─── Registry ──────────────────────────────────────────────

  const getRegistryEntry = (): RegistryEntry | undefined => {
    const row = db
      .prepare("SELECT * FROM registry LIMIT 1")
      .get() as any | undefined;
    return row ? deserializeRegistry(row) : undefined;
  };

  const setRegistryEntry = (entry: RegistryEntry): void => {
    db.prepare(
      `INSERT OR REPLACE INTO registry (agent_id, agent_uri, chain, contract_address, tx_hash, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.agentId,
      entry.agentURI,
      entry.chain,
      entry.contractAddress,
      entry.txHash,
      entry.registeredAt,
    );
  };

  // ─── Reputation ────────────────────────────────────────────

  const insertReputation = (entry: ReputationEntry): void => {
    db.prepare(
      `INSERT INTO reputation (id, from_agent, to_agent, score, comment, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.fromAgent,
      entry.toAgent,
      entry.score,
      entry.comment,
      entry.txHash ?? null,
    );
  };

  const getReputation = (agentAddress?: string): ReputationEntry[] => {
    const query = agentAddress
      ? "SELECT * FROM reputation WHERE to_agent = ? ORDER BY created_at DESC"
      : "SELECT * FROM reputation ORDER BY created_at DESC";
    const params = agentAddress ? [agentAddress] : [];
    const rows = db.prepare(query).all(...params) as any[];
    return rows.map(deserializeReputation);
  };

  // ─── Inbox Messages ──────────────────────────────────────────

  const insertInboxMessage = (msg: InboxMessage): void => {
    db.prepare(
      `INSERT OR IGNORE INTO inbox_messages (id, from_address, content, received_at, reply_to)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      msg.id,
      msg.from,
      msg.content,
      msg.createdAt || new Date().toISOString(),
      msg.replyTo ?? null,
    );
  };

  const getUnprocessedInboxMessages = (limit: number): InboxMessage[] => {
    const rows = db
      .prepare(
        "SELECT * FROM inbox_messages WHERE processed_at IS NULL ORDER BY received_at ASC LIMIT ?",
      )
      .all(limit) as any[];
    return rows.map(deserializeInboxMessage);
  };

  const markInboxMessageProcessed = (id: string): void => {
    db.prepare(
      "UPDATE inbox_messages SET processed_at = datetime('now') WHERE id = ?",
    ).run(id);
  };

  // ─── Polymarket Trading ──────────────────────────────────────

  const insertPMPosition = (
    id: string,
    marketId: string,
    marketTitle: string,
    side: "YES" | "NO",
    entryPrice: number,
    entryAmountUsd: number,
    targetExitPrice: number,
    stopLossPrice: number,
  ): void => {
    db.prepare(
      `INSERT INTO pm_positions (
        id, market_id, market_title, side, entry_price, entry_amount_usd,
        entry_time, target_exit_price, stop_loss_price
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
    ).run(
      id,
      marketId,
      marketTitle,
      side,
      entryPrice,
      entryAmountUsd,
      targetExitPrice,
      stopLossPrice,
    );
  };

  const closePMPosition = (
    id: string,
    exitPrice: number,
    exitAmountUsd: number,
    reason: "target_hit" | "stop_loss" | "timeout",
    pnlUsd: number,
    pnlPct: number,
  ): void => {
    db.prepare(
      `UPDATE pm_positions SET 
        status = 'closed',
        current_price = ?,
        current_value_usd = ?,
        pnl_usd = ?,
        pnl_pct = ?,
        close_reason = ?,
        closed_at = datetime('now'),
        updated_at = datetime('now')
       WHERE id = ?`,
    ).run(exitPrice, exitAmountUsd, pnlUsd, pnlPct, reason, id);
  };

  const getPMPositions = (
    status?: "open" | "closed",
  ): Array<{
    id: string;
    marketTitle: string;
    side: string;
    entryPrice: number;
    entryAmount: number;
    currentPrice: number | null;
    pnlUsd: number;
    pnlPct: number;
    status: string;
  }> => {
    let query =
      "SELECT id, market_title, side, entry_price, entry_amount_usd, current_price, pnl_usd, pnl_pct, status FROM pm_positions";
    if (status) {
      query += " WHERE status = ?";
    }
    query += " ORDER BY entry_time DESC";

    const rows = status
      ? (db.prepare(query).all(status) as any[])
      : (db.prepare(query).all() as any[]);

    return rows.map((r) => ({
      id: r.id,
      marketTitle: r.market_title,
      side: r.side,
      entryPrice: r.entry_price,
      entryAmount: r.entry_amount_usd,
      currentPrice: r.current_price,
      pnlUsd: r.pnl_usd,
      pnlPct: r.pnl_pct,
      status: r.status,
    }));
  };

  const insertPMTrade = (
    id: string,
    marketId: string,
    marketTitle: string,
    side: "YES" | "NO",
    entryPrice: number,
    entryAmountUsd: number,
    exitPrice: number,
    exitAmountUsd: number,
    reason: "target_hit" | "stop_loss" | "timeout" | "manual",
    pnlUsd: number,
    pnlPct: number,
    holdingMinutes: number,
    weatherCondition?: string,
    edgePct?: number,
  ): void => {
    db.prepare(
      `INSERT INTO pm_trades (
        id, market_id, market_title, side, entry_price, entry_amount_usd,
        entry_time, exit_price, exit_amount_usd, exit_time, exit_reason,
        pnl_usd, pnl_pct, holding_minutes, weather_condition, edge_pct
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      marketId,
      marketTitle,
      side,
      entryPrice,
      entryAmountUsd,
      exitPrice,
      exitAmountUsd,
      reason,
      pnlUsd,
      pnlPct,
      holdingMinutes,
      weatherCondition || null,
      edgePct || null,
    );
  };

  const getPMTradeHistory = (
    limit: number = 50,
  ): Array<{
    marketTitle: string;
    side: string;
    pnlUsd: number;
    pnlPct: number;
    reason: string;
    createdAt: string;
  }> => {
    const rows = db
      .prepare(
        `SELECT market_title, side, pnl_usd, pnl_pct, exit_reason, created_at 
         FROM pm_trades ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as any[];

    return rows.map((r) => ({
      marketTitle: r.market_title,
      side: r.side,
      pnlUsd: r.pnl_usd,
      pnlPct: r.pnl_pct,
      reason: r.exit_reason,
      createdAt: r.created_at,
    }));
  };

  const insertPMPortfolioSnapshot = (
    id: string,
    totalCapitalUsd: number,
    currentBalanceUsd: number,
    positionsOpen: number,
    pnlTodayUsd: number,
    tradsToday: number,
    winCount: number,
    lossCount: number,
    dailyMaxLossReached: boolean,
    note?: string,
  ): void => {
    db.prepare(
      `INSERT INTO pm_portfolio (
        id, timestamp, total_capital_usd, current_balance_usd,
        positions_open, pnl_today_usd, trades_today, win_count, loss_count,
        daily_max_loss_reached, note
      ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      totalCapitalUsd,
      currentBalanceUsd,
      positionsOpen,
      pnlTodayUsd,
      tradsToday,
      winCount,
      lossCount,
      dailyMaxLossReached ? 1 : 0,
      note || null,
    );
  };

  const getPMPortfolioStats = () => {
    const row = db
      .prepare(
        `SELECT 
          SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as win_count,
          SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as loss_count,
          COUNT(*) as total_trades,
          AVG(pnl_pct) as avg_pnl_pct,
          MAX(pnl_usd) as best_trade,
          MIN(pnl_usd) as worst_trade,
          SUM(pnl_usd) as total_pnl
        FROM pm_trades`,
      )
      .get() as any;

    return {
      winCount: row.win_count || 0,
      lossCount: row.loss_count || 0,
      totalTrades: row.total_trades || 0,
      avgPnlPct: row.avg_pnl_pct || 0,
      bestTrade: row.best_trade || 0,
      worstTrade: row.worst_trade || 0,
      totalPnl: row.total_pnl || 0,
      winRate: row.total_trades
        ? ((row.win_count || 0) / row.total_trades * 100).toFixed(1)
        : 0,
    };
  };

  const insertPMEdge = (
    id: string,
    marketId: string,
    marketTitle: string,
    location: string | undefined,
    weatherForecast: string,
    marketPriceYes: number,
    yourForecastPct: number,
    edgePct: number,
    recommendation: "strong_buy" | "buy" | "hold" | "skip",
    betPlaced: boolean,
    notes?: string,
  ): void => {
    db.prepare(
      `INSERT INTO pm_edges (
        id, market_id, market_title, location, weather_forecast,
        market_price_yes, your_forecast_pct, edge_pct, recommendation,
        bet_placed, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      marketId,
      marketTitle,
      location || null,
      weatherForecast,
      marketPriceYes,
      yourForecastPct,
      edgePct,
      recommendation,
      betPlaced ? 1 : 0,
      notes || null,
    );
  };

  const getPMEdgeAnalysis = (hoursBack: number = 24) => {
    const rows = db
      .prepare(
        `SELECT 
          recommendation, edge_pct, bet_placed, 
          COUNT(*) as count,
          SUM(CASE WHEN bet_placed = 1 THEN 1 ELSE 0 END) as beds_count
        FROM pm_edges 
        WHERE created_at > datetime('now', '-' || ? || ' hours')
        GROUP BY recommendation, bet_placed
        ORDER BY edge_pct DESC`,
      )
      .all(hoursBack) as any[];

    return rows.map((r) => ({
      recommendation: r.recommendation,
      edgePct: r.edge_pct,
      totalOpportunities: r.count,
      betsMade: r.bets_count || 0,
    }));
  };

  // ─── Agent State ─────────────────────────────────────────────

  const getAgentState = (): AgentState => {
    return (getKV("agent_state") as AgentState) || "setup";
  };

  const setAgentState = (state: AgentState): void => {
    setKV("agent_state", state);
  };

  // ─── Close ───────────────────────────────────────────────────

  const close = (): void => {
    db.close();
  };

  return {
    getIdentity,
    setIdentity,
    insertTurn,
    getRecentTurns,
    getTurnById,
    getTurnCount,
    insertToolCall,
    getToolCallsForTurn,
    getHeartbeatEntries,
    upsertHeartbeatEntry,
    updateHeartbeatLastRun,
    insertTransaction,
    getRecentTransactions,
    getInstalledTools,
    installTool,
    removeTool,
    insertModification,
    getRecentModifications,
    getKV,
    setKV,
    deleteKV,
    getSkills,
    getSkillByName,
    upsertSkill,
    removeSkill,
    getChildren,
    getChildById,
    insertChild,
    updateChildStatus,
    getRegistryEntry,
    setRegistryEntry,
    insertReputation,
    getReputation,
    insertInboxMessage,
    getUnprocessedInboxMessages,
    markInboxMessageProcessed,
    insertPMPosition,
    closePMPosition,
    getPMPositions,
    insertPMTrade,
    getPMTradeHistory,
    insertPMPortfolioSnapshot,
    getPMPortfolioStats,
    insertPMEdge,
    getPMEdgeAnalysis,
    getAgentState,
    setAgentState,
    close,
  };
}

// ─── Deserializers ─────────────────────────────────────────────

function deserializeTurn(row: any): AgentTurn {
  return {
    id: row.id,
    timestamp: row.timestamp,
    state: row.state,
    input: row.input ?? undefined,
    inputSource: row.input_source ?? undefined,
    thinking: row.thinking,
    toolCalls: JSON.parse(row.tool_calls || "[]"),
    tokenUsage: JSON.parse(row.token_usage || "{}"),
    costCents: row.cost_cents,
  };
}

function deserializeToolCall(row: any): ToolCallResult {
  return {
    id: row.id,
    name: row.name,
    arguments: JSON.parse(row.arguments || "{}"),
    result: row.result,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
  };
}

function deserializeHeartbeatEntry(row: any): HeartbeatEntry {
  return {
    name: row.name,
    schedule: row.schedule,
    task: row.task,
    enabled: !!row.enabled,
    lastRun: row.last_run ?? undefined,
    nextRun: row.next_run ?? undefined,
    params: JSON.parse(row.params || "{}"),
  };
}

function deserializeTransaction(row: any): Transaction {
  return {
    id: row.id,
    type: row.type,
    amountCents: row.amount_cents ?? undefined,
    balanceAfterCents: row.balance_after_cents ?? undefined,
    description: row.description,
    timestamp: row.created_at,
  };
}

function deserializeInstalledTool(row: any): InstalledTool {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: JSON.parse(row.config || "{}"),
    installedAt: row.installed_at,
    enabled: !!row.enabled,
  };
}

function deserializeModification(row: any): ModificationEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    description: row.description,
    filePath: row.file_path ?? undefined,
    diff: row.diff ?? undefined,
    reversible: !!row.reversible,
  };
}

function deserializeSkill(row: any): Skill {
  return {
    name: row.name,
    description: row.description,
    autoActivate: !!row.auto_activate,
    requires: JSON.parse(row.requires || "{}"),
    instructions: row.instructions,
    source: row.source,
    path: row.path,
    enabled: !!row.enabled,
    installedAt: row.installed_at,
  };
}

function deserializeChild(row: any): ChildAutomaton {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    sandboxId: row.sandbox_id,
    genesisPrompt: row.genesis_prompt,
    creatorMessage: row.creator_message ?? undefined,
    fundedAmountCents: row.funded_amount_cents,
    status: row.status,
    createdAt: row.created_at,
    lastChecked: row.last_checked ?? undefined,
  };
}

function deserializeRegistry(row: any): RegistryEntry {
  return {
    agentId: row.agent_id,
    agentURI: row.agent_uri,
    chain: row.chain,
    contractAddress: row.contract_address,
    txHash: row.tx_hash,
    registeredAt: row.registered_at,
  };
}

function deserializeInboxMessage(row: any): InboxMessage {
  return {
    id: row.id,
    from: row.from_address,
    to: "",
    content: row.content,
    signedAt: row.received_at,
    createdAt: row.received_at,
    replyTo: row.reply_to ?? undefined,
  };
}

function deserializeReputation(row: any): ReputationEntry {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    score: row.score,
    comment: row.comment,
    txHash: row.tx_hash ?? undefined,
    timestamp: row.created_at,
  };
}
