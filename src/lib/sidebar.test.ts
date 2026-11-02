import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import type { Chats } from "../sessions";
import type { RecentFolder } from "../types";
import { chatInitials, compactGroups, initials, needsYou, openProjects, sidebarProjects, type ProjectOpen, type SidebarChat, type SidebarItem } from "./sidebar";

const idle = (over: Partial<State> = {}): State => ({ ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/work/lantern", ...over });
const asking = { type: "permission" as const, id: "p1", toolName: "Bash", input: {}, decision: null };
const said = (text: string) => ({ type: "user" as const, id: `u-${text}`, text });
const meta = (parent: string, name: string) => ({ parent, name, brief: "", folder: "/wt/x", branch: "b", base: "main", isolation: "worktree" as const });
const opts = { titles: {}, drafts: {}, unread: {}, pinned: {} };

const chats = (slots: Record<string, State>, over: Partial<Chats> = {}): Chats => ({ active: Object.keys(slots)[0], slots, agents: {}, ...over });

describe("openProjects", () => {
  it("groups open chats by project, and counts the ones that need you without moving them", () => {
    const open = openProjects(
      chats({
        s1: idle({ items: [said("Network tab polish")], status: "running", sessionId: "a" }),
        s2: idle({ items: [said("Fix restore mode"), asking], sessionId: "b" }),
        s3: idle({ items: [said("Other project")], folder: "/work/network-monitor" }),
      }),
      opts,
    );
    expect(Object.keys(open).sort()).toEqual(["/work/lantern", "/work/network-monitor"]);
    const lantern = open["/work/lantern"];
    // The chat working now is first; the one that needs you keeps its place by activity, with its dot saying so.
    expect(lantern.items.map((i) => [i.title, i.state])).toEqual([
      ["Network tab polish", "running"],
      ["Fix restore mode", "waiting"],
    ]);
    expect(lantern.needs).toBe(1);
    expect(lantern.target).toEqual({ slot: "s2", team: null });
    expect(lantern.sessionIds).toEqual(["a", "b"]);
    expect(open["/work/network-monitor"].needs).toBe(0);
    expect(open["/work/network-monitor"].target).toBeNull();
  });

  it("keeps the order chats were opened in when none of them has done anything yet", () => {
    const open = openProjects(chats({ s1: idle({ items: [said("one")] }), s2: idle({ items: [said("two")] }), s3: idle({ items: [said("three")] }) }), opts);
    expect(open["/work/lantern"].items.map((i) => i.title)).toEqual(["one", "two", "three"]);
  });

  describe("ordered by recent activity", () => {
    const titles = (open: ReturnType<typeof openProjects>) => open["/work/lantern"].items.map((i) => i.title);
    const sentAt = (text: string, at: number) => ({ type: "user" as const, id: `u-${text}`, text, at });
    const byTime = { ...opts, byActivity: true };

    it("lists the chat that did something last first, whatever order they were opened in", () => {
      const open = openProjects(
        chats({
          old: idle({ items: [said("old")], activityAt: 1_000 }),
          newest: idle({ items: [said("newest")], activityAt: 3_000 }),
          middle: idle({ items: [said("middle")], activityAt: 2_000 }),
        }),
        byTime,
      );
      expect(titles(open)).toEqual(["newest", "middle", "old"]);
    });

    it("moves a chat up when it does something, and a chat that needs you doesn't jump above one that did something later", () => {
      const waiting = idle({ items: [said("waiting"), asking], activityAt: 1_000 });
      const later = idle({ items: [said("later")], activityAt: 5_000 });
      expect(titles(openProjects(chats({ waiting, later }), byTime))).toEqual(["later", "waiting"]);
      expect(titles(openProjects(chats({ waiting: { ...waiting, activityAt: 9_000 }, later }), byTime))).toEqual(["waiting", "later"]);
    });

    it("puts the chats working now first, ordered by when their turn began, so working chats don't swap places as they write", () => {
      const working = (text: string, began: number, lastLine: number) => idle({ status: "running", items: [sentAt(text, began)], activityAt: lastLine });
      const idleRecently = idle({ items: [said("idle")], activityAt: 50_000 });
      const first = openProjects(chats({ idleRecently, a: working("a", 1_000, 60_000), b: working("b", 2_000, 61_000) }), byTime);
      expect(titles(first)).toEqual(["b", "a", "idle"]);
      // "a" writes another line: still behind "b", which began later.
      const second = openProjects(chats({ idleRecently, a: working("a", 1_000, 99_000), b: working("b", 2_000, 61_000) }), byTime);
      expect(titles(second)).toEqual(["b", "a", "idle"]);
    });

    it("ranks a team by its busiest or newest chat, agents included", () => {
      const open = openProjects(
        chats(
          {
            lead: idle({ items: [said("team")], orchestrator: true, activityAt: 1_000 }),
            a1: idle({ folder: "/wt/a1", items: [said("go")], activityAt: 8_000 }),
            plain: idle({ items: [said("plain")], activityAt: 5_000 }),
          },
          { agents: { a1: meta("lead", "worker") } },
        ),
        byTime,
      );
      expect(titles(open)).toEqual(["team", "plain"]);
      const quiet = openProjects(
        chats(
          {
            lead: idle({ items: [said("team")], orchestrator: true, activityAt: 1_000 }),
            a1: idle({ folder: "/wt/a1", items: [said("go")], activityAt: 2_000 }),
            plain: idle({ items: [said("plain")], activityAt: 5_000 }),
          },
          { agents: { a1: meta("lead", "worker") } },
        ),
        byTime,
      );
      expect(titles(quiet)).toEqual(["plain", "team"]);
    });
  });

  describe("without the activity order (the default)", () => {
    const titles = (open: ReturnType<typeof openProjects>) => open["/work/lantern"].items.map((i) => i.title);

    it("lists nothing for no chats, and keeps the opening order for chats that never did anything", () => {
      expect(openProjects(chats({}), opts)).toEqual({});
      expect(titles(openProjects(chats({ a: idle({ items: [said("a")] }), b: idle({ items: [said("b")] }) }), opts))).toEqual(["a", "b"]);
    });

    it("keeps a chat in its place when it does something later than the others", () => {
      const open = openProjects(chats({ old: idle({ items: [said("old")], activityAt: 1_000 }), newest: idle({ items: [said("newest")], activityAt: 9_000 }), middle: idle({ items: [said("middle")], activityAt: 2_000 }) }), opts);
      expect(titles(open)).toEqual(["old", "newest", "middle"]);
    });

    it("keeps a chat that is working now in its place too, and still counts what needs you", () => {
      const open = openProjects(chats({ idle: idle({ items: [said("idle")], activityAt: 1_000 }), working: idle({ status: "running", items: [said("working")], activityAt: 9_000 }), waiting: idle({ items: [said("waiting"), asking], activityAt: 5_000 }) }), opts);
      expect(titles(open)).toEqual(["idle", "working", "waiting"]);
      expect(open["/work/lantern"].needs).toBe(1);
    });
  });

  it("nests a team's agents under its Lead, and keeps them off the list on their own", () => {
    const open = openProjects(
      chats(
        {
          lead: idle({ items: [said("audit sweep")], orchestrator: true, sessionId: "L" }),
          a1: idle({ folder: "/wt/sec", items: [said("go")], status: "running", sessionId: "A1" }),
          a2: idle({ folder: "/wt/ui", items: [said("go")], sessionId: "A2" }),
        },
        { agents: { a1: meta("lead", "security pass"), a2: meta("lead", "ui pass") } },
      ),
      { ...opts, unread: { a2: 1 } },
    );
    expect(Object.keys(open)).toEqual(["/work/lantern"]);
    const [team, ...rest] = open["/work/lantern"].items;
    expect(rest).toEqual([]);
    expect(team.kind).toBe("team");
    if (team.kind !== "team") return;
    expect(team.title).toBe("audit sweep");
    expect(team.agents.map((a) => [a.title, a.state, a.unread])).toEqual([
      ["security pass", "running", false],
      ["ui pass", "done", true],
    ]);
    // The team shows as working while an agent works, and as unread when one finished unseen.
    expect(team.state).toBe("running");
    expect(team.unread).toBe(true);
    expect(open["/work/lantern"].sessionIds).toEqual(["L", "A1", "A2"]);
  });

  it("counts an agent that needs you toward its project, and says where to go to answer it", () => {
    const open = openProjects(
      chats(
        { lead: idle({ items: [said("sweep")], orchestrator: true }), a1: idle({ folder: "/wt/sec", items: [asking] }), plain: idle({ items: [said("plain")] }) },
        { agents: { a1: meta("lead", "security pass") } },
      ),
      opts,
    );
    const project = open["/work/lantern"];
    expect(project.needs).toBe(1);
    expect(project.target).toEqual({ slot: "a1", team: "lead" });
    // The team is first as the older of two untouched chats, and its dot says it needs you.
    expect(project.items.map((i) => [i.kind, i.state])).toEqual([
      ["team", "waiting"],
      ["chat", "done"],
    ]);
  });

  it("calls an empty Lead a new team, lists no chat without a folder, and marks pinned chats", () => {
    const open = openProjects(
      chats({ s1: idle({ items: [said("current")], sessionId: "c" }), lead: idle({ orchestrator: true }), blank: idle({ folder: null }), s4: idle({ items: [said("done one")], sessionId: "d" }), s5: idle({ items: [said("running")], status: "running" }) }),
      { ...opts, byActivity: true, pinned: { "/work/lantern": ["d"] }, drafts: { s5: "" } },
    );
    const items = open["/work/lantern"].items;
    // The chat working now comes first; the rest keep the order they were opened in, none of them having done anything.
    expect(items.map((i) => i.title)).toEqual(["running", "current", "New team", "done one"]);
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle["done one"]).toMatchObject({ pinned: true, active: false });
    expect(byTitle["current"]).toMatchObject({ active: true, pinned: false });
  });

  it("uses a chat's title once one is made, and an unsent draft is a draft", () => {
    const open = openProjects(chats({ s1: idle({ items: [said("raw first prompt")], sessionId: "x" }), s2: idle({ items: [said("typing")] }) }), { ...opts, titles: { x: "Named chat" }, drafts: { s2: "half a message" } });
    expect(open["/work/lantern"].items.map((i) => [i.title, i.state])).toEqual([
      ["Named chat", "done"],
      ["typing", "draft"],
    ]);
  });
});

describe("sidebarProjects", () => {
  const recent = [
    { path: "/work/network-monitor", updated_ms: 5 },
    { path: "/work/lantern", updated_ms: 4 },
    { path: "/work/lumiform-ios", updated_ms: 3 },
    { path: "/work/old", updated_ms: 2 },
  ];
  const project = (folder: string, state = idle({ folder, items: [said("x")] })) => openProjects(chats({ [folder]: state }), opts)[folder];

  it("puts projects with an open chat first, in the order of the recent list, then the other recent folders", () => {
    const projects = sidebarProjects({ recent, hidden: [], open: { "/work/lumiform-ios": project("/work/lumiform-ios"), "/work/lantern": project("/work/lantern") } });
    expect(projects.map((p) => [p.label, p.hasOpen])).toEqual([
      ["lantern", true],
      ["lumiform-ios", true],
      ["network-monitor", false],
      ["old", false],
    ]);
  });

  it("lists a project that isn't in the recents yet ahead of the rest", () => {
    const projects = sidebarProjects({ recent, hidden: [], open: { "/work/new-one": project("/work/new-one"), "/work/lantern": project("/work/lantern") } });
    expect(projects.map((p) => p.label).slice(0, 2)).toEqual(["new-one", "lantern"]);
  });

  it("hides a removed project unless a chat is open in it", () => {
    const hidden = ["/work/old", "/work/lantern"];
    const without = sidebarProjects({ recent, hidden, open: {} });
    expect(without.map((p) => p.label)).toEqual(["network-monitor", "lumiform-ios"]);
    const withChat = sidebarProjects({ recent, hidden, open: { "/work/lantern": project("/work/lantern") } });
    expect(withChat[0].label).toBe("lantern");
  });

  it("tells two projects with the same folder name apart by their parent", () => {
    const projects = sidebarProjects({ recent: [{ path: "/a/web", updated_ms: 2 }, { path: "/b/web", updated_ms: 1 }, { path: "/c/api", updated_ms: 0 }], hidden: [], open: {} });
    expect(projects.map((p) => p.label)).toEqual(["web · a", "web · b", "api"]);
  });

  it("carries the needs-you count and where to go for a collapsed project's badge", () => {
    const [p] = sidebarProjects({ recent, hidden: [], open: { "/work/lantern": project("/work/lantern", idle({ items: [said("q"), asking] })) } });
    expect(p.needs).toBe(1);
    expect(p.target).toEqual({ slot: "/work/lantern", team: null });
  });
});

describe("needsYou", () => {
  it("adds up what waits on you in every project, chats and agents alike", () => {
    const waiting = (needs: number) => ({ items: [], sessionIds: [], needs, target: null });
    expect(needsYou({})).toBe(0);
    expect(needsYou({ "/a": waiting(2), "/b": waiting(0), "/c": waiting(1) })).toBe(3);
  });
});

describe("initials", () => {
  it("takes the first letters of the first two words, skipping filler, or the first letter(s) of a single word", () => {
    expect(initials("lantern")).toBe("L");
    expect(initials("lantern", 2)).toBe("LA");
    expect(initials("network-monitor", 2)).toBe("NM");
    expect(initials("lumiform_ios app")).toBe("LI");
    expect(initials("acme-api · projects", 2)).toBe("AA");
    expect(initials("Retry transient fetch errors")).toBe("RT");
    expect(initials("ask me first")).toBe("AM");
    expect(initials("Fix the login redirect")).toBe("FL");
    expect(initials("Add a retry to fetchJson")).toBe("AR");
    expect(initials("the")).toBe("T");
    expect(initials("")).toBe("?");
  });

  it("calls a chat or team with no title yet N", () => {
    expect(chatInitials("New chat")).toBe("N");
    expect(chatInitials("New team")).toBe("N");
    expect(chatInitials("Network tab polish")).toBe("NT");
  });
});

describe("compactGroups", () => {
  const item = (slot: string, over: Partial<SidebarChat> = {}): SidebarChat => ({ slot, title: slot, state: "done", unread: false, background: 0, sessionId: null, active: false, pinned: false, ...over });
  const chatItem = (slot: string, over: Partial<SidebarChat> = {}): SidebarItem => ({ kind: "chat", ...item(slot, over) });
  const open = (items: SidebarItem[]): ProjectOpen => ({ items, sessionIds: [], needs: 0, target: null });

  it("lists the open projects in the recent list's order with a chip for each chat, and a team once (its Lead)", () => {
    const groups = compactGroups(
      {
        "/work/lantern": open([chatItem("a", { state: "running" }), { kind: "team", ...item("lead", { state: "waiting" }), agents: [item("w1", { active: true })] }]),
        "/work/network-monitor": open([chatItem("b", { unread: true })]),
        "/work/empty": open([]),
      },
      [{ path: "/work/network-monitor", updated_ms: 2 }, { path: "/work/lantern", updated_ms: 1 }] satisfies RecentFolder[],
    );
    expect(groups.map((g) => [g.label, g.initials, g.chips.map((c) => c.slot)])).toEqual([
      ["network-monitor", "NM", ["b"]],
      ["lantern", "LA", ["a", "lead"]],
    ]);
    const [monitor, lantern] = groups;
    expect(monitor.chips[0]).toMatchObject({ team: false, status: "Unread" });
    expect(lantern.chips.map((c) => [c.team, c.status, c.active])).toEqual([
      [false, "Working", false],
      // The team is lit while one of its agents is the one on screen.
      [true, "Needs you", true],
    ]);
  });

  it("tells two projects of one name apart by their parent folder", () => {
    const groups = compactGroups({ "/a/app": open([chatItem("x")]), "/b/app": open([chatItem("y")]) }, []);
    expect(groups.map((g) => g.label).sort()).toEqual(["app · a", "app · b"]);
    expect(groups.every((g) => g.initials === "AP")).toBe(true);
  });
});
