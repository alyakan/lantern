import type { ProjectRow } from "../lib/deskBoard";
import { elapsed } from "../lib/time";

export interface DeskProjectsProps {
  rows: ProjectRow[];
  now: number;
  /** The project picked: the inbox lists only its chats. */
  picked: string | null;
  onPick: (folder: string | null) => void;
}

const last = (now: number, at: number | null) => (at === null ? "—" : now - at < 60_000 ? "just now" : `${elapsed(now - at)} ago`);

/** What a project's chats are doing, in a few words: "2 working · 1 needs you", or "none open". */
function chatsLine(r: ProjectRow): string {
  if (!r.chats) return "none open";
  const done = r.chats - r.working - r.waiting - r.asleep;
  const parts = [r.working && `${r.working} working`, r.waiting && `${r.waiting} needs you`, done && `${done} idle`, r.asleep && `${r.asleep} asleep`].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Every project on the Desk, a row each, with only what Lantern knows for sure: its chats and what they are doing, what waits on
 * you there, its to-dos, and when something last happened. A row picks the project: the inbox then lists only its chats.
 */
export function DeskProjects({ rows, now, picked, onPick }: DeskProjectsProps) {
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
          {rows.map((r) => (
            <tr key={r.folder} className={r.folder === picked ? "on" : undefined}>
              <th scope="row">
                <button className="desk-project" title={r.folder} aria-pressed={r.folder === picked} onClick={() => onPick(r.folder === picked ? null : r.folder)}>
                  {r.label}
                </button>
                {r.unread > 0 && <span className="desk-unread-count">{r.unread} unread</span>}
              </th>
              <td>{chatsLine(r)}</td>
              <td className={r.needs ? "desk-attn" : "muted"}>{r.needs || "—"}</td>
              <td className={r.todos?.overdue ? "desk-bad" : r.todos?.open ? undefined : "muted"}>{r.todos ? (r.todos.open ? `${r.todos.open}${r.todos.overdue ? ` · ${r.todos.overdue} overdue` : ""}` : "—") : "…"}</td>
              <td className="muted">{last(now, r.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
