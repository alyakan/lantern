/**
 * The terminal on the phone: a "!" at the start of the message box turns it into a terminal (as on the Mac), and what a
 * command prints is cleaned up the way the Mac's window does before it is shown.
 */

/** Whether the box is a terminal: it starts with "!". The "!" itself is not shown. */
export const isTerminal = (text: string) => text.startsWith("!");

/** What is typed after the "!". */
export const commandOf = (text: string) => (isTerminal(text) ? text.slice(1) : text);

/** How much of a command's output the phone keeps (a dev server can print for hours): the end of it. */
export const KEEP_CHARS = 60_000;
/** How many lines of it a card shows until it is opened. */
export const SHOWN_LINES = 40;
/** How long output has to stop mid-line before the command counts as asking something. */
export const PROMPT_PAUSE_MS = 400;

// Colour and cursor codes (CSI), titles and links (OSC), and the short two-byte ones.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// What is left of the control characters once lines are settled: a bell, a backspace, a stray escape. Tabs and newlines stay.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Output as a terminal would show it: no colour codes, and a line redrawn with \r (a progress bar) at its last draw. */
export function cleanOutput(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
    .join("\n")
    .replace(CONTROL, "");
}

/** The last `n` lines of `text`, and how many came before them. */
export function lastLines(text: string, n: number): { text: string; hidden: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= n) return { text: text.replace(/\n$/, ""), hidden: 0 };
  return { text: lines.slice(-n).join("\n"), hidden: lines.length - n };
}

/** The end of a command's output, kept to what a phone holds. */
export const keepEnd = (text: string) => (text.length > KEEP_CHARS ? text.slice(-KEEP_CHARS) : text);

let counter = 0;
/** An id for a command: the Mac accepts "ph-" and 4 to 28 letters or digits (its own are never like this). */
export function newShellId(now: number = Date.now()): string {
  return `ph-${now.toString(36)}${(++counter).toString(36)}`;
}

/** A command's end in a few words: "exit 1", "stopped", or nothing for one that ended cleanly with no code. */
export function endLine(status: "running" | "done" | "failed" | "stopped", code: number | null): string {
  if (status === "stopped") return "stopped";
  if (status === "running" || code === null) return "";
  return `exit ${code}`;
}

/** "12 s" or "1 min 5 s". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * What was typed, with the keyboard's smart punctuation undone: iOS turns "--" into a dash and straight quotes into curly
 * ones as you type, and neither means anything to a shell.
 */
export const plainTyped = (text: string) =>
  text
    .replace(/—/g, "--")
    .replace(/[–−]/g, "-")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/…/g, "...");

// Spaces that look like a space and aren't one to a shell: text copied from a web page, Slack or Notes brings them.
const ODD_SPACES = /[   ]/g;
// What a line can end with that already joins it to the next one.
const JOINS = /(?:&&|\|\||\||;|&)$/;

/**
 * A command as it was typed or pasted, made into the one line the Mac runs: a pasted command often comes with line breaks
 * (Windows ones too), lines continued with "\", and spaces that aren't spaces. A line break between two commands is a "; "
 * (as it is in a script: the next runs after the last, whatever it did), a line that ends with "&&", "|" and the like or is
 * continued with "\" goes on with a space, blank lines and the break at the very end go, and smart punctuation is undone.
 * Only these harmless kinds are put right: a character that can't be seen is left in, to be refused (see `hasHiddenChars`).
 */
export function commandTyped(text: string): string {
  const lines = plainTyped(text.replace(ODD_SPACES, " ")).replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1) return lines[0];
  let out = "";
  lines.forEach((raw, i) => {
    // The last line is still being typed: its spaces are kept. The others lose the spaces at their ends. Only spaces and tabs:
    // trim() would also take a byte order mark or a line separator, which must stay to be refused.
    const line = i === lines.length - 1 ? raw.replace(/^[ \t]+/, "") : raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!line) return;
    if (!out) out = line;
    else if (out.endsWith("\\")) out = `${out.slice(0, -1).replace(/[ \t]+$/, "")} ${line}`;
    else out = `${out}${JOINS.test(out) ? " " : "; "}${line}`;
  });
  return out;
}

// Characters that draw nothing, or draw backwards, so a command can read one way and run another, as code point ranges:
// controls (a tab is fine), the soft hyphen, the Arabic letter mark, the Mongolian vowel separator, zero-width and joining
// marks and direction marks, line and paragraph separators and bidirectional overrides, word joiners and invisible operators,
// bidirectional isolates and the other format controls, and the byte order mark. Numbers, not an escaped regular
// expression: a line separator in a regular expression would split it.
const HIDDEN: [number, number][] = [
  [0x00, 0x08],
  [0x0a, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];

/** Whether `text` has a character that can't be seen, or that changes how the text around it is drawn (never in a command to run). */
export function hasHiddenChars(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (HIDDEN.some(([from, to]) => c >= from && c <= to)) return true;
  }
  return false;
}

/** How many of a command's last lines go to Claude when it is told, and how much text at most. */
export const TELL_LINES = 60;
export const TELL_MAX_CHARS = 4000;

/**
 * A message that tells Claude what a command run from the phone's terminal printed: the command, how it ended and the end of
 * its output, in a code block that cannot be closed early by anything in the output. It goes into the message box to be read and
 * sent by the person, never sent for them: the output is whatever the command printed, secrets included.
 */
export function tellClaude(command: string, rawOutput: string, status: "running" | "done" | "failed" | "stopped", code: number | null): string {
  const out = lastLines(cleanOutput(rawOutput), TELL_LINES);
  let body = out.text.length > TELL_MAX_CHARS ? out.text.slice(-TELL_MAX_CHARS) : out.text;
  const cutStart = out.hidden > 0 || body.length < out.text.length;
  // The fence is longer than any run of backticks in the output, so the output can't end the block.
  const longest = Math.max(2, ...[...(body + command).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const end = endLine(status, code);
  return [`I ran this in the terminal on my Mac${end ? ` (${end})` : ""}:`, "", fence, `$ ${command}`, ...(cutStart ? ["… (the start of the output is left out)"] : []), body, fence].join("\n");
}
