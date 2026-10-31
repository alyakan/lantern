import { Fragment, useState } from "react";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { statusFor, type ProjectStatus } from "../lib/deskStatus";
import { elapsed } from "../lib/time";
import type { RepoStatus } from "../types";

export interface DeskProjectsProps {
  rows: ProjectRow[];
  /** Every chat on the Desk: a project's row opens to list its own. */
  chats: InboxRow[];
  /** How the projects' repositories stand; null until the Mac has said. */
  repos: RepoStatus[] | null;
  now: number;
  onOpen: (slot: string) => void;
}

const last = (now: number, at: number | null) => (at === null ? "—" : now - at < 60_000 ? "just now" : `${elapsed(now - at)} ago`);
/** A release's age, roughly: "3h ago", "2d ago". */
const age = (now: number, at: number) => {
  const h = Math.floor((now - at) / 3_600_000);
  return h < 1 ? "just now" : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
const STATE: Record<RowState, string | null> = { working: "working", waiting: "needs you", done: null, asleep: "asleep" };

/** What a project's chats are doing, in a few words: "2 working · 1 needs you", or "none open". */
function chatsLine(r: ProjectRow): string {
  if (!r.chats) return "none open";
  const done = r.chats - r.working - r.waiting - r.asleep;
  const parts = [r.working && `${r.working} working`, r.waiting && `${r.waiting} needs you`, done && `${done} idle`, r.asleep && `${r.asleep} asleep`].filter(Boolean);
  return parts.join(" · ");
}

/** Why GitHub has nothing to say of a project, when it couldn't be asked. */
const NO_GH: Partial<Record<ProjectStatus["gh"], string>> = { missing: "gh isn't installed", logged_out: "gh isn't logged in", failed: "GitHub didn't answer" };

/** A project's branch, and how many files are changed on it, under its name. */
function Branch({ s }: { s: ProjectStatus | null | undefined }) {
  if (!s?.branch) return null;
  return (
    <span className="desk-branch-line">
      <span className="desk-branch" title={s.branch}>
        {s.branch}
      </span>
      {!!s.changed && <span className="desk-changed"> · {s.changed} changed</span>}
    </span>
  );
}

/** Its repository's open pull requests, and how many have checks failing or still running. */
function PrCell({ s }: { s: ProjectStatus | null | undefined }) {
  if (s === undefined) return <td className="muted">…</td>;
  if (s === null) return <td className="muted">—</td>;
  const why = NO_GH[s.gh];
  if (why) return <td className="muted" title={s.error ?? why}>{why}</td>;
  if (!s.open) return <td className="muted">—</td>;
  return (
    <td title={s.running > 0 ? `${s.running} with checks still running` : undefined}>
      {s.open} open
      {s.failing > 0 && <span className="desk-bad"> · {s.failing} failing</span>}
    </td>
  );
}

/** Its latest release, and drafts waiting to be published. */
function ReleaseCell({ s, now }: { s: ProjectStatus | null | undefined; now: number }) {
  if (s === undefined) return <td className="muted">…</td>;
  if (s === null) return <td className="muted">—</td>;
  if (!s.release && !s.drafts) return <td className="muted">—</td>;
  return (
    <td title={s.release?.at != null ? `Published ${age(now, s.release.at)}` : undefined}>
      {s.release?.tag}
      {s.drafts > 0 && <span className="desk-attn">{s.release ? " · " : ""}{s.drafts} draft{s.drafts > 1 ? "s" : ""}</span>}
    </td>
  );
}

/**
 * Every project on the Desk, a row each, with only what Lantern knows for sure: its chats and what they are doing (what waits on
 * you among them), its branch, pull requests and release (from git and gh), its to-dos, and when something last happened. A project
 * opens to list its chats, each with its last message.
 */
export function DeskProjects({ rows, chats, repos, now, onOpen }: DeskProjectsProps) {
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
            <th scope="col">Pull requests</th>
            <th scope="col">Release</th>
            <th scope="col">To-dos</th>
            <th scope="col">Last active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = !!opened[r.folder] && r.chats > 0;
            const mine = open ? chats.filter((c) => c.folder === r.folder) : [];
            const s = statusFor(r.folder, repos);
            return (
              <Fragment key={r.folder}>
                <tr className={open ? "on" : undefined}>
                  <th scope="row">
                    <span className="desk-project-name">
                      <button className="desk-project" title={r.folder} aria-expanded={r.chats > 0 ? open : undefined} disabled={!r.chats} onClick={() => setOpened({ ...opened, [r.folder]: !open })}>
                        {r.chats > 0 && <span className={`desk-chev${open ? " open" : ""}`} aria-hidden>›</span>}
                        {r.label}
                      </button>
                      {r.unread > 0 && <span className="desk-unread-count">{r.unread} unread</span>}
                    </span>
                    <Branch s={s} />
                  </th>
                  <td>{chatsLine(r)}</td>
                  <PrCell s={s} />
                  <ReleaseCell s={s} now={now} />
                  <td className={r.todos?.overdue ? "desk-bad" : r.todos?.open ? undefined : "muted"}>{r.todos ? (r.todos.open ? `${r.todos.open}${r.todos.overdue ? ` · ${r.todos.overdue} overdue` : ""}` : "—") : "…"}</td>
                  <td className="muted">{last(now, r.at)}</td>
                </tr>
                {mine.map((c) => (
                  <tr key={c.slot} className="desk-chat-row">
                    <td colSpan={6}>
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
