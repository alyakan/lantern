import { isBusy } from "../sessions";
import type { State } from "../store";
import { FULL_AT, WARN_AT } from "../components/ContextMeter";
import { nodeStatus } from "./orchestraView";

/**
 * A chat's context window, or null when nothing says. Said by: the window the CLI reported for this chat's model (kept by
 * model, so another chat on the same model that has finished a turn counts, and so does this chat's earlier turn before a
 * model change), or the model's own name when it is the 1M one (`[1m]`). Never a guess: a window below what the chat already
 * holds is wrong, so it isn't said either.
 */
export function windowOf(s: Pick<State, "model" | "contextWindow" | "contextUsed">, known: Record<string, number> = {}): number | null {
  const model = s.model;
  const window = (model && known[model]) || s.contextWindow || (model && /\[1m\]/i.test(model) ? 1_000_000 : null) || null;
  return window !== null && s.contextUsed !== null && s.contextUsed > window ? null : window;
}

/** "Compact all" compacts the agents using more of their context than this. */
export const COMPACT_ALL_AT = 60;

export interface ContextShare {
  used: number;
  /** Null while nothing says what the window is: then there is no percent and no warning, only the tokens used. */
  window: number | null;
  /** Of the window, whole percent, never over 100; null with no window. */
  percent: number | null;
  /** Amber and red from the same points the chat's own meter warns at. */
  level: "warn" | "full" | null;
}

/** How full an agent's context is now; null before its first reply says. */
export function contextShare(s: State | undefined, known: Record<string, number> = {}): ContextShare | null {
  const used = s?.contextUsed;
  if (!s || used === null || used === undefined) return null;
  const window = windowOf(s, known);
  if (window === null) return { used, window: null, percent: null, level: null };
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
