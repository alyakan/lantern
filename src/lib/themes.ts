/**
 * The themes: what Settings offers, and the custom theme's colours. Light, Dark, Terminal, Fallout, Solarized, Nord, Paper and PostHog are
 * token sets in styles.css (data-theme on <html>); "custom" is computed here from the few colours the user picks and set
 * on <html> as inline custom properties (see applyTheme).
 */
import { alpha, contrast, ensureContrast, isDark, mix, normalizeHex, readableOn } from "./color";

export type ThemeId = "system" | "light" | "dark" | "terminal" | "fallout" | "solarized" | "nord" | "paper" | "posthog" | "custom";
export type Scheme = "light" | "dark";

/** The six colours a custom theme is made from; every other colour is derived from them. */
export interface Picks {
  /** Window, toolbar and the review pane. */
  bg: string;
  /** The chat card and the sidebar. */
  panel: string;
  text: string;
  text2: string;
  accent: string;
  line: string;
}

export interface CustomTheme extends Picks {
  /** Every font is the monospace one. */
  mono: boolean;
  /** Square corners instead of rounded ones. */
  square: boolean;
}

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  /** Light or dark; null for "system", which follows macOS. */
  scheme: Scheme | null;
  /** The theme's six main colours, for its swatch and as the custom editor's starting point; null for "system". */
  picks: Picks | null;
}

const pick = (bg: string, panel: string, text: string, text2: string, accent: string, line: string): Picks => ({ bg, panel, text, text2, accent, line });

export const LIGHT_PICKS = pick("#ffffff", "#f5f5f7", "#1d1d1f", "#48484a", "#1d1d1f", "#e5e5ea");
export const DARK_PICKS = pick("#1f1f24", "#29292e", "#dfdfe0", "#b9b9bd", "#e6e6e7", "#313137");

/** Every theme Settings offers, in the order it shows them. styles.test.ts keeps each one's picks equal to its tokens. */
export const THEMES: ThemeInfo[] = [
  { id: "system", label: "Follow macOS", scheme: null, picks: null },
  { id: "light", label: "Light", scheme: "light", picks: LIGHT_PICKS },
  { id: "dark", label: "Dark", scheme: "dark", picks: DARK_PICKS },
  { id: "terminal", label: "Terminal", scheme: "dark", picks: pick("#0d1117", "#11161d", "#d3d8e0", "#a9b1bb", "#58a6ff", "#21262d") },
  { id: "fallout", label: "Fallout", scheme: "dark", picks: pick("#020a04", "#051009", "#2adb5f", "#229e4e", "#c4ffd8", "#11401f") },
  { id: "solarized", label: "Solarized Dark", scheme: "dark", picks: pick("#002b36", "#073642", "#a2b1b1", "#93a1a1", "#2aa198", "#0f3f4c") },
  { id: "nord", label: "Nord", scheme: "dark", picks: pick("#2e3440", "#3b4252", "#eceff4", "#d8dee9", "#88c0d0", "#3f4759") },
  { id: "paper", label: "Paper", scheme: "light", picks: pick("#fbf6ec", "#f3ecdc", "#2b2620", "#52483d", "#6b3f1d", "#e4dac6") },
  { id: "posthog", label: "PostHog", scheme: "light", picks: pick("#eeefe9", "#ffffff", "#151515", "#4d4f46", "#f54e00", "#d0d1c9") },
  { id: "custom", label: "Custom", scheme: null, picks: null },
];

export const THEME_IDS = THEMES.map((t) => t.id);

export const isThemeId = (value: unknown): value is ThemeId => THEME_IDS.includes(value as ThemeId);

/** What the custom theme is before anything is picked: Dark's colours. */
export const CUSTOM_DEFAULT: CustomTheme = { ...DARK_PICKS, mono: false, square: false };

/** The custom theme with its colours checked: a saved one that isn't made of hex colours falls back to the default. */
export function readCustom(value: unknown): CustomTheme {
  const v = (value ?? {}) as Partial<CustomTheme>;
  const colour = (c: unknown, fallback: string) => normalizeHex(c) ?? fallback;
  return {
    bg: colour(v.bg, CUSTOM_DEFAULT.bg),
    panel: colour(v.panel, CUSTOM_DEFAULT.panel),
    text: colour(v.text, CUSTOM_DEFAULT.text),
    text2: colour(v.text2, CUSTOM_DEFAULT.text2),
    accent: colour(v.accent, CUSTOM_DEFAULT.accent),
    line: colour(v.line, CUSTOM_DEFAULT.line),
    mono: v.mono === true,
    square: v.square === true,
  };
}

/** The custom editor's starting point: the theme that's on now, as six colours (and Terminal's and Fallout's monospace, square look). */
export function startingPoint(theme: ThemeId, macDark: boolean, saved: CustomTheme): CustomTheme {
  if (theme === "custom") return saved;
  const info = THEMES.find((t) => t.id === theme);
  const picks = info?.picks ?? (macDark ? DARK_PICKS : LIGHT_PICKS);
  const terminal = theme === "terminal" || theme === "fallout";
  return { ...picks, mono: terminal, square: terminal };
}

/** Whether a theme is dark; "system" asks macOS (`macDark`), and "custom" its own background. */
export function schemeOf(theme: ThemeId, macDark: boolean, custom: CustomTheme): Scheme {
  if (theme === "system") return macDark ? "dark" : "light";
  if (theme === "custom") return isDark(custom.bg) ? "dark" : "light";
  return THEMES.find((t) => t.id === theme)?.scheme ?? "light";
}

/** Corners that are square: every radius token at 0 (circles stay round). */
const SQUARE: Record<string, string> = Object.fromEntries(
  ["radius", "radius-inner", "radius-chip", "radius-float", "radius-md", "radius-card", "radius-hud", "radius-pill"].map((n) => [`--${n}`, "0"]),
);

// The colours that mean something regardless of the theme, tuned for each kind of background; deriveTokens moves each
// until it reads on the picked ones.
const STATUS: Record<Scheme, Record<string, string>> = {
  light: { working: "#d4693f", unread: "#0a84ff", attn: "#c47f00", "attn-text": "#8a5d00", add: "#1a7f37", del: "#cf222e", warn: "#9a6700", "sev-blocker": "#d9661f", "sev-should": "#a88400", "sev-should-text": "#7a5f00" },
  dark: { working: "#ef8a5c", unread: "#0a84ff", attn: "#f0b44c", "attn-text": "#f0b44c", add: "#6bd488", del: "#ff8a93", warn: "#e3b341", "sev-blocker": "#f0914a", "sev-should": "#e3b341", "sev-should-text": "#e3b341" },
};
// Text-sized ones need 4.5:1, the rest (rings, dots, bars) 3:1.
const AS_TEXT = new Set(["add", "del", "warn", "attn-text", "sev-should-text"]);

/**
 * Every colour token for a custom theme, from its six colours. The rest are mixes of them: the greys between text and
 * background, washes of the text colour for hovers, and the status colours nudged until they read.
 */
export function deriveTokens(c: CustomTheme): Record<string, string> {
  const scheme: Scheme = isDark(c.bg) ? "dark" : "light";
  const dark = scheme === "dark";
  // Readable on both surfaces text sits on: moved toward the text colour, which reads on both, so one fix doesn't undo the other.
  const reads = (colour: string, min: number) => ensureContrast(ensureContrast(colour, c.panel, min, c.text), c.bg, min, c.text);
  const muted = mix(c.text2, c.bg, 0.4);
  // Bold and headings read brighter than the text; the accent (links, code, quotes) is moved until it reads on every surface it sits on.
  const strong = ensureContrast(mix(c.text, dark ? "#ffffff" : "#000000", 0.45), c.panel, 4.5, c.text);
  const chip = dark ? mix(c.panel, "#000000", 0.28) : mix(c.panel, c.text, 0.1);
  const accentText = ensureContrast(reads(c.accent, 4.5), chip, 4.5, c.text);
  const t: Record<string, string> = {
    bg: c.bg,
    pane: c.bg,
    sidebar: c.panel,
    field: c.bg,
    glass: alpha(c.text, dark ? 0.05 : 0.04),
    "glass-line": alpha(c.text, 0.07),
    "seg-track": alpha(c.text, 0.06),
    "seg-thumb": dark ? alpha(c.text, 0.17) : c.bg,
    "bg-subtle": mix(c.panel, c.text, 0.04),
    "bg-hover": alpha(c.text, 0.06),
    "bg-active": alpha(c.text, 0.09),
    "bg-user": mix(c.panel, c.text, 0.07),
    line: c.line,
    "line-strong": mix(c.line, c.text, 0.15),
    text: c.text,
    "text-2": c.text2,
    muted,
    faint: mix(c.text2, c.bg, 0.65),
    "muted-text": reads(muted, 4.5),
    accent: c.accent,
    "accent-soft": mix(c.bg, c.accent, 0.12),
    "accent-text": readableOn(c.accent),
    "info-bg": mix(c.bg, c.text, 0.04),
    "code-bg": dark ? mix(c.bg, "#000000", 0.35) : mix(c.bg, c.text, 0.07),
    "md-strong": strong,
    "md-strong-weight": "700",
    "md-heading": strong,
    "md-link": reads(c.accent, 4.5),
    "md-link-line": reads(c.accent, 4.5),
    "md-code-bg": chip,
    "md-code-text": accentText,
    "md-quote-bar": mix(c.line, c.accent, 0.7),
    "md-marker": reads(c.accent, 3),
    "pc-tint": dark ? "24%" : "13%",
    "pc-ink": dark ? "45%" : "78%",
    shadow: dark ? "0 12px 32px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.35)" : "0 10px 30px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06)",
    "card-shadow": dark ? "0 0 0 0.5px rgba(0, 0, 0, 0.6), 0 4px 16px rgba(0, 0, 0, 0.3)" : "0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 2px 10px rgba(0, 0, 0, 0.06)",
  };
  for (const [name, colour] of Object.entries(STATUS[scheme])) t[name] = reads(colour, AS_TEXT.has(name) ? 4.5 : 3);
  t["error-bg"] = mix(c.bg, t.del, dark ? 0.18 : 0.1);
  t["auth-bg"] = mix(c.bg, t.warn, dark ? 0.18 : 0.12);

  const out: Record<string, string> = { "color-scheme": scheme };
  for (const [name, value] of Object.entries(t)) out[`--${name}`] = value;
  if (c.mono) out["--ui"] = "var(--mono)";
  if (c.square) Object.assign(out, SQUARE);
  return out;
}

/** How well the picked text reads on the picked background and panel, and whether that is enough for body text (4.5:1). */
export function textContrast(c: Pick<Picks, "bg" | "panel" | "text">): { ratio: number; ok: boolean } {
  const ratio = Math.min(contrast(c.text, c.bg), contrast(c.text, c.panel));
  return { ratio, ok: ratio >= 4.5 };
}
