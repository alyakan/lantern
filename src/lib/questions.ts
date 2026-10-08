/**
 * AskUserQuestion: Claude asking the user to choose (one to four questions, two to four options each, or several
 * when `multiSelect`). The answers go back in the tool's input, as the Agent SDK does: `answers`, keyed by the
 * question's text, each the chosen label (several joined with ", ") or what the user wrote instead.
 */
export const QUESTION_TOOL = "AskUserQuestion";

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

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The questions in the tool's input, skipping anything malformed. */
export function readQuestions(input: unknown): Question[] {
  const list = input && typeof input === "object" ? (input as { questions?: unknown }).questions : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((q): Question[] => {
    if (!q || typeof q !== "object" || !str((q as { question?: unknown }).question)) return [];
    const o = q as { question: string; header?: unknown; options?: unknown; multiSelect?: unknown };
    const options = Array.isArray(o.options)
      ? o.options.flatMap((x): QuestionOption[] => (x && typeof x === "object" && str((x as { label?: unknown }).label) ? [{ label: str((x as { label: string }).label), description: str((x as { description?: unknown }).description) }] : []))
      : [];
    return [{ question: o.question, header: str(o.header), options, multiSelect: o.multiSelect === true }];
  });
}

/** Claude marks the option it recommends: "(Recommended)" at the end of its label. */
export const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** One question's answer: the picked labels, or what the user wrote instead when they wrote something. */
export interface Answer {
  picked: string[];
  other: string;
}

export const answerText = (a: Answer | undefined) => (a?.other.trim() ? a.other.trim() : (a?.picked ?? []).join(", "));

export const answered = (qs: Question[], answers: Record<string, Answer>) => qs.every((q) => answerText(answers[q.question]) !== "");

/** The tool's input with the answers in, as it goes back to Claude. */
export function withAnswers(input: unknown, qs: Question[], answers: Record<string, Answer>): Record<string, unknown> {
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return { ...base, answers: Object.fromEntries(qs.map((q) => [q.question, answerText(answers[q.question])])) };
}

/** A line for the chat once answered: "Database: SQLite · Tests: Unit, E2E". */
export function answersLine(qs: Question[], answers: Record<string, Answer>): string {
  return qs.map((q) => `${q.header || q.question}: ${answerText(answers[q.question])}`).join(" · ");
}
