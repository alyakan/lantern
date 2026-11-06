import { useEffect, useRef, useState } from "react";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { statusFor, type ProjectStatus } from "../lib/deskStatus";
import { projectsOf, toneCounts, type WorkItem } from "../lib/yourWork";
import { elapsed } from "../lib/time";
import type { RepoStatus } from "../types";
import { useMenuInside } from "../lib/useMenuInside";
import { Row } from "./DeskCard";
import { WorkDots } from "./YourWork";
import { useMenuKeys } from "./useMenuKeys";

export interface DeskProjectsProps {
  rows: ProjectRow[];
  /** Every chat on the Desk: a project's row opens to list its own. */
  chats: InboxRow[];
  /** How the projects' repositories stand; null until the Mac has said. */
  repos: RepoStatus[] | null;
  /** Your work in them (see YourWork). */
  items: WorkItem[];
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

/** Your work in its repository (see YourWork): a coloured dot and a count for each state. */
function Work({ s, repo, items }: { s: ProjectStatus | null | undefined; repo: string | null; items: WorkItem[] }) {
  if (s === undefined) return <dd className="muted">…</dd>;
  if (s === null || repo === null) return <dd className="muted">—</dd>;
  const counts = toneCounts(items, repo);
  const why = NO_GH[s.gh];
  if (why && !Object.keys(counts).length) return <dd className="muted" title={s.error ?? why}>{why}</dd>;
  return (
    <dd>
      <WorkDots counts={counts} />
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

/** A project's chats, in a dropdown under its tile's button, each with its last message: the tiles around it don't move. */
function ChatsMenu({ label, chats, now, onOpen }: { label: string; chats: InboxRow[]; now: number; onOpen: (slot: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
  const inside = useMenuInside(open, [chats.length]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    // The whole tile opens its project's page: the chats' own presses stop here.
    <div className="desk-tile-chats" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className="desk-more" aria-haspopup="menu" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the chats of ${label}`} disabled={!chats.length} onClick={() => setOpen(!open)}>
        {chats.length ? (
          <>
            Chats ({chats.length}) <span className="chev down" aria-hidden />
          </>
        ) : (
          "No chats"
        )}
      </button>
      {open && (
        <div className="menu desk-chats-menu" ref={inside.ref} style={inside.style} role="menu" aria-label={`Chats of ${label}`} onKeyDown={keys.onKeyDown}>
          {chats.map((c) => (
            <button
              key={c.slot}
              role="menuitem"
              className={`menu-row desk-chat-item${c.unread ? " unread" : ""}`}
              aria-label={`${c.title}${c.unread ? ", unread" : ""}`}
              onClick={() => {
                setOpen(false);
                onOpen(c.slot);
              }}
            >
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
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Every project on the Desk, a tile each, with only what Lantern knows for sure: its chats and what they are doing (what waits on
 * you among them), its branch, your work in it and its release (from git and gh), its to-dos, and when something last happened, one
 * under the other. A tile opens its project's page wherever it is pressed (its name is the button that says so, and the way there
 * from the keyboard); its Chats button drops its chats down over the Desk, each with its last message.
 */
export function DeskProjects({ rows, chats, repos, items, now, onOpen, onPage }: DeskProjectsProps) {
  if (!rows.length) return null;
  return (
    <section className="desk-projects" aria-label="Projects">
        {rows.map((r) => {
          const s = statusFor(r.folder, repos);
          const repo = repos?.find((x) => x.folders.some((f) => f.folder === r.folder))?.repo ?? null;
          return (
            <article key={r.folder} className="desk-tile" aria-label={r.label} onClick={() => onPage(r.folder)}>
              <header className="desk-tile-head">
                <button
                  className="desk-project"
                  title={`Open ${r.folder}`}
                  onClick={(e) => {
                    // The tile opens the page too; one press is one opening.
                    e.stopPropagation();
                    onPage(r.folder);
                  }}
                >
                  {r.label}
                </button>
                {r.unread > 0 && <span className="desk-unread-count">{r.unread} unread</span>}
                {r.at !== null && <time className="desk-time">{last(now, r.at)}</time>}
              </header>
              <Branch s={s} />
              <dl className="desk-facts">
                <dt>Chats</dt>
                <dd>{chatsLine(r)}</dd>
                <dt>Your work</dt>
                <Work s={s} repo={repo} items={items} />
                {repo !== null && projectsOf(items, repo).length > 0 && (
                  <>
                    <dt>Linear</dt>
                    <dd className="yw-projects">
                      {projectsOf(items, repo).map((p) => (
                        <span key={p.project} className="yw-project">
                          {p.project}
                          <span className="muted">
                            {p.doing > 0 && ` · ${p.doing} doing`}
                            {p.todo > 0 && ` · ${p.todo} to start`}
                          </span>
                        </span>
                      ))}
                    </dd>
                  </>
                )}
                <dt>Release</dt>
                <Release s={s} now={now} />
                <dt>To-dos</dt>
                <dd className={r.todos?.overdue ? "desk-bad" : r.todos?.open ? undefined : "muted"}>{r.todos ? (r.todos.open ? `${r.todos.open}${r.todos.overdue ? ` · ${r.todos.overdue} overdue` : ""}` : "—") : "…"}</dd>
              </dl>
              <footer className="desk-tile-foot">
                {/* Its own button, so opening a chat from the tile doesn't also open its page. */}
                <ChatsMenu label={r.label} chats={r.chats ? chats.filter((c) => c.folder === r.folder) : []} now={now} onOpen={onOpen} />
              </footer>
            </article>
          );
        })}
    </section>
  );
}
