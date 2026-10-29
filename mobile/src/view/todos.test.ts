import { dueText, shownTodos, todoOfNotification, tomorrowMorning, validDay } from "./todos";
import type { RemoteUserTodo } from "../protocol/generated/RemoteUserTodo";

const item = (id: string, over: Partial<RemoteUserTodo> = {}): RemoteUserTodo => ({ id, title: id, note: null, done: false, due_date: null, due_time: null, overdue: false, by_claude: false, snoozed_until: null, ...over });
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe("to-dos on the phone", () => {
  it("says when something is due in a few words", () => {
    const now = at(2026, 10, 29);
    expect(dueText("2026-10-29", null, now)).toBe("Today");
    expect(dueText("2026-10-30", "14:00", now)).toBe("Tomorrow 14:00");
    expect(dueText("2026-10-28", null, now)).toBe("Yesterday");
    expect(dueText("2026-11-20", null, now)).toBe("20 Nov");
    expect(dueText("2027-01-05", null, now)).toBe("5 Jan 2027");
  });

  it("shows overdue open items first, then the rest, then the done ones", () => {
    expect(shownTodos([item("a"), item("d", { done: true }), item("late", { overdue: true })]).map((t) => t.id)).toEqual(["late", "a", "d"]);
  });

  it("knows tomorrow morning and a real day", () => {
    expect(tomorrowMorning(at(2026, 12, 31, 23))).toBe(at(2027, 1, 1, 9));
    expect(validDay("2028-02-29")).toBe(true);
    expect(validDay("2026-02-29")).toBe(false);
    expect(validDay("3 Nov")).toBe(false);
  });

  it("reads a reminder's push, and nothing else", () => {
    expect(todoOfNotification({ kind: "todo", project: "/Users/me/app", todo: "ab12" })).toEqual({ project: "/Users/me/app", todo: "ab12" });
    expect(todoOfNotification({ kind: "todo", project: "/Users/me/app" })).toEqual({ project: "/Users/me/app", todo: null });
    expect(todoOfNotification({ kind: "todo", project: "/p", todo: "../x" })).toEqual({ project: "/p", todo: null });
    expect(todoOfNotification({ kind: "needs_you", slot: "a" })).toBeNull();
    expect(todoOfNotification({ kind: "todo", project: "app" })).toBeNull();
    expect(todoOfNotification(null)).toBeNull();
  });
});
