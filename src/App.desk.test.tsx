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
    expect(within(desk()!).getByText(/Nothing here yet/)).toBeInTheDocument();
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

  it("sends what is typed to the chat picked in the box, and says where it went", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    const to = screen.getByRole("combobox", { name: "Send to" });
    const chat = within(to).getAllByRole("option").find((o) => o.textContent?.includes("acme-api"))!;
    fireEvent.change(to, { target: { value: (chat as HTMLOptionElement).value } });
    await type("Add retries to fetchJson");
    const entry = await screen.findByRole("article", { name: "You on the Desk: Add retries to fetchJson" });
    await waitFor(() => expect(entry).toHaveTextContent(/sent to/));
    // It went into the chat, as if typed there.
    fireEvent.click(within(entry).getByRole("button", { name: /New chat|Add retries/ }));
    await waitFor(() => expect(desk()).toBeNull());
    expect(await screen.findAllByText("Add retries to fetchJson")).not.toHaveLength(0);
  });

  it("lets the Desk start a chat for new work, in a project on the Desk", async () => {
    await launch(true);
    await waitFor(() => expect(desk()).toBeInTheDocument());
    await type("new: a dark mode for the docs");
    const entry = await screen.findByRole("article", { name: "You on the Desk: new: a dark mode for the docs" });
    await waitFor(() => expect(entry).toHaveTextContent(/started/));
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
