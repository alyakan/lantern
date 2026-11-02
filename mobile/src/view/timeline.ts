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
  /** One of its steps is still going (a spinner shows on it). */
  running?: boolean;
}

export type Row =
  | { key: string; kind: "user"; item: Extract<Item, { kind: "user" }>; /** Its time is shown: the first message of its day, or one a while after the one before. */ showTime: boolean }
  | { key: string; kind: "assistant"; item: Extract<Item, { kind: "assistant" }>; /** The files its turn edited: a path in the words that names one opens its diff. */ files: string[] }
  | { key: string; kind: "page"; item: Extract<Item, { kind: "assistant" }>; page: Page; live: boolean; /** The files its turn edited (a Build step's): named in its words, each is a link to its change. */ files: string[] }
  | { key: string; kind: "summary"; item: Extract<Item, { kind: "assistant" }>; chips: StepChip[]; durationMs: number | null; files: string[] }
  | { key: string; kind: "steps"; chips: StepChip[]; /** How long the turn took, when it ended and this is its last row of steps ("42 s"). */ took: string | null }
  | { key: string; kind: "prompt"; item: Extract<Item, { kind: "prompt" }> }
  | { key: string; kind: "desktop"; item: Extract<Item, { kind: "desktop" }> }
  | { key: string; kind: "turn"; item: Extract<Item, { kind: "turn" }> }
  | { key: string; kind: "shell"; item: Extract<Item, { kind: "shell" }> }
  /** Where a new day starts: "Today", "Yesterday", "Mon 26 Oct". */
  | { key: string; kind: "day"; label: string }
  /** What the user's post-hook made Claude say and do, folded: the hook's words, its last line, and its steps. */
  | { key: string; kind: "hook"; text: string; said: string; chips: StepChip[]; going: boolean };

type Step = Extract<Item, { kind: "step" }>;

/** The tools that change a file (their lines come once the change is made). */
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One row of chips for a run of steps. */
export function stepChips(steps: Step[]): StepChip[] {
  const chips: StepChip[] = [];
  const going = (of: Step[]) => (of.some((s) => !s.done) ? { running: true } : {});
  const named = (...names: string[]) => steps.filter((s) => names.includes(s.name));
  const reads = named("Read");
  if (reads.length) chips.push({ key: "read", label: `Read ${plural(reads.length, "file")}`, tone: "plain", ...going(reads) });
  const searches = named("Grep", "Glob", "WebSearch", "WebFetch");
  if (searches.length) chips.push({ key: "search", label: searches.every((s) => s.name.startsWith("Web")) ? `Looked up ${plural(searches.length, "page")}` : `Searched ${plural(searches.length, "time")}`, tone: "plain", ...going(searches) });

  // An edit still going has no lines yet: it is the edits chip already, spinning, not "another tool" that later turns into one.
  const editing = steps.filter((s) => EDIT_TOOLS.includes(s.name) && !s.edits.length && !s.done);
  const edits = new Map<string, { added: number; removed: number }>();
  for (const s of steps) for (const e of s.edits) edits.set(e.path, { added: (edits.get(e.path)?.added ?? 0) + e.added, removed: (edits.get(e.path)?.removed ?? 0) + e.removed });
  if (edits.size) {
    const [added, removed] = [...edits.values()].reduce<[number, number]>(([a, r], e) => [a + e.added, r + e.removed], [0, 0]);
    chips.push({ key: "edits", label: `Edited ${plural(edits.size, "file")} +${added} −${removed}`, tone: "plain", files: [...edits.keys()], ...going([...steps.filter((s) => s.edits.length), ...editing]) });
  } else if (editing.length) chips.push({ key: "edits", label: `Editing ${plural(editing.length, "file")}`, tone: "plain", running: true });

  const tested = steps.filter((s) => s.tests);
  if (tested.length) {
    const t = tested.reduce((n, s) => ({ passed: n.passed + s.tests!.passed, failed: n.failed + s.tests!.failed }), { passed: 0, failed: 0 });
    chips.push(t.failed > 0 ? { key: "tests", label: `${t.failed} failed, ${t.passed} passed`, tone: "bad" } : { key: "tests", label: `${plural(t.passed, "test")} passed`, tone: "ok" });
  }

  // What is left is grouped by kind, as the desktop's summary line is ("Ran 5 commands, used 2 skills"), each group
  // opening to its steps.
  const rest = steps.filter((s) => !s.tests && !s.edits.length && !editing.includes(s) && !["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(s.name));
  const group = (key: string, label: string, of: Step[], line: (s: Step) => string) => {
    if (of.length) chips.push({ key, label, tone: "plain", items: of.map((s) => ({ text: clip(line(s), 200), bad: s.isError, id: s.id })), ...going(of) });
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

/** What a post-hook made Claude say and do, kept apart from the turn it followed. */
interface HookRun {
  id: string;
  text: string;
  steps: Step[];
  said: string[];
  /** No turn's end has come after it yet. */
  going: boolean;
}

/**
 * The items with what each post-hook made Claude say and do taken out (its words and steps, up to the end of the turn), and where
 * each hook's row goes: before the item at that place in what is left (the turn's end), or at the end while it is still going.
 */
function apart(items: Item[]): { main: Item[]; hooks: Map<number, HookRun> } {
  const main: Item[] = [];
  const hooks = new Map<number, HookRun>();
  let run: HookRun | null = null;
  for (const it of items) {
    if (it.kind === "hook") {
      if (run) hooks.set(main.length, { ...run, going: false });
      run = { id: it.id, text: it.text, steps: [], said: [], going: true };
      continue;
    }
    if (run && it.kind === "step") {
      run.steps.push(it);
      continue;
    }
    if (run && it.kind === "assistant") {
      run.said.push(it.text);
      continue;
    }
    // The hook is over at its turn's end, or (a chat replayed from its transcript has no turn ends) at the next message: not one
    // this phone is still sending, which may be typed while the hook runs.
    if (run && (it.kind === "turn" || (it.kind === "user" && !it.sending))) {
      hooks.set(main.length, { ...run, going: false });
      run = null;
    }
    main.push(it);
  }
  if (run) hooks.set(main.length, run);
  return { main, hooks };
}

/** The last line of what was said that is words: a hook's row says it ("The brain is updated."). */
export function lastLine(text: string): string {
  // Words only: not an empty line, a code fence, or the code inside one.
  let fenced = false;
  const lines: string[] = [];
  for (const l of text.split("\n").map((x) => x.trim())) {
    if (l.startsWith("```")) fenced = !fenced;
    else if (!fenced && l) lines.push(l);
  }
  return clip((lines.at(-1) ?? "").replace(/^[#>*\-\s]+/, "").replace(/[*`]/g, ""), 120);
}

const DAY = 86_400_000;
/** How long after the message before a message's time is shown again. */
export const TIME_GAP_MS = 10 * 60_000;

/** "Today", "Yesterday", "Mon 26 Oct" (and the year, for another year's). */
export function dayLabel(at: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return "Today";
  if (day(at) === day(now - DAY)) return "Yesterday";
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** How long a turn took, as a chip row ends with it: "42 s", "1 min 12 s". */
export function tookOf(durationMs: number | null): string | null {
  if (!durationMs) return null;
  const s = Math.round(durationMs / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** No files: the same list every time, so a row with none is not drawn again as words stream in. */
const NO_FILES: string[] = [];
/** Lists of files already made, by what is in them: the same files are the same list, for the same reason. */
const fileLists = new Map<string, string[]>();
function sameList(files: string[]): string[] {
  if (files.length === 0) return NO_FILES;
  const key = files.join("\n");
  const known = fileLists.get(key);
  if (known) return known;
  if (fileLists.size > 500) fileLists.clear();
  fileLists.set(key, files);
  return files;
}

/** The files each turn edited, by the place in `items` of each of its items. */
function filesByItem(items: Item[]): string[][] {
  const out: string[][] = [];
  let from = 0;
  const close = (to: number) => {
    const files = sameList([...new Set(items.slice(from, to).flatMap((it) => (it.kind === "step" ? it.edits.map((e) => e.path) : [])))]);
    for (let k = from; k < to; k++) out[k] = files;
    from = to;
  };
  items.forEach((it, i) => {
    if (it.kind === "user" && i > from) close(i);
  });
  close(items.length);
  return out;
}

export function timeline(all: Item[], now = Date.now(), working = false): Row[] {
  const { main: items, hooks } = apart(all);
  const files = filesByItem(items);
  const rows: Row[] = [];
  let run: Step[] = [];
  // Where the current turn's rows start (after its user row), the last day said and the last message's time.
  let turnStart = 0;
  let lastDay: string | null = null;
  let lastAt: number | null = null;
  const endRun = () => {
    if (run.length) rows.push({ key: `steps-${run[0].id}`, kind: "steps", chips: stepChips(run), took: null });
    run = [];
  };
  const hookAt = (i: number) => {
    const h = hooks.get(i);
    if (!h) return;
    endRun();
    const said = h.said.join("\n\n");
    // Still going only while the chat works: a replayed chat's last hook has no end, and is long over.
    rows.push({ key: `hk-${h.id}`, kind: "hook", text: h.text, said, chips: stepChips(h.steps), going: h.going && working });
  };
  items.forEach((item, i) => {
    hookAt(i);
    if (item.kind === "step") return void run.push(item);
    endRun();
    switch (item.kind) {
      case "user": {
        let showTime = false;
        if (item.at !== null) {
          const day = new Date(item.at).toDateString();
          // A new day: said once, above its first message (the first of all only when it isn't today, where it goes without saying).
          if (day !== lastDay && (lastDay !== null || day !== new Date(now).toDateString())) rows.push({ key: `day-${day}`, kind: "day", label: dayLabel(item.at, now) });
          showTime = day !== lastDay || lastAt === null || item.at - lastAt > TIME_GAP_MS;
          lastDay = day;
          lastAt = item.at;
        }
        rows.push({ key: `u-${item.id}`, kind: "user", item, showTime });
        turnStart = rows.length;
        return;
      }
      case "assistant": {
        const page = readPage(item.text);
        if (page && !item.streaming) return void rows.push({ key: `a-${item.id}`, kind: "page", item, page, live: livePage(items, i), files: files[i] ?? NO_FILES });
        const summary = summaryOf(items, i);
        if (summary) return void rows.push({ key: `a-${item.id}`, kind: "summary", item, ...summary, files: files[i] ?? NO_FILES });
        return void rows.push({ key: `a-${item.id}`, kind: "assistant", item, files: files[i] ?? NO_FILES });
      }
      case "prompt":
        return void rows.push({ key: `p-${item.id}`, kind: "prompt", item });
      case "desktop":
        return void rows.push({ key: `d-${item.id}`, kind: "desktop", item });
      case "turn": {
        // A turn that ended well says how long it took where its work already is: the summary card has it, or the last row of steps
        // ends with it. Only a turn with neither (a quick answer) keeps a line of its own, and an error always does.
        if (!item.isError) {
          const own = rows.slice(turnStart).filter((r) => r.kind !== "hook");
          if (own.some((r) => r.kind === "summary")) return;
          const lastSteps = [...own].reverse().find((r) => r.kind === "steps");
          if (lastSteps && lastSteps.kind === "steps") {
            lastSteps.took = tookOf(item.durationMs);
            return;
          }
        }
        return void rows.push({ key: `t-${item.id}`, kind: "turn", item });
      }
      case "shell":
        return void rows.push({ key: `sh-${item.id}`, kind: "shell", item });
    }
  });
  endRun();
  hookAt(items.length);
  return rows;
}

/** A turn's end in a few words: "3 s", "1 min 12 s", or what went wrong. */
export function turnLine(t: Extract<Item, { kind: "turn" }>): { text: string; bad: boolean } {
  if (t.isError) return { text: t.result ? `Stopped with an error: ${clip(t.result, 80)}` : "Stopped with an error", bad: true };
  const s = Math.round((t.durationMs ?? 0) / 1000);
  if (!t.durationMs) return { text: "Finished", bad: false };
  return { text: s < 60 ? `Finished in ${s} s` : `Finished in ${Math.floor(s / 60)} min ${s % 60} s`, bad: false };
}
