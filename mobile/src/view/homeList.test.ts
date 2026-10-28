import type { RemoteChat } from "../protocol/generated/RemoteChat";
import { matches, rows, sections } from "./home";

const NOW = 10_000_000;
const chat = (over: Partial<RemoteChat> = {}): RemoteChat => ({ slot: "a", title: "Release 0.1.53", project: "lantern", status: "idle", last_seq: 1, active_at: NOW - 60_000, permissions: null, preset: null, project_color: null, workflow: null, ...over });

describe("a row's preview and time worked", () => {
  it("is the line the Mac sent, trimmed, and none from a Mac that sent nothing", () => {
    expect(rows([chat({ preview: "  The tests pass.  " })], NOW)[0].preview).toBe("The tests pass.");
    expect(rows([chat()], NOW)[0].preview).toBeNull();
    expect(rows([chat({ preview: "   " })], NOW)[0].preview).toBeNull();
  });

  it("says how long a chat has been working, once it has been a while", () => {
    expect(rows([chat({ status: "working", active_at: NOW - 5 * 60_000 })], NOW)[0].elapsed).toBe("5 min");
    expect(rows([chat({ status: "working", active_at: NOW - 10_000 })], NOW)[0].elapsed).toBeNull();
    // Counted from when it was first seen working, not from its last event.
    expect(rows([chat({ slot: "w", status: "working", active_at: NOW - 1000 })], NOW, null, { w: NOW - 3 * 3_600_000 })[0].elapsed).toBe("3 h");
  });

  it("is said of a working chat only", () => {
    expect(rows([chat({ status: "idle", active_at: NOW - 5 * 60_000 })], NOW)[0].elapsed).toBeNull();
  });
});

describe("the labelled stretches of the recent list", () => {
  const list = () =>
    rows(
      [chat({ slot: "n", status: "needs_you" }), chat({ slot: "w", status: "working" }), chat({ slot: "i", status: "idle" }), chat({ slot: "p", status: "asleep", active_at: 1 }), chat({ slot: "z", status: "idle", active_at: 5 })],
      NOW,
      null,
      {},
      ["p"],
    );

  it("are pinned first, then what needs you, what works, and the rest", () => {
    const parts = sections(list());
    expect(parts.map((s) => [s.label, s.rows.map((r) => r.slot)])).toEqual([
      ["Pinned", ["p"]],
      ["Waiting on you", ["n"]],
      ["Working", ["w"]],
      ["Earlier", ["i", "z"]],
    ]);
  });

  it("is one stretch when every chat is alike", () => {
    expect(sections(rows([chat({ slot: "a" }), chat({ slot: "b" })], NOW)).map((s) => s.key)).toEqual(["earlier"]);
    expect(sections([])).toEqual([]);
  });
});

describe("which chats answer a search", () => {
  const row = (over: Partial<RemoteChat>) => rows([chat(over)], NOW)[0];
  it("is every word, anywhere in the title, project or preview, whatever the case", () => {
    const r = row({ title: "Storage audit", project: "network-monitor", preview: "Bash npm test" });
    expect(matches(r, "storage")).toBe(true);
    expect(matches(r, "AUDIT monitor")).toBe(true);
    expect(matches(r, "npm")).toBe(true);
    expect(matches(r, "storage zebra")).toBe(false);
  });
  it("is every chat when nothing is typed", () => {
    expect(matches(row({}), "")).toBe(true);
    expect(matches(row({}), "   ")).toBe(true);
  });
  it("copes with a chat that has no project or preview", () => {
    expect(matches(row({ project: null, preview: undefined }), "release")).toBe(true);
    expect(matches(row({ project: null }), "undefined")).toBe(false);
  });
});
