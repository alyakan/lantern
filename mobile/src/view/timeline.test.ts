import type { Item } from "../sync/reducer";
import { dayLabel, lastLine, stepChips, summaryOf, timeline, turnLine } from "./timeline";

type Step = Extract<Item, { kind: "step" }>;
const step = (id: string, name: string, over: Partial<Step> = {}): Step => ({ kind: "step", id, name, summary: "", done: true, isError: false, edits: [], tests: null, ...over });
const said = (id: string, text: string, streaming = false): Item => ({ kind: "assistant", id, text, streaming });
const you = (id: string, text: string): Item => ({ kind: "user", id, text, at: null, sentBy: null });

describe("a run of steps as chips", () => {
  it("counts reads, searches and edits (files once, lines summed)", () => {
    const chips = stepChips([
      step("1", "Read"),
      step("2", "Read"),
      step("3", "Grep"),
      step("4", "Edit", { edits: [{ path: "/a.ts", created: false, added: 2, removed: 1 }] }),
      step("5", "Edit", { edits: [{ path: "/a.ts", created: false, added: 1, removed: 0 }, { path: "/b.ts", created: true, added: 5, removed: 0 }] }),
    ]);
    expect(chips.map((c) => c.label)).toEqual(["Read 2 files", "Searched 1 time", "Edited 2 files +8 −1"]);
    expect(chips[2].files).toEqual(["/a.ts", "/b.ts"]);
  });

  it("says tests as passed in green, or the failures in red", () => {
    expect(stepChips([step("1", "Bash", { tests: { passed: 412, failed: 0, skipped: 2 } })])).toEqual([{ key: "tests", label: "412 tests passed", tone: "ok" }]);
    expect(stepChips([step("1", "Bash", { tests: { passed: 10, failed: 3, skipped: 0 } })])).toEqual([{ key: "tests", label: "3 failed, 10 passed", tone: "bad" }]);
    expect(stepChips([step("1", "Bash", { tests: { passed: 1, failed: 0, skipped: 0 } })])[0].label).toBe("1 test passed");
  });

  it("groups commands, skills, helpers and other tools by kind, like the desktop's summary, and says failed steps in red", () => {
    const chips = stepChips([
      step("1", "Bash", { summary: "git push origin release/0.1.53 --force-with-lease" }),
      step("2", "Agent", { summary: "check the build" }),
      step("3", "mcp__claude_ai_Linear__list_issues", { summary: "mine" }),
      step("4", "Bash", { summary: "ls", isError: true }),
      step("5", "Skill", { summary: "brainstorming" }),
      step("6", "Bash"),
      step("7", "mcp__claude_ai_Linear__get_issue"),
      step("8", "SomethingNew"),
    ]);
    expect(chips.map((c) => c.label)).toEqual(["Ran 3 commands", "Used 1 skill", "Ran 1 helper", "Used Linear 2 times", "Used 1 other tool", "1 step failed"]);
    expect(chips[0].items).toEqual([
      { text: "git push origin release/0.1.53 --force-with-lease", bad: false, id: "1" },
      { text: "ls", bad: true, id: "4" },
      { text: "a command", bad: false, id: "6" },
    ]);
    expect(chips[3].items?.map((i) => i.text)).toEqual(["list issues mine", "get issue"]);
    expect(chips.at(-1)?.tone).toBe("bad");
  });

  it("keeps a test run apart from the commands, and says a lone command as a group of one", () => {
    const chips = stepChips([step("1", "Bash", { tests: { passed: 3, failed: 0, skipped: 0 } }), step("2", "Bash", { summary: "git status" })]);
    expect(chips.map((c) => c.label)).toEqual(["3 tests passed", "Ran 1 command"]);
  });

  it("looks up web pages apart from searching files", () => {
    expect(stepChips([step("1", "WebFetch"), step("2", "WebSearch")])[0].label).toBe("Looked up 2 pages");
  });
});

describe("the timeline", () => {
  it("folds each run of steps into one row, between the messages around it", () => {
    const rows = timeline([you("u1", "go"), step("1", "Read"), step("2", "Edit"), said("a1", "Done."), step("3", "Bash")]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "steps", "assistant", "steps"]);
  });

  it("shows a finished page as a page, and only the last one is live", () => {
    const rows = timeline([said("a1", "# Step 1 of 2 — one"), you("u1", "Next"), said("a2", "# Step 2 of 2 — two")]);
    expect(rows.map((r) => (r.kind === "page" ? r.live : null))).toEqual([false, null, true]);
  });

  it("keeps a page that is still streaming as text until it is whole", () => {
    expect(timeline([said("a", "# Step 1 of 2 — on", true)])[0].kind).toBe("assistant");
  });

  it("carries prompts, what only the Mac can answer, and turns' ends through", () => {
    const rows = timeline([
      { kind: "prompt", id: "p", toolName: "Bash", input: {}, state: "open", by: null },
      { kind: "desktop", id: "d", what: "Builder wants to merge its branch." },
      { kind: "turn", id: "t", isError: false, result: null, durationMs: 3000 },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["prompt", "desktop", "turn"]);
  });

  it("gives every row a key of its own", () => {
    const rows = timeline([you("u1", "a"), you("u2", "b"), said("x", "c"), step("s1", "Read"), step("s2", "Read")]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("a turn's end", () => {
  it("says how long it took, or what went wrong", () => {
    expect(turnLine({ kind: "turn", id: "t", isError: false, result: null, durationMs: 3100 })).toEqual({ text: "Finished in 3 s", bad: false });
    expect(turnLine({ kind: "turn", id: "t", isError: false, result: null, durationMs: 72_000 }).text).toBe("Finished in 1 min 12 s");
    expect(turnLine({ kind: "turn", id: "t", isError: false, result: null, durationMs: null }).text).toBe("Finished");
    expect(turnLine({ kind: "turn", id: "t", isError: true, result: "rate limited", durationMs: 1 })).toEqual({ text: "Stopped with an error: rate limited", bad: true });
  });
});

describe("a turn's summary", () => {
  const turn = (id: string, over: Partial<Extract<Item, { kind: "turn" }>> = {}): Item => ({ kind: "turn", id, isError: false, result: "ok", durationMs: 192_000, ...over });
  const long = "Done. Here is what changed:\n\n- the gateway checks Auto\n- the window checks again\n- the phone shows it";
  const worked = (): Item[] => [you("u1", "do it"), step("1", "Read"), step("2", "Edit", { edits: [{ path: "/a.ts", created: false, added: 4, removed: 1 }] }), step("3", "Bash", { summary: "npm test", tests: { passed: 9, failed: 0, skipped: 0 } })];

  it("is the closing message of a turn that did real work and says something, with what the turn did", () => {
    const items = [...worked(), said("a1", long), turn("t1")];
    const s = summaryOf(items, 4);
    expect(s?.durationMs).toBe(192_000);
    expect(s?.chips.map((c) => c.label)).toEqual(["Edited 1 file +4 −1", "9 tests passed"]);
    // The card says how long the turn took: no line of its own under it.
    expect(timeline(items).map((r) => r.kind)).toEqual(["user", "steps", "summary"]);
  });

  it("is a list too, however short, and a few sentences without one", () => {
    expect(summaryOf([...worked(), said("a1", "- one\n- two"), turn("t1")], 4)).not.toBeNull();
    expect(summaryOf([...worked(), said("a1", "x".repeat(170)), turn("t1")], 4)).not.toBeNull();
  });

  it("is not a short answer, or a turn that did little, or one that is still going or ended in an error", () => {
    expect(summaryOf([...worked(), said("a1", "Done."), turn("t1")], 4)).toBeNull();
    expect(summaryOf([you("u1", "hi"), step("1", "Read"), said("a1", long), turn("t1")], 2)).toBeNull();
    expect(summaryOf([...worked(), said("a1", long, true), turn("t1")], 4)).toBeNull();
    expect(summaryOf([...worked(), said("a1", long)], 4)).toBeNull();
    expect(summaryOf([...worked(), said("a1", long), turn("t1", { isError: true })], 4)).toBeNull();
  });

  it("is only the last message of the turn: what Claude said between its steps stays a message", () => {
    const items = [you("u1", "do it"), said("a0", long), ...worked().slice(1), said("a1", long), turn("t1")];
    expect(timeline(items).map((r) => r.kind)).toEqual(["user", "assistant", "steps", "summary"]);
  });

  it("counts only its own turn's work, not an earlier turn's", () => {
    const items: Item[] = [...worked(), turn("t1"), you("u2", "and?"), said("a2", long), turn("t2")];
    expect(summaryOf(items, 6)).toBeNull();
  });
});

describe("a turn's end, where it is said", () => {
  const end = (over: Partial<Extract<Item, { kind: "turn" }>> = {}): Item => ({ kind: "turn", id: "t", isError: false, result: null, durationMs: 42_000, ...over });
  it("ends the turn's last row of steps, instead of a line of its own", () => {
    const rows = timeline([you("u1", "go"), step("1", "Read"), said("a1", "Done."), end()]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "steps", "assistant"]);
    expect(rows[1].kind === "steps" && rows[1].took).toBe("42 s");
  });
  it("keeps a line of its own for a quick answer with no steps, and always for an error", () => {
    expect(timeline([you("u1", "hi"), said("a1", "Hello."), end()]).map((r) => r.kind)).toEqual(["user", "assistant", "turn"]);
    expect(timeline([you("u1", "go"), step("1", "Read"), end({ isError: true, result: "rate limited" })]).map((r) => r.kind)).toEqual(["user", "steps", "turn"]);
  });
  it("only counts its own turn's steps", () => {
    const rows = timeline([you("u1", "go"), step("1", "Read"), end({ id: "t1" }), you("u2", "hi"), said("a2", "Hello."), end({ id: "t2" })]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "steps", "user", "assistant", "turn"]);
  });
});

describe("days and times in a chat", () => {
  const NOW = new Date(2026, 9, 28, 9, 0).getTime();
  const at = (id: string, t: number): Item => ({ kind: "user", id, text: id, at: t, sentBy: null });
  const kinds = (items: Item[]) => timeline(items, NOW).map((r) => (r.kind === "day" ? `day:${r.label}` : r.kind === "user" ? `user:${r.showTime}` : r.kind));

  it("says nothing above today's first message, and names the day a new one starts", () => {
    expect(kinds([at("a", NOW - 60_000)])).toEqual(["user:true"]);
    const yesterday = NOW - 86_400_000;
    expect(kinds([at("a", yesterday), at("b", NOW - 60_000)])).toEqual(["day:Yesterday", "user:true", "day:Today", "user:true"]);
  });

  it("shows a message's time only after a gap, and never for one with no time", () => {
    expect(kinds([at("a", NOW - 30 * 60_000), at("b", NOW - 28 * 60_000), at("c", NOW - 5 * 60_000)])).toEqual(["user:true", "user:false", "user:true"]);
    expect(kinds([you("a", "x")])).toEqual(["user:false"]);
  });

  it("names an older day by its date", () => {
    expect(dayLabel(new Date(2026, 9, 20, 12).getTime(), NOW)).not.toMatch(/Today|Yesterday/);
    expect(dayLabel(NOW - 3 * 3_600_000, NOW)).toBe("Today");
  });
});

describe("a post-hook in the timeline", () => {
  const hook: Item = { kind: "hook", id: "hook-u1", text: "Update the brain if needed" };
  const turnEnd: Item = { kind: "turn", id: "t", isError: false, result: null, durationMs: 9000 };
  const long = "Done. Here is what changed:\n\n- one\n- two\n- three";
  const work = [step("1", "Read"), step("2", "Edit", { edits: [{ path: "/p/a.ts", created: false, added: 1, removed: 0 }] }), step("3", "Bash")];

  it("folds what the hook made Claude say and do into one row after the answer, which is still the turn's summary", () => {
    const rows = timeline([you("u1", "go"), ...work, said("a1", long), hook, step("h1", "Bash", { summary: "brain log" }), said("h2", "The brain is updated."), turnEnd]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "steps", "summary", "hook"]);
    const h = rows[3];
    expect(h.kind === "hook" && [h.text, h.said, h.chips.map((c) => c.label), h.going]).toEqual(["Update the brain if needed", "The brain is updated.", ["Ran 1 command"], false]);
  });

  it("is still going until the turn ends", () => {
    const rows = timeline([you("u1", "go"), said("a1", "Hi."), hook, step("h1", "Bash", { done: false })], Date.now(), true);
    expect(rows.at(-1)?.kind === "hook" && rows.at(-1)).toMatchObject({ going: true });
  });

  it("says the last line of the hook's words", () => {
    expect(lastLine("Checked.\n\n**The brain is updated.**\n```\ncode\n```")).toBe("The brain is updated.");
  });
});

describe("the files a message's turn edited", () => {
  it("are given to each message of the turn, and not to another turn's", () => {
    const rows = timeline([you("u1", "go"), said("a0", "Looking."), step("1", "Edit", { edits: [{ path: "/p/src/a.ts", created: false, added: 1, removed: 0 }] }), said("a1", "Changed `a.ts`."), you("u2", "next"), said("a2", "Ok.")]);
    const files = rows.filter((r) => r.kind === "assistant").map((r) => (r.kind === "assistant" ? r.files : null));
    expect(files).toEqual([["/p/src/a.ts"], ["/p/src/a.ts"], []]);
  });
});

describe("a chip whose step is still going", () => {
  it("says so, and stops once it is done", () => {
    expect(stepChips([step("1", "Bash", { done: false })])[0].running).toBe(true);
    expect(stepChips([step("1", "Bash")])[0].running).toBeUndefined();
    expect(stepChips([step("1", "Read", { done: false })])[0].running).toBe(true);
  });
});

describe("a post-hook in a chat replayed from its transcript (no turn ends)", () => {
  const hook: Item = { kind: "hook", id: "hook-u1", text: "Update the brain" };
  it("ends at the next message, and isn't going once the chat has stopped", () => {
    const rows = timeline([you("u1", "go"), said("a1", "Done."), hook, said("h1", "Updated."), you("u2", "next"), said("a2", "Ok."), { kind: "hook", id: "hook-u2", text: "Update the brain" }, said("h2", "Nothing new.")]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "hook", "user", "assistant", "hook"]);
    expect(rows.filter((r) => r.kind === "hook").map((r) => r.kind === "hook" && r.going)).toEqual([false, false]);
  });
  it("is going only while the chat works", () => {
    const items = [you("u1", "go"), said("a1", "Done."), hook];
    expect(timeline(items, Date.now(), true).at(-1)).toMatchObject({ kind: "hook", going: true });
    expect(timeline(items, Date.now(), false).at(-1)).toMatchObject({ kind: "hook", going: false });
  });
  it("isn't ended by a message this phone is still sending", () => {
    const sending: Item = { kind: "user", id: "local-1", text: "also", at: null, sentBy: null, sending: true };
    const rows = timeline([you("u1", "go"), said("a1", "Done."), hook, sending, said("h1", "Updated.")], Date.now(), true);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user", "hook"]);
  });
});

describe("rows drawn again as words stream in", () => {
  it("keep the same list of files, so their words aren't drawn again", () => {
    const edit = step("1", "Edit", { edits: [{ path: "/p/a.ts", created: false, added: 1, removed: 0 }] });
    const a = timeline([you("u1", "go"), edit, said("a1", "Changed it.")]);
    const b = timeline([you("u1", "go"), edit, said("a1", "Changed it."), said("a2", "More", true)]);
    const files = (rows: ReturnType<typeof timeline>) => rows.find((r) => r.kind === "assistant" && r.key === "a-a1");
    expect((files(a) as { files: string[] }).files).toBe((files(b) as { files: string[] }).files);
    const none = timeline([you("u1", "hi"), said("a1", "Hello.")]).find((r) => r.kind === "assistant") as { files: string[] };
    expect(none.files).toBe((timeline([you("u2", "x"), said("a9", "y")]).find((r) => r.kind === "assistant") as { files: string[] }).files);
  });
});

describe("an edit still going", () => {
  it("is the edits chip, spinning, not another tool", () => {
    expect(stepChips([step("1", "Edit", { done: false, summary: "a.ts" })])).toEqual([{ key: "edits", label: "Editing 1 file", tone: "plain", running: true }]);
    // One that failed with no change made is still said as a tool that was used.
    expect(stepChips([step("1", "Edit", { isError: true })]).map((c) => c.label)).toEqual(["Used 1 other tool", "1 step failed"]);
  });
});
