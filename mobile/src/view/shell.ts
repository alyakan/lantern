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
