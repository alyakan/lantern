import { describe, expect, it } from "vitest";
import { contrast, luminance, parseHex } from "./lib/color";
import { THEMES } from "./lib/themes";
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
  const system = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\), :root\[data-theme="system"\] \{([^}]*)\}/)?.[1] ?? "";
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

  it("keeps macOS's dark colours to \"system\", so no theme picks them up by accident", () => {
    const SYSTEM = ':root:not([data-theme]), :root[data-theme="system"]';
    const guarded = [...css.matchAll(/prefers-color-scheme: dark\) \{\s*([^{]*)\{/g)].map((m) => m[1].trim());
    expect(guarded.length).toBeGreaterThan(0);
    for (const selector of guarded) expect(selector).toBe(SYSTEM);
  });

  it("forces light by leaving the light tokens alone, and keeps macOS's dark tokens off a forced light", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\), :root\[data-theme="system"\] \{/);
    expect(css).toMatch(/:root\[data-theme="light"\] \{\s*color-scheme: light;?\s*\}/);
    expect(tokenIn(light, "bg")).toBe("#ffffff");
  });

  it("keeps every colour in a token: rules use var(--…), not a hex or rgb value", () => {
    const rules = css
      .split("\n")
      // The blocks of tokens themselves, which are where colours are written.
      .filter((l) => !/^\s*--[\w-]+:/.test(l) && !/^:root\s*\{\s*--/.test(l))
      .filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l.replace(/\/\*.*?\*\//g, "")));
    // A mask's #000 carries no colour; nothing else is left over.
    expect(rules.filter((l) => !l.includes("-webkit-mask"))).toEqual([]);
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

describe("themes", () => {
  const block = (id: string) => css.match(new RegExp(`:root\\[data-theme="${id}"\\] \\{([^}]*)\\}`))?.[1] ?? "";
  const token = (b: string, name: string) => b.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim() ?? "";
  const names = (b: string) => [...b.matchAll(/--([\w-]+):/g)].map((m) => m[1]);
  // Dark's tokens are the full list of colours a theme has to give; Light's block is `:root`, with the shared ones too.
  const colourTokens = names(block("dark")).filter((n) => !/^(shadow|card-shadow)$/.test(n));
  const own = THEMES.filter((t) => ["terminal", "solarized", "nord", "paper"].includes(t.id));

  it("has a block for each preset, with every colour token Dark has", () => {
    for (const { id } of own) {
      const b = block(id);
      expect(b, id).not.toBe("");
      expect(colourTokens.filter((n) => !names(b).includes(n)), id).toEqual([]);
      expect(b, id).toMatch(new RegExp(`color-scheme: ${THEMES.find((t) => t.id === id)!.scheme};`));
    }
  });

  it("gives each theme's swatch the colours its tokens have, so the picker shows what you get", () => {
    const fromCss = (id: string) => {
      const b = id === "light" ? css.match(/:root \{([^}]*)\}/)![1] : block(id);
      return { bg: token(b, "bg"), panel: token(b, "sidebar"), text: token(b, "text"), text2: token(b, "text-2"), accent: token(b, "accent"), line: token(b, "line") };
    };
    for (const t of THEMES.filter((t) => t.picks && t.id !== "custom")) expect(t.picks, t.id).toEqual(fromCss(t.id));
  });

  // Body text 4.5:1 and large or interface text 3:1 (WCAG AA), on the surfaces they sit on.
  const bodyText: [string, string][] = [["text", "bg"], ["text", "pane"], ["text", "sidebar"], ["text", "code-bg"], ["text", "bg-user"], ["text", "info-bg"], ["text", "error-bg"], ["text", "auth-bg"], ["text-2", "pane"], ["text-2", "sidebar"], ["muted-text", "pane"], ["muted-text", "sidebar"], ["accent-text", "accent"], ["add", "pane"], ["add", "sidebar"], ["del", "pane"], ["del", "sidebar"], ["warn", "pane"], ["attn-text", "sidebar"], ["sev-should-text", "pane"]];
  const uiText: [string, string][] = [["muted", "pane"], ["accent", "bg"], ["working", "pane"], ["unread", "pane"], ["sev-blocker", "pane"]];

  it("keeps each theme's text readable: 4.5:1 for body text, 3:1 for interface colours", () => {
    for (const { id } of own) {
      const b = block(id);
      for (const [fg, bg] of bodyText) expect(contrast(token(b, fg), token(b, bg)), `${id}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of uiText) expect(contrast(token(b, fg), token(b, bg)), `${id}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the diff's red and green apart in every theme: green and red, at least 90 degrees of hue apart", () => {
    const hue = (hex: string) => {
      const [r, g, b] = parseHex(hex).map((c) => c / 255);
      const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
      const h = max === r ? (g - b) / (max - min) : max === g ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min);
      return (h * 60 + 360) % 360;
    };
    for (const { id } of own) {
      const b = block(id);
      const [add, del] = [token(b, "add"), token(b, "del")];
      // Green is 60–180°, red is within 30° of 0° (either side).
      expect(hue(add), id).toBeGreaterThan(60);
      expect(hue(add), id).toBeLessThan(180);
      expect(Math.min(hue(del), 360 - hue(del)), id).toBeLessThan(30);
      expect(Math.abs(hue(add) - (hue(del) > 180 ? hue(del) - 360 : hue(del))), id).toBeGreaterThan(90);
    }
  });

  describe("Terminal", () => {
    const b = block("terminal");

    it("is phosphor green on near-black, with amber for \"working\"", () => {
      const [r, g, bl] = parseHex(token(b, "bg"));
      expect(Math.max(r, g, bl)).toBeLessThan(20);
      for (const name of ["text", "text-2", "accent"]) {
        const [cr, cg, cb] = parseHex(token(b, name));
        expect(cg, name).toBeGreaterThan(cr);
        expect(cg, name).toBeGreaterThan(cb);
      }
      const [wr, wg, wb] = parseHex(token(b, "working"));
      expect(wr).toBeGreaterThan(wg);
      expect(wg).toBeGreaterThan(wb);
      // Secondary text is dimmer than the text, the accent brighter.
      expect(luminance(token(b, "text-2"))).toBeLessThan(luminance(token(b, "text")));
      expect(luminance(token(b, "accent"))).toBeGreaterThan(luminance(token(b, "text")));
    });

    it("is all monospace, with square corners (0–2px) and no shadows but 1px lines", () => {
      expect(token(b, "ui")).toBe("var(--mono)");
      for (const radius of names(b).filter((n) => n.startsWith("radius"))) expect(parseFloat(token(b, radius)), radius).toBeLessThanOrEqual(2);
      // Every radius the stylesheet uses is one of those tokens (or a circle, or 2px or less).
      expect(names(b).filter((n) => n.startsWith("radius")).length).toBeGreaterThanOrEqual(8);
      for (const shadow of ["shadow", "card-shadow", "thumb-shadow", "badge-shadow", "lift-shadow", "hud-shadow"]) {
        expect(token(b, shadow), shadow).toMatch(/^0 0 0 1px var\(--[\w-]+\)$/);
      }
    });

    it("draws the chat card and the review pane as bordered boxes", () => {
      expect(token(b, "card-shadow")).toMatch(/1px/);
      expect(token(b, "pane-edge")).toMatch(/^inset 0 0 0 1px/);
      expect(css).toMatch(/\.review \{[^}]*box-shadow: var\(--pane-edge\)/);
    });
  });

  it("leaves the stylesheet's corners to tokens: no radius above 2px is hard-coded", () => {
    const fixed = [...css.matchAll(/border-radius:([^;}]*)/g)].flatMap((m) => [...m[1].matchAll(/([\d.]+)px/g)].map((n) => parseFloat(n[1])));
    expect(fixed.filter((px) => px > 2)).toEqual([]);
  });
});
