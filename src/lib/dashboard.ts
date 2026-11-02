import type { DashboardField, DashboardPanel, DashboardRunSummary, DashboardValues } from "../types";

export type FormPanel = Extract<DashboardPanel, { type: "form" }>;

/** What a form's controls hold while it is being filled in: text, a number's digits, and a select's option are strings. */
export type FormState = Record<string, string | boolean | string[]>;

/** The controls' starting values: each field's default, else empty (a toggle off). */
export function initialState(fields: DashboardField[]): FormState {
  const state: FormState = {};
  for (const f of fields) {
    if (f.type === "toggle") state[f.id] = f.default === true;
    else if (f.type === "multiselect") state[f.id] = Array.isArray(f.default) ? [...f.default] : [];
    else state[f.id] = f.default === undefined ? "" : String(f.default);
  }
  return state;
}

/**
 * What the controls say, as the values Lantern checks and fills into the command. A cleared number is left out (its default
 * applies); digits that aren't a number go as typed, so Lantern can say which field is wrong.
 */
export function toValues(fields: DashboardField[], state: FormState): DashboardValues {
  const values: DashboardValues = {};
  for (const f of fields) {
    const v = state[f.id];
    if (f.type === "number") {
      const text = String(v ?? "").trim();
      if (text === "") continue;
      values[f.id] = Number.isFinite(Number(text)) ? Number(text) : text;
    } else if (f.type === "toggle") values[f.id] = v === true;
    else if (f.type === "multiselect") values[f.id] = Array.isArray(v) ? v : [];
    else values[f.id] = String(v ?? "");
  }
  return values;
}

/** One argument as it reads in a command line: with a space or a quote in it, it is quoted. */
export const quoteArg = (a: string): string => (a === "" || /[^\w@%+=:,./~{}-]/.test(a) ? JSON.stringify(a) : a);

/** A command as one line to read. */
export function commandLine(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

const ANSI = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g");

/** Output as plain text: the colour codes a tool prints for a terminal are dropped. */
export function plain(text: string): string {
  return text.replace(ANSI, "");
}

export type RunTone = "ok" | "failed" | "stopped";

/** How a run went, in a word, and which colour says it. */
export function runStatus(run: Pick<DashboardRunSummary, "exit_code" | "stopped" | "timed_out">): { label: string; tone: RunTone } {
  if (run.timed_out) return { label: "timed out", tone: "stopped" };
  if (run.stopped) return { label: "stopped", tone: "stopped" };
  if (run.exit_code === 0) return { label: "done", tone: "ok" };
  return { label: run.exit_code === null ? "ended" : `failed (${run.exit_code})`, tone: "failed" };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

const show = (v: string | number | boolean | string[]): string => (Array.isArray(v) ? v.join(",") : String(v));

/** What a run was given, in a short line: "staging 7 · users 2 · addons approvals,sso". Empty values are left out. */
export function summarizeInputs(inputs: DashboardValues, max = 90): string {
  const text = Object.entries(inputs)
    .filter(([, v]) => v !== "" && !(Array.isArray(v) && v.length === 0) && v !== false)
    .map(([k, v]) => (v === true ? k : `${k} ${show(v)}`))
    .join(" · ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A value of a JSON output that has no inside to open. */
export const isScalar = (v: unknown): v is string | number | boolean | null => v === null || typeof v !== "object";

/** A list of objects that is a table: every item an object (not a list), and none of its values holds another object. */
export function isTable(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.length > 0 && v.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

/** The table's columns: every key any row has, in the order they first show up. */
export function tableColumns(rows: Record<string, unknown>[], max = 12): string[] {
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return columns.slice(0, max);
}

/** How long a run has been going, as the button says it: "12 s", "1 min 5 s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}

/** A cell as a line of text to paste: a nested value as JSON, and nothing in it that would break a tab-separated line. */
const cellText = (v: unknown): string => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "")).replace(/[\t\r\n]+/g, " ");

/** One table row as a tab-separated line, in the columns' order (what a row's Copy puts on the clipboard). */
export function rowTsv(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((c) => cellText(row[c])).join("\t");
}

/** The whole table as tab-separated lines with a header: pastes into a sheet, a ticket or a chat as it looks here. */
export function tableTsv(rows: Record<string, unknown>[], columns: string[]): string {
  return [columns.join("\t"), ...rows.map((r) => rowTsv(r, columns))].join("\n");
}

/** The options whose text contains `query`, ignoring case; all of them for an empty query. */
export function matching(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q === "" ? options : options.filter((o) => o.toLowerCase().includes(q));
}

/** One thing a dashboard does: a form, with the result and the history that belong to it. */
export interface DashboardFunction {
  id: string;
  title: string;
  panels: DashboardPanel[];
}

/** A spec's panels grouped by the form they belong to, in the order the forms come (each is a tab when there are several). */
export function functionsOf(panels: DashboardPanel[]): DashboardFunction[] {
  const groups: DashboardFunction[] = [];
  for (const p of panels) if (p.type === "form") groups.push({ id: p.id, title: p.title ?? p.id, panels: [p] });
  for (const p of panels) {
    if (p.type === "form") continue;
    // A result or history of a form the file doesn't have (the checker refuses it) is still shown, with the first function.
    let group = groups.find((g) => g.id === p.of) ?? groups[0];
    if (!group) groups.push((group = { id: "", title: "Dashboard", panels: [] }));
    group.panels.push(p);
  }
  return groups;
}
