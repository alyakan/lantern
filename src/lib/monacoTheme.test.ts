import { describe, expect, it } from "vitest";
import { contrast } from "./color";
import { FALLBACK_TOKENS, monacoTheme, syntaxFor } from "./monacoTheme";

const dark = FALLBACK_TOKENS.dark;
const light = FALLBACK_TOKENS.light;

describe("monacoTheme", () => {
  it("takes the editor's background, gutter and line numbers from the page's tokens", () => {
    const t = monacoTheme(dark, true, syntaxFor("dark", true));
    expect(t.base).toBe("vs-dark");
    expect(t.colors["editor.background"]).toBe(dark.pane);
    expect(t.colors["editorGutter.background"]).toBe(dark.pane);
    expect(t.colors["editorLineNumber.foreground"]).toBe(dark.faint);
    expect(t.colors["editorLineNumber.activeForeground"]).toBe(dark.muted);
    expect(monacoTheme(light, false, syntaxFor("light", false)).base).toBe("vs");
  });

  it("tints the diff with the theme's own green and red, faintly", () => {
    const t = monacoTheme({ ...dark, add: "#00ff00", del: "#ff0000" }, true, syntaxFor("terminal", true));
    expect(t.colors["diffEditor.insertedTextBackground"]).toMatch(/^#00ff00[0-9a-f]{2}$/);
    expect(t.colors["diffEditor.removedTextBackground"]).toMatch(/^#ff0000[0-9a-f]{2}$/);
    // Faint: well under a quarter opacity.
    expect(parseInt(t.colors["diffEditor.insertedLineBackground"].slice(7), 16)).toBeLessThan(64);
  });

  it("makes the selection a wash of the text colour, and find the review yellow", () => {
    const t = monacoTheme({ ...dark, text: "#abcdef", warn: "#e3b341" }, true, syntaxFor("dark", true));
    expect(t.colors["editor.selectionBackground"]).toMatch(/^#abcdef/);
    expect(t.colors["editor.findMatchBorder"]).toBe("#e3b341");
  });

  it("puts the foreground on the page's text colour", () => {
    const t = monacoTheme({ ...dark, text: "#5df08a" }, true, syntaxFor("terminal", true));
    expect(t.rules.find((r) => r.token === "")?.foreground).toBe("5df08a");
  });

  it("keeps every source colour readable on the editor's background, whatever the theme's palette", () => {
    for (const [name, tokens, isDark] of [["light", light, false], ["dark", dark, true], ["terminal", { ...dark, pane: "#050a06", text: "#5df08a" }, true], ["solarized", { ...dark, pane: "#002b36", text: "#a2b1b1" }, true], ["nord", { ...dark, pane: "#2e3440", text: "#eceff4" }, true], ["paper", { ...light, pane: "#fffdf8", text: "#2b2620" }, false]] as const) {
      const t = monacoTheme(tokens, isDark, syntaxFor(name, isDark));
      for (const rule of t.rules) expect(contrast(`#${rule.foreground}`, tokens.pane), `${name}: ${rule.token || "plain"}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("has its own source colours for Terminal, Solarized and Nord, and Xcode's for the rest", () => {
    expect(syntaxFor("terminal", true)).not.toBe(syntaxFor("dark", true));
    expect(syntaxFor("nord", true)).not.toBe(syntaxFor("solarized", true));
    expect(syntaxFor("paper", false)).toBe(syntaxFor("light", false));
    expect(syntaxFor("custom", true)).toBe(syntaxFor("dark", true));
    expect(syntaxFor(undefined, false)).toBe(syntaxFor("light", false));
  });
});
