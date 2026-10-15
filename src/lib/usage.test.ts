import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import type { Chats } from "../sessions";
import { modelLine, modelShares, teamWarning, usageRows, workingTeams } from "./usage";

const chat = (over: Partial<State> = {}): State => ({ ...initialState, folder: "/p/acme-api", status: "idle", ...over });
const used = (cost: number, tokens: number, over: Partial<State> = {}) => chat({ costSeen: cost, sessionCost: cost, sessionTokens: tokens, ...over });
const meta = (parent: string, name: string) => ({ parent, name, brief: "", folder: "/p/acme-api", branch: null, base: null, isolation: "shared" as const });

describe("what each model took", () => {
  it("shares the latest turn's cost between the families, biggest first, and by tokens when there is no cost", () => {
    const a = chat({ modelUsage: [{ model: "claude-sonnet-5-5", cost_usd: 0.62, input_tokens: 1000, output_tokens: 0 }, { model: "claude-opus-5-5", cost_usd: 0.38, input_tokens: 10, output_tokens: 0 }] });
    expect(modelLine(modelShares([a]))).toBe("Sonnet 62%, Opus 38%");
    const b = chat({ modelUsage: [{ model: "claude-haiku-5-5", cost_usd: 0, input_tokens: 300, output_tokens: 100 }, { model: "claude-sonnet-5-5", cost_usd: 0, input_tokens: 100, output_tokens: 0 }] });
    expect(modelLine(modelShares([b]))).toBe("Haiku 80%, Sonnet 20%");
  });

  it("pools several chats, and names the model a chat runs on until it has reported any", () => {
    const one = { model: "claude-opus-5-5", cost_usd: 1, input_tokens: 0, output_tokens: 0 };
    const two = { model: "claude-sonnet-5-5", cost_usd: 1, input_tokens: 0, output_tokens: 0 };
    expect(modelLine(modelShares([chat({ modelUsage: [one] }), chat({ modelUsage: [two] })]))).toBe("Opus 50%, Sonnet 50%");
    expect(modelLine(modelShares([chat({ model: "claude-opus-5-5" })]))).toBe("Opus");
    expect(modelShares([chat()])).toEqual([]);
  });

  it("says <1% for a sliver", () => {
    expect(modelLine([{ name: "Haiku", share: 0.004 }])).toBe("Haiku <1%");
  });
});

describe("the usage list", () => {
  it("lists chats and teams biggest first, a team as its Lead and agents with their total", () => {
    const chats: Chats = {
      active: "s1",
      slots: {
        s1: used(1.2, 300_000),
        s2: used(0.5, 90_000, { orchestrator: true, status: "running" }),
        w1: used(0.9, 200_000, { status: "idle" }),
        w2: used(0.1, 10_000),
        s3: chat(),
      },
      agents: { w1: meta("s2", "Login form"), w2: meta("s2", "Docs") },
    };
    const rows = usageRows(chats, {});
    expect(rows.map((r) => [r.slot, r.cost])).toEqual([["s2", 1.5], ["s1", 1.2]]);
    const team = rows[0];
    expect(team.name).toBe("Team · acme-api");
    expect(team.state).toBe("working");
    expect(team.tokens).toBe(300_000);
    expect(team.members?.map((m) => m.name)).toEqual(["Lead", "Login form", "Docs"]);
  });

  it("leaves out a chat that has used nothing and isn't working, and says nothing when no chat has used anything", () => {
    const chats: Chats = { active: "s1", slots: { s1: chat(), s2: chat({ status: "running" }) }, agents: {} };
    expect(usageRows(chats).map((r) => r.slot)).toEqual(["s2"]);
    expect(usageRows({ active: "s1", slots: { s1: chat() }, agents: {} })).toEqual([]);
  });

  it("sorts by tokens when no cost is known, and names a chat by its title", () => {
    const chats: Chats = { active: "s1", slots: { s1: chat({ sessionTokens: 5_000, sessionId: "a" }), s2: chat({ sessionTokens: 90_000, sessionId: "b" }) }, agents: {} };
    const rows = usageRows(chats, { a: "Small one", b: "Big one" });
    expect(rows.map((r) => r.name)).toEqual(["Big one", "Small one"]);
  });
});

describe("another team working", () => {
  const team = (lead: Partial<State>, ...workers: Partial<State>[]): Chats => ({
    active: "s1",
    slots: { s1: chat({ orchestrator: true, ...lead }), ...Object.fromEntries(workers.map((w, i) => [`w${i}`, chat(w)])) },
    agents: Object.fromEntries(workers.map((_, i) => [`w${i}`, meta("s1", `Agent ${i}`)])),
  });

  it("counts the agents working, and none when everyone is idle", () => {
    expect(workingTeams(team({}, { status: "running" }, { status: "running" }, { status: "idle" }))).toEqual([{ name: "acme-api", agents: 2 }]);
    expect(workingTeams(team({}, { status: "idle" }))).toEqual([]);
    expect(workingTeams(team({ status: "running" }))).toEqual([{ name: "acme-api", agents: 0 }]);
  });

  it("leaves out the team of the Lead that is starting an agent", () => {
    expect(workingTeams(team({}, { status: "running" }), "s1")).toEqual([]);
  });

  it("says who is working", () => {
    expect(teamWarning([{ name: "acme-api", agents: 3 }])).toBe("Another team is working (acme-api, 3 agents). Every agent spends the same plan. Start anyway?");
    expect(teamWarning([{ name: "web", agents: 1 }, { name: "infra", agents: 0 }])).toBe("Other teams are working (web, 1 agent; infra, its Lead). Every agent spends the same plan. Start anyway?");
  });
});
