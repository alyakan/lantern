import { useEffect, useState } from "react";
import { api } from "../api";

/** How many workers may run at once across all of Lantern (every team, every project): they all spend one plan. */
const KEY = "lantern.agentLimit";
const CHANGED = "lantern-agent-limit";
export const AGENT_LIMIT_DEFAULT = 3;
export const AGENT_LIMIT_MIN = 1;
export const AGENT_LIMIT_MAX = 6;

export function agentLimit(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isInteger(n) && n >= AGENT_LIMIT_MIN && n <= AGENT_LIMIT_MAX ? n : AGENT_LIMIT_DEFAULT;
  } catch {
    return AGENT_LIMIT_DEFAULT;
  }
}

/** Tells the backend the limit, which is where spawn_agent checks it. Done when the window starts and on every change. */
export function pushAgentLimit(): Promise<void> {
  return api.setAgentLimit(agentLimit()).catch(() => {});
}

export function setAgentLimit(n: number): void {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
  void api.setAgentLimit(n).catch(() => {});
}

/** The limit, kept in step with every place that changes it. */
export function useAgentLimit(): number {
  const [n, setN] = useState(agentLimit);
  useEffect(() => {
    const sync = () => setN(agentLimit());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return n;
}
