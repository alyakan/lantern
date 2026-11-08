import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than vitest's default to do.
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 20_000 });

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

const FOLDER = "/Users/you/projects/acme-api";

async function launch(startOnDesk: boolean) {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
  const { default: App } = await import("./App");
  render(<App startOnDesk={startOnDesk} />);
  await screen.findByRole("region", { name: "acme-api" });
}

const desk = () => screen.queryByRole("region", { name: "Desk" });
const ask = () => screen.queryByRole("region", { name: "Ask" });
const deskButton = () => screen.getByRole("button", { name: /^Desk/ });

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("the Desk in the app", () => {
  it("opens on the Desk once a chat is open, in place of the chat, and a chat in the sidebar leaves it", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    expect(deskButton()).toHaveAttribute("aria-pressed", "true");
    // Ask is a sheet: the title bar's panel button opens it, and puts it away again.
    fireEvent.click(screen.getByRole("button", { name: "Show side panel" }));
    expect(within(await screen.findByRole("region", { name: "Ask" })).getByText(/Nothing asked here yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide side panel" }));
    await waitFor(() => expect(ask()).toBeNull());
    // The Desk has the chat's project, whose tile drops the chat down.
    const table = within(desk()!).getByRole("region", { name: "Projects" });
    fireEvent.click(within(table).getByRole("button", { name: "Show the chats of acme-api" }));
    expect(within(screen.getByRole("menu", { name: "Chats of acme-api" })).getByRole("menuitem", { name: "New chat" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(within(await screen.findByRole("region", { name: "acme-api" })).getByTitle("New chat"));
    await waitFor(() => expect(desk()).toBeNull());
    expect(deskButton()).toHaveAttribute("aria-pressed", "false");
    // Its button brings it back, and puts it away again.
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeNull());
  });

  it("opens Ask from the bar at the foot of the Desk, and ⌘J opens and puts it away", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    expect(ask()).toBeNull();
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(await screen.findByRole("region", { name: "Ask" })).toBeInTheDocument();
    // A second press within 150 ms is dropped as the same keystroke arriving twice (see runAction).
    await new Promise((resolve) => setTimeout(resolve, 200));
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await waitFor(() => expect(ask()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Ask across your projects" }));
    expect(await screen.findByRole("region", { name: "Ask" })).toBeInTheDocument();
  });

  it("puts the Ask sheet away on Escape and on a click behind it, but not on a click inside it", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    const open = async () => {
      if (!ask()) fireEvent.click(screen.getByRole("button", { name: "Ask across your projects" }));
      return screen.findByRole("region", { name: "Ask" });
    };
    const inside = await open();
    fireEvent.mouseDown(inside);
    expect(ask()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(ask()).toBeNull());
    await open();
    fireEvent.mouseDown(document.querySelector(".desk-ask-overlay")!);
    await waitFor(() => expect(ask()).toBeNull());
  });

  it("closes the Ask sheet when the Desk is left, so it is not waiting when the Desk comes back", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Ask across your projects" }));
    await screen.findByRole("region", { name: "Ask" });
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeNull());
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeInTheDocument());
    expect(ask()).toBeNull();
  });

  it("opens a project's page on the Desk from its sidebar right-click menu", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.contextMenu(document.querySelector(".sidebar .sb-header")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Desk" }));
    expect(await screen.findByRole("region", { name: "Project acme-api" })).toBeInTheDocument();
    expect(within(desk()!).getByRole("region", { name: "Where things stand" })).toBeInTheDocument();
  });

  it("goes back to the Desk from a chat opened from it, but not from one left by the Desk's own button", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    const table = within(desk()!).getByRole("region", { name: "Projects" });
    fireEvent.click(within(table).getByRole("button", { name: "Show the chats of acme-api" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New chat" }));
    await waitFor(() => expect(desk()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Back to the Desk" }));
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeNull());
    expect(screen.queryByRole("button", { name: "Back to the Desk" })).toBeNull();
  });

  it("goes back from a project's page to every project with the title bar's back, as the page's own link does", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.click(within(within(desk()!).getByRole("region", { name: "Projects" })).getByRole("button", { name: "acme-api" }));
    expect(screen.getByRole("region", { name: "Project acme-api" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to all projects" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Project acme-api" })).toBeNull());
    expect(within(desk()!).getByRole("region", { name: "Projects" })).toBeInTheDocument();
  });

  it("opens a project's own page, asks about that project only, and comes back to it from one of its chats", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.click(within(within(desk()!).getByRole("region", { name: "Projects" })).getByRole("button", { name: "acme-api" }));
    const page = () => screen.getByRole("region", { name: "Project acme-api" });
    expect(within(page()).getByRole("heading", { name: "acme-api" })).toBeInTheDocument();
    await openAsk();
    expect(within(ask()!).getByRole("heading", { name: "Ask about acme-api" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Ask" }));
    await waitFor(() => expect(ask()).toBeNull());
    // Its worktrees, with the Storage scan's word on each once it has scanned.
    const wts = await within(page()).findByRole("region", { name: "Worktrees" });
    fireEvent.click(await within(wts).findByRole("button", { name: "Scan now" }));
    await waitFor(() => expect(wts).toHaveTextContent("Safe to remove"));
    fireEvent.click(within(within(page()).getByRole("region", { name: "Chats" })).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(desk()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Back to the Desk" }));
    await waitFor(() => expect(page()).toBeInTheDocument());
    fireEvent.click(within(page()).getByRole("button", { name: "‹ All projects" }));
    await waitFor(() => expect(within(desk()!).getByRole("region", { name: "Projects" })).toBeInTheDocument());
    await openAsk();
    expect(within(ask()!).getByRole("heading", { name: "Ask" })).toBeInTheDocument();
  });

  const openAsk = async () => {
    if (!ask()) fireEvent.click(screen.getByRole("button", { name: /^Ask (across|about)/ }));
    return screen.findByRole("region", { name: "Ask" });
  };

  const type = async (text: string) => {
    await openAsk();
    const box = await screen.findByRole("textbox", { name: "Tell Lantern" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeDisabled());
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
  };

  it("talks back without sending anything when it is only talked to", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await type("hi there");
    const entry = await screen.findByRole("article", { name: "You on the Desk: hi there" });
    await waitFor(() => expect(entry).toHaveTextContent(/Hi! \d+ chats are open on this Desk/));
    expect(entry).not.toHaveTextContent(/Sent to|Started/);
  });

  it("sums up what came back from the chat a message went to, under the message, once", async () => {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
    // Count the summaries asked for: a redraw must not ask again.
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    let summaries = 0;
    internals.invoke = (cmd, ...rest) => {
      if (cmd === "desk_summary") summaries++;
      return invoke(cmd, ...rest);
    };
    const { default: App } = await import("./App");
    render(<App startOnDesk />);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await openAsk();
    fireEvent.click(screen.getByRole("button", { name: "Send to: Desk picks" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Send to" })).getByRole("menuitemradio", { name: /acme-api/ }));
    await type("Add retries to fetchJson");
    const entry = await screen.findByRole("article", { name: "You on the Desk: Add retries to fetchJson" });
    // The demo turn asks to run its tests on the way: allowed from the Desk, as you would.
    await waitFor(
      () => {
        const allow = screen.queryByRole("region", { name: "Needs you" }) && within(screen.getByRole("region", { name: "Needs you" })).queryByRole("button", { name: /^Allow / });
        if (allow && allow.getAttribute("aria-disabled") !== "true") fireEvent.click(allow);
        expect(within(entry).getByLabelText("What came back")).toHaveTextContent(/^Done: /);
      },
      { timeout: 40_000, interval: 300 },
    );
    const back = within(entry).getByLabelText("What came back");
    expect(within(back).getByRole("button", { name: "Show full answer" })).toBeInTheDocument();
    expect(within(back).getByRole("button", { name: "Open chat" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(summaries).toBe(1);
    // It finished while the Desk was in front of it: unread on the sidebar's timeline, until its entry opens it.
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    const timeline = () => screen.getByRole("region", { name: "Timeline" });
    // Written down by its session, for the next launch.
    const kept = () => Object.keys(JSON.parse(localStorage.getItem("chat.unreadBySession") ?? "{}"));
    await waitFor(() => expect(kept()).toHaveLength(1));
    fireEvent.click(within(timeline()).getByRole("button", { name: /, unread$/ }));
    await waitFor(() => expect(desk()).toBeNull());
    expect(within(timeline()).queryByRole("button", { name: /, unread$/ })).toBeNull();
    await waitFor(() => expect(kept()).toEqual([]));
  });

  it("sends what is typed to the chat picked in the box, and says where it went", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await openAsk();
    fireEvent.click(screen.getByRole("button", { name: "Send to: Desk picks" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Send to" })).getByRole("menuitemradio", { name: /acme-api/ }));
    await type("Add retries to fetchJson");
    const entry = await screen.findByRole("article", { name: "You on the Desk: Add retries to fetchJson" });
    await waitFor(() => expect(entry).toHaveTextContent(/Sent to/));
    // It went into the chat, as if typed there.
    fireEvent.click(within(entry).getByRole("button", { name: /New chat|Add retries/ }));
    await waitFor(() => expect(desk()).toBeNull());
    expect(await screen.findAllByText("Add retries to fetchJson")).not.toHaveLength(0);
  });

  it("answers a question about how things stand itself, from the chats about it, which it lists and opens", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await type("How is the login redirect");
    const entry = await screen.findByRole("article", { name: "You on the Desk: How is the login redirect" });
    // Laid out: the sentence that answers, then Done / Open / Blocked, each point citing a chat.
    await waitFor(() => expect(within(entry).getByText("Mostly done: retries work, one test is still red.")).toBeInTheDocument());
    expect(within(entry).getByText("Done")).toBeInTheDocument();
    expect(within(entry).getByText("Blocked")).toBeInTheDocument();
    const read = within(entry).getByRole("list", { name: "The chats it read" });
    expect(within(read).getAllByRole("button")).toHaveLength(1);
    // Nothing was sent anywhere: the Desk stays, and no chat got the question.
    expect(entry).not.toHaveTextContent(/Sent to|Started/);
  });

  it("lets the Desk start a chat for new work, in a project on the Desk", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await type("new: a dark mode for the docs");
    const entry = await screen.findByRole("article", { name: "You on the Desk: new: a dark mode for the docs" });
    await waitFor(() => expect(entry).toHaveTextContent(/Started/));
    expect(desk()).toBeInTheDocument();
  });

  it("answers \"which chat…?\" with the past chats that mention it", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await type("which chat had the oauth redirect");
    const entry = await screen.findByRole("article", { name: "You on the Desk: which chat had the oauth redirect" });
    await waitFor(() => expect(within(entry).getByText(/Chats that mention|No chat on this Desk mentions/)).toBeInTheDocument());
  });

  it("opens on the chat as before when not asked to start on the Desk", async () => {
    await launch(false);
    await screen.findByRole("button", { name: /^Permissions: / });
    expect(desk()).toBeNull();
  });
});
