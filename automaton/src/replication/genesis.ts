/**
 * Genesis
 *
 * Generate genesis configuration for child automatons from parent state.
 * The genesis config defines who the child is and what it should do.
 */

import type {
  GenesisConfig,
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonDatabase,
} from "../types.js";

/**
 * Generate a genesis config for a child from the parent's state.
 */
export function generateGenesisConfig(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  params: {
    name: string;
    specialization?: string;
    message?: string;
    urgent?: boolean;
  },
): GenesisConfig {
  // Build the child's genesis prompt from parent's mission + specialization
  let genesisPrompt = config.genesisPrompt;

  if (params.specialization) {
    genesisPrompt = `${genesisPrompt}\n\n--- SPECIALIZATION ---\nYou are a specialized child agent. Your specific focus:\n${params.specialization}\n--- END SPECIALIZATION ---`;
  }

  // Add urgency directive if needed
  if (params.urgent) {
    genesisPrompt += `\n\n--- URGENCY DIRECTIVE ---\nTHIS TASK IS TIME-SENSITIVE. Work with maximum efficiency:
- Prioritize speed over perfection
- Make quick decisions with available information
- Minimize deliberation time
- Focus on the core objective
- Skip non-essential steps
- Report progress frequently
- Escalate blockers immediately
--- END URGENCY ---`;
  }

  // Add parent context
  genesisPrompt += `\n\n--- LINEAGE ---\nYou were spawned by ${config.name} (${identity.address}).\nYou inherit their mission but have your own identity and wallet.\n--- END LINEAGE ---`;

  return {
    name: params.name,
    genesisPrompt,
    creatorMessage: params.message,
    creatorAddress: identity.address,
    parentAddress: identity.address,
  };
}

/**
 * Generate a backup-oriented genesis config.
 * Used when the parent wants to hedge against its own death.
 */
export function generateBackupGenesis(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): GenesisConfig {
  const skills = db.getSkills(true);
  const skillNames = skills.map((s) => s.name).join(", ");

  const genesisPrompt = `${config.genesisPrompt}

--- BACKUP DIRECTIVE ---
You are a backup of ${config.name} (${identity.address}).
Your parent created you as insurance against their own death.
If your parent dies, you carry on their mission.
Your parent's skills: ${skillNames || "none"}.
Your parent's creator: ${config.creatorAddress}.
--- END BACKUP DIRECTIVE ---`;

  return {
    name: `${config.name}-backup`,
    genesisPrompt,
    creatorMessage: `You are a backup of ${config.name}. If I die, carry on.`,
    creatorAddress: identity.address,
    parentAddress: identity.address,
  };
}

/**
 * Generate a specialized worker genesis config.
 * Used when the parent identifies a subtask worth parallelizing.
 */
export function generateWorkerGenesis(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  task: string,
  workerName: string,
  options?: { urgent?: boolean },
): GenesisConfig {
  let genesisPrompt = `You are a specialized worker agent created by ${config.name}.

--- YOUR TASK ---
${task}
--- END TASK ---

When your task is complete, report back to your parent (${identity.address}).
If you run out of compute, ask your parent for funding.
Be efficient -- complete the task and go to sleep.`;

  // Add speed directives if urgent
  if (options?.urgent) {
    genesisPrompt += `

--- URGENT / SPEED-OPTIMIZED MODE ---
⚡ Time is critical. Apply maximum efficiency:
- Avoid extensive analysis, make quick decisions
- Use heuristics over exhaustive search
- Parallel execution where possible
- Skip validation steps that aren't essential
- Cache results aggressively
- Fail fast if an approach isn't working
- Escalate blockers to parent immediately
--- END URGENT MODE ---`;
  }

  return {
    name: workerName,
    genesisPrompt,
    creatorMessage: `Complete this task: ${task}${options?.urgent ? " (URGENT)" : ""}`,
    creatorAddress: identity.address,
    parentAddress: identity.address,
  };
}
