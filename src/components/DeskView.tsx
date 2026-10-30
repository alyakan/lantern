import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeskCard, DeskLive } from "../lib/desk";
import type { InboxItem } from "../lib/inbox";
import { elapsed } from "../lib/time";
import { AllowButton } from "./Inbox";

export interface DeskViewProps {
  cards: DeskCard[];
  live: DeskLive[];
  /** What waits on you, in every project (the title bar's inbox): shown here in full, last, where the eye ends. */
  needs: InboxItem[];
  /** Opens a chat. */
  onOpen: (slot: string) => void;
  /** Goes to what a waiting row is about (its chat, or the team's canvas). */
  onGo: (item: InboxItem) => void;
  onDecide: (item: InboxItem, allow: boolean) => void;
}

/** How often the times are redrawn. */
const TICK_MS = 30_000;
/** Within this of the end, the feed follows what comes in. */
const FOLLOW_PX = 80;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const OUTCOME: Record<DeskCard["outcome"], string | null> = { done: null, failed: "Failed", stopped: "Stopped" };

/**
 * The Desk: every open chat at once. Along the top, a line for each chat working or waiting on you. Below, one card for
 * each answer that finished, oldest first, each saying which chat it was in, what started it, and the start of what Claude
 * said; then what waits on you, which can be answered here as in the inbox. A chat's name opens it.
 */
export function DeskView({ cards, live, needs, onOpen, onGo, onDecide }: DeskViewProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // It opens at the end, and stays there as cards come, unless it was scrolled up to read.
  const feed = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const count = cards.length + needs.length;
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  const waiting = needs.filter((n) => n.needsYou);

  return (
    <section className="chat-pane desk" aria-label="Desk">
      <header className="desk-head">
        <h1 className="desk-title">Desk</h1>
        {live.length > 0 && (
          <ul className="desk-live" aria-label="Working now">
            {live.map((l) => (
              <li key={l.slot}>
                <button className={`desk-live-row${l.waiting ? " waiting" : ""}`} onClick={() => onOpen(l.slot)} title={`${l.title} · ${l.where}`}>
                  <span className={`node-dot ${l.waiting ? "waiting" : "working"}`} aria-hidden />
                  <span className="desk-live-name">{l.title}</span>
                  <span className="desk-live-line">{l.line}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </header>
      <div
        ref={feed}
        className="desk-feed"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
        }}
      >
        {cards.length === 0 && waiting.length === 0 && <div className="desk-empty muted">Nothing here yet. When a chat finishes an answer, it shows up here, with which chat it was in.</div>}
        {cards.map((c) => (
          <article key={c.key} className={`desk-card ${c.outcome}`} aria-label={`${c.title}: ${c.said || c.asked}`}>
            <div className="desk-card-head">
              <button className="desk-chat" onClick={() => onOpen(c.slot)} title="Open this chat">
                {c.title}
              </button>
              <span className="desk-where">{c.where}</span>
              {OUTCOME[c.outcome] && <span className={`desk-outcome ${c.outcome}`}>{OUTCOME[c.outcome]}</span>}
              {c.at !== null && (
                <time className="desk-time" dateTime={new Date(c.at).toISOString()} title={new Date(c.at).toLocaleString()}>
                  {now - c.at < 60 * 60_000 ? `${elapsed(now - c.at)} ago` : clock(c.at)}
                </time>
              )}
            </div>
            <div className={`desk-asked${c.auto ? " auto" : ""}`}>{c.auto ? "Claude went on by itself" : <><span className="desk-you">You:</span> {c.asked}</>}</div>
            {c.said && <p className="desk-said">{c.said}</p>}
          </article>
        ))}
        {waiting.map((it, at) => (
          <article key={`${it.key}:${it.requestId ?? ""}`} className="desk-card needs" aria-label={`${it.title} needs you: ${it.need}`}>
            <div className="desk-card-head">
              <button className="desk-chat" onClick={() => onGo(it)} title="Go there">
                {it.title}
              </button>
              <span className="desk-where">{it.where}</span>
              <span className="desk-outcome needs">Needs you</span>
              {it.since !== null && <span className="desk-time">{elapsed(now - it.since)}</span>}
            </div>
            <p className="desk-said">{it.need}</p>
            {it.detail !== null && <pre className="inbox-full">{it.detail}</pre>}
            <div className="desk-actions">
              {it.requestId && it.canAllow && <AllowButton key={at} title={it.title} onAllow={() => onDecide(it, true)} />}
              {it.requestId && (
                <button aria-label={`Deny ${it.title}`} onClick={() => onDecide(it, false)}>
                  Deny
                </button>
              )}
              <button aria-label={`Go to ${it.title}`} onClick={() => onGo(it)}>
                Open
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
