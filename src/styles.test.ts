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
  // The dark theme's two blocks: macOS's, when Settings follows it, and the one Settings forces.
  const system = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)?.[1] ?? "";
  const forced = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1] ?? "";
  const light = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
  const tokenIn = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, "i"))?.[1] ?? "";
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
  // Each declaration as "name: value", so the two dark blocks can be compared line for line.
  const declarations = (block: string) =>
    block
      .split(";")
      .map((d) => d.replace(/\/\*.*?\*\//g, "").trim())
      .filter(Boolean);

  it("gives a dark code block a background of its own, readable, on the pane and the chat card", () => {
    for (const block of [system, forced]) {
      const code = tokenIn(block, "code-bg");
      expect(code).not.toBe("");
      expect(code).not.toBe(tokenIn(block, "pane"));
      expect(code).not.toBe(tokenIn(block, "sidebar"));
      expect(contrast(tokenIn(block, "text"), code)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps a selected item's fill when the pointer is over it", () => {
    for (const sel of [".mode-guide-tab.active:hover", ".skill-row.active:hover", ".menu-row.current:hover", ".search-toggle.on:hover"]) {
      expect(css).toContain(sel);
    }
  });

  it("has the forced dark theme use the same colours as macOS's dark theme, so they can't drift apart", () => {
    expect(system).not.toBe("");
    expect(declarations(forced).filter((d) => !d.startsWith("color-scheme"))).toEqual(declarations(system));
  });

  it("lets every dark-only rule give way to a forced light, so no colour sticks to macOS's dark", () => {
    const guarded = [...css.matchAll(/prefers-color-scheme: dark\) \{\s*([^{]*)\{/g)].map((m) => m[1].trim());
    expect(guarded.length).toBeGreaterThan(1);
    for (const selector of guarded) expect(selector).toBe(':root:not([data-theme="light"])');
  });

  it("forces light by leaving the light tokens alone, and keeps macOS's dark tokens off a forced light", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(css).toMatch(/:root\[data-theme="light"\] \{\s*color-scheme: light;?\s*\}/);
    expect(tokenIn(light, "bg")).toBe("#ffffff");
  });

  it("scales every font size by Settings' text size, so none is a bare px value", () => {
    expect(css).toMatch(/--font-scale: 1;/);
    expect(css).not.toMatch(/font(?:-size)?:\s*(?:\d+\s+)*\d+(?:\.\d+)?px/);
  });

  describe("small text that has to be read", () => {
    // Each rule is on one line. The tab track sits on the glass capsule, which is see-through, so the test checks the
    // opaque surfaces it's over (the pane and the chat card): the glass is a shade of them.
    const body = (sel: string) => css.split("\n").find((l) => l.startsWith(`${sel} {`)) ?? "";

    it("uses the readable muted text, not the faint or decorative grey, for placeholders and the tab track", () => {
      for (const sel of [".pane-tabs-track button", ".menu-search::placeholder", ".repro-input::placeholder"]) {
        expect(body(sel), sel).toMatch(/color:\s*var\(--muted-text\)/);
      }
    });

    it("keeps the readable muted text at 4.5:1 or more on the pane and the chat card, in every theme", () => {
      for (const block of [light, system, forced]) {
        for (const surface of ["pane", "sidebar"]) {
          const muted = tokenIn(block, "muted-text");
          const background = tokenIn(block, surface);
          expect(muted).not.toBe("");
          expect(background).not.toBe("");
          expect(contrast(muted, background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  });
});
