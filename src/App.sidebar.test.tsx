import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 30_000 });

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

const FOLDER = "/Users/you/projects/acme-api";
const OTHER = "/Users/you/projects/web-dashboard";

type Call = [string, Record<string, unknown> | undefined];

/** Opens the app on a project with an empty chat, recording every command it sends to the backend. */
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
  await screen.findByRole("button", { name: /^Permissions: / });
  return calls;
}

const project = (name: string) => screen.findByRole("region", { name });
const calledWith = (calls: Call[], cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("the sidebar in the app", () => {
  const history = () => screen.findByRole("dialog", { name: "Chat history" });

  it("lists only the projects with a chat open, and reads no past chats until History is opened", async () => {
    const calls = await launch();
    const acme = await project("acme-api");
    expect(within(acme).getByRole("button", { name: /^acme-api/ })).toHaveAttribute("aria-expanded", "true");
    // The empty chat on screen is there, as the open chat.
    expect(within(acme).getByTitle("New chat")).toHaveAttribute("aria-current", "true");
    // The other recent folders and every past chat are in History, not in the pane.
    expect(screen.queryByRole("region", { name: "web-dashboard · projects" })).toBeNull();
    expect(screen.queryByText(/Show all/)).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(calledWith(calls, "list_sessions")).toEqual([]);
  });

  it("has a History button under New that opens the past chats of every project, grouped by project, and toggles it", async () => {
    const calls = await launch();
    await project("acme-api");
    const button = screen.getByRole("button", { name: "History" });
    expect(button).toHaveAttribute("title", "History");
    fireEvent.click(button);
    const dialog = await history();
    expect(await within(dialog).findByText("Fix the login redirect after OAuth callback")).toBeInTheDocument();
    const names = within(dialog).getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(names).toContain("acme-api");
    expect(names).toContain("web-dashboard · projects");
    await waitFor(() => expect(new Set(calledWith(calls, "list_sessions").map((a) => a?.folder)).has(OTHER)).toBe(true));
    // A press on the button again closes it, and Escape does.
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull());
    fireEvent.click(button);
    await history();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
  });

  it("leaves an agent's conversation out of the past chats, though it is in the project's folder", async () => {
    // Agents that share the folder run their sessions in it, so Claude Code files them with the project's own.
    localStorage.setItem("session.agentIds", JSON.stringify(["3f1c2a", "c0ffee"]));
    await launch();
    await project("acme-api");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const acme = within(await history());
    expect(await acme.findByText("Add retries with backoff to fetchJson")).toBeInTheDocument();
    expect(acme.queryByText("Fix the login redirect after OAuth callback")).toBeNull();
    expect(acme.queryByText("Refactor the settings screen into smaller components")).toBeNull();
  });

  it("resumes a past chat of another project from History, in that project", async () => {
    const calls = await launch();
    await project("acme-api");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(await within(await history()).findByText("Chart tooltips clip at the edge"));
    await waitFor(() => expect(calledWith(calls, "open_session").length).toBe(1));
    expect(calledWith(calls, "open_session")[0]).toMatchObject({ folder: OTHER, sessionId: "d4a501" });
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    // It is open now, in its project, and on screen: the pane lists that project too.
    const open = await project("web-dashboard");
    await waitFor(() => expect(open.querySelector('[aria-current="true"]')).not.toBeNull());
  });

  it("starts a chat in a project with nothing open from its header in History", async () => {
    const calls = await launch();
    await project("acme-api");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(await within(await history()).findByRole("button", { name: "New chat in web-dashboard · projects" }));
    await waitFor(() => expect(calledWith(calls, "start_session").pop()).toMatchObject({ folder: OTHER }));
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    expect(await within(await project("web-dashboard")).findByTitle("New chat")).toHaveAttribute("aria-current", "true");
  });

  it("has New ▾ in place of the title bar's New chat and Start a team, and the title bar lost its History clock", async () => {
    const calls = await launch();
    await project("acme-api");
    const bar = screen.getByRole("banner");
    expect(within(bar).queryByRole("button", { name: "New chat" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Start a team" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Chat history" })).toBeNull();
    // The folder and branch stay.
    expect(bar).toHaveTextContent("acme-api");
    expect(await within(bar).findByText("main")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Chat⌘N", "Team⇧⌘N", "Team from a template…", "Review a PR…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team(?! from)/ }));
    await waitFor(() => expect(calledWith(calls, "start_session").length).toBeGreaterThan(1));
    expect(calledWith(calls, "start_session").pop()).toMatchObject({ settings: { orchestrator: true } });
    expect(await screen.findByRole("button", { name: /Team: New team/ })).toBeInTheDocument();
  });

  it("opens History for every project on ⌘K, and closes it on ⌘K again, with or without a project open", async () => {
    await launch();
    await project("acme-api");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await history();
    expect(await within(dialog).findByText("Fix the login redirect after OAuth callback")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toHaveValue("");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull());
  });

  it("hides completely with ⌃⌘S, leaving a Show sidebar button in the title bar, and brings it back the same way; it is remembered", async () => {
    await launch();
    await project("acme-api");
    const bar = screen.getByRole("banner");
    expect(within(bar).queryByRole("button", { name: /^Show sidebar/ })).toBeNull();
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull());
    expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull();
    expect(localStorage.getItem("sidebar.collapsed")).toBe("true");
    expect(within(bar).getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
    // A second press within a moment is the same keystroke arriving twice (webview and menu), so it waits.
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    expect(await screen.findByRole("region", { name: "acme-api" })).toBeInTheDocument();
    expect(localStorage.getItem("sidebar.collapsed")).toBe("false");
    expect(within(bar).queryByRole("button", { name: /^Show sidebar/ })).toBeNull();
  });

  it("the title bar's button shows it again, and the menu and palette name what ⌃⌘S does", async () => {
    const calls = await launch();
    await project("acme-api");
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Show sidebar" }));
    expect(await project("acme-api")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    // The menu bar is told (hidden, compact) each time it changes.
    expect(calledWith(calls, "sidebar_menu")).toEqual([
      { hidden: false, compact: false },
      { hidden: true, compact: false },
      { hidden: false, compact: false },
    ]);
  });

  it("starts hidden when it was left minimized (the old rail), and reads no past chats at all until History is opened", async () => {
    localStorage.setItem("sidebar.collapsed", "true");
    const calls = await launch();
    const show = await screen.findByRole("button", { name: "Show sidebar" });
    expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull();
    expect(calledWith(calls, "list_sessions")).toEqual([]);
    fireEvent.click(show);
    await project("acme-api");
    await new Promise((r) => setTimeout(r, 300));
    expect(calledWith(calls, "list_sessions")).toEqual([]);
  });

  it("keeps the sidebar's width apart, so showing it again restores it", async () => {
    localStorage.setItem("sidebar.width", "300");
    localStorage.setItem("sidebar.collapsed", "true");
    await launch();
    fireEvent.click(await screen.findByRole("button", { name: "Show sidebar" }));
    await project("acme-api");
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "300px" });
  });

  it("remembers the width it was dragged to", async () => {
    localStorage.setItem("sidebar.width", "300");
    await launch();
    await project("acme-api");
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "300px" });
  });

  it("removes a project from the recents from its ⋯ menu, which only hides it", async () => {
    await launch();
    const acme = await project("acme-api");
    fireEvent.click(within(acme).getByRole("button", { name: "More for acme-api" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from recents" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("sidebar.hidden") ?? "[]")).toEqual([FOLDER]));
    // It has a chat open, so it stays listed.
    expect(await project("acme-api")).toBeInTheDocument();
  });
});

describe("the hidden sidebar", () => {
  const edge = () => document.querySelector(".sidebar-edge") as HTMLElement;
  // Whole-app tests run in real time: the pointer rests on the edge for the peek's delay.
  const rest = () => new Promise((r) => setTimeout(r, 320));

  beforeEach(() => localStorage.setItem("sidebar.collapsed", "true"));

  it("slides the sidebar in over the chat when the pointer rests on the left edge, and away when it leaves", async () => {
    await launch();
    await screen.findByRole("button", { name: "Show sidebar" });
    fireEvent.pointerEnter(edge());
    expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull();
    await rest();
    const peeked = await screen.findByRole("complementary", { name: "Projects" });
    expect(peeked).toHaveClass("peek");
    // It is over the chat: the app's own layout still has the whole width (hidden is still saved).
    expect(localStorage.getItem("sidebar.collapsed")).toBe("true");
    fireEvent.pointerLeave(peeked.parentElement!);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull());
  });

  it("does not open for a pointer that only crosses the edge", async () => {
    await launch();
    await screen.findByRole("button", { name: "Show sidebar" });
    fireEvent.pointerEnter(edge());
    fireEvent.pointerLeave(edge());
    await rest();
    expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull();
  });

  it("closes on Escape", async () => {
    await launch();
    await screen.findByRole("button", { name: "Show sidebar" });
    fireEvent.pointerEnter(edge());
    await rest();
    await screen.findByRole("complementary", { name: "Projects" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull());
  });

  it("goes to a chat picked in it, and puts itself away", async () => {
    await launch();
    await screen.findByRole("button", { name: "Show sidebar" });
    fireEvent.pointerEnter(edge());
    await rest();
    const acme = await project("acme-api");
    fireEvent.click(within(acme).getByRole("button", { name: /^New chat, acme-api/ }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Projects" })).toBeNull());
    // Still hidden: picking is not pinning.
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
    expect(localStorage.getItem("sidebar.collapsed")).toBe("true");
  });

  it("is pinned from its own button: a normal sidebar again", async () => {
    await launch();
    await screen.findByRole("button", { name: "Show sidebar" });
    fireEvent.pointerEnter(edge());
    await rest();
    fireEvent.click(await screen.findByRole("button", { name: "Keep sidebar open" }));
    const shown = await screen.findByRole("complementary", { name: "Projects" });
    expect(shown).not.toHaveClass("peek");
    expect(localStorage.getItem("sidebar.collapsed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
  });

  it("badges the title bar's button with what needs you", async () => {
    localStorage.setItem("sidebar.collapsed", "false");
    await launch();
    await project("acme-api");
    expect(screen.queryByRole("button", { name: /^Show sidebar/ })).toBeNull();
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "ask me first" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Where should retries live?");
    // Waiting in the sidebar's list too, so hide it and the count moves to the button.
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    const show = await screen.findByRole("button", { name: "Show sidebar, 1 chat needs you" });
    expect(show).toHaveTextContent("1");
    fireEvent.click(show);
    expect(await project("acme-api")).toBeInTheDocument();
  });
});

describe("the collapsed sidebar", () => {
  const column = () => screen.findByRole("complementary", { name: "Open chats" });
  const full = () => screen.queryByRole("complementary", { name: "Projects" });
  // Whole-app tests run in real time: the pointer rests on the column for the peek's delay.
  const rest = () => new Promise((r) => setTimeout(r, 320));

  it("is the pin button's doing: a slim column of the open chats instead of the pinned sidebar, and the button at its top pins it again; it is remembered", async () => {
    await launch();
    await project("acme-api");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const slim = await column();
    expect(full()).toBeNull();
    expect(localStorage.getItem("sidebar.compact")).toBe("true");
    // The empty chat on screen is its one square, lit.
    expect(within(slim).getByRole("button", { name: /^New chat, acme-api/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(slim).getByRole("button", { name: "Expand sidebar" }));
    expect(await project("acme-api")).toBeInTheDocument();
    expect(localStorage.getItem("sidebar.compact")).toBe("false");
  });

  it("starts collapsed when it was left that way, and reads no past chats until it opens", async () => {
    localStorage.setItem("sidebar.compact", "true");
    const calls = await launch();
    await column();
    expect(calledWith(calls, "list_sessions")).toEqual([]);
  });

  it("⌃⌘S hides it and brings it back collapsed: hidden and collapsed are kept apart", async () => {
    localStorage.setItem("sidebar.compact", "true");
    await launch();
    await column();
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Open chats" })).toBeNull());
    expect(localStorage.getItem("sidebar.collapsed")).toBe("true");
    expect(localStorage.getItem("sidebar.compact")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    await column();
    expect(full()).toBeNull();
    expect(localStorage.getItem("sidebar.collapsed")).toBe("false");
  });

  it("an old saved 'collapsed' still means hidden, whatever the collapsed setting", async () => {
    localStorage.setItem("sidebar.collapsed", "true");
    localStorage.setItem("sidebar.compact", "true");
    await launch();
    await screen.findByRole("button", { name: "Show sidebar" });
    expect(screen.queryByRole("complementary", { name: "Open chats" })).toBeNull();
  });

  it("tells the menu bar what its two sidebar items do now", async () => {
    localStorage.setItem("sidebar.compact", "true");
    const calls = await launch();
    await column();
    expect(calledWith(calls, "sidebar_menu").slice(-1)[0]).toEqual({ hidden: false, compact: true });
  });

  describe("opening in place", () => {
    beforeEach(() => localStorage.setItem("sidebar.compact", "true"));
    const panel = async () => (await column()).querySelector<HTMLElement>(".sb-panel")!;

    it("opens the column itself over the chat when the pointer rests on it, as the whole pane, and closes when it leaves", async () => {
      await launch();
      const p = await panel();
      fireEvent.pointerEnter(p);
      expect(p).not.toHaveClass("expanded");
      await rest();
      await waitFor(() => expect(p).toHaveClass("expanded"));
      // The same sidebar, wider: still collapsed as far as what is saved goes.
      expect(full()).toHaveClass("collapsed");
      expect(await project("acme-api")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
      expect(localStorage.getItem("sidebar.compact")).toBe("true");
      fireEvent.pointerLeave(p);
      expect(p).not.toHaveClass("expanded");
    });

    it("is pinned from its pin button while open over the chat, and then stays", async () => {
      await launch();
      const p = await panel();
      fireEvent.pointerEnter(p);
      await rest();
      fireEvent.click(await screen.findByRole("button", { name: "Keep sidebar open" }));
      await waitFor(() => expect(localStorage.getItem("sidebar.compact")).toBe("false"));
      expect(full()).toHaveClass("pinned");
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    });

    it("does not open for a pointer that only crosses the column", async () => {
      await launch();
      const p = await panel();
      fireEvent.pointerEnter(p);
      fireEvent.pointerLeave(p);
      await rest();
      expect(p).not.toHaveClass("expanded");
    });

    it("closes on Escape", async () => {
      await launch();
      const p = await panel();
      fireEvent.pointerEnter(p);
      await rest();
      await waitFor(() => expect(p).toHaveClass("expanded"));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(p).not.toHaveClass("expanded"));
    });

    it("goes to a chat picked in it and closes, still compact", async () => {
      await launch();
      const p = await panel();
      fireEvent.pointerEnter(p);
      await rest();
      await waitFor(() => expect(p).toHaveClass("expanded"));
      fireEvent.click(within(p).getByRole("button", { name: /^New chat, acme-api/ }));
      expect(p).not.toHaveClass("expanded");
      expect(localStorage.getItem("sidebar.compact")).toBe("true");
    });
  });
});

describe("a team in the sidebar", () => {
  const WORKTREE = "/Users/you/Library/Application Support/lantern/worktrees/acme-api/login-form-w1";
  const team = [
    { sessionId: "aaaa11", folder: WORKTREE, title: "Login form", draft: "", active: false, orchestra: { role: "worker", name: "Login form", parentSession: "bbbb22", branch: "lantern/login-form", base: "main", isolation: "worktree" } },
    { sessionId: "bbbb22", folder: FOLDER, title: "Build the login flow", draft: "", active: true, orchestra: { role: "main" } },
  ];

  it("shows the team with its agent nested under it, and the agent nowhere else; clicks open the canvas and focus the agent", async () => {
    localStorage.setItem("session.openChats", JSON.stringify(team));
    await launch();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore( all)?$/ }));
    const acme = await project("acme-api");
    const row = await within(acme).findByRole("button", { name: /Team: / });
    // Folded: only the team's line says it has an agent, until it is pressed.
    expect(within(acme).queryByRole("list", { name: /^Agents in / })).toBeNull();
    fireEvent.click(within(acme).getByRole("button", { name: /^1 agent in / }));
    const agents = within(acme).getByRole("list", { name: /^Agents in / });
    expect(within(agents).getAllByRole("button", { name: /, acme-api,/ }).map((b) => b.getAttribute("title"))).toEqual(["Login form"]);
    // The agent is under its team only: one row in the whole sidebar, and the agent's worktree isn't a project.
    expect(within(screen.getByRole("complementary", { name: "Projects" })).getAllByTitle("Login form")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /login-form/ })).toBeNull();

    fireEvent.click(row);
    expect(await screen.findByLabelText(/Agent Login form/)).toBeInTheDocument();
    fireEvent.click(within(agents).getByRole("button", { name: /^Login form, acme-api/ }));
    await waitFor(() => expect(within(agents).getByRole("button", { name: /^Login form, acme-api/ })).toHaveAttribute("aria-current", "true"));
    // The team is still on its canvas.
    expect(screen.getByLabelText(/^Lead,/)).toBeInTheDocument();
  });
});

describe("closing chats from the sidebar", () => {
  const WORKTREE = "/Users/you/Library/Application Support/lantern/worktrees/acme-api/login-form-w1";
  const team = [
    { sessionId: "aaaa11", folder: WORKTREE, title: "Login form", draft: "", active: false, orchestra: { role: "worker", name: "Login form", parentSession: "bbbb22", branch: "lantern/login-form", base: "main", isolation: "worktree" } },
    { sessionId: "bbbb22", folder: FOLDER, title: "Build the login flow", draft: "", active: true, orchestra: { role: "main" } },
  ];

  it("closes the chat on screen from its ×: nothing is left open, so the pane says so", async () => {
    const calls = await launch();
    const acme = await project("acme-api");
    fireEvent.click(within(acme).getByRole("button", { name: "Close New chat" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull());
    expect(calledWith(calls, "close_session").length).toBeGreaterThan(0);
    expect(await screen.findByText("Nothing open. Start a chat with New, or find an old one in History.")).toBeInTheDocument();
  });

  it("asks \"Stop and close?\" before closing a chat that waits on an answer, and stops it on yes", async () => {
    const calls = await launch();
    await project("acme-api");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "ask me first" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Where should retries live?");
    const before = calledWith(calls, "close_session").length;
    fireEvent.click(await screen.findByRole("button", { name: /^Close ask me first/ }));
    const ask = await screen.findByRole("group", { name: /^Close ask me first/ });
    expect(ask).toHaveTextContent("Stop and close?");
    expect(calledWith(calls, "close_session").length).toBe(before);
    fireEvent.click(within(ask).getByRole("button", { name: "Stop and close" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull());
    expect(calledWith(calls, "close_session").length).toBeGreaterThan(before);
  });

  it("asks \"Close the team and its 1 agent?\" with what would be lost, closes the agent the checked way, then the Lead", async () => {
    localStorage.setItem("session.openChats", JSON.stringify(team));
    const calls = await launch();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore( all)?$/ }));
    const acme = await project("acme-api");
    const lead = await within(acme).findByRole("button", { name: /^Team: / });
    fireEvent.click(lead.parentElement!.querySelector<HTMLElement>(".sb-close")!);
    const ask = await screen.findByRole("group", { name: /^Close / });
    expect(ask).toHaveTextContent("Close the team and its 1 agent?");
    expect(ask).toHaveTextContent("2 uncommitted files and 1 commit that isn't merged would be lost.");
    expect(calledWith(calls, "orchestra_close_worker")).toEqual([]);
    fireEvent.click(within(ask).getByRole("button", { name: "Close team and agents" }));
    await waitFor(() => expect(calledWith(calls, "orchestra_close_worker")).toEqual([{ worker: expect.any(String), agreed: { uncommitted: 2, unmerged_commits: 1 } }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull());
  });
});
