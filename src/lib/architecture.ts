import { findingsOf, withoutCue, type Finding } from "./review";
import { mermaidBlock } from "./mermaid";
import { architectureBlock, parseArchitecture, type ArchSpec } from "./archGraph";
import type { StepPage } from "./steps";

/**
 * Reads an Architecture part page into parts the app can lay out:
 *
 *   Covers: authSvc, tokenStore          the diagram nodes the part is about (the map lights them up)
 *   ### Role         what the part is for
 *   ### Connects to  what it talks to, and how
 *   ### Changes      what is new, changed or removed here
 *   ### Concerns     ⚠ (blocker|should-fix|nit): <the problem and its consequence>   — or exactly "None."
 *   ### Notes        what was checked, context
 */
export interface ArchitecturePart {
  /** Node ids from the Overview's diagram. */
  covers: string[];
  /** Anything said before the sections. */
  preface: string;
  role: string;
  connects: string;
  changes: string;
  concerns: Finding[];
  /** The Concerns section said "None.". */
  clean: boolean;
  notes: string;
}

// `Covers: a, b`, also as `**Covers:** a, b` or with the ids in backticks.
const COVERS = /^[ \t]*(?:\*\*)?Covers:?(?:\*\*)?:?[ \t]*(.*)$/im;

/** The node ids a Covers line names. */
export function coveredIds(line: string): string[] {
  return line
    .split(/[,;\s]+/)
    .map((id) => id.replace(/[`*_]/g, "").trim())
    .filter(Boolean);
}

/** A part page's pieces; null when the message doesn't have the sections. */
export function parseArchitecturePart(text: string): ArchitecturePart | null {
  const parts = withoutCue(text).split(/^###\s+(.+)$/m);
  if (parts.length < 3) return null;
  const sections = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i].trim().toLowerCase(), parts[i + 1] ?? "");
  if (!["role", "connects to", "changes", "concerns"].some((s) => sections.has(s))) return null;
  const covers = COVERS.exec(parts[0]);
  const { findings, clean } = findingsOf(sections.get("concerns") ?? "");
  return {
    covers: covers ? coveredIds(covers[1]) : [],
    preface: parts[0].replace(COVERS, "").trim(),
    role: (sections.get("role") ?? "").trim(),
    connects: (sections.get("connects to") ?? "").trim(),
    changes: (sections.get("changes") ?? "").trim(),
    concerns: findings,
    clean,
    notes: (sections.get("notes") ?? "").trim(),
  };
}

/** The message a page's shown turn wrote. */
function textOf(page: StepPage): string {
  const turn = page.turns[page.main];
  const msg = turn.items.find((it) => it.id === turn.messageId);
  return msg?.type === "assistant" ? msg.text : "";
}

/** The Covers line of a part page, whether or not its sections are there. */
export function coversOf(page: StepPage): string[] {
  if (page.heading?.kind !== "part") return [];
  const m = COVERS.exec(textOf(page));
  return m ? coveredIds(m[1]) : [];
}

/**
 * The architecture map the Architecture tab draws: the latest Overview's boxes and arrows (its ```architecture block),
 * and which page each box opens. An Overview written before that block existed has a Mermaid diagram instead, which is
 * shown as it is; one whose block doesn't read says why.
 */
export type ArchitectureMap = { page: string; title: string; nodes: Record<string, string> } & (
  | { kind: "native"; spec: ArchSpec }
  | { kind: "mermaid"; source: string }
  | { kind: "broken"; error: string; text: string }
);

/** The map the pages so far have drawn: null until an Overview with a diagram comes. */
export function architectureMap(pages: StepPage[]): ArchitectureMap | null {
  const overview = [...pages].reverse().find((p) => p.heading?.kind === "overview" && (architectureBlock(textOf(p)) !== null || mermaidBlock(textOf(p)) !== null));
  if (!overview) return null;
  const nodes: Record<string, string> = {};
  for (const p of pages) for (const id of coversOf(p)) nodes[id] ??= p.key;
  const base = { page: overview.key, title: overview.heading?.title ?? "", nodes };
  const block = architectureBlock(textOf(overview));
  if (block === null) return { ...base, kind: "mermaid", source: mermaidBlock(textOf(overview))! };
  const read = parseArchitecture(block);
  return "spec" in read ? { ...base, kind: "native", spec: read.spec } : { ...base, kind: "broken", error: read.error, text: block };
}
