import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ChatItem } from "../store";
import { RECOMMENDED, answerText, answersLine, readQuestions, withAnswers, type Answer, type Question } from "../lib/questions";
import { moveFocus } from "./useMenuKeys";
import { CLAUDE, providerName } from "../lib/provider";

type PermissionItem = Extract<ChatItem, { type: "permission" }>;
/** What Claude is told when you skip its question. */
const SKIPPED = "The user chose not to answer. Carry on with your best judgement, and say what you assumed.";

type Decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>) => void;

/**
 * How long a picked option shows as picked before the card moves on (long enough to see it, the other options dimming
 * beside it), and how long a question takes to fade away. The next one comes in over STEP_IN_MS (in styles.css), and the
 * card's height glides to it over the same time.
 */
export const PICK_BEAT_MS = 450;
export const LEAVE_MS = 200;

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
 * rows (a number key picks one), then a row to answer in your own words. Picking one of a question's options holds it lit for
 * a beat (the others dimming), then moves on to the next question, the one shown fading away and the next easing in, the card's
 * height gliding between them; a question where several can be picked, or one answered in your own words, moves on from Next.
 * After the last comes a recap: each question with what you chose (click one, or press its number, to change it), and Send.
 * Nothing goes until Send. The arrows beside "1 of 3" go back to an earlier question with its answer kept, and on again to one
 * already reached. Once sent, the card folds to a line saying what you chose.
 *
 * `docked`: shown in place of the chat's message box, where number keys pick wherever the focus is (unless it is in a field).
 */
/**
 * The height of what `inner` holds, for a box around it to glide to (with a CSS transition on its height) instead of
 * jumping when a question with more or fewer options comes in. Undefined (the box takes its natural height) until measured,
 * and where the browser has no ResizeObserver (tests).
 */
function useGlideHeight() {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { inner, height };
}

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
  const sendButton = useRef<HTMLButtonElement>(null);
  // A pick being shown before the card moves on: the other options dim.
  const [settling, setSettling] = useState(false);
  const glide = useGlideHeight();
  // The number keys, for the question shown now (kept fresh each render for the window's listener).
  const digit = useRef<(n: number) => void>(() => {});
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSettling(false);
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
  // On the recap, Send takes the focus, so Enter sends (unless the focus is somewhere else in the window).
  const onRecap = questions.length > 0 && step >= questions.length;
  useEffect(() => {
    if (!onRecap || leaving) return;
    const focus = document.activeElement;
    if (!focus || focus === document.body || root.current?.contains(focus)) sendButton.current?.focus({ preventScroll: true });
  }, [onRecap, leaving]);

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
  // Past the last question: the recap of what was chosen, with Send.
  const recap = onRecap;
  const at = recap ? questions.length : Math.min(step, Math.max(questions.length - 1, 0));
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
    // Set first, so the question shown leaves the way the next comes from.
    setBack(to < at);
    const swap = () => {
      timer.current = null;
      setLeaving(false);
      setSettling(false);
      setStep(to);
      setReached((r) => Math.max(r, to));
    };
    if (reducedMotion()) return swap();
    setLeaving(true);
    timer.current = setTimeout(swap, LEAVE_MS);
  };
  // On from the question shown, with these answers: to the next, or, from the last, to the recap (or to the first question
  // still waiting for an answer, if one is).
  const onward = (all: Record<string, Answer>) => {
    if (!last) return go(at + 1);
    const waiting = questions.findIndex((q) => !hasAnswer(all[q.question]));
    go(waiting === -1 ? questions.length : waiting);
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

  const allReady = questions.every((x) => hasAnswer(answers[x.question]));
  const sendLabel = many ? "Send answers" : "Send answer";
  const onKeyDown = docked
    ? undefined
    : (e: ReactKeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key) || typingIn(e.target as Element)) return;
        e.preventDefault();
        digit.current(Number(e.key) - 1);
      };
  const top = (
    <div className="question-top">
      <span className="question-kicker">{many ? `${who} has ${questions.length} questions` : `${who} is asking`}</span>
      {many && (
        <div className="question-pager" role="group" aria-label="Questions">
          <button className="question-arrow" aria-label="Previous question" title="Previous question" disabled={at === 0} onClick={() => go(at - 1)}>
            <span className="question-chev back" aria-hidden />
          </button>
          <span className="question-count" aria-live="polite">
            {recap ? "Review" : `${at + 1} of ${questions.length}`}
          </span>
          <button className="question-arrow" aria-label="Next question" title="Next question" disabled={at >= reached} onClick={() => go(at + 1)}>
            <span className="question-chev" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
  const card = (body: ReactNode, foot: ReactNode) => (
    <div ref={root} className={cardClass} role="group" aria-label={`${who}'s question`} onKeyDown={onKeyDown}>
      {top}
      {/* The card's height glides from one question to the next, instead of jumping to it. */}
      <div className="question-glide" style={glide.height === undefined ? undefined : { height: glide.height }}>
        <div ref={glide.inner}>{body}</div>
      </div>
      {foot}
    </div>
  );

  if (recap) {
    // What you chose, one row a question: a click (or its number) goes back to change it.
    digit.current = (n) => {
      if (!leaving && questions[n]) go(n);
    };
    return card(
      <div key="recap" className={`question question-step${back ? " back" : ""}${leaving ? " leaving" : ""}`}>
        <div className="question-text" id={`${item.id}-recap`}>
          {many ? "Check your answers" : "Check your answer"}
        </div>
        <div className="question-options question-recap" role="list" aria-labelledby={`${item.id}-recap`}>
          {questions.map((x, i) => {
            const text = answerText(answers[x.question]);
            return (
              <button key={x.question} role="listitem" className="question-option question-recap-row" aria-label={`${x.question}: ${text || "no answer yet"}. Change it`} title="Change this answer" onClick={() => go(i)}>
                <span className="question-num" aria-hidden>
                  {i + 1}
                </span>
                <span className="question-option-text">
                  <span className="question-desc">{x.question}</span>
                  <span className={`question-label${text ? "" : " missing"}`}>{text ? text.replace(RECOMMENDED, "") : "No answer yet"}</span>
                </span>
                <span className="question-recap-change" aria-hidden>
                  Change
                </span>
              </button>
            );
          })}
        </div>
      </div>,
      <div className="question-foot">
        <span className="question-hint">{many ? "Click one to change it" : "Click it to change it"}</span>
        <div className="question-buttons">
          <button className="question-skip" onClick={skip} title={`${who} carries on without an answer`}>
            Skip
          </button>
          <button ref={sendButton} className="primary" disabled={!allReady || leaving} onClick={() => send(answers)}>
            {sendLabel}
          </button>
        </div>
      </div>,
    );
  }

  const q: Question = questions[at];
  const a = answers[q.question] ?? NONE;
  const set = (next: Answer) => {
    const all = { ...answers, [q.question]: next };
    setAnswers(all);
    return all;
  };
  // Picked with a click, Enter or its number: a question with one answer moves on once the pick has been seen (the other
  // options dimming meanwhile). Arrows pick without moving on.
  const pick = (label: string, moveOn: boolean) => {
    const picked = q.multiSelect ? (a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label]) : [label];
    const all = set({ picked, other: "" });
    if (!moveOn || q.multiSelect) return;
    stop();
    setSettling(true);
    timer.current = setTimeout(() => onward(all), PICK_BEAT_MS);
  };
  digit.current = (n) => {
    if (!leaving && q.options[n]) pick(q.options[n].label, true);
  };
  const anyPicked = q.options.some((x) => a.picked.includes(x.label)) && !a.other.trim();
  const ready = hasAnswer(a);

  return card(
    <div key={q.question} className={`question question-step${back ? " back" : ""}${leaving ? " leaving" : ""}`}>
      <div className="question-text" id={`${item.id}-q`}>
        {q.question}
      </div>
      <div
        className={`question-options${settling || leaving ? " settling" : ""}`}
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
    </div>,
    <div className="question-foot">
      <span className="question-hint">{q.multiSelect ? "Pick any, then Next" : q.options.length > 1 ? `Pick one, or press 1–${Math.min(q.options.length, 9)}` : "Pick it, or write your own"}</span>
      <div className="question-buttons">
        <button className="question-skip" onClick={skip} title={`${who} carries on without an answer`}>
          Skip
        </button>
        <button className="primary" disabled={!ready || leaving} onClick={() => onward(answers)}>
          Next
        </button>
      </div>
    </div>,
  );
}
