import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { applySaved, applyTheme, cssToHex, onThemeChange, readCustomTheme, readTheme, usePrefersDark, useThemeVersion } from "./theme";
import { CUSTOM_DEFAULT, deriveTokens } from "./themes";

const root = document.documentElement;
const reset = () => {
  applyTheme("system", "default");
  localStorage.clear();
};

describe("applyTheme", () => {
  afterEach(reset);

  it("puts the theme on <html> and the text size's scale in --font-scale", () => {
    applyTheme("dark", "large");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--font-scale")).toBe("1.15");
    applyTheme("light", "small");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--font-scale")).toBe("0.9");
  });

  it("puts a preset's id on <html> and no colours of its own: they're in styles.css", () => {
    applyTheme("terminal", "default");
    expect(root.dataset.theme).toBe("terminal");
    expect(root.style.getPropertyValue("--bg")).toBe("");
  });

  it("sets every derived token of a custom theme on <html>, and takes them off for the next theme", () => {
    const custom = { ...CUSTOM_DEFAULT, bg: "#fafafa", panel: "#eeeeee", text: "#111111", text2: "#444444", mono: true };
    applyTheme("custom", "default", custom);
    const tokens = deriveTokens(custom);
    expect(root.dataset.theme).toBe("custom");
    expect(root.dataset.scheme).toBe("light");
    expect(root.style.getPropertyValue("--bg")).toBe("#fafafa");
    expect(root.style.getPropertyValue("--sidebar")).toBe("#eeeeee");
    expect(root.style.getPropertyValue("--ui")).toBe("var(--mono)");
    expect(root.style.getPropertyValue("--code-bg")).toBe(tokens["--code-bg"]);
    applyTheme("dark", "default");
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(root.style.getPropertyValue("--ui")).toBe("");
    expect(root.dataset.scheme).toBeUndefined();
    expect(root.style.getPropertyValue("--font-scale")).toBe("1");
  });
});

describe("the saved theme", () => {
  afterEach(reset);

  it("is system until one is chosen", () => {
    expect(readTheme()).toBe("system");
  });

  it("reads settings.theme, and the older settings.appearance when there's no settings.theme", () => {
    localStorage.setItem("settings.appearance", JSON.stringify("dark"));
    expect(readTheme()).toBe("dark");
    localStorage.setItem("settings.theme", JSON.stringify("nord"));
    expect(readTheme()).toBe("nord");
  });

  it("ignores a theme that isn't one", () => {
    localStorage.setItem("settings.theme", JSON.stringify("neon"));
    expect(readTheme()).toBe("system");
  });

  it("reads the custom theme, with anything that isn't a colour replaced by the default's", () => {
    localStorage.setItem("settings.customTheme", JSON.stringify({ ...CUSTOM_DEFAULT, bg: "#123456", text: "red; background: url(x)", mono: true }));
    expect(readCustomTheme()).toEqual({ ...CUSTOM_DEFAULT, bg: "#123456", mono: true });
  });

  it("applySaved puts the saved custom theme on the page, as main.tsx does before the first paint", () => {
    localStorage.setItem("settings.theme", JSON.stringify("custom"));
    localStorage.setItem("settings.customTheme", JSON.stringify({ ...CUSTOM_DEFAULT, bg: "#ffffff", panel: "#f0f0f0", text: "#000000", text2: "#333333", square: true }));
    localStorage.setItem("settings.textSize", JSON.stringify("large"));
    applySaved();
    expect(root.dataset.theme).toBe("custom");
    expect(root.style.getPropertyValue("--bg")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--radius")).toBe("0");
    expect(root.style.getPropertyValue("--font-scale")).toBe("1.15");
  });
});

describe("usePrefersDark", () => {
  afterEach(reset);

  it("follows a forced theme, whatever macOS says", () => {
    applyTheme("dark", "default");
    expect(renderHook(() => usePrefersDark()).result.current).toBe(true);
    applyTheme("light", "default");
    expect(renderHook(() => usePrefersDark()).result.current).toBe(false);
  });

  it("knows which of the other themes are dark and which are light", () => {
    for (const [theme, dark] of [["terminal", true], ["fallout", true], ["solarized", true], ["nord", true], ["paper", false], ["posthog", false]] as const) {
      applyTheme(theme, "default");
      expect(renderHook(() => usePrefersDark()).result.current, theme).toBe(dark);
    }
  });

  it("takes a custom theme's from its background", () => {
    applyTheme("custom", "default", { ...CUSTOM_DEFAULT, bg: "#101010" });
    expect(renderHook(() => usePrefersDark()).result.current).toBe(true);
    applyTheme("custom", "default", { ...CUSTOM_DEFAULT, bg: "#f4f4f4", panel: "#e8e8e8", text: "#111111", text2: "#444444" });
    expect(renderHook(() => usePrefersDark()).result.current).toBe(false);
  });

  it("updates when Settings changes the theme while it's shown", async () => {
    applyTheme("light", "default");
    const { result } = renderHook(() => usePrefersDark());
    expect(result.current).toBe(false);
    act(() => applyTheme("dark", "default"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is light under \"system\" where the page can't ask macOS (tests)", () => {
    applyTheme("system", "default");
    expect(renderHook(() => usePrefersDark()).result.current).toBe(false);
  });
});

describe("telling the editor and diagrams that the colours changed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  it("calls a listener once the theme settles, however many steps a colour picker took", () => {
    const listener = vi.fn();
    const stop = onThemeChange(listener);
    applyTheme("custom", "default", { ...CUSTOM_DEFAULT, accent: "#111111" });
    applyTheme("custom", "default", { ...CUSTOM_DEFAULT, accent: "#222222" });
    applyTheme("custom", "default", { ...CUSTOM_DEFAULT, accent: "#333333" });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    applyTheme("dark", "default");
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("gives effects a number that goes up with each change", () => {
    const { result } = renderHook(() => useThemeVersion());
    const before = result.current;
    act(() => {
      applyTheme("nord", "default");
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(before + 1);
  });
});

describe("cssToHex", () => {
  it("reads the colours a browser computes", () => {
    expect(cssToHex("rgb(31, 31, 36)")).toBe("#1f1f24");
    expect(cssToHex("rgba(255, 255, 255, 0.05)")).toBe("#ffffff0d");
    expect(cssToHex("color(srgb 0.5 0 1 / 0.5)")).toBe("#8000ff80");
    expect(cssToHex("color(srgb 1 1 1)")).toBe("#ffffff");
  });

  it("returns null for what isn't a colour", () => {
    expect(cssToHex("")).toBeNull();
    expect(cssToHex("var(--x)")).toBeNull();
  });
});

describe("a corrupt or hostile saved theme", () => {
  afterEach(reset);

  it("can't break startup: unreadable JSON falls back to the defaults", () => {
    localStorage.setItem("settings.theme", "{not json");
    localStorage.setItem("settings.customTheme", "}}}");
    expect(() => applySaved()).not.toThrow();
    expect(readTheme()).toBe("system");
    expect(readCustomTheme()).toEqual(CUSTOM_DEFAULT);
    expect(root.dataset.theme).toBe("system");
  });

  it("falls back to the default for values of the wrong type or shape", () => {
    for (const bad of [null, 5, [], {}, "<script>", { x: 1 }]) {
      localStorage.setItem("settings.theme", JSON.stringify(bad));
      expect(readTheme(), JSON.stringify(bad)).toBe("system");
    }
    for (const bad of [null, 5, "red", [], [1, 2, 3]]) {
      localStorage.setItem("settings.customTheme", JSON.stringify(bad));
      expect(readCustomTheme(), JSON.stringify(bad)).toEqual(CUSTOM_DEFAULT);
    }
  });

  it("never writes anything but validated colours to <html>, even when handed an unchecked custom theme", () => {
    const evil = { bg: "red; background: url(https://evil.test)", panel: "url(x)", text: "#fff;}", text2: "</style>", accent: "var(--x)", line: "#12", mono: "yes", square: 1 } as never;
    applyTheme("custom", "default", evil);
    const written = [...Array(root.style.length).keys()].map((i) => root.style[i as never] as string).map((n) => [n, root.style.getPropertyValue(n)]);
    expect(written.length).toBeGreaterThan(30);
    for (const [name, value] of written) {
      expect(value, name).not.toMatch(/url|evil|<|>|[;{}]|var\(--x\)/);
    }
    // The default custom theme is what shows: its colours, not the hostile ones.
    expect(root.style.getPropertyValue("--bg")).toBe(CUSTOM_DEFAULT.bg);
    expect(root.style.getPropertyValue("--ui")).toBe("");
    expect(root.style.getPropertyValue("--radius")).toBe("");
  });

  it("does not take a theme id that isn't one", () => {
    localStorage.setItem("settings.theme", JSON.stringify("custom\" onload=\"x"));
    expect(readTheme()).toBe("system");
  });
});
