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
  switch (toolName) {
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

/** The text Claude's approval card (request_approval) asks to approve: shown as the detail of its own tag. */
export const APPROVAL_TOOL = "mcp__lantern__request_approval";

/** Whether a prompt can be answered from the phone: everything can, but an approval says what it approves first. */
export function approvalOf(toolName: string, input: unknown): { action: string; why: string } | null {
  if (toolName !== APPROVAL_TOOL) return null;
  const i = rec(input);
  return { action: str(i.action) ?? "an action", why: str(i.reason) ?? "" };
}
