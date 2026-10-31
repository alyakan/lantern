import { useEffect, useState } from "react";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import { deskOf, HOME_ID, moveProject, removeDesk, renameDesk, type Desks } from "../lib/desks";
import type { InboxItem } from "../lib/inbox";
import { elapsed } from "../lib/time";
import type { RepoStatus } from "../types";
import { DeskProject } from "./DeskProject";
import { DeskProjects } from "./DeskProjects";
import { ReposToday } from "./ReposToday";
import { AllowButton } from "./Inbox";

export interface DeskViewProps {
  /** Every chat on this Desk, for the projects' rows to list. */
  chats: InboxRow[];
  /** Every project on this Desk, as the table lists it. */
  projects: ProjectRow[];
  /** What waits on you on this Desk (the title bar's inbox), one thing at a time. */
  needs: InboxItem[];
  /** How this Desk's repositories stand (git and GitHub); null until the Mac has said. */
  repos: RepoStatus[] | null;
  desks: {
    value: Desks;
    /** How many things wait on you on each Desk. */
    waiting: Record<string, number>;
    /** Every project known (open, or on a Desk), with its name: what the Desks editor lists. */
    projects: { folder: string; label: string }[];
    onChange: (desks: Desks) => void;
    onAdd: (name: string) => void;
  };
  onOpen: (slot: string) => void;
  /** The project whose own page is open (a folder), or null for all of them; and the way to open or leave one. */
  page: string | null;
  onPage: (folder: string | null) => void;
  /** Starts a chat in a project (from its page). */
  onNewChat: (folder: string) => void;
  onGo: (item: InboxItem) => void;
  onDecide: (item: InboxItem, allow: boolean) => void;
}

/** How often the times are redrawn. */
const TICK_MS = 30_000;

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

/**
 * The Desk, as a dashboard: what waits on you, one thing at a time, and a table of the Desk's projects with only what Lantern
 * knows for sure (a row opens to list its chats), then what happened in its repositories today. What happened in the chats, as
 * it happened, is the sidebar's Timeline; asking and telling is the right pane's Ask.
 */
export function DeskView(props: DeskViewProps) {
  const { needs, onOpen, onGo, onDecide } = props;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const waiting = needs.filter((n) => n.needsYou);
  // A project's page, while that project is still on the Desk.
  const pageRow = props.page === null ? undefined : props.projects.find((p) => p.folder === props.page);
  return (
    <section className="chat-pane desk" aria-label="Desk">
      <header className="desk-head">
        <DeskTabs desks={props.desks} />
      </header>
      <div className="desk-main">
        {waiting.length > 0 ? <NeedsYou waiting={waiting} now={now} onGo={onGo} onDecide={onDecide} /> : <div className="desk-clear">✓ Nothing needs you</div>}
        {pageRow ? (
          <DeskProject
            row={pageRow}
            chats={props.chats.filter((c) => c.folder === pageRow.folder)}
            repo={props.repos && (props.repos.find((r) => r.folders.some((f) => f.folder === pageRow.folder)) ?? null)}
            now={now}
            onBack={() => props.onPage(null)}
            onOpen={onOpen}
            onNewChat={props.onNewChat}
          />
        ) : (
          <>
            <DeskProjects rows={props.projects} chats={props.chats} repos={props.repos} now={now} onOpen={onOpen} onPage={props.onPage} />
            <ReposToday repos={props.repos} now={now} />
          </>
        )}
      </div>
    </section>
  );
}
