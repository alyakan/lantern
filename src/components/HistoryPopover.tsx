import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { OldLocation, SessionSummary } from "../types";
import { pinnedFirst, type SessionActions } from "../lib/sessionActions";
import { PlusIcon } from "./icons";
import { SessionList } from "./SessionList";

/** A project History lists the past chats of: its folder and the name the sidebar gives it. */
export interface HistoryProject {
  folder: string;
  label: string;
}

interface Props {
  /** Every project, in the sidebar's order. */
  projects: HistoryProject[];
  /** The project it starts filtered to; none (the default) lists them all. */
  initial?: string | null;
  /** The session ids of the chats that are open: the sidebar has them, so History lists past chats only. */
  exclude: string[];
  /** A project's past chats: read for every project when History opens. */
  load: (folder: string) => Promise<SessionSummary[]>;
  /** The places a project's chats came from that aren't brought over, read when it is the one filtered to. */
  loadOld: (folder: string) => Promise<OldLocation[]>;
  /** What can be done to a past chat of a project (pin, rename, export). */
  actionsFor: (folder: string) => SessionActions | null;
  onBring: (folder: string) => void;
  /** Starts a chat in a project: how one with nothing open is started from here. */
  onNewChat: (folder: string) => void;
  onOpen: (id: string, folder: string) => void;
  onClose: () => void;
}

/** What the arrow keys move between: the search box, then each chat. */
const STOPS = "input.menu-search, .session-row > .menu-row";

/**
 * History, under the title bar: the past chats of every project (the open ones are in the sidebar), grouped by project in the
 * sidebar's order, a project's pinned chats first and then the newest. Search narrows them, and the project chip filters to
 * one. A click opens the chat in its own project. It reads the projects when it opens, and closes on Escape or a press outside.
 */
export function HistoryPopover({ projects, initial = null, exclude, load, loadOld, actionsFor, onBring, onNewChat, onOpen, onClose }: Props) {
  const [byFolder, setByFolder] = useState<Record<string, SessionSummary[]>>({});
  const [filter, setFilter] = useState<string | null>(initial);
  const [old, setOld] = useState<OldLocation[]>([]);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const folders = projects.map((p) => p.folder).join("\n");

  useEffect(() => {
    let live = true;
    for (const { folder } of projects) {
      load(folder).then(
        (list) => live && setByFolder((all) => ({ ...all, [folder]: list })),
        () => live && setByFolder((all) => ({ ...all, [folder]: [] })),
      );
    }
    return () => {
      live = false;
    };
  }, [folders]);

  useEffect(() => {
    setOld([]);
    if (!filter) return;
    let live = true;
    loadOld(filter).then((found) => live && setOld(found), () => {});
    return () => {
      live = false;
    };
  }, [filter]);

  useEffect(() => {
    // The button that opens History toggles it, so a press on it isn't "outside".
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-history-toggle]") && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // ↑ and ↓ move between the search box and the chats (a project chip's own arrows choose a project).
  const arrows = (e: ReactKeyboardEvent<HTMLElement>) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || (e.target as HTMLElement).tagName === "SELECT") return;
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>(STOPS)];
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const down = e.key === "ArrowDown";
    e.preventDefault();
    stops[at < 0 ? (down ? 0 : stops.length - 1) : Math.max(0, Math.min(stops.length - 1, at + (down ? 1 : -1)))].focus();
  };

  const q = query.trim().toLowerCase();
  const shown = projects.filter((p) => !filter || p.folder === filter);
  const groups = shown.map((p) => {
    const sessions = byFolder[p.folder];
    const listed = sessions?.filter((s) => !exclude.includes(s.id) && (!q || s.title.toLowerCase().includes(q)));
    return { project: p, loaded: !!sessions, sessions: listed && pinnedFirst(listed, actionsFor(p.folder)?.pinned ?? []) };
  });
  const loading = groups.some((g) => !g.loaded);
  // A project with no past chats still has its header (and its +), unless a search is narrowing the list.
  const visible = groups.filter((g) => !g.loaded || (g.sessions?.length ?? 0) > 0 || !q);
  const nothing = !loading && !groups.some((g) => (g.sessions?.length ?? 0) > 0);
  const toBring = old.filter((p) => !p.already).reduce((n, p) => n + p.sessions, 0);

  return (
    <div className="history-popover" ref={root}>
      <div className="menu history-menu" role="dialog" aria-label="Chat history" onKeyDown={arrows}>
        <div className="history-top">
          <input className="menu-search" autoCapitalize="off" autoCorrect="off" autoFocus placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="history-filter" aria-label="Project" value={filter ?? ""} onChange={(e) => setFilter(e.target.value || null)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.folder} value={p.folder}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {filter && toBring > 0 && (
          <button className="menu-row bring-old" onClick={() => onBring(filter)}>
            <span className="menu-row-title">{`${toBring} ${toBring === 1 ? "chat" : "chats"} from before you moved this project: Bring them here`}</span>
          </button>
        )}
        {visible.map(({ project, sessions }) => (
          <section key={project.folder} aria-label={project.label}>
            <div className="history-group-head">
              <div className="menu-heading">{project.label}</div>
              <button className="icon history-new" aria-label={`New chat in ${project.label}`} title="New chat here" onClick={() => onNewChat(project.folder)}>
                <PlusIcon />
              </button>
            </div>
            {sessions && sessions.length > 0 && <SessionList label={`Past chats in ${project.label}`} sessions={sessions} actions={actionsFor(project.folder)} onOpen={(id) => onOpen(id, project.folder)} />}
          </section>
        ))}
        {loading && <div className="menu-empty">Loading…</div>}
        {nothing && <div className="menu-empty">{q ? "No matching chats" : "No past chats"}</div>}
      </div>
    </div>
  );
}
