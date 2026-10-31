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
    expect(within(desk()!).getByText(/Nothing asked here yet/)).toBeInTheDocument();
    // The inbox lists the chat that is open, and the table its project.
    expect(within(screen.getByRole("complementary", { name: "Inbox" })).getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByRole("button", { name: "acme-api" })).toBeInTheDocument();
    fireEvent.click(within(await screen.findByRole("region", { name: "acme-api" })).getByTitle("New chat"));
    await waitFor(() => expect(desk()).toBeNull());
    expect(deskButton()).toHaveAttribute("aria-pressed", "false");
    // Its button brings it back, and puts it away again.
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeInTheDocument());
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeNull());
  });

  const type = async (text: string) => {
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
    const to = screen.getByRole("combobox", { name: "Send to" });
    const chat = within(to).getAllByRole("option").find((o) => o.textContent?.includes("acme-api"))!;
    fireEvent.change(to, { target: { value: (chat as HTMLOptionElement).value } });
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
    // It finished while the Desk was in front of it: unread in the inbox, until its row opens it.
    const row = within(screen.getByRole("complementary", { name: "Inbox" })).getByRole("button", { name: /, unread$/ });
    fireEvent.click(row);
    await waitFor(() => expect(desk()).toBeNull());
    fireEvent.click(deskButton());
    await waitFor(() => expect(desk()).toBeInTheDocument());
    expect(within(screen.getByRole("complementary", { name: "Inbox" })).queryByRole("button", { name: /, unread$/ })).toBeNull();
  });

  it("sends what is typed to the chat picked in the box, and says where it went", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    const to = screen.getByRole("combobox", { name: "Send to" });
    const chat = within(to).getAllByRole("option").find((o) => o.textContent?.includes("acme-api"))!;
    fireEvent.change(to, { target: { value: (chat as HTMLOptionElement).value } });
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
