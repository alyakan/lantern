import { useEffect, useState, useSyncExternalStore } from "react";
import { toHex } from "./color";
import { CUSTOM_DEFAULT, THEMES, deriveTokens, isThemeId, readCustom, type CustomTheme, type ThemeId } from "./themes";
import { readStored } from "./layout";

export type TextSize = "small" | "default" | "large";
/** What every font size is multiplied by: the text sizes Settings offers. */
export const TEXT_SCALE: Record<TextSize, number> = { small: 0.9, default: 1, large: 1.15 };

const QUERY = "(prefers-color-scheme: dark)";
// Light where the page can't be asked (tests' jsdom has no matchMedia).
const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

/** Whether the page is dark: Settings' theme (data-theme on <html>), or macOS's own when it's "system". */
export const pageIsDark = () => {
  const root = document.documentElement;
  const theme = root.dataset.theme;
  // A custom theme says so itself: its background decides.
  if (theme === "custom") return root.dataset.scheme === "dark";
  const scheme = THEMES.find((t) => t.id === theme)?.scheme;
  return scheme ? scheme === "dark" : (query()?.matches ?? false);
};

/** Whether the page is dark, following Settings' theme and macOS's appearance when it's "system". */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(pageIsDark);
  useEffect(() => {
    const update = () => setDark(pageIsDark());
    const mq = query();
    mq?.addEventListener("change", update);
    // The theme lives in data-theme (and data-scheme, for a custom one), so a change reaches every component that asks.
    const watch = new MutationObserver(update);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-scheme"] });
    return () => {
      mq?.removeEventListener("change", update);
      watch.disconnect();
    };
  }, []);
  return dark;
}

// Whoever draws with the theme's colours (Monaco, mermaid) is told when they change. A custom theme changes with every
// step of a colour picker, so the tellings wait for it to settle.
const listeners = new Set<() => void>();
let version = 0;
let settle: ReturnType<typeof setTimeout> | undefined;
let watchingMac = false;

const changed = () => {
  clearTimeout(settle);
  settle = setTimeout(() => {
    // A test's page can be gone by now.
    if (typeof window === "undefined") return;
    version++;
    listeners.forEach((l) => l());
  }, 60);
};

/** Calls `listener` after the colours change: another theme, an edit to the custom one, or macOS switching under "system". Returns what stops it. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  if (!watchingMac) {
    watchingMac = true;
    query()?.addEventListener("change", changed);
  }
  return () => void listeners.delete(listener);
}

/** A number that goes up each time the theme's colours change, for effects that draw with them (code blocks, diagrams). */
export function useThemeVersion(): number {
  return useSyncExternalStore(onThemeChange, () => version);
}

/** The custom properties a custom theme has put on <html>, so the next theme can take them off. */
let custom: string[] = [];

/**
 * Puts the theme and text size on the page: data-theme for the colours (styles.css), --font-scale for the text. A custom
 * theme's colours have no block in styles.css: they are derived (themes.ts) and set on <html> here.
 */
export function applyTheme(theme: ThemeId, size: TextSize, customTheme: CustomTheme = CUSTOM_DEFAULT): void {
  const root = document.documentElement;
  for (const name of custom) root.style.removeProperty(name);
  custom = [];
  root.dataset.theme = theme;
  delete root.dataset.scheme;
  if (theme === "custom") {
    const tokens = deriveTokens(customTheme);
    for (const [name, value] of Object.entries(tokens)) {
      root.style.setProperty(name, value);
      custom.push(name);
    }
    root.dataset.scheme = tokens["color-scheme"];
  }
  root.style.setProperty("--font-scale", String(TEXT_SCALE[size]));
  changed();
}

/** The saved theme (settings.theme; an older install has its choice in settings.appearance, which was only system, light or dark). */
export function readTheme(): ThemeId {
  const saved = readStored<unknown>("settings.theme", null) ?? readStored<unknown>("settings.appearance", "system");
  return isThemeId(saved) ? saved : "system";
}

/** The saved custom theme. */
export const readCustomTheme = (): CustomTheme => readCustom(readStored<unknown>("settings.customTheme", null));

/** Applies what's saved; main.tsx calls it before the first paint, so a chosen theme doesn't flash the default. */
export function applySaved(): void {
  applyTheme(readTheme(), readStored<TextSize>("settings.textSize", "default"), readCustomTheme());
}

let probe: HTMLElement | null = null;

/** A colour the browser computed ("rgb(1, 2, 3)", "rgba(…)", or "color(srgb 0.1 0.2 0.3 / 0.5)") as "#rrggbb", with "aa" if see-through. */
export function cssToHex(css: string): string | null {
  const nums = (s: string) => s.match(/-?\d*\.?\d+(?:e-?\d+)?%?/g)?.map((n) => (n.endsWith("%") ? parseFloat(n) / 100 : parseFloat(n))) ?? [];
  let rgb: number[];
  let a = 1;
  if (css.startsWith("color(")) {
    const [r, g, b, alpha] = nums(css.replace(/^color\(\s*\S+/, ""));
    rgb = [r * 255, g * 255, b * 255];
    a = alpha ?? 1;
  } else if (css.startsWith("rgb")) {
    const [r, g, b, alpha] = nums(css);
    rgb = [r, g, b];
    a = alpha ?? 1;
  } else return null;
  if (rgb.some((n) => !Number.isFinite(n))) return null;
  const hex = toHex(rgb as [number, number, number]);
  return a < 1 ? `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}` : hex;
}

/** The theme's colour tokens, as the page shows them now ("--bg" → "#1f1f24"). Tokens it can't read are left out (tests' jsdom has no style cascade). */
export function readColors(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof getComputedStyle !== "function") return out;
  probe ??= Object.assign(document.createElement("div"), { ariaHidden: "true" });
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  for (const name of names) {
    probe.style.color = "";
    probe.style.color = `var(--${name})`;
    const hex = cssToHex(getComputedStyle(probe).color);
    if (hex) out[name] = hex;
  }
  probe.remove();
  return out;
}
