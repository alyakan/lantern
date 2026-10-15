import { isBusy } from "../sessions";
import type { State } from "../store";
import { FULL_AT, WARN_AT } from "../components/ContextMeter";
import { nodeStatus } from "./orchestraView";

/** A chat's window when it hasn't said (before its first turn ends): what the chat's own meter assumes. */
export const DEFAULT_WINDOW = 200_000;
/** "Compact all" compacts the agents using more of their context than this. */
export const COMPACT_ALL_AT = 60;

export interface ContextShare {
  used: number;
  window: number;
  /** Of the window, whole percent, never over 100. */
  percent: number;
  /** Amber and red from the same points the chat's own meter warns at. */
  level: "warn" | "full" | null;
}

/** How full an agent's context is now; null before its first reply says. */
export function contextShare(s: State | undefined): ContextShare | null {
  const used = s?.contextUsed;
  if (!s || used === null || used === undefined) return null;
  const window = s.contextWindow || DEFAULT_WINDOW;
  const percent = Math.round(Math.min(used / window, 1) * 100);
  return { used, window, percent, level: percent >= FULL_AT ? "full" : percent >= WARN_AT ? "warn" : null };
}

/** Why Compact and Clear can't be used on this agent now, or null when they can: they are sent as messages, which an agent mid-turn would only queue. */
export function tidyBlock(s: State): string | null {
  if (s.status === "ended") return "It has stopped";
  const status = nodeStatus(s);
  return isBusy(s) || (status !== "idle" && status !== "held") ? "Wait until it has finished its turn" : null;
}

/** "190k", "1.2M": a token count short enough for a row. */
export function shortTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
