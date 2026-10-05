import type { Hunk } from "../types";

export type LineKind = "add" | "del" | "ctx" | "meta";

export function lineKind(line: string): LineKind {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta";
  return "ctx";
}

export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      const k = lineKind(l);
      if (k === "add") added++;
      else if (k === "del") removed++;
    }
  return { added, removed };
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", rs: "rust", py: "python", swift: "swift", kt: "kotlin", java: "java", go: "go", rb: "ruby",
  css: "css", scss: "scss", html: "html", md: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", sh: "shell",
  zsh: "shell", sql: "sql", c: "c", h: "c", cpp: "cpp", m: "objective-c", xml: "xml",
};

export function languageFor(path: string): string {
  const name = basename(path);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANGUAGES[ext] ?? "plaintext";
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * A path as it reads best next to `folder`: relative inside it, "~/…" elsewhere under the same home folder, and
 * the last few parts of anything else ("…/scratchpad/probe/a.ts") rather than a long absolute path.
 * Anything that isn't an absolute path (a command, a search pattern) is returned as is.
 */
export function relativeTo(path: string, folder: string | null): string {
  if (!folder || !path.startsWith("/")) return path;
  const base = folder.replace(/\/$/, "");
  if (path.startsWith(base + "/")) return path.slice(base.length + 1);
  const home = /^\/(?:Users|home)\/[^/]+/.exec(base)?.[0];
  if (home && path.startsWith(home + "/")) return `~${path.slice(home.length)}`;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
