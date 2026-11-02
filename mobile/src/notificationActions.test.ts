import { ACTION_ALLOW, ACTION_DENY, ACTION_REPLY, ACTION_TODO_DONE, ACTION_TODO_SNOOZE, ACTION_TODO_TOMORROW, CATEGORIES, CATEGORY_DECIDE, CATEGORY_REPLY, CATEGORY_TODO, connectedWithin, requestIdOfNotification, runButton, TAP, type ActionHost, type Link, type ResponseLike } from "./notificationActions";

function host(over: Partial<ActionHost> = {}) {
  const calls: string[] = [];
  const told: string[][] = [];
  const h: ActionHost = {
    lockOn: async () => false,
    connected: async () => true,
    answer: async (slot, id, allow) => void calls.push(`answer ${slot} ${id} ${allow}`),
    send: async (slot, text) => void calls.push(`send ${slot} ${text}`),
    todoEdit: async (project, edit) => void calls.push(`todo ${project} ${JSON.stringify(edit)}`),
    tell: async (title, body) => void told.push([title, body]),
    ...over,
  };
  return { h, calls, told };
}

const response = (action: string, data: unknown = { slot: "release", kind: "needs_you", request_id: "p1" }, extra: Partial<ResponseLike> = {}): ResponseLike => ({
  actionIdentifier: action,
  notification: { request: { identifier: "n1", content: { data } } },
  ...extra,
});

describe("the buttons notifications have", () => {
  it("asks for the phone to be unlocked before Allow and Reply, but not before Deny, and never opens the app", () => {
    const button = (id: string) => CATEGORIES.flatMap((c) => c.actions).find((a) => a.identifier === id)!;
    expect(button(ACTION_ALLOW).options.isAuthenticationRequired).toBe(true);
    expect(button(ACTION_REPLY).options.isAuthenticationRequired).toBe(true);
    expect(button(ACTION_DENY).options).toMatchObject({ isAuthenticationRequired: false, isDestructive: true });
    for (const a of CATEGORIES.flatMap((c) => c.actions)) expect(a.options.opensAppToForeground).toBe(false);
    expect(button(ACTION_REPLY).textInput).toBeTruthy();
  });

  it("are filed under the names the Mac's push uses", () => {
    expect(CATEGORIES.map((c) => c.identifier)).toEqual([CATEGORY_DECIDE, CATEGORY_REPLY, CATEGORY_TODO]);
    expect([CATEGORY_DECIDE, CATEGORY_REPLY, CATEGORY_TODO]).toEqual(["lantern_decide", "lantern_reply", "lantern_todo"]);
  });
});

describe("a reminder's buttons", () => {
  const token = "0123456789abcdef";
  const reminder = (action: string, data: unknown = { slot: "", kind: "todo", project: token, todo: "ab12" }) => response(action, data);

  it("put the reminder off an hour or to tomorrow, or tick the item off, on the project the push named", async () => {
    const { h, calls } = host();
    expect(await runButton(reminder(ACTION_TODO_SNOOZE), h, new Set())).toEqual({ kind: "todo", edit: "snooze" });
    expect(await runButton(reminder(ACTION_TODO_DONE), h, new Set())).toEqual({ kind: "todo", edit: "done" });
    expect(calls[0]).toMatch(/^todo 0123456789abcdef \{"op":"snooze","id":"ab12","until":\d+\}$/);
    expect(calls[1]).toBe('todo 0123456789abcdef {"op":"done","id":"ab12","done":true}');
    await runButton(reminder(ACTION_TODO_TOMORROW), h, new Set());
    const until = JSON.parse(calls[2].split(" ").slice(2).join(" ")).until;
    expect(new Date(until).getHours()).toBe(9);
  });

  it("asks for the phone unlocked before Done but not before putting it off, and Done respects Lantern's lock", async () => {
    const button = (id: string) => CATEGORIES.flatMap((c) => c.actions).find((a) => a.identifier === id)!;
    expect(button(ACTION_TODO_DONE).options.isAuthenticationRequired).toBe(true);
    expect(button(ACTION_TODO_SNOOZE).options.isAuthenticationRequired).toBe(false);
    const { h, calls, told } = host({ lockOn: async () => true });
    expect((await runButton(reminder(ACTION_TODO_DONE), h, new Set())).kind).toBe("failed");
    expect(told[0][1]).toMatch(/locked/);
    expect((await runButton(reminder(ACTION_TODO_SNOOZE), h, new Set())).kind).toBe("todo");
    expect(calls).toHaveLength(1);
  });

  it("does nothing with a push that names no item, or names its project by anything but a token", async () => {
    const { h, calls } = host();
    for (const data of [{ kind: "todo", project: token }, { kind: "todo", project: "/Users/me/app", todo: "ab" }, { kind: "needs_you", slot: "a", project: token, todo: "ab" }]) {
      expect((await runButton(reminder(ACTION_TODO_DONE, data), h, new Set())).kind).toBe("failed");
    }
    expect(calls).toEqual([]);
  });
});

describe("what a button does", () => {
  it("allows or denies the very prompt the notification named, in its chat", async () => {
    const a = host();
    expect(await runButton(response(ACTION_ALLOW), a.h, new Set())).toEqual({ kind: "answered", allow: true });
    const d = host();
    expect(await runButton(response(ACTION_DENY), d.h, new Set())).toEqual({ kind: "answered", allow: false });
    expect(a.calls).toEqual(["answer release p1 true"]);
    expect(d.calls).toEqual(["answer release p1 false"]);
  });

  it("sends what was typed into the chat the notification named", async () => {
    const { h, calls } = host();
    expect(await runButton(response(ACTION_REPLY, { slot: "release", kind: "finished" }, { userText: "  now run the tests  " }), h, new Set())).toEqual({ kind: "sent" });
    expect(calls).toEqual(["send release now run the tests"]);
  });

  it("does nothing for a tap, for an empty reply, or for a button it doesn't know", async () => {
    const { h, calls, told } = host();
    for (const r of [response(TAP), response(ACTION_REPLY, { slot: "a" }, { userText: "   " }), response("something-else")]) expect(await runButton(r, h, new Set())).toEqual({ kind: "ignored" });
    expect(calls).toEqual([]);
    expect(told).toEqual([]);
  });

  it("does the same press once, even when the response arrives again", async () => {
    const { h, calls } = host();
    const seen = new Set<string>();
    await runButton(response(ACTION_ALLOW), h, seen);
    expect(await runButton(response(ACTION_ALLOW), h, seen)).toEqual({ kind: "ignored" });
    expect(calls).toHaveLength(1);
    // Another notification, or the other button on it, is another press.
    await runButton({ ...response(ACTION_DENY), notification: { request: { identifier: "n2", content: { data: { slot: "release", request_id: "p2" } } } } }, h, seen);
    expect(calls).toHaveLength(2);
  });

  it("answers a prompt it can't place, or a Mac it can't reach, in a notification, and sends nothing", async () => {
    const lost = host();
    expect((await runButton(response(ACTION_ALLOW, { slot: "release" }), lost.h, new Set())).kind).toBe("failed");
    expect(lost.calls).toEqual([]);
    expect(lost.told[0][0]).toBe("Couldn't allow that");
    const away = host({ connected: async () => false });
    expect((await runButton(response(ACTION_DENY), away.h, new Set())).kind).toBe("failed");
    expect(away.calls).toEqual([]);
    expect(away.told[0]).toEqual(["Couldn't deny that", "Lantern couldn't reach your Mac. Open Lantern to do it."]);
    const mute = host({ connected: async () => false });
    await runButton(response(ACTION_REPLY, { slot: "a" }, { userText: "hi" }), mute.h, new Set());
    expect(mute.told[0][0]).toBe("Couldn't send your reply");
  });

  it("won't allow or reply while Lantern's own lock is on (that would get round it), but still denies", async () => {
    const a = host({ lockOn: async () => true });
    expect((await runButton(response(ACTION_ALLOW), a.h, new Set())).kind).toBe("failed");
    expect((await runButton(response(ACTION_REPLY, { slot: "a" }, { userText: "hi", notification: { request: { identifier: "n9", content: { data: { slot: "a" } } } } }), a.h, new Set())).kind).toBe("failed");
    expect(a.calls).toEqual([]);
    expect(a.told.map((t) => t[1])).toEqual(["Lantern is locked. Open Lantern to do it.", "Lantern is locked. Open Lantern to do it."]);
    expect(await runButton(response(ACTION_DENY), a.h, new Set())).toEqual({ kind: "answered", allow: false });
    expect(a.calls).toEqual(["answer release p1 false"]);
    // A lock that can't be read counts as on.
    const unknown = host({ lockOn: async () => { throw new Error("no"); } });
    expect((await runButton(response(ACTION_ALLOW), unknown.h, new Set())).kind).toBe("failed");
  });

  it("says why the Mac refused (the prompt was answered somewhere else already)", async () => {
    const { h, told } = host({ answer: async () => { throw new Error("That was answered already, or Claude stopped asking."); } });
    expect(await runButton(response(ACTION_ALLOW), h, new Set())).toEqual({ kind: "failed", why: "That was answered already, or Claude stopped asking." });
    expect(told).toEqual([["Couldn't allow that", "That was answered already, or Claude stopped asking."]]);
  });

  it("takes only an id and a chat that look like ones the Mac gives", async () => {
    expect(requestIdOfNotification({ request_id: "toolu_01A-b.c:d" })).toBe("toolu_01A-b.c:d");
    for (const bad of [null, "x", {}, { request_id: 5 }, { request_id: "" }, { request_id: "a b" }, { request_id: "../x" }, { request_id: "x".repeat(101) }]) expect(requestIdOfNotification(bad)).toBeNull();
    const { h, calls } = host();
    expect((await runButton(response(ACTION_ALLOW, { slot: "../etc", request_id: "p1" }), h, new Set())).kind).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("waiting for a connection that works", () => {
  function link(over: Partial<Link> & { steps?: number } = {}) {
    let t = 0;
    const log: string[] = [];
    const l: Link = {
      now: () => t,
      up: () => true,
      alive: async () => true,
      redial: () => void log.push("redial"),
      changed: async (ms) => void (t += ms),
      ...over,
    };
    return { l, log };
  }

  it("trusts a connection once the Mac has answered over it", async () => {
    const { l, log } = link();
    expect(await connectedWithin(l, 20_000)).toBe(true);
    // It dials once at the start (an app woken from the background may have a link the phone dropped).
    expect(log).toEqual(["redial"]);
  });

  it("doesn't trust one that says it is up but doesn't answer, and dials again until one does", async () => {
    let tries = 0;
    const { l, log } = link({ alive: async () => ++tries >= 3 });
    expect(await connectedWithin(l, 20_000)).toBe(true);
    expect(tries).toBe(3);
    expect(log.length).toBeGreaterThanOrEqual(3);
  });

  it("waits for the connection to come up, and gives up when the time is gone", async () => {
    let up = false;
    let waits = 0;
    const { l } = link({ up: () => up, changed: async (ms) => { waits++; if (waits === 2) up = true; return void ms; } });
    expect(await connectedWithin(l, 20_000)).toBe(true);
    expect(waits).toBe(2);
    expect(await connectedWithin(link({ up: () => false }).l, 5_000)).toBe(false);
  });

  it("counts an answer that throws as no answer", async () => {
    const { l } = link({ alive: async () => { throw new Error("closed"); } });
    expect(await connectedWithin(l, 3_000)).toBe(false);
  });
});
