import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const claudeLogin = vi.fn((_path: string) => Promise.resolve({ logged_in: true, account: "sam@acme.dev" as string | null }));
vi.mock("../api", () => ({ api: { claudeLogin: (path: string) => claudeLogin(path) } }));

import { RECENTS_SHOWN, Welcome } from "./Welcome";

const HOUR = 3_600_000;
const recent = (names: string[]) => names.map((n, i) => ({ path: `/Users/you/projects/${n}`, updated_ms: Date.now() - (i + 1) * HOUR }));
const welcome = (extra: Partial<Parameters<typeof Welcome>[0]> = {}) => {
  const props = { claudePath: "/bin/claude", loadRecent: () => Promise.resolve(recent(["acme-api", "web-dashboard"])), skip: [], onOpenFolder: vi.fn(), onPick: vi.fn(), ...extra };
  return { props, ...render(<Welcome {...props} />) };
};

beforeEach(() => claudeLogin.mockClear());

describe("the first-launch screen", () => {
  it("has one primary button, Open folder…", () => {
    const { props } = welcome();
    const buttons = screen.getAllByRole("button", { name: /Open folder/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveClass("primary");
    fireEvent.click(buttons[0]);
    expect(props.onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("shows recent projects as cards with their name, where they are and when they were last used, and opens one on a click", async () => {
    const { props } = welcome();
    const card = await screen.findByRole("button", { name: /acme-api/ });
    expect(within(card).getByText("acme-api")).toBeInTheDocument();
    expect(within(card).getByText("/Users/you/projects")).toBeInTheDocument();
    expect(within(card).getByText("Last used 1h ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /web-dashboard/ })).toHaveTextContent("Last used 2h ago");
    fireEvent.click(card);
    expect(props.onPick).toHaveBeenCalledWith("/Users/you/projects/acme-api");
  });

  it("leaves out folders the user removed or that moved, and shows no more than it has room for", async () => {
    welcome({ loadRecent: () => Promise.resolve(recent(["a", "b", "c", "d", "e", "f", "g", "h"])), skip: ["/Users/you/projects/b"] });
    await screen.findByRole("button", { name: /^a/ });
    const cards = screen.getByRole("region", { name: "Recent projects" }).querySelectorAll(".welcome-card");
    expect(cards).toHaveLength(RECENTS_SHOWN);
    expect(screen.queryByRole("button", { name: /^b\b/ })).toBeNull();
  });

  it("has no Recent projects heading when there are none", async () => {
    welcome({ loadRecent: () => Promise.resolve([]) });
    await screen.findByText("Claude Code is installed and signed in as sam@acme.dev");
    expect(screen.queryByRole("region", { name: "Recent projects" })).toBeNull();
  });
});

describe("the claude check", () => {
  it("says claude is installed and who is signed in", async () => {
    welcome();
    expect(await screen.findByText("Claude Code is installed and signed in as sam@acme.dev")).toBeInTheDocument();
    expect(claudeLogin).toHaveBeenCalledWith("/bin/claude");
  });

  it("says plainly that claude isn't signed in, and how to fix it, and checks again on request", async () => {
    claudeLogin.mockResolvedValueOnce({ logged_in: false, account: null });
    welcome();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Claude Code is installed, but you're not signed in.");
    expect(alert).toHaveTextContent("run claude and type /login");
    fireEvent.click(within(alert).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Claude Code is installed and signed in as sam@acme.dev")).toBeInTheDocument();
    expect(claudeLogin).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet about signing in when claude can't say", async () => {
    claudeLogin.mockRejectedValueOnce("too old");
    welcome();
    expect(await screen.findByText("Claude Code is installed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows what comes above it, such as chats offered back", () => {
    welcome({ children: <p>Pick up where you left off</p> });
    expect(screen.getByText("Pick up where you left off")).toBeInTheDocument();
  });
});
