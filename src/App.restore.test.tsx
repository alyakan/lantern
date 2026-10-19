import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import type { SavedChat } from "./lib/restore";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 60_000 });
// Their finds and waits take as long on such a runner: the default 1 s is for a component, not the whole app.
configure({ asyncUtilTimeout: 20_000 });

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

type Call = [string, Record<string, unknown> | undefined];

/** Opens the app with the chats from last time on offer, recording every command it sends to the backend. */
async function launch(): Promise<Call[]> {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const calls: Call[] = [];
  const answer = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args]);
    return answer(cmd, args, options);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByText(/(chats were|chat was) open when Lantern closed/);
  return calls;
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
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
    expect(screen.getByRole("textbox")).toHaveValue("and log the state param");
    expect(screen.queryByText(/were open when Lantern closed/)).toBeNull();
    // Both are saved as open now, the one on screen marked so.
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.map((c) => [c.sessionId, c.active])).toEqual([["3f1c2a", true], ["9b7e01", false]]);
    });
  });

  it("starts only the chat on screen and leaves the others asleep in the sidebar until they are opened", async () => {
    const calls = await launch();
    const opened = () => calls.filter(([c]) => c === "open_session").map(([, a]) => a?.sessionId);
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
    // The other chat is there to click, with its title, but has no claude and no history yet.
    const asleep = await screen.findByTitle("Retry transient fetch errors");
    expect(opened()).toEqual(["3f1c2a"]);
    fireEvent.click(asleep);
    await waitFor(() => expect(opened()).toEqual(["3f1c2a", "9b7e01"]));
    // Asleep or awake, both stay saved, so quitting in between loses nothing.
    const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
    expect(saved.map((c) => c.sessionId).sort()).toEqual(["3f1c2a", "9b7e01"]);
  });

  it("puts a chat that has sat idle off screen to sleep, and wakes it when it is opened again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    try {
      const calls = await launch();
      const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);
      fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
      await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
      // Opening the other chat leaves the first one off screen and idle: its clock starts.
      fireEvent.click(await screen.findByTitle("Retry transient fetch errors"));
      await waitFor(() => expect(sent("open_session")).toHaveLength(2));
      await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
      expect(sent("close_session")).toEqual([]);
      // Ten minutes later (the default) it is put to sleep: its process is closed, and the sidebar still has it.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(sent("close_session")).toHaveLength(1));
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      const slept = saved.find((c) => c.sessionId === "3f1c2a");
      expect(slept).toBeDefined();
      // The mock gives every chat the same first prompt, so two rows can share a title: the one that isn't the open chat is it.
      const row = screen.getAllByTitle(slept!.title).find((el) => el.getAttribute("aria-current") !== "true");
      expect(row).toBeDefined();
      // Opening it brings it back.
      fireEvent.click(row!);
      await waitFor(() => expect(sent("open_session")).toHaveLength(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes a chat on the mode it was saved in, not the mode of the chat that was open when it was put to sleep", async () => {
    localStorage.setItem("settings.modeBySession", JSON.stringify({ "9b7e01": "auto", "3f1c2a": "ask" }));
    const calls = await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByText("Should the backoff have jitter so clients don't retry in lockstep?");
    fireEvent.click(await screen.findByTitle("Retry transient fetch errors"));
    await waitFor(() => expect(calls.filter(([c]) => c === "open_session")).toHaveLength(2));
    const woken = calls.filter(([c]) => c === "open_session").map(([, a]) => a as { sessionId: string; settings: { mode: string } });
    expect(woken.map((a) => [a.sessionId, a.settings.mode])).toEqual([["3f1c2a", "ask"], ["9b7e01", "auto"]]);
    // Nor was its saved mode written over while it slept.
    expect(JSON.parse(localStorage.getItem("settings.modeBySession") ?? "{}")["9b7e01"]).toBe("auto");
  });

  it("opens a long session at its last turns and shows the earlier ones when asked", async () => {
    window.history.replaceState({}, "", "/?earlier");
    try {
      const calls = await launch();
      fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
      const more = await screen.findByRole("button", { name: /Show earlier messages/ });
      expect(more).toHaveTextContent("1 earlier turn");
      expect(screen.queryByText("Where does fetchJson live?")).toBeNull();
      fireEvent.click(more);
      await screen.findByText("Where does fetchJson live?");
      // Nothing is left to load: the bar goes, and what it asked the backend for was the one turn it was missing.
      expect(screen.queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
      const asked = calls.filter(([c]) => c === "earlier_events").map(([, a]) => a);
      expect(asked).toEqual([{ folder: OTHER, sessionId: "3f1c2a", hidden: 1 }]);
      // A long chat is still named by what the backend knows of it (a title already made), not left with a prompt from the middle.
      expect(calls.some(([c, a]) => c === "title_session" && a?.sessionId === "3f1c2a")).toBe(true);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("keeps an asleep chat's title and unsent text across a save", async () => {
    localStorage.setItem("session.openChats", JSON.stringify([{ ...lastTime[0], draft: "and the jitter?" }, lastTime[1]]));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByTitle("Retry transient fetch errors");
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.find((c) => c.sessionId === "9b7e01")).toMatchObject({ title: "Retry transient fetch errors", draft: "and the jitter?", active: false });
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
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
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

  it("brings an agent back on the model it had, or Sonnet when none was saved, never on the project's own model", async () => {
    // The project's harness runs its chats on Opus; the agents didn't.
    localStorage.setItem("settings.model", JSON.stringify("opus"));
    const withModel = team.map((c) => (c.orchestra?.role === "worker" ? { ...c, orchestra: { ...c.orchestra, model: "claude-haiku-5-5" } } : c));
    localStorage.setItem("session.openChats", JSON.stringify(withModel));
    const calls = await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByRole("button", { name: "Canvas" });
    const models = (id: string) => calls.filter(([c, a]) => c === "open_session" && a?.sessionId === id).map(([, a]) => (a?.settings as { model?: string }).model);
    expect(models("aaaa11")).toEqual(["claude-haiku-5-5"]);
    // The Lead keeps its own.
    expect(models("bbbb22")).toEqual(["opus"]);
  });

  it("brings an agent saved before models were kept back on Sonnet", async () => {
    localStorage.setItem("settings.model", JSON.stringify("opus"));
    const calls = await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByRole("button", { name: "Canvas" });
    const open = calls.filter(([c, a]) => c === "open_session" && a?.sessionId === "aaaa11");
    expect(open.map(([, a]) => (a?.settings as { model?: string }).model)).toEqual(["sonnet"]);
  });

  it("brings the team back with the review setting it had, the builder's role told to the backend, and saves them again", async () => {
    const review = { on: true, tidy: false, checks: ["reviewer", "qa"] };
    const role = { id: "builder", label: "Builder", read_only: false };
    const saved = team.map((c) => (c.orchestra?.role === "main" ? { ...c, orchestra: { role: "main", review } } : { ...c, orchestra: { ...c.orchestra, agentRole: role } }));
    localStorage.setItem("session.openChats", JSON.stringify(saved));
    const calls = await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    expect(await screen.findByRole("button", { name: "Review: On" })).toBeInTheDocument();
    const told = calls.filter(([c]) => c === "orchestra_set_review").pop()?.[1];
    expect(told).toMatchObject({ setting: review });
    // The builder comes back as a builder, so what it builds is checked again.
    const worker = calls.find(([c, a]) => c === "open_session" && a?.sessionId === "aaaa11")?.[1] as { settings: { worker: { role?: unknown } } };
    expect(worker.settings.worker.role).toEqual(role);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("session.openChats") ?? "[]").find((c: SavedChat) => c.sessionId === "bbbb22").orchestra).toEqual({ role: "main", review }));
  });

  it("brings a team saved without the setting back with it off", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    expect(await screen.findByRole("button", { name: "Review: Off" })).toBeInTheDocument();
  });

  it("brings the workers back on the mode they had, not just the ones the user had looked at", async () => {
    localStorage.setItem("settings.modeBySession", JSON.stringify({ bbbb22: "auto", aaaa11: "auto" }));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    // Each window's title bar says its Permissions: the Lead's and the agent's.
    expect(await within(await screen.findByLabelText(/^Lead,/)).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    expect(await within(await screen.findByLabelText(/Agent Login form/)).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    // Still saved under both sessions for the next restart.
    expect(JSON.parse(localStorage.getItem("settings.modeBySession") ?? "{}")).toMatchObject({ bbbb22: "auto", aaaa11: "auto" });
  });

  it("brings a worker with no saved mode back on Ask, as before modes were kept for it", async () => {
    localStorage.setItem("settings.modeBySession", JSON.stringify({ bbbb22: "auto" }));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    expect(await within(await screen.findByLabelText(/^Lead,/)).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    expect(await within(await screen.findByLabelText(/Agent Login form/)).findByRole("button", { name: "Permissions: Ask" })).toBeInTheDocument();
  });

  it("keeps the side panel beside the canvas, shut until the user opens it, and remembers that", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    expect(await screen.findByLabelText(/Agent Login form/)).toBeInTheDocument();
    // The panel is there beside the canvas (its Changes tab is in the page), shut.
    expect(screen.getByRole("tab", { name: /^Changes/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show side panel" }));
    expect(await screen.findByRole("button", { name: "Hide side panel" })).toBeInTheDocument();
    // Still the canvas, now with the panel open beside it; and the choice is kept for the next time.
    expect(screen.getByLabelText(/Agent Login form/)).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("review.canvasPanel") ?? "false")).toBe(true));
  });

  it("keeps a worker the user hid hidden across a restart", async () => {
    const hiddenWorker: SavedChat = { ...team[0], orchestra: { ...(team[0].orchestra as Extract<NonNullable<SavedChat["orchestra"]>, { role: "worker" }>), hidden: true } };
    localStorage.setItem("session.openChats", JSON.stringify([hiddenWorker, team[1]]));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByRole("button", { name: "Canvas" });
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.find((c) => c.sessionId === "aaaa11")?.orchestra).toMatchObject({ role: "worker", hidden: true });
    });
  });

  it("restores what an older version saved, which has no such field, with the worker shown", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByRole("button", { name: "Canvas" });
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.find((c) => c.sessionId === "aaaa11")?.orchestra).toMatchObject({ role: "worker", name: "Login form" });
      expect(saved.find((c) => c.sessionId === "aaaa11")?.orchestra).not.toHaveProperty("hidden");
    });
  });

  // What an older version left saved after a team ran: agents without a team, a worktree that was removed, and an
  // agent's chat saved as an ordinary one.
  it("never brings an agent back as a chat of its own, and drops what can't come back from the saved chats", async () => {
    const worker = team[0].orchestra as Extract<NonNullable<SavedChat["orchestra"]>, { role: "worker" }>;
    const AGENT_FOLDER = "/Users/you/Library/Application Support/io.github.alyakan.lantern/worktrees/acme-api/old-w2";
    localStorage.setItem(
      "session.openChats",
      JSON.stringify([
        team[0],
        team[1],
        // Its worktree was removed after the merge.
        { ...team[0], sessionId: "dddd44", folder: `${WORKTREE}-gone`, title: "Removed", orchestra: { ...worker, name: "Removed" } },
        // Its main agent isn't among the saved chats.
        { ...team[0], sessionId: "eeee55", title: "Orphan", orchestra: { ...worker, name: "Orphan", parentSession: "zzzz99" } },
        // Saved as an ordinary chat by a version that restored workers that way.
        { sessionId: "ffff66", folder: AGENT_FOLDER, title: "Old agent chat", draft: "", active: false },
        // Shared with its team's folder, and known to be an agent's.
        { sessionId: "9b7e01", folder: FOLDER, title: "Shared agent", draft: "", active: false },
        { sessionId: "3f1c2a", folder: OTHER, title: "A chat of the user's", draft: "", active: false },
      ]),
    );
    localStorage.setItem("session.agentIds", JSON.stringify(["9b7e01"]));
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
    const { default: App } = await import("./App");
    render(<App />);
    // The team and the user's own chat are offered, and nothing of the agents.
    await screen.findByText("2 chats were open when Lantern closed");
    expect(screen.queryByRole("button", { name: /Login form|Removed|Orphan|Old agent chat|Shared agent/ })).toBeNull();
    // The saved list is cleaned on the first launch, apart from the worker that comes back with its team (and not yet its folder check).
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.map((c) => c.sessionId).sort()).toEqual(["3f1c2a", "aaaa11", "bbbb22"]);
    });
    fireEvent.click(screen.getByRole("button", { name: /^Restore( all)?$/ }));
    await screen.findByRole("button", { name: "Canvas" });
    // The team's own agent is nested under it in the sidebar (folded under "1 agent" until opened): no project of its own, no row among the chats.
    const acme = await screen.findByRole("region", { name: "acme-api" });
    fireEvent.click(await within(acme).findByRole("button", { name: /^1 agent in / }));
    expect(within(acme).getByTitle(/Login form/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /login-form|worktrees|old-w2/ })).toBeNull();
    await waitFor(() => {
      const saved: SavedChat[] = JSON.parse(localStorage.getItem("session.openChats") ?? "[]");
      expect(saved.map((c) => [c.sessionId, c.orchestra?.role ?? null]).sort()).toEqual([["3f1c2a", null], ["aaaa11", "worker"], ["bbbb22", "main"]]);
    });
    // The agents' conversations are remembered, so the past chats leave them out.
    expect(JSON.parse(localStorage.getItem("session.agentIds") ?? "[]")).toEqual(expect.arrayContaining(["9b7e01", "aaaa11", "dddd44", "eeee55", "ffff66"]));
  });
});
