/**
 * A Review page as the Mac reads it (src/lib/review.ts, copied here line for line so the two agree): a page's parts (a
 * file's, or a group's `Files:` line and title), the Frame's Units and Risks, and the Next that carries your verdicts on its
 * findings, which is what Claude reads whichever of them sent it. A finding names its file (`src/a.ts:42 (nit): …`), so a
 * verdict on one reads back from the Next like the Mac's. What isn't here: what the Mac does with the Changes pane (findings
 * in its diff, the notes kept for the summary) and its prNumberOf, baseBranchOf, reviewTargetOf and matchChanged, which are
 * about the Mac's own panes.
 */

/**
 * Reads a Review-mode file page (the incremental-pr-review skill's format) into parts the app can lay out:
 *
 *   ### What changed   <plain language>
 *   ### Findings       ⚠ src/a.ts:42 (blocker|should-fix|nit): <defect and consequence>   — or exactly "None."
 *   ### Notes          <what was checked, context>
 */

export type Severity = "blocker" | "should-fix" | "nit";

export interface Finding {
  /** Its place among the page's findings, for its verdict. */
  index: number;
  line: number | null;
  lineEnd: number | null;
  severity: Severity | null;
  text: string;
  /** The file it is in, when the finding names it (`⚠ src/a.ts:42 (nit): …`, as the skill and the Review prompt ask; an older page says `⚠ line 42`). */
  path?: string;
}

export interface ReviewFile {
  /** The file, for a page about one file; null for a group's. */
  path: string | null;
  /** A group's title ("#548 Add the field, model and mapping") and its files, for a page that covers several; else null and empty. */
  group: string | null;
  files: string[];
  added: number | null;
  removed: number | null;
  /** Anything said before the sections (e.g. about the last file's verdicts). */
  preface: string;
  changed: string;
  findings: Finding[];
  /** The Findings section said "None.". */
  clean: boolean;
  notes: string;
}

/** "path/to/file.m (+96 −1)" → the path and the counts. */
export function splitFileTitle(title: string): { path: string; added: number | null; removed: number | null } {
  const m = /^(.*?)\s*\(\s*\+(\d+)\s*[−–-]\s*(\d+)\s*\)\s*$/.exec(title.trim());
  return m ? { path: m[1].replace(/^`|`$/g, ""), added: Number(m[2]), removed: Number(m[3]) } : { path: title.trim().replace(/^`|`$/g, ""), added: null, removed: null };
}

/** The line a message ends on to say what to type next, which the page's buttons already say. */
const CUE = /(?:^|\n)\s*(?:I'll stop here\.?\s*)?(?:Say|Reply|Type|Answer)\s+["“]?next["”]?[^\n]*\s*$/i;
// The same cue after other words on its line, when it opens with "I'll stop here.": "All good. I'll stop here. Say next."
const STOP_CUE = /\s+I'll stop here\.?\s*(?:Say|Reply|Type|Answer)\s+["“]?next["”]?[^\n]*\s*$/i;
export const withoutCue = (text: string) => text.replace(CUE, "").replace(STOP_CUE, "").trimEnd();

const SEVERITY: Record<string, Severity> = { blocker: "blocker", "should-fix": "should-fix", "should fix": "should-fix", shouldfix: "should-fix", nit: "nit" };
const FINDING = /^\s*(?:[-*]\s*)?(?:\*\*)?⚠️?\s*(.*)$/i;
const LINE_REF = /^lines?\s+(\d+)(?:\s*[–-]\s*(\d+))?/i;
// A repo-relative path with its line, where a finding's header starts: `src/a.ts:42`, `src/a.ts:42-47`, also in backticks.
const PATH_REF = /^`?([^\s`:()]+\.[A-Za-z]\w{0,9})`?:(\d+)(?:\s*[–-]\s*(\d+))?`?\s*(.*)$/;
// A severity in brackets, which may be followed by a tag ("(should-fix, convention)"), or the whole header in bold.
const SEVERITY_IN = /[([]\s*(blocker|should[- ]?fix|nit)\b[^)\]]*[)\]]/i;
const SEVERITY_ALONE = /^\**\s*(blocker|should[- ]?fix|nit)\s*\**$/i;

/**
 * A finding's header and text. The header is what comes before the first colon: a line (or several, of which the first
 * counts), and the severity, which Claude writes as "(nit)", "(should-fix, convention)" or "**nit:**". A line without a
 * severity or a line reference in front of its first colon is all text.
 */
function readFinding(line: string): Omit<Finding, "index"> | null {
  const m = FINDING.exec(line);
  if (!m) return null;
  // The skill's own shape names the file: `src/a.ts:42 (nit): text`. Read as the line shape, with the file kept.
  const at = PATH_REF.exec(m[1]);
  if (at) {
    const inner = readFinding(`⚠ line ${at[2]}${at[3] ? `-${at[3]}` : ""} ${at[4]}`);
    return inner && { ...inner, path: at[1] };
  }
  const rest = m[1];
  const colon = rest.indexOf(":");
  const head = colon < 0 ? rest : rest.slice(0, colon);
  const ref = LINE_REF.exec(head.trim());
  const rawSeverity = SEVERITY_IN.exec(head)?.[1] ?? SEVERITY_ALONE.exec(head.trim().replace(LINE_REF, "").trim())?.[1] ?? null;
  const severity = rawSeverity ? (SEVERITY[rawSeverity.toLowerCase()] ?? null) : null;
  const line1 = ref ? Number(ref[1]) : null;
  const lineEnd = ref?.[2] ? Number(ref[2]) : null;
  // No colon, or one that doesn't close a header: the older shape ("⚠ line 7 (blocker) text") still reads, the rest is text.
  if (colon < 0 || (!severity && !ref)) {
    const old = /^(?:lines?\s+(\d+)(?:\s*[–-]\s*(\d+))?\s*)?(?:\(([^)]+)\))?\s*:?\s*(.*)$/i.exec(rest);
    if (!old) return { line: null, lineEnd: null, severity: null, text: rest.trim() };
    return { line: old[1] ? Number(old[1]) : null, lineEnd: old[2] ? Number(old[2]) : null, severity: SEVERITY[(old[3] ?? "").trim().toLowerCase()] ?? null, text: old[4].trim() };
  }
  // The colon of a bold header sits inside the bold ("**nit:** text"): the closing marks belong to it, not to the text.
  const text = rest.slice(colon + 1).replace(/^\**\s*/, "").trim();
  return { line: line1, lineEnd, severity, text };
}

export function findingsOf(section: string): { findings: Finding[]; clean: boolean } {
  const body = section.trim();
  if (/^none\.?$/i.test(body)) return { findings: [], clean: true };
  const findings: Finding[] = [];
  for (const line of body.split("\n")) {
    const read = /⚠/.test(line) ? readFinding(line) : null;
    if (read) {
      findings.push({ index: findings.length, ...read });
    } else if (findings.length && line.trim()) {
      // A finding's text can run on over the lines after it.
      findings[findings.length - 1].text += `\n${line.trim()}`;
    }
  }
  return { findings, clean: false };
}

/** A group page's first line under its heading: `Files: a/b.ts, c/d.ts` (also bold, or with the paths in backticks). */
const FILES_LINE = /^(?:\*\*)?Files:?(?:\*\*)?:?[ \t]*(.+)$/i;

/**
 * The paths of the `Files:` line a page opens with, when it has one (a Review page for a group of files). The Mac reads it
 * from the second line of the message, under the heading; the phone's page body has lost the heading, so it is the first.
 */
export function filesUnder(body: string): string[] | null {
  const m = FILES_LINE.exec((body.split("\n").find((l) => l.trim()) ?? "").trim());
  const files = (m?.[1] ?? "").split(",").map((f) => f.replace(/\*\*/g, "").trim().replace(/^`+|`+$/g, "").trim()).filter(Boolean);
  return files.length ? files : null;
}

/**
 * A unit's parts; null when the message doesn't have the skill's sections. A page that opens with a `Files:` line is a
 * group's: its title is the group's (not a path), the line becomes `files`, and it goes from the preface.
 */
export function parseReviewFile(title: string | null, text: string): ReviewFile | null {
  const parts = withoutCue(text).split(/^###\s+(.+)$/m);
  if (parts.length < 3) return null;
  const sections = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i].trim().toLowerCase(), parts[i + 1] ?? "");
  if (!sections.has("what changed") && !sections.has("findings")) return null;
  const files = filesUnder(text) ?? [];
  const named = title ? splitFileTitle(title) : { path: null, added: null, removed: null };
  const file = files.length ? { ...named, path: null, group: named.path } : { ...named, group: null };
  const preface = files.length ? parts[0].replace(/^\s*[^\n]*\n?/, "") : parts[0];
  const { findings, clean } = findingsOf(sections.get("findings") ?? "");
  return { ...file, files, preface: preface.trim(), changed: (sections.get("what changed") ?? "").trim(), findings, clean, notes: (sections.get("notes") ?? "").trim() };
}

/** A unit the Frame plans, in walk order: its number (its page is "File N of M"), what it is, its counts and why to look. */
export interface FrameUnit {
  n: number;
  /** A file's repo-relative path, or a group's title. */
  title: string;
  added: number | null;
  removed: number | null;
  note: string;
}

/** A risk the Frame names: in a few words, why it could go wrong, and the units it is in. */
export interface FrameRisk {
  title: string;
  text: string;
  units: number[];
}

/** A Review's Frame: what comes before the sections, the planned units, the risks, and any other section as written. */
export interface ReviewFrame {
  preface: string;
  units: FrameUnit[];
  risks: FrameRisk[];
  /** The Frame's other sections, headings and all (what is skipped, ...). */
  rest: string;
}

const UNIT = /^\s*(\d+)[.)]\s+(.+)$/;
const COUNTS = /^(.*?)\s*\(\s*\+(\d+)\s*[−–-]\s*(\d+)\s*\)\s*(?:[—–]|-{1,2})?\s*(.*)$/;
const RISK = /^\s*[-*]\s+(.+)$/;
const RISK_UNITS = /\s*\(\s*units?\s+([\d\s,–-]+(?:\s*and\s*\d+)?)\s*\)\s*\.?\s*$/i;
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/^`|`$/g, "").trim();

/**
 * The Frame of a Review, when it has the sections the Mac reads (`### Units`, a line per unit: `N. <path or group title>
 * (+added −removed) — <why to look>`; `### Risks`, a line per risk: `- <risk>: <why> (units 2, 4)`, or "None."). Null
 * when it has neither (an older Frame): the page then reads as Claude wrote it.
 */
export function parseReviewFrame(text: string): ReviewFrame | null {
  const parts = withoutCue(text).split(/^###\s+(.+)$/m);
  let units: FrameUnit[] | null = null;
  let risks: FrameRisk[] | null = null;
  const rest: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim().toLowerCase();
    const body = parts[i + 1] ?? "";
    if (name === "units") {
      units = body.split("\n").flatMap((line): FrameUnit[] => {
        const m = UNIT.exec(line);
        if (!m) return [];
        const c = COUNTS.exec(m[2]);
        if (c) return [{ n: Number(m[1]), title: plain(c[1]), added: Number(c[2]), removed: Number(c[3]), note: c[4].trim() }];
        const [title, ...note] = m[2].split(/\s+[—–]\s+/);
        return [{ n: Number(m[1]), title: plain(title), added: null, removed: null, note: note.join(" — ").trim() }];
      });
    } else if (name === "risks") {
      risks = body.split("\n").flatMap((line): FrameRisk[] => {
        const m = RISK.exec(line);
        if (!m) return [];
        const u = RISK_UNITS.exec(m[1]);
        const said = u ? m[1].slice(0, u.index) : m[1];
        const numbers = u ? expandUnits(u[1]) : [];
        const colon = said.indexOf(":");
        return colon > 0 ? [{ title: plain(said.slice(0, colon)), text: said.slice(colon + 1).trim(), units: numbers }] : [{ title: plain(said), text: "", units: numbers }];
      });
    } else rest.push(`### ${parts[i].trim()}\n${body.trim()}`);
  }
  if (units === null && risks === null) return null;
  return { preface: parts[0].trim(), units: units ?? [], risks: risks ?? [], rest: rest.join("\n\n") };
}

/** "2, 4–6 and 9" → [2, 4, 5, 6, 9]. */
function expandUnits(list: string): number[] {
  const out: number[] = [];
  for (const piece of list.split(/,|\band\b/)) {
    const range = /^\s*(\d+)\s*[–-]\s*(\d+)\s*$/.exec(piece);
    if (range) for (let n = Number(range[1]); n <= Number(range[2]) && out.length < 100; n++) out.push(n);
    else if (/^\s*\d+\s*$/.test(piece)) out.push(Number(piece));
  }
  return out;
}

/** A unit's title as a file (a path with no spaces) or a group's title. */
export const isPath = (title: string) => !/\s/.test(title) && (title.includes("/") || /\.[A-Za-z]\w*$/.test(title));
/** What a unit is called where room is short: a file's name, or a group's title. */
export const unitName = (title: string) => (isPath(title) ? title.slice(title.lastIndexOf("/") + 1) : title);

export type Verdict = "agree" | "reject";

const where = (f: Finding) => {
  if (f.line === null) return `finding ${f.index + 1}`;
  const span = `${f.line}${f.lineEnd ? `-${f.lineEnd}` : ""}`;
  return f.path ? `${f.path}:${span}` : `line ${span}`;
};

/** The Next message carrying a page's verdicts: "Next. Agreed: src/a.ts:42. Rejected: src/a.ts:17." ("line 42" for a finding that names no file). */
export function verdictMessage(findings: Finding[], verdicts: Record<number, Verdict> | undefined): string {
  const pick = (v: Verdict) => findings.filter((f) => verdicts?.[f.index] === v).map(where);
  const agreed = pick("agree");
  const rejected = pick("reject");
  return ["Next.", agreed.length ? `Agreed: ${agreed.join(", ")}.` : "", rejected.length ? `Rejected: ${rejected.join(", ")}.` : ""].filter(Boolean).join(" ");
}

/** A Next that carries verdicts (it moves on like a plain Next). */
export const isVerdictNext = (text: string) => /^next\.\s+(agreed|rejected):/i.test(text.trim());

/**
 * The verdicts a Next carried, read back against the findings of the page it left: the chat is where they are kept once
 * sent, so they outlive the view that was showing them. Findings with the same label (two on one line) take the labels
 * in the order they were listed; a label no finding has any more (the page was rewritten) is left out. Undefined when
 * the message isn't a Next with verdicts.
 */
export function verdictsFromNext(text: string, findings: Finding[]): Record<number, Verdict> | undefined {
  if (!isVerdictNext(text)) return undefined;
  const out: Record<number, Verdict> = {};
  for (const [verdict, key] of [["agree", "agreed"], ["reject", "rejected"]] as const) {
    // The list ends at a full stop that ends a word ("src/a.ts:42" has dots inside it).
    const list = new RegExp(`${key}:\\s*(.+?)\\.(?=\\s|$)`, "i").exec(text)?.[1];
    for (const label of list?.split(",").map((s) => s.trim()) ?? []) {
      const found = findings.find((f) => where(f) === label && out[f.index] === undefined);
      if (found) out[found.index] = verdict;
    }
  }
  return out;
}

/** Verdicts not yet sent, per chat and page, kept while the app runs: switching chats or modes redraws the view. */
