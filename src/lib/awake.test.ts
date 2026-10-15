import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import type { Chats } from "../sessions";
import { anythingWorking } from "./awake";

const chat = (over: Partial<State> = {}): State => ({ ...initialState, status: "idle", folder: "/work/lantern", ...over });
const chats = (slots: Record<string, State>): Chats => ({ active: Object.keys(slots)[0], slots, agents: {} });
const asking = { type: "permission" as const, id: "p1", toolName: "Bash", input: {}, decision: null };

describe("anythingWorking", () => {
  it("is false when every chat is idle or ended", () => {
    expect(anythingWorking(chats({ s1: chat(), s2: chat({ status: "ended" }) }))).toBe(false);
  });

  it("is true while any chat in any project is running", () => {
    expect(anythingWorking(chats({ s1: chat(), s2: chat({ status: "running", folder: "/work/other" }) }))).toBe(true);
  });

  it("is true for a chat with messages queued, but not for one only opening", () => {
    expect(anythingWorking(chats({ s1: chat({ status: "starting" }) }))).toBe(false);
    expect(anythingWorking(chats({ s1: chat({ queued: ["next"] }) }))).toBe(true);
  });

  it("is true for an agent paused on a permission, but not for a restored chat's old question", () => {
    expect(anythingWorking(chats({ s1: chat({ status: "running", items: [asking] }) }))).toBe(true);
    expect(anythingWorking(chats({ s1: chat({ items: [asking] }) }))).toBe(false);
  });
});
