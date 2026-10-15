import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import type { SavedChat } from "./lib/restore";

// The editor isn't needed here, and doesn't load in jsdom.
// The diff and file viewers load lazily and may still ask for its theme names before a test ends.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
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

describe("restoring a team at launch", () => {
  const WORKTREE = "/Users/you/Library/Application Support/lantern/worktrees/acme-api/login-form-w1";
  // The worker is listed before its main agent, so putting the team back has to open the main agent first.
  const team: SavedChat[] = [
    { sessionId: "aaaa11", folder: WORKTREE, title: "Login form", draft: "", active: false, orchestra: { role: "worker", name: "Login form", parentSession: "bbbb22", branch: "lantern/login-form", base: "main", isolation: "worktree" } },
    { sessionId: "bbbb22", folder: FOLDER, title: "Build the login flow", draft: "", active: true, orchestra: { role: "main" } },
  ];

  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    localStorage.clear();
    localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
    localStorage.setItem("session.openChats", JSON.stringify(team));
  });

  it("puts the main agent and its worker back together, and offers the canvas", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    // The chats are an orchestra again: the canvas can be shown.
    await screen.findByRole("button", { name: "Canvas" });
    // Saved as they are now, with the worker still naming its main agent by session.
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      const bySession = Object.fromEntries(saved.map((c) => [c.sessionId, c]));
      expect(bySession.bbbb22.orchestra).toEqual({ role: "main" });
      expect(bySession.aaaa11.orchestra).toEqual({ role: "worker", name: "Login form", parentSession: "bbbb22", branch: "lantern/login-form", base: "main", isolation: "worktree" });
      expect(bySession.bbbb22.active).toBe(true);
    });
  });

  it("brings the workers back on the mode they had, not just the ones the user had looked at", async () => {
    localStorage.setItem("settings.modeBySession", JSON.stringify({ bbbb22: "auto", aaaa11: "auto" }));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    // Each window's title bar says its Permissions: the Lead's and the agent's.
    expect(await within(await screen.findByLabelText(/^Main agent /)).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    expect(await within(await screen.findByLabelText(/Worker Login form/)).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    // Still saved under both sessions for the next restart.
    expect(JSON.parse(localStorage.getItem("settings.modeBySession") ?? "{}")).toMatchObject({ bbbb22: "auto", aaaa11: "auto" });
  });

  it("brings a worker with no saved mode back on Ask, as before modes were kept for it", async () => {
    localStorage.setItem("settings.modeBySession", JSON.stringify({ bbbb22: "auto" }));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    expect(await within(await screen.findByLabelText(/^Main agent /)).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    expect(await within(await screen.findByLabelText(/Worker Login form/)).findByRole("button", { name: "Permissions: Ask" })).toBeInTheDocument();
  });

  it("keeps the side panel beside the canvas, shut until the user opens it, and remembers that", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    expect(await screen.findByLabelText(/Worker Login form/)).toBeInTheDocument();
    // The panel is there beside the canvas (its Changes tab is in the page), shut.
    expect(screen.getByRole("tab", { name: /^Changes/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(await screen.findByRole("button", { name: "Hide changes" })).toBeInTheDocument();
    // Still the canvas, now with the panel open beside it; and the choice is kept for the next time.
    expect(screen.getByLabelText(/Worker Login form/)).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("review.canvasPanel") ?? "false")).toBe(true));
  });

  it("keeps a worker the user hid hidden across a restart", async () => {
    const hiddenWorker: SavedChat = { ...team[0], orchestra: { ...(team[0].orchestra as Extract<NonNullable<SavedChat["orchestra"]>, { role: "worker" }>), hidden: true } };
    localStorage.setItem("session.openChats", JSON.stringify([hiddenWorker, team[1]]));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    await screen.findByRole("button", { name: "Canvas" });
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.find((c) => c.sessionId === "aaaa11")?.orchestra).toMatchObject({ role: "worker", hidden: true });
    });
  });

  it("restores what an older version saved, which has no such field, with the worker shown", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    await screen.findByRole("button", { name: "Canvas" });
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.find((c) => c.sessionId === "aaaa11")?.orchestra).toMatchObject({ role: "worker", name: "Login form" });
      expect(saved.find((c) => c.sessionId === "aaaa11")?.orchestra).not.toHaveProperty("hidden");
    });
  });

  it("brings a worker back as an ordinary chat when its main agent is not restored with it", async () => {
    localStorage.setItem("session.openChats", JSON.stringify([team[0], { ...team[1], sessionId: "cccc33", orchestra: undefined }]));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved).toHaveLength(2);
      expect(saved.every((c) => !c.orchestra)).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "Canvas" })).toBeNull();
  });
});
