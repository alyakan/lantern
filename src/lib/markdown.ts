/**
 * Shapes in Claude's markdown that get their own look: GitHub callouts (`> [!NOTE]`), and incremental-dev's plan
 * steps (a code block of `File:` / `Change:` / `Verify:` lines).
 */

import { languageFor } from "./diff";

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
  diff: "Diff", md: "Markdown", markdown: "Markdown", objc: "Objective-C", c: "C", cpp: "C++", "c++": "C++", cc: "C++", h: "C", hpp: "C++",
  php: "PHP", cs: "C#", csharp: "C#", scala: "Scala", lua: "Lua", r: "R", dart: "Dart", perl: "Perl", graphql: "GraphQL", gql: "GraphQL",
  powershell: "PowerShell", ps1: "PowerShell", dockerfile: "Dockerfile", docker: "Dockerfile", jsonc: "JSON", scss: "SCSS", xml: "XML", mjs: "JavaScript",
};

const MONACO_IDS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", typescript: "typescript", js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript",
  py: "python", python: "python", rs: "rust", rust: "rust", swift: "swift", kt: "kotlin", kotlin: "kotlin", go: "go", rb: "ruby", ruby: "ruby",
  java: "java", css: "css", scss: "scss", html: "html", xml: "xml", json: "json", yaml: "yaml", yml: "yaml", toml: "ini", sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", c: "c", cpp: "cpp", objc: "objective-c", md: "markdown", markdown: "markdown",
  "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp", php: "php", cs: "csharp", csharp: "csharp", scala: "scala", lua: "lua", r: "r", dart: "dart", perl: "perl",
  graphql: "graphql", gql: "graphql", powershell: "powershell", ps1: "powershell", dockerfile: "dockerfile", docker: "dockerfile", jsonc: "json",
};

/** The header label for a Monaco language id, for a block whose language was worked out rather than written. */
const LABEL_FOR_ID: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", python: "Python", rust: "Rust", swift: "Swift", kotlin: "Kotlin", go: "Go", ruby: "Ruby", java: "Java",
  css: "CSS", scss: "SCSS", html: "HTML", xml: "XML", json: "JSON", yaml: "YAML", ini: "TOML", sql: "SQL", shell: "Shell", c: "C", cpp: "C++",
  "objective-c": "Objective-C", markdown: "Markdown", diff: "Diff", php: "PHP", csharp: "C#", dart: "Dart", lua: "Lua",
};

/** Monaco's language id for a code block's `language-xyz`; null when it has none Monaco highlights. */
export function monacoLanguage(className: string | undefined): string | null {
  const lang = /language-([\w+#-]+)/.exec(className ?? "")?.[1]?.toLowerCase();
  return (lang && MONACO_IDS[lang]) || null;
}

/**
 * The language most of the files a message mentions are in (`src/a.ts:12`, `lib/b.ts`), as a Monaco id: what an
 * untagged code block in that message is most likely written in. Null when it names no file in a known language.
 */
export function languageHint(markdown: string): string | null {
  const counts = new Map<string, number>();
  for (const m of markdown.matchAll(/(?:^|[\s`(])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,4})(?::\d+(?:-\d+)?)?(?=[\s`),.:;]|$)/gm)) {
    const lang = languageFor(m[1]);
    if (lang !== "plaintext" && lang !== "markdown") counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  // The most mentioned; the first one named when they tie (a Map keeps insertion order).
  let best: string | null = null;
  for (const [lang, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = lang;
  return best;
}

const SHELL_START = /^(?:\$ |(?:npm|npx|pnpm|yarn|git|cargo|brew|cd|ls|cat|curl|node|python3?|pip3?|make|docker|sudo|gh|claude|swift|xcodebuild)\s)/;
const LOOKS_LIKE_CODE = /[{};]|=>|^\s*(?:import|export|const|let|var|def|fn|func|class|struct|enum|return|if|for|while)\b/m;

/**
 * What an untagged code block is: a diff, JSON, a shell command, or code in the language of the files the message
 * names (`hint`). Null when it can't tell, so plain output (test results, a file tree) stays plain.
 */
export function inferLanguage(code: string, hint: string | null): string | null {
  const text = code.trim();
  if (!text) return null;
  const lines = text.split("\n");
  if (lines.some((l) => /^@@ .* @@/.test(l)) || (lines.some((l) => l.startsWith("--- ")) && lines.some((l) => l.startsWith("+++ ")))) return "diff";
  // Added and removed lines together: a bare list of "- items" isn't one.
  if (lines.some((l) => l.startsWith("+")) && lines.some((l) => l.startsWith("-")) && lines.every((l) => !l.trim() || /^[-+ \\]/.test(l))) return "diff";
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // Not JSON after all (a snippet, a template): fall through.
    }
  }
  if (SHELL_START.test(lines[0])) return "shell";
  return hint && LOOKS_LIKE_CODE.test(text) ? hint : null;
}

/**
 * How to colour a code block: the language it names if Monaco has it (or "diff", which gets its own colouring), else,
 * when it names none, what `inferLanguage` makes of it. `label` is what its header says.
 */
export function blockLanguage(className: string | undefined, code: string, hint: string | null): { id: string | null; label: string | null } {
  const label = languageName(className);
  const known = monacoLanguage(className);
  if (known) return { id: known, label };
  if (label?.toLowerCase() === "diff") return { id: "diff", label };
  if (label) return { id: null, label };
  const guessed = inferLanguage(code, hint);
  return { id: guessed, label: guessed ? (LABEL_FOR_ID[guessed] ?? null) : null };
}

/** A code block's language for its header, from `language-xyz`; null when it has none. */
export function languageName(className: string | undefined): string | null {
  const lang = /language-([\w+#-]+)/.exec(className ?? "")?.[1];
  if (!lang) return null;
  return LANGUAGES[lang.toLowerCase()] ?? lang;
}
