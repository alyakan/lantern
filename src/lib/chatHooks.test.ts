import { describe, expect, it } from "vitest";
import { choiceOf, hookFor, HOOK_MAX, NO_HOOKS, POST_PREFIX, postText, readHooks, withProjectHook, type HookTable } from "./chatHooks";

const table = (over: Partial<HookTable> = {}): HookTable => ({ ...NO_HOOKS, ...over });

describe("readHooks", () => {
  it("takes nothing from what is not a table", () => {
    expect(readHooks(null)).toEqual(NO_HOOKS);
    expect(readHooks("pre")).toEqual(NO_HOOKS);
    expect(readHooks({ pre: 3, post: [], projects: 7 })).toEqual(NO_HOOKS);
  });

  it("keeps well-formed hooks, and a hook that isn't switched on is off", () => {
    const read = readHooks({ pre: { text: "check", on: true }, post: { text: "save" }, projects: { "/p": { pre: { text: "own", on: true }, post: "x" }, "/q": {} } });
    expect(read.pre).toEqual({ text: "check", on: true });
    expect(read.post).toEqual({ text: "save", on: false });
    expect(read.projects).toEqual({ "/p": { pre: { text: "own", on: true } } });
  });

  it("cuts a hook to the limit", () => {
    expect(readHooks({ pre: { text: "a".repeat(HOOK_MAX + 10), on: true } }).pre.text).toHaveLength(HOOK_MAX);
  });
});

describe("hookFor", () => {
  const t = table({ pre: { text: " check the brain ", on: true }, post: { text: "update", on: false }, projects: { "/p": { pre: { text: "own", on: true }, post: { text: "save it", on: true } } } });

  it("uses the workspace's hook when the project has none of its own, trimmed, and none when it is off", () => {
    expect(hookFor(t, "/other", "pre")).toBe("check the brain");
    expect(hookFor(t, "/other", "post")).toBeNull();
    expect(hookFor(t, null, "pre")).toBe("check the brain");
  });

  it("uses a project's own, even where the workspace's is off", () => {
    expect(hookFor(t, "/p", "pre")).toBe("own");
    expect(hookFor(t, "/p", "post")).toBe("save it");
  });

  it("a project's hook that is off means none, not the workspace's", () => {
    expect(hookFor(withProjectHook(t, "/other", "pre", "off", "anything"), "/other", "pre")).toBeNull();
  });

  it("an empty hook is none", () => {
    expect(hookFor(table({ pre: { text: "  ", on: true } }), "/p", "pre")).toBeNull();
  });
});

describe("withProjectHook and choiceOf", () => {
  it("sets a project's own hook, and reads how the project stands", () => {
    const t = withProjectHook(NO_HOOKS, "/p", "pre", "custom", "read NOTES.md");
    expect(choiceOf(t, "/p", "pre")).toEqual({ choice: "custom", text: "read NOTES.md" });
    expect(choiceOf(t, "/p", "post")).toEqual({ choice: "workspace", text: "" });
    expect(choiceOf(withProjectHook(t, "/p", "post", "off", ""), "/p", "post").choice).toBe("off");
  });

  it("keeps the words of a hook that is off, so switching it back on finds them", () => {
    const t = withProjectHook(withProjectHook(NO_HOOKS, "/p", "pre", "custom", "read NOTES.md"), "/p", "pre", "off", "read NOTES.md");
    expect(choiceOf(t, "/p", "pre")).toEqual({ choice: "off", text: "read NOTES.md" });
  });

  it("drops a project left with nothing of its own", () => {
    const t = withProjectHook(NO_HOOKS, "/p", "pre", "custom", "x");
    expect(withProjectHook(t, "/p", "pre", "workspace", "")).toEqual(NO_HOOKS);
    // Another hook of the project stays.
    const both = withProjectHook(t, "/p", "post", "custom", "y");
    expect(withProjectHook(both, "/p", "pre", "workspace", "").projects).toEqual({ "/p": { post: { text: "y", on: true } } });
  });

  it("changes nothing for the other projects", () => {
    const t = withProjectHook(NO_HOOKS, "/q", "pre", "custom", "q's");
    expect(withProjectHook(t, "/p", "pre", "custom", "p's").projects["/q"]).toEqual({ pre: { text: "q's", on: true } });
  });
});

describe("postText", () => {
  it("reads the post-hook out of its message, and nothing else", () => {
    expect(postText(`${POST_PREFIX}update the brain`)).toBe("update the brain");
    expect(postText("update the brain")).toBeNull();
  });
});
