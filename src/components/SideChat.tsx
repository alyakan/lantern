import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { answerOf, asideReducer, emptyAside, isWorking } from "../lib/aside";
import { usageLine } from "../lib/cost";
import { batchPerFrame } from "../lib/frameBatch";
import { useSlot } from "../lib/slot";
import type { AsideEvent } from "../types";
import { Md } from "./Md";

/** What a side question may run on. "" is the chat's own model; Haiku is the cheap one for a quick question. */
const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Same model as this chat" },
  { value: "haiku", label: "Haiku (cheapest)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];
const MODEL_KEY = "lantern.sideChatModel";

const savedModel = () => {
  const saved = localStorage.getItem(MODEL_KEY) ?? "";
  return MODELS.some((m) => m.value === saved) ? saved : "";
};

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

/**
 * A quick question about the chat, asked without disturbing it: it opens over the message box, answers from a read-only
 * copy of the conversation (see aside.rs) and is thrown away when it closes. Its answers arrive as their own events and
 * live only in this component, so they never reach the chat's messages, queue, cards or totals. It works while the chat is
 * mid-turn.
 */
export function SideChat({ onClose }: { onClose: () => void }) {
  const slot = useSlot();
  const id = useMemo(() => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, []);
  const [state, dispatch] = useReducer(asideReducer, emptyAside);
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState(savedModel);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const working = isWorking(state);
  const answered = state.turns.filter((t) => answerOf(t));
  const latest = answered[answered.length - 1];

  // Its own events only, a frame at a time like a chat's.
  useEffect(() => {
    const batch = batchPerFrame<AsideEvent>((events) => {
      for (const e of events) dispatch({ type: "event", event: e.event, note: e.note });
    });
    const unlisten = api.onAsideEvent((e) => e.aside === id && batch.push(e));
    return () => {
      batch.flush();
      unlisten.then((stop) => stop());
    };
  }, [id]);

  // Closing throws it away: its claude stops, whichever way it closed.
  useEffect(() => {
    input.current?.focus();
    return () => void api.asideStop(id).catch(() => {});
  }, [id]);

  // Escape closes it (and stops it), unless something in the message box has used the key already.
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closing.current();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  // The newest words stay in view.
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns]);

  const ask = (e: FormEvent) => {
    e.preventDefault();
    const text = question.trim();
    if (!text || working || state.ended) return;
    setQuestion("");
    dispatch({ type: "asked", question: text });
    api.asideAsk(slot, id, text, model || null).then(
      (forked) => dispatch({ type: "started", forked }),
      (err) => dispatch({ type: "failed", text: errText(err) }),
    );
  };

  const copy = () => {
    if (!latest) return;
    navigator.clipboard?.writeText(answerOf(latest)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const changeModel = (value: string) => {
    setModel(value);
    localStorage.setItem(MODEL_KEY, value);
  };

  const used = usageLine(state.cost, state.tokens);
  return (
    <div className="aside" role="dialog" aria-label="Side chat">
      <div className="aside-head">
        <span className="aside-title">Side chat</span>
        <select className="aside-model" aria-label="Model for the side chat" title={state.turns.length ? "Close this side chat to change the model" : "Which model answers"} value={model} disabled={state.turns.length > 0} onChange={(e) => changeModel(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button type="button" className="icon" aria-label="Close side chat" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="aside-body" ref={body} aria-live="polite">
        {state.turns.length === 0 && <p className="aside-empty">Ask a quick question about this chat or your files. The chat carries on without it.</p>}
        {state.forked === false && <p className="aside-note">This chat has no messages yet, so Claude has only your question to go on.</p>}
        {state.turns.map((t, i) => (
          <div key={i} className="aside-turn">
            <div className="aside-q">{t.question}</div>
            {answerOf(t) && (
              <div className="aside-a">
                <Md>{answerOf(t)}</Md>
              </div>
            )}
            {t.status === "working" && (
              <div className="aside-step" role="status">
                <span className="spinner" aria-hidden />
                <span>{t.step ?? "Thinking"}</span>
              </div>
            )}
            {t.note && <div className={`aside-note${t.status === "failed" ? " failed" : ""}`}>{t.note}</div>}
          </div>
        ))}
      </div>
      <form className="aside-ask" onSubmit={ask}>
        <input
          ref={input}
          aria-label="Side question"
          placeholder={state.ended ? "This side chat has ended" : state.turns.length ? "Ask a follow-up…" : "Ask a quick question…"}
          value={question}
          disabled={state.ended}
          onChange={(e) => setQuestion(e.target.value)}
        />
        {working ? (
          <button type="button" className="ghost" title="Stop this answer" onClick={() => void api.asideStopAnswering(id).catch(() => {})}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!question.trim() || state.ended}>
            Ask
          </button>
        )}
      </form>
      <div className="aside-foot">
        <div className="aside-promise">
          <span>This isn't added to the chat.</span>
          <span>Read only: it can read your files but not change anything.</span>
          {used && <span title="What this side chat has used. It isn't counted in the chat's own total.">Used by this side chat: {used}</span>}
        </div>
        <button type="button" className="ghost" disabled={!latest} title="Copy the latest answer" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
