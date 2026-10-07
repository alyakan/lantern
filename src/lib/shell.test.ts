import { describe, expect, it } from "vitest";
import { initialState, reducer, type ChatItem, type ShellItem, type State } from "../store";
import { cleanOutput, lastLines, readShellContext, shellContext, withShellContext } from "./shell";

const shell = (over: Partial<ShellItem> = {}): ShellItem => ({ type: "shell", id: "s1", command: "git status", output: "On branch main\n", status: "done", code: 0, startedAt: 1, endedAt: 2, shared: false, ...over });

describe("cleanOutput", () => {
  it("drops colour codes and keeps a redrawn line's last draw", () => {
    expect(cleanOutput("\x1b[32mok\x1b[0m\r\n 10%\r 50%\r100%\ndone\n")).toBe("ok\n100%\ndone\n");
  });
});

describe("lastLines", () => {
  it("keeps the end and counts what's left out", () => {
    expect(lastLines("a\nb\nc\n", 2)).toEqual({ text: "b\nc", hidden: 1 });
    expect(lastLines("a\nb\n", 5)).toEqual({ text: "a\nb", hidden: 0 });
  });
});

describe("shell context", () => {
  it("puts the commands not sent yet before the message, in Claude Code's tags", () => {
    const items: ChatItem[] = [shell({ shared: true, command: "ls" }), shell(), shell({ id: "s2", command: "npm test", output: "1 failed\n", status: "failed", code: 1 })];
    expect(withShellContext(items, "why did it fail?")).toBe(
      "<bash-input>git status</bash-input>\n<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>\n" +
        "<bash-input>npm test</bash-input>\n<bash-stdout>1 failed\n[exit code 1]</bash-stdout><bash-stderr></bash-stderr>\n\nwhy did it fail?",
    );
  });

  it("sends only the end of long output, and says when a command is still going", () => {
    const output = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const context = shellContext([shell({ command: "npm run dev", output, status: "running", code: null })])!;
    expect(context).toContain("[50 earlier lines left out]\nline 50\n");
    expect(context).toContain("line 249\n[still running]</bash-stdout>");
  });

  it("leaves slash commands alone, and messages with nothing run", () => {
    expect(withShellContext([shell()], "/compact")).toBe("/compact");
    expect(withShellContext([shell({ shared: true })], "hi")).toBe("hi");
  });

  it("reads the commands back from a sent message", () => {
    const sent = withShellContext([shell(), shell({ id: "s2", command: "make", output: "boom\n", status: "failed", code: 2 }), shell({ id: "s3", command: "sleep 9", output: "", status: "stopped", code: null })], "help");
    expect(readShellContext(sent)).toEqual({
      text: "help",
      shells: [
        { command: "git status", output: "On branch main", code: 0, stopped: false },
        { command: "make", output: "boom", code: 2, stopped: false },
        { command: "sleep 9", output: "", code: null, stopped: true },
      ],
    });
    expect(readShellContext("plain")).toEqual({ text: "plain", shells: [] });
  });
});

describe("reducer and shells", () => {
  const idle: State = { ...initialState, status: "idle" };

  it("streams a command's output and records how it ended", () => {
    let s = reducer(idle, { type: "shell_started", id: "s1", command: "npm test" });
    s = reducer(s, { type: "ui_event", event: { kind: "shell_output", id: "s1", text: "ok " } });
    s = reducer(s, { type: "ui_event", event: { kind: "shell_output", id: "s1", text: "1 failed\n" } });
    expect(s.items[0]).toMatchObject({ type: "shell", output: "ok 1 failed\n", status: "running", shared: false });
    expect(s.status).toBe("idle");
    s = reducer(s, { type: "ui_event", event: { kind: "shell_done", id: "s1", code: 1, stopped: false } });
    expect(s.items[0]).toMatchObject({ status: "failed", code: 1, endedAt: expect.any(Number) });
    expect(reducer(s, { type: "ui_event", event: { kind: "shell_done", id: "s1", code: null, stopped: true } }).items[0]).toMatchObject({ status: "stopped" });
  });

  it("marks commands as sent with the next message, but not with a slash command", () => {
    const s = reducer(idle, { type: "shell_started", id: "s1", command: "ls" });
    expect(reducer(s, { type: "user_sent", text: "/clear" }).items[0]).toMatchObject({ shared: false });
    expect(reducer(s, { type: "user_sent", text: "what's here?" }).items[0]).toMatchObject({ shared: true });
  });

  it("brings the commands back from a reopened session, before the prompt they went with", () => {
    const text = withShellContext([shell()], "summarise");
    const s = reducer(idle, { type: "ui_event", event: { kind: "user_text", text, at: 5 } });
    expect(s.items.map((it) => it.type)).toEqual(["shell", "user"]);
    expect(s.items[0]).toMatchObject({ command: "git status", output: "On branch main", status: "done", shared: true });
    expect(s.items[1]).toMatchObject({ text: "summarise" });
  });
});
