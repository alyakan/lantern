import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import type { SavedChat } from "./lib/restore";

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({}));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

const FOLDER = "/Users/you/projects/acme-api";
const OTHER = "/Users/you/projects/web-dashboard";
const lastTime: SavedChat[] = [
  { sessionId: "9b7e01", folder: FOLDER, title: "Retry transient fetch errors", draft: "", active: false },
  { sessionId: "3f1c2a", folder: OTHER, title: "Fix the login redirect", draft: "and log the state param", active: true },
];

async function launch() {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByText("2 chats were open when Lantern closed");
}

describe("restoring chats at launch", () => {
  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    localStorage.clear();
    localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
    localStorage.setItem("session.openChats", JSON.stringify(lastTime));
  });

  it("brings every chat back, the one that was on screen on screen with its unsent text", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
    expect(screen.getByRole("textbox")).toHaveValue("and log the state param");
    expect(screen.queryByText(/were open when Lantern closed/)).toBeNull();
    // Both are saved as open now, the one on screen marked so.
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.map((c) => [c.sessionId, c.active])).toEqual([["3f1c2a", true], ["9b7e01", false]]);
    });
  });

  it("brings one back on its own, and keeps offering the rest", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /Retry transient fetch errors/ }));
    await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.map((c) => c.sessionId)).toEqual(["9b7e01", "3f1c2a"]);
    });
  });

  it("stops offering them once dismissed", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/were open when Lantern closed/)).toBeNull();
    await waitFor(() => expect(localStorage.getItem("session.openChats")).toBe("[]"));
  });
});
