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
  it("lists the open project first and open, the other recent folders collapsed, and reads past chats only for the open one", async () => {
    const calls = await launch();
    const acme = await project("acme-api");
    expect(within(acme).getByRole("button", { name: /^acme-api/ })).toHaveAttribute("aria-expanded", "true");
    // Past chats of the open project: the 3 most recent, and Show all for the rest.
    expect(await within(acme).findByText("Fix the login redirect after OAuth callback")).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "Show all 5…" })).toBeInTheDocument();
    expect(within(acme).queryByText("Release flow notes")).toBeNull();
    const web = await project("web-dashboard · projects");
    expect(within(web).getByRole("button", { name: /^web-dashboard/ })).toHaveAttribute("aria-expanded", "false");
    expect(calledWith(calls, "list_sessions")).toEqual([{ folder: FOLDER }]);
    // The empty chat on screen is there too, as the open chat.
    expect(within(acme).getByTitle("New chat")).toHaveAttribute("aria-current", "true");
  });

  it("leaves an agent's conversation out of the past chats, though it is in the project's folder", async () => {
    // Agents that share the folder run their sessions in it, so Claude Code files them with the project's own.
    localStorage.setItem("session.agentIds", JSON.stringify(["3f1c2a", "c0ffee"]));
    await launch();
    const acme = await project("acme-api");
    expect(await within(acme).findByText("Add retries with backoff to fetchJson")).toBeInTheDocument();
    expect(within(acme).queryByText("Fix the login redirect after OAuth callback")).toBeNull();
    expect(within(acme).queryByText("Refactor the settings screen into smaller components")).toBeNull();
    expect(within(acme).queryByRole("button", { name: /^Show all/ })).toBeNull(); // 3 of the 5 are the user's, all listed
  });

  it("reads another project's chats when it is opened, and resumes one of them in that project", async () => {
    const calls = await launch();
    const web = await project("web-dashboard · projects");
    fireEvent.click(within(web).getByRole("button", { name: /^web-dashboard/ }));
    fireEvent.click(await within(web).findByRole("button", { name: /Chart tooltips clip at the edge/ }));
    await waitFor(() => expect(calledWith(calls, "open_session").length).toBe(1));
    expect(calledWith(calls, "open_session")[0]).toMatchObject({ folder: OTHER, sessionId: "d4a501" });
    // It is open now, in its project, and on screen: no longer listed as a past chat (the mock replays one conversation, so
    // its title is that conversation's first prompt).
    const open = await project("web-dashboard · projects");
    await waitFor(() => expect(open.querySelector('[aria-current="true"]')).not.toBeNull());
    expect(within(open).queryByText("Chart tooltips clip at the edge")).toBeNull();
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
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Chat⌘N", "Team⇧⌘N", "Review a PR…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team/ }));
    await waitFor(() => expect(calledWith(calls, "start_session").length).toBeGreaterThan(1));
    expect(calledWith(calls, "start_session").pop()).toMatchObject({ settings: { orchestrator: true } });
    expect(await screen.findByRole("button", { name: /Team: New team/ })).toBeInTheDocument();
  });

  it("starts a chat in a project from its +, and shows it there", async () => {
    const calls = await launch();
    const web = await project("web-dashboard · projects");
    fireEvent.click(within(web).getByRole("button", { name: "New chat in web-dashboard · projects" }));
    await waitFor(() => expect(calledWith(calls, "start_session").pop()).toMatchObject({ folder: OTHER }));
    expect(await within(await project("web-dashboard · projects")).findByTitle("New chat")).toHaveAttribute("aria-current", "true");
  });

  it("opens History for a project from Show all…, with past chats only, and resumes one", async () => {
    const calls = await launch();
    const acme = await project("acme-api");
    fireEvent.click(await within(acme).findByRole("button", { name: "Show all 5…" }));
    const history = await screen.findByRole("dialog", { name: "Chat history" });
    expect(await within(history).findByText("Release flow notes")).toBeInTheDocument();
    expect(within(history).getByText("Past chats in acme-api")).toBeInTheDocument();
    expect(within(history).queryByText("Open chats")).toBeNull();
    fireEvent.click(within(history).getByText("Release flow notes"));
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    await waitFor(() => expect(calledWith(calls, "open_session").pop()).toMatchObject({ folder: FOLDER, sessionId: "b0b0b0" }));
  });

  it("keeps History on ⌘K for the project on screen", async () => {
    await launch();
    await project("acme-api");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeInTheDocument();
    expect(screen.getByText("Past chats in acme-api")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
  });

  it("shows the Moved? notice on the project row of the folder that moved", async () => {
    await launch();
    const old = await project("web-dashboard · Github");
    expect(within(old).getByRole("button", { name: /^Move chats from .*web-dashboard to .*web-dashboard$/ })).toBeInTheDocument();
    expect(within(await project("acme-api")).queryByText(/Moved\?/)).toBeNull();
  });

  it("minimizes to the rail with ⌃⌘S, and brings the sidebar back the same way; it is remembered", async () => {
    await launch();
    await project("acme-api");
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    const rail = await screen.findByRole("complementary", { name: "Projects" });
    await waitFor(() => expect(rail).toHaveClass("rail"));
    expect(within(rail).getByRole("button", { name: "acme-api" })).toHaveTextContent("AA");
    expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull();
    expect(localStorage.getItem("sidebar.collapsed")).toBe("true");
    // A second press within a moment is the same keystroke arriving twice (webview and menu), so it waits.
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true });
    expect(await screen.findByRole("region", { name: "acme-api" })).toBeInTheDocument();
    expect(localStorage.getItem("sidebar.collapsed")).toBe("false");
  });

  it("starts on the rail when it was left there, and reads no past chats until it is opened", async () => {
    localStorage.setItem("sidebar.collapsed", "true");
    const calls = await launch();
    const rail = await screen.findByRole("complementary", { name: "Projects" });
    expect(rail).toHaveClass("rail");
    await within(rail).findByRole("button", { name: "acme-api" });
    expect(calledWith(calls, "list_sessions")).toEqual([]);
    fireEvent.click(within(rail).getByRole("button", { name: "Show sidebar" }));
    await within(await project("acme-api")).findByText("Fix the login redirect after OAuth callback");
    expect(calledWith(calls, "list_sessions")).toEqual([{ folder: FOLDER }]);
  });

  it("remembers the width it was dragged to", async () => {
    localStorage.setItem("sidebar.width", "300");
    await launch();
    await project("acme-api");
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "300px" });
  });

  it("removes a project from the recents, and brings it back when its folder is opened", async () => {
    await launch();
    const web = await project("web-dashboard · projects");
    fireEvent.click(within(web).getByRole("button", { name: "More for web-dashboard · projects" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from recents" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "web-dashboard · projects" })).toBeNull());
    expect(JSON.parse(localStorage.getItem("sidebar.hidden") ?? "[]")).toEqual([OTHER]);
    // The other web-dashboard (the moved one) has the name to itself now.
    expect(await project("web-dashboard")).toBeInTheDocument();
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
    const agents = within(acme).getByRole("list", { name: /^Agents in / });
    expect(within(agents).getAllByRole("button").map((b) => b.getAttribute("title"))).toEqual(["Login form"]);
    // The agent is under its team only: one row in the whole sidebar, and the agent's worktree isn't a project.
    expect(within(screen.getByRole("complementary", { name: "Projects" })).getAllByTitle("Login form")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /login-form/ })).toBeNull();

    fireEvent.click(row);
    expect(await screen.findByLabelText(/Agent Login form/)).toBeInTheDocument();
    fireEvent.click(within(agents).getByRole("button", { name: /Login form/ }));
    await waitFor(() => expect(within(agents).getByRole("button", { name: /Login form/ })).toHaveAttribute("aria-current", "true"));
    // The team is still on its canvas.
    expect(screen.getByLabelText(/^Lead,/)).toBeInTheDocument();
  });
});
