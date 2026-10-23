import { cleanOutput, commandOf, endLine, isTerminal, keepEnd, KEEP_CHARS, lastLines, newShellId, plainTyped, took } from "./shell";

describe("terminal mode", () => {
  it("starts with a '!', which is not part of the command", () => {
    expect(isTerminal("!git status")).toBe(true);
    expect(isTerminal("!")).toBe(true);
    expect(isTerminal(" !git")).toBe(false);
    expect(isTerminal("hello !")).toBe(false);
    expect(commandOf("!git status")).toBe("git status");
    expect(commandOf("!")).toBe("");
    expect(commandOf("plain")).toBe("plain");
  });
});

describe("cleanOutput", () => {
  it("drops colour codes and keeps a redrawn line's last draw", () => {
    expect(cleanOutput("\x1b[32mok\x1b[0m\r\n 10%\r 50%\r100%\ndone\n")).toBe("ok\n100%\ndone\n");
  });

  it("drops titles and links, and the control characters that would draw as boxes, but keeps tabs", () => {
    expect(cleanOutput("\x1b]0;title\x07a\tb\x07\x08c\n")).toBe("a\tbc\n");
    expect(cleanOutput("\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
});

describe("lastLines", () => {
  it("keeps the end and counts what's left out", () => {
    expect(lastLines("a\nb\nc\n", 2)).toEqual({ text: "b\nc", hidden: 1 });
    expect(lastLines("a\nb\n", 5)).toEqual({ text: "a\nb", hidden: 0 });
  });
});

describe("keepEnd", () => {
  it("keeps all of a short output and the end of a long one", () => {
    expect(keepEnd("short")).toBe("short");
    const long = "x".repeat(KEEP_CHARS) + "tail";
    expect(keepEnd(long)).toHaveLength(KEEP_CHARS);
    expect(keepEnd(long).endsWith("tail")).toBe(true);
  });
});

describe("newShellId", () => {
  it("is what the Mac accepts from a phone: ph- and 4 to 28 letters or digits, and never the same twice", () => {
    const a = newShellId(1_700_000_000_000);
    const b = newShellId(1_700_000_000_000);
    expect(a).toMatch(/^ph-[a-z0-9]{4,28}$/);
    expect(a).not.toBe(b);
  });
});

describe("how a command ended", () => {
  it("says the exit code or that it was stopped, and nothing while running", () => {
    expect(endLine("failed", 1)).toBe("exit 1");
    expect(endLine("done", 0)).toBe("exit 0");
    expect(endLine("stopped", null)).toBe("stopped");
    expect(endLine("running", null)).toBe("");
    expect(endLine("failed", null)).toBe("");
    expect(took(12_000)).toBe("12 s");
    expect(took(65_000)).toBe("1 min 5 s");
  });
});

describe("plainTyped", () => {
  it("undoes iOS's smart dashes, quotes and ellipsis, which a shell can't read", () => {
    expect(plainTyped("git log —oneline –x")).toBe("git log --oneline -x");
    expect(plainTyped("echo “hi” ‘there’")).toBe(`echo "hi" 'there'`);
    expect(plainTyped("wait…")).toBe("wait...");
    expect(plainTyped("plain -- text")).toBe("plain -- text");
  });
});
