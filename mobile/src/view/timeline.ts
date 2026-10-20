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
}

export type Row =
  | { key: string; kind: "user"; item: Extract<Item, { kind: "user" }> }
  | { key: string; kind: "assistant"; item: Extract<Item, { kind: "assistant" }> }
  | { key: string; kind: "page"; item: Extract<Item, { kind: "assistant" }>; page: Page; live: boolean }
  | { key: string; kind: "steps"; chips: StepChip[] }
  | { key: string; kind: "prompt"; item: Extract<Item, { kind: "prompt" }> }
  | { key: string; kind: "desktop"; item: Extract<Item, { kind: "desktop" }> }
  | { key: string; kind: "turn"; item: Extract<Item, { kind: "turn" }> };

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

  for (const s of steps) {
    if (s.tests || s.edits.length || ["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(s.name)) continue;
    const label = s.name === "Bash" ? `Ran ${clip(s.summary || "a command", 26)}` : s.name === "Agent" || s.name === "Task" ? "Ran a helper" : s.name ? clip(s.summary ? `${s.name} ${s.summary}` : s.name, 30) : "A step";
    chips.push({ key: `step-${s.id}`, label, tone: "plain" });
  }
  const failed = steps.filter((s) => s.isError);
  if (failed.length) chips.push({ key: "failed", label: `${plural(failed.length, "step")} failed`, tone: "bad" });
  return chips;
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
        return void rows.push({ key: `a-${item.id}`, kind: "assistant", item });
      }
      case "prompt":
        return void rows.push({ key: `p-${item.id}`, kind: "prompt", item });
      case "desktop":
        return void rows.push({ key: `d-${item.id}`, kind: "desktop", item });
      case "turn":
        return void rows.push({ key: `t-${item.id}`, kind: "turn", item });
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
