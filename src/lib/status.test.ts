import { describe, expect, it } from "vitest";
import { initialState, type ChatItem, type State } from "../store";
import { activityStatus } from "./status";

const chat = (extra: Partial<State>): State => ({ ...initialState, folder: "/p", status: "idle", ...extra });
const turn = (extra: object = {}): ChatItem => ({ type: "turn", id: "t", isError: false, stopped: false, result: null, durationMs: 1, denied: 0, ...extra });

describe("activityStatus", () => {
  it("says what Claude is doing", () => {
    expect(activityStatus(chat({ folder: null }), null).text).toBe("No folder open");
    expect(activityStatus(chat({ status: "starting" }), null)).toMatchObject({ text: "Starting Claude…", working: true });
    expect(activityStatus(chat({}), null)).toMatchObject({ text: "Ready", working: false });
    expect(activityStatus(chat({ status: "running" }), null)).toMatchObject({ text: "Claude is working", working: true });
    const asking: ChatItem = { type: "permission", id: "p", toolName: "Bash", input: {}, decision: null };
    expect(activityStatus(chat({ status: "running", items: [asking] }), null)).toMatchObject({ text: "Waiting for you", working: false });
  });

  it("says how the last turn ended, and when", () => {
    const now = new Date(2026, 8, 29, 19, 30);
    const at = new Date(2026, 8, 29, 19, 22);
    expect(activityStatus(chat({ items: [turn()] }), at, now).text).toBe("Finished");
    expect(activityStatus(chat({ items: [turn()] }), at, now).detail).toMatch(/^Today at /);
    expect(activityStatus(chat({ items: [turn({ stopped: true })] }), null, now)).toMatchObject({ text: "Stopped", detail: null });
    expect(activityStatus(chat({ items: [turn({ isError: true })] }), new Date(2026, 8, 20), now).detail).not.toMatch(/Today/);
  });
});
