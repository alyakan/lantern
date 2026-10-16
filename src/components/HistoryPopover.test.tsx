import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HistoryPopover } from "./HistoryPopover";
import type { SessionActions } from "../lib/sessionActions";

const ACME = "/work/acme-api";
const WEB = "/work/web-dashboard";
const INFRA = "/work/infra";

const sessions: Record<string, { id: string; title: string; updated_ms: number; prompts: number }[]> = {
  [ACME]: [
    { id: "a", title: "Add retries to fetchJson", updated_ms: Date.now() - 60_000, prompts: 3 },
    { id: "b", title: "Fix the login redirect", updated_ms: Date.now() - 3_600_000, prompts: 1 },
    { id: "c", title: "Old pinned notes", updated_ms: Date.now() - 9 * 86_400_000, prompts: 1 },
  ],
  [WEB]: [{ id: "w", title: "Chart tooltips clip at the edge", updated_ms: Date.now() - 7_200_000, prompts: 2 }],
  [INFRA]: [],
};
const projects = [
  { folder: ACME, label: "acme-api" },
  { folder: WEB, label: "web-dashboard" },
  { folder: INFRA, label: "infra" },
];

function setup(over: Partial<React.ComponentProps<typeof HistoryPopover>> = {}) {
  const props: React.ComponentProps<typeof HistoryPopover> = {
    projects,
    exclude: [],
    load: vi.fn(async (folder: string) => sessions[folder]),
    loadOld: vi.fn().mockResolvedValue([]),
    actionsFor: vi.fn(() => null),
    onBring: vi.fn(),
    onNewChat: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<HistoryPopover {...props} />);
  return props;
}

const group = (name: string) => screen.getByRole("region", { name });

describe("History", () => {
  it("reads every project's past chats when it opens, lists them grouped by project in the given order, and opens a pick in its project", async () => {
    const p = setup();
    expect(await screen.findByText("Fix the login redirect")).toBeInTheDocument();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["acme-api", "web-dashboard", "infra"]);
    expect(p.load).toHaveBeenCalledTimes(3);
    expect(within(group("web-dashboard")).getByText("Chart tooltips clip at the edge")).toBeInTheDocument();
    fireEvent.click(within(group("web-dashboard")).getByText("Chart tooltips clip at the edge"));
    expect(p.onOpen).toHaveBeenCalledWith("w", WEB);
    fireEvent.click(screen.getByText("Fix the login redirect"));
    expect(p.onOpen).toHaveBeenLastCalledWith("b", ACME);
  });

  it("lists a project's chats newest first, its pinned ones before them", async () => {
    const actionsFor = (folder: string): SessionActions | null => (folder === ACME ? { folder, pinned: ["c"], onTogglePin: () => {}, onRename: async () => {}, onExport: () => {} } : null);
    setup({ actionsFor });
    await screen.findByText("Fix the login redirect");
    expect(Array.from(group("acme-api").querySelectorAll(".session-row > .menu-row")).map((b) => b.getAttribute("title"))).toEqual(["Old pinned notes", "Add retries to fetchJson", "Fix the login redirect"]);
  });

  it("lists past chats only: the ones open (in the sidebar) are left out", async () => {
    setup({ exclude: ["a"] });
    expect(await screen.findByText("Fix the login redirect")).toBeInTheDocument();
    expect(screen.queryByText("Add retries to fetchJson")).toBeNull();
    expect(screen.queryByText("Open chats")).toBeNull();
  });

  it("searches across all the projects", async () => {
    setup();
    await screen.findByText("Fix the login redirect");
    fireEvent.change(screen.getByPlaceholderText("Search chats"), { target: { value: "tooltips" } });
    expect(screen.getByText("Chart tooltips clip at the edge")).toBeInTheDocument();
    expect(screen.queryByText("Fix the login redirect")).toBeNull();
    // A project with nothing that matches has no group while searching.
    expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search chats"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching chats")).toBeInTheDocument();
  });

  it("filters to one project with its chip, and starts filtered to the one it was opened for", async () => {
    setup();
    await screen.findByText("Fix the login redirect");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: WEB } });
    expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull();
    expect(screen.getByText("Chart tooltips clip at the edge")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "" } });
    expect(screen.getByRole("region", { name: "acme-api" })).toBeInTheDocument();
  });

  it("starts filtered to the project it was opened for", async () => {
    setup({ initial: WEB });
    expect(await screen.findByText("Chart tooltips clip at the edge")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(WEB);
    expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull();
  });

  it("starts a chat in any project from its header's +, even one with no past chats", async () => {
    const p = setup();
    await screen.findByText("Fix the login redirect");
    fireEvent.click(within(group("infra")).getByRole("button", { name: "New chat in infra" }));
    expect(p.onNewChat).toHaveBeenCalledWith(INFRA);
  });

  it("offers the old chats of a moved project when filtered to it, only when some aren't brought over", async () => {
    const p = setup({
      loadOld: vi.fn().mockResolvedValue([
        { path: "/old/acme-api", exists: true, sessions: 7, updated_ms: 1, already: false },
        { path: "/src/acme-api", exists: true, sessions: 4, updated_ms: 1, already: true },
      ]),
    });
    await screen.findByText("Fix the login redirect");
    expect(screen.queryByText(/from before you moved/)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: ACME } });
    fireEvent.click(await screen.findByRole("button", { name: "7 chats from before you moved this project: Bring them here" }));
    expect(p.onBring).toHaveBeenCalledWith(ACME);
  });

  it("moves between the search box and the chats with ↑ and ↓", async () => {
    setup();
    await screen.findByText("Fix the login redirect");
    const search = screen.getByPlaceholderText("Search chats");
    search.focus();
    const rows = () => screen.getAllByRole("button", { name: /ago$/ });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
  });

  it("opens with the search box focused, and closes on Escape and on a press outside it, but not on its own button", async () => {
    const p = setup();
    await screen.findByText("Fix the login redirect");
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search chats"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(p.onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByPlaceholderText("Search chats"));
    expect(p.onClose).toHaveBeenCalledTimes(2);
    const toggle = document.body.appendChild(document.createElement("button"));
    toggle.setAttribute("data-history-toggle", "");
    fireEvent.mouseDown(toggle);
    expect(p.onClose).toHaveBeenCalledTimes(2);
    toggle.remove();
  });

  it("says so when no project has a past chat, or the chats can't be read", async () => {
    const { unmount } = render(<div />);
    unmount();
    setup({ load: vi.fn().mockRejectedValue("nope") });
    await waitFor(() => expect(screen.getByText("No past chats")).toBeInTheDocument());
  });

  it("shows Loading… until the projects are read, and each project as soon as it is", async () => {
    let release: (list: typeof sessions[string]) => void = () => {};
    const load = vi.fn((folder: string) => (folder === WEB ? new Promise<typeof sessions[string]>((r) => (release = r)) : Promise.resolve(sessions[folder])));
    setup({ load });
    expect(await screen.findByText("Fix the login redirect")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await act(async () => release(sessions[WEB]));
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("Chart tooltips clip at the edge")).toBeInTheDocument();
  });
});
