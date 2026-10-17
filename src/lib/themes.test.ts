import { describe, expect, it } from "vitest";
import { contrast, isHex } from "./color";
import { CUSTOM_DEFAULT, DARK_PICKS, LIGHT_PICKS, THEMES, deriveTokens, isThemeId, readCustom, schemeOf, startingPoint, textContrast, type CustomTheme } from "./themes";

const light: CustomTheme = { ...LIGHT_PICKS, mono: false, square: false };
const dark: CustomTheme = { ...DARK_PICKS, mono: false, square: false };

describe("the themes", () => {
  it("lists Follow macOS, Light and Dark, then the presets, then Custom", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["system", "light", "dark", "terminal", "fallout", "solarized", "nord", "paper", "posthog", "custom"]);
    expect(THEMES.every((t) => t.label)).toBe(true);
  });

  it("says which are dark and which light", () => {
    const scheme = Object.fromEntries(THEMES.map((t) => [t.id, t.scheme]));
    expect(scheme).toMatchObject({ light: "light", dark: "dark", terminal: "dark", fallout: "dark", solarized: "dark", nord: "dark", paper: "light", posthog: "light", system: null });
  });

  it("knows a theme id from anything else", () => {
    expect(isThemeId("nord")).toBe(true);
    expect(isThemeId("custom")).toBe(true);
    expect(isThemeId("neon")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });

  it("resolves a theme to light or dark: system by macOS, custom by its background", () => {
    expect(schemeOf("system", true, light)).toBe("dark");
    expect(schemeOf("system", false, dark)).toBe("light");
    expect(schemeOf("paper", true, dark)).toBe("light");
    expect(schemeOf("posthog", true, dark)).toBe("light");
    expect(schemeOf("terminal", false, light)).toBe("dark");
    expect(schemeOf("custom", false, dark)).toBe("dark");
    expect(schemeOf("custom", true, light)).toBe("light");
  });
});

describe("the custom theme's colours", () => {
  it("are read from storage, a colour at a time: what isn't a hex colour is the default's", () => {
    expect(readCustom(null)).toEqual(CUSTOM_DEFAULT);
    expect(readCustom({ bg: "#abcdef", accent: "url(evil)", square: true })).toEqual({ ...CUSTOM_DEFAULT, bg: "#abcdef", square: true });
    expect(readCustom("junk")).toEqual(CUSTOM_DEFAULT);
  });

  it("start from the theme that's on", () => {
    expect(startingPoint("paper", true, CUSTOM_DEFAULT)).toEqual({ ...THEMES.find((t) => t.id === "paper")!.picks, mono: false, square: false });
    expect(startingPoint("terminal", false, CUSTOM_DEFAULT)).toMatchObject({ mono: true, square: true });
    expect(startingPoint("fallout", false, CUSTOM_DEFAULT)).toMatchObject({ mono: true, square: true });
    // Follow macOS: whichever macOS is showing.
    expect(startingPoint("system", true, CUSTOM_DEFAULT)).toEqual(dark);
    expect(startingPoint("system", false, CUSTOM_DEFAULT)).toEqual(light);
    // From an earlier custom theme: that one.
    const mine = { ...dark, accent: "#ff00aa", mono: true };
    expect(startingPoint("custom", false, mine)).toBe(mine);
  });
});

describe("deriveTokens", () => {
  // Every token styles.css gives each theme, from the six colours.
  const COLOUR_TOKENS = ["bg", "pane", "sidebar", "field", "glass", "glass-line", "seg-track", "seg-thumb", "bg-subtle", "bg-hover", "bg-active", "bg-user", "line", "line-strong", "text", "text-2", "muted", "faint", "muted-text", "accent", "accent-soft", "accent-text", "working", "unread", "attn", "attn-text", "add", "del", "warn", "sev-blocker", "sev-should", "sev-should-text", "info-bg", "error-bg", "auth-bg", "code-bg", "pc-tint", "pc-ink", "shadow", "card-shadow", "md-strong", "md-heading", "md-link", "md-code-bg", "md-code-text", "md-quote-bar", "md-marker"];

  it("gives every colour token from just the six picks", () => {
    for (const c of [light, dark, { ...light, bg: "#fbf6ec", panel: "#f3ecdc" }]) {
      const t = deriveTokens(c);
      expect(COLOUR_TOKENS.filter((n) => !t[`--${n}`])).toEqual([]);
    }
  });

  it("uses the picks as they are", () => {
    const c = { ...dark, bg: "#101820", panel: "#18222d", text: "#f0f0f0", text2: "#c0c0c0", accent: "#ff8800", line: "#2a3846" };
    const t = deriveTokens(c);
    expect([t["--bg"], t["--pane"], t["--sidebar"], t["--text"], t["--text-2"], t["--accent"], t["--line"]]).toEqual([c.bg, c.bg, c.panel, c.text, c.text2, c.accent, c.line]);
  });

  it("makes hex colours of the derived ones, with an alpha for the washes", () => {
    const t = deriveTokens(dark);
    for (const n of ["muted", "faint", "muted-text", "line-strong", "bg-subtle", "bg-user", "accent-soft", "code-bg", "error-bg"]) expect(isHex(t[`--${n}`]), n).toBe(true);
    for (const n of ["glass", "glass-line", "bg-hover", "bg-active"]) expect(t[`--${n}`], n).toMatch(/^#[0-9a-f]{8}$/);
  });

  it("is light or dark by the background, which color-scheme says", () => {
    expect(deriveTokens(dark)["color-scheme"]).toBe("dark");
    expect(deriveTokens(light)["color-scheme"]).toBe("light");
    expect(deriveTokens({ ...light, bg: "#fbf6ec", panel: "#f3ecdc" })["color-scheme"]).toBe("light");
  });

  it("keeps the text it derives readable on the background and the panel (4.5:1), and the interface colours at 3:1", () => {
    // Including picks that are hard to work with: mid-greys, where nudging toward white or black is the only way.
    const hard: CustomTheme[] = [light, dark, { ...dark, bg: "#6b6b6b", panel: "#707070", text: "#ffffff", text2: "#eeeeee" }, { ...light, bg: "#c8c8c8", panel: "#b8b8b8", text: "#000000", text2: "#222222" }, { ...dark, bg: "#fbf6ec", panel: "#ffffff", text: "#222222", text2: "#555555" }];
    for (const c of hard) {
      const t = deriveTokens(c);
      for (const surface of [c.bg, c.panel]) {
        for (const n of ["muted-text", "add", "del", "warn", "attn-text", "sev-should-text"]) expect(contrast(t[`--${n}`], surface), `${n} on ${surface} in ${c.bg}`).toBeGreaterThanOrEqual(4.5);
        for (const n of ["working", "unread", "attn", "sev-blocker", "sev-should"]) expect(contrast(t[`--${n}`], surface), `${n} on ${surface} in ${c.bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("styles bold, headings, links and inline code so they read on the surfaces they sit on, and bold stands out from the text", () => {
    const hard: CustomTheme[] = [light, dark, { ...dark, bg: "#6b6b6b", panel: "#707070", text: "#ffffff", text2: "#eeeeee" }, { ...light, bg: "#c8c8c8", panel: "#b8b8b8", text: "#000000", text2: "#222222" }, { ...dark, accent: "#303030" }];
    for (const c of hard) {
      const t = deriveTokens(c);
      for (const surface of [c.bg, c.panel]) for (const n of ["md-strong", "md-heading", "md-link"]) expect(contrast(t[`--${n}`], surface), `${n} on ${surface} in ${c.bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--md-code-text"], t["--md-code-bg"]), `code in ${c.bg}`).toBeGreaterThanOrEqual(4.5);
      expect(t["--md-code-bg"], `chip in ${c.bg}`).not.toBe(t["--sidebar"]);
    }
    // Bold is further from the background than the text is: brighter on a dark theme, darker on a light one.
    expect(contrast(deriveTokens(dark)["--md-strong"], dark.bg)).toBeGreaterThan(contrast(dark.text, dark.bg));
    expect(contrast(deriveTokens(light)["--md-strong"], light.bg)).toBeGreaterThan(contrast(light.text, light.bg));
  });

  it("makes text on the accent readable", () => {
    for (const accent of ["#e6e6e7", "#1d1d1f", "#ff8800", "#2aa198", "#6b3f1d"]) {
      const t = deriveTokens({ ...dark, accent });
      expect(contrast(t["--accent-text"], accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("goes monospace and square only when asked", () => {
    const plain = deriveTokens(dark);
    expect(plain["--ui"]).toBeUndefined();
    expect(plain["--radius"]).toBeUndefined();
    const asked = deriveTokens({ ...dark, mono: true, square: true });
    expect(asked["--ui"]).toBe("var(--mono)");
    for (const r of ["radius", "radius-inner", "radius-chip", "radius-float", "radius-md", "radius-card", "radius-hud", "radius-pill"]) expect(asked[`--${r}`], r).toBe("0");
  });

  it("gives a dark theme's code blocks a background darker than the panels, and a light one's a shade of the text", () => {
    const d = deriveTokens(dark);
    expect(contrast(d["--code-bg"], "#000000")).toBeLessThan(contrast(dark.bg, "#000000"));
    const l = deriveTokens(light);
    expect(l["--code-bg"]).not.toBe(l["--bg"]);
    expect(contrast(l["--text"], l["--code-bg"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("textContrast", () => {
  it("is the worse of the text on the background and on the panel", () => {
    const { ratio, ok } = textContrast({ bg: "#ffffff", panel: "#808080", text: "#000000" });
    expect(ratio).toBeCloseTo(contrast("#000000", "#808080"));
    expect(ok).toBe(true);
    expect(textContrast({ bg: "#ffffff", panel: "#f5f5f7", text: "#aaaaaa" }).ok).toBe(false);
  });

  it("is OK at 4.5:1 and not below", () => {
    expect(textContrast({ bg: "#ffffff", panel: "#ffffff", text: "#767676" }).ok).toBe(true);
    expect(textContrast({ bg: "#ffffff", panel: "#ffffff", text: "#7a7a7a" }).ok).toBe(false);
  });
});

describe("a custom theme that came from storage or anywhere else", () => {
  const HOSTILE = ["red", "#12", "#12345", "#1234567", "#12345678", "url(https://evil.test/x)", "#fff; background: url(x)", "#fff}", "#fff /*", "var(--x)", "expression(1)", "#ggg", "", " #ffffff", "#ffffff\n", 12, null, undefined, {}, [], ["#ffffff"], true];

  it("keeps only strict hex colours (#rgb or #rrggbb), written out as #rrggbb in lower case", () => {
    expect(readCustom({ bg: "#ABC", panel: "#A1B2C3" })).toMatchObject({ bg: "#aabbcc", panel: "#a1b2c3" });
    for (const bad of HOSTILE) expect(readCustom({ bg: bad, text: bad, accent: bad })).toEqual(CUSTOM_DEFAULT);
  });

  it("takes anything that isn't an object for no custom theme at all", () => {
    for (const junk of [null, undefined, "junk", 7, true, [], [1, 2], () => 1]) expect(readCustom(junk)).toEqual(CUSTOM_DEFAULT);
  });

  it("takes the monospace and square switches only when they are exactly true", () => {
    for (const bad of ["true", 1, "yes", {}, [true]]) expect(readCustom({ mono: bad, square: bad })).toMatchObject({ mono: false, square: false });
  });

  it("derives tokens made only of hex colours, fixed shadows and percentages, whatever the picks were", () => {
    const allowed = /^(#[0-9a-f]{6}([0-9a-f]{2})?|\d+%|\d+|light|dark|var\(--mono\)|(0 0 0 0\.5px|0 1[02]px 3[02]px|0 4px 16px)[0-9a-z ().,\-]*)$/;
    for (const bad of HOSTILE) {
      const tokens = deriveTokens(readCustom({ bg: bad, panel: bad, text: bad, text2: bad, accent: bad, line: bad, mono: true, square: true }));
      for (const [name, value] of Object.entries(tokens)) {
        expect(value, name).toMatch(allowed);
        expect(value, name).not.toMatch(/[;{}<>"'\\]|url|expression|\/\*/);
      }
    }
  });
});
