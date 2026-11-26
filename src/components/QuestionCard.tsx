import { useEffect, useRef, useState } from "react";
import type { ChatItem } from "../store";
import { RECOMMENDED, answerText, answersLine, readQuestions, withAnswers, type Answer, type Question } from "../lib/questions";
import { moveFocus } from "./useMenuKeys";
import { CLAUDE, providerName } from "../lib/provider";

type PermissionItem = Extract<ChatItem, { type: "permission" }>;
/** What Claude is told when you skip its question. */
const SKIPPED = "The user chose not to answer. Carry on with your best judgement, and say what you assumed.";

type Decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>) => void;

/** How long a picked option shows as picked before the card moves on (so the pick is seen), and how long a question takes to fade away. */
export const PICK_BEAT_MS = 180;
export const LEAVE_MS = 140;

const NONE: Answer = { picked: [], other: "" };
const hasAnswer = (a: Answer | undefined) => answerText(a) !== "";
const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Claude asking you to choose (its AskUserQuestion tool), one question at a time as the Claude app asks: its options as buttons
 * (checkboxes when several can be picked) and a field to answer in your own words. Picking one of a question's options moves on
 * to the next question, the one shown fading away and the next fading in; a question where several can be picked, or one
 * answered in your own words, moves on from Next. The last answer sends them all. Back, or a step's dot, goes to an earlier
 * question with its answer kept. Once sent, the card folds to a line saying what you chose.
 */
export function QuestionCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const questions = readQuestions(item.input);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [step, setStep] = useState(0);
  // The furthest question reached: its dot, and those before it, go back to it.
  const [reached, setReached] = useState(0);
  const [leaving, setLeaving] = useState(false);
  // Which way the next question comes in: from the right going on, from the left going back.
  const [back, setBack] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef(false);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Answered from elsewhere (the phone), or gone: nothing waiting to move on or send.
  useEffect(() => stop, []);
  useEffect(() => {
    if (item.decision !== null) stop();
  }, [item.decision]);
  if (item.decision !== null) {
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{item.decision === "allowed" ? "✓ Answered" : "✕ Skipped"}</span>
        {item.decision === "allowed" && item.note && <span className="permission-done-detail"> · {item.note}</span>}
      </div>
    );
  }
  // The agent the chat runs on, by name: Claude, or another one that asked (Antigravity).
  const who = providerName(item.provider ?? CLAUDE);
  const many = questions.length > 1;
  const at = Math.min(step, Math.max(questions.length - 1, 0));
  const last = at === questions.length - 1;

  const send = (all: Record<string, Answer>) => {
    if (sent.current) return;
    sent.current = true;
    stop();
    onDecide(item.id, true, answersLine(questions, all), withAnswers(item.input, questions, all));
  };
  // To question `to`: the one shown fades away first (at once when motion is reduced).
  const go = (to: number) => {
    stop();
    const swap = () => {
      timer.current = null;
      setLeaving(false);
      setBack(to < at);
      setStep(to);
      setReached((r) => Math.max(r, to));
    };
    if (reducedMotion()) return swap();
    setLeaving(true);
    timer.current = setTimeout(swap, LEAVE_MS);
  };
  // On from the question shown, with these answers: to the next, or, from the last, they all go.
  const onward = (all: Record<string, Answer>) => {
    if (!questions.every((q) => hasAnswer(all[q.question]))) {
      // The last question answered while an earlier one isn't (a dot skipped ahead): to the first that waits.
      if (last) return go(questions.findIndex((q) => !hasAnswer(all[q.question])));
    }
    if (last) send(all);
    else go(at + 1);
  };

  if (questions.length === 0) {
    return (
      <div className="permission question-card" role="group" aria-label={`${who}'s question`}>
        <div className="permission-title">{who} is asking</div>
        <div className="settings-muted">{who} asked something Lantern couldn't read. Skip it, and answer in the chat instead.</div>
        <div className="permission-actions">
          <button onClick={() => onDecide(item.id, false, SKIPPED)} title="Claude carries on without an answer">
            Skip
          </button>
        </div>
      </div>
    );
  }

  const q: Question = questions[at];
  const a = answers[q.question] ?? NONE;
  const set = (next: Answer) => {
    const all = { ...answers, [q.question]: next };
    setAnswers(all);
    return all;
  };
  // Picked with a click (or Enter): a question with one answer moves on once the pick has been seen. Arrows pick without moving on.
  const pick = (label: string, moveOn: boolean) => {
    const picked = q.multiSelect ? (a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label]) : [label];
    const all = set({ picked, other: "" });
    if (!moveOn || q.multiSelect) return;
    stop();
    timer.current = setTimeout(() => onward(all), PICK_BEAT_MS);
  };
  const anyPicked = q.options.some((x) => a.picked.includes(x.label)) && !a.other.trim();
  const ready = hasAnswer(a);
  const allReady = questions.every((x) => hasAnswer(answers[x.question]));
  const sendLabel = many ? "Send answers" : "Send answer";

  return (
    <div className="permission question-card" role="group" aria-label={`${who}'s question`}>
      <div className="question-top">
        <div className="permission-title">{many ? `${who} has ${questions.length} questions` : `${who} is asking`}</div>
        {many && (
          <div className="question-steps" role="group" aria-label="Questions">
            <span className="question-count" aria-live="polite">
              {at + 1} of {questions.length}
            </span>
            {questions.map((x, i) => (
              <button
                key={x.question}
                className={`question-dot${i === at ? " current" : hasAnswer(answers[x.question]) ? " done" : ""}`}
                aria-label={`Question ${i + 1}${x.header ? `: ${x.header}` : ""}${hasAnswer(answers[x.question]) ? ", answered" : ""}`}
                aria-current={i === at ? "step" : undefined}
                disabled={i > reached || i === at}
                onClick={() => go(i)}
              />
            ))}
          </div>
        )}
      </div>
      <fieldset key={q.question} className={`question question-step${back ? " back" : ""}${leaving ? " leaving" : ""}`}>
        <legend>
          {q.header && <span className="question-header">{q.header}</span>}
          <span className="question-text">{q.question}</span>
          {q.multiSelect && <span className="question-hint">Pick any</span>}
        </legend>
        <div
          className="question-options"
          role={q.multiSelect ? "group" : "radiogroup"}
          aria-label={q.question}
          onKeyDown={(e) => {
            // Arrows move between the options; with radio buttons, moving also picks, as a radio group does (without moving on).
            const to = moveFocus(e, [...e.currentTarget.querySelectorAll<HTMLElement>("button")]);
            if (to !== null && !q.multiSelect) pick(q.options[to].label, false);
          }}
        >
          {q.options.map((o, i) => {
            const on = a.picked.includes(o.label) && !a.other.trim();
            // One radio is in the tab order: the picked one, or the first while none is.
            const tabbable = q.multiSelect || (anyPicked ? on : i === 0);
            return (
              <button key={o.label} className={`question-option${on ? " on" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} tabIndex={tabbable ? undefined : -1} onClick={() => pick(o.label, true)}>
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
        <input
          className="question-other"
          placeholder="Or answer in your own words…"
          aria-label={`Your own answer: ${q.question}`}
          value={a.other}
          onChange={(e) => {
            stop();
            set({ picked: a.picked, other: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && a.other.trim()) {
              e.preventDefault();
              onward(answers);
            }
          }}
        />
      </fieldset>
      <div className="permission-actions">
        <button className="primary" disabled={last ? !allReady : !ready} onClick={() => onward(answers)}>
          {last ? sendLabel : "Next"}
        </button>
        {at > 0 && <button onClick={() => go(at - 1)}>Back</button>}
        <button
          onClick={() => {
            stop();
            sent.current = true;
            onDecide(item.id, false, SKIPPED);
          }}
          title="Claude carries on without an answer"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
