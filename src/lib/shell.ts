import type { ChatItem, ShellItem } from "../store";

/** How much of a command's output Claude gets: its last lines. */
export const CONTEXT_LINES = 200;
/** How much of a command's output a chat keeps (a dev server can print for hours): the end of it. */
export const KEEP_CHARS = 256_000;

// Colour and cursor codes (CSI), titles and links (OSC), and the short two-byte ones.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Output as a terminal would show it: no colour codes, and a line redrawn with \r (a progress bar) at its last draw. */
export function cleanOutput(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
    .join("\n");
}

/** The last `n` lines of `text`, and how many came before them. */
export function lastLines(text: string, n: number): { text: string; hidden: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= n) return { text: text.replace(/\n$/, ""), hidden: 0 };
  return { text: lines.slice(-n).join("\n"), hidden: lines.length - n };
}

/** Slash commands go to claude as they are: nothing can go before them. */
export const takesShellContext = (text: string) => !text.startsWith("/");

function ending(s: ShellItem): string {
  if (s.status === "running") return "[still running]";
  if (s.status === "stopped") return "[stopped]";
  return s.code ? `[exit code ${s.code}]` : "";
}

/**
 * The commands run since the last message, for Claude: in the tags Claude Code uses for its own `!` commands, so it
 * reads them the same way. Null when there are none.
 */
export function shellContext(items: ChatItem[]): string | null {
  const shells = items.filter((it): it is ShellItem => it.type === "shell" && !it.shared);
  if (shells.length === 0) return null;
  return shells
    .map((s) => {
      const { text, hidden } = lastLines(cleanOutput(s.output), CONTEXT_LINES);
      const out = [hidden ? `[${hidden} earlier lines left out]` : "", text, ending(s)].filter(Boolean).join("\n");
      return `<bash-input>${s.command}</bash-input>\n<bash-stdout>${out}</bash-stdout><bash-stderr></bash-stderr>`;
    })
    .join("\n");
}

/** The message as it goes to claude: the commands run since the last one first. */
export function withShellContext(items: ChatItem[], text: string): string {
  const context = takesShellContext(text) ? shellContext(items) : null;
  return context ? `${context}\n\n${text}` : text;
}

export interface SentShell {
  command: string;
  output: string;
  code: number | null;
  stopped: boolean;
}

const BLOCK = /^<bash-input>([\s\S]*?)<\/bash-input>\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*/;
const ENDING = /\n?\[(?:exit code (\d+)|(stopped)|still running)\]$/;

/** A prompt as you wrote it, and the commands that went before it (see shellContext). */
export function readShellContext(text: string): { text: string; shells: SentShell[] } {
  const shells: SentShell[] = [];
  let rest = text;
  for (let m = BLOCK.exec(rest); m; m = BLOCK.exec(rest)) {
    const end = ENDING.exec(m[2]);
    const output = [end ? m[2].slice(0, end.index) : m[2], m[3] ?? ""].filter(Boolean).join("\n");
    shells.push({ command: m[1], output, code: end?.[1] ? Number(end[1]) : end?.[2] ? null : 0, stopped: !!end?.[2] });
    rest = rest.slice(m[0].length);
  }
  return { text: rest, shells };
}
