import { PlanMeter } from "./PlanMeter";
import type { UsageRow } from "../lib/usage";
import { useEffect, useRef, useState } from "react";
import type { BackgroundTask, Status } from "../store";
import { elapsed } from "../lib/time";
import { basename } from "../lib/diff";
import { ACTIONS, shortcutLabel, useAction } from "../lib/actions";
import { FolderMenu } from "./FolderPill";
import { Inbox, type InboxProps } from "./Inbox";
import { useMenuKeys } from "./useMenuKeys";
import type { ActivityStatus } from "../lib/status";
import { BranchIcon, CanvasIcon, FailIcon, FolderIcon, GearIcon, PaneIcon, SidebarIcon } from "./icons";

interface Props {
  folder: string | null;
  status: Status;
  changeCount: number;
  reviewCollapsed: boolean;
  onOpenFolder: () => void;
  /** Shows and hides the side panel; none until a folder is open (there is no panel before then). */
  onToggleReview?: () => void;
  /** Opens Settings (MCP servers, skills). */
  onOpenSettings?: () => void;
  /** MCP servers that are down or need a login ("sentry needs you to log in"): the Settings button wears a warning dot. */
  mcpIssues?: string[];
  branch?: string | null;
  /** What the activity viewer says on its right. */
  activity?: ActivityStatus;
  /** A count beside the status, like Xcode's errors: failed steps in the latest turn. */
  issues?: { failed: number };
  /** What this chat's claude still runs in the background (commands, agents); a count beside the status lists them. */
  background?: BackgroundTask[];
  /** Stops one of them; it leaves the list when claude says it's gone. */
  onStopTask?: (id: string) => Promise<void>;
  onShowFailure?: () => void;
  /** Hides the failure count until something else fails. */
  onClearFailures?: () => void;
  /** The folder menu's "Bring old chats here…" (the projects, their recents and moved notices are in the sidebar). */
  onBringOld?: () => void;
  /** Orchestras: a main agent and the workers it runs. `exists`: there is one, so the canvas can be shown. */
  orchestra?: { view: "chat" | "canvas"; exists: boolean; attention: number; onView: (view: "chat" | "canvas") => void };
  /** What the plan meter's popover lists: every open chat and team with what it has used (computed when it opens), and opening one. */
  usage?: { rows: () => UsageRow[]; onOpen: (slot: string) => void };
  /** The sidebar, while it is hidden: a button at the left to show it again, badged with how many chats and agents need you. */
  sidebar?: { needs: number; onShow: () => void };
  /** What waits on you in every project and team (see Inbox): a button at the right with a popover. */
  inbox?: InboxProps;
}

const showSidebarLabel = (needs: number) => (needs > 0 ? `Show sidebar, ${needs} ${needs === 1 ? "chat needs" : "chats need"} you` : "Show sidebar");
const sidebarShortcut = (() => {
  const def = ACTIONS.find((a) => a.id === "toggle-sidebar");
  const label = def && shortcutLabel(def);
  return label ? ` (${label})` : "";
})();

/** How long a stopped task may stay listed before its Stop comes back. */
const STOP_AGAIN_MS = 8000;

/** "local_bash" → "Command", "local_agent" → "Agent". */
function taskKind(type: string): string {
  if (/bash|shell|command/i.test(type)) return "Command";
  if (/agent/i.test(type)) return "Agent";
  if (/monitor|watch/i.test(type)) return "Monitor";
  return "Task";
}

// No native title bar: the traffic lights sit in the left gutter and the bar drags the window. In the centre, like
// Xcode's activity viewer: the folder and branch on the left (it opens the folder menu, like Xcode's scheme), what
// Claude is doing on the right, and a progress bar along its bottom edge while it works. The projects, new chats and
// teams, and past chats are in the sidebar.
export function TopBar({ folder, status, changeCount, reviewCollapsed, onOpenFolder, onToggleReview, onOpenSettings, mcpIssues = [], branch = null, activity, issues, background = [], onStopTask, onShowFailure, onClearFailures, onBringOld, orchestra, usage, sidebar, inbox }: Props) {
  // A working chat keeps running in the background when you switch away, so only a starting one blocks switching.
  const busy = status === "starting";
  const toggleLabel = reviewCollapsed ? "Show side panel" : "Hide side panel";
  // At most one of the title bar's menus is open.
  const [menu, setMenu] = useState<"folders" | "background" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = () => setMenu(null);
  // The button that opened the menu: closing it (Escape, a pick) puts focus back there, not on the page.
  const opener = useRef<HTMLButtonElement | null>(null);
  const folderButton = useRef<HTMLButtonElement>(null);
  // The folder menu's arrow keys; the first button with a menu in the title is the folder one.
  const folderKeys = useMenuKeys(menu === "folders", root);
  useEffect(() => {
    const active = document.activeElement;
    if (!menu && (!active || active === document.body)) opener.current?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (busy) close();
  }, [busy]);
  useEffect(() => {
    if (menu === "background" && background.length === 0) close();
  }, [background.length]);
  // Tasks asked to stop, and why one couldn't be. A task stays "Stopping…" until claude drops it; if it's still listed
  // after a while, Stop comes back so it can be asked again.
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);
  const stopTask = (id: string) => {
    if (!onStopTask) return;
    const settle = () =>
      setStopping((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    setStopError(null);
    setStopping((s) => new Set(s).add(id));
    onStopTask(id).then(() => setTimeout(settle, STOP_AGAIN_MS), (e) => {
      setStopError(`Couldn't stop it: ${String(e)}`);
      settle();
    });
  };
  // The list's "running for" times, kept current while it's open.
  const [, tick] = useState(0);
  useEffect(() => {
    if (menu !== "background") return;
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [menu]);

  useAction(
    "open-folder",
    () => {
      close();
      onOpenFolder();
    },
    !busy,
  );

  // With a folder open its menu has Open folder… and Bring old chats here…; with none, the button opens the dialog.
  const toggleFolders = () => {
    if (!folder) return onOpenFolder();
    if (menu === "folders") return close();
    opener.current = folderButton.current;
    setMenu("folders");
  };

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-side" data-tauri-drag-region>
        {sidebar && (
          <div className="toolbar-group">
            <button className="icon sidebar-toggle" aria-label={showSidebarLabel(sidebar.needs)} title={`Show sidebar${sidebarShortcut}`} onClick={sidebar.onShow}>
              <SidebarIcon />
              {sidebar.needs > 0 && (
                <span className="sidebar-toggle-badge" aria-hidden>
                  {sidebar.needs}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      <div className="title-center" ref={root}>
        <div className={`viewer${activity?.working ? " working" : ""}`}>
          <button ref={folderButton} className={`viewer-scheme${menu === "folders" ? " pressed" : ""}`} aria-haspopup="menu" aria-expanded={menu === "folders"} onClick={toggleFolders} disabled={busy} title={folder ? folder : "Open a folder for Claude to work in (⌘O)"}>
            <FolderIcon />
            <span className="viewer-name">{folder ? basename(folder) : "Open folder…"}</span>
            {folder && branch && (
              <>
                <span className="viewer-crumb" aria-hidden />
                <BranchIcon />
                <span className="viewer-branch">{branch}</span>
              </>
            )}
          </button>
          {background.length > 0 && (
            <button
              className={`viewer-issue background${menu === "background" ? " pressed" : ""}`}
              aria-haspopup="dialog"
              aria-expanded={menu === "background"}
              aria-label={`${background.length} running in the background`}
              title={`Still running in the background:\n${background.map((t) => t.description).join("\n")}`}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setMenu(menu === "background" ? null : "background");
              }}
            >
              <span className="spinner" aria-hidden />
              {background.length}
            </button>
          )}
          {!!issues?.failed && (
            <span className="viewer-issue-group">
              <button className="viewer-issue failed" title={`${issues.failed} step${issues.failed === 1 ? "" : "s"} failed in this turn. Click to show.`} onClick={onShowFailure}>
                <FailIcon />
                {issues.failed}
              </button>
              {onClearFailures && (
                <button className="viewer-issue-clear" aria-label="Clear failures" title="Clear (it comes back if something else fails)" onClick={onClearFailures}>
                  ×
                </button>
              )}
            </span>
          )}
          {activity && (
            <span className="viewer-status" role="status">
              {activity.text}
              {activity.detail && <span className="viewer-detail">{` | ${activity.detail}`}</span>}
            </span>
          )}
          {activity?.working && <span className="viewer-progress" aria-hidden />}
        </div>
        {orchestra?.exists && (
          <div className="toolbar-group">
            <button
              className={`icon canvas-toggle${orchestra.view === "canvas" ? " pressed" : ""}`}
              aria-label={orchestra.attention > 0 ? `Canvas, ${orchestra.attention === 1 ? "1 agent needs" : `${orchestra.attention} agents need`} you` : "Canvas"}
              aria-pressed={orchestra.view === "canvas"}
              title={orchestra.view === "canvas" ? "Back to the chat (⇧⌘C)" : "Show the canvas (⇧⌘C)"}
              onClick={() => orchestra.onView(orchestra.view === "canvas" ? "chat" : "canvas")}
            >
              <CanvasIcon />
              {orchestra.attention > 0 && orchestra.view !== "canvas" && <span className="dot" aria-hidden="true" />}
            </button>
          </div>
        )}
        {menu === "background" && (
          <div className="menu background-menu" role="dialog" aria-label="Background tasks">
            <div className="menu-heading">Running in the background</div>
            <ul className="menu-list">
              {background.map((t) => (
                <li key={t.id} className="background-task">
                  <span className="spinner" aria-hidden />
                  <span className="background-task-kind">{taskKind(t.taskType)}</span>
                  <span className={`background-task-text${t.taskType === "local_bash" ? " mono" : ""}`} title={t.description}>
                    {t.description || t.id}
                  </span>
                  <span className="background-task-time">{elapsed(Date.now() - t.since)}</span>
                  {onStopTask && (
                    <button className="background-task-stop" aria-label={`Stop ${t.description || t.id}`} title="Stop it" disabled={stopping.has(t.id)} onClick={() => stopTask(t.id)}>
                      {stopping.has(t.id) ? "Stopping…" : "Stop"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {stopError && <div className="background-error">{stopError}</div>}
            <div className="background-note">Claude is told when each one ends, and may reply on its own then. Stop in the chat box ends the turn only; these keep running.</div>
          </div>
        )}
        {menu === "folders" && <FolderMenu folder={folder} onBrowse={onOpenFolder} onClose={close} onKeyDown={folderKeys.onKeyDown} relocate={onBringOld ? { moved: [], onRelocate: () => onBringOld(), onDismiss: () => {} } : undefined} />}
      </div>
      <div className="topbar-side end" data-tauri-drag-region>
        <PlanMeter usage={usage} />
        <div className="toolbar-group">
          {inbox && <Inbox {...inbox} />}
          {onOpenSettings && (
            <button
              className="icon settings-button"
              aria-label={mcpIssues.length ? `Settings, ${mcpIssues.join(", ")}` : "Settings"}
              title={mcpIssues.length ? `Settings (⌘,): ${mcpIssues.join(" · ")}` : "Settings (⌘,)"}
              onClick={onOpenSettings}
            >
              <GearIcon />
              {mcpIssues.length > 0 && <span className="dot warn" aria-hidden="true" />}
            </button>
          )}
          {onToggleReview && (
            <button className={`icon pane-toggle${reviewCollapsed ? "" : " active"}`} aria-label={toggleLabel} aria-pressed={!reviewCollapsed} title={`${toggleLabel} (⌘\\)`} onClick={onToggleReview}>
              <PaneIcon />
              {reviewCollapsed && changeCount > 0 && <span className="dot" aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
