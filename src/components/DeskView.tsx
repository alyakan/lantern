import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { answerShape, type AnswerPart, type DeskCard, type DeskEntry, type DeskLive } from "../lib/desk";
import { deskOf, HOME_ID, moveProject, removeDesk, renameDesk, type Desks } from "../lib/desks";
import type { InboxItem } from "../lib/inbox";
import { elapsed } from "../lib/time";
import type { ChatHit } from "../types";
import { AllowButton } from "./Inbox";
import { Md } from "./Md";

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

/** The Desk's own answer to a question about how things stand, and the chats it was made from, numbered as it cites them. */
function Answer({ outcome, onOpenPast }: { outcome: Extract<DeskEntry["outcome"], { kind: "answer" }>; onOpenPast: DeskViewProps["onOpenPast"] }) {
  const { terms, hits, text, error } = outcome;
  if (hits === null) return <div className="desk-note muted">Looking through your chats about “{terms}”…</div>;
  if (hits === "failed") return <div className="desk-note">Couldn't look through your chats just now.</div>;
  if (hits.length === 0) return <div className="desk-note">No chat on this Desk talks about “{terms}”.</div>;
  const shape = text ? answerShape(text) : null;
  const projects = [...new Set(hits.map((h) => h.project))];
  return (
    <div className="desk-note desk-answer">
      {shape ? (
        <>
          <p className="desk-lead">
            <Cited text={shape.lead} />
          </p>
          <p className="desk-from">
            From {hits.length === 1 ? "1 chat" : `${hits.length} chats`}
            {projects.length === 1 ? ` in ${projects[0]}` : ""}
          </p>
          {shape.parts.length > 0 && (
            <dl className="desk-parts">
              {shape.parts.map(({ part, points }) => (
                <div key={part} className={`desk-part ${part}`}>
                  <dt>{PART_NAME[part]}</dt>
                  <dd>
                    <ul>
                      {points.map((pt, i) => (
                        <li key={i}>
                          <Cited text={pt} />
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : text ? (
        <Md>{text}</Md>
      ) : error ? (
        <div className="desk-failed">No answer: {error}</div>
      ) : (
        <div className="muted">Reading {hits.length === 1 ? "the chat" : `${hits.length} chats`} about “{terms}”…</div>
      )}
      <ol className="desk-sources" aria-label="The chats it read">
        {hits.map((h, i) => (
          <li key={h.id}>
            <button className="desk-source" onClick={() => onOpenPast(h)} title={`${h.project}, ${new Date(h.updated_ms).toLocaleDateString([], { month: "short", day: "numeric" })}`}>
              <span className="desk-source-n">{i + 1}</span>
              <span className="desk-source-title">{h.title.map((p) => p.text).join("") || "Untitled chat"}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

const PART_NAME: Record<AnswerPart, string> = { done: "Done", open: "Open", blocked: "Blocked" };

/** A line of the Desk's answer as text, with its [1], [2] as small numbers. */
function Cited({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[\d+\])/).map((piece, i) => (/^\[\d+\]$/.test(piece) ? <sup key={i}>{piece.slice(1, -1)}</sup> : piece))}
    </>
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
        {o.kind === "answer" && <span className="muted">The Desk answers</span>}
        {o.kind === "sent" && (
          <>
            <span>
              {o.started ? "Started " : o.queued ? "Queued in " : "Sent to "}
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
      {o.kind === "answer" && <Answer outcome={o} onOpenPast={p.onOpenPast} />}
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
      <textarea aria-label="Tell Lantern" placeholder={canSend ? "Tell Lantern what to do" : "Waiting for Claude Code…"} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys} />
      <select className="desk-to" aria-label="Send to" value={target} onChange={(e) => setTo(e.target.value)} title="Where what you type goes: the Desk picks the right chat, or starts one">
        <option value="">Desk picks</option>
        {targets.map((t) => (
          <option key={t.slot} value={t.slot}>
            {t.title} ({t.where})
          </option>
        ))}
      </select>
      <button className="primary" aria-label="Send" disabled={!text.trim() || !canSend} onClick={send}>
        Send
      </button>
    </div>
  );
}

/** How many finished answers show before "Show more". */
const FINISHED_SHOWN = 3;
const MARK: Record<DeskCard["outcome"], string> = { done: "✓", failed: "✕", stopped: "■" };

/** The first sentence of what Claude said, for a finished answer's one line. */
const firstSentence = (said: string) => {
  // A list's items come joined by bullets: the first item is enough.
  const first = said.replace(/^\s*•\s*/, "").split(" • ")[0];
  const end = first.search(/[.!?](\s|$)/);
  return end > 0 && end < first.length - 1 ? first.slice(0, end + 1) : first;
};

/** What waits on you, one thing at a time: the first, big, with what it asks; the rest a click away. */
function NeedsYou({ waiting, now, onGo, onDecide }: { waiting: InboxItem[]; now: number } & Pick<DeskViewProps, "onGo" | "onDecide">) {
  const [at, setAt] = useState(0);
  const i = at < waiting.length ? at : 0;
  const it = waiting[i];
  if (!it) return null;
  const more = waiting.length - 1;
  return (
    <section className="desk-needs" aria-label="Needs you">
      <h2 className="desk-h">Needs you</h2>
      <div className={`desk-focus${more > 0 ? " stacked" : ""}`}>
        <article className="desk-need" aria-label={`${it.title} needs you: ${it.need}`}>
          <div className="desk-who">
            <span className="node-dot waiting" aria-hidden />
            <button className="desk-chat" onClick={() => onGo(it)} title="Go there">
              {it.title}
            </button>
            <span className="desk-where">
              in {it.where}
              {it.since !== null && `, ${elapsed(now - it.since)}`}
            </span>
          </div>
          <p className="desk-ask">{it.need}</p>
          {it.detail !== null && <pre className="desk-detail">{it.detail}</pre>}
          <div className="desk-actions">
            {it.requestId && it.canAllow && <AllowButton key={it.key + (it.requestId ?? "")} title={it.title} onAllow={() => onDecide(it, true)} />}
            {it.requestId && (
              <button aria-label={`Deny ${it.title}`} onClick={() => onDecide(it, false)}>
                Deny
              </button>
            )}
            <button className={it.requestId ? undefined : "primary"} aria-label={`Go to ${it.title}`} onClick={() => onGo(it)}>
              Open chat
            </button>
            {more > 0 && (
              <button className="desk-next" onClick={() => setAt((i + 1) % waiting.length)}>
                {more} more waiting
              </button>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}

/** The answers that finished, one quiet line each, newest first: a few, and the rest when asked. */
function JustFinished({ cards, now, onOpen }: { cards: DeskCard[]; now: number; onOpen: (slot: string) => void }) {
  const [all, setAll] = useState(false);
  if (!cards.length) return null;
  const newest = [...cards].sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
  const shown = all ? newest : newest.slice(0, FINISHED_SHOWN);
  return (
    <section className="desk-finished" aria-label="Just finished">
      <h2 className="desk-h">Just finished</h2>
      {shown.map((c) => {
        // A failed or stopped answer says why when Claude did, else just that it failed or stopped.
        const line = c.said ? firstSentence(c.said) : OUTCOME[c.outcome];
        return (
          <button key={c.key} className={`desk-line ${c.outcome}`} aria-label={`${c.title}: ${c.said || c.asked}`} title={c.said || c.asked} onClick={() => onOpen(c.slot)}>
            <span className="desk-mark" aria-hidden>
              {MARK[c.outcome]}
            </span>
            <span className="desk-line-text">
              <b>{c.title}</b>
              {line ? <span className={c.outcome === "done" ? undefined : "desk-bad"}>: {line}</span> : null}
            </span>
            {c.at !== null && <time className="desk-time">{ago(now, c.at)}</time>}
          </button>
        );
      })}
      {newest.length > FINISHED_SHOWN && (
        <button className="desk-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${newest.length - FINISHED_SHOWN} more`}
        </button>
      )}
    </section>
  );
}

/**
 * The Desk, calm: what waits on you at the top, one thing at a time and always in view; below it, the answers that just
 * finished as one quiet line each, then what you said on the Desk and where it went, with the Desk's own answers. At the
 * bottom, the box: what you type goes to the right chat. The chats themselves are in the sidebar, as always.
 */
export function DeskView(props: DeskViewProps) {
  const { cards, needs, entries, onOpen, onGo, onDecide } = props;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // It opens at the end, and stays there as messages come, unless it was scrolled up to read.
  const feed = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const waiting = needs.filter((n) => n.needsYou);
  const last = entries[entries.length - 1];
  const shape = `${entries.length}:${last?.outcome.kind ?? ""}:${last?.outcome.kind === "answer" ? (last.outcome.text?.length ?? 0) : 0}`;
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shape]);
  const said = [...entries].sort((a, b) => a.at - b.at);
  const empty = !cards.length && !entries.length && !waiting.length;

  return (
    <section className="chat-pane desk" aria-label="Desk">
      <header className="desk-head">
        <div className="desk-col">
          <DeskTabs desks={props.desks} />
          {waiting.length > 0 ? <NeedsYou waiting={waiting} now={now} onGo={onGo} onDecide={onDecide} /> : !empty && <div className="desk-clear">✓ Nothing needs you</div>}
        </div>
      </header>
      <div
        ref={feed}
        className="desk-feed"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
        }}
      >
        <div className="desk-col">
          {empty && <div className="desk-empty muted">Nothing here yet. Tell Lantern what to do below: it goes to the right chat, or starts one.</div>}
          <JustFinished cards={cards} now={now} onOpen={onOpen} />
          {said.length > 0 && (
            <section className="desk-talk" aria-label="You and the Desk">
              <h2 className="desk-h">You and the Desk</h2>
              {said.map((entry) => (
                <Entry key={entry.id} entry={entry} now={now} targets={props.targets} onSendTo={props.onSendTo} onStartIn={props.onStartIn} onOpenPast={props.onOpenPast} onOpen={onOpen} />
              ))}
            </section>
          )}
        </div>
      </div>
      <DeskBox targets={props.targets} canSend={props.canSend} onSend={props.onSend} />
    </section>
  );
}
