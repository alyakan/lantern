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

/** A command as one line to read: an argument with a space or a quote in it is quoted. */
export function commandLine(args: string[]): string {
  return args.map((a) => (a === "" || /[^\w@%+=:,./~{}-]/.test(a) ? JSON.stringify(a) : a)).join(" ");
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
