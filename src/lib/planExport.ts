import type { ChangedFile } from "../store";
import { parsePlanStep } from "./markdown";
import type { StepPage } from "./steps";
import { messageOf, type StepsSummary, type SummaryRow } from "./stepsSummary";

export interface PlanExportInput {
  pages: StepPage[];
  summary: StepsSummary;
  /** The files each row changed, by row id; a row missing here just has no list. */
  files: Record<string, ChangedFile[]>;
  /** The chat's title, for a document whose Frame page has none. */
  title: string;
  /** The folder the chat works in, whose name goes in the document and whose path is taken off the file paths. */
  folder: string | null;
  date: Date;
  /** What each step did (its page, in full), or only the plan: Frame, the plan's table, an outline of the rest. */
  results: boolean;
}

const MINUS = "−";

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;
const two = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const relative = (path: string, folder: string | null) => (folder && path.startsWith(`${folder.replace(/\/+$/, "")}/`) ? path.slice(folder.replace(/\/+$/, "").length + 1) : path);

/** A table cell: one line, with its pipes kept from ending the cell. */
const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();

/** Markdown headings moved `by` levels deeper (never past six), so a page's own headings sit under the document's. Code is left alone. */
export function demoteHeadings(text: string, by: number): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      const m = /^(#{1,6})(\s.*|)$/.exec(line);
      return m ? `${"#".repeat(Math.min(6, m[1].length + by))}${m[2]}` : line;
    })
    .join("\n");
}

/** The File / Change / Verify lines of a plan page's step block. */
function planFields(page: StepPage | undefined): { files: string; change: string; verify: string } | null {
  if (!page) return null;
  for (const m of messageOf(page).matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const step = parsePlanStep(m[1]);
    if (!step) continue;
    const field = (label: string) => step.fields.find((f) => f.label.startsWith(label))?.value ?? "";
    return { files: field("File"), change: field("Change"), verify: field("Verify") };
  }
  return null;
}

/** "`src/a.ts` +3 −1, `b.ts` (new) +10 −0" */
function filesLine(files: ChangedFile[], folder: string | null): string {
  return files.map((f) => `\`${relative(f.path, folder)}\`${f.created ? " (new)" : ""} +${f.added} ${MINUS}${f.removed}`).join(", ");
}

function planTable(rows: SummaryRow[], byKey: Map<string, StepPage>): string {
  const lines = ["| Step | What | Files | Change | Verify | Status |", "| --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    const fields = planFields(byKey.get(row.planPage ?? row.page));
    lines.push(`| ${cell(row.label)} | ${cell(row.title)} | ${cell(fields?.files ?? "")} | ${cell(fields?.change || row.gist || "")} | ${cell(fields?.verify ?? "")} | ${row.built ? "Built" : "Planned"} |`);
  }
  return lines.join("\n");
}

/** One row's section: its label and title, what it changed or found, and its page. */
function section(row: SummaryRow, page: StepPage | undefined, input: PlanExportInput): string {
  const out = [`### ${row.title ? `${row.label} — ${row.title}` : row.label}`];
  const facts: string[] = [];
  if (row.stats) facts.push(`+${row.stats.added} ${MINUS}${row.stats.removed}`);
  if (row.findings) facts.push(row.findings.count ? `${row.findings.count} finding${row.findings.count === 1 ? "" : "s"}` : "No findings");
  if (facts.length) out.push(facts.join(" · "));
  const files = input.files[row.id];
  if (files?.length) out.push(`**Files:** ${filesLine(files, input.folder)}`);
  const body = page ? messageOf(page).trim() : "";
  if (body) out.push(demoteHeadings(body, 2));
  return out.join("\n\n");
}

/**
 * The finished plan (or review, or debugging) as one markdown document: the Frame, the plan's steps in a table with
 * their status, and, with `results`, what each step did.
 */
export function planMarkdown(input: PlanExportInput): string {
  const { summary } = input;
  const byKey = new Map(input.pages.map((p) => [p.key, p]));
  const rows = summary.rows;
  const frame = rows.find((r) => r.kind === "frame");
  const steps = rows.filter((r) => r.kind === "step");
  const others = rows.filter((r) => r.kind !== "frame" && r.kind !== "step");

  const out: string[] = [`# ${frame?.title || input.title || "Plan"}`];
  const project = input.folder ? baseName(input.folder) : null;
  out.push(`${project ? `${project} · ` : ""}${isoDate(input.date)}`);
  if (summary.headline) out.push(`**${summary.headline}**`);
  if (steps.some((s) => !s.built)) out.push("> [!NOTE]\n> Draft: the plan isn't fully built yet.");

  const frameBody = frame ? messageOf(byKey.get(frame.page)!).trim() : "";
  if (frameBody) out.push("## Frame", demoteHeadings(frameBody, 1));

  if (steps.length) out.push("## Plan", planTable(steps, byKey));

  if (input.results) {
    const sections = rows
      .filter((r) => r.kind !== "frame" && (r.kind !== "step" || r.built))
      .map((r) => section(r, byKey.get(r.page), input));
    if (sections.length) out.push("## Details", ...sections);
  } else if (others.length) {
    out.push("## Outline", others.map((r) => `- **${r.label}**${r.title ? ` — ${r.title}` : ""}${r.gist ? `: ${r.gist}` : ""}`).join("\n"));
  }
  return `${out.join("\n\n")}\n`;
}

/** What to name the file: "acme-api-plan-2026-10-12.md". */
export function exportFileName(folder: string | null, date: Date): string {
  const project = (folder ? baseName(folder) : "lantern").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${project || "lantern"}-plan-${isoDate(date)}.md`;
}
