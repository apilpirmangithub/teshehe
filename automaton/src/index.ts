#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { runAgentLoop } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { startDashboardServer } from "./dashboard/server.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (shows dashboard first)
  automaton --dashboard    Show live trading dashboard (auto-refresh)
  automaton --auto-tunnel  Start Cloudflare Tunnel to expose port 3000
  automaton --setup        Re-run the interactive setup wizard
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    const { account, isNew } = await getWallet();
    console.log(
      JSON.stringify({
        address: account.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      console.log(JSON.stringify(result));
    } catch (err: any) {
      console.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--dashboard")) {
    await runDashboard(args.includes("--live"));
    process.exit(0);
  }

  if (args.includes("--run")) {
    if (args.includes("--auto-tunnel")) {
      startTunnel().catch(err => console.error(`[Tunnel] Failed: ${err.message}`));
    }
    await run();
    return;
  }

  if (args.includes("--auto-tunnel")) {
    await startTunnel();
    process.exit(0);
  }

  // Default: show help
  console.log('Run "automaton --help" for usage information.');
  console.log('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  console.log(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Dashboard Command ─────────────────────────────────────────

async function runDashboard(live: boolean = false): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);
  const walletAddress = config.walletAddress;

  const { showDashboard, showLiveDashboard } = await import("./dashboard/dashboard.js");

  if (live) {
    await showLiveDashboard({ db, config, walletAddress, refreshInterval: 30 });
  } else {
    await showDashboard({ db, config, walletAddress });
  }

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Ensure API key is in environment for getWallet() zero-config logic
  if (config.conwayApiKey && !process.env.CONWAY_API_KEY) {
    process.env.CONWAY_API_KEY = config.conwayApiKey;
  }

  // Load wallet
  const { account } = await getWallet();
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    console.error(
      "No API key found. Run: automaton --provision",
    );
    process.exit(1);
  }

  // Build identity
  const identity: AutomatonIdentity = {
    name: config.name,
    address: account.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt: new Date().toISOString(),
  };

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", account.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("sandbox", config.sandboxId);

  // Store wallet address in KV for heartbeat tasks (balance checks)
  db.setKV("wallet_address", account.address);

  // ─── Start Web Dashboard Server ──────────────────────────────
  try {
    startDashboardServer({
      db,
      config,
      walletAddress: account.address,
      port: 3001,
    });
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Web Dashboard Server failed: ${err.message}`);
  }

  // ─── Show Trading Dashboard at Startup ───────────────────────
  try {
    const { showDashboard } = await import("./dashboard/dashboard.js");
    await showDashboard({ db, config, walletAddress: account.address });
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Dashboard skipped: ${err.message}`);
  }

  // ─── Pre-flight Capital Check ───────────────────────────────
  try {
    const { getBalance } = await import("./survival/hyperliquid.js");
    const hl = await getBalance();
    if (hl.accountValue < 1.0) {
      console.warn(`\n\x1b[1m\x1b[33m[!]\x1b[0m \x1b[33mCRITICAL: Insufficient USDC balance ($${hl.accountValue.toFixed(2)}).\x1b[0m`);
      console.warn(`\x1b[33m[!]\x1b[0m \x1b[33mHyperScalperX requires at least $1.00 USDC to trade.\x1b[0m`);
      console.warn(`\x1b[33m[!]\x1b[0m \x1b[33mPlease deposit USDC via Hyperliquid App:\x1b[0m`);
      console.warn(`\x1b[1m\x1b[36m    https://app.hyperliquid.xyz/\x1b[0m`);
      console.warn(`\x1b[33m[!]\x1b[0m \x1b[33mThe agent will enter SLEEP mode until funded.\x1b[0m\n`);
    }

    // ─── Agent Authorization Check ──────────────────────────────
    const auth = await (await import("./survival/hyperliquid.js")).checkAgentAuthorization();
    if (!auth.authorized) {
      console.log(`\n\x1b[1m\x1b[35m[!] ACTION REQUIRED: AUTHORIZE AGENT\x1b[0m`);
      console.log(`\x1b[35mAgar HypeScalperX bisa trading, Anda perlu memberikan izin (Authorize) di Hyperliquid.\x1b[0m`);
      console.log(`\x1b[35mCaranya sangat mudah:\x1b[0m`);
      console.log(`\x1b[36m  1. Buka \x1b[1mhttps://app.hyperliquid.xyz/\x1b[0m`);
      console.log(`\x1b[36m  2. Klik tab \x1b[1m'More'\x1b[0m di atas, lalu pilih \x1b[1m'API'\x1b[0m`);
      console.log(`\x1b[36m  3. Klik tombol \x1b[1m'Authorize an Agent'\x1b[0m`);
      console.log(`\x1b[36m  4. Masukkan Address Agen ini:\x1b[0m \x1b[1m\x1b[32m${auth.agentAddress}\x1b[0m`);
      console.log(`\x1b[36m  5. Klik 'Approve' dan tanda tangani di Wallet (MetaMask/Rabby).\x1b[0m`);
      console.log(`\n\x1b[35mDashboard akan otomatis update begitu status berubah menjadi ACTIVE.\x1b[0m\n`);
    } else {
      console.log(`\x1b[32m[✓] Agent Authorization: ACTIVE (Signed by ${auth.userAddress})\x1b[0m`);
    }
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Capital/Auth check failed: ${err.message}`);
  }

  // Create Conway client
  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });

  // Create inference client
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
  });

  // Create social client
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, account);
    console.log(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    console.log(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    console.log(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Start heartbeat daemon
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    db,
    conway,
    social,
    onWakeRequest: (reason) => {
      console.log(`[HEARTBEAT] Wake request: ${reason}`);
      // The heartbeat can trigger the agent loop
      // In the main run loop, we check for wake requests
      db.setKV("wake_request", reason);
    },
  });

  heartbeat.start();
  console.log(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch { }

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        onStateChange: (state: AgentState) => {
          console.log(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          console.log(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        console.log(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(120_000); // Check every 2 minutes (hustle mode)
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 90_000; // Default 90s (hustle mode)
        const sleepMs = Math.max(sleepUntil - Date.now(), 60_000); // Minimum 1 min sleep (aggressive)
        console.log(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Check for wake request from heartbeat
          const wakeRequest = db.getKV("wake_request");
          if (wakeRequest) {
            console.log(
              `[${new Date().toISOString()}] Woken by heartbeat: ${wakeRequest}`,
            );
            db.deleteKV("wake_request");
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      console.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

async function startTunnel(): Promise<void> {
  const { exec } = await import("child_process");
  console.log("[Tunnel] Starting Cloudflare Quick Tunnel...");
  const proc = exec('cloudflared tunnel --url http://127.0.0.1:3001');

  proc.stderr?.on("data", (data) => {
    const output = data.toString();
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      console.log(`\n\x1b[32m[Tunnel] PUBLIC DASHBOARD ACCESS: ${match[0]}\x1b[0m\n`);
    }
  });

  return new Promise((resolve) => {
    proc.on("spawn", () => {
      setTimeout(resolve, 3000);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
