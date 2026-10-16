import { describe, expect, it } from "vitest";
import { initialState, type MergeProposal, type State } from "../store";
import type { Chats } from "../sessions";
import { checkItems, inboxItems, wholeRequest } from "./inbox";
import { openProjects } from "./sidebar";

const idle = (over: Partial<State> = {}): State => ({ ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/work/lantern", ...over });
const said = (text: string) => ({ type: "user" as const, id: `u-${text}`, text });
const asks = (id: string, at: number, toolName = "Bash", input: unknown = { command: "npm test" }) => ({ type: "permission" as const, id, toolName, input, decision: null, at });
const reply = (text: string) => [{ type: "assistant" as const, id: "a1", text }, { type: "turn" as const, id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 }];
const meta = (parent: string, name: string) => ({ parent, name, brief: "", folder: "/wt/x", branch: "b", base: "main", isolation: "worktree" as const });
const proposal = (worker: string, at: number): MergeProposal => ({ worker, name: worker, branch: `agent/${worker}`, into: "main", summary: "", commits: 2, files: [], uncommitted: 0, loose: [], status: "open", problem: null, attempts: 0, at });
const describe_ = (input: unknown) => (input as { command?: string }).command ?? "";

const list = (chats: Chats, unread: Record<string, number> = {}) => inboxItems(chats, openProjects(chats, { titles: {}, drafts: {}, unread, pinned: {} }), { unread, describe: describe_ });
const chats = (slots: Record<string, State>, over: Partial<Chats> = {}): Chats => ({ active: Object.keys(slots)[0], slots, agents: {}, ...over });

describe("inboxItems", () => {
  it("is empty when nothing waits", () => {
    expect(list(chats({ s1: idle({ items: [said("hi")] }) }))).toEqual([]);
  });

  it("lists a permission request with its project, what it wants and since when, answerable in place", () => {
    const [row] = list(chats({ s1: idle({ items: [said("Fix the build"), asks("p1", 100)] }) }));
    expect(row).toMatchObject({ kind: "permission", slot: "s1", role: "chat", team: null, title: "Fix the build", where: "lantern", need: "Wants to use Bash", detail: "npm test", canAllow: true, since: 100, requestId: "p1", needsYou: true });
  });

  it("names a question or a plan as such and leaves it to its own card (no request to allow)", () => {
    const rows = list(
      chats({
        s1: idle({ items: [said("one"), asks("q", 1, "AskUserQuestion", { questions: [{ question: "Which database?", header: "DB", options: [], multiSelect: false }] })] }),
        s2: idle({ items: [said("two"), asks("pl", 2, "ExitPlanMode", { plan: "Step one" })] }),
      }),
    );
    expect(rows.map((r) => [r.kind, r.requestId, r.need])).toEqual([
      ["question", null, "Question: Which database?"],
      ["plan", null, "Plan ready for review: Step one"],
    ]);
  });

  it("counts a second pending request in the same chat", () => {
    const [row] = list(chats({ s1: idle({ items: [said("x"), asks("p1", 5), asks("p2", 6)] }) }));
    expect(row.need).toBe("Wants to use Bash (+1 more)");
  });

  it("puts what needs you before what only finished, each oldest first", () => {
    const rows = list(
      chats({
        s1: idle({ items: [said("finished late"), ...reply("Done it")] }),
        s2: idle({ items: [said("asked late"), asks("a", 300)] }),
        s3: idle({ items: [said("finished early"), ...reply("All good")] }),
        s4: idle({ items: [said("asked early"), asks("b", 200)] }),
      }),
      { s1: 900, s3: 800 },
    );
    expect(rows.map((r) => [r.title, r.needsYou])).toEqual([
      ["asked early", true],
      ["asked late", true],
      ["finished early", false],
      ["finished late", false],
    ]);
    expect(rows[2]).toMatchObject({ kind: "unread", need: "Finished: All good", since: 800, requestId: null });
  });

  it("ignores an unread mark on a chat that has since started working again", () => {
    expect(list(chats({ s1: idle({ items: [said("x")], status: "running" }) }), { s1: 5 })).toEqual([]);
  });

  it("lists a team's agents under the team's name, with merges to approve", () => {
    const rows = list(
      chats(
        {
          lead: idle({ orchestrator: true, items: [said("Ship it")], proposals: [proposal("a2", 50)] }),
          a1: idle({ folder: "/wt/a", items: [said("go"), asks("p9", 70)] }),
          a2: idle({ folder: "/wt/b", items: [said("go")] }),
        },
        { agents: { a1: meta("lead", "security pass"), a2: meta("lead", "ui pass") } },
      ),
    );
    expect(rows.map((r) => [r.title, r.role, r.team, r.kind, r.where])).toEqual([
      ["ui pass", "agent", "lead", "merge", "lantern · Ship it"],
      ["security pass", "agent", "lead", "permission", "lantern · Ship it"],
    ]);
    expect(rows[0].need).toBe("Ready to merge agent/a2 into main");
  });

  it("tells projects with the same name apart and covers every project", () => {
    const rows = list(
      chats({
        s1: idle({ folder: "/a/app", items: [said("one"), asks("p1", 1)] }),
        s2: idle({ folder: "/b/app", items: [said("two"), asks("p2", 2)] }),
      }),
    );
    expect(rows.map((r) => r.where)).toEqual(["app · a", "app · b"]);
  });

  it("agrees with the sidebar's count of what needs you", () => {
    const c = chats(
      {
        lead: idle({ orchestrator: true, items: [said("Ship it")], proposals: [proposal("a2", 50)] }),
        a1: idle({ folder: "/wt/a", items: [said("go"), asks("p9", 70)] }),
        a2: idle({ folder: "/wt/b", items: [said("go")] }),
        s2: idle({ items: [said("plain"), asks("p3", 1)] }),
      },
      { agents: { a1: meta("lead", "security pass"), a2: meta("lead", "ui pass") } },
    );
    const open = openProjects(c, { titles: {}, drafts: {}, unread: {}, pinned: {} });
    const needs = Object.values(open).reduce((n, p) => n + p.needs, 0);
    expect(list(c).filter((r) => r.needsYou)).toHaveLength(needs);
  });
});

describe("agents that have gone quiet", () => {
  const NOW = 10_000_000;
  const AFTER = 180_000;
  const quiet = (c: Chats) => inboxItems(c, openProjects(c, { titles: {}, drafts: {}, unread: {}, pinned: {} }), { unread: {}, describe: describe_, quiet: { now: NOW, after: AFTER } });
  const team = (worker: Partial<State>, lead: Partial<State> = {}) =>
    chats(
      { lead: idle({ orchestrator: true, items: [said("Ship it")], ...lead }), a1: idle({ folder: "/wt/a", items: [said("go")], status: "running", ...worker }) },
      { agents: { a1: meta("lead", "security pass") } },
    );

  it("lists a team's agent that has worked a while without a word, with how long it has been", () => {
    const [row] = quiet(team({ activityAt: NOW - 4 * 60_000 }));
    expect(row).toMatchObject({ kind: "quiet", slot: "a1", role: "agent", team: "lead", title: "security pass", where: "lantern · Ship it", since: NOW - 4 * 60_000, needsYou: true, requestId: null, canAllow: false });
    expect(row.need).toMatch(/Quiet while working/);
  });

  it("lists a Lead too", () => {
    const rows = quiet(team({ status: "idle" }, { status: "running", activityAt: NOW - AFTER }));
    expect(rows.map((r) => [r.slot, r.role, r.kind])).toEqual([["lead", "lead", "quiet"]]);
  });

  it("does not list one that is only thinking, has been heard from, or isn't working", () => {
    expect(quiet(team({ activityAt: NOW - AFTER + 1_000 }))).toEqual([]);
    expect(quiet(team({ activityAt: null }))).toEqual([]);
    expect(quiet(team({ activityAt: NOW - 10 * 60_000, status: "idle" }))).toEqual([]);
  });

  it("does not list a plain chat, which may sit on one long command", () => {
    expect(quiet(chats({ s1: idle({ status: "running", items: [said("build"), ], activityAt: NOW - 20 * 60_000 }) }))).toEqual([]);
  });

  it("lists what it is waiting on instead when it is waiting on you", () => {
    const [row] = quiet(team({ activityAt: NOW - 20 * 60_000, items: [said("go"), asks("p1", 5)] }));
    expect(row.kind).toBe("permission");
  });

  it("is not listed at all unless the caller says what counts as quiet", () => {
    expect(list(team({ activityAt: NOW - 20 * 60_000 }))).toEqual([]);
  });
});

describe("which requests Allow is offered for", () => {
  const rowFor = (toolName: string, input: unknown) => list(chats({ s1: idle({ items: [said("x"), asks("p1", 1, toolName, input)] }) }))[0];

  it("offers it for a short single-line command, and shows all of it", () => {
    const row = rowFor("Bash", { command: "git status --short" });
    expect(row).toMatchObject({ canAllow: true, detail: "git status --short", requestId: "p1" });
  });

  it("does not offer it when a command has a second line, however harmless the first looks", () => {
    const row = rowFor("Bash", { command: "npm test\nrm -rf ~" });
    expect(row).toMatchObject({ canAllow: false, detail: null, requestId: "p1" });
    expect(row.need).toBe("Wants to use Bash: npm test");
    expect(rowFor("Bash", { command: "npm test\r\nrm -rf ~" }).canAllow).toBe(false);
    expect(rowFor("Bash", { command: "npm test\u2028rm -rf ~" }).canAllow).toBe(false);
  });

  it("does not offer it for a command over 160 characters, but does at 160", () => {
    expect(rowFor("Bash", { command: `echo ${"a".repeat(155)}` }).canAllow).toBe(true);
    expect(rowFor("Bash", { command: `echo ${"a".repeat(156)}` }).canAllow).toBe(false);
  });

  it("does not offer it for text that can reorder or hide what is shown", () => {
    expect(wholeRequest("Bash", { command: "echo \u202eevil" })).toBeNull();
    expect(wholeRequest("Bash", { command: "echo a\u200bb" })).toBeNull();
  });

  it("does not offer it when the input carries something the row doesn't show", () => {
    expect(wholeRequest("Bash", { command: "ls", dangerouslyDisableSandbox: true })).toBeNull();
    expect(wholeRequest("Bash", { command: "ls", run_in_background: true })).toBeNull();
    expect(wholeRequest("Bash", { command: "ls", description: "List", timeout: 5000 })).toBe("ls");
  });

  it("does not offer it for edits, writes, MCP tools or anything unknown, which show only a path or a name", () => {
    expect(rowFor("Write", { file_path: "/work/a.ts", content: "x".repeat(50) }).canAllow).toBe(false);
    expect(rowFor("Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" }).canAllow).toBe(false);
    expect(rowFor("MultiEdit", { file_path: "/work/a.ts", edits: [] }).canAllow).toBe(false);
    expect(rowFor("NotebookEdit", { notebook_path: "/work/a.ipynb", new_source: "x" }).canAllow).toBe(false);
    expect(rowFor("mcp__github__delete_repo", { name: "app" }).canAllow).toBe(false);
    expect(rowFor("Mystery", { command: "ls" }).canAllow).toBe(false);
    // Deny is still there for all of them: the request id is kept.
    expect(rowFor("Write", { file_path: "/work/a.ts", content: "x" }).requestId).toBe("p1");
  });

  it("offers it for the read-only tools, showing all their input", () => {
    expect(rowFor("Read", { file_path: "/work/src/a.ts" })).toMatchObject({ canAllow: true, detail: "/work/src/a.ts" });
    expect(rowFor("Grep", { pattern: "TODO", path: "/work/src" })).toMatchObject({ canAllow: true, detail: "pattern: TODO\npath: /work/src" });
    expect(rowFor("Glob", { pattern: "**/*.ts" }).canAllow).toBe(true);
    expect(rowFor("LS", { path: "/work" }).canAllow).toBe(true);
    expect(rowFor("WebSearch", { query: "tauri caffeinate" }).canAllow).toBe(true);
    expect(rowFor("WebFetch", { url: "https://example.com/a", prompt: "Summarise" })).toMatchObject({ canAllow: true, detail: "url: https://example.com/a\nprompt: Summarise" });
  });

  it("does not offer it for a web address over 200 characters, or a read with an extra input", () => {
    expect(wholeRequest("WebFetch", { url: `https://example.com/${"a".repeat(190)}` })).toBeNull();
    expect(wholeRequest("Read", { file_path: "/a", extra: 1 })).toBeNull();
    expect(wholeRequest("Read", {})).toBeNull();
    expect(wholeRequest("Bash", "ls")).toBeNull();
  });

  it("does not offer it for a plan, a question or a reproduction, which have no Allow here at all", () => {
    expect(rowFor("ExitPlanMode", { plan: "x" })).toMatchObject({ canAllow: false, requestId: null });
  });
});

describe("checkItems", () => {
  it("makes a row that waits on the user for each pull request whose checks failed", () => {
    const [row, ...rest] = checkItems([{ folder: "/work/lantern", slot: "s2", where: "lantern", branch: "feat/x", number: 57, failed: 2 }]);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ key: "checks:/work/lantern", kind: "checks", slot: "s2", role: "chat", team: null, title: "Checks failed on feat/x", where: "lantern", need: "Pull request #57: 2 checks failed", needsYou: true, canAllow: false, requestId: null });
    expect(checkItems([{ folder: "/a", slot: "s", where: "a", branch: "b", number: 1, failed: 1 }])[0].need).toBe("Pull request #1: 1 check failed");
    expect(checkItems([])).toEqual([]);
  });
});
