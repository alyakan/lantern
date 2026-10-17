/**
 * Follows a file's relative imports so an editor's TypeScript service can see the project files it depends on.
 * Pure on purpose: the caller supplies `read`, so this runs (and is tested) without the editor or Tauri.
 */

const MODULE_REFS = [
  // import x from "m", import type {T} from "m", export * from "m", export {a} from "m"
  /\b(?:import|export)\b[^'"`;()]*?\bfrom\s*(["'`])([^"'`\n]+)\1/g,
  // import "m"
  /\bimport\s*(["'`])([^"'`\n]+)\1/g,
  // import("m")
  /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g,
  // require("m")
  /\brequire\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g,
];

// Files whose imports we follow. JSON is returned to the editor but never parsed.
const CODE_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
// Extensions a specifier can already carry. .mts/.cts are here so an explicit import of them still resolves.
const KNOWN_EXTS = [...CODE_EXTS, ".json"];
// Tried in order after a bare path (no known extension).
const PROBE_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
// TypeScript ESM style: "./x.js" is written for "x.ts" on disk.
const TS_FOR_JS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
// Above this a file is skipped: it would dominate the budget and is rarely the thing being looked at.
const MAX_FILE_CHARS = 100_000;

/** Relative module specifiers ("./", "../", or "." and ".." for a folder's index) in first-appearance order. Bare packages are left to the editor. */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const hits: { at: number; spec: string }[] = [];
  for (const re of MODULE_REFS) {
    for (const m of code.matchAll(re)) hits.push({ at: m.index ?? 0, spec: m[2] });
  }
  hits.sort((a, b) => a.at - b.at);
  const out = new Set<string>();
  for (const { spec } of hits) {
    if (/^\.\.?(?:\/|$)/.test(spec) && !spec.includes("${")) out.add(spec);
  }
  return [...out];
}

/** Absolute POSIX paths to try, best first, for a relative `specifier` imported from the absolute path `fromFile`. */
export function candidatePaths(fromFile: string, specifier: string): string[] {
  const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  const base = normalisePosix(`${dir}/${specifier}`);
  const out: string[] = [];
  const ext = KNOWN_EXTS.find((e) => base.endsWith(e));
  // "." and ".." name the folder itself: its index, not a sibling file called like it.
  const folder = /(?:^|\/)\.\.?$/.test(specifier);
  if (folder) {
    for (const e of PROBE_EXTS) out.push(normalisePosix(`${base}/index${e}`));
  } else if (ext) {
    // Keep the written file first; the TypeScript source it stands for comes after.
    out.push(base);
    for (const tsExt of TS_FOR_JS[ext] ?? []) out.push(base.slice(0, -ext.length) + tsExt);
  } else {
    for (const e of PROBE_EXTS) out.push(base + e);
    for (const e of PROBE_EXTS) out.push(normalisePosix(`${base}/index${e}`));
  }
  return [...new Set(out)];
}

/**
 * Breadth-first walk of `entry`'s relative imports. The entry's imports are depth 1. Each level's reads run in
 * parallel, but results are kept in walk order so the output is deterministic. A read that rejects means "not there".
 */
export async function collectLibs(
  entry: { path: string; text: string },
  read: (path: string) => Promise<string>,
  options: { maxFiles?: number; maxDepth?: number; maxBytes?: number } = {},
): Promise<{ path: string; text: string }[]> {
  const { maxFiles = 30, maxDepth = 3, maxBytes = 200_000 } = options;

  // Memoised by path, misses included: different specifiers often probe the same candidates.
  const reads = new Map<string, Promise<string | null>>();
  reads.set(entry.path, Promise.resolve(entry.text));
  const load = (path: string): Promise<string | null> => {
    let text = reads.get(path);
    if (!text) {
      text = new Promise<string>((resolve) => resolve(read(path))).then(
        (t) => (typeof t === "string" ? t : null),
        () => null,
      );
      reads.set(path, text);
    }
    return text;
  };
  const resolveSpecifier = async (from: string, spec: string) => {
    for (const path of candidatePaths(from, spec)) {
      const text = await load(path);
      if (text !== null) return { path, text };
    }
    return null;
  };

  const seen = new Set<string>([entry.path]);
  const out: { path: string; text: string }[] = [];
  let total = 0;
  let frontier = isCode(entry.path) ? [entry] : [];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const jobs = frontier.flatMap((file) => importSpecifiers(file.text).map((spec) => ({ from: file.path, spec })));
    const found = await Promise.all(jobs.map((j) => resolveSpecifier(j.from, j.spec)));

    const next: { path: string; text: string }[] = [];
    for (const hit of found) {
      if (!hit || seen.has(hit.path)) continue;
      seen.add(hit.path);
      if (hit.text.length > MAX_FILE_CHARS) continue;
      // Stop rather than skip ahead: the walk order is what makes the cut-off predictable.
      if (out.length >= maxFiles || total + hit.text.length > maxBytes) return out;
      out.push(hit);
      total += hit.text.length;
      if (isCode(hit.path)) next.push(hit);
    }
    frontier = next;
  }
  return out;
}

function isCode(path: string): boolean {
  return CODE_EXTS.some((e) => path.endsWith(e));
}

/** Resolves "." and ".." and collapses empty segments. ".." at the root stays at the root. */
function normalisePosix(path: string): string {
  const stack: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return "/" + stack.join("/");
}

/** Blanks comments but keeps string literals intact, so "http://x" is not mistaken for a comment. */
function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out.push(" ");
    } else if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(src, i);
      out.push(src.slice(i, end));
      i = end;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

/** Index just past the string literal starting at `start`. A single-line quote ends at a newline, so a stray apostrophe can't swallow the file. */
function stringEnd(src: string, start: number): number {
  const quote = src[start];
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === quote) return j + 1;
    else if (c === "\n" && quote !== "`") return j;
  }
  return src.length;
}
