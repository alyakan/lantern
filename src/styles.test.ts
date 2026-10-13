import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

// Read from disk: Vitest hands CSS imports to tests as empty strings.
const css: string = readFileSync("src/styles.css", "utf8");

// The window turns text selection off; these are the selectors that turn it back on.
const selectable = css
  .split("}")
  .filter((rule) => /user-select:\s*text/.test(rule))
  .flatMap((rule) => rule.split("{")[0].split(","))
  .map((s) => s.trim());

describe("the History menu", () => {
  it("doesn't let a long list of past sessions squeeze the open chats", () => {
    const rule = css.match(/\.history-menu \.open-chats-list \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).toMatch(/max-height:/);
  });
});

describe("text you can select and copy", () => {
  it("includes a review's findings, what changed, notes and summary table", () => {
    for (const cls of [".finding-text", ".review-preface", ".review-changed", ".review-notes", ".review-table"]) {
      expect(selectable).toContain(cls);
    }
  });
});

describe("colours", () => {
  // The dark theme's own values, from its block of the stylesheet.
  const dark = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/)?.[1] ?? "";
  const token = (name: string) => dark.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, "i"))?.[1] ?? "";
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("gives a dark code block a background of its own, readable, on the pane and the chat card", () => {
    const code = token("code-bg");
    expect(code).not.toBe("");
    expect(code).not.toBe(token("pane"));
    expect(code).not.toBe(token("sidebar"));
    expect(contrast(token("text"), code)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a selected item's fill when the pointer is over it", () => {
    for (const sel of [".mode-guide-tab.active:hover", ".skill-row.active:hover", ".menu-row.current:hover", ".search-toggle.on:hover"]) {
      expect(css).toContain(sel);
    }
  });

  describe("small text that has to be read", () => {
    // Each rule is on one line. The tab track sits on the glass capsule, which is see-through, so the test checks the
    // opaque surfaces it's over (the pane and the chat card): the glass is a shade of them.
    const body = (sel: string) => css.split("\n").find((l) => l.startsWith(`${sel} {`)) ?? "";
    const light = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    const lightToken = (name: string) => light.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, "i"))?.[1] ?? "";

    it("uses the readable muted text, not the faint or decorative grey, for placeholders and the tab track", () => {
      for (const sel of [".pane-tabs-track button", ".menu-search::placeholder", ".repro-input::placeholder"]) {
        expect(body(sel), sel).toMatch(/color:\s*var\(--muted-text\)/);
      }
    });

    it("keeps the readable muted text at 4.5:1 or more on the pane and the chat card, in both themes", () => {
      for (const [muted, surface] of [
        [lightToken("muted-text"), lightToken("pane")],
        [lightToken("muted-text"), lightToken("sidebar")],
        [token("muted-text"), token("pane")],
        [token("muted-text"), token("sidebar")],
      ]) {
        expect(muted).not.toBe("");
        expect(surface).not.toBe("");
        expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
