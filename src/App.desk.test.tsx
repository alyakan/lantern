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

  it("opens on the chat as before when not asked to start on the Desk", async () => {
    await launch(false);
    await screen.findByRole("button", { name: /^Permissions: / });
    expect(desk()).toBeNull();
  });
});
