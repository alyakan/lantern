// steps.ts imports this file too; each only calls the other's functions, never at load time.
import type { ChatItem } from "../store";
import { parseHeading } from "./steps";

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
const FINDING = /^\s*(?:[-*]\s*)?⚠️?\s*(?:lines?\s+(\d+)(?:\s*[–-]\s*(\d+))?\s*)?(?:\(([^)]+)\))?\s*:?\s*(.*)$/i;

export function findingsOf(section: string): { findings: Finding[]; clean: boolean } {
  const body = section.trim();
  if (/^none\.?$/i.test(body)) return { findings: [], clean: true };
  const findings: Finding[] = [];
  for (const line of body.split("\n")) {
    const m = /⚠/.test(line) ? FINDING.exec(line) : null;
    if (m) {
      findings.push({ index: findings.length, line: m[1] ? Number(m[1]) : null, lineEnd: m[2] ? Number(m[2]) : null, severity: SEVERITY[(m[3] ?? "").trim().toLowerCase()] ?? null, text: m[4].trim() });
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

/**
 * The pull request a review is about: "#128" in the Frame heading, or "PR 128", "PR #128" or ".../pull/128" in what
 * was asked. The latest mention wins, so a second review in the same chat moves on to its PR.
 */
export function prNumberOf(items: readonly { type: string; text?: string }[]): number | null {
  const MENTION = /(?:\bPR\s*#?|\/pull\/|\(#)(\d{1,7})\b/gi;
  let found: number | null = null;
  for (const it of items) {
    if ((it.type !== "user" && it.type !== "assistant") || !it.text) continue;
    const text = it.type === "assistant" ? (it.text.match(/^#\s+Frame\b.*$/m)?.[0] ?? "") : it.text;
    for (const m of text.matchAll(MENTION)) found = Number(m[1]);
  }
  return found;
}

/**
 * The branch a reviewed local branch is stacked on, as the review's Frame names it: a line `Base: feat/core` (also
 * `**Base:** \`feat/core\``). The latest Frame that names one wins; null when none does (Lantern then works it out).
 */
export function baseBranchOf(items: readonly { type: string; text?: string }[]): string | null {
  const LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?Base:?(?:\*\*)?:?\s*`?([A-Za-z0-9._/-]+)`?\s*$/im;
  let found: string | null = null;
  for (const it of items) {
    if (it.type !== "assistant" || !it.text || parseHeading(it.text)?.kind !== "frame") continue;
    const m = LINE.exec(it.text);
    if (m) found = m[1];
  }
  return found;
}

/**
 * What Claude set the Changes pane to show with mcp__lantern__review_target, read from the transcript (its card header
 * says it, "pr=512 base=auto", see stream_parser::summarize): a pull request, or the checked-out branch against a base
 * (null: Lantern finds it). Only for a chat reopened from disk: a live call reaches the window as a review_target event
 * (State.reviewTarget). Null when it never called it; then the review's text is read instead (prNumberOf, baseBranchOf).
 */
export function reviewTargetOf(items: readonly ChatItem[]): { pr: number | null; base: string | null } | null {
  let found: { pr: number | null; base: string | null } | null = null;
  for (const it of items) {
    if (it.type !== "tool" || it.name !== "mcp__lantern__review_target" || it.status === "error") continue;
    const m = /^pr=(\d+|none) base=(\S+)$/.exec(it.summary.trim());
    if (m) found = { pr: m[1] === "none" ? null : Number(m[1]), base: m[2] === "auto" ? null : m[2] };
  }
  return found;
}

/**
 * What says which repository a review is in, when the folder holds several: the reviewed files' paths (from their
 * pages), and absolute paths Claude used in its steps (`git -C /…/repo log`, a Read of a file).
 */
export function reviewHints(items: readonly ChatItem[], folder: string | null): string[] {
  const hints = new Set<string>();
  const walk = (list: readonly ChatItem[]) => {
    for (const it of list) {
      if (it.type === "assistant") {
        const h = parseHeading(it.text);
        if (h?.kind === "file") hints.add(splitFileTitle(h.title).path);
      } else if (it.type === "tool") {
        if (folder) for (const m of it.summary.matchAll(/(?:^|[\s"'=])(\/[^\s"'`;|&]+)/g)) if (m[1].startsWith(`${folder}/`)) hints.add(m[1]);
        walk(it.children);
      }
    }
  };
  walk(items);
  return [...hints].slice(-30);
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
const unsent = new Map<string, Record<string, Record<number, Verdict>>>();
export const rememberVerdicts = (slot: string, verdicts: Record<string, Record<number, Verdict>>) => unsent.set(slot, verdicts);
export const recallVerdicts = (slot: string) => unsent.get(slot) ?? {};
