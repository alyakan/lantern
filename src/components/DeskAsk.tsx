import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { answerShape, type AnswerPart, type DeskEntry, type DeskReply } from "../lib/desk";
import { elapsed } from "../lib/time";
import type { ChatHit } from "../types";
import { Md } from "./Md";

/** A chat a message can be sent to from the box, as its "to" menu lists it. */
export interface DeskTarget {
  slot: string;
  title: string;
  where: string;
}

export interface DeskAskProps {
  /** The messages typed on this Desk, with where each went. */
  entries: DeskEntry[];
  /** The chats on this Desk, for the box's "to" menu and "Send it there too". */
  targets: DeskTarget[];
  /** The Desk has more than one project: the box asks across them. */
  across: boolean;
  /** A project's page is open: the box asks about that project only (its name). */
  about?: string;
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
}

/** How often the times are redrawn. */
const TICK_MS = 30_000;
/** Within this of the end, the feed follows what comes in. */
const FOLLOW_PX = 80;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (now: number, at: number) => (now - at < 60_000 ? "just now" : now - at < 60 * 60_000 ? `${elapsed(now - at)} ago` : clock(at));

/** The past chats with the words a "which chat…?" message was about (found once, with the message): each opens where it is. */
function SearchHits({ terms, hits, onOpenPast }: { terms: string; hits: ChatHit[] | null | "failed"; onOpenPast: DeskAskProps["onOpenPast"] }) {
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
function Answer({ outcome, onOpenPast }: { outcome: Extract<DeskEntry["outcome"], { kind: "answer" }>; onOpenPast: DeskAskProps["onOpenPast"] }) {
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
function SendToo({ entry, targets, onSendTo }: { entry: DeskEntry; targets: DeskTarget[]; onSendTo: DeskAskProps["onSendTo"] }) {
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

/** What came back from the chat a Desk message went to: a short summary, the whole reply on asking, and the way to the chat. */
function Reply({ reply, slot, open, onOpen }: { reply: DeskReply; slot: string; open: boolean; onOpen: (slot: string) => void }) {
  const [full, setFull] = useState(false);
  if (reply.status === "waiting") return open ? <div className="desk-reply waiting muted">Working on it…</div> : null;
  if (reply.status === "lost") return <div className="desk-reply waiting muted">Lantern restarted before it came back: open the chat to see it.</div>;
  const failed = reply.outcome === "failed";
  const stopped = reply.outcome === "stopped";
  return (
    <div className={`desk-reply${failed ? " failed" : ""}`} aria-label="What came back">
      {reply.status === "summarizing" && <p className="muted">Finished. Summing it up…</p>}
      {reply.status === "done" && (
        <p>
          {failed && <span className="desk-bad">Failed: </span>}
          {stopped && <span className="muted">Stopped: </span>}
          {reply.summary}
        </p>
      )}
      {reply.status === "failed" && <p className="muted">Finished. {reply.why}</p>}
      {reply.status === "off" && <p className="muted">Finished. It runs on another provider, so the Desk doesn't read it: open the chat to see what it said.</p>}
      {full && reply.status !== "off" && (
        <div className="desk-full">
          <Md>{reply.full}</Md>
        </div>
      )}
      <div className="desk-reply-actions">
        {reply.status !== "off" && reply.full.trim() !== "" && <button onClick={() => setFull(!full)}>{full ? "Hide full answer" : "Show full answer"}</button>}
        <button onClick={() => onOpen(slot)}>Open chat</button>
      </div>
    </div>
  );
}

/** A message typed on the Desk: your words, what the Desk said back, where they went (or its question, or what it found), and what came back. */
function Entry({ entry, now, ...p }: { entry: DeskEntry; now: number } & Pick<DeskAskProps, "targets" | "onSendTo" | "onStartIn" | "onOpenPast" | "onOpen">) {
  const o = entry.outcome;
  return (
    <article className="desk-entry" aria-label={`You on the Desk: ${entry.text}`}>
      <div className="desk-me">{entry.text}</div>
      {entry.say && <div className="desk-says">{entry.say}</div>}
      <div className="desk-route">
        {o.kind === "routing" && <span className="muted">Thinking…</span>}
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
          {/* What the Desk said already asks, when it said something. */}
          {!entry.say && <div>{o.unsure ? "I couldn't work out where this goes. Where should it go?" : "Which chat is this for?"}</div>}
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
      {o.kind === "sent" && entry.reply && <Reply reply={entry.reply} slot={o.slot} open={p.targets.some((t) => t.slot === o.slot)} onOpen={p.onOpen} />}
      {o.kind === "answer" && <Answer outcome={o} onOpenPast={p.onOpenPast} />}
    </article>
  );
}

/** The Desk's box: what you type goes to the chat the Desk picks, or the one picked in its menu. */
function DeskBox({ targets, canSend, onSend }: Pick<DeskAskProps, "targets" | "canSend" | "onSend">) {
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

/**
 * The Desk's Ask pane, in the window's right pane: what you said on the Desk and where it went, with the Desk's own answers and
 * what came back, and under it the box. Ask how things stand, or say what to do: it goes to the right chat, or starts one.
 */
export function DeskAsk(props: DeskAskProps) {
  const { entries, onOpen } = props;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // It opens at the end, and stays there as messages come, unless it was scrolled up to read.
  const feed = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const last = entries[entries.length - 1];
  const shape = `${entries.length}:${last?.outcome.kind ?? ""}:${last?.outcome.kind === "answer" ? (last.outcome.text?.length ?? 0) : 0}:${last?.say ? 1 : 0}:${last?.reply?.status ?? ""}`;
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shape]);
  const said = [...entries].sort((a, b) => a.at - b.at);
  return (
    <section className="desk-side" aria-label="Ask">
      <h2 className="desk-h">{props.about ? `Ask about ${props.about}` : props.across ? "Ask across projects" : "Ask"}</h2>
      <div
        ref={feed}
        className="desk-feed"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
        }}
      >
        {said.length === 0 ? (
          <div className="desk-empty muted">Nothing asked here yet. Ask how something stands, or say what to do: it goes to the right chat, or starts one.</div>
        ) : (
          <section className="desk-talk" aria-label="You and the Desk">
            {said.map((entry) => (
              <Entry key={entry.id} entry={entry} now={now} targets={props.targets} onSendTo={props.onSendTo} onStartIn={props.onStartIn} onOpenPast={props.onOpenPast} onOpen={onOpen} />
            ))}
          </section>
        )}
      </div>
      <DeskBox targets={props.targets} canSend={props.canSend} onSend={props.onSend} />
    </section>
  );
}
