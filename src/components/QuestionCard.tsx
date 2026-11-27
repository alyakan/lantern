import { createContext, useContext, useEffect, useRef, useState } from "react";
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

/**
 * The question the chat shows where its message box was (see App): the same question in the chat's stream is only a line
 * pointing down to it, so it is answered in one place.
 */
export const DockedQuestion = createContext<string | null>(null);

const NONE: Answer = { picked: [], other: "" };
const hasAnswer = (a: Answer | undefined) => answerText(a) !== "";
const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Typing somewhere a number means something else: a field, or an editor. */
const typingIn = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

/**
 * Claude asking you to choose (its AskUserQuestion tool), as the Claude app asks: one question at a time, its options as numbered
 * rows (a number key picks one), then a row to answer in your own words. Picking one of a question's options moves on to the
 * next question, the one shown fading away and the next fading in; a question where several can be picked, or one answered in
 * your own words, moves on from Next. The last answer sends them all. The arrows beside "1 of 3" go back to an earlier
 * question with its answer kept, and on again to one already reached. Once sent, the card folds to a line saying what you chose.
 *
 * `docked`: shown in place of the chat's message box, where number keys pick wherever the focus is (unless it is in a field).
 */
export function QuestionCard({ item, onDecide, docked = false }: { item: PermissionItem; onDecide: Decide; docked?: boolean }) {
  const questions = readQuestions(item.input);
  const dockedHere = useContext(DockedQuestion);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [step, setStep] = useState(0);
  // The furthest question reached: the arrows go back and forth up to it.
  const [reached, setReached] = useState(0);
  const [leaving, setLeaving] = useState(false);
  // Which way the next question comes in: from the right going on, from the left going back.
  const [back, setBack] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  // The number keys, for the question shown now (kept fresh each render for the window's listener).
  const digit = useRef<(n: number) => void>(() => {});
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Answered from elsewhere (the phone), or gone: nothing waiting to move on or send.
  useEffect(() => stop, []);
  useEffect(() => {
    if (item.decision !== null) stop();
  }, [item.decision]);
  useEffect(() => {
    if (!docked || item.decision !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const focus = document.activeElement;
      // Not while something else is typed in, or another part of the window (the Files editor) has the keys.
      if (typingIn(focus) || (focus && focus !== document.body && !root.current?.contains(focus))) return;
      e.preventDefault();
      digit.current(Number(e.key) - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docked, item.decision]);

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
  // In the stream while the same question waits where the message box is: a line pointing to it.
  if (!docked && dockedHere === item.id) {
    return (
      <div className="question-pointer" role="note">
        {who} is asking {questions.length > 1 ? `${questions.length} questions` : "a question"} below
      </div>
    );
  }
  const many = questions.length > 1;
  const at = Math.min(step, Math.max(questions.length - 1, 0));
  const last = at === questions.length - 1;
  const cardClass = `permission question-card${docked ? " question-dock" : ""}`;

  const send = (all: Record<string, Answer>) => {
    if (sent.current) return;
    sent.current = true;
    stop();
    onDecide(item.id, true, answersLine(questions, all), withAnswers(item.input, questions, all));
  };
  const skip = () => {
    stop();
    sent.current = true;
    onDecide(item.id, false, SKIPPED);
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
      // The last question answered while an earlier one isn't: to the first that waits.
      if (last) return go(questions.findIndex((q) => !hasAnswer(all[q.question])));
    }
    if (last) send(all);
    else go(at + 1);
  };

  if (questions.length === 0) {
    return (
      <div className={cardClass} role="group" aria-label={`${who}'s question`}>
        <div className="question-kicker">{who} is asking</div>
        <div className="settings-muted">{who} asked something Lantern couldn't read. Skip it, and answer in the chat instead.</div>
        <div className="question-foot">
          <span />
          <button onClick={() => onDecide(item.id, false, SKIPPED)} title={`${who} carries on without an answer`}>
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
  // Picked with a click, Enter or its number: a question with one answer moves on once the pick has been seen. Arrows pick
  // without moving on.
  const pick = (label: string, moveOn: boolean) => {
    const picked = q.multiSelect ? (a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label]) : [label];
    const all = set({ picked, other: "" });
    if (!moveOn || q.multiSelect) return;
    stop();
    timer.current = setTimeout(() => onward(all), PICK_BEAT_MS);
  };
  digit.current = (n) => {
    if (!leaving && q.options[n]) pick(q.options[n].label, true);
  };
  const anyPicked = q.options.some((x) => a.picked.includes(x.label)) && !a.other.trim();
  const ready = hasAnswer(a);
  const allReady = questions.every((x) => hasAnswer(answers[x.question]));
  const sendLabel = many ? "Send answers" : "Send answer";

  return (
    <div
      ref={root}
      className={cardClass}
      role="group"
      aria-label={`${who}'s question`}
      onKeyDown={
        docked
          ? undefined
          : (e) => {
              if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key) || typingIn(e.target as Element)) return;
              e.preventDefault();
              digit.current(Number(e.key) - 1);
            }
      }
    >
      <div className="question-top">
        <span className="question-kicker">{many ? `${who} has ${questions.length} questions` : `${who} is asking`}</span>
        {many && (
          <div className="question-pager" role="group" aria-label="Questions">
            <button className="question-arrow" aria-label="Previous question" title="Previous question" disabled={at === 0} onClick={() => go(at - 1)}>
              <span className="question-chev back" aria-hidden />
            </button>
            <span className="question-count" aria-live="polite">
              {at + 1} of {questions.length}
            </span>
            <button className="question-arrow" aria-label="Next question" title="Next question" disabled={at >= reached} onClick={() => go(at + 1)}>
              <span className="question-chev" aria-hidden />
            </button>
          </div>
        )}
      </div>
      <div key={q.question} className={`question question-step${back ? " back" : ""}${leaving ? " leaving" : ""}`}>
        <div className="question-text" id={`${item.id}-q`}>
          {q.question}
        </div>
        <div
          className="question-options"
          role={q.multiSelect ? "group" : "radiogroup"}
          aria-labelledby={`${item.id}-q`}
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
                <span className="question-num" aria-hidden>
                  {i + 1}
                </span>
                <span className="question-option-text">
                  <span className="question-label">
                    {o.label.replace(RECOMMENDED, "")}
                    {RECOMMENDED.test(o.label) && <span className="question-recommended">Recommended</span>}
                  </span>
                  {o.description && <span className="question-desc">{o.description}</span>}
                </span>
                {on && (
                  <span className="question-check" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
          <label className={`question-own${a.other.trim() ? " on" : ""}`}>
            <span className="question-num pen" aria-hidden>
              ✎
            </span>
            <input
              className="question-other"
              placeholder="Something else…"
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
          </label>
        </div>
      </div>
      <div className="question-foot">
        <span className="question-hint">{q.multiSelect ? (last ? "Pick any, then send" : "Pick any, then Next") : q.options.length > 1 ? `Pick one, or press 1–${Math.min(q.options.length, 9)}` : "Pick it, or write your own"}</span>
        <div className="question-buttons">
          <button className="question-skip" onClick={skip} title={`${who} carries on without an answer`}>
            Skip
          </button>
          <button className="primary" disabled={last ? !allReady : !ready} onClick={() => onward(answers)}>
            {last ? sendLabel : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
