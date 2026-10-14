import { useEffect, useState } from "react";

export type Appearance = "system" | "light" | "dark";
export type TextSize = "small" | "default" | "large";
/** What every font size is multiplied by: the text sizes Settings offers. */
export const TEXT_SCALE: Record<TextSize, number> = { small: 0.9, default: 1, large: 1.15 };

const QUERY = "(prefers-color-scheme: dark)";
// Light where the page can't be asked (tests' jsdom has no matchMedia).
const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

/** Whether the page is dark: Settings' choice (data-theme on <html>), or macOS's own when the choice is "system". */
const isDark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme !== "light" && (query()?.matches ?? false));
};

/** Whether the page is dark, following Settings' choice and macOS's appearance when it's "system". */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const update = () => setDark(isDark());
    const mq = query();
    mq?.addEventListener("change", update);
    // The choice lives in data-theme, so a change to it reaches every component that asks.
    const watch = new MutationObserver(update);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener("change", update);
      watch.disconnect();
    };
  }, []);
  return dark;
}

/** Puts the theme and text size on the page: data-theme for the colours (styles.css), --font-scale for the text. */
export function applyAppearance(theme: Appearance, size: TextSize): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty("--font-scale", String(TEXT_SCALE[size]));
}
