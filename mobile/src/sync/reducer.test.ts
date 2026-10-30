import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import type { Waiting } from "../protocol/generated/Waiting";
import { emptyView, initialState, openPrompts, reducer, type Action, type State } from "./reducer";

const event = (slot: string, seq: number, e: RemoteEvent): Action => ({ type: "pushed", msg: { type: "event", slot, seq, event: e } });
const reset = (slot: string, seq: number, events: RemoteEvent[], page = 0, done = true, hidden = 0): Action => ({ type: "pushed", msg: { type: "reset", slot, seq, page, done, hidden, events } });
const run = (actions: Action[], from: State = initialState) => actions.reduce(reducer, from);
const items = (s: State, slot = "a") => s.views[slot]?.items ?? [];

const turn: RemoteEvent[] = [
  { kind: "user_text", text: "ship it", at: 1, sent_by: "desktop" },
  { kind: "thinking" },
  { kind: "text_delta", block_id: "b1", text: "Bump" },
  { kind: "text_delta", block_id: "b1", text: "ing" },
  { kind: "assistant_text", block_id: "b1", text: "Bumping the version." },
  { kind: "tool_started", tool_use_id: "t1", name: "Edit", summary: "package.json" },
  { kind: "file_edited", tool_use_id: "t1", path: "/p/package.json", created: false, added: 1, removed: 1 },
  { kind: "tool_finished", tool_use_id: "t1", is_error: false },
  { kind: "tool_started", tool_use_id: "t2", name: "Bash", summary: "npm test" },
  { kind: "tests_ran", tool_use_id: "t2", command: "npm test", passed: 412, failed: 0, skipped: 2 },
  { kind: "tool_finished", tool_use_id: "t2", is_error: false },
  { kind: "turn_done", is_error: false, result: "done", duration_ms: 3000, context_window: null },
];

describe("whether the chat list and what waits have come", () => {
  it("are not known until the Mac has sent them, even when there are none", () => {
    expect(initialState).toMatchObject({ chatsLoaded: false, waitingLoaded: false });
    const chatsOnly = run([{ type: "pushed", msg: { type: "chats", chats: [] } }]);
    expect(chatsOnly).toMatchObject({ chatsLoaded: true, waitingLoaded: false });
    expect(run([{ type: "waiting", list: [] }], chatsOnly)).toMatchObject({ chatsLoaded: true, waitingLoaded: true });
  });

  it("stay known when the Mac starts a new run: what was shown is still shown while it is asked again", () => {
    const known = run([{ type: "pushed", msg: { type: "chats", chats: [] } }, { type: "waiting", list: [] }]);
    expect(run([{ type: "welcome", epoch: 7 }], known)).toMatchObject({ chatsLoaded: true, waitingLoaded: true });
  });
});

describe("whether a chat's history has come", () => {
  it("is not loaded until the Mac sends it, even when it is empty", () => {
    expect(emptyView).toMatchObject({ loaded: false, loadError: null });
    const s = run([reset("a", 0, [])]);
    expect(s.views.a).toMatchObject({ loaded: true, loadError: null, items: [] });
  });

  it("keeps why asking failed, until asked again or the history comes", () => {
    const failed = run([{ type: "load_failed", slot: "a", why: "That chat isn't open." }]);
    expect(failed.views.a).toMatchObject({ loaded: false, loadError: "That chat isn't open." });
    expect(run([{ type: "load_started", slot: "a" }], failed).views.a.loadError).toBeNull();
    expect(run([reset("a", 3, turn)], failed).views.a).toMatchObject({ loaded: true, loadError: null });
  });

  it("starting to load changes nothing for a chat that has no view yet", () => {
    expect(run([{ type: "load_started", slot: "a" }])).toBe(initialState);
  });
});

describe("a chat, built from its events", () => {
  it("streams text into its block, folds steps with their edits and tests, and ends the turn", () => {
    const s = run(turn.map((e, i) => event("a", i + 1, e)));
    const kinds = items(s).map((it) => it.kind);
    expect(kinds).toEqual(["user", "assistant", "step", "step", "turn"]);
    expect(items(s)[1]).toMatchObject({ text: "Bumping the version.", streaming: false });
    expect(items(s)[2]).toMatchObject({ name: "Edit", done: true, edits: [{ path: "/p/package.json", added: 1, removed: 1 }] });
    expect(items(s)[3]).toMatchObject({ tests: { passed: 412, failed: 0, skipped: 2 } });
    expect(s.views.a).toMatchObject({ seq: turn.length, thinking: false });
  });

  it("applying the same events again changes nothing", () => {
    const once = run(turn.map((e, i) => event("a", i + 1, e)));
    const twice = run(turn.map((e, i) => event("a", i + 1, e)), once);
    expect(items(twice)).toEqual(items(once));
  });

  it("a catch-up that overlaps live events shows each thing once", () => {
    // The phone was sent the start live, then a Reset with the whole turn, then the rest live again.
    const live = run(turn.slice(0, 4).map((e, i) => event("a", i + 1, e)));
    const afterReset = run([reset("a", 8, turn.slice(0, 8))], live);
    const rest = run(turn.slice(4).map((e, i) => event("a", i + 5, e)), afterReset);
    expect(items(rest).filter((it) => it.kind === "assistant")).toHaveLength(1);
    expect(items(rest).filter((it) => it.kind === "step")).toHaveLength(2);
    expect(items(rest).at(-1)?.kind).toBe("turn");
  });

  it("a late streamed piece doesn't add to a block that is already whole", () => {
    const s = run([event("a", 1, { kind: "assistant_text", block_id: "b", text: "Whole." }), event("a", 2, { kind: "text_delta", block_id: "b", text: " more" })]);
    expect(items(s)[0]).toMatchObject({ text: "Whole." });
  });

  it("a Reset's first page starts over and later pages add to it, with how many turns are left out", () => {
    const before = run([event("a", 1, { kind: "user_text", text: "old", at: 1, sent_by: null })]);
    const page0 = run([reset("a", 20, [{ kind: "user_text", text: "new", at: 9, sent_by: null }], 0, false, 4)], before);
    expect(items(page0).map((it) => (it.kind === "user" ? it.text : it.kind))).toEqual(["new"]);
    expect(page0.views.a).toMatchObject({ seq: 20, hidden: 4, resetting: true });
    const page1 = run([reset("a", 20, [{ kind: "assistant_text", block_id: "x", text: "reply" }], 1, true, 4)], page0);
    expect(items(page1)).toHaveLength(2);
    expect(page1.views.a.resetting).toBe(false);
  });

  it("says how many events a catch-up covered, only for a chat that was followed before", () => {
    const first = run([reset("a", 20, [{ kind: "user_text", text: "hi", at: 1, sent_by: null }])]);
    expect(first.views.a.caughtUp).toBe(0);
    const again = run([reset("a", 35, [{ kind: "user_text", text: "hi", at: 1, sent_by: null }])], first);
    expect(again.views.a.caughtUp).toBe(15);
    // Later pages of the same catch-up keep the count; a catch-up that covers nothing resets it.
    expect(run([reset("a", 35, [], 1, true)], again).views.a.caughtUp).toBe(15);
    expect(run([reset("a", 35, [])], again).views.a.caughtUp).toBe(0);
  });

  it("earlier turns go before what is shown, once", () => {
    const s = run([reset("a", 5, [{ kind: "user_text", text: "recent", at: 9, sent_by: null }], 0, true, 3)]);
    const more = reducer(s, { type: "earlier", slot: "a", hidden: 0, events: [{ kind: "user_text", text: "first", at: 1, sent_by: null }] });
    expect(items(more).map((it) => (it.kind === "user" ? it.text : ""))).toEqual(["first", "recent"]);
    expect(more.views.a.hidden).toBe(0);
  });

  it("events of other chats don't touch this one", () => {
    const s = run([event("b", 1, { kind: "thinking" })]);
    expect(s.views.a).toBeUndefined();
    expect(s.views.b.thinking).toBe(true);
  });
});

describe("turns", () => {
  it("a turn's end applied twice is one end, and each turn has its own", () => {
    const first: RemoteEvent[] = [{ kind: "user_text", text: "one", at: 1, sent_by: null }, { kind: "turn_done", is_error: false, result: "a", duration_ms: 1, context_window: null }];
    const second: RemoteEvent[] = [{ kind: "user_text", text: "two", at: 2, sent_by: null }, { kind: "turn_done", is_error: false, result: "b", duration_ms: 1, context_window: null }];
    let s = run([...first, ...first, ...second, ...second].map((e, i) => ({ type: "pushed", msg: { type: "event", slot: "a", seq: i + 1, event: e } }) as Action));
    expect(items(s).filter((it) => it.kind === "turn")).toHaveLength(2);
    // A catch-up of the same turns on top changes nothing either.
    s = run([reset("a", 20, [...first, ...second])], s);
    expect(items(s).filter((it) => it.kind === "turn")).toHaveLength(2);
    expect(items(s).filter((it) => it.kind === "user")).toHaveLength(2);
  });
});

describe("the post-hook", () => {
  it("marks where the hook's turn begins, once however often it is told, after the answer", () => {
    const hook: RemoteEvent = { kind: "hook_turn", text: "Update the brain if needed" };
    const s = run([...turn.slice(0, 5), hook, hook, { kind: "assistant_text", block_id: "h1", text: "Updated." } as RemoteEvent].map((e, i) => event("a", i + 1, e)));
    const kinds = items(s).map((it) => it.kind);
    expect(kinds).toEqual(["user", "assistant", "hook", "assistant"]);
    expect(items(s)[2]).toEqual({ kind: "hook", id: "hook-u-1-ship it", text: "Update the brain if needed" });
  });

  it("keeps the first hook's place when a second comes in the same turn (a Stop hook, then the post-hook)", () => {
    const stop: RemoteEvent = { kind: "hook_turn", text: "Before you finish: save it." };
    const post: RemoteEvent = { kind: "hook_turn", text: "Update the brain if needed" };
    const said = (id: string, text: string) => ({ kind: "assistant_text", block_id: id, text }) as RemoteEvent;
    const s = run([...turn.slice(0, 5), stop, said("h1", "Saved."), post, said("h2", "Nothing more.")].map((e, i) => event("a", i + 1, e)));
    expect(items(s).map((it) => it.kind)).toEqual(["user", "assistant", "hook", "assistant", "assistant"]);
  });
});

describe("a message sent from this phone", () => {
  it("shows at once, and the Mac's copy takes its place", () => {
    let s = reducer(initialState, { type: "sending", slot: "a", clientId: "m-1", text: "ship it", at: 5 });
    expect(items(s)[0]).toMatchObject({ kind: "user", text: "ship it", sending: true });
    s = reducer(s, event("a", 1, { kind: "user_text", text: "ship it", at: 6, sent_by: "phone-abc:m-1" }));
    expect(items(s)).toHaveLength(1);
    expect(items(s)[0]).toMatchObject({ at: 6, sentBy: "phone-abc:m-1" });
    expect(items(s)[0]).not.toHaveProperty("sending");
  });

  it("with photos shows them at once, and keeps them where this phone has them when the Mac's copy takes its place", () => {
    let s = reducer(initialState, { type: "sending", slot: "a", clientId: "m-1", text: "what is this?", at: 5, thumbs: ["file:///a.jpg", "file:///b.jpg"] });
    expect(items(s)[0]).toMatchObject({ kind: "user", sending: true, images: 2, thumbs: ["file:///a.jpg", "file:///b.jpg"] });
    s = reducer(s, event("a", 1, { kind: "user_text", text: "what is this?", at: 6, sent_by: "phone-abc:m-1", images: 2 }));
    expect(items(s)).toHaveLength(1);
    expect(items(s)[0]).toMatchObject({ at: 6, images: 2, thumbs: ["file:///a.jpg", "file:///b.jpg"] });
    expect(items(s)[0]).not.toHaveProperty("sending");
  });

  it("with no pictures carries no count, whether the Mac says none or says nothing", () => {
    for (const images of [undefined, null as unknown as undefined, 0]) {
      const s = reducer(initialState, event("a", 1, { kind: "user_text", text: "hi", at: 1, sent_by: "phone-abc:m-9", ...(images === undefined ? {} : { images }) }));
      expect(items(s)[0]).not.toHaveProperty("images");
      expect(items(s)[0]).not.toHaveProperty("thumbs");
    }
  });

  it("is only a count when it was sent from somewhere else, or before this run", () => {
    const s = reducer(initialState, event("a", 1, { kind: "user_text", text: "", at: 3, sent_by: "desktop", images: 3 }));
    expect(items(s)[0]).toMatchObject({ kind: "user", text: "", images: 3 });
    expect(items(s)[0]).not.toHaveProperty("thumbs");
  });

  it("says why when it didn't go", () => {
    let s = reducer(initialState, { type: "sending", slot: "a", clientId: "m-2", text: "hi", at: 1 });
    s = reducer(s, { type: "send_failed", slot: "a", clientId: "m-2", error: "That chat isn't open on your Mac." });
    expect(items(s)[0]).toMatchObject({ sending: false, failed: "That chat isn't open on your Mac." });
  });

  it("survives a Reset that comes before its echo", () => {
    let s = reducer(initialState, { type: "sending", slot: "a", clientId: "m-3", text: "hi", at: 1 });
    s = reducer(s, reset("a", 3, []));
    expect(items(s)).toHaveLength(1);
  });
});

describe("prompts", () => {
  const asked: RemoteEvent = { kind: "permission_requested", request_id: "p1", tool_name: "Bash", input: { command: "git push" } };

  it("are open until answered here or on the Mac, and say who answered", () => {
    let s = run([event("a", 1, asked)]);
    expect(openPrompts(s.views.a)).toHaveLength(1);
    s = run([event("a", 2, { kind: "permission_resolved", request_id: "p1", allow: true, by: "desktop" })], s);
    expect(openPrompts(s.views.a)).toHaveLength(0);
    expect(items(s)[0]).toMatchObject({ state: "allowed", by: "desktop" });
  });

  it("remember what this phone answered a question with, for showing beside it", () => {
    let s = run([event("a", 1, asked), event("a", 2, { kind: "permission_resolved", request_id: "p1", allow: true, by: "phone-1" })]);
    s = reducer(s, { type: "answered_with", slot: "a", requestId: "p1", text: "Stable" });
    expect(items(s)[0]).toMatchObject({ state: "allowed", answer: "Stable" });
    // Of a chat or prompt that isn't there: nothing happens.
    expect(reducer(s, { type: "answered_with", slot: "zzz", requestId: "p1", text: "x" })).toBe(s);
    expect(items(reducer(s, { type: "answered_with", slot: "a", requestId: "nope", text: "x" }))[0]).toMatchObject({ answer: "Stable" });
  });

  it("close when Claude stops asking, or a new claude starts", () => {
    expect(items(run([event("a", 1, asked), event("a", 2, { kind: "permission_withdrawn", request_id: "p1" })]))[0]).toMatchObject({ state: "withdrawn" });
    expect(openPrompts(run([event("a", 1, asked), event("a", 2, { kind: "session_ended", code: 1 })]).views.a)).toHaveLength(0);
    expect(openPrompts(run([event("a", 1, asked), event("a", 2, { kind: "session_started", session_id: "s" })]).views.a)).toHaveLength(0);
  });

  it("leave the home screen's stack when they're settled, oldest first while waiting", () => {
    const w = (slot: string, id: string, at: number): Waiting => ({ slot, chat_title: null, request_id: id, tool_name: "Bash", input: {}, at });
    let s = reducer(initialState, { type: "waiting", list: [w("a", "p2", 9), w("a", "p1", 3), w("b", "q", 5)] });
    expect(s.waiting.map((x) => x.request_id)).toEqual(["p1", "q", "p2"]);
    s = run([event("a", 1, { kind: "permission_resolved", request_id: "p1", allow: false, by: "desktop" })], s);
    expect(s.waiting.map((x) => x.request_id)).toEqual(["q", "p2"]);
    s = run([event("b", 1, { kind: "session_ended", code: null })], s);
    expect(s.waiting.map((x) => x.request_id)).toEqual(["p2"]);
  });

  it("what only the Mac can answer is said once", () => {
    const s = run([event("a", 1, { kind: "needs_desktop", what: "Builder wants to merge its branch." }), event("a", 2, { kind: "needs_desktop", what: "Builder wants to merge its branch." })]);
    expect(items(s)).toEqual([{ kind: "desktop", id: "desktop-Builder wants to merge its branch.", what: "Builder wants to merge its branch." }]);
  });
});

describe("the Mac", () => {
  it("restarting (another epoch) makes every followed chat start over from 0", () => {
    let s = run([{ type: "welcome", epoch: 1 }, event("a", 50, { kind: "thinking" })]);
    expect(s.views.a.seq).toBe(50);
    s = reducer(s, { type: "welcome", epoch: 2 });
    expect(s.views.a.seq).toBe(0);
    s = reducer(s, event("a", 1, { kind: "assistant_text", block_id: "n", text: "after the restart" }));
    expect(items(s).some((it) => it.kind === "assistant")).toBe(true);
  });

  it("the same Mac saying hello again keeps the numbers", () => {
    const s = run([{ type: "welcome", epoch: 1 }, event("a", 5, { kind: "thinking" }), { type: "welcome", epoch: 1 }]);
    expect(s.views.a.seq).toBe(5);
  });

  it("keeps the chat list as the Mac last sent it", () => {
    const s = reducer(initialState, { type: "pushed", msg: { type: "chats", chats: [{ slot: "a", title: "Release", project: "lantern", status: "needs_you", last_seq: 3, active_at: 1, permissions: null, preset: null, project_color: null, workflow: null }] } });
    expect(s.chats[0]).toMatchObject({ slot: "a", status: "needs_you" });
    expect(emptyView.items).toEqual([]);
  });

  it("a conversation cleared on the Mac is cleared here", () => {
    const s = run([event("a", 1, { kind: "user_text", text: "x", at: 1, sent_by: null }), event("a", 2, { kind: "conversation_reset" })]);
    expect(items(s)).toEqual([]);
  });
});

describe("a command started from this phone's terminal", () => {
  const id = "ph-abcd1234";
  const started: RemoteEvent = { kind: "shell_started", id, command: "git status" };

  it("is a card that fills with what it prints and ends with its exit code", () => {
    let s = run([event("a", 1, started), event("a", 2, { kind: "shell_output", id, text: "On branch " }), event("a", 3, { kind: "shell_output", id, text: "main\n" })]);
    expect(items(s)).toEqual([{ kind: "shell", id, command: "git status", output: "On branch main\n", status: "running", code: null, secret: false }]);
    s = run([event("a", 4, { kind: "shell_done", id, code: 0, stopped: false })], s);
    expect(items(s)[0]).toMatchObject({ status: "done", code: 0 });
    expect(items(run([event("b", 1, started), event("b", 2, { kind: "shell_done", id, code: 2, stopped: false })]), "b")[0]).toMatchObject({ status: "failed", code: 2 });
    expect(items(run([event("c", 1, started), event("c", 2, { kind: "shell_done", id, code: null, stopped: true })]), "c")[0]).toMatchObject({ status: "stopped" });
  });

  it("knows when it reads a secret, until it ends", () => {
    let s = run([event("a", 1, started), event("a", 2, { kind: "shell_secret", id, secret: true })]);
    expect(items(s)[0]).toMatchObject({ secret: true });
    s = run([event("a", 3, { kind: "shell_secret", id, secret: false })], s);
    expect(items(s)[0]).toMatchObject({ secret: false });
    s = run([event("a", 4, { kind: "shell_secret", id, secret: true }), event("a", 5, { kind: "shell_done", id, code: 0, stopped: false })], s);
    expect(items(s)[0]).toMatchObject({ secret: false });
  });

  it("is one card however often it is told of, keeps only the end of a huge output, and ignores output for a command it doesn't have", () => {
    const big = "x".repeat(70_000);
    const s = run([event("a", 1, started), event("a", 2, { kind: "shell_output", id, text: big }), event("a", 3, { kind: "shell_output", id, text: "END" }), event("a", 4, { kind: "shell_output", id: "ph-other123", text: "nowhere" })]);
    expect(items(s)).toHaveLength(1);
    const out = (items(s)[0] as { output: string }).output;
    expect(out.length).toBeLessThanOrEqual(60_000);
    expect(out.endsWith("END")).toBe(true);
    // A catch-up that has it again doesn't add a second.
    expect(items(run([reset("a", 9, [started, { kind: "shell_output", id, text: "hi\n" }])], s))).toEqual([expect.objectContaining({ id, output: "hi\n" })]);
  });
});

describe("the commands, plan, context and usage a Mac with extras sends", () => {
  const todos: RemoteEvent = { kind: "todos", items: [{ content: "A", status: "pending", active_form: "Doing A" }] };
  const commands: RemoteEvent = { kind: "commands", commands: [{ name: "review", description: "Review", argument_hint: "" }] };
  const context = (tokens: number, window: number | null): RemoteEvent => ({ kind: "context", tokens, window });
  const done = (context_window: number | null): RemoteEvent => ({ kind: "turn_done", is_error: false, result: null, duration_ms: 1, context_window });

  it("are kept on the chat as they were last said, and the plan and context go with the conversation", () => {
    const s = run([event("a", 1, commands), event("a", 2, todos), event("a", 3, context(50_000, 200_000))]);
    expect(s.views.a).toMatchObject({ commands: [{ name: "review" }], todos: [{ content: "A" }], context: { tokens: 50_000, window: 200_000 } });
    // They are not messages: nothing is added to the chat's items.
    expect(items(s)).toEqual([]);
    expect(run([event("a", 4, { kind: "conversation_reset" })], s).views.a).toMatchObject({ todos: [], context: null });
  });

  it("keep the window the chat was last told when an event doesn't say it, and take the one a turn's result says", () => {
    let s = run([event("a", 1, context(50_000, 200_000)), event("a", 2, context(60_000, null))]);
    expect(s.views.a.context).toEqual({ tokens: 60_000, window: 200_000 });
    s = run([event("a", 3, done(1_000_000))], s);
    expect(s.views.a.context).toEqual({ tokens: 60_000, window: 1_000_000 });
    // A result before any context was said leaves it unsaid.
    expect(run([event("b", 1, done(200_000))]).views.b.context).toBeNull();
  });

  it("keep what runs in the background as it was last said, until the chat's claude ends or sleeps", () => {
    const background = (...tasks: string[]): RemoteEvent => ({ kind: "background", tasks });
    let s = run([event("a", 1, background("npm run dev", "cargo watch"))]);
    expect(s.views.a.background).toEqual(["npm run dev", "cargo watch"]);
    expect(items(s)).toEqual([]);
    s = run([event("a", 2, background("cargo watch"))], s);
    expect(s.views.a.background).toEqual(["cargo watch"]);
    expect(run([event("a", 3, { kind: "asleep", asleep: true })], s).views.a.background).toEqual([]);
    expect(run([event("a", 3, { kind: "asleep", asleep: false })], s).views.a.background).toEqual(["cargo watch"]);
    expect(run([event("a", 3, { kind: "session_ended", code: 0 })], s).views.a.background).toEqual([]);
  });

  it("stay through a catch-up that starts the chat over, and come again with it", () => {
    const hi: RemoteEvent = { kind: "user_text", text: "hi", at: 1, sent_by: null };
    const s = run([event("a", 1, commands), reset("a", 9, [hi])]);
    expect(s.views.a.commands).toEqual([expect.objectContaining({ name: "review" })]);
    const again = run([reset("a", 12, [hi, todos, context(70_000, 200_000)])], s);
    expect(again.views.a).toMatchObject({ todos: [{ content: "A" }], context: { tokens: 70_000, window: 200_000 } });
  });

  it("leave a chat as it is for an event of a kind this app doesn't know", () => {
    const s = run([event("a", 1, { kind: "user_text", text: "hi", at: 1, sent_by: null })]);
    const next = run([event("a", 2, { kind: "from_a_newer_mac" } as unknown as RemoteEvent)], s);
    expect(items(next)).toEqual(items(s));
    expect(next.views.a.seq).toBe(2);
  });

  it("make the account's usage the app's, whichever chat is open, and ignore a message it doesn't know", () => {
    const plan: Action = { type: "pushed", msg: { type: "plan", used: 0.4, resets_at: 99, status: "allowed" } };
    expect(run([plan]).plan).toEqual({ used: 0.4, resetsAt: 99, status: "allowed" });
    // The weekly window comes with it from a Mac that knows it, and is gone again from one message that doesn't have it.
    const withWeek: Action = { type: "pushed", msg: { type: "plan", used: 0.4, resets_at: 99, status: "allowed", week_used: 0.25, week_resets_at: 777 } };
    expect(run([withWeek]).plan).toEqual({ used: 0.4, resetsAt: 99, status: "allowed", week: { used: 0.25, resetsAt: 777 } });
    expect(run([withWeek, plan]).plan?.week).toBeUndefined();
    const unknown = { type: "from_a_newer_mac" } as unknown as Action extends { msg: infer M } ? M : never;
    const before = run([plan]);
    expect(reducer(before, { type: "pushed", msg: unknown } as Action)).toEqual(before);
  });
});

describe("when each working chat started", () => {
  const chatOf = (slot: string, status: "working" | "idle" | "asleep", active_at: number) => ({ slot, title: null, project: null, status, last_seq: 0, active_at, permissions: null, preset: null, project_color: null, workflow: null });
  const list = (...chats: ReturnType<typeof chatOf>[]): Action => ({ type: "pushed", msg: { type: "chats", chats } });

  it("is when the chat was first seen working, and holds as its activity moves on", () => {
    const s = run([list(chatOf("a", "working", 100), chatOf("b", "idle", 50)), list(chatOf("a", "working", 400), chatOf("b", "working", 410)), list(chatOf("a", "working", 900), chatOf("b", "working", 950))]);
    expect(s.workingSince).toEqual({ a: 100, b: 410 });
  });

  it("starts again for a chat that stopped and works anew, and forgets one that is no longer listed", () => {
    const s = run([list(chatOf("a", "working", 100), chatOf("gone", "working", 120)), list(chatOf("a", "idle", 200)), list(chatOf("a", "working", 700))]);
    expect(s.workingSince).toEqual({ a: 700 });
  });

  it("keeps the same object when nothing changed, so nothing redraws for it", () => {
    const first = run([list(chatOf("a", "working", 100))]);
    const again = reducer(first, list(chatOf("a", "working", 300)));
    expect(again.workingSince).toBe(first.workingSince);
  });
});
