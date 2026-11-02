/**
 * A Review page as the Mac reads it (src/lib/review.ts, copied here line for line so the two agree): a file page's parts, and
 * the Next that carries your verdicts on its findings, which is what Claude reads whichever of them sent it.
 */

/**
 * Reads a Review-mode file page (the incremental-pr-review skill's format) into parts the app can lay out:
 *
 *   ### What changed   <plain language>
 *   ### Findings       ⚠ line 42 (blocker|should-fix|nit): <defect and consequence>   — or exactly "None."
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
}

export interface ReviewFile {
  path: string | null;
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

/** A file page's parts; null when the message doesn't have the skill's sections. */
export function parseReviewFile(title: string | null, text: string): ReviewFile | null {
  const parts = withoutCue(text).split(/^###\s+(.+)$/m);
  if (parts.length < 3) return null;
  const sections = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i].trim().toLowerCase(), parts[i + 1] ?? "");
  if (!sections.has("what changed") && !sections.has("findings")) return null;
  const file = title ? splitFileTitle(title) : { path: null, added: null, removed: null };
  const { findings, clean } = findingsOf(sections.get("findings") ?? "");
  return { ...file, preface: parts[0].trim(), changed: (sections.get("what changed") ?? "").trim(), findings, clean, notes: (sections.get("notes") ?? "").trim() };
}

export type Verdict = "agree" | "reject";

const where = (f: Finding) => (f.line === null ? `finding ${f.index + 1}` : `line ${f.line}${f.lineEnd ? `-${f.lineEnd}` : ""}`);

/** The Next message carrying a page's verdicts: "Next. Agreed: line 42. Rejected: line 17." */
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
    const list = new RegExp(`${key}:\\s*([^.]+)\\.`, "i").exec(text)?.[1];
    for (const label of list?.split(",").map((s) => s.trim()) ?? []) {
      const found = findings.find((f) => where(f) === label && out[f.index] === undefined);
      if (found) out[found.index] = verdict;
    }
  }
  return out;
}

/** Verdicts not yet sent, per chat and page, kept while the app runs: switching chats or modes redraws the view. */
