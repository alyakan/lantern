/**
 * A chat as the phone draws it: the reducer's items, with each run of steps folded into one row of chips, and each
 * Step-by-step page marked live when it is the one that can still be answered.
 */
import type { Item } from "../sync/reducer";
import { livePage, readPage, type Page } from "./pages";

export interface StepChip {
  key: string;
  label: string;
  tone: "plain" | "ok" | "bad";
  /** The files an edit chip stands for: a tap lists their diffs. */
  files?: string[];
  /** What a grouped chip stands for ("Ran 5 commands"): a tap lists them, one line each. */
  items?: { text: string; bad: boolean; /** The step's id, to ask what it printed. */ id: string }[];
}

export type Row =
  | { key: string; kind: "user"; item: Extract<Item, { kind: "user" }> }
  | { key: string; kind: "assistant"; item: Extract<Item, { kind: "assistant" }> }
  | { key: string; kind: "page"; item: Extract<Item, { kind: "assistant" }>; page: Page; live: boolean }
  | { key: string; kind: "summary"; item: Extract<Item, { kind: "assistant" }>; chips: StepChip[]; durationMs: number | null }
  | { key: string; kind: "steps"; chips: StepChip[] }
  | { key: string; kind: "prompt"; item: Extract<Item, { kind: "prompt" }> }
  | { key: string; kind: "desktop"; item: Extract<Item, { kind: "desktop" }> }
  | { key: string; kind: "turn"; item: Extract<Item, { kind: "turn" }> }
  | { key: string; kind: "shell"; item: Extract<Item, { kind: "shell" }> };

type Step = Extract<Item, { kind: "step" }>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One row of chips for a run of steps. */
export function stepChips(steps: Step[]): StepChip[] {
  const chips: StepChip[] = [];
  const named = (...names: string[]) => steps.filter((s) => names.includes(s.name));
  const reads = named("Read");
  if (reads.length) chips.push({ key: "read", label: `Read ${plural(reads.length, "file")}`, tone: "plain" });
  const searches = named("Grep", "Glob", "WebSearch", "WebFetch");
  if (searches.length) chips.push({ key: "search", label: searches.every((s) => s.name.startsWith("Web")) ? `Looked up ${plural(searches.length, "page")}` : `Searched ${plural(searches.length, "time")}`, tone: "plain" });

  const edits = new Map<string, { added: number; removed: number }>();
  for (const s of steps) for (const e of s.edits) edits.set(e.path, { added: (edits.get(e.path)?.added ?? 0) + e.added, removed: (edits.get(e.path)?.removed ?? 0) + e.removed });
  if (edits.size) {
    const [added, removed] = [...edits.values()].reduce<[number, number]>(([a, r], e) => [a + e.added, r + e.removed], [0, 0]);
    chips.push({ key: "edits", label: `Edited ${plural(edits.size, "file")} +${added} −${removed}`, tone: "plain", files: [...edits.keys()] });
  }

  const tested = steps.filter((s) => s.tests);
  if (tested.length) {
    const t = tested.reduce((n, s) => ({ passed: n.passed + s.tests!.passed, failed: n.failed + s.tests!.failed }), { passed: 0, failed: 0 });
    chips.push(t.failed > 0 ? { key: "tests", label: `${t.failed} failed, ${t.passed} passed`, tone: "bad" } : { key: "tests", label: `${plural(t.passed, "test")} passed`, tone: "ok" });
  }

  // What is left is grouped by kind, as the desktop's summary line is ("Ran 5 commands, used 2 skills"), each group
  // opening to its steps.
  const rest = steps.filter((s) => !s.tests && !s.edits.length && !["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(s.name));
  const group = (key: string, label: string, of: Step[], line: (s: Step) => string) => {
    if (of.length) chips.push({ key, label, tone: "plain", items: of.map((s) => ({ text: clip(line(s), 200), bad: s.isError, id: s.id })) });
  };
  const commands = rest.filter((s) => s.name === "Bash" || s.name === "BashOutput");
  group("run", `Ran ${plural(commands.length, "command")}`, commands, (s) => s.summary || "a command");
  const skills = rest.filter((s) => s.name === "Skill");
  group("skill", `Used ${plural(skills.length, "skill")}`, skills, (s) => s.summary || "a skill");
  const helpers = rest.filter((s) => s.name === "Agent" || s.name === "Task");
  group("agent", `Ran ${plural(helpers.length, "helper")}`, helpers, (s) => s.summary || "a helper");
  const advised = rest.filter((s) => s.name === "advisor");
  group("advisor", advised.length === 1 ? "Consulted the advisor" : `Consulted the advisor ${advised.length} times`, advised, (s) => s.summary || "the advisor");
  const servers = new Map<string, Step[]>();
  for (const s of rest) {
    const m = /^mcp__(.+?)__(.+)$/.exec(s.name);
    if (m) servers.set(m[1], [...(servers.get(m[1]) ?? []), s]);
  }
  for (const [server, of] of servers) {
    const name = server.replace(/^claude_ai_/, "").replace(/_/g, " ");
    group(`mcp-${server}`, `Used ${name.charAt(0).toUpperCase()}${name.slice(1)}${of.length === 1 ? "" : ` ${of.length} times`}`, of, (s) => `${s.name.replace(/^mcp__.+?__/, "").replace(/_/g, " ")}${s.summary ? ` ${s.summary}` : ""}`);
  }
  const grouped = new Set([...commands, ...skills, ...helpers, ...advised, ...[...servers.values()].flat()]);
  const other = rest.filter((s) => !grouped.has(s));
  group("other", `Used ${plural(other.length, "other tool")}`, other, (s) => (s.name ? `${s.name}${s.summary ? ` ${s.summary}` : ""}` : "A step"));
  const failed = steps.filter((s) => s.isError);
  if (failed.length) chips.push({ key: "failed", label: `${plural(failed.length, "step")} failed`, tone: "bad" });
  return chips;
}

/** What of a turn's work a summary card says (the rest is in the steps above it). */
const SUMMARY_CHIPS = ["edits", "run", "tests", "failed"];

/**
 * A turn's closing message is a summary when the turn did real work (three steps, or any edit) and the message says
 * something (a few sentences, or a list): the card it is shown as carries what the turn did, in its chips. Null for an
 * ordinary message, one still streaming, or one a turn didn't end on.
 */
export function summaryOf(items: Item[], i: number): { chips: StepChip[]; durationMs: number | null } | null {
  const item = items[i];
  if (item?.kind !== "assistant" || item.streaming) return null;
  let j = i + 1;
  while (j < items.length && items[j].kind === "step") j++;
  const end = items[j];
  if (end?.kind !== "turn" || end.isError) return null;
  let from = i;
  while (from > 0 && items[from - 1].kind !== "user" && items[from - 1].kind !== "turn") from--;
  const steps = items.slice(from, j).filter((it): it is Step => it.kind === "step");
  const text = item.text.trim();
  const worked = steps.length >= 3 || steps.some((s) => s.edits.length > 0);
  const says = text.length >= 160 || /^\s*(?:[-*•]|\d+[.)])\s/m.test(text);
  if (!worked || !says) return null;
  return { chips: stepChips(steps).filter((c) => SUMMARY_CHIPS.includes(c.key)), durationMs: end.durationMs };
}

export function timeline(items: Item[]): Row[] {
  const rows: Row[] = [];
  let run: Step[] = [];
  const endRun = () => {
    if (run.length) rows.push({ key: `steps-${run[0].id}`, kind: "steps", chips: stepChips(run) });
    run = [];
  };
  items.forEach((item, i) => {
    if (item.kind === "step") return void run.push(item);
    endRun();
    switch (item.kind) {
      case "user":
        return void rows.push({ key: `u-${item.id}`, kind: "user", item });
      case "assistant": {
        const page = readPage(item.text);
        if (page && !item.streaming) return void rows.push({ key: `a-${item.id}`, kind: "page", item, page, live: livePage(items, i) });
        const summary = summaryOf(items, i);
        if (summary) return void rows.push({ key: `a-${item.id}`, kind: "summary", item, ...summary });
        return void rows.push({ key: `a-${item.id}`, kind: "assistant", item });
      }
      case "prompt":
        return void rows.push({ key: `p-${item.id}`, kind: "prompt", item });
      case "desktop":
        return void rows.push({ key: `d-${item.id}`, kind: "desktop", item });
      case "turn":
        return void rows.push({ key: `t-${item.id}`, kind: "turn", item });
      case "shell":
        return void rows.push({ key: `sh-${item.id}`, kind: "shell", item });
    }
  });
  endRun();
  return rows;
}

/** A turn's end in a few words: "3 s", "1 min 12 s", or what went wrong. */
export function turnLine(t: Extract<Item, { kind: "turn" }>): { text: string; bad: boolean } {
  if (t.isError) return { text: t.result ? `Stopped with an error: ${clip(t.result, 80)}` : "Stopped with an error", bad: true };
  const s = Math.round((t.durationMs ?? 0) / 1000);
  if (!t.durationMs) return { text: "Finished", bad: false };
  return { text: s < 60 ? `Finished in ${s} s` : `Finished in ${Math.floor(s / 60)} min ${s % 60} s`, bad: false };
}
