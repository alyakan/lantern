import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DeskCard, DeskEntry, DeskLive } from "../lib/desk";
import { deskOf, HOME_ID, moveProject, removeDesk, renameDesk, type Desks } from "../lib/desks";
import type { InboxItem } from "../lib/inbox";
import { elapsed } from "../lib/time";
import type { ChatHit } from "../types";
import { AllowButton } from "./Inbox";

/** A chat a message can be sent to from the box, as its "to" menu lists it. */
export interface DeskTarget {
  slot: string;
  title: string;
  where: string;
}

export interface DeskViewProps {
  cards: DeskCard[];
  live: DeskLive[];
  /** What waits on you on this Desk (the title bar's inbox): shown here in full, last, where the eye ends. */
  needs: InboxItem[];
  /** The messages typed on this Desk, with where each went. */
  entries: DeskEntry[];
  /** The chats on this Desk, for the box's "to" menu and "Send it there too". */
  targets: DeskTarget[];
  desks: {
    value: Desks;
    /** How many things wait on you on each Desk. */
    waiting: Record<string, number>;
    /** Every project known (open, or on a Desk), with its name: what the Desks editor lists. */
    projects: { folder: string; label: string }[];
    onChange: (desks: Desks) => void;
    onAdd: (name: string) => void;
  };
  /** The box can send (Claude is located): the router needs it. */
  canSend: boolean;
  /** `to`: a chat picked in the box's menu; none lets the Desk pick. */
  onSend: (text: string, to: string | null) => void;
  /** Sends an entry's words to a chat as well (after a question, or "Send it there too"). */
  onSendTo: (entry: DeskEntry, slot: string) => void;
  /** Starts a chat in a project with an entry's words (the router's question, when it couldn't tell). */
  onStartIn: (entry: DeskEntry, folder: string) => void;
  onOpenPast: (hit: ChatHit) => void;
  onOpen: (slot: string) => void;
  onGo: (item: InboxItem) => void;
  onDecide: (item: InboxItem, allow: boolean) => void;
}

/** How often the times are redrawn. */
const TICK_MS = 30_000;
/** Within this of the end, the feed follows what comes in. */
const FOLLOW_PX = 80;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (now: number, at: number) => (now - at < 60_000 ? "just now" : now - at < 60 * 60_000 ? `${elapsed(now - at)} ago` : clock(at));
const OUTCOME: Record<DeskCard["outcome"], string | null> = { done: null, failed: "Failed", stopped: "Stopped" };

/** The past chats with the words a "which chat…?" message was about (found once, with the message): each opens where it is. */
function SearchHits({ terms, hits, onOpenPast }: { terms: string; hits: ChatHit[] | null | "failed"; onOpenPast: DeskViewProps["onOpenPast"] }) {
  if (hits === null) return <div className="desk-note muted">Looking through your chats for “{terms}”…</div>;
  if (hits === "failed") return <div className="desk-note">Couldn't look through your chats just now.</div>;
  if (hits.length === 0) return <div className="desk-note">No chat on this Desk mentions “{terms}”.</div>;
  return (
    <div className="desk-note">
      <div>Chats that mention “{terms}”:</div>
      <ul className="desk-hits">
        {hits.slice(0, 5).map((h) => (
          <li key={h.id}>
            <button className="desk-hit" onClick={() => onOpenPast(h)}>
              <span className="desk-hit-title">{h.title.map((p) => p.text).join("") || "Untitled chat"}</span>
              <span className="desk-where">
                {h.project} · {new Date(h.updated_ms).toLocaleDateString([], { month: "short", day: "numeric" })}
              </span>
              {h.snippets[0] && <span className="desk-hit-snippet">{h.snippets[0].pieces.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Send it there too": the chats on this Desk the message hasn't gone to. */
function SendToo({ entry, targets, onSendTo }: { entry: DeskEntry; targets: DeskTarget[]; onSendTo: DeskViewProps["onSendTo"] }) {
  const sent = new Set([...(entry.outcome.kind === "sent" ? [entry.outcome.slot] : []), ...entry.also.map((a) => a.slot)]);
  const left = targets.filter((t) => !sent.has(t.slot));
  if (!left.length) return null;
  return (
    <select
      className="desk-too"
      aria-label="Send it to another chat too"
      value=""
      onChange={(e) => {
        if (e.target.value) onSendTo(entry, e.target.value);
      }}
    >
      <option value="">Send it there too…</option>
      {left.map((t) => (
        <option key={t.slot} value={t.slot}>
          {t.title} · {t.where}
        </option>
      ))}
    </select>
  );
}

/** A message typed on the Desk: your words, then where they went (or the Desk's question, or what it found). */
function Entry({ entry, now, ...p }: { entry: DeskEntry; now: number } & Pick<DeskViewProps, "targets" | "onSendTo" | "onStartIn" | "onOpenPast" | "onOpen">) {
  const o = entry.outcome;
  return (
    <article className="desk-entry" aria-label={`You on the Desk: ${entry.text}`}>
      <div className="desk-me">{entry.text}</div>
      <div className="desk-route">
        {o.kind === "routing" && <span className="muted">Finding the chat…</span>}
        {o.kind === "sent" && (
          <>
            <span>
              → {o.started ? "started " : o.queued ? "queued in " : "sent to "}
              <button className="desk-chat inline" onClick={() => p.onOpen(o.slot)}>
                {o.title}
              </button>
            </span>
            {entry.also.map((a) => (
              <span key={a.slot}>
                , and{" "}
                <button className="desk-chat inline" onClick={() => p.onOpen(a.slot)}>
                  {a.title}
                </button>
              </span>
            ))}
            <SendToo entry={entry} targets={p.targets} onSendTo={p.onSendTo} />
          </>
        )}
        {o.kind === "failed" && <span className="desk-failed">Not sent: {o.why}</span>}
        <time className="desk-time">{ago(now, entry.at)}</time>
      </div>
      {o.kind === "ask" && (
        <div className="desk-note">
          <div>{o.unsure ? "I couldn't work out where this goes. Where should it go?" : "Which chat is this for?"}</div>
          <div className="desk-actions">
            {o.chats.map((c) => (
              <button key={c.slot} onClick={() => p.onSendTo(entry, c.slot)}>
                {c.title} <span className="desk-where">{c.where}</span>
              </button>
            ))}
            {o.projects.map((pr) => (
              <button key={pr.folder} onClick={() => p.onStartIn(entry, pr.folder)}>
                New chat in {pr.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {o.kind === "search" && <SearchHits terms={o.terms} hits={o.hits} onOpenPast={p.onOpenPast} />}
    </article>
  );
}

/** Which Desk is on screen, and the way to make more and say which projects are on each. */
function DeskTabs({ desks }: { desks: DeskViewProps["desks"] }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const { value } = desks;
  const many = value.list.length > 1;
  return (
    <div className="desk-tabs">
      {many ? (
        <div role="tablist" aria-label="Desks" className="desk-tablist">
          {value.list.map((d) => (
            <button key={d.id} role="tab" aria-selected={d.id === value.on} className={`desk-tab${d.id === value.on ? " on" : ""}`} onClick={() => desks.onChange({ ...value, on: d.id })}>
              {d.name}
              {d.id !== value.on && (desks.waiting[d.id] ?? 0) > 0 && (
                <span className="desk-tab-badge" aria-label={`${desks.waiting[d.id]} waiting`}>
                  {desks.waiting[d.id]}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <h1 className="desk-title">Desk</h1>
      )}
      <button className="desk-edit" aria-expanded={editing} onClick={() => setEditing(!editing)}>
        {editing ? "Done" : many ? "Edit Desks" : "Split into Desks…"}
      </button>
      {editing && (
        <div className="desk-editor" role="group" aria-label="Desks">
          <p className="muted">Each project is on one Desk. A Desk shows only its projects' chats, and what you type on it goes only to them.</p>
          {value.list.length > 1 &&
            value.list.map((d) => (
              <div key={d.id} className="desk-editor-row">
                <input aria-label={`Name of ${d.name}`} defaultValue={d.name} maxLength={40} onBlur={(e) => e.target.value.trim() !== d.name && desks.onChange(renameDesk(value, d.id, e.target.value))} />
                {d.id !== HOME_ID && (
                  <button aria-label={`Remove ${d.name}`} title="Its projects go back to the first Desk" onClick={() => desks.onChange(removeDesk(value, d.id))}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          <form
            className="desk-editor-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) desks.onAdd(name.trim());
              setName("");
            }}
          >
            <input aria-label="New Desk's name" placeholder="New Desk, e.g. Work" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!name.trim()}>
              Add
            </button>
          </form>
          {value.list.length > 1 && desks.projects.length > 0 && (
            <ul className="desk-editor-projects">
              {desks.projects.map((pr) => {
                return (
                  <li key={pr.folder}>
                    <span title={pr.folder}>{pr.label}</span>
                    <select
                      aria-label={`Desk for ${pr.label}`}
                      value={deskOf(value, pr.folder)}
                      onChange={(e) => desks.onChange(moveProject(value, pr.folder, e.target.value))}
                    >
                      {value.list.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The Desk's box: what you type goes to the chat the Desk picks, or the one picked in its menu. */
function DeskBox({ targets, canSend, onSend }: Pick<DeskViewProps, "targets" | "canSend" | "onSend">) {
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  // A picked chat that closed meanwhile goes back to the Desk picking.
  const target = targets.some((t) => t.slot === to) ? to : "";
  const send = () => {
    if (!text.trim() || !canSend) return;
    onSend(text.trim(), target || null);
    setText("");
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="desk-box">
      <select className="desk-to" aria-label="Send to" value={target} onChange={(e) => setTo(e.target.value)} title="Where what you type goes">
        <option value="">→ Desk picks</option>
        {targets.map((t) => (
          <option key={t.slot} value={t.slot}>
            → {t.title} · {t.where}
          </option>
        ))}
      </select>
      <textarea aria-label="Tell Lantern" placeholder={canSend ? "Tell Lantern… (it goes to the right chat, or starts one)" : "Waiting for Claude Code…"} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys} />
      <button className="primary" aria-label="Send" disabled={!text.trim() || !canSend} onClick={send}>
        Send
      </button>
    </div>
  );
}

/**
 * The Desk: every open chat at once. Along the top, a line for each chat working or waiting on you. Below, one card for
 * each answer that finished, oldest first, each saying which chat it was in, what started it, and the start of what Claude
 * said, with your Desk messages among them where they were sent; then what waits on you, which can be answered here as in
 * the inbox. At the bottom, the box: what you type goes to the right chat. A chat's name opens it.
 */
export function DeskView(props: DeskViewProps) {
  const { cards, live, needs, entries, onOpen, onGo, onDecide } = props;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // It opens at the end, and stays there as cards come, unless it was scrolled up to read.
  const feed = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const waiting = needs.filter((n) => n.needsYou);
  const last = entries[entries.length - 1];
  const shape = `${cards.length}:${waiting.length}:${entries.length}:${last?.outcome.kind ?? ""}`;
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shape]);
  // Cards and Desk messages in the order they were said; one whose time isn't known goes first.
  const rows: ({ kind: "card"; at: number; card: DeskCard } | { kind: "entry"; at: number; entry: DeskEntry })[] = [...cards.map((card) => ({ kind: "card" as const, at: card.at ?? -1, card })), ...entries.map((entry) => ({ kind: "entry" as const, at: entry.at, entry }))].sort((a, b) => a.at - b.at);

  return (
    <section className="chat-pane desk" aria-label="Desk">
      <header className="desk-head">
        <DeskTabs desks={props.desks} />
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
        {rows.length === 0 && waiting.length === 0 && <div className="desk-empty muted">Nothing here yet. Type below and it goes to the right chat; when a chat finishes an answer, it shows up here, with which chat it was in.</div>}
        {rows.map((r) =>
          r.kind === "entry" ? (
            <Entry key={r.entry.id} entry={r.entry} now={now} targets={props.targets} onSendTo={props.onSendTo} onStartIn={props.onStartIn} onOpenPast={props.onOpenPast} onOpen={onOpen} />
          ) : (
            <article key={r.card.key} className={`desk-card ${r.card.outcome}`} aria-label={`${r.card.title}: ${r.card.said || r.card.asked}`}>
              <div className="desk-card-head">
                <button className="desk-chat" onClick={() => onOpen(r.card.slot)} title="Open this chat">
                  {r.card.title}
                </button>
                <span className="desk-where">{r.card.where}</span>
                {OUTCOME[r.card.outcome] && <span className={`desk-outcome ${r.card.outcome}`}>{OUTCOME[r.card.outcome]}</span>}
                {r.card.at !== null && (
                  <time className="desk-time" dateTime={new Date(r.card.at).toISOString()} title={new Date(r.card.at).toLocaleString()}>
                    {ago(now, r.card.at)}
                  </time>
                )}
              </div>
              <div className={`desk-asked${r.card.auto ? " auto" : ""}`}>
                {r.card.auto ? (
                  "Claude went on by itself"
                ) : (
                  <>
                    <span className="desk-you">You:</span> {r.card.asked}
                  </>
                )}
              </div>
              {r.card.said && <p className="desk-said">{r.card.said}</p>}
            </article>
          ),
        )}
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
      <DeskBox targets={props.targets} canSend={props.canSend} onSend={props.onSend} />
    </section>
  );
}
