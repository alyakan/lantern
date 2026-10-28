import { cleanOutput, commandOf, endLine, isTerminal, keepEnd, KEEP_CHARS, hasHiddenChars, lastLines, newShellId, plainTyped, tellClaude, TELL_LINES, took } from "./shell";

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

/** Characters built from their code points, so the test says what it tries (they can't be seen in a source file). */
const chars = (...codes: number[]) => codes.map((c) => String.fromCodePoint(c));

describe("hasHiddenChars", () => {
  it("finds what can't be seen or draws backwards, and lets a tab and ordinary text through, accents and other scripts too", () => {
    const bidiAndZeroWidth = chars(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0xad, 0x61c, 0x2028, 0x2029);
    const controls = chars(0x00, 0x01, 0x08, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9f);
    for (const c of [...bidiAndZeroWidth, ...controls]) expect(hasHiddenChars(`ls ${c} -la`)).toBe(true);
    expect(hasHiddenChars(`${String.fromCodePoint(0xfeff)}ls`)).toBe(true);
    for (const fine of ["git status", "printf 'a\tb'", "echo café", "echo 日本語 😀", "ls -la ~/Documents", 'echo "quoted"']) expect(hasHiddenChars(fine)).toBe(false);
  });
});

describe("tellClaude", () => {
  it("says what was run, how it ended and what it printed, in a block", () => {
    expect(tellClaude("npm test", "1 failed\n\x1b[31mFAIL\x1b[0m a.test.ts\n", "failed", 1)).toBe("I ran this in the terminal on my Mac (exit 1):\n\n```\n$ npm test\n1 failed\nFAIL a.test.ts\n```");
  });

  it("keeps the end of a long output and says the start is left out", () => {
    const out = Array.from({ length: TELL_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
    const text = tellClaude("make", out, "done", 0);
    expect(text).toContain("(the start of the output is left out)");
    expect(text).toContain(`line ${TELL_LINES + 9}`);
    expect(text).not.toContain("line 0\n");
  });

  it("uses a fence the output cannot close early", () => {
    const text = tellClaude("echo", "```\nsneaky\n```", "done", 0);
    expect(text.split("\n")[2]).toBe("````");
    expect(text.endsWith("````")).toBe(true);
  });
});
