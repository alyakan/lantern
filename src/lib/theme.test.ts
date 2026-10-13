import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { applyAppearance, usePrefersDark } from "./theme";

describe("applyAppearance", () => {
  afterEach(() => applyAppearance("system", "default"));

  it("puts the theme on <html> and the text size's scale in --font-scale", () => {
    applyAppearance("dark", "large");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.15");
    applyAppearance("light", "small");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("0.9");
  });
});

describe("usePrefersDark", () => {
  afterEach(() => applyAppearance("system", "default"));

  it("follows a forced theme, whatever macOS says", () => {
    applyAppearance("dark", "default");
    expect(renderHook(() => usePrefersDark()).result.current).toBe(true);
    applyAppearance("light", "default");
    expect(renderHook(() => usePrefersDark()).result.current).toBe(false);
  });

  it("updates when Settings changes the theme while it's shown", async () => {
    applyAppearance("light", "default");
    const { result } = renderHook(() => usePrefersDark());
    expect(result.current).toBe(false);
    act(() => applyAppearance("dark", "default"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is light under \"system\" where the page can't ask macOS (tests)", () => {
    applyAppearance("system", "default");
    expect(renderHook(() => usePrefersDark()).result.current).toBe(false);
  });
});
