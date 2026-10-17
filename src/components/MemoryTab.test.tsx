import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryTab, POLL_MS } from "./MemoryTab";
import { api } from "../api";
import type { MemoryApp, MemorySnapshot } from "../types";

vi.mock("../api", () => ({ api: { memorySnapshot: vi.fn() } }));

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TOTAL = 16 * GB;
const app = (name: string, mb: number, processes = 1, kind: MemoryApp["kind"] = "app"): MemoryApp => ({ name, bytes: mb * MB, processes, share: (mb * MB) / TOTAL, kind });
const snapshot = (over: Partial<MemorySnapshot> = {}): MemorySnapshot => {
  const apps = [app("Google Chrome", 2100, 11), app("Lantern and its agents", 1900, 9, "lantern"), app("Xcode", 1600, 14), app("macOS", 1500, 380, "macos"), app("Slack", 780, 6), app("Other apps", 400, 30, "other")];
  const used = apps.reduce((n, a) => n + a.bytes, 0);
  return { total_bytes: TOTAL, used_bytes: used, cached_bytes: 3 * GB, free_bytes: TOTAL - used - 3 * GB, compressed_bytes: 2 * GB, swap_used_bytes: 2.5 * GB, pressure: "normal", pressure_source: "kernel", scaled: false, apps, ...over };
};

let visibility: "visible" | "hidden" = "visible";
const setVisibility = (v: "visible" | "hidden") =>
  act(() => {
    visibility = v;
    document.dispatchEvent(new Event("visibilitychange"));
  });
const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.mocked(api.memorySnapshot).mockReset();
  vi.mocked(api.memorySnapshot).mockResolvedValue(snapshot());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryTab", () => {
  it("says it is reading while the first snapshot is on its way", async () => {
    vi.mocked(api.memorySnapshot).mockReturnValue(new Promise(() => {}));
    render(<MemoryTab />);
    expect(screen.getByText("Reading memory…")).toBeInTheDocument();
  });

  it("shows the whole RAM as a bar with a text alternative, and the line on what is used, the pressure and the swap", async () => {
    render(<MemoryTab />);
    await settle();
    const bar = screen.getByRole("img", { name: /^Memory by app\./ });
    const label = bar.getAttribute("aria-label")!;
    expect(label).toContain("Google Chrome: 2.1 GB");
    expect(label).toContain("Lantern and its agents:");
    expect(label).toContain("macOS:");
    expect(label).toContain("Cached: 3.0 GB");
    expect(label).toContain("Free:");
    const used = snapshot().used_bytes / GB;
    expect(screen.getByText(/About/).textContent).toBe(`About ${used.toFixed(1)} GB used of 16.0 GB, pressure: normal, swap 2.5 GB`);
    expect(screen.getByText("normal")).toHaveClass("memory-pressure", "normal");
    expect(screen.getByText("normal")).toHaveAttribute("title", "macOS's own memory pressure level");
  });

  it("says where an estimated pressure came from, and colours a warning and a critical one apart", async () => {
    vi.mocked(api.memorySnapshot).mockResolvedValue(snapshot({ pressure: "critical", pressure_source: "estimated" }));
    render(<MemoryTab />);
    await settle();
    const chip = screen.getByText("critical");
    expect(chip).toHaveClass("critical");
    expect(chip.getAttribute("title")).toMatch(/Estimated/);
  });

  it("lists the apps by size with their process counts and shares, and Lantern and its agents stands out with what is in it", async () => {
    render(<MemoryTab />);
    await settle();
    const list = screen.getByRole("region", { name: "Memory by app" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByText(/^(Google Chrome|Lantern and its agents|Xcode|macOS|Slack|Other apps)$/).textContent)).toEqual(["Google Chrome", "Lantern and its agents", "Xcode", "macOS", "Slack", "Other apps"]);
    expect(within(rows[0]).getByText("11 processes")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2.1 GB")).toBeInTheDocument();
    expect(within(rows[0]).getByText("13%")).toBeInTheDocument();
    expect(rows[1]).toHaveClass("lantern");
    expect(within(rows[1]).getByText(/the agents it runs \(claude, node, vite/)).toBeInTheDocument();
    expect(within(rows[3]).getByText("380 processes")).toBeInTheDocument();
    // Their bars are against the biggest app, and are not the only way to read them.
    expect(rows[0].querySelector(".storage-rowbar span")).toHaveStyle({ width: "100%" });
    expect(rows[0].querySelector(".storage-rowbar")).toHaveAttribute("aria-hidden", "true");
  });

  it("says the sizes are resident memory and that shared pages are counted in each process", async () => {
    render(<MemoryTab />);
    await settle();
    expect(screen.getByText(/resident memory/)).toBeInTheDocument();
    expect(screen.getByText(/Shared pages count in every process/)).toBeInTheDocument();
    expect(screen.getByText("Resident memory by app, about")).toBeInTheDocument();
  });

  it("only shows: no button here quits, kills or stops anything", async () => {
    render(<MemoryTab />);
    await settle();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Refresh"]);
  });

  it("reads once at once, then every three seconds", async () => {
    render(<MemoryTab />);
    await settle();
    expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
    await settle(POLL_MS - 1);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
    await settle(1);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(2);
    await settle(POLL_MS * 2);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(4);
  });

  it("stops reading when the tab goes away", async () => {
    const { unmount } = render(<MemoryTab />);
    await settle();
    unmount();
    await settle(POLL_MS * 5);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
  });

  it("pauses while the window is hidden, and reads at once when it is visible again", async () => {
    render(<MemoryTab />);
    await settle();
    await setVisibility("hidden");
    await settle(POLL_MS * 5);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
    await setVisibility("visible");
    await settle();
    expect(api.memorySnapshot).toHaveBeenCalledTimes(2);
    await settle(POLL_MS);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(3);
  });

  it("reads nothing at all when it opens in a hidden window", async () => {
    await setVisibility("hidden");
    render(<MemoryTab />);
    await settle(POLL_MS * 3);
    expect(api.memorySnapshot).not.toHaveBeenCalled();
  });

  it("doesn't start a read while one is still running", async () => {
    vi.mocked(api.memorySnapshot).mockReturnValue(new Promise(() => {}));
    render(<MemoryTab />);
    await settle(POLL_MS * 3);
    expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
  });

  it("reads again at once on Refresh, and counts the time since the last reading", async () => {
    render(<MemoryTab />);
    await settle();
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
    await settle(2000);
    vi.mocked(api.memorySnapshot).mockResolvedValue(snapshot({ pressure: "warning" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(api.memorySnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByText("warning")).toBeInTheDocument();
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
  });

  it("shows the time since the last reading growing while the reads fail", async () => {
    render(<MemoryTab />);
    await settle();
    vi.mocked(api.memorySnapshot).mockRejectedValue("ps took longer than 5 seconds and was stopped");
    await settle(POLL_MS * 3);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read memory: ps took longer than 5 seconds and was stopped. Showing the last reading.");
    expect(screen.getByText(/^Updated (9|10)s ago$/)).toBeInTheDocument();
    // The last reading stays on screen.
    expect(screen.getByRole("img", { name: /^Memory by app\./ })).toBeInTheDocument();
    // And the error goes when a read works again.
    vi.mocked(api.memorySnapshot).mockResolvedValue(snapshot());
    await settle(POLL_MS);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says it couldn't read memory when the first read fails, and tries again on request", async () => {
    vi.mocked(api.memorySnapshot).mockRejectedValue(new Error("vm_stat failed"));
    render(<MemoryTab />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read memory: vm_stat failed");
    vi.mocked(api.memorySnapshot).mockResolvedValue(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getByRole("img", { name: /^Memory by app\./ })).toBeInTheDocument();
  });

  it("says so when no apps were found", async () => {
    vi.mocked(api.memorySnapshot).mockResolvedValue(snapshot({ apps: [] }));
    render(<MemoryTab />);
    await settle();
    expect(screen.getByText("No apps were found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("keeps the rows in their order when sizes only trade places by a row or two", async () => {
    render(<MemoryTab />);
    await settle();
    const first = snapshot();
    // Xcode passes Lantern, and Slack passes macOS: both within a row of where they were.
    const swapped = { ...first, apps: first.apps.map((a) => (a.name === "Xcode" ? { ...a, bytes: 2000 * MB } : a.name === "Slack" ? { ...a, bytes: 1600 * MB } : a)) };
    vi.mocked(api.memorySnapshot).mockResolvedValue(swapped);
    await settle(POLL_MS);
    const order = within(screen.getByRole("region", { name: "Memory by app" })).getAllByRole("listitem").map((r) => r.querySelector(".memory-name")!.textContent);
    expect(order).toEqual(["Google Chrome", "Lantern and its agents", "Xcode", "macOS", "Slack", "Other apps"]);
  });

  it("moves an app that has become much bigger to where it belongs", async () => {
    render(<MemoryTab />);
    await settle();
    const first = snapshot();
    const apps = [...first.apps.filter((a) => a.kind !== "other"), app("Docker", 90), app("Notes", 80), app("Mail", 70), app("Music", 60), first.apps.find((a) => a.kind === "other")!];
    vi.mocked(api.memorySnapshot).mockResolvedValue({ ...first, apps });
    await settle(POLL_MS);
    const grown = { ...first, apps: apps.map((a) => (a.name === "Music" ? { ...a, bytes: 5000 * MB } : a)) };
    vi.mocked(api.memorySnapshot).mockResolvedValue(grown);
    await settle(POLL_MS);
    const order = within(screen.getByRole("region", { name: "Memory by app" })).getAllByRole("listitem").map((r) => r.querySelector(".memory-name")!.textContent);
    expect(order[0]).toBe("Music");
    expect(order[order.length - 1]).toBe("Other apps");
  });

  it("is reachable from the keyboard: the Refresh button, then the list to scroll it", async () => {
    render(<MemoryTab />);
    await settle();
    expect(screen.getByRole("region", { name: "Memory by app" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Refresh" })).not.toHaveAttribute("tabindex", "-1");
  });
});
