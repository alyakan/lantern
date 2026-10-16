import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, act, within } from "@testing-library/react";
import { NOTIFY_DEFAULTS, type NotifyPrefs } from "../lib/notifyPrefs";
import { chimeOn, setChime, useChimeOn } from "../lib/chime";
import { CUSTOM_DEFAULT, THEMES } from "../lib/themes";

vi.mock("../api", () => ({ api: {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));

import { SettingsView, type GeneralSettingsProps } from "./SettingsView";

describe("Settings' General page", () => {
  let general: GeneralSettingsProps;
  let notify: NotifyPrefs;
  beforeEach(() => {
    localStorage.clear();
    notify = { ...NOTIFY_DEFAULTS };
    general = {
      keepAwake: true,
      onKeepAwake: vi.fn(),
      notify,
      onNotify: vi.fn(),
      theme: "system",
      customTheme: CUSTOM_DEFAULT,
      onTheme: vi.fn(),
      onCustomTheme: vi.fn(),
      textSize: "default",
      onTextSize: vi.fn(),
    };
  });
  const view = () => render(<SettingsView open="general" onClose={() => {}} slot={null} live={false} mcpTools={[]} commands={[]} general={general} />);

  it("is the first tab, and opens on it", () => {
    view();
    const tabs = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("button");
    expect(tabs[0]).toHaveTextContent("General");
    expect(tabs[0]).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("offers keeping the Mac awake, on by default, and says when it is turned off", () => {
    view();
    const box = screen.getByRole("checkbox", { name: "Keep my Mac awake while Claude works" });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(general.onKeepAwake).toHaveBeenCalledWith(false);
  });

  it("turns notifications off as a whole", () => {
    view();
    fireEvent.click(screen.getByLabelText("Tell me in macOS notifications and in the window"));
    expect(general.onNotify).toHaveBeenCalledWith({ ...notify, on: false });
  });

  it("greys out the per-event switches while notifications are off", () => {
    general.notify = { ...notify, on: false };
    view();
    expect(screen.getByLabelText("A turn fails")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause for 1 hour" })).toBeDisabled();
  });

  it("turns one kind of event off, leaving the others", () => {
    general.notify = { ...notify, on: true };
    view();
    fireEvent.click(screen.getByLabelText("A turn fails"));
    expect(general.onNotify).toHaveBeenCalledWith({ ...notify, failed: false });
  });

  it("pauses for an hour and resumes", () => {
    const before = Date.now();
    view();
    fireEvent.click(screen.getByRole("button", { name: "Pause for 1 hour" }));
    const [next] = (general.onNotify as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(next.pausedUntil).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(next.pausedUntil).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("says until when notifications are paused, and resumes them", () => {
    general.notify = { ...notify, pausedUntil: Date.now() + 60 * 60 * 1000 };
    view();
    expect(screen.getByText(/Paused until/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(general.onNotify).toHaveBeenCalledWith({ ...general.notify, pausedUntil: 0 });
  });

  it("turns the toast sound on and off, where the toast's speaker sees it too", () => {
    view();
    expect(chimeOn()).toBe(false);
    fireEvent.click(screen.getByLabelText(/Play a sound with the toasts/));
    expect(localStorage.getItem("toast.sound")).toBe("on");
  });

  it("chooses the theme and the text size", () => {
    view();
    fireEvent.click(screen.getByLabelText("Dark"));
    expect(general.onTheme).toHaveBeenCalledWith("dark");
    fireEvent.click(screen.getByLabelText("Large"));
    expect(general.onTextSize).toHaveBeenCalledWith("large");
  });

  it("offers every preset theme, Follow macOS and Custom", () => {
    view();
    const names = within(screen.getByRole("group", { name: "Theme" })).getAllByRole("radio").map((r) => r.closest("label")?.textContent);
    expect(names).toEqual(["Follow macOS", "Light", "Dark", "Terminal", "Fallout", "Solarized Dark", "Nord", "Paper", "Custom"]);
    fireEvent.click(screen.getByLabelText("Terminal"));
    expect(general.onTheme).toHaveBeenCalledWith("terminal");
    fireEvent.click(screen.getByLabelText("Fallout"));
    expect(general.onTheme).toHaveBeenCalledWith("fallout");
  });

  describe("Customize…", () => {
    it("starts from the theme that's on, switching to Custom so the app shows the colours as they're picked", () => {
      general.theme = "paper";
      view();
      fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
      expect(general.onCustomTheme).toHaveBeenCalledWith({ ...THEMES.find((t) => t.id === "paper")!.picks, mono: false, square: false });
      expect(general.onTheme).toHaveBeenCalledWith("custom");
      expect(screen.getByRole("group", { name: "Custom theme" })).toBeInTheDocument();
    });

    it("starts from Terminal's monospace, square look when that's the theme", () => {
      general.theme = "terminal";
      view();
      fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
      expect(general.onCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ mono: true, square: true }));
    });

    it("saves each colour, the monospace switch and the corners as they're changed", () => {
      general.theme = "custom";
      general.customTheme = { ...CUSTOM_DEFAULT, bg: "#101010" };
      view();
      fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
      const onCustom = general.onCustomTheme as ReturnType<typeof vi.fn>;
      onCustom.mockClear();
      fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#ff0000" } });
      expect(onCustom).toHaveBeenLastCalledWith({ ...general.customTheme, accent: "#ff0000" });
      fireEvent.click(screen.getByLabelText("Monospace everywhere"));
      expect(onCustom).toHaveBeenLastCalledWith({ ...general.customTheme, mono: true });
      fireEvent.click(screen.getByLabelText("Square"));
      expect(onCustom).toHaveBeenLastCalledWith({ ...general.customTheme, square: true });
    });

    it("warns when the text doesn't read on the background, and not when it does", () => {
      general.theme = "custom";
      general.customTheme = { ...CUSTOM_DEFAULT, bg: "#808080", panel: "#808080", text: "#8a8a8a" };
      const { unmount } = view();
      fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
      expect(screen.getByRole("status")).toHaveTextContent(/below|4\.5:1/);
      unmount();
      general.customTheme = CUSTOM_DEFAULT;
      view();
      fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("goes back to the earlier theme when cancelled", () => {
      general.theme = "nord";
      view();
      fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(general.onTheme).toHaveBeenLastCalledWith("nord");
      expect(screen.queryByRole("group", { name: "Custom theme" })).toBeNull();
    });
  });
});

describe("Settings' Teams section: quiet agents and the plan's limit", () => {
  const props = (): GeneralSettingsProps => ({ keepAwake: true, onKeepAwake: vi.fn(), notify: { ...NOTIFY_DEFAULTS }, onNotify: vi.fn(), theme: "system", customTheme: CUSTOM_DEFAULT, onTheme: vi.fn(), onCustomTheme: vi.fn(), textSize: "default", onTextSize: vi.fn() });
  const view = () => render(<SettingsView open="general" onClose={() => {}} slot={null} live={false} mcpTools={[]} commands={[]} general={props()} />);
  beforeEach(() => localStorage.clear());

  it("sets how long an agent may be quiet, 3 minutes until chosen", () => {
    view();
    const select = screen.getByRole("combobox", { name: "Say an agent is quiet after" });
    expect(select).toHaveValue("3");
    fireEvent.change(select, { target: { value: "10" } });
    expect(localStorage.getItem("lantern.quietMinutes")).toBe("10");
    expect(select).toHaveValue("10");
  });

  it("sets when a team's work is paused, Off until chosen", () => {
    view();
    const select = screen.getByRole("combobox", { name: "Pause a team's work when my plan reaches" });
    expect(select).toHaveValue("0");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Off", "90%", "95%"]);
    fireEvent.change(select, { target: { value: "95" } });
    expect(localStorage.getItem("lantern.pauseAtPercent")).toBe("95");
    expect(select).toHaveValue("95");
  });
});

describe("useChimeOn", () => {
  beforeEach(() => {
    localStorage.clear();
    setChime(false);
  });

  it("follows every change to the toast sound, wherever it's made", () => {
    const { result } = renderHook(() => useChimeOn());
    expect(result.current).toBe(false);
    act(() => setChime(true));
    expect(result.current).toBe(true);
    act(() => setChime(false));
    expect(result.current).toBe(false);
  });
});
