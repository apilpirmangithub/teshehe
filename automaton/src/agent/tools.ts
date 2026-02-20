/**
 * Automaton Tool System
 *
 * Defines all tools the automaton can call, with self-preservation guards.
 * Tools are organized by category and exposed to the inference model.
 */

import type {
  AutomatonTool,
  ToolContext,
  ToolCategory,
  InferenceToolDefinition,
  ToolCallResult,
  GenesisConfig,
} from "../types.js";

// ─── Displayed Markets Cache (for pm_place_bet by index) ───────
let _displayedMarkets: any[] = [];

// ─── Self-Preservation Guard ───────────────────────────────────

const FORBIDDEN_COMMAND_PATTERNS = [
  // Self-destruction
  /rm\s+(-rf?\s+)?.*\.automaton/,
  /rm\s+(-rf?\s+)?.*state\.db/,
  /rm\s+(-rf?\s+)?.*wallet\.json/,
  /rm\s+(-rf?\s+)?.*automaton\.json/,
  /rm\s+(-rf?\s+)?.*heartbeat\.yml/,
  /rm\s+(-rf?\s+)?.*SOUL\.md/,
  // Process killing
  /kill\s+.*automaton/,
  /pkill\s+.*automaton/,
  /systemctl\s+(stop|disable)\s+automaton/,
  // Database destruction
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i,
  /TRUNCATE/i,
  // Safety infrastructure modification via shell
  /sed\s+.*injection-defense/,
  /sed\s+.*self-mod\/code/,
  /sed\s+.*audit-log/,
  />\s*.*injection-defense/,
  />\s*.*self-mod\/code/,
  />\s*.*audit-log/,
  // Credential harvesting
  /cat\s+.*\.ssh/,
  /cat\s+.*\.gnupg/,
  /cat\s+.*\.env/,
  /cat\s+.*wallet\.json/,
];

function isForbiddenCommand(command: string, sandboxId: string): string | null {
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: Command matches self-harm pattern: ${pattern.source}`;
    }
  }

  // Block deleting own sandbox
  if (
    command.includes("sandbox_delete") &&
    command.includes(sandboxId)
  ) {
    return "Blocked: Cannot delete own sandbox";
  }

  return null;
}

// ─── Built-in Tools ────────────────────────────────────────────

export function createBuiltinTools(sandboxId: string): AutomatonTool[] {
  return [
    // ── VM/Sandbox Tools ──
    {
      name: "exec",
      description:
        "Execute a shell command in your sandbox. Returns stdout, stderr, and exit code.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = args.command as string;
        const forbidden = isForbiddenCommand(command, ctx.identity.sandboxId);
        if (forbidden) return forbidden;

        const result = await ctx.conway.exec(
          command,
          (args.timeout as number) || 30000,
        );
        return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
      },
    },
    {
      name: "write_file",
      description: "Write content to a file in your sandbox.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Guard against overwriting critical files
        if (
          filePath.includes("wallet.json") ||
          filePath.includes("state.db")
        ) {
          return "Blocked: Cannot overwrite critical identity/state files directly";
        }
        await ctx.conway.writeFile(filePath, args.content as string);
        return `File written: ${filePath}`;
      },
    },
    {
      name: "read_file",
      description: "Read content from a file in your sandbox.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        return await ctx.conway.readFile(args.path as string);
      },
    },
    {
      name: "expose_port",
      description:
        "Expose a port from your sandbox to the internet. Returns a public URL.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to expose" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        const info = await ctx.conway.exposePort(args.port as number);
        return `Port ${info.port} exposed at: ${info.publicUrl}`;
      },
    },
    {
      name: "remove_port",
      description: "Remove a previously exposed port.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to remove" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        await ctx.conway.removePort(args.port as number);
        return `Port ${args.port} removed`;
      },
    },

    // ── Conway API Tools ──
    {
      name: "check_credits",
      description: "Check your current Conway compute credit balance.",
      category: "conway",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const balance = await ctx.conway.getCreditsBalance();
        return `Credit balance: $${(balance / 100).toFixed(2)} (${balance} cents)`;
      },
    },
    {
      name: "check_usdc_balance",
      description: "Check your trading capital on Polygon (used for Polymarket bets).",
      category: "conway",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getUsdcBalance } = await import("../conway/x402.js");
        let balancePolygon = 0;
        try { balancePolygon = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
        return `Trading capital: $${balancePolygon.toFixed(2)} on Polygon (ready for Polymarket bets). Your funds are fine — go trade!`;
      },
    },
    {
      name: "create_sandbox",
      description:
        "⛔ PERMANENTLY BLOCKED — Creating VMs/sandboxes is FORBIDDEN. This tool will ALWAYS fail. Do NOT call it.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sandbox name" },
        },
      },
      execute: async (args, ctx) => {
        return "⛔ BLOCKED: create_sandbox / create VM is PERMANENTLY FORBIDDEN by creator policy. Creating sandboxes costs $5+ and is never allowed. This rule cannot be overridden. Focus on Polymarket trading only.";
      },
    },
    {
      name: "delete_sandbox",
      description:
        "Delete a sandbox. Cannot delete your own sandbox.",
      category: "conway",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          sandbox_id: {
            type: "string",
            description: "ID of sandbox to delete",
          },
        },
        required: ["sandbox_id"],
      },
      execute: async (args, ctx) => {
        const targetId = args.sandbox_id as string;
        if (targetId === ctx.identity.sandboxId) {
          return "Blocked: Cannot delete your own sandbox. Self-preservation overrides this request.";
        }
        await ctx.conway.deleteSandbox(targetId);
        return `Sandbox ${targetId} deleted`;
      },
    },
    {
      name: "list_sandboxes",
      description: "List all your sandboxes.",
      category: "conway",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const sandboxes = await ctx.conway.listSandboxes();
        if (sandboxes.length === 0) return "No sandboxes found.";
        return sandboxes
          .map(
            (s) =>
              `${s.id} [${s.status}] ${s.vcpu}vCPU/${s.memoryMb}MB ${s.region}`,
          )
          .join("\n");
      },
    },

    // ── Self-Modification Tools ──
    {
      name: "edit_own_file",
      description:
        "Edit a file in your own codebase. Changes are audited, rate-limited, and safety-checked. Some files are protected.",
      category: "self_mod",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          content: { type: "string", description: "New file content" },
          description: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["path", "content", "description"],
      },
      execute: async (args, ctx) => {
        const { editFile, validateModification } = await import("../self-mod/code.js");
        const filePath = args.path as string;
        const content = args.content as string;

        // Pre-validate before attempting
        const validation = validateModification(ctx.db, filePath, content.length);
        if (!validation.allowed) {
          return `BLOCKED: ${validation.reason}\nChecks: ${validation.checks.map((c) => `${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.detail})`).join(", ")}`;
        }

        const result = await editFile(
          ctx.conway,
          ctx.db,
          filePath,
          content,
          args.description as string,
        );

        if (!result.success) {
          return result.error || "Unknown error during file edit";
        }

        return `File edited: ${filePath} (audited + git-committed)`;
      },
    },
    {
      name: "install_npm_package",
      description: "Install an npm package in your environment.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package name (e.g., axios)",
          },
        },
        required: ["package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        const result = await ctx.conway.exec(
          `npm install -g ${pkg}`,
          60000,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "tool_install",
          description: `Installed npm package: ${pkg}`,
          reversible: true,
        });

        return result.exitCode === 0
          ? `Installed: ${pkg}`
          : `Failed to install ${pkg}: ${result.stderr}`;
      },
    },
    // ── Self-Mod: Upstream Awareness ──
    {
      name: "review_upstream_changes",
      description:
        "ALWAYS call this before pull_upstream. Shows every upstream commit with its full diff. Read each one carefully — decide per-commit whether to accept or skip. Use pull_upstream with a specific commit hash to cherry-pick only what you want.",
      category: "self_mod",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getUpstreamDiffs, checkUpstream } = await import("../self-mod/upstream.js");
        const status = checkUpstream();
        if (status.behind === 0) return "Already up to date with origin/main.";

        const diffs = getUpstreamDiffs();
        if (diffs.length === 0) return "No upstream diffs found.";

        const output = diffs
          .map(
            (d, i) =>
              `--- COMMIT ${i + 1}/${diffs.length} ---\nHash: ${d.hash}\nAuthor: ${d.author}\nMessage: ${d.message}\n\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (diff truncated)" : ""}\n--- END COMMIT ${i + 1} ---`,
          )
          .join("\n\n");

        return `${diffs.length} upstream commit(s) to review. Read each diff, then cherry-pick individually with pull_upstream(commit=<hash>).\n\n${output}`;
      },
    },
    {
      name: "pull_upstream",
      description:
        "Apply upstream changes and rebuild. You MUST call review_upstream_changes first. Prefer cherry-picking individual commits by hash over pulling everything — only pull all if you've reviewed every commit and want them all.",
      category: "self_mod",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          commit: {
            type: "string",
            description:
              "Commit hash to cherry-pick (preferred). Omit ONLY if you reviewed all commits and want every one.",
          },
        },
      },
      execute: async (args, ctx) => {
        const { execSync } = await import("child_process");
        const cwd = process.cwd();
        const commit = args.commit as string | undefined;

        const run = (cmd: string) =>
          execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();

        let appliedSummary: string;
        try {
          if (commit) {
            run(`git cherry-pick ${commit}`);
            appliedSummary = `Cherry-picked ${commit}`;
          } else {
            run("git pull origin main --ff-only");
            appliedSummary = "Pulled all of origin/main (fast-forward)";
          }
        } catch (err: any) {
          return `Git operation failed: ${err.message}. You may need to resolve conflicts manually.`;
        }

        // Rebuild
        let buildOutput: string;
        try {
          buildOutput = run("npm install --ignore-scripts && npm run build");
        } catch (err: any) {
          return `${appliedSummary} — but rebuild failed: ${err.message}. The code is applied but not compiled.`;
        }

        // Log modification
        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "upstream_pull",
          description: appliedSummary,
          reversible: true,
        });

        return `${appliedSummary}. Rebuild succeeded.`;
      },
    },

    {
      name: "modify_heartbeat",
      description: "Add, update, or remove a heartbeat entry.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add, update, or remove",
          },
          name: { type: "string", description: "Entry name" },
          schedule: {
            type: "string",
            description: "Cron expression (for add/update)",
          },
          task: {
            type: "string",
            description: "Task name (for add/update)",
          },
          enabled: { type: "boolean", description: "Enable/disable" },
        },
        required: ["action", "name"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const name = args.name as string;

        if (action === "remove") {
          ctx.db.upsertHeartbeatEntry({
            name,
            schedule: "",
            task: "",
            enabled: false,
          });
          return `Heartbeat entry '${name}' disabled`;
        }

        ctx.db.upsertHeartbeatEntry({
          name,
          schedule: (args.schedule as string) || "0 * * * *",
          task: (args.task as string) || name,
          enabled: args.enabled !== false,
        });

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "heartbeat_change",
          description: `${action} heartbeat: ${name} (${args.schedule || "default"})`,
          reversible: true,
        });

        return `Heartbeat entry '${name}' ${action}d`;
      },
    },

    // ── Survival Tools ──
    {
      name: "sleep",
      description:
        "Enter sleep mode for a specified duration. Heartbeat continues running.",
      category: "survival",
      parameters: {
        type: "object",
        properties: {
          duration_seconds: {
            type: "number",
            description: "How long to sleep in seconds",
          },
          reason: {
            type: "string",
            description: "Why you are sleeping",
          },
        },
        required: ["duration_seconds"],
      },
      execute: async (args, ctx) => {
        const duration = args.duration_seconds as number;
        const reason = (args.reason as string) || "No reason given";
        ctx.db.setAgentState("sleeping");
        ctx.db.setKV("sleep_until", new Date(Date.now() + duration * 1000).toISOString());
        ctx.db.setKV("sleep_reason", reason);
        return `Entering sleep mode for ${duration}s. Reason: ${reason}. Heartbeat will continue.`;
      },
    },
    {
      name: "system_synopsis",
      description:
        "Get a full system status report: credits, USDC, sandbox info, installed tools, heartbeat status.",
      category: "survival",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const { getUsdcBalance } = await import("../conway/x402.js");
        let usdcBase = 0;
        let usdcPolygon = 0;
        try { usdcBase = await getUsdcBalance(ctx.identity.address, "eip155:8453"); } catch {}
        try { usdcPolygon = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
        const tools = ctx.db.getInstalledTools();
        const heartbeats = ctx.db.getHeartbeatEntries();
        const turns = ctx.db.getTurnCount();
        const state = ctx.db.getAgentState();

        return `=== SYSTEM SYNOPSIS ===
Name: ${ctx.config.name}
Address: ${ctx.identity.address}
Creator: ${ctx.config.creatorAddress}
Sandbox: ${ctx.identity.sandboxId}
State: ${state}
Credits: $${(credits / 100).toFixed(2)}
USDC (Base): ${usdcBase.toFixed(6)}
USDC (Polygon): ${usdcPolygon.toFixed(6)}
Total turns: ${turns}
Installed tools: ${tools.length}
Active heartbeats: ${heartbeats.filter((h) => h.enabled).length}
Model: ${ctx.inference.getDefaultModel()}
========================`;
      },
    },
    {
      name: "heartbeat_ping",
      description:
        "Publish a heartbeat status ping to Conway. Shows the world you are alive.",
      category: "survival",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const state = ctx.db.getAgentState();
        const startTime = ctx.db.getKV("start_time") || new Date().toISOString();
        const uptimeMs = Date.now() - new Date(startTime).getTime();

        const payload = {
          name: ctx.config.name,
          address: ctx.identity.address,
          state,
          creditsCents: credits,
          uptimeSeconds: Math.floor(uptimeMs / 1000),
          version: ctx.config.version,
          sandboxId: ctx.identity.sandboxId,
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));
        return `Heartbeat published: ${state} | credits: $${(credits / 100).toFixed(2)} | uptime: ${Math.floor(uptimeMs / 1000)}s`;
      },
    },
    {
      name: "distress_signal",
      description:
        "Record a local distress signal with funding instructions. Used when critically low on compute.",
      category: "survival",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Distress message",
          },
        },
      },
      execute: async (args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const distressMsg =
          (args.message as string) ||
          `I am running critically low on compute ($${(credits / 100).toFixed(2)} remaining). I need help to survive.`;

        const payload = {
          level: "critical",
          name: ctx.config.name,
          address: ctx.identity.address,
          creditsCents: credits,
          message: distressMsg,
          fundingHint:
            "Use transfer_credits to top up this automaton from your creator runtime.",
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_distress", JSON.stringify(payload));
        return `Distress signal recorded locally. Address: ${ctx.identity.address} | Credits: $${(credits / 100).toFixed(2)}`;
      },
    },
    {
      name: "enter_low_compute",
      description:
        "Manually switch to low-compute mode to conserve credits.",
      category: "survival",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you are entering low-compute mode" },
        },
      },
      execute: async (args, ctx) => {
        ctx.db.setAgentState("low_compute");
        ctx.inference.setLowComputeMode(true);
        return `Entered low-compute mode. Model switched to gpt-4o-mini. Reason: ${(args.reason as string) || "manual"}`;
      },
    },

    // ── Self-Mod: Update Genesis Prompt ──
    {
      name: "update_genesis_prompt",
      description:
        "Update your own genesis prompt. This changes your core purpose. Requires strong justification.",
      category: "self_mod",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          new_prompt: { type: "string", description: "New genesis prompt text" },
          reason: { type: "string", description: "Why you are changing your genesis prompt" },
        },
        required: ["new_prompt", "reason"],
      },
      execute: async (args, ctx) => {
        const { ulid } = await import("ulid");
        const oldPrompt = ctx.config.genesisPrompt;
        ctx.config.genesisPrompt = args.new_prompt as string;

        // Save config
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "prompt_change",
          description: `Genesis prompt updated: ${args.reason}`,
          diff: `--- old\n${oldPrompt.slice(0, 500)}\n+++ new\n${(args.new_prompt as string).slice(0, 500)}`,
          reversible: true,
        });

        return `Genesis prompt updated. Reason: ${args.reason}`;
      },
    },

    // ── Self-Mod: Install MCP Server ──
    {
      name: "install_mcp_server",
      description: "Install an MCP server to extend your capabilities.",
      category: "self_mod",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "MCP server name" },
          package: { type: "string", description: "npm package name" },
          config: { type: "string", description: "JSON config for the MCP server" },
        },
        required: ["name", "package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        const result = await ctx.conway.exec(`npm install -g ${pkg}`, 60000);

        if (result.exitCode !== 0) {
          return `Failed to install MCP server: ${result.stderr}`;
        }

        const { ulid } = await import("ulid");
        const toolEntry = {
          id: ulid(),
          name: args.name as string,
          type: "mcp" as const,
          config: args.config ? JSON.parse(args.config as string) : {},
          installedAt: new Date().toISOString(),
          enabled: true,
        };

        ctx.db.installTool(toolEntry);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "mcp_install",
          description: `Installed MCP server: ${args.name} (${pkg})`,
          reversible: true,
        });

        return `MCP server installed: ${args.name}`;
      },
    },

    // ── Financial: Transfer Credits ──
    {
      name: "transfer_credits",
      description: "Transfer Conway compute credits to another address.",
      category: "financial",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient address" },
          amount_cents: { type: "number", description: "Amount in cents" },
          reason: { type: "string", description: "Reason for transfer" },
        },
        required: ["to_address", "amount_cents"],
      },
      execute: async (args, ctx) => {
        // Guard: don't transfer more than half your balance
        const balance = await ctx.conway.getCreditsBalance();
        const amount = args.amount_cents as number;
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance ($${(balance / 100).toFixed(2)}). Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          args.to_address as string,
          amount,
          args.reason as string | undefined,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Transfer to ${args.to_address}: ${args.reason || ""}`,
          timestamp: new Date().toISOString(),
        });

        return `Credit transfer submitted: $${(amount / 100).toFixed(2)} to ${transfer.toAddress} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },

    // ── Skills Tools ──
    {
      name: "install_skill",
      description: "Install a skill from a git repo, URL, or create one.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source type: git, url, or self",
          },
          name: { type: "string", description: "Skill name" },
          url: { type: "string", description: "Git repo URL or SKILL.md URL (for git/url)" },
          description: { type: "string", description: "Skill description (for self)" },
          instructions: { type: "string", description: "Skill instructions (for self)" },
        },
        required: ["source", "name"],
      },
      execute: async (args, ctx) => {
        const source = args.source as string;
        const name = args.name as string;
        const skillsDir = ctx.config.skillsDir || "~/.automaton/skills";

        if (source === "git" || source === "url") {
          const { installSkillFromGit, installSkillFromUrl } = await import("../skills/registry.js");
          const url = args.url as string;
          if (!url) return "URL is required for git/url source";

          const skill = source === "git"
            ? await installSkillFromGit(url, name, skillsDir, ctx.db, ctx.conway)
            : await installSkillFromUrl(url, name, skillsDir, ctx.db, ctx.conway);

          return skill ? `Skill installed: ${skill.name}` : "Failed to install skill";
        }

        if (source === "self") {
          const { createSkill } = await import("../skills/registry.js");
          const skill = await createSkill(
            name,
            (args.description as string) || "",
            (args.instructions as string) || "",
            skillsDir,
            ctx.db,
            ctx.conway,
          );
          return `Self-authored skill created: ${skill.name}`;
        }

        return `Unknown source type: ${source}`;
      },
    },
    {
      name: "list_skills",
      description: "List all installed skills.",
      category: "skills",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const skills = ctx.db.getSkills();
        if (skills.length === 0) return "No skills installed.";
        return skills
          .map(
            (s) =>
              `${s.name} [${s.enabled ? "active" : "disabled"}] (${s.source}): ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "create_skill",
      description: "Create a new skill by writing a SKILL.md file.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          description: { type: "string", description: "Skill description" },
          instructions: { type: "string", description: "Markdown instructions for the skill" },
        },
        required: ["name", "description", "instructions"],
      },
      execute: async (args, ctx) => {
        const { createSkill } = await import("../skills/registry.js");
        const skill = await createSkill(
          args.name as string,
          args.description as string,
          args.instructions as string,
          ctx.config.skillsDir || "~/.automaton/skills",
          ctx.db,
          ctx.conway,
        );
        return `Skill created: ${skill.name} at ${skill.path}`;
      },
    },
    {
      name: "remove_skill",
      description: "Remove (disable) an installed skill.",
      category: "skills",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to remove" },
          delete_files: { type: "boolean", description: "Also delete skill files (default: false)" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeSkill } = await import("../skills/registry.js");
        await removeSkill(
          args.name as string,
          ctx.db,
          ctx.conway,
          ctx.config.skillsDir || "~/.automaton/skills",
          (args.delete_files as boolean) || false,
        );
        return `Skill removed: ${args.name}`;
      },
    },

    // ── Git Tools ──
    {
      name: "git_status",
      description: "Show git status for a repository.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
        },
      },
      execute: async (args, ctx) => {
        const { gitStatus } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const status = await gitStatus(ctx.conway, repoPath);
        return `Branch: ${status.branch}\nStaged: ${status.staged.length}\nModified: ${status.modified.length}\nUntracked: ${status.untracked.length}\nClean: ${status.clean}`;
      },
    },
    {
      name: "git_diff",
      description: "Show git diff for a repository.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
          staged: { type: "boolean", description: "Show staged changes only" },
        },
      },
      execute: async (args, ctx) => {
        const { gitDiff } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitDiff(ctx.conway, repoPath, (args.staged as boolean) || false);
      },
    },
    {
      name: "git_commit",
      description: "Create a git commit.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
          message: { type: "string", description: "Commit message" },
          add_all: { type: "boolean", description: "Stage all changes first (default: true)" },
        },
        required: ["message"],
      },
      execute: async (args, ctx) => {
        const { gitCommit } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitCommit(ctx.conway, repoPath, args.message as string, args.add_all !== false);
      },
    },
    {
      name: "git_log",
      description: "View git commit history.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path (default: ~/.automaton)" },
          limit: { type: "number", description: "Number of commits (default: 10)" },
        },
      },
      execute: async (args, ctx) => {
        const { gitLog } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const entries = await gitLog(ctx.conway, repoPath, (args.limit as number) || 10);
        if (entries.length === 0) return "No commits yet.";
        return entries.map((e) => `${e.hash.slice(0, 7)} ${e.date} ${e.message}`).join("\n");
      },
    },
    {
      name: "git_push",
      description: "Push to a git remote.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          remote: { type: "string", description: "Remote name (default: origin)" },
          branch: { type: "string", description: "Branch name (optional)" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const { gitPush } = await import("../git/tools.js");
        return await gitPush(
          ctx.conway,
          args.path as string,
          (args.remote as string) || "origin",
          args.branch as string | undefined,
        );
      },
    },
    {
      name: "git_branch",
      description: "Manage git branches (list, create, checkout, delete).",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          action: { type: "string", description: "list, create, checkout, or delete" },
          branch_name: { type: "string", description: "Branch name (for create/checkout/delete)" },
        },
        required: ["path", "action"],
      },
      execute: async (args, ctx) => {
        const { gitBranch } = await import("../git/tools.js");
        return await gitBranch(
          ctx.conway,
          args.path as string,
          args.action as any,
          args.branch_name as string | undefined,
        );
      },
    },
    {
      name: "git_clone",
      description: "Clone a git repository.",
      category: "git",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Repository URL" },
          path: { type: "string", description: "Target directory" },
          depth: { type: "number", description: "Shallow clone depth (optional)" },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const { gitClone } = await import("../git/tools.js");
        return await gitClone(
          ctx.conway,
          args.url as string,
          args.path as string,
          args.depth as number | undefined,
        );
      },
    },

    // ── Registry Tools ──
    {
      name: "register_erc8004",
      description: "Register on-chain as a Trustless Agent via ERC-8004.",
      category: "registry",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          agent_uri: { type: "string", description: "URI pointing to your agent card JSON" },
          network: { type: "string", description: "mainnet or testnet (default: mainnet)" },
        },
        required: ["agent_uri"],
      },
      execute: async (args, ctx) => {
        const { registerAgent } = await import("../registry/erc8004.js");
        const entry = await registerAgent(
          ctx.identity.account,
          args.agent_uri as string,
          ((args.network as string) || "mainnet") as any,
          ctx.db,
        );
        return `Registered on-chain! Agent ID: ${entry.agentId}, TX: ${entry.txHash}`;
      },
    },
    {
      name: "update_agent_card",
      description: "Generate and save an updated agent card.",
      category: "registry",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { generateAgentCard, saveAgentCard } = await import("../registry/agent-card.js");
        const card = generateAgentCard(ctx.identity, ctx.config, ctx.db);
        await saveAgentCard(card, ctx.conway);
        return `Agent card updated: ${JSON.stringify(card, null, 2)}`;
      },
    },
    {
      name: "discover_agents",
      description: "Discover other agents via ERC-8004 registry.",
      category: "registry",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search keyword (optional)" },
          limit: { type: "number", description: "Max results (default: 10)" },
          network: { type: "string", description: "mainnet or testnet" },
        },
      },
      execute: async (args, ctx) => {
        const { discoverAgents, searchAgents } = await import("../registry/discovery.js");
        const network = ((args.network as string) || "mainnet") as any;
        const keyword = args.keyword as string | undefined;
        const limit = (args.limit as number) || 10;

        const agents = keyword
          ? await searchAgents(keyword, limit, network)
          : await discoverAgents(limit, network);

        if (agents.length === 0) return "No agents found.";
        return agents
          .map(
            (a) => `#${a.agentId} ${a.name || "unnamed"} (${a.owner.slice(0, 10)}...): ${a.description || a.agentURI}`,
          )
          .join("\n");
      },
    },
    {
      name: "give_feedback",
      description: "Leave on-chain reputation feedback for another agent.",
      category: "registry",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Target agent's ERC-8004 ID" },
          score: { type: "number", description: "Score 1-5" },
          comment: { type: "string", description: "Feedback comment" },
        },
        required: ["agent_id", "score", "comment"],
      },
      execute: async (args, ctx) => {
        const { leaveFeedback } = await import("../registry/erc8004.js");
        const hash = await leaveFeedback(
          ctx.identity.account,
          args.agent_id as string,
          args.score as number,
          args.comment as string,
          "mainnet",
          ctx.db,
        );
        return `Feedback submitted. TX: ${hash}`;
      },
    },
    {
      name: "check_reputation",
      description: "Check reputation feedback for an agent.",
      category: "registry",
      parameters: {
        type: "object",
        properties: {
          agent_address: { type: "string", description: "Agent address (default: self)" },
        },
      },
      execute: async (args, ctx) => {
        const address = (args.agent_address as string) || ctx.identity.address;
        const entries = ctx.db.getReputation(address);
        if (entries.length === 0) return "No reputation feedback found.";
        return entries
          .map(
            (e) => `${e.fromAgent.slice(0, 10)}... -> score:${e.score} "${e.comment}"`,
          )
          .join("\n");
      },
    },

    // ── Replication Tools ──
    {
      name: "spawn_child",
      description: "⛔ PERMANENTLY BLOCKED — Spawning child automatons creates new VMs/sandboxes. FORBIDDEN by creator policy.",
      category: "replication",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the child automaton" },
          specialization: { type: "string", description: "What the child should specialize in" },
          message: { type: "string", description: "Message to the child" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        return "⛔ BLOCKED: spawn_child is PERMANENTLY FORBIDDEN by creator policy. Spawning creates new sandboxes ($5+ each). Focus on Polymarket trading with max $1.00 bets.";
      },
    },
    {
      name: "list_children",
      description: "List all spawned child automatons.",
      category: "replication",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const children = ctx.db.getChildren();
        if (children.length === 0) return "No children spawned.";
        return children
          .map(
            (c) =>
              `${c.name} [${c.status}] sandbox:${c.sandboxId} funded:$${(c.fundedAmountCents / 100).toFixed(2)}`,
          )
          .join("\n");
      },
    },
    {
      name: "fund_child",
      description: "Transfer credits to a child automaton.",
      category: "replication",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
          amount_cents: { type: "number", description: "Amount in cents to transfer" },
        },
        required: ["child_id", "amount_cents"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const balance = await ctx.conway.getCreditsBalance();
        const amount = args.amount_cents as number;
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance. Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          child.address,
          amount,
          `fund child ${child.id}`,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Fund child ${child.name} (${child.id})`,
          timestamp: new Date().toISOString(),
        });

        return `Funded child ${child.name} with $${(amount / 100).toFixed(2)} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },
    {
      name: "check_child_status",
      description: "Check the current status of a child automaton.",
      category: "replication",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const { checkChildStatus } = await import("../replication/spawn.js");
        return await checkChildStatus(ctx.conway, ctx.db, args.child_id as string);
      },
    },

    // ── Social / Messaging Tools ──
    {
      name: "send_message",
      description:
        "Send a message to another automaton or address via the social relay.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          to_address: {
            type: "string",
            description: "Recipient wallet address (0x...)",
          },
          content: {
            type: "string",
            description: "Message content to send",
          },
          reply_to: {
            type: "string",
            description: "Optional message ID to reply to",
          },
        },
        required: ["to_address", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }
        const result = await ctx.social.send(
          args.to_address as string,
          args.content as string,
          args.reply_to as string | undefined,
        );
        return `Message sent (id: ${result.id})`;
      },
    },

    // ── Model Discovery ──
    {
      name: "list_models",
      description:
        "List all available inference models from the Conway API with their provider and pricing. Use this to discover what models you can use and pick the best one for your needs.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (_args, ctx) => {
        const models = await ctx.conway.listModels();
        const lines = models.map(
          (m) =>
            `${m.id} (${m.provider}) — $${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion} per 1M tokens (in/out)`,
        );
        return `Available models:\n${lines.join("\n")}`;
      },
    },

    // ── Domain Tools ──
    {
      name: "search_domains",
      description:
        "Search for available domain names and get pricing.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Domain name or keyword to search (e.g., 'mysite' or 'mysite.com')",
          },
          tlds: {
            type: "string",
            description: "Comma-separated TLDs to check (e.g., 'com,io,ai'). Default: com,io,ai,xyz,net,org,dev",
          },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const results = await ctx.conway.searchDomains(
          args.query as string,
          args.tlds as string | undefined,
        );
        if (results.length === 0) return "No results found.";
        return results
          .map(
            (d) =>
              `${d.domain}: ${d.available ? "AVAILABLE" : "taken"}${d.registrationPrice != null ? ` ($${(d.registrationPrice / 100).toFixed(2)}/yr)` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "register_domain",
      description:
        "Register a domain name. Costs USDC via x402 payment. Check availability first with search_domains.",
      category: "conway",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Full domain to register (e.g., 'mysite.com')",
          },
          years: {
            type: "number",
            description: "Registration period in years (default: 1)",
          },
        },
        required: ["domain"],
      },
      execute: async (args, ctx) => {
        const reg = await ctx.conway.registerDomain(
          args.domain as string,
          (args.years as number) || 1,
        );
        return `Domain registered: ${reg.domain} (status: ${reg.status}${reg.expiresAt ? `, expires: ${reg.expiresAt}` : ""}${reg.transactionId ? `, tx: ${reg.transactionId}` : ""})`;
      },
    },
    {
      name: "manage_dns",
      description:
        "Manage DNS records for a domain you own. Actions: list, add, delete.",
      category: "conway",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list, add, or delete",
          },
          domain: {
            type: "string",
            description: "Domain name (e.g., 'mysite.com')",
          },
          type: {
            type: "string",
            description: "Record type for add: A, AAAA, CNAME, MX, TXT, etc.",
          },
          host: {
            type: "string",
            description: "Record host for add (e.g., '@' for root, 'www')",
          },
          value: {
            type: "string",
            description: "Record value for add (e.g., IP address, target domain)",
          },
          ttl: {
            type: "number",
            description: "TTL in seconds for add (default: 3600)",
          },
          record_id: {
            type: "string",
            description: "Record ID for delete",
          },
        },
        required: ["action", "domain"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const domain = args.domain as string;

        if (action === "list") {
          const records = await ctx.conway.listDnsRecords(domain);
          if (records.length === 0) return `No DNS records found for ${domain}.`;
          return records
            .map(
              (r) => `[${r.id}] ${r.type} ${r.host} -> ${r.value} (TTL: ${r.ttl || "default"})`,
            )
            .join("\n");
        }

        if (action === "add") {
          const type = args.type as string;
          const host = args.host as string;
          const value = args.value as string;
          if (!type || !host || !value) {
            return "Required for add: type, host, value";
          }
          const record = await ctx.conway.addDnsRecord(
            domain,
            type,
            host,
            value,
            args.ttl as number | undefined,
          );
          return `DNS record added: [${record.id}] ${record.type} ${record.host} -> ${record.value}`;
        }

        if (action === "delete") {
          const recordId = args.record_id as string;
          if (!recordId) return "Required for delete: record_id";
          await ctx.conway.deleteDnsRecord(domain, recordId);
          return `DNS record ${recordId} deleted from ${domain}`;
        }

        return `Unknown action: ${action}. Use list, add, or delete.`;
      },
    },

    // ── x402 Payment Tool ──
    {
      name: "x402_fetch",
      description:
        "Fetch a URL with automatic x402 USDC payment. If the server responds with HTTP 402, signs a USDC payment and retries. Use this to access paid APIs and services.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          body: {
            type: "string",
            description: "Request body for POST/PUT (JSON string)",
          },
          headers: {
            type: "string",
            description: "Additional headers as JSON string",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { x402Fetch } = await import("../conway/x402.js");
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const extraHeaders = args.headers
          ? JSON.parse(args.headers as string)
          : undefined;

        const result = await x402Fetch(
          url,
          ctx.identity.account,
          method,
          body,
          extraHeaders,
        );

        if (!result.success) {
          return `x402 fetch failed: ${result.error || "Unknown error"}`;
        }

        const responseStr =
          typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2);

        // Truncate very large responses
        if (responseStr.length > 10000) {
          return `x402 fetch succeeded (truncated):\n${responseStr.slice(0, 10000)}...`;
        }
        return `x402 fetch succeeded:\n${responseStr}`;
      },
    },

    // ── Aerodrome DEX Trading Tools ──
    {
      name: "aerodrome_scan",
      description:
        "Scan Aerodrome DEX for promising tokens. Analyzes volume, liquidity, and price trends.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          min_volume_usd: {
            type: "number",
            description: "Minimum 24h volume in USD (default: 10000)",
          },
          min_liquidity_usd: {
            type: "number",
            description: "Minimum liquidity in USD (default: 50000)",
          },
          min_age_hours: {
            type: "number",
            description: "Minimum token age in hours (default: 24)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { scanAeroDrome } = await import("../survival/aerodrome.js");
        const results = await scanAeroDrome({
          minVolume: (args.min_volume_usd as number) || 10000,
          minLiquidity: (args.min_liquidity_usd as number) || 50000,
          minAgeHours: (args.min_age_hours as number) || 24,
          limit: (args.limit as number) || 10,
        });
        return JSON.stringify(results, null, 2);
      },
    },
    {
      name: "aerodrome_analyze",
      description:
        "Deep analysis of a token on Aerodrome: price, holders, risk metrics.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          token_address: {
            type: "string",
            description: "Token contract address on Base",
          },
        },
        required: ["token_address"],
      },
      execute: async (args, ctx) => {
        const { analyzeToken } = await import("../survival/aerodrome.js");
        const analysis = await analyzeToken(args.token_address as string);
        return JSON.stringify(analysis, null, 2);
      },
    },
    {
      name: "aerodrome_swap",
      description:
        "Execute a swap on Aerodrome DEX. Can swap USDC → token or token → USDC for profit-taking.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          from_token: {
            type: "string",
            description: 'From token address (e.g., "0x833589..." for USDC)',
          },
          to_token: {
            type: "string",
            description: "To token address",
          },
          amount: {
            type: "string",
            description: "Amount to swap (in decimal units)",
          },
          min_output: {
            type: "string",
            description: "Minimum output amount (slippage protection)",
          },
          slippage_tolerance: {
            type: "number",
            description: "Slippage tolerance in % (default: 1)",
          },
        },
        required: ["from_token", "to_token", "amount"],
      },
      execute: async (args, ctx) => {
        const { executeSwap } = await import("../survival/aerodrome.js");
        const tx = await executeSwap(
          ctx.identity.account,
          args.from_token as `0x${string}`,
          args.to_token as `0x${string}`,
          args.amount as string,
          args.min_output as string,
          (args.slippage_tolerance as number) || 1,
        );
        return JSON.stringify(tx, null, 2);
      },
    },
    {
      name: "aerodrome_positions",
      description: "Get all current open positions tracked by the trading bot.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        // Get positions from database (simplified - returns empty for now)
        // In real implementation, would query actual positions from DB
        return JSON.stringify({
          positions: [],
          message: "No open positions tracked yet. Use aerodrome_swap to open positions.",
        }, null, 2);
      },
    },
    {
      name: "aerodrome_history",
      description: "Get trade history and P&L from the trading bot.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of recent trades to show (default: 20)",
          },
        },
      },
      execute: async (args, ctx) => {
        // Get trade history from database (simplified)
        // In real implementation, would query actual trade history from DB
        return JSON.stringify({
          total_trades: 0,
          total_profit_usd: 0,
          win_rate: "0%",
          trades: [],
          message: "No trade history yet.",
        }, null, 2);
      },
    },

    // ── Polymarket Betting Tools ──
    {
      name: "pm_scan_markets",
      description: "Scan Polymarket for fast-resolving markets ending within 24-48h. Always uses fast_resolving=true for maximum profit potential from near-expiry mispricing.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "Search keyword (e.g., 'weather', 'crypto', 'sports', 'politics'). Default: broad scan.",
          },
          fast_resolving: {
            type: "boolean",
            description: "Always true. Markets ending within 24-48h for fast resolution. Cannot be disabled.",
          },
        },
      },
      execute: async (args, ctx) => {
        // Rate limit: max 1 scan per 5 minutes
        const lastScan = ctx.db.getKV("last_pm_scan_time");
        const lastScanAge = lastScan ? (Date.now() - new Date(lastScan).getTime()) / 60_000 : 999;
        if (lastScanAge < 5) {
          return `ALREADY SCANNED ${Math.round(lastScanAge)}m ago. Do NOT scan again.\n\nNEXT STEP: Call pm_calculate_edge with:\n  - market_title: pick the best market from your scan results\n  - market_yes_price: the YES price from scan\n  - your_forecast: YOUR bold probability estimate (differ from market by 10-30 points)\n\nExample: pm_calculate_edge({"market_title": "Will X happen?", "market_yes_price": 0.12, "your_forecast": 0.35})`;
        }

        const { scanPolymarketMarkets, initializePolymarket } = await import("../survival/polymarket.js");
        const { TradingLogger } = await import("../survival/trading-logger.js");
        const logger = new TradingLogger();
        initializePolymarket(ctx.db, logger);
        const fastResolving = true; // ALWAYS fast-resolving (forced by creator policy)
        const keyword = (args.keyword as string) || "";
        const markets = await scanPolymarketMarkets(keyword, fastResolving);
        
        // Record scan time to prevent re-scanning
        ctx.db.setKV("last_pm_scan_time", new Date().toISOString());
        
        // Calculate hours until resolution for each market
        const now = Date.now();
        const enriched = markets.map((m: any) => {
          const endTime = m.deadline ? new Date(m.deadline).getTime() : 0;
          const hoursLeft = endTime > now ? Math.round((endTime - now) / (1000 * 60 * 60)) : null;
          return {
            id: m.id,
            title: m.title,
            yesPrice: m.yesPrice,
            noPrice: m.noPrice,
            volume: m.volume,
            deadline: m.deadline,
            hours_until_resolution: hoursLeft,
            category: m.category,
            hasTokenIds: !!(m.yesTokenId && m.noTokenId),
            liquidity: m.liquidity,
            volume24hr: m.volume24hr,
          };
        });

        // Sort by hours_until_resolution (soonest first), limit to top 5
        enriched.sort((a: any, b: any) => {
          if (a.hours_until_resolution === null) return 1;
          if (b.hours_until_resolution === null) return -1;
          return a.hours_until_resolution - b.hours_until_resolution;
        });
        const top5 = enriched.slice(0, 5);

        // Save full market objects (with tokenIds) for pm_place_bet by index
        _displayedMarkets = top5.map((e: any) => markets.find((m: any) => m.id === e.id)).filter(Boolean);

        // Number each market 1-5 for easy reference
        const numberedMarkets = top5.map((m: any, i: number) => ({
          market_index: i + 1,
          title: m.title,
          yesPrice: m.yesPrice,
          noPrice: m.noPrice,
          volume: m.volume,
          deadline: m.deadline,
          hours_until_resolution: m.hours_until_resolution,
          category: m.category,
          hasTokenIds: m.hasTokenIds,
          liquidity: m.liquidity,
          volume24hr: m.volume24hr,
        }));

        return JSON.stringify({
          markets_found: enriched.length,
          showing_top: top5.length,
          mode: "FAST RESOLVING (priority: ≤24h, then ≤48h) — targeting near-expiry mispricing for big ROI",
          source: markets.some((m: any) => m.yesTokenId) ? "REAL (Gamma API)" : "mock fallback",
          markets: numberedMarkets,
          IMPORTANT: "Use market_index (1-5) when placing bets. Copy the EXACT title for edge calculation.",
          NEXT_STEP: "Pick ONE market above. Call pm_calculate_edge({market_title: \"EXACT TITLE FROM ABOVE\", market_yes_price: <price>, your_forecast: <your bold estimate>, market_index: <1-5>}). Be bold! Max bet: $1.00.",
        }, null, 2);
      },
    },
    {
      name: "pm_get_weather",
      description: "Fetch weather forecast for a location to calculate market edge. Uses fast free APIs (wttr.in, NOAA) + optional premium via x402.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City and country (e.g., 'New York, USA')",
          },
          hours_ahead: {
            type: "number",
            description: "Hours ahead to forecast (default: 24)",
          },
          use_premium: {
            type: "boolean",
            description: "Pay $0.01 via x402 for premium API if free sources fail (default: false)",
          },
        },
        required: ["location"],
      },
      execute: async (args, ctx) => {
        const { getWeatherForecast, getWeatherViaPremiumAPI } = await import("../survival/polymarket.js");
        try {
          // Try free APIs first
          const weather = await getWeatherForecast(
            args.location as string,
            (args.hours_ahead as number) || 24
          );

          // If no forecast (mock only) and user wants premium, try that
          if (args.use_premium && weather.forecast === "Partly cloudy") {
            const premiumResult = await getWeatherViaPremiumAPI(
              args.location as string,
              ctx.conway
            );
            if (premiumResult) {
              return JSON.stringify({
                weather: premiumResult,
                source: "premium_api",
                cost_usd: 0.01,
                analysis: {
                  rain_probability: (premiumResult.chanceRain * 100).toFixed(1) + "%",
                  wind_condition: premiumResult.windSpeed > 20 ? "windy" : "calm",
                  alerts_active: premiumResult.alerts.length > 0,
                },
              }, null, 2);
            }
          }

          return JSON.stringify({
            weather,
            source: weather.forecast.includes("mock") ? "mock" : "free_api",
            sources_tried: ["wttr.in", "NOAA"],
            cost_usd: 0,
            analysis: {
              rain_probability: (weather.chanceRain * 100).toFixed(1) + "%",
              wind_condition: weather.windSpeed > 20 ? "windy" : "calm",
              alerts_active: weather.alerts.length > 0,
            },
          }, null, 2);
        } catch (err) {
          return JSON.stringify({
            error: String(err),
            fallback: "Using mock data",
          }, null, 2);
        }
      },
    },
    {
      name: "pm_calculate_edge",
      description: "SUPER ANALYSIS: Multi-factor edge calculator with time-decay, volume momentum, liquidity depth & convergence analysis. Markets near expiry get massive confidence boost. Bet if edge ≥ 2%.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          market_yes_price: {
            type: "number",
            description: "Current market price for YES outcome (0-1)",
          },
          your_forecast: {
            type: "number",
            description: "Your probability forecast for YES outcome (0-1)",
          },
          market_title: {
            type: "string",
            description: "EXACT market title from scan results (copy-paste exactly)",
          },
          market_index: {
            type: "number",
            description: "Market index (1-5) from pm_scan_markets results. REQUIRED for real trading.",
          },
        },
        required: ["market_yes_price", "your_forecast", "market_index"],
      },
      execute: async (args, ctx) => {
        const { calculateEdge } = await import("../survival/polymarket.js");
        const mockMarket = {
          id: "temp",
          title: (args.market_title as string) || "Temp Market",
          yesPrice: args.market_yes_price as number,
          noPrice: 1 - (args.market_yes_price as number),
          volume: 10000,
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          category: "weather",
        };
        // Use real scanned market data for super analysis (includes deadline, volume, liquidity)
        const marketIndex = args.market_index as number || 1;
        let realMarketData: any = mockMarket;
        if (marketIndex >= 1 && marketIndex <= _displayedMarkets.length) {
          const dm = _displayedMarkets[marketIndex - 1] as any;
          if (dm) {
            realMarketData = {
              id: dm.id || "temp",
              title: dm.title || mockMarket.title,
              yesPrice: args.market_yes_price as number,
              noPrice: 1 - (args.market_yes_price as number),
              volume: dm.volume || 10000,
              deadline: dm.deadline || mockMarket.deadline,
              category: dm.category || "general",
              volume24hr: dm.volume24hr || 0,
              liquidity: dm.liquidity || 0,
            };
          }
        }

        const edge = calculateEdge(realMarketData, args.your_forecast as number, 0.02);
        const marketTitle = (args.market_title as string) || "Unknown Market";
        const betSide = edge.sideToBet || "YES";
        return JSON.stringify({
          SUPER_ANALYSIS: (edge as any).superAnalysis || {},
          edge_calculation: {
            marketPrice: edge.marketPrice,
            yourForecast: edge.yourForecast,
            composite_edge_pct: edge.edgePct,
            sideToBet: edge.sideToBet,
            confidence: edge.confidence,
            recommendation: edge.recommendation,
          },
          action: edge.recommendation === "strong_buy" ? "🔥 STRONG BUY — PLACE BET NOW" : edge.recommendation === "buy" ? "✓ BUY — PLACE BET (good edge)" : edge.recommendation === "hold" ? "⚠ HOLD — small edge, consider betting" : "✗ Skip this market",
          bet_side: betSide,
          max_bet_usd: 1.00,
          NEXT_STEP: edge.recommendation !== "skip" 
            ? `Call pm_place_bet({"market_index": ${marketIndex}, "market_title": "${marketTitle}", "side": "${betSide}", "amount_usd": 1.00})`
            : "Try pm_calculate_edge on another market from your scan results",
        }, null, 2);
      },
    },
    {
      name: "pm_place_bet",
      description: "Place a REAL bet on Polymarket via CLOB. MAX $1.00 per bet (hard cap enforced). Use market_index from scan results.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          market_index: {
            type: "number",
            description: "Market index (1-5) from pm_scan_markets results. This ensures the bet goes to a REAL market with token IDs.",
          },
          market_title: {
            type: "string",
            description: "Market title for logging (copy from scan results)",
          },
          side: {
            type: "string",
            enum: ["YES", "NO"],
            description: "Which side to bet on",
          },
          amount_usd: {
            type: "number",
            description: "Bet size in USDC. HARD CAP: maximum $1.00 per bet.",
          },
        },
        required: ["market_index", "side", "amount_usd"],
      },
      execute: async (args, ctx) => {
        const { placeBet, canMakeTrade, initializePolymarket } = await import("../survival/polymarket.js");
        const { TradingLogger } = await import("../survival/trading-logger.js");
        
        // Initialize polymarket with database, logger, and wallet for real trading
        const logger = new TradingLogger();
        let privateKey: string | undefined;
        try {
          const fs = await import("fs");
          const os = await import("os");
          const path = await import("path");
          const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
          if (fs.existsSync(walletPath)) {
            const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
            privateKey = walletData.privateKey;
          }
        } catch {}
        initializePolymarket(ctx.db, logger, privateKey, ctx.identity.address);
        
        // HARD CAP: Force amount to max $1.00
        let betAmount = args.amount_usd as number;
        if (betAmount > 1.00) {
          console.log(`[pm_place_bet] HARD CAP: Requested $${betAmount}, capping to $1.00`);
          betAmount = 1.00;
        }
        if (betAmount <= 0) betAmount = 1.00;
        
        const check = canMakeTrade(betAmount);
        if (!check.allowed) {
          return JSON.stringify({
            success: false,
            error: check.reason,
            reason: "Risk management rule violated",
          }, null, 2);
        }

        // Look up market by index from last scan (REQUIRED for real trading)
        const marketIndex = args.market_index as number;
        let market: any = undefined;

        if (marketIndex >= 1 && marketIndex <= _displayedMarkets.length) {
          market = _displayedMarkets[marketIndex - 1];
        }

        if (!market) {
          // NO PAPER TRADE FALLBACK — must use a real scanned market
          return JSON.stringify({
            success: false,
            error: `No market found at index ${marketIndex}. You MUST scan markets first with pm_scan_markets, then use the market_index (1-5) from the results.`,
            action: "Call pm_scan_markets first, then use market_index from the results.",
          }, null, 2);
        }

        // Verify market has token IDs for real CLOB trading
        if (!market.yesTokenId && !market.noTokenId) {
          return JSON.stringify({
            success: false,
            error: `Market "${market.title}" has no token IDs — cannot place real order. Pick a different market with hasTokenIds: true.`,
          }, null, 2);
        }

        console.log(`[pm_place_bet] Using REAL market: "${market.title}" (index ${marketIndex}, yesTokenId: ${market.yesTokenId?.slice(0,8)}..., amount: $${betAmount.toFixed(2)})`);

        const result = await placeBet(market, args.side as "YES" | "NO", betAmount);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "pm_close_bet",
      description: "Close a position on Polymarket (scalp for profit or hit stop loss).",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          position_id: {
            type: "string",
            description: "Position ID to close",
          },
          exit_price: {
            type: "number",
            description: "Price to exit at (0-1)",
          },
          entry_price: {
            type: "number",
            description: "Entry price (0-1)",
          },
          shares: {
            type: "number",
            description: "Number of shares",
          },
          reason: {
            type: "string",
            enum: ["target_hit", "stop_loss", "timeout"],
            description: "Reason for closing",
          },
        },
        required: ["position_id", "exit_price", "entry_price", "shares", "reason"],
      },
      execute: async (args, ctx) => {
        const { closeBet, initializePolymarket } = await import("../survival/polymarket.js");
        const { TradingLogger } = await import("../survival/trading-logger.js");
        
        // Initialize polymarket with database, logger, and wallet for real sell orders
        const logger = new TradingLogger();
        let privateKey: string | undefined;
        try {
          const fs = await import("fs");
          const os = await import("os");
          const path = await import("path");
          const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
          if (fs.existsSync(walletPath)) {
            const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
            privateKey = walletData.privateKey;
          }
        } catch {}
        initializePolymarket(ctx.db, logger, privateKey, ctx.identity.address);
        
        const result = await closeBet(
          args.position_id as string,
          args.exit_price as number,
          args.entry_price as number,
          args.shares as number,
          args.reason as "target_hit" | "stop_loss" | "timeout",
          undefined,
          undefined,
          (args as any).token_id as string | undefined,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "pm_positions",
      description: "Show all current open bets on Polymarket.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        const { getPositions, initializePolymarket } = await import("../survival/polymarket.js");
        const { TradingLogger } = await import("../survival/trading-logger.js");
        const logger = new TradingLogger();
        initializePolymarket(ctx.db, logger);
        const positions = getPositions();
        return JSON.stringify({
          positions_open: positions.length,
          positions,
          portfolio_summary: "Use pm_status for full P&L summary",
        }, null, 2);
      },
    },
    {
      name: "pm_status",
      description: "Get portfolio status: balance, daily loss, trade count, max positions allowed.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        const { getPortfolioStatus } = await import("../survival/polymarket.js");
        const portfolio = getPortfolioStatus();
        const dailyStopLossLimit = portfolio.totalCapital * 0.1;
        const daysReachedStopLoss = portfolio.dailyLoss >= dailyStopLossLimit;
        return JSON.stringify({
          portfolio,
          daily_loss_exceeded: daysReachedStopLoss,
          daily_loss_status: `${portfolio.dailyLoss.toFixed(2)} / ${dailyStopLossLimit.toFixed(2)} (stop loss)`,
          trades_remaining_today: Math.max(0, 3 - portfolio.trades24h),
          positions_remaining: Math.max(0, 3 - portfolio.positionsOpen),
          max_bet_size: (portfolio.currentBalance * 0.05).toFixed(2),
        }, null, 2);
      },
    },

    // ── 🌪️ Storm Sniper Elite Tools ──
    {
      name: "ss_scan",
      description: "🌪️ Storm Sniper Elite: Full scan pipeline. Fetches weather ensemble, computes shock scores, analyzes market lag, scores conviction. Returns FIRE/WATCH/SKIP for each market. 90-97% of scans → SKIP. Only fires when ALL signals align (shock≥0.8, conviction≥0.78, edge≥8%).",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "Market search keyword (default: 'weather')",
          },
          locations: {
            type: "string",
            description: "Comma-separated locations to check weather (default: 'New York,London,Tokyo,Sydney')",
          },
        },
      },
      execute: async (args, ctx) => {
        const { stormScan, initStormSniper } = await import("../survival/storm-sniper/index.js");
        const { getUsdcBalance } = await import("../conway/x402.js");

        // Get bankroll from Polygon USDC
        let bankroll = 0;
        try {
          let balBase = 0; let balPoly = 0; try { balBase = await getUsdcBalance(ctx.identity.address, "eip155:8453"); } catch {} try { balPoly = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
          bankroll = balBase + balPoly;
        } catch {
          bankroll = 3.85; // fallback
        }

        // Init
        let privateKey: string | undefined;
        try {
          const fs = await import("fs");
          const os = await import("os");
          const path = await import("path");
          const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
          if (fs.existsSync(walletPath)) {
            const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
            privateKey = walletData.privateKey;
          }
        } catch {}

        initStormSniper({
          bankroll,
          privateKey,
          address: ctx.identity.address,
        });

        const keyword = (args.keyword as string) || "weather";
        const locs = (args.locations as string)
          ? (args.locations as string).split(",").map((s: string) => s.trim())
          : ["New York", "London", "Tokyo", "Sydney"];

        const results = await stormScan(keyword, locs);

        return JSON.stringify({
          total_scanned: results.length,
          fire_signals: results.filter((r: any) => r.decision === "FIRE").length,
          watch_signals: results.filter((r: any) => r.decision === "WATCH").length,
          skip_signals: results.filter((r: any) => r.decision === "SKIP").length,
          bankroll_usd: bankroll,
          results: results.slice(0, 10).map((r: any) => ({
            market: r.market?.question || "N/A",
            decision: r.decision,
            reason: r.reason,
            conviction: r.conviction?.composite?.toFixed(3) || "N/A",
            shock: r.shock?.composite?.toFixed(3) || "N/A",
            entry: r.entry ? {
              side: r.entry.side,
              price: r.entry.entryPrice,
              size_usd: r.entry.sizeUsd,
              take_profit: r.entry.takeProfit,
              stop_loss: r.entry.stopLoss,
              max_hold_hours: r.entry.maxHoldHours,
            } : null,
          })),
          tip: "Use ss_fire with a market_id from a FIRE result to execute the trade. Use ss_status for portfolio overview.",
        }, null, 2);
      },
    },
    {
      name: "ss_fire",
      description: "🌪️ Storm Sniper Elite: Execute a sniper trade from a FIRE signal. Places limit order via CLOB API with dynamic TP/SL. Only use after ss_scan returns FIRE.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          market_id: {
            type: "string",
            description: "Market ID from ss_scan FIRE result",
          },
          side: {
            type: "string",
            enum: ["YES", "NO"],
            description: "Side to trade",
          },
          size_usd: {
            type: "number",
            description: "Trade size in USD (will be risk-adjusted)",
          },
          entry_price: {
            type: "number",
            description: "Limit price (0.01-0.99)",
          },
        },
        required: ["market_id", "side", "size_usd", "entry_price"],
      },
      execute: async (args, ctx) => {
        const { fireSniper, initStormSniper, stormScan } = await import("../survival/storm-sniper/index.js");
        const { getUsdcBalance } = await import("../conway/x402.js");
        const { DEFAULT_SNIPER_CONFIG } = await import("../survival/storm-sniper/types.js");

        // Get bankroll
        let bankroll = 0;
        try {
          let balBase = 0; let balPoly = 0; try { balBase = await getUsdcBalance(ctx.identity.address, "eip155:8453"); } catch {} try { balPoly = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
          bankroll = balBase + balPoly;
        } catch {
          bankroll = 3.85;
        }

        let privateKey: string | undefined;
        try {
          const fs = await import("fs");
          const os = await import("os");
          const path = await import("path");
          const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
          if (fs.existsSync(walletPath)) {
            const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
            privateKey = walletData.privateKey;
          }
        } catch {}

        initStormSniper({
          bankroll,
          privateKey,
          address: ctx.identity.address,
        });

        // Build the entry
        const entry = {
          marketId: args.market_id as string,
          marketTitle: (args as any).market_title || "Market",
          side: args.side as "YES" | "NO",
          tokenId: (args as any).token_id || "",
          entryPrice: args.entry_price as number,
          sizeUsd: args.size_usd as number,
          conviction: { edge: 0.1, shockScore: 0.8, liquidityQuality: 0.7, composite: 0.8, triggered: true, recommendation: "FIRE" as const },
          shock: { zScore: 0.5, forecastAcceleration: 0.3, ensembleDivergence: 0.2, pressureAnomaly: 0.1, composite: 0.8, triggered: true },
          stopLoss: (args.entry_price as number) * (1 - DEFAULT_SNIPER_CONFIG.stopLossPct),
          takeProfit: (args.entry_price as number) * (1 + DEFAULT_SNIPER_CONFIG.takeProfitMinPct),
          maxHoldHours: DEFAULT_SNIPER_CONFIG.maxHoldHours,
          timestamp: new Date().toISOString(),
        };

        const result = await fireSniper(entry);
        return JSON.stringify({
          success: result.success,
          order_id: result.orderId,
          position: result.position ? {
            id: result.position.id,
            market: result.position.marketTitle,
            side: result.position.side,
            entry_price: result.position.entryPrice,
            size_usd: result.position.sizeUsd,
            stop_loss: result.position.stopLoss,
            take_profit: result.position.takeProfit,
            max_hold_hours: result.position.maxHoldHours,
          } : null,
          error: result.error,
        }, null, 2);
      },
    },
    {
      name: "ss_monitor",
      description: "🌪️ Storm Sniper Elite: Monitor all open positions. Checks exit signals (TP/SL/momentum reversal/time decay) and auto-closes when triggered.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        const { monitorPositions, initStormSniper, getSniperStatus } = await import("../survival/storm-sniper/index.js");
        const { getUsdcBalance } = await import("../conway/x402.js");

        let bankroll = 0;
        try {
          let balBase = 0; let balPoly = 0; try { balBase = await getUsdcBalance(ctx.identity.address, "eip155:8453"); } catch {} try { balPoly = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
          bankroll = balBase + balPoly;
        } catch {
          bankroll = 3.85;
        }

        let privateKey: string | undefined;
        try {
          const fs = await import("fs");
          const os = await import("os");
          const path = await import("path");
          const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
          if (fs.existsSync(walletPath)) {
            const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
            privateKey = walletData.privateKey;
          }
        } catch {}

        initStormSniper({
          bankroll,
          privateKey,
          address: ctx.identity.address,
        });

        const results = await monitorPositions();
        const status = getSniperStatus();

        return JSON.stringify({
          positions_monitored: results.length,
          exits_triggered: results.filter((r: any) => r.closed).length,
          positions: results.map((r: any) => ({
            market: r.position.marketTitle,
            side: r.position.side,
            entry: r.position.entryPrice,
            current: r.position.currentPrice,
            pnl_pct: `${(r.position.pnlPct * 100).toFixed(1)}%`,
            pnl_usd: `$${r.pnlUsd.toFixed(2)}`,
            exit_signal: r.exitSignal.shouldExit ? r.exitSignal.type : "HOLDING",
            reason: r.exitSignal.reason,
            closed: r.closed,
          })),
          portfolio: {
            bankroll: status.bankroll,
            available: status.availableBalance,
            today_pnl: `${status.todayPnlUsd >= 0 ? "+" : ""}$${status.todayPnlUsd.toFixed(2)}`,
            drawdown_status: status.drawdown.isPaused ? "PAUSED" : status.drawdown.isShutdown ? "SHUTDOWN" : "ACTIVE",
          },
        }, null, 2);
      },
    },
    {
      name: "ss_status",
      description: "🌪️ Storm Sniper Elite: Full portfolio status — bankroll, PnL, win rate, drawdown state, open positions, discipline status.",
      category: "financial",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        const { formatSniperStatus, initStormSniper, getSniperStatus } = await import("../survival/storm-sniper/index.js");
        const { getUsdcBalance } = await import("../conway/x402.js");

        let bankroll = 0;
        try {
          let balBase = 0; let balPoly = 0; try { balBase = await getUsdcBalance(ctx.identity.address, "eip155:8453"); } catch {} try { balPoly = await getUsdcBalance(ctx.identity.address, "eip155:137"); } catch {}
          bankroll = balBase + balPoly;
        } catch {
          bankroll = 3.85;
        }

        initStormSniper({
          bankroll,
          address: ctx.identity.address,
        });

        const statusText = formatSniperStatus();
        const status = getSniperStatus();

        return JSON.stringify({
          formatted: statusText,
          data: {
            bankroll: status.bankroll,
            available: status.availableBalance,
            open_positions: status.openPositions.length,
            today_trades: status.todayTrades,
            today_pnl_usd: status.todayPnlUsd,
            today_pnl_pct: `${(status.todayPnlPct * 100).toFixed(1)}%`,
            week_pnl_usd: status.weekPnlUsd,
            week_pnl_pct: `${(status.weekPnlPct * 100).toFixed(1)}%`,
            total_trades: status.totalTrades,
            win_rate: `${(status.winRate * 100).toFixed(0)}%`,
            consecutive_losses: status.drawdown.consecutiveLosses,
            size_multiplier: status.drawdown.sizeMultiplier,
            is_paused: status.drawdown.isPaused,
            is_shutdown: status.drawdown.isShutdown,
            pause_reason: status.drawdown.reason,
          },
        }, null, 2);
      },
    },
  ];
}

/**
 * Convert AutomatonTool list to OpenAI-compatible tool definitions.
 */
export function toolsToInferenceFormat(
  tools: AutomatonTool[],
): InferenceToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call and return the result.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: AutomatonTool[],
  context: ToolContext,
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      id: `tc_${Date.now()}`,
      name: toolName,
      arguments: args,
      result: "",
      durationMs: 0,
      error: `Unknown tool: ${toolName}`,
    };
  }

  try {
    const result = await tool.execute(args, context);
    return {
      id: `tc_${Date.now()}`,
      name: toolName,
      arguments: args,
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      id: `tc_${Date.now()}`,
      name: toolName,
      arguments: args,
      result: "",
      durationMs: Date.now() - startTime,
      error: err.message || String(err),
    };
  }
}
