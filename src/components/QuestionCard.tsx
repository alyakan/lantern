import { useState } from "react";
import type { ChatItem } from "../store";
import { RECOMMENDED, answered, answersLine, readQuestions, withAnswers, type Answer } from "../lib/questions";

type PermissionItem = Extract<ChatItem, { type: "permission" }>;
/** What Claude is told when you skip its question. */
const SKIPPED = "The user chose not to answer. Carry on with your best judgement, and say what you assumed.";

type Decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>) => void;

/**
 * Claude asking you to choose (its AskUserQuestion tool): each question with its options as buttons (checkboxes when
 * several can be picked) and a field to answer in your own words. The answers go back to Claude; once sent, the card
 * folds to a line saying what you chose.
 */
export function QuestionCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const questions = readQuestions(item.input);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  if (item.decision !== null) {
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{item.decision === "allowed" ? "✓ Answered" : "✕ Skipped"}</span>
        {item.decision === "allowed" && item.note && <span className="permission-done-detail"> · {item.note}</span>}
      </div>
    );
  }
  const set = (q: string, a: Answer) => setAnswers({ ...answers, [q]: a });
  const ready = questions.length > 0 && answered(questions, answers);
  return (
    <div className="permission question-card" role="group" aria-label="Claude's question">
      <div className="permission-title">{questions.length > 1 ? `Claude has ${questions.length} questions` : "Claude is asking"}</div>
      {questions.length === 0 && <div className="settings-muted">Claude asked something Lantern couldn't read. Skip it, and answer in the chat instead.</div>}
      {questions.map((q) => {
        const a = answers[q.question] ?? { picked: [], other: "" };
        const pick = (label: string) => {
          const picked = q.multiSelect ? (a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label]) : [label];
          set(q.question, { picked, other: "" });
        };
        return (
          <fieldset key={q.question} className="question">
            <legend>
              {q.header && <span className="question-header">{q.header}</span>}
              <span className="question-text">{q.question}</span>
              {q.multiSelect && <span className="question-hint">Pick any</span>}
            </legend>
            <div className="question-options" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
              {q.options.map((o) => {
                const on = a.picked.includes(o.label) && !a.other.trim();
                return (
                  <button key={o.label} className={`question-option${on ? " on" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(o.label)}>
                    <span className="question-mark" aria-hidden>
                      {q.multiSelect ? (on ? "☑" : "☐") : on ? "●" : "○"}
                    </span>
                    <span className="question-option-text">
                      <span className="question-label">
                        {o.label.replace(RECOMMENDED, "")}
                        {RECOMMENDED.test(o.label) && <span className="question-recommended">Recommended</span>}
                      </span>
                      {o.description && <span className="question-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <input className="question-other" placeholder="Or answer in your own words…" aria-label={`Your own answer: ${q.question}`} value={a.other} onChange={(e) => set(q.question, { picked: a.picked, other: e.target.value })} />
          </fieldset>
        );
      })}
      <div className="permission-actions">
        <button className="primary" disabled={!ready} onClick={() => onDecide(item.id, true, answersLine(questions, answers), withAnswers(item.input, questions, answers))}>
          {questions.length > 1 ? "Send answers" : "Send answer"}
        </button>
        <button onClick={() => onDecide(item.id, false, SKIPPED)} title="Claude carries on without an answer">
          Skip
        </button>
      </div>
    </div>
  );
}
