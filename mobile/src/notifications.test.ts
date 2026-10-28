import { pushLine, registerForPush, slotOfNotification, type PushPlatform } from "./notifications";

function platform(over: Partial<PushPlatform> = {}) {
  const calls: string[] = [];
  const p: PushPlatform = {
    isDevice: true,
    getPermission: async () => (calls.push("get"), "undetermined"),
    requestPermission: async () => (calls.push("request"), "granted"),
    getToken: async (id) => (calls.push(`token ${id}`), "ExponentPushToken[abc]"),
    prepareChannel: async () => void calls.push("channel"),
    ...over,
  };
  return { p, calls };
}

describe("registering for notifications", () => {
  it("does nothing without an Expo project id, and says so (and never reaches Expo)", async () => {
    const { p, calls } = platform();
    const send = jest.fn();
    expect(await registerForPush(p, undefined, send)).toEqual({ kind: "no-project" });
    expect(calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks permission, gets the token for the project and gives it to the Mac", async () => {
    const { p, calls } = platform();
    const send = jest.fn(async () => {});
    expect(await registerForPush(p, "proj-1", send)).toEqual({ kind: "registered", token: "ExponentPushToken[abc]" });
    expect(calls).toEqual(["channel", "get", "request", "token proj-1"]);
    expect(send).toHaveBeenCalledWith("ExponentPushToken[abc]");
  });

  it("on an iPhone gives the Mac the phone's own token, with no Expo project at all", async () => {
    const { p, calls } = platform({ getDeviceToken: async () => (calls2.push("device"), "ab".repeat(32)) });
    const calls2: string[] = [];
    const send = jest.fn(async () => {});
    expect(await registerForPush(p, undefined, send)).toEqual({ kind: "registered", token: "ab".repeat(32) });
    expect(calls2).toEqual(["device"]);
    expect(calls.some((c) => c.startsWith("token"))).toBe(false);
    expect(send).toHaveBeenCalledWith("ab".repeat(32));
  });

  it("doesn't ask again when permission is already given", async () => {
    const { p, calls } = platform({ getPermission: async () => "granted" });
    await registerForPush(p, "proj-1", async () => {});
    expect(calls).not.toContain("request");
  });

  it("says when permission is refused, when this isn't a phone, and when something failed", async () => {
    expect(await registerForPush(platform({ getPermission: async () => "denied", requestPermission: async () => "denied" }).p, "p", jest.fn())).toEqual({ kind: "denied" });
    expect(await registerForPush(platform({ isDevice: false }).p, "p", jest.fn())).toEqual({ kind: "not-a-phone" });
    expect(await registerForPush(platform({ getToken: async () => { throw new Error("no network"); } }).p, "p", jest.fn())).toEqual({ kind: "failed", why: "no network" });
    expect(await registerForPush(platform().p, "p", async () => { throw new Error("The Mac said no"); })).toEqual({ kind: "failed", why: "The Mac said no" });
  });
});

describe("a tapped notification", () => {
  it("opens the chat it names, and nothing else", () => {
    expect(slotOfNotification({ slot: "release", kind: "needs_you" })).toBe("release");
    for (const bad of [null, "x", {}, { slot: 5 }, { slot: "" }, { slot: "a/b" }, { slot: "x".repeat(17) }, { slot: "../etc" }]) expect(slotOfNotification(bad)).toBeNull();
  });

  it("says where push stands in words", () => {
    expect(pushLine({ kind: "registered", token: "t" })).toBe("Notifications are on.");
    expect(pushLine({ kind: "denied" })).toContain("Turn them on");
    expect(pushLine({ kind: "no-project" })).toContain("aren't set up");
    expect(pushLine({ kind: "failed", why: "x" })).toContain("x");
    expect(pushLine(null)).toBe("");
  });
});
