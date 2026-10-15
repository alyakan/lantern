import type { Mode } from "../types";

/**
 * A chat has two settings. Permissions: Ask (edits apply, everything else asks you) or Auto (Claude Code's classifier
 * decides). Workflow: Chat (a plain conversation), Step by step (one page at a time, in a flavour) or Team (a Lead runs
 * agents). Permissions mean the same in every workflow.
 */
export type Permissions = "ask" | "auto";
export type Workflow = "chat" | "steps" | "team";

export const PERMISSIONS_LABEL: Record<Permissions, string> = { ask: "Ask", auto: "Auto" };
export const WORKFLOW_LABEL: Record<Workflow, string> = { chat: "Chat", steps: "Step by step", team: "Team" };

/** Where a Team's subagents (the Lead's built-in helpers) run. A chat that isn't a Team's Lead always runs them inline. */
export type Subagents = "canvas" | "inline";
export const SUBAGENTS_LABEL: Record<Subagents, string> = { canvas: "On the canvas", inline: "Inline" };

/** What a chat holds of both settings: Lantern's launch mode, Step by step's auto-approve, and whether it leads a team. */
export interface Setting {
  mode: Mode;
  autoApprove: boolean;
  orchestrator: boolean;
}

/** Auto on every workflow: the mode itself, or Step by step with auto-approve (Auto's permissions, with pages). */
export const permissionsOf = (s: Pick<Setting, "mode" | "autoApprove">): Permissions => (s.mode === "auto" || (s.mode === "steps" && s.autoApprove) ? "auto" : "ask");

/** A team's Lead is in Team; Step by step is its own workflow (a Lead can't be in both); everything else is a Chat. */
export const workflowOf = (s: Pick<Setting, "mode" | "orchestrator">): Workflow => (s.mode === "steps" ? "steps" : s.orchestrator ? "team" : "chat");

/** The launch mode for a pair of settings. Chat and Team take Permissions as their mode; Step by step keeps it as auto-approve. */
export function launchOf(permissions: Permissions, workflow: Workflow): { mode: Mode; autoApprove: boolean; team: boolean } {
  return workflow === "steps" ? { mode: "steps", autoApprove: permissions === "auto", team: false } : { mode: permissions, autoApprove: false, team: workflow === "team" };
}

/** "Ask · Chat": both settings as a line, for a title attribute or a header. */
export const settingLine = (s: Setting) => `${PERMISSIONS_LABEL[permissionsOf(s)]} · ${WORKFLOW_LABEL[workflowOf(s)]}`;

/** What a saved mode string is: older Lanterns saved only the mode, and Step by step's auto-approve was kept apart. */
export const STEPS_AUTO = "steps:auto";
export const savedModeOf = (s: Pick<Setting, "mode" | "autoApprove">): string => (s.mode === "steps" && s.autoApprove ? STEPS_AUTO : s.mode);

const MODE_KEY = "settings.modeByFolder";
const AUTO_KEY = "settings.autoApproveByFolder";
const TEAM_KEY = "settings.orchestraModeByFolder";
export const PERMISSIONS_KEY = "settings.permissionsByFolder";
export const WORKFLOW_KEY = "settings.workflowByFolder";

const readRecord = <T>(storage: Storage, key: string): Record<string, T> => {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
};

/**
 * Moves what older Lanterns saved per project (one mode, Step by step's auto-approve, and how a team ran) into the two
 * settings: a project that had Step by step with auto-approve on is now Workflow Step by step with Permissions Auto.
 * What the project already has under the new keys wins; the old keys are removed. Safe to run on every launch.
 */
export function migrateModeSettings(storage: Storage): void {
  const modes = readRecord<string>(storage, MODE_KEY);
  const auto = readRecord<boolean>(storage, AUTO_KEY);
  const teams = readRecord<string>(storage, TEAM_KEY);
  if (!Object.keys(modes).length && !Object.keys(auto).length && !Object.keys(teams).length) {
    for (const key of [MODE_KEY, AUTO_KEY, TEAM_KEY]) storage.removeItem(key);
    return;
  }
  const permissions = readRecord<Permissions>(storage, PERMISSIONS_KEY);
  const workflows = readRecord<Workflow>(storage, WORKFLOW_KEY);
  for (const folder of new Set([...Object.keys(modes), ...Object.keys(auto), ...Object.keys(teams)])) {
    const mode = modes[folder];
    const steps = mode === "steps";
    // Debug, Teach and Review were modes of their own once: they are Step by step too (see savedMode).
    const stepsLike = steps || mode === "debug" || mode === "teach" || mode === "review";
    if (!(folder in workflows) && mode !== undefined) workflows[folder] = stepsLike ? "steps" : "chat";
    if (!(folder in permissions)) {
      const wasAuto = mode === "auto" || (stepsLike && auto[folder] === true) || (mode === undefined && teams[folder] === "auto");
      if (mode !== undefined || teams[folder] !== undefined || auto[folder] !== undefined) permissions[folder] = wasAuto ? "auto" : "ask";
    }
  }
  try {
    storage.setItem(PERMISSIONS_KEY, JSON.stringify(permissions));
    storage.setItem(WORKFLOW_KEY, JSON.stringify(workflows));
    for (const key of [MODE_KEY, AUTO_KEY, TEAM_KEY]) storage.removeItem(key);
  } catch {
    // storage is full or unavailable: the old keys stay, and it is tried again next launch
  }
}
