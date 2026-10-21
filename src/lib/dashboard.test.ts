import { describe, expect, it } from "vitest";
import spec from "../../src-tauri/tests/fixtures/dashboard.spec.json";
import type { DashboardAction, DashboardField, DashboardSpec } from "../types";
import { commandLine, formatDuration, formatElapsed, initialState, isScalar, isTable, matching, plain, rowTsv, runStatus, summarizeInputs, tableColumns, tableTsv, toValues } from "./dashboard";

// dashboard.spec.json is what Rust's checker makes of dashboard.input.json (a Rust test fails when it's stale). These tests
// hold the TypeScript types to the same file: a key added on one side and not the other fails here, either as a type error
// in these tables or as a mismatch below.
const FIELD_KEYS: Record<keyof DashboardField, true> = { id: true, type: true, label: true, required: true, default: true, options: true, optionsFrom: true, min: true, max: true };
const ACTION_KEYS: Record<keyof DashboardAction, true> = { command: true, confirm: true, output: true };
const OPTIONS_FROM_KEYS: Record<keyof NonNullable<DashboardField["optionsFrom"]>, true> = { command: true, dependsOn: true };
const FORM_KEYS = ["action", "fields", "id", "title", "type"];
const LINK_KEYS = ["id", "of", "title", "type"];
const ROOT_KEYS: Record<keyof DashboardSpec, true> = { title: true, panels: true };

const keysOf = (items: object[]) => [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
const table = (t: Record<string, true>) => Object.keys(t).sort();

describe("the dashboard spec the TypeScript types describe", () => {
  const panels = spec.panels as Array<Record<string, unknown> & { type: string }>;
  const forms = panels.filter((p) => p.type === "form");
  const fields = forms.flatMap((f) => f.fields as DashboardField[]);

  it("has the root keys", () => {
    expect(Object.keys(spec).sort()).toEqual(table(ROOT_KEYS));
  });

  it("has exactly the panel kinds and keys the types name", () => {
    expect([...new Set(panels.map((p) => p.type))].sort()).toEqual(["form", "history", "result"]);
    expect(keysOf(forms)).toEqual(FORM_KEYS);
    expect(keysOf(panels.filter((p) => p.type !== "form"))).toEqual(LINK_KEYS);
  });

  it("has exactly the field kinds and keys the types name", () => {
    expect([...new Set(fields.map((f) => f.type))].sort()).toEqual(["multiselect", "number", "select", "text", "toggle"]);
    expect(keysOf(fields)).toEqual(table(FIELD_KEYS));
  });

  it("has exactly the optionsFrom keys the types name", () => {
    const from = fields.flatMap((f) => (f.optionsFrom ? [f.optionsFrom] : []));
    expect(from.length).toBeGreaterThan(0);
    expect(keysOf(from)).toEqual(table(OPTIONS_FROM_KEYS));
  });

  it("has exactly the action keys the types name", () => {
    expect(keysOf(forms.map((f) => f.action as object))).toEqual(table(ACTION_KEYS));
    expect(forms.map((f) => (f.action as DashboardAction).output)).toEqual(["json"]);
  });

  it("keeps a field's default the shape of its type", () => {
    const defaults = Object.fromEntries(fields.map((f) => [f.type, typeof f.default === "object" ? "list" : typeof f.default]));
    expect(defaults).toEqual({ select: "undefined", number: "number", multiselect: "list", text: "string", toggle: "boolean" });
  });
});

describe("the form's controls", () => {
  const fields = spec.panels.flatMap((p) => ("fields" in p ? (p.fields as DashboardField[]) : []));

  it("start from each field's default, a toggle off", () => {
    expect(initialState(fields)).toEqual({ staging: "", users: "2", admins: "1", addons: ["approvals"], name: "QA org", trial: false });
  });

  it("become the values Lantern checks: numbers as numbers, a cleared number left out, a cleared text kept empty", () => {
    const state = { ...initialState(fields), staging: "7", users: "3", admins: "", name: "", addons: ["sso"], trial: true };
    expect(toValues(fields, state)).toEqual({ staging: "7", users: 3, addons: ["sso"], name: "", trial: true });
  });

  it("send digits that aren't a number as typed, so Lantern says which field is wrong", () => {
    expect(toValues(fields, { ...initialState(fields), users: "two" }).users).toBe("two");
    expect(toValues(fields, { ...initialState(fields), users: " 4 " }).users).toBe(4);
  });
});

describe("reading a run", () => {
  it("quotes only the arguments that need it", () => {
    expect(commandLine(["python3", "~/x.py", "--name=QA org", "--n", "2", "", 'a"b'])).toBe('python3 ~/x.py "--name=QA org" --n 2 "" "a\\"b"');
  });

  it("drops terminal colour codes from output", () => {
    expect(plain("\u001b[31mred\u001b[0m and \u001b[1;32mgreen\u001b[0m")).toBe("red and green");
    expect(plain("no codes")).toBe("no codes");
  });

  it("says how a run went", () => {
    expect(runStatus({ exit_code: 0, stopped: false, timed_out: false })).toEqual({ label: "done", tone: "ok" });
    expect(runStatus({ exit_code: 3, stopped: false, timed_out: false })).toEqual({ label: "failed (3)", tone: "failed" });
    expect(runStatus({ exit_code: null, stopped: true, timed_out: false })).toEqual({ label: "stopped", tone: "stopped" });
    expect(runStatus({ exit_code: null, stopped: false, timed_out: true })).toEqual({ label: "timed out", tone: "stopped" });
    expect(runStatus({ exit_code: null, stopped: false, timed_out: false })).toEqual({ label: "ended", tone: "failed" });
  });

  it("formats durations", () => {
    expect([250, 1500, 12000, 61000].map(formatDuration)).toEqual(["250 ms", "1.5 s", "12 s", "1 min 1 s"]);
  });

  it("summarizes what a run was given, leaving out what is empty or off", () => {
    expect(summarizeInputs({ staging: "7", users: 2, addons: ["approvals", "sso"], name: "", trial: false, loud: true, none: [] })).toBe("staging 7 · users 2 · addons approvals,sso · loud");
    expect(summarizeInputs({ note: "x".repeat(200) }, 20)).toHaveLength(20);
  });

  it("finds a table in a list of objects and its columns in the order they appear", () => {
    const rows = [{ email: "a", role: "admin" }, { email: "b", password: "p" }];
    expect(isTable(rows)).toBe(true);
    expect(tableColumns(rows)).toEqual(["email", "role", "password"]);
    expect([[], ["a"], [[1]], [null], "x", { a: 1 }].map(isTable)).toEqual([false, false, false, false, false, false]);
    expect(tableColumns([{ a: 1, b: 2, c: 3 }], 2)).toEqual(["a", "b"]);
    expect([null, 1, "a", true, [], {}].map(isScalar)).toEqual([true, true, true, true, false, false]);
  });
});

describe("reading and copying a result", () => {
  it("says how long a run has been going", () => {
    expect([0, 999, 3200, 59_999, 65_000, 3_725_000].map(formatElapsed)).toEqual(["0 s", "0 s", "3 s", "59 s", "1 min 5 s", "62 min 5 s"]);
    expect(formatElapsed(-5)).toBe("0 s");
  });

  it("writes a row and a table as tab-separated lines, with nothing in a cell that would break one", () => {
    const rows = [{ email: "a@x", note: "line one\nline\ttwo", n: 3, nested: { k: [1] }, gone: null }, { email: "b@x" }];
    const columns = ["email", "note", "n", "nested", "gone"];
    expect(rowTsv(rows[0], columns)).toBe('a@x\tline one line two\t3\t{"k":[1]}\t');
    expect(rowTsv(rows[1], columns)).toBe("b@x\t\t\t\t");
    expect(tableTsv(rows, columns).split("\n")).toEqual(["email\tnote\tn\tnested\tgone", 'a@x\tline one line two\t3\t{"k":[1]}\t', "b@x\t\t\t\t"]);
  });

  it("filters options by what they contain, ignoring case and spaces around the query", () => {
    const options = ["approvals", "form_translations", "manual_form_translations", "sso"];
    expect(matching(options, "")).toBe(options);
    expect(matching(options, "  ")).toBe(options);
    expect(matching(options, " TRANS ")).toEqual(["form_translations", "manual_form_translations"]);
    expect(matching(options, "zzz")).toEqual([]);
  });
});
