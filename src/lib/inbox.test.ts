import { describe, expect, it } from "vitest";
import { initialState, type MergeProposal, type State } from "../store";
import type { Chats } from "../sessions";
import { inboxItems } from "./inbox";
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
    expect(row).toMatchObject({ kind: "permission", slot: "s1", role: "chat", team: null, title: "Fix the build", where: "lantern", need: "Wants to use Bash: npm test", since: 100, requestId: "p1", needsYou: true });
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
    expect(row.need).toBe("Wants to use Bash: npm test (+1 more)");
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
