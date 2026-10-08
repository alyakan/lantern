import type { McpServer, SkillEntry } from "../types";

/** How Claude Code names a server in its tools: "claude.ai Linear" → "claude_ai_Linear" (mcp__claude_ai_Linear__…). */
export const toolPrefix = (server: string) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;

/** The server's tools, by their own names ("create_issue"), from claude's list of MCP tools. */
export function toolsOf(server: string, tools: string[]): string[] {
  const prefix = toolPrefix(server);
  return tools.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
}

export type StatusTone = "ok" | "warn" | "bad" | "idle";

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "ok" },
  "needs-auth": { label: "Needs you to log in", tone: "warn" },
  pending: { label: "Connecting…", tone: "idle" },
  failed: { label: "Failed", tone: "bad" },
  disabled: { label: "Off", tone: "idle" },
};

export const statusOf = (s: string) => STATUS[s] ?? { label: s, tone: "idle" as StatusTone };

/** Where a server comes from, in words. */
export function sourceOf(s: McpServer): string {
  if (s.scope === "claudeai" || s.source === "claudeai") return "claude.ai connector";
  if (s.source === "plugin" || s.name.startsWith("plugin:")) return "Plugin";
  switch (s.scope) {
    case "user":
      return "Yours, every project";
    case "local":
      return "Yours, this project";
    case "project":
      return "This project (.mcp.json)";
    case "enterprise":
    case "managed":
      return "Your organization";
    default:
      return "Claude Code";
  }
}

/** A name to show: claude.ai connectors and plugin servers carry a prefix in their names. */
export const displayName = (s: McpServer) => s.serverInfo?.title || s.name.replace(/^claude\.ai /, "").replace(/^plugin:[^:]+:/, "");

/** Servers you added with `claude mcp add`, which `claude mcp remove` takes away again. */
export const removable = (s: McpServer) => s.scope === "user" || s.scope === "local" || s.scope === "project";

/** How it's reached, without secrets: headers and environment values never show. */
export function describeConfig(s: McpServer): { label: string; value: string }[] {
  const c = s.config ?? {};
  const rows: { label: string; value: string }[] = [];
  if (typeof c.url === "string") rows.push({ label: c.type === "sse" ? "SSE" : "Address", value: c.url });
  if (typeof c.command === "string") rows.push({ label: "Command", value: [c.command, ...(Array.isArray(c.args) ? c.args : [])].join(" ") });
  const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o) : []);
  if (keys(c.env).length) rows.push({ label: "Environment", value: keys(c.env).map((k) => `${k}=•••`).join("  ") });
  if (keys(c.headers).length) rows.push({ label: "Headers", value: keys(c.headers).map((k) => `${k}: •••`).join("  ") });
  return rows;
}

/** An icon the server publishes, if it's on the web (https). */
export const iconOf = (s: McpServer) => s.serverInfo?.icons?.find((i) => i.src.startsWith("https://"))?.src ?? null;

/** Skills and commands grouped as Settings lists them: yours, the project's, then each plugin's. */
export function groupSkills(entries: SkillEntry[]): { title: string; entries: SkillEntry[] }[] {
  const groups = new Map<string, SkillEntry[]>();
  const order = (e: SkillEntry) => (e.source === "user" ? "Yours" : e.source === "project" ? "This project" : `Plugin · ${e.plugin}`);
  for (const e of entries) groups.set(order(e), [...(groups.get(order(e)) ?? []), e]);
  const rank = (t: string) => (t === "Yours" ? 0 : t === "This project" ? 1 : 2);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([title, list]) => ({ title, entries: list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "skill" ? -1 : 1)) }));
}

/** A skill file's body, without its frontmatter. */
export const withoutFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n?/, "");
