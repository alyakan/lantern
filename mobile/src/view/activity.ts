/**
 * What Claude is doing right now, in a few words, for the line under a working chat: the step it is in ("Running npm test",
 * "Editing HomeScreen.tsx"), writing, thinking, or the user's post-hook. Read from the current turn's items only.
 */
import type { Item } from "../sync/reducer";

type Step = Extract<Item, { kind: "step" }>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The last part of a path: "src/view/home.ts" is "home.ts". */
const base = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;

/** One step as what is being done. */
export function stepActivity(s: Pick<Step, "name" | "summary">): string {
  const what = s.summary.trim();
  switch (s.name) {
    case "Bash":
    case "BashOutput":
      return what ? `Running ${clip(what, 48)}` : "Running a command";
    case "Read":
      return what ? `Reading ${base(what)}` : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return what ? `Editing ${base(what)}` : "Editing a file";
    case "Grep":
    case "Glob":
      return "Searching the code";
    case "WebSearch":
    case "WebFetch":
      return "Looking it up";
    case "Agent":
    case "Task":
      return what ? `Running a helper: ${clip(what, 40)}` : "Running a helper";
    case "Skill":
      return what ? `Using ${clip(what, 40)}` : "Using a skill";
    case "advisor":
      return "Asking the advisor";
    case "TodoWrite":
      return "Updating the plan";
  }
  const mcp = /^mcp__(.+?)__/.exec(s.name);
  if (mcp) {
    const server = mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
    return `Using ${server.charAt(0).toUpperCase()}${server.slice(1)}`;
  }
  return s.name ? `Using ${s.name}` : "Working";
}

/** What the chat is doing now: the newest of its current turn's steps still going, its words while they stream, else thinking. */
export function activityOf(items: Item[], thinking: boolean): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user" || it.kind === "turn") break;
    if (it.kind === "step" && !it.done) return stepActivity(it);
    if (it.kind === "assistant" && it.streaming) return "Writing";
    if (it.kind === "hook") return "Running your post-hook";
  }
  return thinking ? "Thinking" : "Working";
}

/** How long it has been at it: "12 s", "3 min", "1 h 5 min". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
