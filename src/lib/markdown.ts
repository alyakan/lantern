/**
 * Shapes in Claude's markdown that get their own look: GitHub callouts (`> [!NOTE]`), and incremental-dev's plan
 * steps (a code block of `File:` / `Change:` / `Verify:` lines).
 */

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";
export const CALLOUT_LABEL: Record<CalloutKind, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

const MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;

/** A hast node, as much of it as the plugin reads. */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HNode[];
  properties?: Record<string, unknown>;
}

/** Marks `> [!NOTE]` blockquotes with `data-callout="note"` and drops the marker. */
export function rehypeCallouts() {
  const mark = (quote: HNode) => {
    const p = quote.children?.find((c) => c.type === "element");
    const text = p?.tagName === "p" ? p.children?.[0] : undefined;
    const m = text?.type === "text" && text.value ? MARKER.exec(text.value) : null;
    if (!p || !text || !m) return;
    text.value = text.value!.slice(m[0].length);
    if (!text.value) p.children!.shift();
    if (p.children![0]?.type === "element" && p.children![0].tagName === "br") p.children!.shift();
    if (!p.children!.length) quote.children = quote.children!.filter((c) => c !== p);
    quote.properties = { ...quote.properties, dataCallout: m[1].toLowerCase() };
  };
  const walk = (n: HNode) => {
    for (const c of n.children ?? []) {
      if (c.type === "element" && c.tagName === "blockquote") mark(c);
      walk(c);
    }
  };
  return (tree: HNode) => walk(tree);
}

export interface PlanStep {
  /** "Plan step 2 — Retry with backoff", when the block starts with it. */
  title: string | null;
  fields: { label: string; value: string }[];
}

const FIELD = /^(Files?|Change|Verify|Test|Why)\s*:\s*(.*)$/;
const STEP_TITLE = /^(?:#+\s*)?Plan step\s+\d+\b.*$/i;

/**
 * A code block that is a plan step: `Label: value` lines (a value may run onto indented lines), with at least a
 * Change and a File or Verify. Anything else in the block means it's code after all.
 */
export function parsePlanStep(text: string): PlanStep | null {
  const lines = text.replace(/\n+$/, "").split("\n");
  let title: string | null = null;
  const fields: PlanStep["fields"] = [];
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (i === 0 && STEP_TITLE.test(line.trim())) {
      title = line.trim().replace(/^#+\s*/, "");
      continue;
    }
    const m = FIELD.exec(line.trim());
    if (m && !/^\s/.test(line)) fields.push({ label: m[1], value: m[2].trim() });
    else if (fields.length && /^\s/.test(line)) fields[fields.length - 1].value += `\n${line.trim()}`;
    else return null;
  }
  const has = (l: string) => fields.some((f) => f.label.startsWith(l));
  return has("Change") && (has("File") || has("Verify")) ? { title, fields } : null;
}

/** The paths in a `File:` value: "a.ts, b.ts", "a.ts and b.ts", or "a.ts (new)". */
export function filePaths(value: string): { path: string; note: string }[] {
  return value
    .split(/,\s*|\s+and\s+/)
    .map((part) => {
      const m = /^`?([^`\s(]+)`?\s*(.*)$/.exec(part.trim());
      return m ? { path: m[1], note: m[2].trim() } : null;
    })
    .filter((p): p is { path: string; note: string } => !!p && !!p.path);
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TSX", typescript: "TypeScript", js: "JavaScript", jsx: "JSX", javascript: "JavaScript", py: "Python", python: "Python",
  rs: "Rust", rust: "Rust", swift: "Swift", kt: "Kotlin", kotlin: "Kotlin", go: "Go", rb: "Ruby", java: "Java", css: "CSS", html: "HTML",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", shell: "Shell", console: "Shell",
  diff: "Diff", md: "Markdown", markdown: "Markdown", objc: "Objective-C", c: "C", cpp: "C++",
};

const MONACO_IDS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", typescript: "typescript", js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript",
  py: "python", python: "python", rs: "rust", rust: "rust", swift: "swift", kt: "kotlin", kotlin: "kotlin", go: "go", rb: "ruby", ruby: "ruby",
  java: "java", css: "css", scss: "scss", html: "html", xml: "xml", json: "json", yaml: "yaml", yml: "yaml", toml: "ini", sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", c: "c", cpp: "cpp", objc: "objective-c", md: "markdown", markdown: "markdown",
};

/** Monaco's language id for a code block's `language-xyz`; null when it has none Monaco highlights. */
export function monacoLanguage(className: string | undefined): string | null {
  const lang = /language-([\w+#-]+)/.exec(className ?? "")?.[1]?.toLowerCase();
  return (lang && MONACO_IDS[lang]) || null;
}

/** A code block's language for its header, from `language-xyz`; null when it has none. */
export function languageName(className: string | undefined): string | null {
  const lang = /language-([\w+#-]+)/.exec(className ?? "")?.[1];
  if (!lang) return null;
  return LANGUAGES[lang.toLowerCase()] ?? lang;
}
