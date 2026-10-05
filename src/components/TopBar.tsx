import { useEffect, useRef, useState } from "react";
import type { BackgroundTask, Status } from "../store";
import { elapsed } from "../lib/time";
import type { RecentFolder, SessionSummary } from "../types";
import { basename } from "../lib/diff";
import { useShortcut } from "../lib/shortcuts";
import { FolderMenu } from "./FolderPill";
import { HistoryMenu, type OpenChat } from "./HistoryMenu";
import type { ActivityStatus } from "../lib/status";
import { BranchIcon, ClockIcon, FailIcon, FolderIcon, PaneIcon, PlusIcon, WaitIcon } from "./icons";

interface Props {
  folder: string | null;
  status: Status;
  changeCount: number;
  reviewCollapsed: boolean;
  onOpenFolder: () => void;
  onToggleReview: () => void;
  sessionId?: string | null;
  loadSessions?: () => Promise<SessionSummary[]>;
  onOpenSession?: (id: string) => void;
  onNewSession?: () => void;
  /** With these, the folder pill opens the recent-folders menu instead of the folder dialog. */
  loadRecent?: () => Promise<RecentFolder[]>;
  onPickFolder?: (path: string) => void;
  /** Chats open in the background, and how to switch to one. */
  openChats?: OpenChat[];
  onSwitchChat?: (slot: string) => void;
  /** Closes an open chat that isn't on screen. */
  onCloseChat?: (slot: string) => void;
  branch?: string | null;
  /** What the activity viewer says on its right. */
  activity?: ActivityStatus;
  /** Counts beside the status, like Xcode's warnings and errors: failed steps in the latest turn, and other chats
   * waiting for an answer. */
  issues?: { failed: number; waiting: number };
  /** What this chat's claude still runs in the background (commands, agents); a count beside the status lists them. */
  background?: BackgroundTask[];
  /** Stops one of them; it leaves the list when claude says it's gone. */
  onStopTask?: (id: string) => Promise<void>;
  onShowFailure?: () => void;
  /** Hides the failure count until something else fails. */
  onClearFailures?: () => void;
}

/** "local_bash" → "Command", "local_agent" → "Agent". */
function taskKind(type: string): string {
  if (/bash|shell|command/i.test(type)) return "Command";
  if (/agent/i.test(type)) return "Agent";
  if (/monitor|watch/i.test(type)) return "Monitor";
  return "Task";
}

// No native title bar: the traffic lights sit in the left gutter and the bar drags the window. In the centre, like
// Xcode's activity viewer: the folder and branch on the left (it opens the folder menu, like Xcode's scheme), what
// Claude is doing on the right, and a progress bar along its bottom edge while it works.
export function TopBar({ folder, status, changeCount, reviewCollapsed, onOpenFolder, onToggleReview, sessionId = null, loadSessions, onOpenSession, onNewSession, loadRecent, onPickFolder, openChats = [], onSwitchChat, onCloseChat, branch = null, activity, issues, background = [], onStopTask, onShowFailure, onClearFailures }: Props) {
  // A working chat keeps running in the background when you switch away, so only a starting one blocks switching.
  const busy = status === "starting";
  const backgroundRunning = openChats.some((c) => c.state === "running" || c.state === "waiting" || !!c.background);
  const backgroundUnread = openChats.some((c) => c.unread && c.state === "done");
  const toggleLabel = reviewCollapsed ? "Show changes" : "Hide changes";
  const canUseSessions = !!folder && !busy;
  // At most one of the title bar's menus is open.
  const [menu, setMenu] = useState<"history" | "folders" | "background" | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [recent, setRecent] = useState<RecentFolder[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = () => setMenu(null);

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
    if (busy || (menu === "history" && !canUseSessions)) close();
  }, [busy, canUseSessions]);
  useEffect(() => {
    if (menu === "background" && background.length === 0) close();
  }, [background.length]);
  // Tasks asked to stop (until claude drops them), and why one couldn't be.
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);
  const stopTask = (id: string) => {
    if (!onStopTask) return;
    setStopError(null);
    setStopping((s) => new Set(s).add(id));
    onStopTask(id).catch((e) => {
      setStopError(`Couldn't stop it: ${String(e)}`);
      setStopping((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    });
  };
  // The list's "running for" times, kept current while it's open.
  const [, tick] = useState(0);
  useEffect(() => {
    if (menu !== "background") return;
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [menu]);

  const toggleHistory = () => {
    if (menu === "history") return close();
    setSessions(null);
    setMenu("history");
    loadSessions?.().then(setSessions, () => setSessions([]));
  };

  useShortcut("n", () => onNewSession?.(), canUseSessions && !!onNewSession);
  useShortcut("k", toggleHistory, canUseSessions && !!loadSessions);
  useShortcut("o", () => {
    close();
    onOpenFolder();
  }, !busy);

  const toggleFolders = () => {
    if (!loadRecent || !onPickFolder) return onOpenFolder();
    if (menu === "folders") return close();
    setRecent(null);
    setMenu("folders");
    loadRecent().then(setRecent, () => setRecent([]));
  };

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-side" data-tauri-drag-region />
      <div className="title-center" ref={root}>
        <div className={`viewer${activity?.working ? " working" : ""}`}>
          <button className={`viewer-scheme${menu === "folders" ? " pressed" : ""}`} aria-haspopup="menu" aria-expanded={menu === "folders"} onClick={toggleFolders} disabled={busy} title={folder ? `${folder}\nClick to switch folders (⌘O opens one)` : "Open a folder for Claude to work in (⌘O)"}>
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
              onClick={() => setMenu(menu === "background" ? null : "background")}
            >
              <span className="spinner" aria-hidden />
              {background.length}
            </button>
          )}
          {!!issues?.waiting && (
            <button className="viewer-issue" title={`${issues.waiting} other chat${issues.waiting === 1 ? " is" : "s are"} waiting for you`} disabled={!canUseSessions} onClick={toggleHistory}>
              <WaitIcon />
              {issues.waiting}
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
        <div className="toolbar-group">
          {onNewSession && (
            <button className="icon" aria-label="New session" title="New session (⌘N)" disabled={!canUseSessions} onClick={onNewSession}>
              <PlusIcon />
            </button>
          )}
          {loadSessions && onOpenSession && (
            <button className={`icon${menu === "history" ? " pressed" : ""}`} aria-label="Session history" aria-expanded={menu === "history"} title="Session history (⌘K)" disabled={!canUseSessions} onClick={toggleHistory}>
              <ClockIcon />
              {(backgroundUnread || backgroundRunning) && <span className={`dot${backgroundUnread ? " unread" : ""}`} aria-hidden="true" />}
            </button>
          )}
        </div>
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
        {menu === "history" && onOpenSession && (
          <HistoryMenu
            sessions={sessions}
            currentId={sessionId}
            onClose={close}
            onOpen={(id) => {
              close();
              if (id !== sessionId) onOpenSession(id);
            }}
            open={openChats}
            onSwitch={(slot) => {
              close();
              onSwitchChat?.(slot);
            }}
            onCloseChat={onCloseChat}
          />
        )}
        {menu === "folders" && onPickFolder && <FolderMenu folder={folder} recent={recent} onPick={onPickFolder} onBrowse={onOpenFolder} onClose={close} />}
      </div>
      <div className="topbar-side end" data-tauri-drag-region>
        <div className="toolbar-group">
          <button className={`icon pane-toggle${reviewCollapsed ? "" : " active"}`} aria-label={toggleLabel} aria-pressed={!reviewCollapsed} title={`${toggleLabel} (⌘\\)`} onClick={onToggleReview}>
            <PaneIcon />
            {reviewCollapsed && changeCount > 0 && <span className="dot" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
  );
}
