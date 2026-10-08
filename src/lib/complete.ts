import type { SkillEntry, SlashCommand } from "../types";

/** A "/" or "@" word being typed, wherever it is in the message: what follows it, and where it sits in the text. */
export interface Trigger {
  kind: "/" | "@";
  query: string;
  start: number;
  end: number;
  /** At the very start of the message: where slash commands run. */
  atStart: boolean;
}

/**
 * The word the caret is in (or just after), when it starts with "/" or "@" at the start of the message or after a
 * space or new line. "src/foo" and "me@example.com" aren't triggers: the sign has to start the word.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const sign = text[start];
  if (sign !== "/" && sign !== "@") return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const query = text.slice(start + 1, caret);
  // A second "/" makes it a path ("/Users/…"), not a command.
  if (sign === "/" && query.includes("/")) return null;
  return { kind: sign, query, start, end, atStart: start === 0 };
}

/** Puts `value` in place of the trigger's word, with a space after it; returns the text and where the caret goes. */
export function replaceTrigger(text: string, t: Trigger, value: string): { text: string; caret: number } {
  const after = text.slice(t.end);
  const insert = after.startsWith(" ") ? value : `${value} `;
  return { text: text.slice(0, t.start) + insert + after, caret: t.start + insert.length };
}

export type CommandKind = "skill" | "command" | "mcp";

/** A slash command as the menu shows it: what it is and where it comes from. */
export interface MenuCommand extends SlashCommand {
  kind: CommandKind;
  /** "Yours", "Project", a plugin's name, "Built-in", an MCP server's name. */
  source: string;
}

// claude ends a custom command's or skill's description with where it's from: "(user)", "(project)", "(plugin:x)".
const SOURCE_SUFFIX = /\s*\((user|project|bundled|plugin[^)]*|MCP)\)$/;

/** Claude's commands, told apart with what's on disk: skills, commands (built-in or custom) and MCP prompts. */
export function describeCommands(commands: SlashCommand[], index: SkillEntry[]): MenuCommand[] {
  const byName = new Map(index.map((e) => [e.name, e]));
  return commands.map((c): MenuCommand => {
    const description = c.description.replace(SOURCE_SUFFIX, "");
    const suffix = SOURCE_SUFFIX.exec(c.description)?.[1];
    if (c.name.startsWith("mcp__") || suffix === "MCP") {
      const server = c.name.startsWith("mcp__") ? c.name.split("__")[1] : c.name.split(":")[0];
      return { ...c, description, kind: "mcp", source: serverLabel(server) };
    }
    const found = byName.get(c.name);
    if (found) return { ...c, description, kind: found.kind, source: found.source === "user" ? "Yours" : found.source === "project" ? "Project" : (found.plugin ?? "Plugin") };
    if (suffix === "user" || suffix === "project") return { ...c, description, kind: "command", source: suffix === "user" ? "Yours" : "Project" };
    const plugin = c.name.includes(":") ? c.name.split(":")[0] : null;
    return { ...c, description, kind: plugin ? "skill" : "command", source: plugin ?? "Built-in" };
  });
}

/** An MCP server's name as tool names carry it ("claude_ai_Linear"), as people know it ("Linear"). */
export const serverLabel = (raw: string) => raw.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "").replace(/_/g, " ");

export const SECTION_TITLE: Record<CommandKind, string> = { skill: "Skills", command: "Commands", mcp: "MCP prompts" };
const SECTION_ORDER: CommandKind[] = ["skill", "command", "mcp"];

/** The menu's sections, in order, from the matches; mid-message, only what can be mentioned there (not commands). */
export function sections(matches: MenuCommand[], atStart: boolean): { kind: CommandKind; items: MenuCommand[] }[] {
  return SECTION_ORDER.filter((k) => atStart || k !== "command")
    .map((kind) => ({ kind, items: matches.filter((m) => m.kind === kind) }))
    .filter((s) => s.items.length > 0);
}
