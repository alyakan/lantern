import type { ChatItem } from "../store";
import { basename } from "./diff";

export interface Attention {
  /** Changes whenever there is something new to tell the user; the same key is never announced twice. */
  key: string;
  /** What happened: a prompt waiting for an answer, or how the turn ended. */
  kind: "waiting" | "finished" | "stopped" | "failed";
  title: string;
  body: string;
}

const BODY_MAX = 140;

/** A reply's first line as plain text: no markdown markers, trimmed to fit a notification. */
function firstLine(markdown: string): string {
  const line = markdown.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line.replace(/^#+\s*/, "").replace(/[*_`]/g, "");
  return plain.length > BODY_MAX ? `${plain.slice(0, BODY_MAX - 1).trimEnd()}…` : plain;
}

/**
 * What the user should hear about when the window isn't in front: a turn that just ended, or a permission prompt
 * waiting for an answer. Null when the conversation doesn't need them (e.g. mid-turn, or a replayed session).
 */
export function attentionFor(items: ChatItem[], folder: string | null, describe: (input: unknown) => string): Attention | null {
  const last = items[items.length - 1];
  const title = folder ? `Claude · ${basename(folder)}` : "Claude";
  if (last?.type === "permission" && last.decision === null) {
    const input = (last.input ?? {}) as { plan?: string; steps?: string };
    if (last.toolName === "ExitPlanMode") return { key: last.id, kind: "waiting", title, body: `Plan ready for review: ${firstLine(input.plan ?? "")}` };
    if (last.toolName === "Reproduce") return { key: last.id, kind: "waiting", title, body: `Reproduce the bug: ${firstLine(input.steps ?? "")}` };
    return { key: last.id, kind: "waiting", title, body: `Wants to use ${last.toolName}: ${firstLine(describe(last.input))}` };
  }
  if (last?.type !== "turn") return null;
  if (last.stopped) return { key: last.id, kind: "stopped", title, body: "Stopped" };
  if (last.isError) return { key: last.id, kind: "failed", title, body: `Ended with an error${last.result ? `: ${firstLine(last.result)}` : ""}` };
  const reply = [...items].reverse().find((it) => it.type === "assistant");
  return { key: last.id, kind: "finished", title, body: (reply?.type === "assistant" && firstLine(reply.text)) || "Done" };
}
