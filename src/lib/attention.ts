import type { ChatItem } from "../store";
import { basename } from "./diff";
import { QUESTION_TOOL, readQuestions } from "./questions";

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
export function attentionFor(items: ChatItem[], folder: string | null, describe: (input: unknown) => string, agent = "Claude"): Attention | null {
  const last = items[items.length - 1];
  const title = folder ? `${agent} · ${basename(folder)}` : agent;
  if (last?.type === "permission" && last.decision === null) {
    const input = (last.input ?? {}) as { plan?: string; steps?: string; action?: unknown };
    if (last.toolName === "ExitPlanMode") return { key: last.id, kind: "waiting", title, body: `Plan ready for review: ${firstLine(input.plan ?? "")}` };
    if (last.toolName === "Approval") return { key: last.id, kind: "waiting", title, body: `Approval needed${typeof input.action === "string" && input.action.trim() ? `: ${firstLine(input.action)}` : ""}` };
    if (last.toolName === "Reproduce") return { key: last.id, kind: "waiting", title, body: `Reproduce the bug: ${firstLine(input.steps ?? "")}` };
    if (last.toolName === QUESTION_TOOL) {
      // Claude's question: the question itself, not the tool it asks with.
      const [first, ...more] = readQuestions(last.input);
      if (first) return { key: last.id, kind: "waiting", title, body: `Question: ${firstLine(first.question)}${more.length ? ` (+${more.length} more)` : ""}` };
      return { key: last.id, kind: "waiting", title, body: "Has a question for you" };
    }
    return { key: last.id, kind: "waiting", title, body: `Wants to use ${last.toolName}: ${firstLine(describe(last.input))}` };
  }
  if (last?.type !== "turn") return null;
  if (last.stopped) return { key: last.id, kind: "stopped", title, body: "Stopped" };
  if (last.isError) return { key: last.id, kind: "failed", title, body: `Ended with an error${last.result ? `: ${firstLine(last.result)}` : ""}` };
  // This turn's reply only: a turn that just ran tools has none, and an earlier turn's reply isn't news.
  const turnStart = items.map((it) => it.type).lastIndexOf("user");
  const reply = items.slice(turnStart + 1).reverse().find((it) => it.type === "assistant");
  return { key: last.id, kind: "finished", title, body: (reply?.type === "assistant" && firstLine(reply.text)) || "Done" };
}
