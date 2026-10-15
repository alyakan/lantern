import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import type { RecentFolder } from "../types";
import { PROJECT_COLORS, assignColors } from "../lib/projectColors";
import { compactGroups, markOf, type CompactChip, type CompactGroup, type ProjectOpen } from "../lib/sidebar";
import { PlusIcon, SidebarIcon, TeamIcon } from "./icons";
import { orderProjects } from "../lib/projectOrder";

interface Props {
  /** What is open, by project (see openProjects). */
  open: Record<string, ProjectOpen>;
  /** The recent folders, for the order the full sidebar lists the projects in. */
  loadRecent: () => Promise<RecentFolder[]>;
  /** A new chat can start (a project is open, and its chat isn't starting). */
  canNew: boolean;
  onNewChat: () => void;
  /** A chat's square, and a team's (its canvas). */
  onChat: (slot: string) => void;
  onTeam: (slot: string) => void;
  /** Each project's colour, an index into PROJECT_COLORS by folder (saved by the app, see assignColors). */
  colors: Record<string, number>;
  /** The colours with a project new to them given one, to save. */
  onColors: (colors: Record<string, number>) => void;
  /** The user's order of the projects, as the full sidebar lists them (see orderProjects), and saving it when a project
   * new to it opens here. */
  order?: string[];
  onOrder?: (order: string[]) => void;
  /** Its button at the top: back to the full sidebar. */
  onToggle: () => void;
  /** How wide it opens when the pointer rests on it: the full sidebar's width. */
  width: number;
}

/** Focus that came from the keyboard (a click focuses a button too, and that shouldn't open the column). */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** How long the pointer rests on the column before it opens, so passing over it on the way to the chat doesn't. */
export const OPEN_AFTER_MS = 220;

/** What a square's row says to VoiceOver (and shows, once the column opens): the title, the project and the status. */
const describe = (chip: CompactChip, group: CompactGroup) => `${chip.team ? "Team: " : ""}${chip.title}, ${group.label}, ${chip.status}`;

/** A chat's row: its square, and beside it (shown once the column opens) its title and how it is. */
function Chip({ chip, group, onClick }: { chip: CompactChip; group: CompactGroup; onClick: () => void }) {
  const mark = markOf(chip);
  return (
    <li>
      <button className={`cp-row${chip.active ? " current" : ""}`} aria-label={describe(chip, group)} aria-current={chip.active ? "true" : undefined} onClick={onClick}>
        <span className={`cp-chip${chip.active ? " current" : ""}${chip.team ? " team" : ""}`} aria-hidden>
          <span className="cp-initials">{chip.initials}</span>
          {chip.team && (
            <span className="cp-team">
              <TeamIcon />
            </span>
          )}
          {mark === "running" && <span className="cp-mark running" />}
          {mark === "waiting" && <span className="cp-mark waiting" />}
          {mark === "unread" && <span className="cp-mark unread" />}
        </span>
        <span className="cp-text" aria-hidden>
          <span className="cp-title">{chip.team ? `Team: ${chip.title}` : chip.title}</span>
          <span className={`cp-status ${mark}`}>{chip.status}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The compact sidebar: a slim column with a square for each open chat and team (not for projects), the chat's initials
 * on it and a mark for how it is: a ring while it works, an amber dot when it needs you, a blue dot when it finished
 * unread. Each project has a colour of its own, kept across restarts: its squares are tinted with it, and the one on screen
 * is filled with it and has a bar beside it. Each project's squares sit under its initials; + starts a chat. A team is one
 * square, for its Lead, with the team's combined state. The column scrolls when there are more squares than fit.
 *
 * Resting the pointer on it (or moving focus into it) opens it over the chat to the full sidebar's width: the squares stay
 * where they are, and each one's title and status, and each project's name, show beside them. It closes when the pointer
 * leaves, focus goes, or a chat is picked.
 */
export function SidebarCompact({ open, loadRecent, canNew, onNewChat, onChat, onTeam, colors: savedColors, onColors, order, onOrder, onToggle, width }: Props) {
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  // Open over the chat: after the pointer rests on it, or while focus is in it.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expanded = hovered || focused;
  const openKey = Object.keys(open).sort().join("\n");
  useEffect(() => {
    loadRecent().then(setRecent, () => setRecent([]));
  }, [openKey]);
  const groups = useMemo(() => compactGroups(open, recent, order), [open, recent, order]);
  const colors = assignColors(groups.map((g) => g.folder), savedColors);
  // A project opened while the sidebar is compact is saved at the top, where it shows, so it stays there. Only once there
  // is an order: the first one is made by the full sidebar, from every recent project, not just the open ones.
  const ordered = order && order.length > 0 ? orderProjects(groups.map((g) => g.folder), order).order : order;
  useEffect(() => {
    if (onOrder && ordered && ordered !== order) onOrder(ordered);
  }, [ordered, order]);
  useEffect(() => {
    if (colors !== savedColors) onColors(colors);
  }, [colors, savedColors]);

  useEffect(() => () => {
    if (rest.current) clearTimeout(rest.current);
  }, []);
  const enter = (e: { buttons: number }) => {
    // Not while dragging something across it.
    if (e.buttons || rest.current) return;
    rest.current = setTimeout(() => {
      rest.current = null;
      setHovered(true);
    }, OPEN_AFTER_MS);
  };
  const leave = () => {
    if (rest.current) clearTimeout(rest.current);
    rest.current = null;
    setHovered(false);
  };
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };
  // Esc closes it, wherever focus is.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      leave();
      setFocused(false);
      (document.activeElement as HTMLElement | null)?.blur?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);
  // Picking a chat closes it: you're going there.
  const pick = (run: () => void) => () => {
    leave();
    setFocused(false);
    (document.activeElement as HTMLElement | null)?.blur?.();
    run();
  };

  return (
    <aside className="sidebar-compact" aria-label="Open chats">
      <div
        className={`cp-panel${expanded ? " expanded" : ""}`}
        style={{ "--cp-open": `${width}px` } as CSSProperties}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={(e) => keyboardFocus(e.target) && setFocused(true)}
        onBlur={onBlur}
      >
      <div className="cp-head">
        <button className="icon cp-button" aria-label="Full sidebar" title="Full sidebar" onClick={onToggle}>
          <SidebarIcon />
        </button>
        <button className="icon cp-button" aria-label="New chat" title="New chat" disabled={!canNew} onClick={onNewChat}>
          <PlusIcon />
        </button>
      </div>
      <nav className="cp-list" aria-label="Open chats">
        {groups.map((group) => (
          <Fragment key={group.folder}>
            <div className="cp-project" title={group.label} aria-hidden style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
              <span className="cp-project-initials">{group.initials}</span>
              <span className="cp-project-name">{group.label}</span>
            </div>
            <ul className="cp-group" aria-label={group.label} style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
              {group.chips.map((chip) => (
                <Chip key={chip.slot} chip={chip} group={group} onClick={pick(() => (chip.team ? onTeam(chip.slot) : onChat(chip.slot)))} />
              ))}
            </ul>
          </Fragment>
        ))}
      </nav>
      </div>
    </aside>
  );
}
