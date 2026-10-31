import { Fragment, useState } from "react";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { elapsed } from "../lib/time";

export interface DeskProjectsProps {
  rows: ProjectRow[];
  /** Every chat on the Desk: a project's row opens to list its own. */
  chats: InboxRow[];
  now: number;
  onOpen: (slot: string) => void;
}

const last = (now: number, at: number | null) => (at === null ? "—" : now - at < 60_000 ? "just now" : `${elapsed(now - at)} ago`);
const STATE: Record<RowState, string | null> = { working: "working", waiting: "needs you", done: null, asleep: "asleep" };

/** What a project's chats are doing, in a few words: "2 working · 1 needs you", or "none open". */
function chatsLine(r: ProjectRow): string {
  if (!r.chats) return "none open";
  const done = r.chats - r.working - r.waiting - r.asleep;
  const parts = [r.working && `${r.working} working`, r.waiting && `${r.waiting} needs you`, done && `${done} idle`, r.asleep && `${r.asleep} asleep`].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Every project on the Desk, a row each, with only what Lantern knows for sure: its chats and what they are doing, what waits on
 * you there, its to-dos, and when something last happened. A project opens to list its chats, each with its last message.
 */
export function DeskProjects({ rows, chats, now, onOpen }: DeskProjectsProps) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (!rows.length) return null;
  return (
    <section className="desk-projects" aria-label="Projects">
      <h2 className="desk-h">Projects</h2>
      <table className="desk-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Chats</th>
            <th scope="col">Needs you</th>
            <th scope="col">To-dos</th>
            <th scope="col">Last active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = !!opened[r.folder] && r.chats > 0;
            const mine = open ? chats.filter((c) => c.folder === r.folder) : [];
            return (
              <Fragment key={r.folder}>
                <tr className={open ? "on" : undefined}>
                  <th scope="row">
                    <button className="desk-project" title={r.folder} aria-expanded={r.chats > 0 ? open : undefined} disabled={!r.chats} onClick={() => setOpened({ ...opened, [r.folder]: !open })}>
                      {r.chats > 0 && <span className={`desk-chev${open ? " open" : ""}`} aria-hidden>›</span>}
                      {r.label}
                    </button>
                    {r.unread > 0 && <span className="desk-unread-count">{r.unread} unread</span>}
                  </th>
                  <td>{chatsLine(r)}</td>
                  <td className={r.needs ? "desk-attn" : "muted"}>{r.needs || "—"}</td>
                  <td className={r.todos?.overdue ? "desk-bad" : r.todos?.open ? undefined : "muted"}>{r.todos ? (r.todos.open ? `${r.todos.open}${r.todos.overdue ? ` · ${r.todos.overdue} overdue` : ""}` : "—") : "…"}</td>
                  <td className="muted">{last(now, r.at)}</td>
                </tr>
                {mine.map((c) => (
                  <tr key={c.slot} className="desk-chat-row">
                    <td colSpan={5}>
                      <button className={`desk-msg${c.unread ? " unread" : ""}`} aria-label={`${c.title}${c.unread ? ", unread" : ""}`} onClick={() => onOpen(c.slot)}>
                        <span className="desk-msg-top">
                          {c.unread && <span className="desk-unread-dot" aria-hidden />}
                          <span className="desk-msg-title">{c.title}</span>
                          <span className="desk-msg-meta">{c.workflow}</span>
                          {STATE[c.state] && <span className={`desk-state ${c.state}`}>{STATE[c.state]}</span>}
                          <time className="desk-time">{last(now, c.at)}</time>
                        </span>
                        {c.line && <span className="desk-msg-line">{c.line}</span>}
                      </button>
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
