import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { CloseAgreed, CloseCheck, MovedFolder, RecentFolder } from "../types";
import { usePersistentState } from "../lib/layout";
import { ACTIONS, shortcutLabel } from "../lib/actions";
import { PROJECT_COLORS, assignColors } from "../lib/projectColors";
import { chipOf, compactGroups, markOf, projectFolders, type ChatDot, type CompactChip, type CompactGroup, type ProjectOpen, type SidebarChat, type SidebarItem } from "../lib/sidebar";
import { lostText } from "../lib/orchestraView";
import { ChevronIcon, ClockIcon, FolderOpenIcon, PinIcon, PlusIcon, SidebarIcon, TeamIcon } from "./icons";
import { MovedNotice } from "./MovedFolders";
import { moveFocus } from "./useMenuKeys";
import { moveProject, orderProjects } from "../lib/projectOrder";
import { useReorder } from "../lib/useReorder";
import { useMenuInside } from "../lib/useMenuInside";

/** The sidebar's width in pixels: what Show/Hide Sidebar and the drag edge keep between these. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 248;
const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));

/** How long the pointer rests on the collapsed bar before it opens, so passing over it on the way to the chat doesn't. */
export const OPEN_AFTER_MS = 220;
/** How long the bar takes to close again (the stylesheet's width transition): its pane stays drawn until then. */
const CLOSE_MS = 240;
/** How long "Closed 3 finished chats" stays under a project's header. */
const NOTICE_MS = 4000;

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
  /** Closes chats (any, the one on screen too: the app shows another, or the start screen). Asking first is the sidebar's job. */
  onCloseChats: (slots: string[]) => void;
  /** What closing an agent would throw away, and closing it (the same checked flow as the canvas's "Clean up and close"). */
  closeCheck: (worker: string) => Promise<CloseCheck>;
  closeWorker: (worker: string, agreed?: CloseAgreed) => Promise<void>;
  /** The History button: past chats of every project. */
  onHistory: () => void;
  onNewChatIn: (folder: string) => void;
  onNewTeamIn: (folder: string) => void;
  onBringOld: (folder: string) => void;
  onReveal: (folder: string) => void;
  onRemove: (folder: string) => void;
  /** Opens the project's "Pull request checks" choice (Off, Tell me, Fix it myself). */
  onPrChecks: (folder: string) => void;
  onOpenFolder: () => void;
  /** New ▾, for the project on screen. */
  onNewChat: () => void;
  onNewTeam: () => void;
  onReviewPr: () => void;
}

/**
 * What the sidebar last showed, kept by the app across the sidebar being shown again (each peek is a new one): it starts
 * from this instead of an empty list, and reads it all again behind it, so the projects don't change order as it fills in.
 */
export interface SidebarMemory {
  recent: RecentFolder[];
}

export const sidebarMemory = (): SidebarMemory => ({ recent: [] });

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

/** Closes a popover on a press outside it or Escape; Escape puts focus back on `opener`, the button that opened it. */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void, opener?: () => HTMLElement | null | undefined) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      opener?.()?.focus();
    };
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
  useDismiss(open, root, () => setOpen(false), () => root.current?.querySelector<HTMLElement>("[aria-haspopup]"));
  // The sidebar clips what sticks out of it, so the menu stays inside it.
  const { ref: menuRef, style: menuStyle } = useMenuInside(open);
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
        <div className="menu sb-menu" role="menu" aria-label="New" ref={menuRef} style={menuStyle} onKeyDown={menuKeys}>
          {item("Chat", "new-session", onNewChat)}
          {item("Team", "work-team", onNewTeam)}
          {item("Review a PR…", null, onReviewPr)}
        </div>
      )}
    </div>
  );
}

/** What a chat, a team or an agent is, for closing it: they are asked about and closed differently. */
interface CloseTarget {
  slot: string;
  kind: "chat" | "team" | "agent";
  title: string;
  state: ChatDot;
  /** A team's agents. */
  agents: string[];
}

/** Where a menu or a question opens, in the window's own coordinates (the bar is too narrow to hold them). */
interface At {
  x: number;
  y: number;
}

/** A question about closing, waiting for the user: nothing is stopped or removed until they say yes. */
interface Closing {
  target: CloseTarget;
  at: At;
  question: string;
  yes: string;
  /** What each agent to be closed was told it would lose, so closing it agrees to exactly that. */
  agreed: Record<string, CloseAgreed>;
  error: string | null;
  busy: boolean;
}

/** The close flow, as one project's rows use it. */
interface Closer {
  closing: Closing | null;
  /** Closes it, asking first when it works, or has a team, or work that would be lost. */
  ask: (target: CloseTarget, at: At) => void;
  /** Opens "Close chat" where the user pressed. */
  menu: (target: CloseTarget, at: At) => void;
  confirm: () => void;
  cancel: () => void;
}

const targetOf = (item: Pick<SidebarChat, "slot" | "title" | "state">, kind: CloseTarget["kind"], agents: string[] = []): CloseTarget => ({ slot: item.slot, kind, title: item.title, state: item.state, agents });
const itemTarget = (item: SidebarItem): CloseTarget => (item.kind === "team" ? targetOf(item, "team", item.agents.map((a) => a.slot)) : targetOf(item, "chat"));

/** Closing's question, inline under the row (open pane) or on its own where the user pressed (the bar). */
function CloseConfirm({ closing, closer, floating }: { closing: Closing; closer: Closer; floating: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closer.cancel();
    const onDown = (e: MouseEvent) => floating && !root.current?.contains(e.target as Node) && closer.cancel();
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);
  return (
    <div className={`sb-confirm${floating ? " floating" : ""}`} role="group" aria-label={`Close ${closing.target.title}`} ref={root} style={floating ? { left: closing.at.x, top: closing.at.y } : undefined}>
      <span className="sb-confirm-text">{closing.error ? `Couldn't close it: ${closing.error}` : closing.question}</span>
      <span className="sb-confirm-actions">
        <button className="sb-confirm-yes" autoFocus disabled={closing.busy} onClick={closer.confirm}>
          {closing.busy ? "Closing…" : closing.yes}
        </button>
        <button className="sb-confirm-no" onClick={closer.cancel}>
          Cancel
        </button>
      </span>
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
 * diamond on its corner. Open in full, the row also says when it is pinned or has tasks in the background. Any row can be
 * closed: with a × at its end (hover or focus) in the open pane, with a small × on the square's corner in the bar, and
 * with "Close chat" in the menu a right click opens.
 */
function ChatRow({ chip, project, onClick, target, closer, full }: { chip: CompactChip; project: string; onClick: () => void; target: CloseTarget; closer: Closer; full: boolean }) {
  const mark = markOf(chip);
  const title = chip.team ? `Team: ${chip.title}` : chip.title;
  const closing = closer.closing?.target.slot === target.slot ? closer.closing : null;
  const press = (e: ReactMouseEvent<HTMLElement>) => closer.ask(target, { x: e.clientX, y: e.clientY });
  return (
    <>
      <li className={full ? "sb-item" : undefined}>
        <button className={`sb-row${chip.active ? " current" : ""}`} aria-label={describe(chip, project, full)} aria-current={chip.active ? "true" : undefined} title={full ? chip.title : undefined} onClick={onClick} onContextMenu={(e) => {
          e.preventDefault();
          closer.menu(target, { x: e.clientX, y: e.clientY });
        }}>
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
        {full ? (
          <button className="icon sb-close" aria-label={`Close ${chip.title}`} title={chip.state === "draft" ? "Close (discards the unsent text)" : "Close"} onClick={press}>
            ×
          </button>
        ) : (
          <button className="sb-corner-close" aria-hidden tabIndex={-1} title="Close" onClick={press}>
            ×
          </button>
        )}
      </li>
      {full && closing && (
        <li className="sb-confirm-wrap">
          <CloseConfirm closing={closing} closer={closer} floating={false} />
        </li>
      )}
    </>
  );
}

/** What a team's agents are doing, in a few words for the line that folds them: who needs you, else who works. */
function agentsSummary(agents: SidebarChat[]): { text: string; waiting: boolean } {
  const waiting = agents.filter((a) => a.state === "waiting").length;
  if (waiting > 0) return { text: `${waiting} ${waiting === 1 ? "needs" : "need"} you`, waiting: true };
  const working = agents.filter((a) => a.state === "running").length;
  return { text: working > 0 ? `${working} working` : "", waiting: false };
}

/**
 * A chat, or a team: its row, and under a team's row a line "3 agents" that opens the list of them. They are folded
 * unless you opened them, or the one on screen is one of them (so the row you are in is never hidden). The team's own row
 * already carries the team's combined state, and a line that says who needs you.
 */
function Item({ item, project, h, closer, agentsOpen, onAgents }: { item: SidebarItem; project: string; h: SidebarHandlers; closer: Closer; agentsOpen: Record<string, boolean>; onAgents: (slot: string, open: boolean) => void }) {
  const chip = chipOf(item);
  if (item.kind === "chat") return <ChatRow full chip={chip} project={project} onClick={() => h.onChat(item.slot)} target={itemTarget(item)} closer={closer} />;
  const open = agentsOpen[item.slot] ?? item.agents.some((a) => a.active);
  const sum = agentsSummary(item.agents);
  return (
    <>
      <ChatRow full chip={chip} project={project} onClick={() => h.onTeam(item.slot)} target={itemTarget(item)} closer={closer} />
      {item.agents.length > 0 && (
        <li className="sb-agents-wrap">
          <button className="sb-agents-toggle" aria-expanded={open} aria-label={`${item.agents.length} ${item.agents.length === 1 ? "agent" : "agents"} in ${item.title}${sum.text ? `, ${sum.text}` : ""}`} onClick={() => onAgents(item.slot, !open)}>
            <span className={`sb-fold${open ? " open" : ""}`} aria-hidden>
              <ChevronIcon />
            </span>
            <span aria-hidden>
              {item.agents.length} {item.agents.length === 1 ? "agent" : "agents"}
            </span>
            {sum.text && (
              <span className={`sb-agents-sum${sum.waiting ? " waiting" : ""}`} aria-hidden>
                {sum.text}
              </span>
            )}
          </button>
          {open && (
            <ul className="sb-agents" aria-label={`Agents in ${item.title}`}>
              {item.agents.map((a) => (
                <ChatRow key={a.slot} full chip={chipOf(a)} project={project} onClick={() => h.onAgent(a.slot, item.slot)} target={targetOf(a, "agent")} closer={closer} />
              ))}
            </ul>
          )}
        </li>
      )}
    </>
  );
}

/** Moving a project up or down one place (None: it's already at that end). */
interface Moves {
  up: (() => void) | null;
  down: (() => void) | null;
}

function ProjectMenu({ group, h, moves, finished, onClose, onClosed }: { group: CompactGroup; h: SidebarHandlers; moves: Moves; finished: string[]; onClose: () => void; onClosed: (count: number) => void }) {
  const { ref: root, style } = useMenuInside(true);
  useDismiss(true, root, onClose, () => root.current?.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]'));
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const pick = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <div className="menu sb-menu project-menu" role="menu" aria-label={`${group.label} actions`} ref={root} style={style} onKeyDown={menuKeys}>
      <button role="menuitem" className="menu-row" onClick={pick(() => h.onNewTeamIn(group.folder))}>
        <span className="menu-row-title">New team</span>
      </button>
      <button
        role="menuitem"
        className="menu-row"
        title="Closes the chats here that are done: not the ones working, or teams"
        onClick={pick(() => {
          if (finished.length > 0) h.onCloseChats(finished);
          onClosed(finished.length);
        })}
      >
        <span className="menu-row-title">Close finished chats</span>
      </button>
      <button role="menuitem" className="menu-row" onClick={pick(() => h.onBringOld(group.folder))}>
        <span className="menu-row-title">Bring old chats here…</span>
      </button>
      <button role="menuitem" className="menu-row" title="What happens after a pull request is open and its checks run" onClick={pick(() => h.onPrChecks(group.folder))}>
        <span className="menu-row-title">Pull request checks…</span>
      </button>
      <button role="menuitem" className="menu-row" onClick={pick(() => h.onReveal(group.folder))}>
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
      <button role="menuitem" className="menu-row" title="Only hides it from the recents: the chats stay in Claude Code" onClick={pick(() => h.onRemove(group.folder))}>
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
 * screen, what needs you when it is folded, and + and ⋯ while the pointer is on it), then its open chats and teams.
 */
function Project({ group, color, expanded, onToggle, current, branch, moved, onRelocate, onDismissMoved, h, closer, reorder, notice, onNotice, agentsOpen, onAgents }: { group: CompactGroup; color: string; expanded: boolean; onToggle: () => void; current: boolean; branch: string | null; moved: MovedFolder | null; onRelocate: (from: MovedFolder) => void; onDismissMoved: (old: string) => void; h: SidebarHandlers; closer: Closer; reorder: Reorder; notice: string | null; onNotice: (text: string) => void; agentsOpen: Record<string, boolean>; onAgents: (slot: string, open: boolean) => void }) {
  const [menu, setMenu] = useState(false);
  // The chats that are done: not a working one, a draft, or a team.
  const finished = group.items.flatMap((item) => (item.kind === "chat" && item.state === "done" ? [item.slot] : []));
  return (
    <section className={`sb-section${current ? " current" : ""}${reorder.lifted ? " lifted" : ""}`} aria-label={group.label} data-reorder-id={group.folder} style={{ ...reorder.style, "--pc": color } as CSSProperties}>
      <div className="sb-header" {...reorder.handle}>
        <button className="sb-header-toggle" aria-expanded={expanded} title={group.folder} onClick={onToggle} onKeyDown={(e) => moveByKey(e, reorder.moves)}>
          <span className="sb-project-initials" aria-hidden>
            {group.initials}
          </span>
          <span className="sb-name">{group.label}</span>
          <span className={`sb-fold${expanded ? " open" : ""}`} aria-hidden>
            <ChevronIcon />
          </span>
          {current && branch && <span className="sb-branch">{branch}</span>}
          {!expanded && group.needs > 0 && (
            <span className="sb-badge" role="img" aria-label={`${group.needs} ${group.needs === 1 ? "needs" : "need"} you`}>
              {group.needs}
              <span className="sb-badge-dot" aria-hidden />
            </span>
          )}
        </button>
        <span className="sb-actions" data-no-drag>
          <button className="icon" aria-label={`New chat in ${group.label}`} title="New chat here" onClick={() => h.onNewChatIn(group.folder)}>
            <PlusIcon />
          </button>
          <button className="icon" aria-label={`More for ${group.label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ⋯
          </button>
        </span>
        {menu && <ProjectMenu group={group} h={h} moves={reorder.moves} finished={finished} onClose={() => setMenu(false)} onClosed={(n) => onNotice(n === 0 ? "No finished chats to close" : `Closed ${n} finished ${n === 1 ? "chat" : "chats"}`)} />}
      </div>
      {moved && <MovedNotice moved={moved} label={group.label} onRelocate={onRelocate} onDismiss={onDismissMoved} />}
      {notice && (
        <div className="sb-note" role="status">
          {notice}
        </div>
      )}
      {expanded && (
        <ul className="sb-group">
          {group.items.map((item) => (
            <Item key={item.slot} item={item} project={group.label} h={h} closer={closer} agentsOpen={agentsOpen} onAgents={onAgents} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** What the user agrees to lose by saying yes: the numbers they were shown. */
const agreeing = (c: CloseCheck): CloseAgreed => ({ uncommitted: c.uncommitted, unmerged_commits: c.unmerged_commits });

/** Two checks' worth of what closing would lose, added up: what closing a team asks about. */
const lostIn = (checks: CloseCheck[]) => lostText({ worktree: true, branch: null, uncommitted: checks.reduce((n, c) => n + c.uncommitted, 0), unmerged_commits: checks.reduce((n, c) => n + c.unmerged_commits, 0) });

/**
 * The left sidebar. Collapsed, it is a slim column with a square for each open chat and team (not for projects), the
 * chat's initials on it and a mark for how it is: a ring while it works, an amber dot when it needs you, a blue dot when
 * it finished unread. Each project has a colour of its own, kept across restarts: its squares are tinted with it, and the one
 * on screen is filled with it and has a bar beside it. A team is one square, for its Lead, with the team's combined state.
 *
 * Open (pinned beside the chat, or over it), the same pane lists the open chats and teams under a header for each project
 * (agents nested under their team, a chat that needs you at the top) and nothing else: past chats are in History, which the
 * button under New opens. Chats close from the pane: a × on a row, "Close chat" in the menu of a right click, and "Close
 * finished chats" in a project's ⋯.
 *
 * Resting the pointer on the collapsed column (or moving focus into it) opens it over the chat to the pinned width: the
 * squares stay where they are, and the titles and statuses come in beside them. It closes when the pointer leaves, focus
 * goes, Escape is pressed, or something is picked.
 */
export function Sidebar(props: Props) {
  const { mode, onToggle, width, onWidth, open, currentFolder, branch, canNew, loadRecent, hidden, moved, onRelocate, onDismissMoved, memory, order = [], onOrder, colors: savedColors, onColors, ...handlers } = props;
  const [recent, setRecent] = useState<RecentFolder[]>(() => memory?.recent ?? []);
  if (memory) memory.recent = recent;
  // A project the user folded by hand: the others show their chats.
  const [by, setBy] = usePersistentState<Record<string, boolean>>("sidebar.expanded", {});
  // The teams whose agents are listed: folded unless opened here, for as long as the app runs.
  const [agentsOpen, setAgentsOpen] = useState<Record<string, boolean>>({});
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  // Collapsed, it opens over the chat after the pointer rests on it, or while focus is in it; then it takes a moment to close.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [closingBar, setClosingBar] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const floating = mode === "collapsed" && (hovered || focused);
  const expanded = mode !== "collapsed" || floating;
  // Closing, the pane stays drawn while its width shrinks, then the bar takes its place.
  const full = expanded || closingBar;
  const wasFloating = useRef(false);
  wasFloating.current = floating;

  const openKey = Object.keys(open).sort().join("\n");
  useEffect(() => {
    loadRecent().then(setRecent, () => setRecent([]));
  }, [openKey]);

  const groups = useMemo(() => compactGroups(open, recent, order), [open, recent, order]);
  // The projects with something open get their colours first, in the order the collapsed bar lists them, then the others the
  // sidebar knows, so the colours don't depend on which are open.
  const colors = assignColors([...groups.map((g) => g.folder), ...recent.filter((r) => !hidden.includes(r.path)).map((r) => r.path)], assignColors(groups.map((g) => g.folder), savedColors));
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
  const listed = groups.map((g) => g.folder);
  const moveTo = (folder: string, index: number) => onOrder?.(moveProject(ordered, listed, folder, index));
  const list = useRef<HTMLElement>(null);
  const reorder = useReorder(listed, list, moveTo);
  const movesOf = (folder: string, i: number): Moves => ({
    up: onOrder && i > 0 ? () => moveTo(folder, i - 1) : null,
    down: onOrder && i < listed.length - 1 ? () => moveTo(folder, i + 1) : null,
  });
  const isExpanded = (g: CompactGroup) => by[g.folder] ?? true;

  const movedFor = (folder: string) => moved.find((m) => m.old === folder) ?? null;
  // Starting something in a project shows it there, even in one that was folded up.
  const opening = (run: (folder: string) => void) => (folder: string) => {
    setBy({ ...by, [folder]: true });
    run(folder);
  };
  const toggle = (g: CompactGroup) => setBy({ ...by, [g.folder]: !isExpanded(g) });

  // Closing a chat: asked about first when it works, or leads a team, or has work that would be lost; the question is
  // inline under its row (the bar has no room, so there it opens where the user pressed). A menu is "Close chat".
  const [closing, setClosing] = useState<Closing | null>(null);
  const [menu, setMenu] = useState<{ target: CloseTarget; at: At } | null>(null);
  const [notice, setNotice] = useState<{ folder: string; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (folder: string, text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ folder, text });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };
  const ask = (target: CloseTarget, at: At) => {
    setMenu(null);
    const question = (text: string, yes: string, agreed: Record<string, CloseAgreed> = {}) => setClosing({ target, at, question: text, yes, agreed, error: null, busy: false });
    const failed = (e: unknown) => setClosing({ target, at, question: "", yes: "Try again", agreed: {}, error: e instanceof Error ? e.message : String(e), busy: false });
    if (target.kind === "chat") {
      if (target.state === "running" || target.state === "waiting") question("Stop and close?", "Stop and close");
      else handlers.onCloseChats([target.slot]);
    } else if (target.kind === "agent") {
      // The canvas's own flow: nothing to lose closes it, otherwise it says what would be thrown away and waits.
      handlers.closeCheck(target.slot).then(
        (check) => (lostText(check) ? question(`It has ${lostText(check)}. Closing it deletes its worktree, so that work is gone for good.`, "Discard work and close", { [target.slot]: agreeing(check) }) : handlers.closeWorker(target.slot).catch(failed)),
        failed,
      );
    } else {
      const n = target.agents.length;
      Promise.all(target.agents.map((a) => handlers.closeCheck(a).then((c) => [a, c] as const))).then((checks) => {
        const lost = lostIn(checks.map(([, c]) => c));
        const who = n === 0 ? "Close the team?" : `Close the team and its ${n} ${n === 1 ? "agent" : "agents"}?`;
        question(lost ? `${who} ${lost[0].toUpperCase()}${lost.slice(1)} would be lost.` : who, n === 0 ? "Close team" : "Close team and agents", Object.fromEntries(checks.map(([a, c]) => [a, agreeing(c)])));
      }, failed);
    }
  };
  const confirm = () => {
    const c = closing;
    if (!c) return;
    setClosing({ ...c, busy: true, error: null });
    const { target } = c;
    const done = () => setClosing(null);
    const failed = (e: unknown) => setClosing({ ...c, busy: false, error: e instanceof Error ? e.message : String(e), yes: "Try again" });
    if (target.kind === "chat") {
      handlers.onCloseChats([target.slot]);
      done();
    } else if (target.kind === "agent") {
      handlers.closeWorker(target.slot, c.agreed[target.slot]).then(done, failed);
    } else {
      // The agents first, one at a time (each tells the Lead it is gone), then the Lead.
      target.agents
        .reduce((p, a) => p.then(() => handlers.closeWorker(a, c.agreed[a])), Promise.resolve())
        .then(() => {
          handlers.onCloseChats([target.slot]);
          done();
        }, failed);
    }
  };
  const closer: Closer = { closing, ask, menu: (target, at) => setMenu({ target, at }), confirm, cancel: () => setClosing(null) };
  const menuRoot = useRef<HTMLDivElement>(null);
  useDismiss(menu !== null, menuRoot, () => setMenu(null));
  // While a question or a menu is open the bar stays open under it, and shuts when it is done if the pointer went elsewhere.
  const hold = closing !== null || menu !== null;
  const inside = useRef(false);

  useEffect(
    () => () => {
      if (rest.current) clearTimeout(rest.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  const stopClosing = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosingBar(false);
  };
  const enter = (e: { buttons: number }) => {
    inside.current = true;
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
      setClosingBar(true);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(stopClosing, CLOSE_MS);
    }
  };
  const leave = () => {
    inside.current = false;
    // Not while a project is being dragged or a question is open: the pointer may leave the bar and they go on.
    if (!reorder.drag && !hold) dismiss();
  };
  useEffect(() => {
    if (!hold && mode === "collapsed" && !inside.current && wasFloating.current) dismiss();
  }, [hold]);
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };
  // Esc closes it, wherever focus is.
  useEffect(() => {
    if (!floating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hold) return;
      dismiss();
      (document.activeElement as HTMLElement | null)?.blur?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [floating, hold]);
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
  const history = (
    <button className={`icon sb-button${full ? " labelled" : ""}`} data-history-toggle aria-label="History" title="History" onClick={h.onHistory}>
      <ClockIcon />
      {full && <span aria-hidden>History</span>}
    </button>
  );

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
          {history}
        </div>
        <nav className="sb-list" aria-label={label} ref={list} onClickCapture={reorder.onClickCapture}>
          {full ? (
            <>
              {groups.map((g, i) => (
                <Project
                  key={g.folder}
                  group={g}
                  color={PROJECT_COLORS[colors[g.folder]]}
                  expanded={isExpanded(g)}
                  onToggle={() => toggle(g)}
                  current={g.folder === currentFolder}
                  branch={branch}
                  moved={movedFor(g.folder)}
                  onRelocate={onRelocate}
                  onDismissMoved={onDismissMoved}
                  h={{ ...h, onNewChatIn: opening(h.onNewChatIn), onNewTeamIn: opening(h.onNewTeamIn) }}
                  closer={closer}
                  reorder={{ handle: onOrder ? reorder.handle(g.folder) : {}, style: reorder.styleFor(g.folder), lifted: reorder.lifted === g.folder, moves: movesOf(g.folder, i) }}
                  notice={notice?.folder === g.folder ? notice.text : null}
                  onNotice={(text) => say(g.folder, text)}
                  agentsOpen={agentsOpen}
                  onAgents={(slot, open) => setAgentsOpen((was) => ({ ...was, [slot]: open }))}
                />
              ))}
              {groups.length === 0 && <div className="sb-note">Nothing open. Start a chat with New, or find an old one in History.</div>}
            </>
          ) : (
            groups.map((group) => (
              <Fragment key={group.folder}>
                <div className="sb-project" title={group.label} aria-hidden style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
                  <span className="sb-project-initials">{group.initials}</span>
                  <span className="sb-project-name">{group.label}</span>
                </div>
                <ul className="sb-group" aria-label={group.label} style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
                  {group.items.map((item) => (
                    <ChatRow key={item.slot} chip={chipOf(item)} project={group.label} full={false} target={itemTarget(item)} closer={closer} onClick={() => (item.kind === "team" ? h.onTeam(item.slot) : h.onChat(item.slot))} />
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
      {menu && (
        <div className="menu sb-context" role="menu" aria-label="Chat" ref={menuRoot} style={{ left: menu.at.x, top: menu.at.y }} onKeyDown={menuKeys}>
            <button role="menuitem" className="menu-row" autoFocus onClick={() => ask(menu.target, menu.at)}>
              <span className="menu-row-title">{menu.target.kind === "team" ? "Close team" : menu.target.kind === "agent" ? "Close agent" : "Close chat"}</span>
            </button>
          </div>
        )}
      {!full && closing && <CloseConfirm closing={closing} closer={closer} floating />}
      {mode === "pinned" && <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={shownWidth} tabIndex={0} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onResizeKey} />}
    </aside>
  );
}
