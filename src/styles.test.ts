import { describe, expect, it } from "vitest";
import { contrast, ensureContrast, isDark, luminance, mix, parseHex } from "./lib/color";
import { syntaxFor } from "./lib/monacoTheme";
import { PROJECT_COLORS } from "./lib/projectColors";
import { THEMES, type ThemeId } from "./lib/themes";
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
  const own = THEMES.filter((t) => ["terminal", "fallout", "solarized", "nord", "paper", "posthog"].includes(t.id));

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

  // A theme's value for a token, following var() to wherever it comes from: the theme's own block, else the defaults in :root.
  const rootBlock = css.match(/:root \{([^}]*)\}/)![1];
  const resolve = (id: string, name: string, depth = 0): string => {
    const raw = token(block(id), name) || token(rootBlock, name);
    const ref = raw.match(/^var\(--([\w-]+)\)$/)?.[1];
    if (ref && depth < 5) return resolve(id, ref, depth + 1);
    if (raw === "currentColor") return resolve(id, "text");
    if (raw === "transparent") return resolve(id, "sidebar");
    return raw;
  };
  const hueOf = (hex: string) => {
    const [r, g, b] = parseHex(hex).map((c) => c / 255);
    const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
    if (max === min) return 0;
    const h = max === r ? (g - b) / (max - min) : max === g ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min);
    return (h * 60 + 360) % 360;
  };

  describe("contrast", () => {
    // A theme's tokens as hex; a hover or active wash (#rrggbbaa) is laid over the surface it sits on.
    const hexOf = (id: string, name: string) => resolve(id, name).slice(0, 7);
    const wash = (id: string, name: string, over: string) => {
      const raw = resolve(id, name);
      return mix(resolve(id, over), raw.slice(0, 7), parseInt(raw.slice(7, 9) || "ff", 16) / 255);
    };
    const percent = (id: string, name: string) => parseFloat(resolve(id, name)) / 100;
    const surfaces = ["pane", "sidebar", "bg-subtle", "bg-user", "code-bg", "info-bg", "error-bg", "auth-bg"];
    const at = (id: string, label: string, fg: string, bg: string, min: number) => expect(contrast(fg, bg), `${id}: ${label}`).toBeGreaterThanOrEqual(min);
    const each = (fn: (id: string, t: (name: string) => string) => void) => {
      for (const { id } of own) fn(id, (name) => hexOf(id, name));
    };

    it("reads the text, secondary text and muted text on every surface and under every hover and selection", () => {
      each((id, t) => {
        for (const s of surfaces) {
          at(id, `text on ${s}`, t("text"), t(s), 4.5);
          at(id, `text-2 on ${s}`, t("text-2"), t(s), 4.5);
          at(id, `muted-text on ${s}`, t("muted-text"), t(s), 4.5);
        }
        for (const s of ["pane", "sidebar"]) {
          at(id, `text on ${s}, for body text`, t("text"), t(s), 7);
          at(id, `text on seg-thumb over ${s}`, t("text"), wash(id, "seg-thumb", s), 4.5);
          for (const w of ["bg-hover", "bg-active"]) {
            at(id, `text on ${w} over ${s}`, t("text"), wash(id, w, s), 4.5);
            at(id, `text-2 on ${w} over ${s}`, t("text-2"), wash(id, w, s), 4.5);
            at(id, `muted-text on ${w} over ${s}`, t("muted-text"), wash(id, w, s), 4.5);
          }
        }
        // The muted grey (icons, placeholders, the focus ring) is text-grade too; faint is for hints and marks, 3:1.
        for (const s of ["bg", "pane", "sidebar", "field"]) {
          at(id, `muted on ${s}`, t("muted"), t(s), 4.5);
          at(id, `faint on ${s}`, t("faint"), t(s), 3);
        }
      });
    });

    it("keeps the order text, then secondary text, then muted text, on the pane and the chat card", () => {
      each((id, t) => {
        for (const s of ["pane", "sidebar"]) {
          expect(contrast(t("text"), t(s)), `${id}: text vs text-2 on ${s}`).toBeGreaterThan(contrast(t("text-2"), t(s)));
          expect(contrast(t("text-2"), t(s)), `${id}: text-2 vs muted-text on ${s}`).toBeGreaterThan(contrast(t("muted-text"), t(s)));
        }
      });
    });

    it("reads every status colour as text on the surfaces it sits on, and its dot or ring at 3:1", () => {
      each((id, t) => {
        for (const n of ["add", "del", "warn", "attn-text", "sev-should-text"]) {
          for (const s of ["pane", "sidebar", "bg-subtle", "info-bg", "error-bg", "auth-bg"]) at(id, `${n} on ${s}`, t(n), t(s), 4.5);
        }
        for (const n of ["working", "unread", "sev-blocker"]) for (const s of ["pane", "sidebar"]) at(id, `${n} on ${s}`, t(n), t(s), 4.5);
        for (const n of ["attn", "sev-should", "accent"]) for (const s of ["pane", "sidebar"]) at(id, `${n} on ${s}`, t(n), t(s), 3);
      });
    });

    it("reads the text on a primary button, a red confirm button, a check mark, an issue badge and the inbox badge", () => {
      each((id, t) => {
        at(id, "accent-text on accent", t("accent-text"), t("accent"), 4.5);
        for (const n of ["add", "del", "warn"]) at(id, `on-status on ${n}`, t("on-status"), t(n), 4.5);
        at(id, "on-attn on attn", t("on-attn"), t("attn"), 4.5);
        // PostHog's accent text is near-black, for its orange; its red button takes the white card's colour.
        at(id, "red confirm button", id === "posthog" ? t("sidebar") : t("accent-text"), t("del"), 4.5);
        at(id, "del on field", t("del"), t("field"), 4.5);
        at(id, "del on bg-subtle (the permission card)", t("del"), t("bg-subtle"), 4.5);
      });
    });

    it("draws a card's edge and separates the surfaces and the hover and selection fills from each other", () => {
      each((id, t) => {
        for (const s of ["pane", "sidebar"]) {
          at(id, `line-strong vs ${s}`, t("line-strong"), t(s), 1.5);
          at(id, `line vs ${s}`, t("line"), t(s), 1.1);
        }
        at(id, "sidebar vs pane", t("sidebar"), t("pane"), 1.08);
        at(id, "sidebar vs bg-subtle", t("sidebar"), t("bg-subtle"), 1.04);
        at(id, "sidebar vs code-bg", t("sidebar"), t("code-bg"), 1.08);
        for (const s of ["pane", "sidebar"]) {
          at(id, `hover vs ${s}`, wash(id, "bg-hover", s), t(s), 1.07);
          at(id, `active vs ${s}`, wash(id, "bg-active", s), t(s), 1.1);
          at(id, `active vs hover over ${s}`, wash(id, "bg-active", s), wash(id, "bg-hover", s), 1.03);
        }
      });
    });

    it("draws the Storage panel's seven kinds in colours that show at 3:1 on the pane, the card and the panel, and tell apart from each other", () => {
      // CIE Lab distance (1976): about 2.3 is the least a person can tell apart; 20 is plainly different, side by side in a bar.
      const lab = (hex: string) => {
        const [r, g, b] = parseHex(hex).map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
        const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
        return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
      };
      const apart = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
      const kinds = [1, 2, 3, 4, 5, 6, 7].map((n) => `storage-${n}`);
      // Light and the two dark blocks are checked from the file as well: they are the defaults the other themes start from.
      const systemDark = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\), :root\[data-theme="system"\] \{([^}]*)\}/)![1];
      const palettes: [string, (n: string) => string, string[]][] = [
        ["light", (n) => token(rootBlock, n), ["pane", "sidebar", "field"].map((s) => token(rootBlock, s))],
        ["system dark", (n) => token(systemDark, n), ["pane", "sidebar", "field"].map((s) => token(systemDark, s))],
        ...own.map((o): [string, (n: string) => string, string[]] => [o.id, (n) => hexOf(o.id, n), ["pane", "sidebar", "field"].map((s) => hexOf(o.id, s))]),
      ];
      for (const [id, colour, surfaces] of palettes) {
        for (const n of kinds) {
          expect(colour(n), `${id}: ${n} is a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
          for (const s of surfaces) expect(contrast(colour(n), s), `${id}: ${n} on ${s}`).toBeGreaterThanOrEqual(3);
        }
        for (let i = 0; i < kinds.length; i++) {
          for (let j = i + 1; j < kinds.length; j++) expect(apart(colour(kinds[i]), colour(kinds[j])), `${id}: ${kinds[i]} vs ${kinds[j]}`).toBeGreaterThanOrEqual(20);
        }
      }
    });

    it("tints a project's chip so its letter reads, on the chip and on the card", () => {
      each((id, t) => {
        for (const pc of PROJECT_COLORS) {
          const letter = mix(t("text"), pc, percent(id, "pc-ink"));
          at(id, `${pc} letter on its chip`, letter, mix(t("bg"), pc, percent(id, "pc-tint")), 4.5);
          at(id, `${pc} letter on the card`, letter, t("sidebar"), 4.5);
        }
      });
    });

    it("draws code in colours that read on the editor and on a code block (comments 4:1)", () => {
      each((id, t) => {
        const syntax = syntaxFor(id as ThemeId, isDark(t("pane")));
        for (const [role, raw] of Object.entries(syntax)) {
          const min = role === "comment" ? 4 : 4.5;
          // Xcode's colours (PostHog's) are moved by the editor until they read; the others' own must read as they are.
          const drawn = id === "posthog" ? ensureContrast(raw, t("pane"), 4.5) : raw;
          at(id, `${role} on the editor`, drawn, t("pane"), min);
          at(id, `${role} on a code block`, drawn, t("md-pre-bg"), min);
        }
        at(id, "text on a code block", t("text"), t("md-pre-bg"), 4.5);
      });
    });

    it("reads the text on a diagram's node, new, changed and removed", () => {
      each((id, t) => {
        for (const [colour, amount] of [["#2ea043", 0.2], ["#d9a300", 0.2], ["#e5484d", 0.133]] as const) {
          at(id, `text on a ${colour} node`, t("text"), mix(t("sidebar"), colour, amount), 4.5);
        }
      });
    });
  });

  describe("markdown tokens", () => {
    const md = names(rootBlock).filter((n) => n.startsWith("md-"));

    it("are in the defaults, and Light and Dark leave them alone, so their text is styled as it always was", () => {
      expect(md).toEqual(expect.arrayContaining(["md-strong", "md-code-bg", "md-code-text", "md-link", "md-quote-bar", "md-heading", "md-pre-bg", "md-th-bg", "md-marker"]));
      for (const b of [css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)![1], css.match(/:root:not\(\[data-theme\]\), :root\[data-theme="system"\] \{([^}]*)\}/)![1]]) {
        expect(names(b).filter((n) => /^(md|user|crt|caret)-/.test(n))).toEqual([]);
      }
      // The defaults are what the rules said before the tokens: the text's own colour, Dark's code background, and so on.
      expect(token(rootBlock, "md-strong")).toBe("currentColor");
      expect(token(rootBlock, "md-strong-weight")).toBe("bolder");
      expect(token(rootBlock, "md-code-bg")).toBe("var(--code-bg)");
      expect(token(rootBlock, "md-link")).toBe("var(--text)");
      expect(token(rootBlock, "md-link-line")).toBe("var(--faint)");
      expect(token(rootBlock, "md-quote-bar")).toBe("var(--line-strong)");
      expect(token(rootBlock, "md-quote-text")).toBe("var(--text-2)");
      expect(token(rootBlock, "md-th-bg")).toBe("var(--bg-subtle)");
      expect(token(rootBlock, "md-pre-head-text")).toBe("var(--muted)");
    });

    it("are what the markdown rules use", () => {
      const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(`${sel} {`)) ?? "";
      expect(rule(".msg.assistant strong")).toMatch(/color: var\(--md-strong\)/);
      expect(rule(".msg.assistant code")).toMatch(/background: var\(--md-code-bg\); color: var\(--md-code-text\)/);
      expect(rule(".msg.assistant a")).toMatch(/color: var\(--md-link\)/);
      expect(rule(".msg.assistant blockquote")).toMatch(/var\(--md-quote-bar\)/);
      expect(rule(".code-block")).toMatch(/background: var\(--md-pre-bg\)/);
      expect(rule(".msg.assistant .md-table th")).toMatch(/background: var\(--md-th-bg\)/);
    });

    it("read at 4.5:1 or more in every theme: bold, headings, links, inline code, quotes, table headers and code headers", () => {
      for (const { id } of own) {
        const on = (fg: string, bg: string, min = 4.5) => expect(contrast(resolve(id, fg), resolve(id, bg)), `${id}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        for (const surface of ["pane", "sidebar"]) for (const n of ["md-strong", "md-heading", "md-link", "md-em"]) on(n, surface);
        on("md-code-text", "md-code-bg");
        on("md-pre-text", "md-pre-bg");
        // A code block's header keeps Light's and Dark's muted grey unless the theme gives it a bar of its own.
        if (token(block(id), "md-pre-head-bg")) on("md-pre-head-text", "md-pre-head-bg");
        on("md-quote-text", "md-quote-bg");
        on("md-th-text", "md-th-bg");
        // A quote's bar (where the theme gives it a colour; the others keep their line's) and a list's bullets are marks, not text: 3:1.
        if (token(block(id), "md-quote-bar")) on("md-quote-bar", "sidebar", 3);
        on("md-marker", "sidebar", 3);
      }
    });
  });

  describe("Terminal", () => {
    const rs = (n: string) => resolve("terminal", n);

    it("is a modern terminal: a near-black, slightly cool background, light neutral text, and colour with a role each", () => {
      const [r, g, bl] = parseHex(rs("bg"));
      expect(Math.max(r, g, bl)).toBeLessThan(32);
      expect(bl).toBeGreaterThanOrEqual(r);
      // The text is light and nearly neutral, not tinted green.
      const [tr, tg, tb] = parseHex(rs("text"));
      expect(Math.min(tr, tg, tb)).toBeGreaterThan(190);
      expect(Math.max(tr, tg, tb) - Math.min(tr, tg, tb)).toBeLessThan(30);
      expect(luminance(rs("text-2"))).toBeLessThan(luminance(rs("text")));
      expect(luminance(rs("muted"))).toBeLessThan(luminance(rs("text-2")));
      // Green is an addition, red a removal, yellow is "working", blue the accent and links, purple emphasis.
      expect(hueOf(rs("add"))).toBeGreaterThan(100);
      expect(hueOf(rs("add"))).toBeLessThan(150);
      expect(Math.min(hueOf(rs("del")), 360 - hueOf(rs("del")))).toBeLessThan(15);
      expect(hueOf(rs("working"))).toBeGreaterThan(30);
      expect(hueOf(rs("working"))).toBeLessThan(55);
      for (const n of ["accent", "md-link"]) {
        expect(hueOf(rs(n)), n).toBeGreaterThan(195);
        expect(hueOf(rs(n)), n).toBeLessThan(225);
      }
      expect(hueOf(rs("md-em"))).toBeGreaterThan(260);
      expect(hueOf(rs("md-em"))).toBeLessThan(290);
    });

    it("tells bold, inline code, code blocks, links and quotes apart from the text", () => {
      // Bold is brighter than the text and heavier; inline code is a chip of its own colour with an accent text colour.
      expect(luminance(rs("md-strong"))).toBeGreaterThan(luminance(rs("text")));
      expect(rs("md-strong-weight")).toBe("700");
      expect(rs("md-code-bg")).not.toBe(rs("sidebar"));
      expect(contrast(rs("md-code-bg"), rs("sidebar"))).toBeGreaterThanOrEqual(1.2);
      expect(rs("md-code-text")).not.toBe(rs("text"));
      expect(hueOf(rs("md-code-text"))).toBeGreaterThan(15);
      expect(hueOf(rs("md-code-text"))).toBeLessThan(40);
      // A code block is another panel than the chat card; a link is coloured (and underlined by the rules); a quote has a coloured bar.
      expect(rs("md-pre-bg")).not.toBe(rs("sidebar"));
      expect(rs("md-link")).not.toBe(rs("text"));
      expect(rs("md-quote-bar")).not.toBe(rs("md-quote-text"));
      expect(rs("md-heading")).not.toBe(rs("text"));
    });

    it("is all monospace, with square corners (0–3px) and no shadows but 1px lines", () => {
      expect(token(block("terminal"), "ui")).toBe("var(--mono)");
      for (const radius of names(block("terminal")).filter((n) => n.startsWith("radius"))) expect(parseFloat(rs(radius)), radius).toBeLessThanOrEqual(3);
      expect(names(block("terminal")).filter((n) => n.startsWith("radius")).length).toBeGreaterThanOrEqual(8);
      for (const shadow of ["shadow", "card-shadow", "thumb-shadow", "badge-shadow", "lift-shadow", "hud-shadow"]) {
        expect(rs(shadow), shadow).toMatch(/^0 0 0 1px var\(--[\w-]+\)$/);
      }
    });

    it("draws the chat card and the review pane as bordered boxes, and has no glow or scanlines", () => {
      expect(rs("card-shadow")).toMatch(/1px/);
      expect(rs("pane-edge")).toMatch(/^inset 0 0 0 1px/);
      expect(css).toMatch(/\.review \{[^}]*box-shadow: var\(--pane-edge\)/);
      expect(rs("term-glow")).toBe("none");
      expect(rs("crt-on")).toBe("none");
    });
  });

  describe("Fallout", () => {
    const rs = (n: string) => resolve("fallout", n);
    const green = (hex: string) => {
      const [r, g, b] = parseHex(hex);
      return g > r && g > b;
    };

    it("is phosphor green on a very dark green-black, with amber for \"working\"", () => {
      const [r, g, bl] = parseHex(rs("bg"));
      expect(Math.max(r, g, bl)).toBeLessThan(20);
      expect(g).toBeGreaterThan(r);
      for (const n of ["text", "text-2", "accent", "md-strong", "md-heading", "md-link"]) expect(green(rs(n)), n).toBe(true);
      // The three levels are a real green, not a grey: the text's red is under half its green.
      for (const n of ["text", "text-2"]) expect(parseHex(rs(n))[0], n).toBeLessThan(parseHex(rs(n))[1] / 2);
      expect(hueOf(rs("working"))).toBeGreaterThan(30);
      expect(hueOf(rs("working"))).toBeLessThan(55);
    });

    it("has three clearly separate greens: bright for bold and headings, normal for text, dim for what is secondary", () => {
      expect(rs("md-strong")).toBe(rs("md-heading"));
      expect(contrast(rs("md-strong"), rs("text"))).toBeGreaterThanOrEqual(1.4);
      expect(contrast(rs("text"), rs("text-2"))).toBeGreaterThanOrEqual(1.7);
      expect(luminance(rs("md-strong"))).toBeGreaterThan(luminance(rs("text")));
      expect(luminance(rs("text"))).toBeGreaterThan(luminance(rs("text-2")));
      expect(luminance(rs("text-2"))).toBeGreaterThan(luminance(rs("muted")));
      expect(rs("md-strong-glow")).toMatch(/^0 0 \d+px/);
    });

    it("solves green on green with structure: inline code and code headers in reverse video, boxed blocks, a marked prompt", () => {
      // Reverse video: dark text on a bright block, readable at well over 4.5:1.
      expect(luminance(rs("md-code-text"))).toBeLessThan(luminance(rs("md-code-bg")));
      expect(contrast(rs("md-code-text"), rs("md-code-bg"))).toBeGreaterThanOrEqual(7);
      expect(luminance(rs("md-pre-head-text"))).toBeLessThan(luminance(rs("md-pre-head-bg")));
      expect(rs("md-pre-line")).not.toBe(rs("bg"));
      // What you sent is in a box and starts with a prompt; Claude's reply is neither.
      expect(rs("user-mark")).toBe('">"');
      expect(rs("user-border")).toMatch(/^1px solid/);
      expect(rs("label-case")).toBe("uppercase");
      expect(rs("md-heading-case")).toBe("uppercase");
    });

    it("has a CRT's scanlines and vignette that never take a click and never move", () => {
      expect(rs("crt-on")).toBe('""');
      expect(rs("caret-shape")).toBe("block");
      const rule = css.split("\n").find((l) => l.startsWith("body::after {")) ?? "";
      expect(rule).toMatch(/pointer-events: none/);
      expect(rule).toMatch(/position: fixed/);
      expect(rule).not.toMatch(/animation/);
      expect(css).not.toMatch(/@keyframes[^{]*(?:scan|flicker|crt)/i);
    });

    it("is all monospace and square, with 1px lines", () => {
      expect(token(block("fallout"), "ui")).toBe("var(--mono)");
      for (const radius of names(block("fallout")).filter((n) => n.startsWith("radius"))) expect(parseFloat(rs(radius)), radius).toBe(0);
      expect(rs("shadow")).toMatch(/^0 0 0 1px var\(--[\w-]+\)$/);
      expect(rs("pane-edge")).toMatch(/^inset 0 0 0 1px/);
    });
  });

  describe("PostHog", () => {
    const px = (name: string) => parseFloat(token(block("posthog"), name));

    it("has tighter corners than the default, with pills still round", () => {
      const root = css.match(/:root \{([^}]*)\}/)![1];
      for (const name of ["radius", "radius-inner", "radius-chip", "radius-float", "radius-md", "radius-card", "radius-hud"]) {
        expect(px(name), name).toBeLessThan(parseFloat(token(root, name)));
      }
      expect(names(block("posthog"))).not.toContain("radius-pill");
    });

    it("reads blue links and a visible focus ring on the cream and the white", () => {
      const b = block("posthog");
      for (const surface of ["bg", "sidebar"]) {
        expect(contrast(token(b, "md-link"), token(b, surface)), surface).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(b, "unread"), token(b, surface)), surface).toBeGreaterThanOrEqual(3);
      }
      expect(css).toMatch(/:root\[data-theme="posthog"\] button:focus-visible[^{]*\{ outline: 2px solid var\(--unread\)/);
    });

    it("turns the orange primary button yellow under the pointer, text still readable", () => {
      expect(css).toMatch(/:root\[data-theme="posthog"\] button\.primary:hover:not\(:disabled\) \{ background: var\(--accent-hover\);/);
      expect(contrast(token(block("posthog"), "accent-text"), token(block("posthog"), "accent-hover"))).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("leaves the stylesheet's corners to tokens: no radius above 2px is hard-coded", () => {
    const fixed = [...css.matchAll(/border-radius:([^;}]*)/g)].flatMap((m) => [...m[1].matchAll(/([\d.]+)px/g)].map((n) => parseFloat(n[1])));
    expect(fixed.filter((px) => px > 2)).toEqual([]);
  });
});
