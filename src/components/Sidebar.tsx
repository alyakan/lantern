import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { MovedFolder, RecentFolder, SessionSummary } from "../types";
import { usePersistentState } from "../lib/layout";
import { ACTIONS, shortcutLabel } from "../lib/actions";
import { relativeTime } from "../lib/time";
import { basename } from "../lib/diff";
import { PROJECT_COLORS, assignColors } from "../lib/projectColors";
import { chipOf, compactGroups, initials, markOf, projectFolders, sidebarProjects, type CompactChip, type ProjectOpen, type SidebarProject } from "../lib/sidebar";
import { ChevronIcon, FolderOpenIcon, PinIcon, PlusIcon, SidebarIcon, TeamIcon } from "./icons";
import { MovedNotice } from "./MovedFolders";
import { moveFocus } from "./useMenuKeys";
import { moveProject, orderProjects } from "../lib/projectOrder";
import { useReorder } from "../lib/useReorder";

/** The sidebar's width in pixels: what Show/Hide Sidebar and the drag edge keep between these. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 248;
const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));

/** How long the pointer rests on the collapsed bar before it opens, so passing over it on the way to the chat doesn't. */
export const OPEN_AFTER_MS = 220;
/** How long the bar takes to close again (the stylesheet's width transition): its pane stays drawn until then. */
const CLOSE_MS = 240;

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

/**
 * What the sidebar last showed, kept by the app across the sidebar being shown again (each peek is a new one): it starts
 * from this instead of an empty list, and reads it all again behind it, so it doesn't flash empty and fill in.
 */
export interface SidebarMemory {
  recent: RecentFolder[];
  past: Record<string, SessionSummary[] | undefined>;
  /** The projects that had something open (see seenOpen). */
  seenOpen: Set<string>;
}

export const sidebarMemory = (): SidebarMemory => ({ recent: [], past: {}, seenOpen: new Set() });

/**
 * pinned: kept open at the saved width, beside the chat. collapsed: a slim column of squares that opens over the chat while
 * the pointer rests on it. peek: opened over the chat from the window's edge while the sidebar is hidden (the app slides it in).
 */
export type SidebarMode = "pinned" | "collapsed" | "peek";

interface Props extends SidebarHandlers {
  mode: SidebarMode;
  /** Its button at the top: pins it open (collapsed, or peeking in over the chat), or collapses it (pinned). */
  onToggle: () => void;
  /** How wide it is pinned, and how wide it opens over the chat. */
  width: number;
  onWidth: (width: number) => void;
  /** What is open, by project (see openProjects), and the project on screen with its branch. */
  open: Record<string, ProjectOpen>;
  currentFolder: string | null;
  branch: string | null;
  /** New ▾ can start something (a project is open, and its chat isn't starting). */
  canNew: boolean;
  loadRecent: () => Promise<RecentFolder[]>;
  /** Reads a project's past chats: called only for the projects that are expanded, and only while the pane is open. */
  loadSessions: (folder: string) => Promise<SessionSummary[]>;
  pinned: Record<string, string[]>;
  titles: Record<string, string>;
  /** Projects removed from the recents (they still show while a chat is open in them). */
  hidden: string[];
  /** Folders that seem to have moved, with what to do about them. */
  moved: MovedFolder[];
  onRelocate: (from: MovedFolder) => void;
  onDismissMoved: (old: string) => void;
  /** What it showed last time (see SidebarMemory); without it, it starts empty. */
  memory?: SidebarMemory;
  /** The user's order of the projects (folder paths, see orderProjects), and saving a new one. */
  order?: string[];
  onOrder?: (order: string[]) => void;
  /** Each project's colour, an index into PROJECT_COLORS by folder (saved by the app, see assignColors). */
  colors: Record<string, number>;
  /** The colours with a project new to them given one, to save. */
  onColors: (colors: Record<string, number>) => void;
}

/** Focus that came from the keyboard (a click focuses a button too, and that shouldn't open the column). */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
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
function NewMenu({ canNew, onNewChat, onNewTeam, onReviewPr }: Pick<Props, "canNew" | "onNewChat" | "onNewTeam" | "onReviewPr">) {
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
      <button className="sb-new-button" aria-haspopup="menu" aria-expanded={open} aria-label="New" title="Start something new" disabled={!canNew} onClick={() => setOpen(!open)}>
        <PlusIcon />
        <span>New</span>
        <span className="chev down" aria-hidden />
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

/** What a row says to VoiceOver (and shows, once the pane is open): the title, the project and the status. */
const describe = (chip: CompactChip, project: string, full: boolean) => {
  const extra = full ? `${chip.pinned ? ", pinned" : ""}${chip.background > 0 ? `, ${chip.background} running in the background` : ""}` : "";
  return `${chip.team ? "Team: " : ""}${chip.title}, ${project}, ${chip.status}${extra}`;
};

/**
 * A chat's row: its square, and beside it (shown once the pane opens) its title and how it is. A team's square has a
 * diamond on its corner. Open in full, the row also says when it is pinned or has tasks in the background, and a chat
 * that can be closed has a × at its end.
 */
function ChatRow({ chip, project, onClick, onClose, full }: { chip: CompactChip; project: string; onClick: () => void; onClose?: () => void; full: boolean }) {
  const mark = markOf(chip);
  const title = chip.team ? `Team: ${chip.title}` : chip.title;
  const closable = full && chip.closable && !!onClose;
  return (
    <li className={full ? `sb-item${closable ? " closable" : ""}` : undefined}>
      <button className={`sb-row${chip.active ? " current" : ""}`} aria-label={describe(chip, project, full)} aria-current={chip.active ? "true" : undefined} title={full ? chip.title : undefined} onClick={onClick}>
        <span className={`sb-chip${chip.active ? " current" : ""}${chip.team ? " team" : ""}`} aria-hidden>
          <span className="sb-initials">{chip.initials}</span>
          {chip.team && (
            <span className="sb-team">
              <TeamIcon />
            </span>
          )}
          {mark === "running" && <span className="sb-mark running" />}
          {mark === "waiting" && <span className="sb-mark waiting" />}
          {mark === "unread" && <span className="sb-mark unread" />}
        </span>
        <span className="sb-text" aria-hidden>
          {full ? (
            <span className="sb-title-line">
              <span className="sb-title">{title}</span>
              {chip.pinned && (
                <span className="sb-pin">
                  <PinIcon />
                </span>
              )}
              {chip.background > 0 && <span className="spinner" />}
            </span>
          ) : (
            <span className="sb-title">{title}</span>
          )}
          <span className={`sb-status ${mark}`}>{chip.status}</span>
        </span>
      </button>
      {closable && (
        <button className="icon sb-close" aria-label={`Close ${chip.title}`} title={chip.state === "draft" ? "Close (discards the unsent text)" : "Close"} onClick={onClose}>
          ×
        </button>
      )}
    </li>
  );
}

function Item({ item, project, h }: { item: ProjectOpen["items"][number]; project: string; h: SidebarHandlers }) {
  const chip = chipOf(item);
  if (item.kind === "chat") return <ChatRow full chip={chip} project={project} onClick={() => h.onChat(item.slot)} onClose={() => h.onCloseChat(item.slot)} />;
  return (
    <>
      <ChatRow full chip={chip} project={project} onClick={() => h.onTeam(item.slot)} />
      {item.agents.length > 0 && (
        <li className="sb-agents-wrap">
          <ul className="sb-agents" aria-label={`Agents in ${item.title}`}>
            {item.agents.map((a) => (
              <ChatRow key={a.slot} full chip={chipOf(a)} project={project} onClick={() => h.onAgent(a.slot, item.slot)} />
            ))}
          </ul>
        </li>
      )}
    </>
  );
}

/** A past chat: no square, only its title and how long ago. */
function PastRow({ title, meta, pinned, onClick }: { title: string; meta: string; pinned?: boolean; onClick: () => void }) {
  return (
    <li className="sb-item">
      <button className="sb-row past" title={title} onClick={onClick}>
        <span className="sb-lead">
          {pinned && (
            <span className="sb-pin" role="img" aria-label="Pinned">
              <PinIcon />
            </span>
          )}
        </span>
        <span className="sb-title">{title}</span>
        <span className="sb-meta">{meta}</span>
      </button>
    </li>
  );
}

/** Moving a project up or down one place (None: it's already at that end). */
interface Moves {
  up: (() => void) | null;
  down: (() => void) | null;
}

function ProjectMenu({ project, h, moves, onClose }: { project: SidebarProject; h: SidebarHandlers; moves: Moves; onClose: () => void }) {
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
      <button role="menuitem" className="menu-row" disabled={!moves.up} onClick={pick(() => moves.up?.())}>
        <span className="menu-row-title">Move up</span>
        <kbd className="menu-row-key">⌥⌘↑</kbd>
      </button>
      <button role="menuitem" className="menu-row" disabled={!moves.down} onClick={pick(() => moves.down?.())}>
        <span className="menu-row-title">Move down</span>
        <kbd className="menu-row-key">⌥⌘↓</kbd>
      </button>
      <button role="menuitem" className="menu-row" title="Only hides it here: the chats stay in Claude Code" onClick={pick(() => h.onRemove(project.folder))}>
        <span className="menu-row-title">Remove from recents</span>
      </button>
    </div>
  );
}

/** ⌥⌘↑ / ⌥⌘↓ on a project's header move it one place (the keyboard's way to reorder). */
function moveByKey(e: ReactKeyboardEvent<HTMLElement>, moves: Moves) {
  if (!e.altKey || !e.metaKey || e.shiftKey || e.ctrlKey) return;
  const move = e.key === "ArrowUp" ? moves.up : e.key === "ArrowDown" ? moves.down : undefined;
  if (move === undefined) return;
  e.preventDefault();
  move?.();
}

/** How a project takes part in reordering: its header is the handle, and where it's drawn while one is dragged. */
interface Reorder {
  handle: Pick<React.DOMAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp">;
  style: CSSProperties | undefined;
  lifted: boolean;
  moves: Moves;
}

/**
 * One project of the open pane: its header (the project's coloured initials, its name, the branch when it is the one on
 * screen, what needs you when it is folded, and + and ⋯ while the pointer is on it), then its open chats and teams, its
 * pinned and latest past chats, and "Show all…".
 */
function Project({ project, color, expanded, onToggle, current, branch, moved, onRelocate, onDismissMoved, h, reorder }: { project: SidebarProject; color: string; expanded: boolean; onToggle: () => void; current: boolean; branch: string | null; moved: MovedFolder | null; onRelocate: (from: MovedFolder) => void; onDismissMoved: (old: string) => void; h: SidebarHandlers; reorder: Reorder }) {
  const [menu, setMenu] = useState(false);
  const { past } = project;
  const shown = past ? past.pinned.length + past.recent.length : 0;
  return (
    <section className={`sb-section${current ? " current" : ""}${reorder.lifted ? " lifted" : ""}`} aria-label={project.label} data-reorder-id={project.folder} style={{ ...reorder.style, "--pc": color } as CSSProperties}>
      <div className="sb-header" {...reorder.handle}>
        <button className="sb-header-toggle" aria-expanded={expanded} title={project.folder} onClick={onToggle} onKeyDown={(e) => moveByKey(e, reorder.moves)}>
          <span className="sb-project-initials" aria-hidden>
            {initials(basename(project.folder), 2)}
          </span>
          <span className="sb-name">{project.label}</span>
          <span className={`sb-fold${expanded ? " open" : ""}`} aria-hidden>
            <ChevronIcon />
          </span>
          {current && branch && <span className="sb-branch">{branch}</span>}
          {!expanded && project.needs > 0 && (
            <span className="sb-badge" role="img" aria-label={`${project.needs} ${project.needs === 1 ? "needs" : "need"} you`}>
              {project.needs}
              <span className="sb-badge-dot" aria-hidden />
            </span>
          )}
        </button>
        <span className="sb-actions" data-no-drag>
          <button className="icon" aria-label={`New chat in ${project.label}`} title="New chat here" onClick={() => h.onNewChatIn(project.folder)}>
            <PlusIcon />
          </button>
          <button className="icon" aria-label={`More for ${project.label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ⋯
          </button>
        </span>
        {menu && <ProjectMenu project={project} h={h} moves={reorder.moves} onClose={() => setMenu(false)} />}
      </div>
      {moved && <MovedNotice moved={moved} label={project.label} onRelocate={onRelocate} onDismiss={onDismissMoved} />}
      {expanded && (
        <>
          {project.items.length > 0 && (
            <ul className="sb-group">
              {project.items.map((item) => (
                <Item key={item.slot} item={item} project={project.label} h={h} />
              ))}
            </ul>
          )}
          <ul className="sb-past-list">
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
        </>
      )}
    </section>
  );
}

/**
 * The left sidebar. Collapsed, it is a slim column with a square for each open chat and team (not for projects), the
 * chat's initials on it and a mark for how it is: a ring while it works, an amber dot when it needs you, a blue dot when
 * it finished unread. Each project has a colour of its own, kept across restarts: its squares are tinted with it, and the one
 * on screen is filled with it and has a bar beside it. A team is one square, for its Lead, with the team's combined state.
 *
 * Open (pinned beside the chat, or over it), the same pane shows every project: its header, its open chats and teams (agents
 * nested under their team), pinned past chats and the latest few, and "Show all…". What needs you rises to the top of its
 * project and shows as a badge when the project is folded. Past chats are read only for an expanded project, and only while
 * the pane is open.
 *
 * Resting the pointer on the collapsed column (or moving focus into it) opens it over the chat to the pinned width: the
 * squares stay where they are, and the titles, statuses and the rest of the pane come in beside them. It closes when the
 * pointer leaves, focus goes, Escape is pressed, or something is picked.
 */
export function Sidebar(props: Props) {
  const { mode, onToggle, width, onWidth, open, currentFolder, branch, canNew, loadRecent, loadSessions, pinned, titles, hidden, moved, onRelocate, onDismissMoved, memory, order = [], onOrder, colors: savedColors, onColors, ...handlers } = props;
  const [recent, setRecent] = useState<RecentFolder[]>(() => memory?.recent ?? []);
  const [past, setPast] = useState<Record<string, SessionSummary[] | undefined>>(() => memory?.past ?? {});
  if (memory) {
    memory.recent = recent;
    memory.past = past;
  }
  // A project the user opened or closed by hand; the others follow whether something is open in them.
  const [by, setBy] = usePersistentState<Record<string, boolean>>("sidebar.expanded", {});
  // A project that had something open stays open when its last chat closes, so the list doesn't fold up under the pointer.
  const seenOpen = useRef(memory?.seenOpen ?? new Set<string>());
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  // Collapsed, it opens over the chat after the pointer rests on it, or while focus is in it; then it takes a moment to close.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [closing, setClosing] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const floating = mode === "collapsed" && (hovered || focused);
  const expanded = mode !== "collapsed" || floating;
  // Closing, the pane stays drawn while its width shrinks, then the bar takes its place.
  const full = expanded || closing;
  const wasFloating = useRef(false);
  wasFloating.current = floating;

  const openKey = Object.keys(open).sort().join("\n");
  useEffect(() => {
    loadRecent().then(setRecent, () => setRecent([]));
  }, [openKey]);

  const projects = useMemo(() => sidebarProjects({ recent, hidden, open, past, pinned, titles, order }), [recent, hidden, open, past, pinned, titles, order]);
  const groups = useMemo(() => compactGroups(open, recent, order), [open, recent, order]);
  // The projects with something open get their colours first, in the order the collapsed bar lists them, so what the bar
  // shows doesn't depend on the others.
  const colors = assignColors(projects.map((p) => p.folder), assignColors(groups.map((g) => g.folder), savedColors));
  useEffect(() => {
    if (colors !== savedColors) onColors(colors);
  }, [colors, savedColors]);
  // A project new to the order is saved at the top, where it shows (only once the recents are read, so the order isn't
  // started from the open projects alone).
  const ordered = orderProjects(projectFolders(recent, hidden, open), order).order;
  const loaded = recent.length > 0;
  useEffect(() => {
    if (loaded && ordered !== order) onOrder?.(ordered);
  }, [loaded, ordered, order]);
  const listed = projects.map((p) => p.folder);
  const moveTo = (folder: string, index: number) => onOrder?.(moveProject(ordered, listed, folder, index));
  const list = useRef<HTMLElement>(null);
  const reorder = useReorder(listed, list, moveTo);
  const movesOf = (folder: string, i: number): Moves => ({
    up: onOrder && i > 0 ? () => moveTo(folder, i - 1) : null,
    down: onOrder && i < listed.length - 1 ? () => moveTo(folder, i + 1) : null,
  });
  for (const p of projects) if (p.hasOpen) seenOpen.current.add(p.folder);
  const isExpanded = (p: SidebarProject) => by[p.folder] ?? (p.hasOpen || seenOpen.current.has(p.folder));

  // Past chats of the expanded projects, read when a project expands and again when its open chats change (one closed
  // becomes a past chat; a new one gets its session). Folded projects are never read, nor any while only the bar shows.
  const wanted = full ? projects.filter(isExpanded).map((p) => `${p.folder}\t${(open[p.folder]?.sessionIds ?? []).join(",")}`) : [];
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

  useEffect(
    () => () => {
      if (rest.current) clearTimeout(rest.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  const stopClosing = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
  };
  const enter = (e: { buttons: number }) => {
    // Not while dragging something across it.
    if (e.buttons || rest.current) return;
    rest.current = setTimeout(() => {
      rest.current = null;
      stopClosing();
      setHovered(true);
    }, OPEN_AFTER_MS);
  };
  /** Puts the open bar away: the pointer left, Escape, or something was picked. */
  const dismiss = () => {
    if (rest.current) clearTimeout(rest.current);
    rest.current = null;
    setHovered(false);
    setFocused(false);
    if (wasFloating.current && !reducedMotion()) {
      setClosing(true);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(stopClosing, CLOSE_MS);
    }
  };
  const leave = () => {
    // Not while a project is being dragged: the pointer may leave the bar and the drag goes on.
    if (!reorder.drag) dismiss();
  };
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };
  // Esc closes it, wherever focus is.
  useEffect(() => {
    if (!floating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      dismiss();
      (document.activeElement as HTMLElement | null)?.blur?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [floating]);
  // Pinned or peeking, there is no bar to open.
  useEffect(() => {
    if (mode === "collapsed") return;
    if (rest.current) clearTimeout(rest.current);
    rest.current = null;
    setHovered(false);
    setFocused(false);
    stopClosing();
  }, [mode]);

  // Picking something in the bar takes you there and puts the bar away (the app does the same for a peek).
  const then = <A extends unknown[]>(run: (...args: A) => void) => (...args: A) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    dismiss();
    run(...args);
  };
  const h: SidebarHandlers =
    mode !== "collapsed"
      ? handlers
      : {
          ...handlers,
          onChat: then(handlers.onChat),
          onTeam: then(handlers.onTeam),
          onAgent: then(handlers.onAgent),
          onPast: then(handlers.onPast),
          onHistory: then(handlers.onHistory),
          onNewChatIn: then(handlers.onNewChatIn),
          onNewTeamIn: then(handlers.onNewTeamIn),
          onBringOld: then(handlers.onBringOld),
          onOpenFolder: then(handlers.onOpenFolder),
          onNewChat: then(handlers.onNewChat),
          onNewTeam: then(handlers.onNewTeam),
          onReviewPr: then(handlers.onReviewPr),
        };
  const toggleBar = () => {
    // Pinning it takes the open bar's place; collapsing it leaves nothing open.
    if (rest.current) clearTimeout(rest.current);
    rest.current = null;
    setHovered(false);
    setFocused(false);
    onToggle();
  };

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
  const pin = mode === "pinned" ? "Collapse sidebar" : full ? "Keep sidebar open" : "Expand sidebar";
  const label = full ? "Projects" : "Open chats";
  const shownWidth = dragWidth ?? width;

  return (
    <aside className={`sidebar ${mode}${dragWidth !== null ? " dragging" : ""}${reorder.drag ? " reordering" : ""}`} aria-label={label} style={mode === "collapsed" ? undefined : { width: shownWidth }}>
      {/* Pinned and floating are different elements, so pinning or collapsing is at once, not a width transition. */}
      <div
        key={mode === "pinned" ? "pinned" : "floating"}
        className={`sb-panel${expanded ? " expanded" : ""}`}
        style={{ "--sb-open": `${shownWidth}px` } as CSSProperties}
        onPointerEnter={mode === "collapsed" ? enter : undefined}
        onPointerLeave={mode === "collapsed" ? leave : undefined}
        onFocus={mode === "collapsed" ? (e) => keyboardFocus(e.target) && setFocused(true) : undefined}
        onBlur={mode === "collapsed" ? onBlur : undefined}
      >
        <div className="sb-head">
          <button className={`icon sb-button${mode === "pinned" ? " on" : ""}`} aria-label={pin} title={pin} onClick={toggleBar}>
            {full ? <span className="sb-pin-glyph"><PinIcon /></span> : <SidebarIcon />}
          </button>
          {full ? (
            <NewMenu {...newMenu} />
          ) : (
            <button className="icon sb-button" aria-label="New chat" title="New chat" disabled={!canNew} onClick={h.onNewChat}>
              <PlusIcon />
            </button>
          )}
        </div>
        <nav className="sb-list" aria-label={label} ref={list} onClickCapture={reorder.onClickCapture}>
          {full ? (
            <>
              {projects.map((p, i) => (
                <Project
                  key={p.folder}
                  project={p}
                  color={PROJECT_COLORS[colors[p.folder]]}
                  expanded={isExpanded(p)}
                  onToggle={() => toggle(p)}
                  current={p.folder === currentFolder}
                  branch={branch}
                  moved={movedFor(p.folder)}
                  onRelocate={onRelocate}
                  onDismissMoved={onDismissMoved}
                  h={{ ...h, onNewChatIn: opening(h.onNewChatIn), onNewTeamIn: opening(h.onNewTeamIn) }}
                  reorder={{ handle: onOrder ? reorder.handle(p.folder) : {}, style: reorder.styleFor(p.folder), lifted: reorder.lifted === p.folder, moves: movesOf(p.folder, i) }}
                />
              ))}
              {projects.length === 0 && <div className="sb-note">No projects yet. Open a folder to start.</div>}
            </>
          ) : (
            groups.map((group) => (
              <Fragment key={group.folder}>
                <div className="sb-project" title={group.label} aria-hidden style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
                  <span className="sb-project-initials">{group.initials}</span>
                  <span className="sb-project-name">{group.label}</span>
                </div>
                <ul className="sb-group" aria-label={group.label} style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
                  {group.chips.map((chip) => (
                    <ChatRow key={chip.slot} chip={chip} project={group.label} full={false} onClick={() => (chip.team ? h.onTeam(chip.slot) : h.onChat(chip.slot))} />
                  ))}
                </ul>
              </Fragment>
            ))
          )}
        </nav>
        {full && (
          <button className="sb-foot" onClick={h.onOpenFolder}>
            <FolderOpenIcon />
            <span>Open folder…</span>
          </button>
        )}
      </div>
      {mode === "pinned" && <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={shownWidth} tabIndex={0} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onResizeKey} />}
    </aside>
  );
}
