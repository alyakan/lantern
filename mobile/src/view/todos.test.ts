import { dueText, monthWeeks, quickDays, todoOfNotification, todoSections, tomorrowMorning } from "./todos";
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

  it("puts the open items in the Mac's sections, leaving out empty ones and the done ones", () => {
    const now = at(2026, 10, 29);
    const sections = todoSections(
      [
        item("free"),
        item("later", { due_date: "2026-11-05" }),
        item("soon", { due_date: "2026-10-30", due_time: "18:00" }),
        item("sooner", { due_date: "2026-10-30", due_time: "09:00" }),
        item("late", { due_date: "2026-10-28", overdue: true }),
        item("today", { due_date: "2026-10-29" }),
        item("ticked", { due_date: "2026-10-29", done: true }),
      ],
      now,
    );
    expect(sections.map((s) => [s.key, s.items.map((t) => t.id)])).toEqual([
      ["overdue", ["late"]],
      ["today", ["today"]],
      ["upcoming", ["sooner", "soon", "later"]],
      ["none", ["free"]],
    ]);
    expect(todoSections([item("free")], now).map((s) => s.key)).toEqual(["none"]);
  });

  it("offers Today, Tomorrow and a week from today, across a month's end", () => {
    expect(quickDays(at(2026, 10, 30))).toEqual([
      { label: "Today", date: "2026-10-30" },
      { label: "Tomorrow", date: "2026-10-31" },
      { label: "Next week", date: "2026-11-06" },
    ]);
  });

  it("lays a month out in weeks from Monday", () => {
    // November 2026 begins on a Sunday and has 30 days.
    const weeks = monthWeeks(2026, 10);
    expect(weeks[0]).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(weeks[weeks.length - 1]).toEqual(["2026-11-30", null, null, null, null, null, null]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
  });

  it("knows tomorrow morning", () => {
    expect(tomorrowMorning(at(2026, 12, 31, 23))).toBe(at(2027, 1, 1, 9));
  });

  it("reads a reminder's push, and nothing else", () => {
    const token = "0123456789abcdef";
    expect(todoOfNotification({ kind: "todo", project: token, todo: "ab12" })).toEqual({ project: token, todo: "ab12" });
    expect(todoOfNotification({ kind: "todo", project: token })).toEqual({ project: token, todo: null });
    expect(todoOfNotification({ kind: "todo", project: token, todo: "../x" })).toEqual({ project: token, todo: null });
    expect(todoOfNotification({ kind: "needs_you", slot: "a" })).toBeNull();
    // A path, or anything else, isn't a project a push names.
    expect(todoOfNotification({ kind: "todo", project: "/Users/me/app" })).toBeNull();
    expect(todoOfNotification({ kind: "todo", project: "app" })).toBeNull();
    expect(todoOfNotification(null)).toBeNull();
  });
});
