import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { MovedFolder, RecentFolder, SessionSummary } from "../types";
import { usePersistentState } from "../lib/layout";
import { ACTIONS, shortcutLabel } from "../lib/actions";
import { relativeTime } from "../lib/time";
import { sidebarProjects, type ProjectOpen, type SidebarChat, type SidebarItem, type SidebarProject } from "../lib/sidebar";
import { ChevronIcon, FolderOpenIcon, PinIcon, PlusIcon, SidebarIcon, TeamIcon } from "./icons";
import { MovedNotice } from "./MovedFolders";
import { moveFocus } from "./useMenuKeys";

/** The sidebar's width in pixels: what Show/Hide Sidebar and the drag edge keep between these. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 248;
const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));

const DOT_LABEL = { running: "Working", waiting: "Needs you", draft: "Draft", done: "Done" } as const;
const shortcut = (id: string) => {
  const def = ACTIONS.find((a) => a.id === id);
  return def ? shortcutLabel(def) : null;
};

export interface SidebarHandlers {
  /** An open chat, a team's canvas, and an agent of a team (focused on its canvas). */
  onChat: (slot: string) => void;
  onTeam: (slot: string) => void;
  onAgent: (slot: string, team: string) => void;
  /** Resumes a past chat of a project. */
  onPast: (folder: string, sessionId: string) => void;
  onCloseChat: (slot: string) => void;
  /** "Show all…": the project's History. */
  onHistory: (folder: string) => void;
  onNewChatIn: (folder: string) => void;
  onNewTeamIn: (folder: string) => void;
  onBringOld: (folder: string) => void;
  onReveal: (folder: string) => void;
  onRemove: (folder: string) => void;
  onOpenFolder: () => void;
  /** New ▾, for the project on screen. */
  onNewChat: () => void;
  onNewTeam: () => void;
  onReviewPr: () => void;
}

interface Props extends SidebarHandlers {
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  width: number;
  onWidth: (width: number) => void;
  /** What is open, by project (see openProjects), and the project on screen with its branch. */
  open: Record<string, ProjectOpen>;
  currentFolder: string | null;
  branch: string | null;
  /** New ▾ can start something (a project is open, and its chat isn't starting). */
  canNew: boolean;
  loadRecent: () => Promise<RecentFolder[]>;
  /** Reads a project's past chats: called only for the projects that are expanded. */
  loadSessions: (folder: string) => Promise<SessionSummary[]>;
  pinned: Record<string, string[]>;
  titles: Record<string, string>;
  /** Projects removed from the recents (they still show while a chat is open in them). */
  hidden: string[];
  /** Folders that seem to have moved, with what to do about them. */
  moved: MovedFolder[];
  onRelocate: (from: MovedFolder) => void;
  onDismissMoved: (old: string) => void;
}

/** Closes a popover on a press outside it or Escape. */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
}

/** A menu's arrow keys, over the menuitems inside it. */
const menuKeys = (e: ReactKeyboardEvent<HTMLElement>) => void moveFocus(e, [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]);

/** New ▾: a chat or a team in the project on screen, or a review of one of its pull requests. */
function NewMenu({ canNew, compact, onNewChat, onNewTeam, onReviewPr }: Pick<Props, "canNew" | "onNewChat" | "onNewTeam" | "onReviewPr"> & { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, () => setOpen(false));
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const item = (label: string, id: string | null, run: () => void) => (
    <button role="menuitem" className="menu-row" onClick={pick(run)}>
      <span className="menu-row-title">{label}</span>
      {id && shortcut(id) && <span className="menu-row-meta">{shortcut(id)}</span>}
    </button>
  );
  return (
    <div className="sb-new" ref={root}>
      <button className={`sb-new-button${compact ? " compact" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label="New" title="Start something new" disabled={!canNew} onClick={() => setOpen(!open)}>
        <PlusIcon />
        {!compact && (
          <>
            <span>New</span>
            <span className="chev down" aria-hidden />
          </>
        )}
      </button>
      {open && (
        <div className="menu sb-menu" role="menu" aria-label="New" onKeyDown={menuKeys}>
          {item("Chat", "new-session", onNewChat)}
          {item("Team", "work-team", onNewTeam)}
          {item("Review a PR…", null, onReviewPr)}
        </div>
      )}
    </div>
  );
}

/** A state dot, for a chat that is working, needs you, finished unread, or is just open. */
function Dot({ chat }: { chat: SidebarChat }) {
  // Needing you beats an unread finish.
  const unread = chat.unread && chat.state !== "waiting";
  const kind = unread ? "unread" : chat.state;
  const label = unread ? "Unread" : DOT_LABEL[chat.state];
  return <span className={`sb-dot ${kind}`} role="img" aria-label={label} />;
}

function ChatRow({ chat, onClick, onClose, team = false, label }: { chat: SidebarChat; onClick: () => void; onClose?: () => void; team?: boolean; label?: string }) {
  return (
    <li className={`sb-item${chat.closable && onClose ? " closable" : ""}`}>
      <button className={`sb-row${chat.active ? " current" : ""}${chat.unread ? " unread" : ""}`} aria-current={chat.active ? "true" : undefined} title={chat.title} onClick={onClick}>
        {team ? <span className={`sb-team ${chat.unread && chat.state !== "waiting" ? "unread" : chat.state}`} role="img" aria-label={`${DOT_LABEL[chat.state]} team`}><TeamIcon /></span> : <Dot chat={chat} />}
        <span className="sb-title">{label ?? chat.title}</span>
        {chat.pinned && <span className="sb-pin" role="img" aria-label="Pinned"><PinIcon /></span>}
        {chat.background > 0 && <span className="spinner" role="img" aria-label={`${chat.background} running in the background`} />}
      </button>
      {chat.closable && onClose && (
        <button className="icon sb-close" aria-label={`Close ${chat.title}`} title={chat.state === "draft" ? "Close (discards the unsent text)" : "Close"} onClick={onClose}>
          ×
        </button>
      )}
    </li>
  );
}

function Item({ item, h }: { item: SidebarItem; h: SidebarHandlers }) {
  if (item.kind === "chat") return <ChatRow chat={item} onClick={() => h.onChat(item.slot)} onClose={() => h.onCloseChat(item.slot)} />;
  return (
    <>
      <ChatRow chat={item} team label={`Team: ${item.title}`} onClick={() => h.onTeam(item.slot)} />
      {item.agents.length > 0 && (
        <li className="sb-agents-wrap">
          <ul className="sb-agents" aria-label={`Agents in ${item.title}`}>
            {item.agents.map((a) => (
              <ChatRow key={a.slot} chat={a} onClick={() => h.onAgent(a.slot, item.slot)} />
            ))}
          </ul>
        </li>
      )}
    </>
  );
}

function ProjectMenu({ project, h, onClose }: { project: SidebarProject; h: SidebarHandlers; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useDismiss(true, root, onClose);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const pick = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <div className="menu sb-menu project-menu" role="menu" aria-label={`${project.label} actions`} ref={root} onKeyDown={menuKeys}>
      <button role="menuitem" className="menu-row" onClick={pick(() => h.onNewTeamIn(project.folder))}>
        <span className="menu-row-title">New team</span>
      </button>
      <button role="menuitem" className="menu-row" onClick={pick(() => h.onBringOld(project.folder))}>
        <span className="menu-row-title">Bring old chats here…</span>
      </button>
      <button role="menuitem" className="menu-row" onClick={pick(() => h.onReveal(project.folder))}>
        <span className="menu-row-title">Reveal in Finder</span>
      </button>
      <button role="menuitem" className="menu-row" title="Only hides it here: the chats stay in Claude Code" onClick={pick(() => h.onRemove(project.folder))}>
        <span className="menu-row-title">Remove from recents</span>
      </button>
    </div>
  );
}

function PastRow({ title, meta, pinned, onClick }: { title: string; meta: string; pinned?: boolean; onClick: () => void }) {
  return (
    <li className="sb-item">
      <button className="sb-row past" title={title} onClick={onClick}>
        {pinned ? <span className="sb-pin lead" role="img" aria-label="Pinned"><PinIcon /></span> : <span className="sb-dot none" aria-hidden />}
        <span className="sb-title">{title}</span>
        <span className="sb-meta">{meta}</span>
      </button>
    </li>
  );
}

function Project({ project, expanded, onToggle, current, branch, moved, onRelocate, onDismissMoved, h }: { project: SidebarProject; expanded: boolean; onToggle: () => void; current: boolean; branch: string | null; moved: MovedFolder | null; onRelocate: (from: MovedFolder) => void; onDismissMoved: (old: string) => void; h: SidebarHandlers }) {
  const [menu, setMenu] = useState(false);
  const { past } = project;
  const shown = past ? past.pinned.length + past.recent.length : 0;
  return (
    <section className={`sb-project${current ? " current" : ""}`} aria-label={project.label}>
      <div className="sb-project-row">
        <button className="sb-project-toggle" aria-expanded={expanded} title={project.folder} onClick={onToggle}>
          <span className={`sb-chev${expanded ? " open" : ""}`}>
            <ChevronIcon />
          </span>
          <span className="sb-name">{project.label}</span>
          {current && branch && <span className="sb-branch">{branch}</span>}
          {!expanded && project.needs > 0 && (
            <span className="sb-badge" role="img" aria-label={`${project.needs} ${project.needs === 1 ? "needs" : "need"} you`}>
              {project.needs}
              <span className="sb-badge-dot" aria-hidden />
            </span>
          )}
        </button>
        <span className="sb-project-actions">
          <button className="icon" aria-label={`New chat in ${project.label}`} title="New chat here" onClick={() => h.onNewChatIn(project.folder)}>
            <PlusIcon />
          </button>
          <button className="icon" aria-label={`More for ${project.label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ⋯
          </button>
        </span>
        {menu && <ProjectMenu project={project} h={h} onClose={() => setMenu(false)} />}
      </div>
      {moved && <MovedNotice moved={moved} label={project.label} onRelocate={onRelocate} onDismiss={onDismissMoved} />}
      {expanded && (
        <ul className="sb-items">
          {project.items.map((item) => (
            <Item key={item.slot} item={item} h={h} />
          ))}
          {past?.pinned.map((r) => (
            <PastRow key={r.id} title={r.title} meta={relativeTime(r.updated_ms)} pinned onClick={() => h.onPast(project.folder, r.id)} />
          ))}
          {past?.recent.map((r) => (
            <PastRow key={r.id} title={r.title} meta={relativeTime(r.updated_ms)} onClick={() => h.onPast(project.folder, r.id)} />
          ))}
          {!past && <li className="sb-note">Loading…</li>}
          {past && past.total > shown && (
            <li className="sb-item">
              <button className="sb-more" onClick={() => h.onHistory(project.folder)}>
                {`Show all ${past.total}…`}
              </button>
            </li>
          )}
          {past && project.items.length === 0 && past.total === 0 && <li className="sb-note">No chats yet</li>}
        </ul>
      )}
    </section>
  );
}

/**
 * The left sidebar: one group per project (the ones with a chat open first, then the other recent folders), each with its
 * open chats and teams (agents nested under their team), pinned past chats and the latest few, and "Show all…". What
 * needs you rises to the top of its group and shows as a badge when the project is collapsed. Minimized, it is a narrow
 * rail of project initials with the same badges. Past chats are read only for an expanded project.
 */
export function Sidebar(props: Props) {
  const { collapsed, onCollapsed, width, onWidth, open, currentFolder, branch, canNew, loadRecent, loadSessions, pinned, titles, hidden, moved, onRelocate, onDismissMoved, ...h } = props;
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [past, setPast] = useState<Record<string, SessionSummary[] | undefined>>({});
  // A project the user opened or closed by hand; the others follow whether something is open in them.
  const [by, setBy] = usePersistentState<Record<string, boolean>>("sidebar.expanded", {});
  // A project that had something open stays open when its last chat closes, so the list doesn't fold up under the pointer.
  const seenOpen = useRef(new Set<string>());
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const openKey = Object.keys(open).sort().join("\n");
  useEffect(() => {
    loadRecent().then(setRecent, () => setRecent([]));
  }, [openKey]);

  const projects = useMemo(() => sidebarProjects({ recent, hidden, open, past, pinned, titles }), [recent, hidden, open, past, pinned, titles]);
  for (const p of projects) if (p.hasOpen) seenOpen.current.add(p.folder);
  const isExpanded = (p: SidebarProject) => by[p.folder] ?? (p.hasOpen || seenOpen.current.has(p.folder));

  // Past chats of the expanded projects, read when a project expands and again when its open chats change (one closed
  // becomes a past chat; a new one gets its session). Collapsed projects are never read, nor is anything on the rail.
  const wanted = (collapsed ? [] : projects.filter(isExpanded)).map((p) => `${p.folder}\t${(open[p.folder]?.sessionIds ?? []).join(",")}`);
  const read = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const entry of wanted) {
      const [folder, key] = entry.split("\t");
      if (read.current[folder] === key) continue;
      read.current[folder] = key;
      loadSessions(folder).then(
        (list) => setPast((all) => ({ ...all, [folder]: list })),
        () => setPast((all) => ({ ...all, [folder]: all[folder] ?? [] })),
      );
    }
  }, [wanted.join("\n")]);

  const movedFor = (folder: string) => moved.find((m) => m.old === folder) ?? null;
  // Starting something in a project shows it there, even in one that was folded up.
  const opening = (run: (folder: string) => void) => (folder: string) => {
    setBy({ ...by, [folder]: true });
    run(folder);
  };
  const toggle = (p: SidebarProject) => setBy({ ...by, [p.folder]: !isExpanded(p) });

  // Dragging the edge moves it here; the app hears the width once, on release (it would re-render the whole window per pixel).
  const dragFrom = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragFrom.current = { x: e.clientX, w: width };
    setDragWidth(width);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFrom.current) setDragWidth(clampWidth(dragFrom.current.w + e.clientX - dragFrom.current.x));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragFrom.current) return;
    const w = clampWidth(dragFrom.current.w + e.clientX - dragFrom.current.x);
    dragFrom.current = null;
    setDragWidth(null);
    onWidth(w);
  };
  const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") onWidth(clampWidth(width - step));
    else if (e.key === "ArrowRight") onWidth(clampWidth(width + step));
    else return;
    e.preventDefault();
  };

  const newMenu = { canNew, onNewChat: h.onNewChat, onNewTeam: h.onNewTeam, onReviewPr: h.onReviewPr };
  const toggleTitle = `${collapsed ? "Show" : "Hide"} sidebar${shortcut("toggle-sidebar") ? ` (${shortcut("toggle-sidebar")})` : ""}`;

  if (collapsed) {
    const goTo = (p: SidebarProject) => {
      // A waiting chat is one click away; otherwise the project's chat on screen, or its first; with none open, the sidebar.
      const first = p.items.find((i) => i.active) ?? p.items[0];
      if (p.target) return p.target.team ? h.onAgent(p.target.slot, p.target.team) : h.onChat(p.target.slot);
      if (first) return first.kind === "team" ? h.onTeam(first.slot) : h.onChat(first.slot);
      onCollapsed(false);
      setBy({ ...by, [p.folder]: true });
    };
    return (
      <aside className="sidebar rail" aria-label="Projects">
        <button className="icon sb-toggle" aria-label="Show sidebar" title={toggleTitle} onClick={() => onCollapsed(false)}>
          <SidebarIcon />
        </button>
        <NewMenu compact {...newMenu} />
        <ul className="rail-list">
          {projects.map((p) => (
            <li key={p.folder}>
              <button
                className={`rail-project${p.folder === currentFolder ? " current" : ""}${p.hasOpen ? " open" : ""}`}
                aria-label={p.needs > 0 ? `${p.label}, ${p.needs} ${p.needs === 1 ? "needs" : "need"} you` : p.label}
                title={p.needs > 0 ? `${p.label}: ${p.needs} ${p.needs === 1 ? "needs" : "need"} you` : p.label}
                onClick={() => goTo(p)}
              >
                {p.initials}
                {p.needs > 0 && <span className="rail-badge" aria-hidden>{p.needs}</span>}
              </button>
            </li>
          ))}
        </ul>
        <button className="icon sb-open-folder" aria-label="Open folder…" title="Open folder… (⌘O)" onClick={h.onOpenFolder}>
          <FolderOpenIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className={`sidebar${dragWidth !== null ? " dragging" : ""}`} aria-label="Projects" style={{ width: dragWidth ?? width }}>
      <div className="sb-head">
        <NewMenu {...newMenu} />
        <button className="icon sb-toggle" aria-label="Hide sidebar" title={toggleTitle} onClick={() => onCollapsed(true)}>
          <SidebarIcon />
        </button>
      </div>
      <nav className="sb-list" aria-label="Projects">
        {projects.map((p) => (
          <Project key={p.folder} project={p} expanded={isExpanded(p)} onToggle={() => toggle(p)} current={p.folder === currentFolder} branch={branch} moved={movedFor(p.folder)} onRelocate={onRelocate} onDismissMoved={onDismissMoved} h={{ ...h, onNewChatIn: opening(h.onNewChatIn), onNewTeamIn: opening(h.onNewTeamIn) }} />
        ))}
        {projects.length === 0 && <div className="sb-note">No projects yet. Open a folder to start.</div>}
      </nav>
      <button className="sb-foot" onClick={h.onOpenFolder}>
        <FolderOpenIcon />
        <span>Open folder…</span>
      </button>
      <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={dragWidth ?? width} tabIndex={0} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onResizeKey} />
    </aside>
  );
}
