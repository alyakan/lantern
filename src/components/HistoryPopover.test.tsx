import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HistoryPopover } from "./HistoryPopover";
import type { SessionActions } from "../lib/sessionActions";
import type { ChatHit, ChatSearchResults } from "../types";

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

  describe("searching what was said", () => {
    const hit = (id: string, title: string, over: Partial<ChatHit> = {}): ChatHit => ({
      id,
      title: [{ text: title, hit: false }],
      folder: ACME,
      project: "acme-api",
      updated_ms: Date.now() - 3_600_000,
      snippets: [{ role: "user", pieces: [{ text: "fix the ", hit: false }, { text: "redirect", hit: true }, { text: " after login", hit: false }] }],
      ...over,
    });
    const found = (chats: ChatHit[], partial = false): ChatSearchResults => ({ chats, partial, cancelled: false });
    const box = () => screen.getByRole("textbox", { name: "Search chats" });
    const type = (value: string) => fireEvent.change(box(), { target: { value } });

    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());
    const wait = (ms = 250) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

    it("looks for the text after a short pause, from two characters, and lists the chats with the match marked", async () => {
      const search = vi.fn().mockResolvedValue(found([hit("a", "Fix the login redirect", { title: [{ text: "Fix the login ", hit: false }, { text: "redirect", hit: true }] })]));
      setup({ search });
      await screen.findByText("Fix the login redirect", { exact: false });
      type("r");
      await wait();
      expect(search).not.toHaveBeenCalled();
      type("re");
      type("redirect");
      expect(search).not.toHaveBeenCalled();
      expect(screen.getByText("Searching…")).toBeInTheDocument();
      await wait();
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith("redirect");
      const list = await screen.findByRole("list", { name: "Chats that mention that" });
      expect(within(list).getAllByText("redirect").map((m) => m.tagName)).toEqual(["MARK", "MARK"]);
      expect(within(list).getByText("You")).toBeInTheDocument();
      expect(within(list).getByText(/acme-api · /)).toBeInTheDocument();
      // The projects' own lists are replaced while a search is shown.
      expect(screen.queryByRole("region", { name: "acme-api" })).toBeNull();
    });

    it("shows what a chat said as text, never as markup", async () => {
      const search = vi.fn().mockResolvedValue(found([hit("a", "t", { snippets: [{ role: "assistant", pieces: [{ text: "<img src=x onerror=alert(1)> ", hit: false }, { text: "<b>", hit: true }] }] })]));
      setup({ search });
      type("<b>");
      await wait();
      const list = await screen.findByRole("list", { name: "Chats that mention that" });
      expect(list.querySelector("img")).toBeNull();
      expect(list.querySelector("b")).toBeNull();
      expect(within(list).getByText("<b>").tagName).toBe("MARK");
      expect(within(list).getByText("Claude")).toBeInTheDocument();
    });

    it("says so when no chat mentions it, while it searches, and when it failed", async () => {
      let release: (r: ChatSearchResults) => void = () => {};
      const search = vi.fn().mockImplementationOnce(() => new Promise((r) => (release = r))).mockRejectedValueOnce("boom");
      setup({ search });
      type("nothing here");
      await wait();
      expect(screen.getByText("Searching…")).toBeInTheDocument();
      await act(async () => release(found([])));
      expect(screen.getByText("No chat mentions that")).toBeInTheDocument();
      type("something else");
      await wait();
      expect(await screen.findByText("The search didn't work. Try again.")).toBeInTheDocument();
    });

    it("says it shows the first results when the search stopped early", async () => {
      setup({ search: vi.fn().mockResolvedValue(found([hit("a", "Fix the login redirect")], true)) });
      type("redirect");
      await wait();
      expect(await screen.findByText("Showing the first results")).toBeInTheDocument();
    });

    it("ignores the answer to an older search", async () => {
      const answers: ((r: ChatSearchResults) => void)[] = [];
      const search = vi.fn(() => new Promise<ChatSearchResults>((r) => answers.push(r)));
      setup({ search });
      type("first query");
      await wait();
      type("second query");
      await wait();
      expect(search).toHaveBeenCalledTimes(2);
      await act(async () => answers[1](found([hit("new", "The new answer")])));
      await act(async () => answers[0](found([hit("old", "The old answer")])));
      expect(screen.getByText("The new answer")).toBeInTheDocument();
      expect(screen.queryByText("The old answer")).toBeNull();
    });

    it("ignores an answer that says a newer search replaced it", async () => {
      setup({ search: vi.fn().mockResolvedValue({ chats: [hit("a", "Stale")], partial: false, cancelled: true }) });
      type("redirect");
      await wait();
      expect(screen.getByText("Searching…")).toBeInTheDocument();
      expect(screen.queryByText("Stale")).toBeNull();
    });

    it("opens a chat in its own project with a click, with Enter in the box (the first), and with ↓ then Enter on another", async () => {
      const chats = [hit("a", "First chat"), hit("b", "Second chat", { folder: WEB })];
      const p = setup({ search: vi.fn().mockResolvedValue(found(chats)) });
      type("redirect");
      await wait();
      await screen.findByText("Second chat");
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(p.onOpen).toHaveBeenLastCalledWith("a", ACME);
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(screen.getByTitle("Second chat"));
      fireEvent.click(document.activeElement!);
      expect(p.onOpen).toHaveBeenLastCalledWith("b", WEB);
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(box());
    });

    it("keeps to the project chosen with the chip", async () => {
      setup({ search: vi.fn().mockResolvedValue(found([hit("a", "First chat"), hit("b", "Second chat", { folder: WEB })])), initial: WEB });
      type("redirect");
      await wait();
      expect(await screen.findByText("Second chat")).toBeInTheDocument();
      expect(screen.queryByText("First chat")).toBeNull();
    });

    it("clears the search on Escape, and closes on the next one", async () => {
      const p = setup({ search: vi.fn().mockResolvedValue(found([hit("a", "First chat")])) });
      type("redirect");
      await wait();
      await screen.findByText("First chat");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(box()).toHaveValue("");
      expect(p.onClose).not.toHaveBeenCalled();
      expect(await screen.findByRole("region", { name: "acme-api" })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(p.onClose).toHaveBeenCalledTimes(1);
    });

    it("only filters titles when it has no search to ask", async () => {
      setup();
      type("redirect");
      await wait();
      expect(screen.queryByText("Searching…")).toBeNull();
    });
  });
});
