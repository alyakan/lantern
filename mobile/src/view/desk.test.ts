import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import { chat } from "../test/render";
import { cantSend, deskFeed, deskLive, deskShown, LOG_MAX, readEntries, TEXT_KEPT, toKeep, waitingBy, type DeskEntry } from "./desk";

const desk: RemoteDesk = {
  desks: [
    { id: "home", name: "Desk", slots: ["a", "b"], projects: [{ id: "/w/lantern", name: "lantern" }] },
    { id: "work", name: "Work", slots: ["w"], projects: [{ id: "/w/job", name: "job" }] },
  ],
  cards: [
    { key: "a:t1", desk: "home", slot: "a", title: "A", project: "lantern", at: 10, asked: "Fix it", auto: false, said: "Fixed.", outcome: "done" },
    { key: "w:t1", desk: "work", slot: "w", title: "W", project: "job", at: 20, asked: "Ship", auto: false, said: "Shipped.", outcome: "done" },
    { key: "b:end", desk: "home", slot: "b", title: "B", project: "lantern", at: null, asked: "Old", auto: false, said: "From before.", outcome: "done" },
  ],
};
const entry = (id: string, at: number, over: Partial<DeskEntry> = {}): DeskEntry => ({ id, desk: "home", at, text: `said ${id}`, outcome: { kind: "routing" }, ...over });

describe("the phone's Desk", () => {
  it("shows the Desk chosen, else the first, else none", () => {
    expect(deskShown(desk, "work")?.name).toBe("Work");
    expect(deskShown(desk, "gone")?.id).toBe("home");
    expect(deskShown(null, "home")).toBeNull();
  });

  it("puts a Desk's cards and the messages typed on it in time order, a card of unknown time first", () => {
    const feed = deskFeed(desk, "home", [entry("e1", 15), entry("e2", 5, { desk: "work" })]);
    expect(feed.map((f) => (f.kind === "card" ? f.card.key : f.entry.id))).toEqual(["b:end", "a:t1", "e1"]);
  });

  it("lists the Desk's chats working or waiting on you, the waiting first", () => {
    const chats = [chat({ slot: "a", status: "working", preview: "Bash npm test" }), chat({ slot: "b", status: "needs_you" }), chat({ slot: "w", status: "working" }), chat({ slot: "c", status: "idle" })];
    expect(deskLive(chats, ["a", "b", "c"]).map((l) => [l.chat.slot, l.line])).toEqual([
      ["b", "Needs you"],
      ["a", "Bash npm test"],
    ]);
    expect(waitingBy(desk, chats)).toEqual({ home: 1, work: 0 });
  });

  it("says why a message can't go to a chat that is closed, asleep or stopped", () => {
    expect(cantSend(undefined)).toMatch(/closed/);
    expect(cantSend(chat({ status: "asleep" }))).toMatch(/asleep/);
    expect(cantSend(chat({ status: "ended" }))).toMatch(/stopped/);
    expect(cantSend(chat({ status: "working" }))).toBeNull();
  });

  it("keeps the messages read back that make sense, says what can't be finished, and keeps the newest", () => {
    const long = toKeep(entry("long", 3, { text: "x".repeat(TEXT_KEPT + 10), outcome: { kind: "ask", slots: ["a"], unsure: false } }));
    expect(long.cut).toBe(true);
    const read = readEntries([entry("going", 1), { id: 5 }, null, long, entry("sent", 4, { outcome: { kind: "sent", slot: "a", title: "A", started: false, queued: false } })]);
    expect(read.map((e) => [e.id, e.outcome.kind])).toEqual([
      ["going", "failed"],
      ["long", "failed"],
      ["sent", "sent"],
    ]);
    expect(readEntries(Array.from({ length: LOG_MAX + 4 }, (_, i) => entry(`e${i}`, i)))).toHaveLength(LOG_MAX);
    expect(readEntries("nope")).toEqual([]);
  });
});
