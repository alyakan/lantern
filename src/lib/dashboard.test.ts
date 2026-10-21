import { describe, expect, it } from "vitest";
import spec from "../../src-tauri/tests/fixtures/dashboard.spec.json";
import type { DashboardAction, DashboardField, DashboardSpec } from "../types";

// dashboard.spec.json is what Rust's checker makes of dashboard.input.json (a Rust test fails when it's stale). These tests
// hold the TypeScript types to the same file: a key added on one side and not the other fails here, either as a type error
// in these tables or as a mismatch below.
const FIELD_KEYS: Record<keyof DashboardField, true> = { id: true, type: true, label: true, required: true, default: true, options: true, min: true, max: true };
const ACTION_KEYS: Record<keyof DashboardAction, true> = { command: true, confirm: true, output: true };
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

  it("has exactly the action keys the types name", () => {
    expect(keysOf(forms.map((f) => f.action as object))).toEqual(table(ACTION_KEYS));
    expect(forms.map((f) => (f.action as DashboardAction).output)).toEqual(["json"]);
  });

  it("keeps a field's default the shape of its type", () => {
    const defaults = Object.fromEntries(fields.map((f) => [f.type, typeof f.default === "object" ? "list" : typeof f.default]));
    expect(defaults).toEqual({ select: "undefined", number: "number", multiselect: "list", text: "string", toggle: "boolean" });
  });
});
