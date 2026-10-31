import { useState } from "react";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { statusFor, type ProjectStatus } from "../lib/deskStatus";
import { elapsed } from "../lib/time";
import type { RepoStatus } from "../types";
import { Card, Row } from "./DeskCard";

export interface DeskProjectsProps {
  rows: ProjectRow[];
  /** Every chat on the Desk: a project's row opens to list its own. */
  chats: InboxRow[];
  /** How the projects' repositories stand; null until the Mac has said. */
  repos: RepoStatus[] | null;
  now: number;
  onOpen: (slot: string) => void;
  /** Opens a project's own page. */
  onPage: (folder: string) => void;
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
function Prs({ s }: { s: ProjectStatus | null | undefined }) {
  if (s === undefined) return <dd className="muted">…</dd>;
  if (s === null) return <dd className="muted">—</dd>;
  const why = NO_GH[s.gh];
  if (why) return <dd className="muted" title={s.error ?? why}>{why}</dd>;
  if (!s.open) return <dd className="muted">none open</dd>;
  return (
    <dd title={s.running > 0 ? `${s.running} with checks still running` : undefined}>
      {s.open} open
      {s.failing > 0 && <span className="desk-bad"> · {s.failing} failing</span>}
    </dd>
  );
}

/** Its latest release, and drafts waiting to be published. */
function Release({ s, now }: { s: ProjectStatus | null | undefined; now: number }) {
  if (s === undefined) return <dd className="muted">…</dd>;
  if (s === null || (!s.release && !s.drafts)) return <dd className="muted">—</dd>;
  return (
    <dd title={s.release?.at != null ? `Published ${age(now, s.release.at)}` : undefined}>
      {s.release?.tag}
      {s.drafts > 0 && <span className="desk-attn">{s.release ? " · " : ""}{s.drafts} draft{s.drafts > 1 ? "s" : ""}</span>}
    </dd>
  );
}

/**
 * Every project on the Desk, a tile each, with only what Lantern knows for sure: its chats and what they are doing (what waits on
 * you among them), its branch, pull requests and release (from git and gh), its to-dos, and when something last happened, one
 * under the other. A tile's Chats button lists its chats in it, each with its last message; its name opens its own page.
 */
export function DeskProjects({ rows, chats, repos, now, onOpen, onPage }: DeskProjectsProps) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (!rows.length) return null;
  return (
    <Card title="Projects" count={rows.length} heading="h2" className="desk-projects">
      <div className="desk-tiles">
        {rows.map((r) => {
          const open = !!opened[r.folder] && r.chats > 0;
          const mine = open ? chats.filter((c) => c.folder === r.folder) : [];
          const s = statusFor(r.folder, repos);
          return (
            <article key={r.folder} className={`desk-tile${open ? " on" : ""}`} aria-label={r.label}>
              <header className="desk-tile-head">
                <button className="desk-project" title={`Open ${r.folder}`} onClick={() => onPage(r.folder)}>
                  {r.label}
                </button>
                {r.unread > 0 && <span className="desk-unread-count">{r.unread} unread</span>}
                {r.at !== null && <time className="desk-time">{last(now, r.at)}</time>}
              </header>
              <Branch s={s} />
              <dl className="desk-facts">
                <dt>Chats</dt>
                <dd>{chatsLine(r)}</dd>
                <dt>Pull requests</dt>
                <Prs s={s} />
                <dt>Release</dt>
                <Release s={s} now={now} />
                <dt>To-dos</dt>
                <dd className={r.todos?.overdue ? "desk-bad" : r.todos?.open ? undefined : "muted"}>{r.todos ? (r.todos.open ? `${r.todos.open}${r.todos.overdue ? ` · ${r.todos.overdue} overdue` : ""}` : "—") : "…"}</dd>
              </dl>
              <button className="desk-more desk-tile-chats" aria-label={`${open ? "Hide" : "Show"} the chats of ${r.label}`} aria-expanded={open} disabled={!r.chats} onClick={() => setOpened({ ...opened, [r.folder]: !open })}>
                {open ? "Hide chats" : r.chats ? `Show chats (${r.chats})` : "No chats"}
              </button>
              {mine.length > 0 && (
                <ul className="dp-list desk-tile-list">
                  {mine.map((c) => (
                    <li key={c.slot}>
                      <button className={`dp-row dp-click${c.unread ? " unread" : ""}`} aria-label={`${c.title}${c.unread ? ", unread" : ""}`} onClick={() => onOpen(c.slot)}>
                        <Row
                          title={
                            <>
                              {c.unread && <span className="desk-unread-dot" aria-hidden />}
                              {c.title}
                            </>
                          }
                          aside={c.at !== null && <time className="desk-time">{last(now, c.at)}</time>}
                          meta={
                            <>
                              {STATE[c.state] ? <span className={`desk-state ${c.state}`}>{STATE[c.state]}</span> : c.workflow}
                              {c.line && ` · ${c.line}`}
                            </>
                          }
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </Card>
  );
}
