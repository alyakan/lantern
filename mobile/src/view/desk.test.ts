import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import { chat } from "../test/render";
import { answerShape, cantSend, deskFeed, deskHistory, deskLive, deskShown, finished, firstSentence, LOG_MAX, readEntries, replyCheck, TEXT_KEPT, toKeep, waitingBy, type DeskEntry } from "./desk";

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

describe("the Desk that talks, on the phone", () => {
  const sent = (over: Partial<DeskEntry> = {}): DeskEntry => ({ id: "e", desk: "home", at: 5, text: "Fix it", outcome: { kind: "sent", slot: "a", title: "A", started: false, queued: false }, ...over });

  it("asks the Mac what came back once the chat moved past the message and isn't working, and gives up when its events start over", () => {
    const waiting = { status: "waiting" as const, after: 10 };
    expect(replyCheck(waiting, chat({ last_seq: 10, status: "idle" }))).toBe("wait");
    expect(replyCheck(waiting, chat({ last_seq: 14, status: "working" }))).toBe("wait");
    expect(replyCheck(waiting, chat({ last_seq: 14, status: "idle" }))).toBe("ask");
    expect(replyCheck(waiting, chat({ last_seq: 3, status: "idle" }))).toBe("lost");
    expect(replyCheck(waiting, undefined)).toBe("wait");
    expect(replyCheck({ status: "off" }, chat({ last_seq: 14 }))).toBe("wait");
  });

  it("leaves out of Just finished the answer that shows under a message, and lists the rest newest first", () => {
    const withMine: RemoteDesk = { ...desk, cards: [...desk.cards, { key: "a:t2", desk: "home", slot: "a", title: "A", project: "lantern", at: 30, asked: "[Lantern: a note] Cap the delay", auto: false, said: "Capped.", outcome: "done" }] };
    const mine = sent({ text: "Cap the delay", at: 25, reply: { status: "waiting", after: 1 } });
    const keys = (entries: DeskEntry[]) => finished(withMine, "home", entries).map((c) => c.key);
    expect(keys([mine])).not.toContain("a:t2");
    expect(keys([])[0]).toBe("a:t2");
    expect(keys([]).indexOf("a:t2")).toBeLessThan(keys([]).indexOf("a:t1"));
  });

  it("tells the Desk the last exchanges with what came back, naming nothing of a chat on another provider", () => {
    const history = deskHistory(
      [sent({ say: "On it.", reply: { status: "done", failed: false, summary: "Fixed." } }), sent({ id: "g", text: "tidy", outcome: { kind: "sent", slot: "g", title: "Gemini", started: false, queued: false }, reply: { status: "done", failed: false, summary: "secret" } }), sent({ id: "t", text: "hi", say: "Hi!", outcome: { kind: "talk" } })],
      "home",
      [chat({ slot: "a" }), chat({ slot: "g", provider: "Gemini" })],
    );
    expect(history).toEqual([
      { you: "Fix it", desk: 'On it. (sent to "A"; it replied: Fixed.)' },
      { you: "tidy", desk: "(sent to)" },
      { you: "hi", desk: "Hi!" },
    ]);
  });

  it("keeps a reply without Claude's whole words, and reads back what it said and what came back", () => {
    const kept = toKeep(sent({ say: "On it.", reply: { status: "done", failed: false, summary: "Fixed.", full: "All of it." } }));
    expect(kept.reply).toEqual({ status: "done", failed: false, summary: "Fixed." });
    expect(readEntries([kept])[0]).toMatchObject({ say: "On it.", reply: { status: "done", summary: "Fixed." } });
    expect(readEntries([{ ...kept, reply: { status: "waiting" } }])[0].reply).toBeUndefined();
  });

  it("reads a finished line's first sentence, and the Mac's answer shape", () => {
    expect(firstSentence("Fixed it. Then more.")).toBe("Fixed it.");
    expect(firstSentence("• one • two")).toBe("one");
    expect(answerShape("Close.\n\n**Open**\n- the footer [1]")).toEqual({ lead: "Close.", parts: [{ part: "open", points: ["the footer [1]"] }] });
    expect(answerShape("- just a list")).toBeNull();
  });
});
