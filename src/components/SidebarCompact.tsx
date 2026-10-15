import { Fragment, useEffect, useMemo, useState, type CSSProperties, type FocusEvent, type MouseEvent, type PointerEventHandler } from "react";
import type { RecentFolder } from "../types";
import { PROJECT_COLORS, assignColors } from "../lib/projectColors";
import { compactGroups, markOf, type CompactChip, type CompactGroup, type ProjectOpen } from "../lib/sidebar";
import { PlusIcon, SidebarIcon, TeamIcon } from "./icons";

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
  /** Its button at the top: back to the full sidebar. */
  onToggle: () => void;
  /** The pointer resting on the column opens the full sidebar over the chat (see usePeek). */
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
}

/** The wording of a square's tooltip and label. */
const describe = (chip: CompactChip, group: CompactGroup) => `${chip.team ? "Team: " : ""}${chip.title}, ${group.label}, ${chip.status}`;

/** Hovering or focusing a square names it; it floats beside the column, since the column scrolls. */
interface Tip {
  top: number;
  left: number;
  chip: CompactChip;
  group: CompactGroup;
}

function Chip({ chip, group, onClick, onTip }: { chip: CompactChip; group: CompactGroup; onClick: () => void; onTip: (tip: Tip | null, target?: HTMLElement) => void }) {
  const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => onTip({ top: 0, left: 0, chip, group }, e.currentTarget);
  const mark = markOf(chip);
  return (
    <li>
      <button className={`cp-chip${chip.active ? " current" : ""}${chip.team ? " team" : ""}`} aria-label={describe(chip, group)} aria-current={chip.active ? "true" : undefined} onClick={onClick} onMouseEnter={show} onFocus={show} onMouseLeave={() => onTip(null)} onBlur={() => onTip(null)}>
        <span className="cp-initials" aria-hidden>
          {chip.initials}
        </span>
        {chip.team && (
          <span className="cp-team" aria-hidden>
            <TeamIcon />
          </span>
        )}
        {mark === "running" && <span className="cp-mark running" aria-hidden />}
        {mark === "waiting" && <span className="cp-mark waiting" aria-hidden />}
        {mark === "unread" && <span className="cp-mark unread" aria-hidden />}
      </button>
    </li>
  );
}

/**
 * The compact sidebar: a slim column with a square for each open chat and team (not for projects), the chat's initials
 * on it and a mark for how it is: a ring while it works, an amber dot when it needs you, a blue dot when it finished
 * unread. Each project has a colour of its own, kept across restarts: its squares are tinted with it, and the one on screen
 * is filled with it and has a bar beside it. Each project's squares sit under its initials (its name is the tooltip);
 * + starts a chat. A team is one square, for its Lead, with the team's combined state. The column scrolls when there are
 * more squares than fit.
 */
export function SidebarCompact({ open, loadRecent, canNew, onNewChat, onChat, onTeam, colors: savedColors, onColors, onToggle, onPointerEnter, onPointerLeave }: Props) {
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [tip, setTip] = useState<Tip | null>(null);
  const openKey = Object.keys(open).sort().join("\n");
  useEffect(() => {
    loadRecent().then(setRecent, () => setRecent([]));
  }, [openKey]);
  const groups = useMemo(() => compactGroups(open, recent), [open, recent]);
  const colors = assignColors(groups.map((g) => g.folder), savedColors);
  useEffect(() => {
    if (colors !== savedColors) onColors(colors);
  }, [colors, savedColors]);

  const showTip = (next: Tip | null, target?: HTMLElement) => {
    if (!next || !target) return setTip(null);
    const r = target.getBoundingClientRect();
    setTip({ ...next, top: r.top + r.height / 2, left: r.right + 8 });
  };

  return (
    <aside className="sidebar-compact" aria-label="Open chats" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div className="cp-head">
        <button className="icon cp-button" aria-label="Full sidebar" title="Full sidebar" onClick={onToggle}>
          <SidebarIcon />
        </button>
        <button className="icon cp-button" aria-label="New chat" title="New chat" disabled={!canNew} onClick={onNewChat}>
          <PlusIcon />
        </button>
      </div>
      <nav className="cp-list" aria-label="Open chats" onScroll={() => setTip(null)}>
        {groups.map((group) => (
          <Fragment key={group.folder}>
            <div className="cp-project" title={group.label} aria-hidden style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
              <span>{group.initials}</span>
            </div>
            <ul className="cp-group" aria-label={group.label} style={{ "--pc": PROJECT_COLORS[colors[group.folder]] } as CSSProperties}>
              {group.chips.map((chip) => (
                <Chip key={chip.slot} chip={chip} group={group} onClick={() => (chip.team ? onTeam(chip.slot) : onChat(chip.slot))} onTip={showTip} />
              ))}
            </ul>
          </Fragment>
        ))}
      </nav>
      {tip && (
        <div className="cp-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          <div className="cp-tip-title">{tip.chip.team ? `Team: ${tip.chip.title}` : tip.chip.title}</div>
          <div className="cp-tip-meta">
            {tip.group.label} · <span className={`cp-tip-status ${markOf(tip.chip)}`}>{tip.chip.status}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
