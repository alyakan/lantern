import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, act, within } from "@testing-library/react";
import { NOTIFY_DEFAULTS, type NotifyPrefs } from "../lib/notifyPrefs";
import { chimeOn, setChime, useChimeOn } from "../lib/chime";

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
      notify,
      onNotify: vi.fn(),
      appearance: "system",
      onAppearance: vi.fn(),
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
    expect(general.onAppearance).toHaveBeenCalledWith("dark");
    fireEvent.click(screen.getByLabelText("Large"));
    expect(general.onTextSize).toHaveBeenCalledWith("large");
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
