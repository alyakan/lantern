import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import { chat, NOW } from "../test/render";
import { byDay, dayOf, historyEvents } from "./history";

const HOUR = 3_600_000;
const card = (key: string, over: Record<string, unknown>) => ({ key, desk: "home", slot: "a", title: "Release 0.1.53", project: "lantern", at: NOW - HOUR, asked: "Ship it", auto: false, said: "Shipped. All green.", outcome: "done", ...over });
const desk = (cards: ReturnType<typeof card>[]) => ({ desks: [{ id: "home", name: "Desk", slots: ["a", "b"], projects: [] }], cards }) as unknown as RemoteDesk;

describe("a tablet's Timeline", () => {
  it("puts what is going on now first, then each finished answer, newest first, on its first sentence", () => {
    const chats = [chat({ slot: "a", status: "idle" }), chat({ slot: "b", title: "Fix the footer", status: "working", preview: "Editing footer.tsx" }), chat({ slot: "c", title: "Migrate", status: "needs_you" })];
    const events = historyEvents(chats, desk([card("a:1", { at: NOW - 3 * HOUR }), card("a:2", { at: NOW - HOUR, said: "Tagged v2. Draft is up." })]), { b: NOW - 60_000 });
    expect(events.map((e) => [e.title, e.kind])).toEqual([
      ["Migrate", "waiting"],
      ["Fix the footer", "working"],
      ["Release 0.1.53", "done"],
      ["Release 0.1.53", "done"],
    ]);
    expect(events[1].line).toBe("Editing footer.tsx");
    expect(events[2].line).toBe("Tagged v2.");
  });

  it("says a failed or stopped answer as such, and keeps to the one project the Mac shows", () => {
    const events = historyEvents([], desk([card("a:1", { outcome: "failed" }), card("b:1", { slot: "b", project: "site", outcome: "stopped" })]), {}, "lantern");
    expect(events.map((e) => e.kind)).toEqual(["failed"]);
  });

  it("groups by Now, Today, Yesterday, then the day", () => {
    const noon = new Date(2026, 10, 8, 12).getTime();
    const events = historyEvents([chat({ slot: "b", status: "working" })], desk([card("a:1", { at: noon - HOUR }), card("a:2", { at: noon - 24 * HOUR }), card("a:3", { at: noon - 72 * HOUR }), card("a:4", { at: null })]), {});
    expect(byDay(events, noon).map((d) => d.day)).toEqual(["Now", "Today", "Yesterday", dayOf(events[3], noon), "Earlier"]);
  });
});
