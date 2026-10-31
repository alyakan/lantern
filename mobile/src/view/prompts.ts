/**
 * What a prompt (a permission, an approval, a question) says on the phone: its tag, its title and the one line of
 * detail to read before deciding. Inputs come from Claude and may be anything, so every read is checked.
 */

export type PromptKind = "allow" | "question";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PromptView {
  kind: PromptKind;
  /** "Run a command": what sort of thing this is. */
  tag: string;
  title: string;
  /** The command, path or address to read before allowing (null: none). */
  detail: string | null;
  questions: Question[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function questionsOf(input: unknown): Question[] {
  const qs = rec(input).questions;
  if (!Array.isArray(qs)) return [];
  return qs.flatMap((q): Question[] => {
    const r = rec(q);
    const question = str(r.question);
    if (!question) return [];
    const options = Array.isArray(r.options) ? r.options.flatMap((o): QuestionOption[] => (str(rec(o).label) ? [{ label: str(rec(o).label)!, description: str(rec(o).description) ?? "" }] : [])) : [];
    return [{ question, header: str(r.header) ?? "", options, multiSelect: r.multiSelect === true }];
  });
}

/** The last part of a path: "/Users/you/dev/lantern/package.json" is "package.json". */
const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export function promptView(toolName: string, input: unknown): PromptView {
  const i = rec(input);
  if (toolName === "AskUserQuestion") {
    const questions = questionsOf(input);
    return { kind: "question", tag: "A question", title: questions[0]?.question ?? "Claude has a question", detail: null, questions };
  }
  const base = { kind: "allow" as const, questions: [] };
  const approval = approvalOf(toolName, input);
  if (approval) return { ...base, tag: "Approval", title: `Approve ${approval.action}?`, detail: approval.why || null };
  switch (toolName) {
    case "ExitPlanMode":
      return { ...base, tag: "A plan", title: "Approve Claude's plan?", detail: str(i.plan) };
    case "Bash":
      return { ...base, tag: "Run a command", title: str(i.description) ?? "Run this command?", detail: str(i.command) };
    case "Write":
      return { ...base, tag: "Write a file", title: `Write ${nameOf(str(i.file_path) ?? "a file")}?`, detail: str(i.file_path) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { ...base, tag: "Change a file", title: `Change ${nameOf(str(i.file_path) ?? str(i.notebook_path) ?? "a file")}?`, detail: str(i.file_path) ?? str(i.notebook_path) };
    case "Read":
      return { ...base, tag: "Read a file", title: `Read ${nameOf(str(i.file_path) ?? "a file")}?`, detail: str(i.file_path) };
    case "WebFetch":
      return { ...base, tag: "Open a web page", title: "Open this page?", detail: str(i.url) };
    case "WebSearch":
      return { ...base, tag: "Search the web", title: "Search the web?", detail: str(i.query) };
    default: {
      // An MCP tool is "mcp__server__tool"; say the tool, and what it was given in a line.
      const tool = toolName.startsWith("mcp__") ? toolName.split("__").slice(1).join(" ") : toolName;
      const first = Object.values(i).find((v) => typeof v === "string") as string | undefined;
      return { ...base, tag: "Use a tool", title: `Use ${tool}?`, detail: str(first) };
    }
  }
}

/** How many of a tool's inputs the decision lists. */
export const FIELDS_SHOWN = 8;

/**
 * What a tool was given, field by field, for a tool with no words of its own to show (an MCP tool): its name made readable,
 * and its value as text (anything that isn't text, as JSON). Empty ones are left out.
 */
export function fieldsOf(input: unknown): { label: string; value: string }[] {
  return Object.entries(rec(input))
    .flatMap(([k, v]) => {
      const value = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
      return value ? [{ label: k.replace(/_/g, " "), value }] : [];
    })
    .slice(0, FIELDS_SHOWN);
}

/**
 * Claude's approval card (request_approval on Lantern's MCP server): the Mac names it "Approval", with the one `action` and
 * the `details` to read before saying yes. The MCP tool's own name is kept for a Mac that ever sends it as Claude called it.
 */
export const APPROVAL_TOOL = "Approval";
const APPROVAL_TOOL_NAMES = [APPROVAL_TOOL, "mcp__lantern__request_approval"];

/** What an approval asks to approve, and what Claude says about it ("" when nothing); null when it isn't an approval. */
export function approvalOf(toolName: string, input: unknown): { action: string; why: string } | null {
  if (!APPROVAL_TOOL_NAMES.includes(toolName)) return null;
  const i = rec(input);
  return { action: str(i.action) ?? "an action", why: str(i.details) ?? str(i.reason) ?? "" };
}
