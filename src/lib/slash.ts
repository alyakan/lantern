import type { SlashCommand } from "../types";

/** The command name being typed: the text after a leading "/", until the first space. Null when not typing one. */
export function slashQuery(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1) : null;
}

/**
 * Commands matching what's typed, best first: names that start with it, then names with a part (after ":" or "-")
 * that starts with it, then names that contain it anywhere. Shorter names win ties, so "compact" beats "compact-x".
 */
export function matchCommands(commands: SlashCommand[], query: string, limit = 8): SlashCommand[] {
  const q = query.toLowerCase();
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[:\-]/).some((part) => part.startsWith(q))) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return commands
    .map((c) => ({ c, r: rank(c.name) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}
