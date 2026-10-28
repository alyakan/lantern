/**
 * A small syntax colouring for the code blocks in a chat: comments, strings, numbers and keywords, for the languages Claude
 * writes most, and a diff's added and removed lines. It is a line-by-line scanner, not a parser: an unknown language gets no
 * colour, and anything it misreads is only a wrong colour, never a wrong character (the text is always kept whole).
 */

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "add" | "del" | "meta";

export interface Token {
  kind: TokenKind;
  text: string;
}

type Family = "c" | "hash" | "sql" | "markup" | "json" | "diff";

interface Lang {
  family: Family;
  keywords: Set<string>;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS = words("const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this super null undefined true false void yield static get set interface type enum implements readonly as satisfies public private protected declare namespace");
const RUST = words("fn let mut const static struct enum impl trait pub use mod crate self Self super if else match loop while for in return break continue async await move ref where as dyn unsafe extern type true false Some None Ok Err");
const SWIFT = words("func let var struct class enum protocol extension import return if else guard switch case default for in while repeat break continue self Self super init deinit nil true false try catch throw throws async await actor private public internal fileprivate static override final lazy weak unowned some any where as is");
const PY = words("def class return if elif else for while break continue pass import from as with try except finally raise lambda yield async await None True False and or not in is global nonlocal assert del self");
const GO = words("func var const type struct interface map chan package import return if else for range switch case default break continue go defer select fallthrough goto nil true false");
const JAVA = words("class interface enum extends implements import package public private protected static final abstract void return if else for while do switch case default break continue new this super try catch finally throw throws null true false int long double float boolean char byte short String val var fun object when is in data sealed override open lateinit companion");
const SH = words("if then else elif fi for while until do done case esac in function return exit export local readonly set unset source echo cd ls cat grep sed awk git npm npx cargo sudo true false");
const SQL = words("select from where and or not insert into values update set delete create table drop alter add index join left right inner outer on group by order having limit offset as distinct union null is in like between case when then else end primary key foreign references default unique count sum avg min max");
const RUBY = words("def class module end if elsif else unless case when while until for in do begin rescue ensure raise return yield self nil true false require include extend attr_accessor attr_reader puts lambda proc");
const CSS = words("important inherit initial unset auto none solid");

const LANGS: Record<string, Lang> = {
  js: { family: "c", keywords: JS },
  javascript: { family: "c", keywords: JS },
  jsx: { family: "c", keywords: JS },
  ts: { family: "c", keywords: JS },
  typescript: { family: "c", keywords: JS },
  tsx: { family: "c", keywords: JS },
  rust: { family: "c", keywords: RUST },
  rs: { family: "c", keywords: RUST },
  swift: { family: "c", keywords: SWIFT },
  go: { family: "c", keywords: GO },
  java: { family: "c", keywords: JAVA },
  kotlin: { family: "c", keywords: JAVA },
  kt: { family: "c", keywords: JAVA },
  c: { family: "c", keywords: words("if else for while do switch case break continue return struct enum typedef static const void int char long short unsigned float double sizeof NULL true false") },
  cpp: { family: "c", keywords: words("if else for while do switch case break continue return struct class enum typedef static const void int char long short unsigned float double sizeof nullptr NULL true false namespace template typename public private protected virtual new delete using auto") },
  css: { family: "c", keywords: CSS },
  py: { family: "hash", keywords: PY },
  python: { family: "hash", keywords: PY },
  sh: { family: "hash", keywords: SH },
  bash: { family: "hash", keywords: SH },
  zsh: { family: "hash", keywords: SH },
  shell: { family: "hash", keywords: SH },
  yaml: { family: "hash", keywords: words("true false null yes no on off") },
  yml: { family: "hash", keywords: words("true false null yes no on off") },
  toml: { family: "hash", keywords: words("true false") },
  ruby: { family: "hash", keywords: RUBY },
  rb: { family: "hash", keywords: RUBY },
  sql: { family: "sql", keywords: SQL },
  json: { family: "json", keywords: words("true false null") },
  html: { family: "markup", keywords: new Set() },
  xml: { family: "markup", keywords: new Set() },
  diff: { family: "diff", keywords: new Set() },
  patch: { family: "diff", keywords: new Set() },
};

/** How far into a text the colouring reads: a huge block stays plain, so scrolling a chat never waits on it. */
export const HIGHLIGHT_MAX_CHARS = 20_000;

/** The language a fence names ("TypeScript", "ts", "```tsx title=x"), or null when it is not one the scanner knows. */
export function langOf(fence: string): Lang | null {
  const name = fence.trim().toLowerCase().split(/[\s{]/)[0].replace(/^language-/, "");
  return LANGS[name] ?? null;
}

const isWordStart = (c: string) => /[A-Za-z_$]/.test(c);
const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);

/**
 * One line, as tokens. `inBlock` says a /* comment from an earlier line is still open; the new state comes back with the
 * tokens. Tokens are joined back to exactly the line.
 */
function scanLine(line: string, lang: Lang, inBlock: boolean): { tokens: Token[]; inBlock: boolean } {
  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ kind: "plain", text: plain });
    plain = "";
  };
  const push = (kind: TokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };
  const { family } = lang;
  let i = 0;
  if (inBlock) {
    const end = line.indexOf("*/");
    if (end === -1) return { tokens: [{ kind: "comment", text: line }], inBlock: true };
    push("comment", line.slice(0, end + 2));
    i = end + 2;
    inBlock = false;
  }
  while (i < line.length) {
    const c = line[i];
    const rest = line.slice(i);
    // Comments.
    if (family === "c" && rest.startsWith("//")) {
      push("comment", rest);
      i = line.length;
      break;
    }
    if ((family === "c" || family === "sql") && rest.startsWith("/*")) {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push("comment", rest);
        return { tokens, inBlock: true };
      }
      push("comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (family === "sql" && rest.startsWith("--")) {
      push("comment", rest);
      i = line.length;
      break;
    }
    if (family === "hash" && c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      push("comment", rest);
      i = line.length;
      break;
    }
    if (family === "markup" && rest.startsWith("<!--")) {
      const end = line.indexOf("-->", i + 4);
      push("comment", end === -1 ? rest : line.slice(i, end + 3));
      i = end === -1 ? line.length : end + 3;
      continue;
    }
    // Strings: closed on the same line, or to the end of it.
    if (c === '"' || c === "'" || (c === "`" && family !== "sql")) {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, line.length);
      push("string", line.slice(i, end));
      i = end;
      continue;
    }
    // Numbers, not the tail of a word.
    if (/[0-9]/.test(c) && (i === 0 || !isWord(line[i - 1]))) {
      const m = /^(0x[0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9]+)?([eE][+-]?[0-9]+)?)/.exec(rest)!;
      push("number", m[0]);
      i += m[0].length;
      continue;
    }
    if (isWordStart(c) && family !== "markup") {
      let j = i + 1;
      while (j < line.length && isWord(line[j])) j++;
      const word = line.slice(i, j);
      if (lang.keywords.has(family === "sql" ? word.toLowerCase() : word)) push("keyword", word);
      else plain += word;
      i = j;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return { tokens, inBlock };
}

/** A diff's line: added, removed, or a header ("@@", "diff", "+++", "---"). */
function diffLine(line: string): Token[] {
  const kind: TokenKind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "plain";
  return [{ kind, text: line }];
}

/** The lines of `text` as tokens (joined back, each line is the text's line exactly); every token is plain for a language it does not know. */
export function highlight(text: string, fence: string): Token[][] {
  const lines = text.split("\n");
  const lang = langOf(fence);
  if (!lang || text.length > HIGHLIGHT_MAX_CHARS) return lines.map((l) => [{ kind: "plain", text: l }]);
  if (lang.family === "diff") return lines.map(diffLine);
  let inBlock = false;
  return lines.map((l) => {
    const r = scanLine(l, lang, inBlock);
    inBlock = r.inBlock;
    return r.tokens.length > 0 ? r.tokens : [{ kind: "plain", text: l }];
  });
}

/** Past this many lines a code block is folded to `FOLDED_LINES` until it is opened. */
export const FOLD_ABOVE = 18;
export const FOLDED_LINES = 12;

/** How many lines of `text` there are, and whether a block of that length folds. */
export function foldOf(text: string): { lines: number; folds: boolean } {
  const lines = text.split("\n").length;
  return { lines, folds: lines > FOLD_ABOVE };
}
