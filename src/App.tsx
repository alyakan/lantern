import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, type BranchReview, type ChangeScope, type RevertOutcome } from "./api";
import { baseBranchOf, prNumberOf, reviewHints, reviewTargetOf } from "./lib/review";
import { guidesByFlavour, pageNote, withPageNote, type Guides } from "./lib/pageNote";
import { openFind } from "./lib/editorFind";
import { summarizeRequest } from "./lib/network";
import { StepsIntro } from "./components/StepsIntro";
import { windowFocused } from "./lib/windowFocus";
import { initialState, reducer, type Action, type ChangedFile, type ChatItem, type Status } from "./store";
import { SessionActionsContext, exportFileName, sessionMarkdown, type SessionActions } from "./lib/sessionActions";
import { chatsReducer, chatState, chatTitle, firstPrompt, initialChats, isBusy, queuesToSend, wakesToSend } from "./sessions";
import type { Mode, UiEvent } from "./types";
import { batchPerFrame } from "./lib/frameBatch";
import { attentionFor } from "./lib/attention";
import { basename } from "./lib/diff";
import { isTyping } from "./lib/typing";
import { withShellContext } from "./lib/shell";
import { prependDraft } from "./lib/paste";
import { withPrompt } from "./lib/promptHistory";
import { latestTurnOf, sinceLabel, withRevertNote, type RevertRequest } from "./lib/revert";
import { withSkillNote } from "./lib/skillNote";
import { agentTree, usesAgents } from "./lib/agents";
import { agentGraph } from "./lib/agentGraph";
import { BUILT_IN, CUSTOM_HARNESS, DEFAULT_HARNESS, findHarness, presetsOf, settingsOf, type Harness } from "./lib/harness";
import { describeCommands } from "./lib/complete";
import type { McpIssue } from "./components/CompletionMenu";
import type { CloseAgreed, McpServer, MovedFolder, NewRule, NewWorker, RelocationEntry, SkillEntry, UpdateInfo } from "./types";
import { LAST_FOLDER, OPEN_CHATS, migrateFolderState, withMovedNote, type Migrated } from "./lib/relocate";
import { BringOldSessionsDialog } from "./components/BringOldSessionsDialog";
import { stepFile, usePersistentState } from "./lib/layout";
import { NOTIFY_DEFAULTS, NOTIFY_KEY, shouldNotify, type NotifyPrefs } from "./lib/notifyPrefs";
import { applyAppearance, type Appearance, type TextSize } from "./lib/theme";
import { notify } from "./lib/notify";
import { availableActions, runAction, useAction } from "./lib/actions";
import type { PaletteEntry } from "./lib/palette";
import { newVersionToShow, notesFor, rememberNotes, versionsWithNotes } from "./lib/whatsNew";
import { NEW_ISSUE_URL } from "./lib/bugReport";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WhatsNew } from "./components/WhatsNew";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { activityStatus } from "./lib/status";
import { failedCount } from "./lib/activity";
import { scrollWithin } from "./lib/scrollWithin";

import { SlotContext } from "./lib/slot";
import { ModeGuideContext } from "./lib/modeGuide";
import { GUIDE, ModeGuide, type GuideKey } from "./components/ModeGuide";
import { SettingsView, TAB_LABEL, type SettingsTab } from "./components/SettingsView";
import { UpdatingOverlay } from "./components/UpdatingOverlay";
import { isInstalling, useUpdateState } from "./lib/updates";
import { BannerView } from "./components/BannerView";
import { ChatView } from "./components/ChatView";
import { StepsView } from "./components/StepsView";
import { andNext, pageLabel, pagesOf, pageTitle } from "./lib/steps";
import { architectureMap, coversOf } from "./lib/architecture";
import { ArchitecturePane } from "./lib/architecturePane";
import { summarize } from "./lib/stepsSummary";
import { flavourOf, savedMode, withFlavourNote, type Flavour } from "./lib/flavour";
import { FileLinksProvider } from "./lib/fileLinks";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Hud, type HudEvent } from "./components/Hud";
import type { OpenChat } from "./components/HistoryMenu";
import { MessageInput } from "./components/MessageInput";
import { describeInput } from "./components/PermissionCard";
import { ReviewPanel } from "./components/ReviewPanel";
import { SetupScreen } from "./components/SetupScreen";
import { RestoreCard } from "./components/RestoreCard";
import { chatsToSave, currentFolder, loadSaved, save, screenFirst, sessionModesToSave, toCurrentFolders, withOffered, type SavedChat } from "./lib/restore";
import { SplitPane } from "./components/SplitPane";
import { TopBar } from "./components/TopBar";
import { Canvas, newLayout } from "./components/Canvas";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "./lib/canvasContext";
import { needingYou, orchestraNodes, teamMain, teamNodes } from "./lib/orchestraView";
import "./styles.css";

/** How many `name` steps have finished, subagents' included. */
/** Commands the user ran from the chat box that have ended. */
const shellsDone = (items: ChatItem[]) => items.filter((it) => it.type === "shell" && it.status !== "running").length;

function countFinished(items: ChatItem[], name: string): number {
  return items.reduce((n, it) => (it.type === "tool" ? n + (it.name === name && it.status !== "running" ? 1 : 0) + countFinished(it.children, name) : n), 0);
}

/** What an empty Step-by-step chat's box asks, for the flavour picked (or none yet). */
const HERO_PLACEHOLDER: Record<Flavour | "none", string> = {
  none: "What are you working on? Claude suggests how to go about it",
  build: "What should we build, step by step?",
  learn: "What do you want to learn, and what for?",
  review: "Which change? e.g. Review PR 128, or Review my branch",
  debug: "What's going wrong, and when?",
  architecture: "What should be mapped? A feature to design, a fix, or e.g. PR 128",
};

/** The chat whose merge cards include `worker`'s: its main agent's, even if the worker's own chat has been closed. */
function mergeOwner(chats: { slots: Record<string, { proposals: { worker: string }[] }> }, worker: string): string | undefined {
  return Object.keys(chats.slots).find((slot) => chats.slots[slot].proposals.some((p) => p.worker === worker));
}

/** An orchestra's main agent starts on the mode the user chose for it. */
interface OrchestraStart {
  mode: Mode;
}

/**
 * What a restored chat was in an orchestra. A worker is reopened under its main agent once that has finished opening
 * (`parentReady`), so the backend knows the main agent by the time it adopts the worker.
 */
type TeamRole =
  | { role: "main" }
  | { role: "worker"; parent: string; name: string; branch: string | null; base: string | null; isolation: "worktree" | "shared"; hidden?: boolean; parentReady?: Promise<boolean> };

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

// A stable empty list, so a chat with no skills loaded yet doesn't hand the composer a new one each render.
const NO_SKILLS: SkillEntry[] = [];

export default function App() {
  // Remembered across launches: the permission mode and the last project opened.
  // Each project remembers its own mode (a project in Step by step stays there; another stays a chat).
  // Saved as strings: older ones can name modes that are gone (see savedMode).
  const [modes, setModes] = usePersistentState<Record<string, string>>("settings.modeByFolder", {});
  const modeFor = (folder: string): Mode => savedMode(modes[folder]).mode;
  // Each session's own mode, so reopening one from History brings back the mode it was in, not the folder's latest.
  const [sessionModes, setSessionModes] = usePersistentState<Record<string, string>>("settings.modeBySession", {});
  // Step by step's auto-approve, per project too.
  const [autoBy, setAutoBy] = usePersistentState<Record<string, boolean>>("settings.autoApproveByFolder", {});
  // How each project's orchestras run, once the user has chosen (see newOrchestra).
  const [orchestraModes, setOrchestraModes] = usePersistentState<Record<string, "auto" | "ask">>("settings.orchestraModeByFolder", {});
  const autoFor = (folder: string | null) => (folder ? (autoBy[folder] ?? false) : false);
  const [lastFolder, setLastFolder] = usePersistentState<string | null>("settings.lastFolder", null);
  // The folders recorded as moved (null until read): a chat saved in the old place reopens in the new one.
  const [moves, setMoves] = useState<RelocationEntry[] | null>(null);
  const refreshMoves = () => api.relocationsList().then(setMoves, () => setMoves((m) => m ?? []));
  useEffect(() => {
    refreshMoves();
  }, []);
  const here = (folder: string) => currentFolder(folder, moves ?? []);
  // Each folder's sent prompts, for ↑ in the box (see MessageInput). Kept per folder, newest last.
  const [promptsBy, setPromptsBy] = usePersistentState<Record<string, string[]>>("settings.promptHistory", {});
  const [model, setModel] = usePersistentState<string | null>("settings.model", null);
  // Thinking effort (--effort); null = Claude Code's default. App-wide, like the model.
  const [effort, setEffort] = usePersistentState<string | null>("settings.effort", null);
  const [defaultModel, setDefaultModel] = usePersistentState<string | null>("settings.defaultModel", null);
  const [modelIds, setModelIds] = usePersistentState<Record<string, string>>("settings.modelIds", {});
  // Each model's context window as last reported, so the meter can show a percentage before a turn reports one.
  const [windows, setWindows] = usePersistentState<Record<string, number>>("settings.contextWindows", {});
  // Harness presets (which models do what), the one each folder starts with, and each session's, like modes.
  const [savedPresets, setSavedPresets] = usePersistentState<Harness[]>("settings.harnessPresets", BUILT_IN.slice(1));
  const presets = presetsOf(savedPresets);
  const [harnessByFolder, setHarnessByFolder] = usePersistentState<Record<string, string>>("settings.harnessByFolder", {});
  const [harnessBySession, setHarnessBySession] = usePersistentState<Record<string, string>>("settings.harnessBySession", {});
  // General: which events are told about (and paused), the theme and the text size.
  const [notifyPrefs, setNotifyPrefs] = usePersistentState<NotifyPrefs>(NOTIFY_KEY, NOTIFY_DEFAULTS);
  const [appearance, setAppearance] = usePersistentState<Appearance>("settings.appearance", "system");
  const [textSize, setTextSize] = usePersistentState<TextSize>("settings.textSize", "default");
  useEffect(() => applyAppearance(appearance, textSize), [appearance, textSize]);
  // Each open chat's preset.
  const [harnessBySlot, setHarnessBySlot] = useState<Record<string, string>>({});
  // Every open chat. The one on screen is `active`; the others keep running in the background.
  const [chats, dispatchChats] = useReducer(chatsReducer, undefined, () => initialChats({ ...initialState, mode: lastFolder ? modeFor(lastFolder) : "ask" }));
  const active = chats.active;
  const state = chats.slots[active];
  // An orchestra shows as a canvas of its agents or as one chat at a time. The canvas's layout is kept here, so going to a
  // chat and back finds the agents where they were; its chats are handed to it through a store, so each agent redraws only
  // for its own chat.
  const [view, setView] = useState<"chat" | "canvas">("chat");
  const canvasLayout = useRef(newLayout());
  const [chatStore] = useState(createChatStore);
  chatStore.assign(chats.slots);
  useLayoutEffect(() => chatStore.notify(), [chats.slots, chatStore]);
  const reopened = useRef(false);
  const slotSeq = useRef(1);
  // Each chat's unsent text, so switching away and back doesn't lose it. A ref: typing needn't re-render the app.
  const drafts = useRef<Record<string, string>>({});
  // How to start a chat again when its start failed: claude never got far enough to be restarted (see the banner).
  const relaunch = useRef<Record<string, () => void>>({});
  // Counts each chat's starts, so one that was cancelled can tell its late answer is stale.
  const startGen = useRef<Record<string, number>>({});
  // Whether the right pane is hidden, per project like the mode. The old app-wide setting is the default.
  const [collapsedDefault, setCollapsedDefault] = usePersistentState("review.collapsed", false);
  const [collapsedBy, setCollapsedBy] = usePersistentState<Record<string, boolean>>("review.collapsedByFolder", {});
  const reviewCollapsed = (state.folder ? collapsedBy[state.folder] : undefined) ?? collapsedDefault;
  const setReviewCollapsed = (collapsed: boolean) => (state.folder ? setCollapsedBy({ ...collapsedBy, [state.folder]: collapsed }) : setCollapsedDefault(collapsed));
  const [splitRatio, setSplitRatio] = usePersistentState("review.ratio", 0.5);
  // The Changes pane's filter: everything this chat changed, or only what the last turn changed.
  const [changeScope, setChangeScope] = usePersistentState<ChangeScope>("review.scope", "session");
  const [turnFiles, setTurnFiles] = useState<ChangedFile[]>([]);
  // Step-by-step mode shows the conversation as pages; the page on screen picks the turn whose changes the Changes pane
  // shows.
  const [pageRange, setPageRange] = useState<{ from: number; to: number } | null>(null);
  // A file mentioned in Claude's text: in Changes if this chat changed it, otherwise the Files preview at the line.
  const [openRequest, setOpenRequest] = useState<{ path: string; line: number | null; key: number } | null>(null);
  const openMention = (path: string, line: number | null) => {
    setReviewCollapsed(false);
    setOpenRequest({ path, line, key: Date.now() });
  };

  // ⌘P and ⌘⇧F: the Files tab's search, for file names or text, with the right pane shown.
  const [searchKey, setSearchKey] = useState<{ mode: "files" | "text"; key: number } | null>(null);
  const openSearch = (mode: "files" | "text") => {
    setReviewCollapsed(false);
    setSearchKey({ mode, key: Date.now() });
  };
  useAction("find-file", () => openSearch("files"), !!state.folder);
  useAction("search-files", () => openSearch("text"), !!state.folder);
  // ⌘F: find in the file the right pane shows (Monaco's find bar), from anywhere in the window.
  useAction("find-in-file", () => void openFind(), !reviewCollapsed);
  // Per chat: which failed steps the title bar's count was cleared for.
  const [clearedFailures, setClearedFailures] = useState<Record<string, string>>({});
  // A test run the chat asked the right pane to show.
  const [focusRun, setFocusRun] = useState<{ id: string; key: number } | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  // When each chat's last turn ended, for the title bar's "Finished | Today at 19:22".
  const [finishedAt, setFinishedAt] = useState<Record<string, Date>>({});
  // The pop-up shown when the chat on screen finishes a turn.
  const [hud, setHud] = useState<HudEvent | null>(null);
  // A newer Lantern, downloaded and ready; `updateLater`: the user chose to take it when they quit.
  const [update, setUpdate] = useState<{ version: string } | null>(null);
  const [updateLater, setUpdateLater] = useState(false);
  // Where updating has got to (looking, downloading, installing), and the version that's running. `installStarted`
  // bridges the moment between clicking Update and the backend saying it has begun.
  const updates = useUpdateState();
  const [installStarted, setInstallStarted] = useState(false);
  const installing = installStarted || isInstalling(updates.state);

  // Actions for one chat. Async results always go to the chat that asked, even if another is on screen by then.
  // The last error any chat showed is kept in memory for Help ▸ Report a Bug… (it's never saved).
  const lastError = useRef<string | null>(null);
  const to = (slot: string) => (action: Action) => {
    if (action.type === "failed" || action.type === "turn_failed" || action.type === "stop_failed") lastError.current = action.text;
    dispatchChats({ type: "in", slot, action });
  };
  const dispatch = to(active);

  const locate = (pathOverride: string | null) =>
    api.locateClaude(pathOverride).then(
      (path) => dispatch({ type: "claude_found", path }),
      (e) => dispatch({ type: "claude_missing", error: errText(e) }),
    );

  useEffect(() => {
    // Events from every chat are applied together once a frame, in the order they came: a chat that streams dozens a second
    // (or several at once, on the canvas) is drawn once for them, not once for each.
    const batch = batchPerFrame<{ slot: string; event: UiEvent }>((items) => {
      for (const { slot, event } of items) dispatchChats({ type: "in", slot, action: { type: "ui_event", event } });
    });
    const unlisten = api.onUiEvent((slot, event) => batch.push({ slot, event }));
    locate(null);
    return () => {
      batch.flush();
      unlisten.then((stop) => stop());
    };
  }, []);

  // The update may have been found before this window was listening, so ask as well as listen. Its notes are kept for
  // the version that installs it, which shows them on its first launch.
  useEffect(() => {
    const offer = (u: UpdateInfo) => {
      rememberNotes(localStorage, u);
      setUpdate(u);
    };
    const unlisten = api.onUpdateReady(offer);
    api.updateStatus().then((u) => u && offer(u), () => {});
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);
  // "What's new in X" once after an update: the running version, if it's not the one this window last saw.
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string | null } | null>(null);
  const showWhatsNew = (version: string) => setWhatsNew({ version, notes: notesFor(localStorage, version) });
  useEffect(() => {
    api.appVersion().then((running) => {
      const version = typeof running === "string" ? newVersionToShow(localStorage, running) : null;
      if (version) showWhatsNew(version);
    }, () => {});
  }, []);
  // "Lantern ▸ Check for Updates…": open the Updates page and look.
  useEffect(() => {
    const unlisten = api.onCheckForUpdates(() => {
      setSettingsAt("updates");
      updates.check();
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);
  // A menu bar item runs its action (the same one its shortcut runs). A folder in Open Recent opens as the folder
  // menu's pick does; the ref is read at the time of the pick, so it sees the chats as they are then.
  const pickRecent = useRef<(path: string) => void>(() => {});
  pickRecent.current = (path) => startFresh(path);
  useEffect(() => {
    const unlisten = api.onMenuAction((id) => runAction(id));
    const unlistenRecent = api.onOpenRecent((path) => pickRecent.current(path));
    return () => {
      unlisten.then((stop) => stop());
      unlistenRecent.then((stop) => stop());
    };
  }, []);

  const harnessOf = (slot: string) => findHarness(presets, harnessBySlot[slot]);
  /** What a chat runs with: its preset's models, or (Default) the app's model and effort. */
  const settingsFor = (slot: string, h: Harness = harnessOf(slot)) => settingsOf(h, { model, effort });

  const restart = (slot: string, mode: Mode, withEffort: string | null = settingsFor(slot).effort) => {
    to(slot)({ type: "restarting" });
    api.restartSession(slot, mode, withEffort, autoFor(chats.slots[slot]?.folder ?? null)).then(() => to(slot)({ type: "session_ready" })).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };

  // If Stop made claude exit instead of just ending the turn, resume the session.
  useEffect(() => {
    for (const [slot, s] of Object.entries(chats.slots)) if (s.status === "ended" && s.stopRequested) restart(slot, s.mode);
  }, [chats.slots]);

  // Removes a chat and closes its claude. The reducer never removes the chat on screen, so after a switch this is
  // safe for the chat left behind, even though `active` here still names it.
  const forget = (slot: string, agent = false) => {
    dispatchChats({ type: agent ? "close_agent" : "remove", slot });
    delete drafts.current[slot];
    delete relaunch.current[slot];
    api.closeSession(slot).catch(() => {});
  };

  /**
   * Leaving a chat keeps it open (running or not) so switching back is instant; only an empty chat with nothing typed
   * is closed. Open chats are closed from the history menu.
   */
  const leave = (slot: string) => {
    const s = chats.slots[slot];
    if (!s || s.items.length > 0 || isBusy(s) || drafts.current[slot]?.trim()) return;
    forget(slot);
  };

  // Gives up on a start that never answers: whatever it says later is ignored, and the banner offers another go.
  const cancelStart = (slot: string) => {
    startGen.current[slot] = (startGen.current[slot] ?? 0) + 1;
    api.closeSession(slot).catch(() => {});
    to(slot)({ type: "failed", text: "Claude didn't start." });
  };

  const closeChat = (slot: string) => {
    if (slot === active || !chats.slots[slot]) return;
    forget(slot);
  };

  const switchTo = (slot: string) => {
    if (slot === active || !chats.slots[slot]) return;
    dispatchChats({ type: "activate", slot });
    leave(active);
    const folder = chats.slots[slot].folder;
    if (folder) setLastFolder(folder);
  };

  /**
   * The chat to start something new in: the one on screen if it's still empty, otherwise a new one (and the current
   * chat is left: kept in the background if busy, closed if not). A chat that is still starting isn't reused: its start
   * is on its way, and a second one would race it.
   */
  const takeSlot = (): string => {
    if (state.items.length === 0 && !isBusy(state) && state.status !== "starting") return active;
    const slot = `s${++slotSeq.current}`;
    dispatchChats({ type: "add", slot });
    dispatchChats({ type: "activate", slot });
    leave(active);
    return slot;
  };

  // `quiet`: reopening the remembered project at launch; if that fails (e.g. the folder is gone), just forget it.
  const startFresh = (folder: string, quiet = false, orchestra?: OrchestraStart) => {
    if (state.claudePath) startIn(takeSlot(), folder, quiet, orchestra);
  };

  /** `orchestra`: the chat is the main agent of an orchestra, which can start worker agents, on the mode the user chose for it. */
  const startIn = (slot: string, folder: string, quiet = false, orchestra?: OrchestraStart) => {
    const { claudePath } = state;
    if (!claudePath) return;
    // A chat opened before the last project was reopened (that waits on the moves): it isn't reopened over it later.
    reopened.current = true;
    // An orchestra runs on the mode the user chose for it (asked the first time, see newOrchestra), which its workers never
    // exceed. It doesn't change the project's own mode (see the effect below).
    const mode: Mode = orchestra ? orchestra.mode : modeFor(folder);
    const orchestrator = !!orchestra;
    const h = findHarness(presets, harnessByFolder[folder]);
    setHarnessBySlot((all) => ({ ...all, [slot]: h.id }));
    to(slot)({ type: "folder_opened", folder });
    to(slot)({ type: "mode_changed", mode });
    to(slot)({ type: "orchestrator_set", on: orchestrator });
    if (!quiet) relaunch.current[slot] = () => startIn(slot, folder, false, orchestra);
    const gen = (startGen.current[slot] = (startGen.current[slot] ?? 0) + 1);
    api.startSession(slot, claudePath, folder, { mode, ...settingsFor(slot, h), auto_approve: autoFor(folder), ...(orchestrator ? { orchestrator } : {}) }).then(
      () => {
        if (startGen.current[slot] !== gen) return;
        delete relaunch.current[slot];
        setLastFolder(folder);
        to(slot)({ type: "session_ready" });
      },
      (e) => {
        if (startGen.current[slot] !== gen) return;
        if (!quiet) return to(slot)({ type: "failed", text: errText(e) });
        setLastFolder(null);
        to(slot)({ type: "folder_cleared" });
      },
    );
  };

  useEffect(() => {
    // Not an orchestra's: its mode is its own, and a worker's folder is a worktree that's gone with it.
    if (state.folder && !state.orchestrator && !chats.agents[active] && modes[state.folder] !== state.mode) setModes({ ...modes, [state.folder]: state.mode });
    // An orchestra's mode, as the user last set it for its main agent, is what the project's next one starts on.
    if (state.folder && state.orchestrator && (state.mode === "auto" || state.mode === "ask") && orchestraModes[state.folder] !== state.mode) setOrchestraModes({ ...orchestraModes, [state.folder]: state.mode });
  }, [state.mode, state.folder]);
  // Every open chat's, not just the one on screen: a worker's mode is set in the background (and may be lowered there).
  const modesKey = Object.values(chats.slots).map((s) => `${s.sessionId}:${s.mode}`).join(" ");
  useEffect(() => {
    const next = sessionModesToSave(chats.slots, sessionModes);
    if (next) setSessionModes(next);
  }, [modesKey]);
  useEffect(() => {
    const id = harnessBySlot[active];
    if (state.sessionId && id && harnessBySession[state.sessionId] !== id) setHarnessBySession({ ...harnessBySession, [state.sessionId]: id });
  }, [harnessBySlot[active], state.sessionId]);

  // With no model chosen, whatever claude runs is Claude Code's default: remember it so the menu can name it.
  // And for an alias, the version it currently resolves to.
  useEffect(() => {
    if (model === null && state.model) setDefaultModel(state.model);
    else if (model && state.model?.includes(model) && modelIds[model] !== state.model) setModelIds({ ...modelIds, [model]: state.model });
  }, [model, state.model]);

  // Reopen the last project once claude has been found (where it is now, if it moved).
  useEffect(() => {
    if (reopened.current || state.status !== "no_folder" || !state.claudePath || !moves) return;
    reopened.current = true;
    if (lastFolder) startFresh(here(lastFolder), true);
  }, [state.status, state.claudePath, moves]);

  const openFolder = async () => {
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder === "string") startFresh(folder);
  };

  const loadSessions = () => (state.folder ? api.listSessions(state.folder) : Promise.resolve([]));

  // Replays a past session into a chat, then continues it with `claude --resume`. A session that's already open
  // in a chat is switched to instead.
  const openSession = (sessionId: string) => {
    const already = Object.entries(chats.slots).find(([, s]) => s.sessionId === sessionId);
    if (already) return switchTo(already[0]);
    const { claudePath, folder } = state;
    if (!claudePath || !folder) return;
    const reuse = state.items.length === 0 && !isBusy(state);
    // A second open into the chat that's still loading would load another session into it: ignored.
    if (reuse && state.status === "starting") return;
    resumeIn(takeSlot(), folder, sessionId, reuse);
  };

  /**
   * `team`: the chat was part of an orchestra: a main agent (reopened as one), or a worker of an open main agent, which
   * is reopened as its worker once that main agent has finished opening (`parentReady`; the backend adopts a worker only
   * into a main agent it already knows). Resolves to whether the chat opened.
   */
  const resumeIn = (slot: string, folder: string, sessionId: string, reuse = false, team?: TeamRole): Promise<boolean> => {
    const { claudePath } = state;
    if (!claudePath) return Promise.resolve(false);
    reopened.current = true;
    // The mode it was last in (and for an older Debug, Teach or Review session, that flavour of Step by step); one from
    // before modes were kept per session reopens as a plain chat, not as whatever this folder's newest chat is doing.
    const { mode, flavour: flavourStart } = savedMode(sessionModes[sessionId]);
    // The preset it last ran with, else the folder's.
    const h = findHarness(presets, harnessBySession[sessionId] ?? harnessByFolder[folder]);
    setHarnessBySlot((all) => ({ ...all, [slot]: h.id }));
    to(slot)(reuse ? { type: "restarting" } : { type: "folder_opened", folder });
    to(slot)({ type: "mode_changed", mode, flavourStart });
    to(slot)({ type: "orchestrator_set", on: team?.role === "main" });
    // Trying again later doesn't wait on a main agent that has long since opened (or not).
    const again: TeamRole | undefined = team?.role === "worker" ? { ...team, parentReady: undefined } : team;
    relaunch.current[slot] = () => void resumeIn(slot, folder, sessionId, reuse, again);
    const gen = (startGen.current[slot] = (startGen.current[slot] ?? 0) + 1);
    const open = (as: TeamRole | undefined) =>
      api.openSession(
        slot,
        claudePath,
        folder,
        { mode, ...settingsFor(slot, h), auto_approve: autoFor(folder), ...(as?.role === "main" ? { orchestrator: true } : {}), ...(as?.role === "worker" ? { worker: { name: as.name, parent: as.parent } } : {}) },
        sessionId,
      );
    // A worker waits for its main agent: if that one didn't open, this one comes back as an ordinary chat.
    const adopted = team?.role === "worker" && team.parentReady ? team.parentReady.then((ok) => (ok ? team : undefined)) : Promise.resolve(team);
    return adopted
      .then((as) => open(as).then((opened) => ({ opened, as })))
      .then(({ opened, as }) => {
        if (startGen.current[slot] !== gen) return false;
        // Not resumed (its copy into this folder failed): the transcript is shown, and Retry copies it again.
        if (opened.read_only) {
          to(slot)({ type: "history_loaded", sessionId, events: opened.events });
          to(slot)({ type: "failed", text: opened.read_only });
          return false;
        }
        delete relaunch.current[slot];
        to(slot)({ type: "history_loaded", sessionId, events: opened.events, movedFrom: opened.moved_from });
        to(slot)({ type: "session_ready" });
        if (as?.role === "worker") dispatchChats({ type: "adopt", slot, meta: { parent: as.parent, name: as.name, brief: "", folder, branch: as.branch, base: as.base, isolation: as.isolation, ...(as.hidden ? { hidden: true } : {}) } });
        return true;
      })
      .catch((e) => {
        if (startGen.current[slot] === gen) to(slot)({ type: "failed", text: errText(e) });
        return false;
      });
  };

  // The chats that were open when Lantern last closed, offered back at launch until restored, dismissed, or a message
  // is sent in a new chat instead.
  const [offer, setOffer] = useState<SavedChat[]>(loadSaved);
  // Offered where their folders are now, once the moves are known.
  useEffect(() => {
    if (moves) setOffer((o) => toCurrentFolders(o, moves));
  }, [moves]);
  // Bumped to remount the chat box when a restore puts unsent text back into the chat on screen.
  const [composerEpoch, setComposerEpoch] = useState(0);
  // After Edit (or a restore) the box has the text: focus it, so the user can go on typing.
  useEffect(() => {
    if (composerEpoch > 0) document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }, [composerEpoch]);
  // Edit: the message goes back in the box to send as a new one, in front of anything typed. Nothing is sent or removed.
  const editInBox = (draft: string) => {
    drafts.current[active] = prependDraft(drafts.current[active] ?? "", draft);
    setComposerEpoch((e) => e + 1);
  };

  // A chat from last time, into `slot`: its conversation continued, or (typed but never sent) a new one in its folder;
  // either way with its unsent text back in the box. A chat that was part of an orchestra comes back as part of it: a worker
  // finds its main agent among the open chats (or, when that is being restored too, in `opened`, by its session).
  // Resolves to whether it opened.
  const restoreInto = (slot: string, c: SavedChat, opened: Record<string, { slot: string; ready: Promise<boolean> }> = {}): Promise<boolean> => {
    if (c.draft) drafts.current[slot] = c.draft;
    const o = c.orchestra;
    let team: TeamRole | undefined;
    if (o?.role === "main") team = { role: "main" };
    else if (o?.role === "worker") {
      const parent = opened[o.parentSession] ?? openMainOf(o.parentSession);
      if (parent) team = { role: "worker", parent: parent.slot, name: o.name, branch: o.branch, base: o.base, isolation: o.isolation, hidden: o.hidden, parentReady: parent.ready };
    }
    if (c.sessionId) return resumeIn(slot, c.folder, c.sessionId, false, team);
    // Typed in the box but never sent: a new chat in its folder, as a main agent again if it was one.
    startIn(slot, c.folder, false, team?.role === "main" ? { mode: orchestraModes[c.folder] ?? "ask" } : undefined);
    return Promise.resolve(true);
  };
  const openAlready = (c: SavedChat) => (c.sessionId ? Object.entries(chats.slots).find(([, s]) => s.sessionId === c.sessionId)?.[0] : undefined);
  /** The main agent already open for this session, if there is one (already opened, so there is nothing to wait for). */
  const openMainOf = (session: string) => {
    const slot = Object.entries(chats.slots).find(([, s]) => s.orchestrator && s.sessionId === session)?.[0];
    return slot ? { slot, ready: Promise.resolve(true) } : undefined;
  };

  // One chat, on screen (in the empty chat on screen if there is one).
  const restoreOne = (offered: SavedChat) => {
    setOffer((o) => o.filter((x) => x !== offered));
    // Chosen before the moves were read, it still goes where its folder is now.
    const c = { ...offered, folder: here(offered.folder) };
    const already = openAlready(c);
    if (already) return switchTo(already);
    if (!state.claudePath) return;
    void restoreInto(takeSlot(), c);
    setComposerEpoch((e) => e + 1);
    setLastFolder(c.folder);
  };

  // Every chat: the one that was on screen comes back on screen, the others open behind it. Main agents of an orchestra
  // are opened first, so their workers can be put back under them.
  const restoreAll = () => {
    const ordered = screenFirst(toCurrentFolders(offer, moves ?? []));
    const [first] = ordered;
    if (!first || !state.claudePath) return;
    const isMain = (c: SavedChat) => c.orchestra?.role === "main";
    const inOrder = [...ordered.filter(isMain), ...ordered.filter((c) => !isMain(c))];
    setOffer([]);
    const opened: Record<string, { slot: string; ready: Promise<boolean> }> = {};
    let onScreen: string | undefined;
    inOrder.forEach((c, i) => {
      const already = openAlready(c);
      let slot: string;
      if (already) {
        slot = already;
      } else {
        // The first goes into the empty chat on screen, if there is one; the rest into chats of their own.
        slot = i === 0 ? takeSlot() : `s${++slotSeq.current}`;
        if (i !== 0) dispatchChats({ type: "add", slot });
        const ready = restoreInto(slot, c, opened);
        if (isMain(c) && c.sessionId) opened[c.sessionId] = { slot, ready };
      }
      if (c === first) onScreen = slot;
    });
    if (onScreen) dispatchChats({ type: "activate", slot: onScreen });
    setComposerEpoch((e) => e + 1);
    setLastFolder(first.folder);
  };

  const syncChanges = (slot: string) =>
    api.changeSummary(slot).then((files) => to(slot)({ type: "changes_synced", files }), () => {});

  // A revert finished: the chat says what it did, keeps Undo for it and tells Claude with the next message.
  const revertDone = (slot: string, req: RevertRequest, outcomes: RevertOutcome[]) => {
    to(slot)({ type: "revert_done", since: sinceLabel(chats.slots[slot]?.items ?? [], req.scope, req.turn), outcomes });
    syncChanges(slot);
  };
  const undoRevert = (slot: string) => {
    const undo = chats.slots[slot]?.revertUndo;
    if (!undo) return;
    api.undoRevert(slot, undo.files).then(
      (outcomes) => {
        to(slot)({ type: "revert_undone", id: undo.id, outcomes });
        syncChanges(slot);
      },
      (e) => to(slot)({ type: "failed", text: errText(e) }),
    );
  };

  // A command can create or change files without an edit (cp, mv, a generator): re-check once each one finishes.
  const commandsDone = countFinished(state.items, "Bash") + shellsDone(state.items);
  useEffect(() => {
    if (commandsDone > 0) syncChanges(active);
  }, [commandsDone]);

  // Coming back to the window: files may have changed meanwhile (an editor, git), so re-check the chat on screen.
  useEffect(() => {
    const onFocus = () => state.folder && syncChanges(active);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, state.folder]);

  // The skills and commands on disk, which tell claude's command list apart (refreshed when claude lists them again).
  // Kept per chat: a background chat's sends use its own skills, and a result that lands after the chat moved on is dropped.
  const [skillIndexBy, setSkillIndexBy] = useState<Record<string, SkillEntry[]>>({});
  useEffect(() => {
    if (!state.folder || !state.commands.length) return;
    let live = true;
    api.skillIndex(active).then((index) => live && setSkillIndexBy((all) => ({ ...all, [active]: index })), () => {});
    return () => {
      live = false;
    };
  }, [active, state.folder, state.commands]);
  const skillIndex = skillIndexBy[active] ?? NO_SKILLS;
  const skillNames = (slot: string) => new Set(describeCommands(chats.slots[slot]?.commands ?? [], skillIndexBy[slot] ?? NO_SKILLS).filter((c) => c.kind === "skill").map((c) => c.name));

  // MCP servers that need something, for the "/" menu: checked when a chat is ready and after its turns (not more
  // than once every 30s). claude.ai connectors you never set up aren't listed: they're optional.
  const [mcpIssues, setMcpIssues] = useState<Record<string, McpIssue[]>>({});
  const mcpCheckedAt = useRef<Record<string, number>>({});
  useEffect(() => {
    if (state.status !== "idle" || !state.folder || Date.now() - (mcpCheckedAt.current[active] ?? 0) < 30_000) return;
    mcpCheckedAt.current[active] = Date.now();
    const slot = active;
    api.claudeRequest<{ mcpServers?: McpServer[] }>(slot, { subtype: "mcp_status" }).then(
      (r) => {
        const issues = (r.mcpServers ?? [])
          .filter((m) => m.scope !== "claudeai" && (m.status === "needs-auth" || m.status === "failed"))
          .map((m) => ({ name: m.name.replace(/^plugin:[^:]+:/, ""), problem: m.status === "failed" ? "couldn't connect" : "needs you to log in" }));
        setMcpIssues((all) => ({ ...all, [slot]: issues }));
      },
      () => {},
    );
  }, [active, state.status, state.folder]);

  // Step by step's flavours as the prompt has them, for the notes that repeat them (switching flavour, an unread page).
  const [guides, setGuides] = useState<Guides>({});
  useEffect(() => {
    api.stepsGuide().then((list) => setGuides(guidesByFlavour(list)), () => {});
  }, []);

  // A flavour picked since the chat's last message goes with this one, in a note telling Claude.
  // `draft`: the box's text as sent, with its paste placeholders (kept on the message so Edit can bring them back).
  // `auto`: sent by Lantern from agents' notes, not typed by the user.
  const sendIn = (slot: string, text: string, draft?: string, auto = false) => {
    const pick = chats.slots[slot]?.flavourPick ?? null;
    const chat = chats.slots[slot];
    // Claude's last reply looked like a page Lantern couldn't read: it hears so with this message, and the headings.
    const unread = chat && chat.mode === "steps" && !pick ? pageNote(chat.items, chatFlavour(chat), guides) : null;
    to(slot)({ type: "user_sent", text, ...(auto ? { auto } : {}), ...(pick ? { switchedTo: pick } : {}), ...(draft ? { draft } : {}) });
    // Commands run since the last message go first, so Claude sees what they printed; skills named mid-message get
    // a note so Claude uses them.
    const items = chats.slots[slot]?.items ?? [];
    const noted = withSkillNote(text, skillNames(slot));
    // Files reverted since the last message: Claude is told, so it doesn't act on what it last wrote.
    const reverted = withRevertNote(withPageNote(unread, pick ? withFlavourNote(pick, noted, guides[pick]?.text) : noted), chats.slots[slot]?.revertNotes ?? []);
    // A chat opened from a place the folder moved from: Claude is told once that the paths in earlier messages are old.
    const moved = withMovedNote(reverted, chats.slots[slot]?.movedFrom ?? null, chats.slots[slot]?.folder ?? null);
    api.sendMessage(slot, withShellContext(items, moved)).then(
      (turn) => typeof turn === "number" && to(slot)({ type: "turn_numbered", turn }),
      (e) => to(slot)({ type: "turn_failed", text: errText(e) }),
    );
  };

  // "!command" in the chat box: run in the chat's folder, its output streaming into the conversation.
  const shellSeq = useRef(0);
  const runShell = (slot: string, command: string) => {
    const id = `sh-${Date.now().toString(36)}-${++shellSeq.current}`;
    to(slot)({ type: "shell_started", id, command });
    api.runShell(slot, id, command).catch((e) => {
      to(slot)({ type: "ui_event", event: { kind: "shell_output", id, text: errText(e) } });
      to(slot)({ type: "ui_event", event: { kind: "shell_done", id, code: null, stopped: false } });
    });
  };

  // A chat's queued messages go out when its turn ends normally, whether or not it's on screen.
  const prevStatus = useRef<Record<string, Status>>({});
  useEffect(() => {
    const due = queuesToSend(prevStatus.current, chats.slots);
    // A turn that just ended may have changed files outside Claude's edits (a shell rm, git checkout): re-check them.
    const ended = Object.entries(chats.slots).filter(([slot, s]) => prevStatus.current[slot] === "running" && s.status === "idle");
    for (const [slot] of ended) syncChanges(slot);
    if (ended.length) setFinishedAt((f) => ({ ...f, ...Object.fromEntries(ended.map(([slot]) => [slot, new Date()])) }));
    // No toast about the chat on screen: you're already looking at it (a macOS notification covers being away).
    prevStatus.current = Object.fromEntries(Object.entries(chats.slots).map(([slot, s]) => [slot, s.status]));
    for (const { slot, text } of due) {
      to(slot)({ type: "queue_set", items: [] });
      sendIn(slot, text);
    }
    // Notes from an orchestra's workers go to the main agent as soon as it is idle (not only when a turn ends: it is
    // usually idle when a worker finishes), joined into one message. Not to a chat that was just sent its queue above: this
    // render still has it idle, and a second message would start a second turn on top of that one.
    for (const { slot, text } of wakesToSend(chats.slots, new Set(due.map((d) => d.slot)))) {
      to(slot)({ type: "wakes_taken" });
      sendIn(slot, text, undefined, true);
    }
  }, [chats.slots]);

  /**
   * Restarting a chat's claude (a new mode, effort or preset) stops what it runs in the background: workflows,
   * background subagents and commands. With any running, ask first; `go` runs only if the answer is yes.
   */
  const unlessBackground = async (slot: string, go: () => void) => {
    const n = chats.slots[slot]?.backgroundTasks.length ?? 0;
    if (n > 0) {
      const them = n === 1 ? "it" : "them";
      const sure = await ask(`${n === 1 ? "A background task is" : `${n} background tasks are`} running in this chat (a workflow, a subagent or a command). Changing this restarts Claude, which stops ${them}.`, {
        title: "Restart Claude?",
        kind: "warning",
        okLabel: "Restart anyway",
        cancelLabel: "Keep running",
      });
      if (!sure) return;
    }
    go();
  };

  // /clear drops the conversation (the files it changed stay), so it's asked about first.
  const clearChat = async (slot: string) => {
    const sure = await ask("Claude forgets this conversation. The files it changed stay as they are.", {
      title: "Clear this conversation?",
      kind: "warning",
      okLabel: "Clear",
      cancelLabel: "Keep it",
    });
    if (sure) sendIn(slot, "/clear");
  };

  const changeMode = (mode: Mode) =>
    unlessBackground(active, () => {
      if (mode !== "steps") dispatch({ type: "flavour_picked", flavour: null });
      dispatch({ type: "mode_changed", mode });
      if (state.folder) restart(active, mode);
    });

  // Step by step's flavour as you see it: one you picked and haven't sent yet, or the conversation's.
  const chatFlavour = (s: typeof state) => (s.mode === "steps" ? (s.flavourPick ?? flavourOf(s.items, s.flavourStart)) : null);
  const flavour = chatFlavour(state);
  // Picking the flavour the chat is already in takes back a pick; one from outside Step by step switches to it.
  const pickFlavour = (next: Flavour | null) => {
    const inChat = state.mode === "steps" ? flavourOf(state.items, state.flavourStart) : null;
    if (state.mode !== "steps") {
      return unlessBackground(active, () => {
        dispatch({ type: "flavour_picked", flavour: next === inChat ? null : next });
        dispatch({ type: "mode_changed", mode: "steps" });
        if (state.folder) restart(active, "steps");
      });
    }
    dispatch({ type: "flavour_picked", flavour: next === inChat ? null : next });
  };

  /**
   * Switches a chat to a preset (and makes it its folder's): its claude restarts on the same session with the
   * preset's models, as for a new mode.
   */
  const switchHarness = (h: Harness, slot = active) => unlessBackground(slot, () => applyHarness(h, slot));
  const applyHarness = (h: Harness, slot: string) => {
    setHarnessBySlot((all) => ({ ...all, [slot]: h.id }));
    const folder = chats.slots[slot]?.folder;
    if (!folder) return;
    setHarnessByFolder({ ...harnessByFolder, [folder]: h.id });
    to(slot)({ type: "restarting" });
    api.applyHarness(slot, settingsFor(slot, h)).then(() => to(slot)({ type: "session_ready" })).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };
  // Changing model or effort on a chat with a preset makes it Custom: that preset with the change.
  const customize = (patch: Partial<Harness>) => {
    const custom: Harness = { ...harnessOf(active), ...patch, id: CUSTOM_HARNESS, name: "Custom" };
    setSavedPresets([...savedPresets.filter((h) => h.id !== CUSTOM_HARNESS), custom]);
    switchHarness(custom);
  };
  const presetOn = harnessOf(active).id !== DEFAULT_HARNESS;

  // Effort is a launch flag, so the chat's claude restarts on the same session to pick it up (like the mode).
  const changeEffort = (next: string | null) => {
    if (presetOn) return customize({ effort: next });
    unlessBackground(active, () => {
      setEffort(next);
      if (state.folder) restart(active, state.mode, next);
    });
  };

  // App-wide: applies in-band from each open chat's next message, and to new chats and restarts. Chats on a preset
  // keep the preset's model.
  const chooseModel = (next: string | null) => {
    if (presetOn) return customize({ model: next });
    setModel(next);
    for (const slot of Object.keys(chats.slots)) {
      if (harnessOf(slot).id === DEFAULT_HARNESS) api.setModel(slot, next).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
    }
  };

  const stopIn = (slot: string) => {
    to(slot)({ type: "stop_requested" });
    api.interrupt(slot).catch((e) => to(slot)({ type: "stop_failed", text: errText(e) }));
  };
  const stop = () => stopIn(active);

  // `note`: what the user wrote on a reproduce card; it goes back to Claude with the answer.
  // `answered`: the tool's input with what the user chose in it (AskUserQuestion's answers).
  // `remember`: an "Always allow…" rule. It's saved first, so the chat's next matching request is answered by it; if it
  // can't be saved, this request is still answered and the error is shown.
  const decideIn = (slot: string, id: string, allow: boolean, note?: string, answered?: Record<string, unknown>, remember?: NewRule) => {
    to(slot)({ type: "permission_decided", id, allow, note });
    const answer = () => api.respondPermission(slot, id, allow, note ?? null, answered ?? null).catch((e) => to(slot)({ type: "turn_failed", text: errText(e) }));
    if (!remember) return answer();
    api.addPermissionRule(slot, remember).catch((e) => to(slot)({ type: "turn_failed", text: errText(e) })).then(answer);
  };
  const decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>, remember?: NewRule) => decideIn(active, id, allow, note, answered, remember);

  // From the title bar's failure count: bring the latest failed step's activity into view, opened.
  const showFailure = () => {
    const marks = document.querySelectorAll(".chat .activity .failed");
    const block = marks[marks.length - 1]?.closest(".activity");
    if (!block) return;
    const line = block.querySelector<HTMLButtonElement>(".activity-line");
    if (line?.getAttribute("aria-expanded") === "false") line.click();
    const chat = block.closest<HTMLElement>(".chat");
    if (chat) scrollWithin(chat, block as HTMLElement, "center", "smooth");
    block.classList.remove("flash");
    void (block as HTMLElement).offsetWidth;
    block.classList.add("flash");
  };

  const stepsMode = state.mode === "steps";
  const stepsView = stepsMode && state.items.length > 0;
  // "Last turn" (on a Step-by-step page: that page's turn) asks the backend, which compares with how files stood when
  // the turn began. Re-asked as edits land, when a turn starts or ends, and when the session-wide list is re-synced;
  // always, so the filter can show both counts.
  const turnAsked = stepsView ? (pageRange?.from ?? null) : null;
  const turnTo = stepsView ? (pageRange?.to ?? null) : null;
  const turnKnown = !stepsView || pageRange !== null;
  useEffect(() => {
    if (!state.folder || !turnKnown) return setTurnFiles([]);
    let live = true;
    api.changeSummary(active, "turn", turnAsked, turnTo).then((f) => live && setTurnFiles(f), () => live && setTurnFiles([]));
    return () => {
      live = false;
    };
  }, [active, state.folder, state.changedFiles, state.status, turnAsked, turnTo, turnKnown]);
  // "Git": everything uncommitted, whoever changed it (an interrupted command, another editor). Asked for only while
  // it's the filter, since it reads git.
  const [gitFiles, setGitFiles] = useState<{ files: ChangedFile[]; error: string | null } | null>(null);
  useEffect(() => {
    if (changeScope !== "git" || !state.folder) return setGitFiles(null);
    let live = true;
    api.changeSummary(active, "git").then(
      (files) => live && setGitFiles({ files, error: null }),
      (e) => live && setGitFiles({ files: [], error: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [changeScope, active, state.folder, state.changedFiles, state.status, state.seq]);
  // "PR #N" while a pull request is reviewed: its files against its base. Picked when the review names its PR.
  // Reviewing with no PR named (a local branch): "Branch", its commits since it left its base. What Claude set with
  // mcp__lantern__review_target comes first, in any flavour; without it, the review's own text says.
  const reviewTarget = useMemo(() => reviewTargetOf(state.items), [state.items]);
  const reviewing = (flavour === "review" || reviewTarget !== null) && state.items.length > 0;
  const reviewPr = !reviewing ? null : reviewTarget ? reviewTarget.pr : prNumberOf(state.items);
  const reviewBranch = reviewing && reviewPr === null;
  const hints = reviewing ? reviewHints(state.items, state.folder) : [];
  const hintKey = hints.join("\n");
  // A local branch stacked on another: the base the review's Frame names (null: the backend works it out).
  const reviewBase = !reviewing ? null : reviewTarget ? reviewTarget.base : baseBranchOf(state.items);
  const scope: ChangeScope = (changeScope === "pr" && reviewPr === null) || (changeScope === "branch" && !reviewBranch) ? "session" : changeScope;
  const prPicked = useRef<string | null>(null);
  useEffect(() => {
    if (!reviewing) return;
    const key = `${active}:${reviewPr ?? "branch"}`;
    if (prPicked.current === key) return;
    prPicked.current = key;
    setChangeScope(reviewPr !== null ? "pr" : "branch");
  }, [active, reviewing, reviewPr]);
  const [branchFiles, setBranchFiles] = useState<{ key: string; review: BranchReview | null; files: ChangedFile[]; error: string | null } | null>(null);
  useEffect(() => {
    if (scope !== "branch" || !state.folder) return;
    let live = true;
    const key = `${active}:${hintKey}:${reviewBase ?? ""}`;
    Promise.all([api.branchReview(active, hints, reviewBase), api.changeSummary(active, "branch", null, null, null, hints, reviewBase)]).then(
      ([review, files]) => live && setBranchFiles({ key, review, files, error: null }),
      (e) => live && setBranchFiles({ key, review: null, files: [], error: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [scope, active, state.folder, hintKey, reviewBase, state.seq]);
  const shownBranch = branchFiles?.key.startsWith(`${active}:`) ? branchFiles : null;
  // Keyed by chat and folder as well as the PR number: another chat reviewing the same PR has its own files.
  const prKey = `${active}:${state.folder}:${reviewPr}`;
  const [prFiles, setPrFiles] = useState<{ key: string; files: ChangedFile[]; error: string | null } | null>(null);
  useEffect(() => {
    if (scope !== "pr" || reviewPr === null || !state.folder) return;
    let live = true;
    if (prFiles?.key !== prKey) setPrFiles(null);
    api.changeSummary(active, "pr", null, null, reviewPr, hints).then(
      (files) => live && setPrFiles({ key: prKey, files, error: null }),
      (e) => live && setPrFiles({ key: prKey, files: [], error: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [scope, active, state.folder, reviewPr]);
  const shownPr = prFiles?.key === prKey ? prFiles : null;
  const shownFiles = scope === "pr" ? (shownPr?.files ?? []) : scope === "branch" ? (shownBranch?.files ?? []) : scope === "git" ? (gitFiles?.files ?? []) : scope === "turn" ? turnFiles : state.changedFiles;
  // A review page's file, shown in the PR's changes once they're in.
  const [reviewFile, setReviewFile] = useState<string | null>(null);
  useEffect(() => {
    if ((scope !== "pr" && scope !== "branch") || !reviewFile) return;
    const match = shownFiles.find((f) => f.path === reviewFile || f.path.endsWith(`/${reviewFile}`));
    if (match && match.path !== state.selectedFile) dispatch({ type: "select_file", path: match.path });
  }, [reviewFile, shownPr, shownBranch]);

  const selectFile = (path: string) => dispatch({ type: "select_file", path });
  const openFile = (path: string) => {
    selectFile(path);
    setReviewCollapsed(false);
  };

  useAction("toggle-changes", () => setReviewCollapsed(!reviewCollapsed));

  // The orchestra. Agents on the canvas are chats like any other, so what they can do is the app's own, for their slot.
  // Another agent is the one the rest of the app (the title bar, shortcuts) is about now. Unlike switching chats, this
  // never closes the one it leaves: an empty main agent that is only waiting for its first message is still the orchestra.
  const focusAgent = (slot: string) => {
    if (slot !== active && chats.slots[slot]) dispatchChats({ type: "activate", slot });
  };
  /** One agent full size: the chat view, on that agent. */
  const showAgent = (slot: string) => {
    focusAgent(slot);
    setView("chat");
  };
  // The canvas gets these two fixed, calling through to this render's: a new function each render would make every agent on
  // it redraw for every event of every chat, which is what its per-agent subscriptions are there to avoid.
  const focusRef = useRef(focusAgent);
  focusRef.current = focusAgent;
  const showRef = useRef(showAgent);
  showRef.current = showAgent;
  const canvasFocus = useMemo(() => (slot: string) => focusRef.current(slot), []);
  const canvasOpen = useMemo(() => (slot: string) => showRef.current(slot), []);
  // How a project's orchestras run, once chosen. Starting a team is not the same as consenting to agents that act without
  // asking, so the first time it is asked, and the answer is kept for that project (changed in the main agent's mode menu).
  const newOrchestra = async () => {
    const folder = state.folder;
    if (!folder) return;
    let mode = orchestraModes[folder];
    if (!mode) {
      const auto = await ask(
        "An orchestra is a main agent and the workers it starts, all acting in this project.\n\nOn Auto, Claude Code's own safety checks approve routine actions, so agents can work without stopping at every step. On Ask, every agent asks you before each action. Workers never get more freedom than the main agent.",
        { title: "How should this team run?", kind: "info", okLabel: "Run on Auto", cancelLabel: "Run on Ask" },
      ).catch(() => false);
      mode = auto ? "auto" : "ask";
      setOrchestraModes({ ...orchestraModes, [folder]: mode });
    }
    startFresh(folder, false, { mode });
    setView("canvas");
  };
  const doing = {
    send: sendIn,
    stop: stopIn,
    queue: (slot: string, items: string[]) => to(slot)({ type: "queue_set", items }),
    decide: decideIn,
    openFile: (slot: string, path: string) => {
      const s = chats.slots[slot];
      if (!s) return;
      showAgent(slot);
      to(slot)({ type: "select_file", path });
      if (s.folder) setCollapsedBy({ ...collapsedBy, [s.folder]: false });
    },
    openTestRun: (slot: string, id: string) => {
      showAgent(slot);
      setFocusRun({ id, key: Date.now() });
      if (chats.slots[slot]?.folder) setCollapsedBy({ ...collapsedBy, [chats.slots[slot].folder!]: false });
    },
    stopShell: (slot: string, id: string) => api.stopShell(slot, id).catch(() => {}),
    shellInput: (slot: string, id: string, text: string) =>
      api.shellInput(slot, id, text).catch((e) => to(slot)({ type: "ui_event", event: { kind: "shell_output", id, text: `\n${errText(e)}\n` } })),
    restart: (slot: string) => {
      const s = chats.slots[slot];
      if (!s) return;
      if (relaunch.current[slot]) relaunch.current[slot]();
      else restart(slot, s.mode);
    },
    // The answer to a merge the main agent asked for. The backend says how it went (merge_resolved); an answer that never
    // got that far (nothing waiting, no such worker) is told to the main agent's chat, where the card is.
    // The main agent whose chat holds the card: found from the proposal itself, because the worker's chat may be closed by now
    // (and with it its place among the agents).
    approveMerge: (worker: string) => {
      const main = mergeOwner(chats, worker);
      api.approveMerge(worker).catch((e) => main && to(main)({ type: "ui_event", event: { kind: "merge_resolved", worker, outcome: "failed", detail: errText(e) } }));
    },
    declineMerge: (worker: string) => {
      const main = mergeOwner(chats, worker);
      api.declineMerge(worker).catch((e) => main && to(main)({ type: "ui_event", event: { kind: "merge_resolved", worker, outcome: "failed", detail: errText(e) } }));
    },
    removeWorktree: (worker: string) => api.discardWorktree(worker, false).catch((e) => Promise.reject(errText(e))),
    closeCheck: (worker: string) => api.closeWorkerCheck(worker).catch((e) => Promise.reject(errText(e))),
    // The backend has stopped it and told the main agent by the time this resolves; the chat goes from the app now.
    closeWorker: (worker: string, agreed?: CloseAgreed) => api.closeWorker(worker, agreed).then(() => forget(worker, true), (e) => Promise.reject(errText(e))),
    // The card comes from the backend's agent_spawned, like any worker's.
    spawn: (main: string, worker: NewWorker) => api.spawnWorker(main, worker).then(() => {}, (e) => Promise.reject(errText(e))),
    // Hiding the agent whose chat is on screen moves the rest of the app to its main agent, so it isn't about a card nobody sees.
    hide: (worker: string) => {
      const parent = chats.agents[worker]?.parent;
      dispatchChats({ type: "set_hidden", slot: worker, hidden: true });
      if (worker === active && parent) focusAgent(parent);
    },
    show: (worker: string) => dispatchChats({ type: "set_hidden", slot: worker, hidden: false }),
    draft: (slot: string) => drafts.current[slot] ?? "",
    setDraft: (slot: string, text: string) => {
      if (text) drafts.current[slot] = text;
      else delete drafts.current[slot];
      saveOpen();
    },
  };
  // Agents are handed one set of actions for good and call through it to whatever this render has, so they never redraw for it.
  const doingRef = useRef(doing);
  doingRef.current = doing;
  const nodeActions = useMemo<NodeActions>(
    () => ({
      send: (slot, text) => doingRef.current.send(slot, text),
      stop: (slot) => doingRef.current.stop(slot),
      queue: (slot, items) => doingRef.current.queue(slot, items),
      decide: (slot, id, allow, note, answered) => doingRef.current.decide(slot, id, allow, note, answered),
      openFile: (slot, path) => doingRef.current.openFile(slot, path),
      openTestRun: (slot, id) => doingRef.current.openTestRun(slot, id),
      stopShell: (slot, id) => doingRef.current.stopShell(slot, id),
      shellInput: (slot, id, text) => doingRef.current.shellInput(slot, id, text),
      restart: (slot) => doingRef.current.restart(slot),
      approveMerge: (worker) => doingRef.current.approveMerge(worker),
      declineMerge: (worker) => doingRef.current.declineMerge(worker),
      removeWorktree: (worker) => doingRef.current.removeWorktree(worker),
      spawn: (main, worker) => doingRef.current.spawn(main, worker),
      closeCheck: (worker) => doingRef.current.closeCheck(worker),
      closeWorker: (worker, agreed) => doingRef.current.closeWorker(worker, agreed),
      hide: (worker) => doingRef.current.hide(worker),
      show: (worker) => doingRef.current.show(worker),
      draft: (slot) => doingRef.current.draft(slot),
      setDraft: (slot, text) => doingRef.current.setDraft(slot, text),
    }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (reviewCollapsed || e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement)) return;
      const delta = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
      const next = delta && stepFile(shownFiles, state.selectedFile, delta);
      if (next && next !== state.selectedFile) selectFile(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewCollapsed, shownFiles, state.selectedFile]);

  // The branch can change between turns (Claude may check out one), so re-read it whenever a turn ends.
  const idle = state.status === "idle";
  useEffect(() => {
    if (!state.folder) return setBranch(null);
    let live = true;
    api.gitBranch(state.folder).then((b) => live && setBranch(b), () => live && setBranch(null));
    return () => {
      live = false;
    };
  }, [state.folder, idle]);

  // Tell the user when a turn ends or Claude needs a permission answer, if they're in another app or another chat.
  // Item ids restart in every session, so the session id is part of what counts as "already announced".
  // Short titles for the open chats, by session id, made once each session has its first prompt.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const titling = useRef(new Set<string>());
  useEffect(() => {
    for (const s of Object.values(chats.slots)) {
      const prompt = firstPrompt(s);
      const id = s.sessionId;
      if (!id || !prompt || !s.folder || !s.claudePath || titles[id] || titling.current.has(id)) continue;
      titling.current.add(id);
      api.titleSession(s.claudePath, s.folder, id, prompt).then(
        (t) => t && setTitles((all) => ({ ...all, [id]: t })),
        () => {},
      );
    }
  }, [chats.slots]);

  // Saved as they change, so a crash or force-quit leaves them to restore too.
  // A chat still open in a folder that has since moved is saved where the folder is now.
  const saveOpen = () => save(toCurrentFolders(withOffered(chatsToSave(chats.slots, active, drafts.current, titles, chats.agents), offer), moves ?? []));
  useEffect(saveOpen, [chats.slots, chats.agents, active, titles, offer, moves]);

  const announced = useRef<Record<string, string>>({});
  // Chats that finished in the background and haven't been looked at since: a blue dot, like an unread message.
  const [unread, setUnread] = useState<Record<string, true>>({});
  useEffect(() => {
    setUnread(({ [active]: _seen, ...rest }) => rest);
  }, [active]);
  useEffect(() => {
    for (const [slot, s] of Object.entries(chats.slots)) {
      const a = attentionFor(s.items, s.folder, describeInput);
      const key = a && `${s.sessionId}:${a.key}`;
      if (!a || !key || key === announced.current[slot]) continue;
      announced.current[slot] = key;
      // An agent of the orchestra on the canvas in front of you is already on screen with what it is doing: no pop-up for it.
      // Away from the window you still hear of it.
      const shown = teamMain(chats, chats.active);
      const onScreen = view === "canvas" && windowFocused() && shown !== null && (slot === shown || chats.agents[slot]?.parent === shown);
      if (onScreen) continue;
      // Settings can have this kind of event off, or paused: then neither a notification nor a toast.
      const wanted = shouldNotify(notifyPrefs, a.kind);
      if (wanted && (!windowFocused() || slot !== chats.active)) notify(a.title, a.body, a.kind);
      // Another chat finished or needs an answer: say so in the window too, and let the toast take you there.
      if (slot !== chats.active) {
        if (a.kind === "finished" || a.kind === "failed") setUnread((u) => ({ ...u, [slot]: true }));
        const project = s.folder && s.folder !== state.folder ? basename(s.folder) : null;
        if (wanted) setHud({ key: Date.now(), kind: a.kind, body: a.body, chat: { slot, title: chats.agents[slot]?.name ?? chatTitle(s, titles), project } });
      }
    }
  }, [chats.slots]);

  // When each chat was last opened or last had something happen in it (a message, a reply), for the Open list.
  const touched = useRef<Record<string, { at: number; seq: number }>>({});
  for (const [slot, s] of Object.entries(chats.slots)) {
    const t = touched.current[slot];
    // The chat on screen counts as opened now; another one when its conversation moves on (seq: messages, turn ends).
    if (!t || t.seq !== s.seq || slot === active) touched.current[slot] = { at: Date.now(), seq: s.seq };
  }
  const lastTouched = (slot: string) => touched.current[slot]?.at ?? 0;
  // A toast about a chat goes once you're in that chat; "Needs you" also once it isn't waiting any more.
  useEffect(() => {
    const slot = hud?.chat?.slot;
    if (!slot) return;
    const s = chats.slots[slot];
    if (active === slot || !s || (hud.kind === "waiting" && chatState(s, drafts.current[slot]) !== "waiting")) setHud(null);
  }, [hud, active, chats.slots]);

  const openChats: OpenChat[] = Object.entries(chats.slots)
    .filter(([slot]) => slot !== active)
    .sort(([a], [b]) => lastTouched(b) - lastTouched(a))
    .map(([slot, s]) => ({ slot, title: chats.agents[slot]?.name ?? chatTitle(s, titles), state: chatState(s, drafts.current[slot]), unread: !!unread[slot], background: s.backgroundTasks.length, sessionId: s.sessionId, elsewhere: s.folder && s.folder !== state.folder ? basename(s.folder) : null, worker: !!chats.agents[slot] }));

  // For the title bar: steps that failed in the latest turn, and other chats waiting for an answer.
  const lastPrompt = state.items.map((it) => it.type).lastIndexOf("user");
  const turnTools = state.items.slice(lastPrompt + 1).flatMap((it) => (it.type === "tool" ? [it] : []));
  // Cleared from the title bar: hidden until a different set of steps has failed.
  const failedKey = turnTools.filter((t) => t.status === "error").map((t) => t.id).join(",");
  const failed = clearedFailures[active] === failedKey ? 0 : failedCount(turnTools);
  const waiting = openChats.filter((c) => c.state === "waiting").length;

  // The team of the chat on screen (its main agent and workers), the ones waiting for you, and whether the canvas is what's
  // shown. Another chat, outside any team, has no canvas, and neither does the toggle for it.
  const team = teamMain(chats, active);
  const mains = Object.values(chats.slots).filter((s) => s.orchestrator).length;
  const nodes = team ? teamNodes(orchestraNodes(chats, (_slot, s) => (mains > 1 && s.folder ? `Main agent · ${basename(s.folder)}` : "Main agent")), team) : [];
  const inOrchestra = team !== null;
  const showCanvas = view === "canvas" && inOrchestra;
  const attention = needingYou(nodes, chats.slots);
  useAction("toggle-canvas", () => setView((v) => (v === "canvas" ? "chat" : "canvas")), inOrchestra);

  const lastTurn = [...state.items].reverse().find((it) => it.type === "turn");
  const lastTurnMs = lastTurn?.type === "turn" ? lastTurn.durationMs : null;
  // Recorded when a turn ends: the window it reported belongs to the model that ran it. (The next turn's init
  // changes the model before a new window arrives, so recording on every change could file it under the wrong one.)
  useEffect(() => {
    if (state.model && state.contextWindow && windows[state.model] !== state.contextWindow) setWindows({ ...windows, [state.model]: state.contextWindow });
  }, [lastTurn?.id]);
  const contextWindow = (state.model && windows[state.model]) || state.contextWindow || 200_000;
  // What the chat (and Step-by-step pages) can do: answer prompts, open files, show test runs.
  const streamHandlers = {
    onDecide: decide,
    onOpenFile: openFile,
    onStopShell: (id: string) => api.stopShell(active, id).catch(() => {}),
    // A reply that couldn't be typed says so in the command's block (the command most likely just ended).
    onShellInput: (id: string, text: string) => api.shellInput(active, id, text).catch((e) => dispatch({ type: "ui_event", event: { kind: "shell_output", id, text: `\n${errText(e)}\n` } })),
    testRunFor: (id: string) => state.testRuns.find((r) => r.id === id),
    onOpenTestRun: (id: string) => {
      setFocusRun({ id, key: Date.now() });
      setReviewCollapsed(false);
    },
  };
  // Edit, Retry and Regenerate: only in a chat that's idle (not mid-turn, not ended) and not Step by step, whose pages
  // have their own flow.
  const resendHandlers = state.status === "idle" && !stepsMode ? { onEdit: editInBox, onResend: (p: { text: string; draft?: string }) => sendIn(active, p.text, p.draft) } : undefined;
  const hero = state.items.length === 0 && !state.thinking;
  // The Agents tab: the latest turn's tree. It comes up by itself the first time a chat's turn uses a subagent or the
  // advisor; after that it's left where you put it.
  // Live while Claude works, and while anything it started runs on in the background (a workflow, a subagent).
  const treeOpts = { live: state.status === "running" || state.backgroundTasks.length > 0, folder: state.folder, mainModel: state.model, effort: settingsFor(active).effort, advisor: settingsFor(active).advisor, background: state.backgroundRuns };
  const tree = agentTree(state.items, treeOpts);
  const graph = useMemo(() => agentGraph(state.items, treeOpts), [state.items, state.backgroundRuns, treeOpts.live, treeOpts.mainModel, treeOpts.advisor]);
  // The Summary tab: the plan so far, from the same pages the Step-by-step view shows. A row asks the view to open its
  // page; the chat it was for is kept so a request can't land in another one.
  const stepPages = useMemo(() => (stepsView ? pagesOf(state.items) : null), [stepsView, state.items]);
  const stepsSummary = useMemo(() => {
    const summary = stepPages ? summarize(stepPages) : null;
    return summary && summary.rows.length > 0 ? summary : null;
  }, [stepPages]);
  const [pageJump, setPageJump] = useState<{ slot: string; page: string; key: number } | null>(null);
  const openPageIn = (slot: string) => (page: string) => setPageJump((j) => ({ slot, page, key: (j?.key ?? 0) + 1 }));
  // The Map tab: the latest Architecture Overview's map, lit for the page on screen. A new Overview (not one already
  // there when the chat was opened) brings the tab up.
  const archMap = useMemo(() => (stepPages ? architectureMap(stepPages) : null), [stepPages]);
  const [shownPage, setShownPage] = useState<{ slot: string; page: string } | null>(null);
  const shownCovers = useMemo(() => {
    const p = shownPage?.slot === active ? stepPages?.find((x) => x.key === shownPage.page) : undefined;
    return p ? coversOf(p) : [];
  }, [shownPage, active, stepPages]);
  const archPageNames = useMemo(() => Object.fromEntries((stepPages ?? []).filter((p) => p.heading?.kind === "part").map((p) => [p.key, `${pageLabel(p.heading)}${pageTitle(p) ? ` — ${pageTitle(p)}` : ""}`])), [stepPages]);
  const [archOpenKey, setArchOpenKey] = useState(0);
  const archSeen = useRef<{ slot: string; page: string | null } | null>(null);
  useEffect(() => {
    const page = archMap?.page ?? null;
    const seen = archSeen.current;
    archSeen.current = { slot: active, page };
    if (seen?.slot === active && page && page !== seen.page) setArchOpenKey((k) => k + 1);
  }, [active, archMap?.page]);
  const openArchitecture = () => {
    setReviewCollapsed(false);
    setArchOpenKey((k) => k + 1);
  };
  const [agentsOpenKey, setAgentsOpenKey] = useState(0);
  const agentsShown = useRef<Set<string>>(new Set());
  const treeInUse = tree.live && usesAgents(tree);
  useEffect(() => {
    if (!treeInUse || agentsShown.current.has(active)) return;
    agentsShown.current.add(active);
    setAgentsOpenKey(Date.now());
  }, [treeInUse, active]);
  // "How the modes work", open on a mode's page.
  const [guideAt, setGuideAt] = useState<GuideKey | null>(null);
  const [settingsAt, setSettingsAt] = useState<SettingsTab | null>(null);
  useAction("settings", () => setSettingsAt(settingsAt ?? "general"));
  // ⇧⌘P: every action that can run, and the things that aren't shortcuts: switching mode or harness, and each Settings
  // page. Listed as they are when the palette opens.
  const [palette, setPalette] = useState<PaletteEntry[] | null>(null);
  const paletteEntries = (): PaletteEntry[] => {
    const ready = !!state.folder && !isBusy(state);
    const modes = (["ask", "auto", "steps"] as const)
      .filter((m) => ready && m !== state.mode)
      .map((m): PaletteEntry => ({ id: `mode:${m}`, title: `Switch to ${GUIDE[m].label}`, group: "Mode", shortcut: null, run: () => changeMode(m) }));
    const harnesses = presets
      .filter((h) => ready && h.id !== harnessOf(active).id)
      .map((h): PaletteEntry => ({ id: `harness:${h.id}`, title: `Use the ${h.name} harness`, group: "Harness", shortcut: null, run: () => switchHarness(h) }));
    const tabs = (["general", "harness", "mcp", "skills", "permissions", "updates"] as SettingsTab[])
      .filter((t) => t !== "harness" || !!state.folder)
      .map((t): PaletteEntry => ({ id: `settings:${t}`, title: `Settings: ${TAB_LABEL[t]}`, group: "Settings", shortcut: null, run: () => setSettingsAt(t) }));
    return [...availableActions(), ...modes, ...harnesses, ...tabs];
  };
  // Pressed again while open, it closes.
  useAction("command-palette", () => setPalette((open) => (open ? null : paletteEntries())));
  // ⌘/ and Help ▸ Keyboard Shortcuts: the sheet of shortcuts, toggled the same way.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useAction("keyboard-shortcuts", () => setShortcutsOpen((open) => !open));
  // Help ▸ Report a Bug…: the diagnostics go to the clipboard and the new-issue page opens. The error shown is the chat's
  // banner's if one is up, else the last one a chat showed.
  useAction("report-bug", () => {
    const error = state.banner?.kind === "error" ? state.banner.text : lastError.current;
    api.copyDiagnostics(state.claudePath, state.model, error).then(
      () => {
        dispatch({ type: "notice", text: "Diagnostics copied. Paste them into the issue form that just opened." });
        openUrl(NEW_ISSUE_URL).catch(() => {});
      },
      (e) => dispatch({ type: "failed", text: errText(e) }),
    );
  });
  // Installs the downloaded update and relaunches. The window says so (the overlay) until it does: closing every chat
  // and reopening is otherwise just a window that vanishes. Started from Settings, that closes first.
  // The History menu's actions on past sessions, for the folder on screen: pins are kept per folder, and a rename also
  // renames the open chat of that session.
  const [pinnedBy, setPinnedBy] = usePersistentState<Record<string, string[]>>("settings.pinnedSessions", {});

  // Folders that seem to have moved (their path is gone), and the "moved?" notices the user dismissed. They're found from
  // the folder menu and at launch; nothing is brought over without the user asking in the dialog.
  const [moved, setMoved] = useState<MovedFolder[]>([]);
  const [dismissedMoves, setDismissedMoves] = usePersistentState<string[]>("relocate.dismissed", []);
  // The project the old sessions go to (null: not chosen yet), and the place a "moved?" notice was for, if any.
  const [bringing, setBringing] = useState<{ destination: string | null; from: string | null } | null>(null);
  const refreshMoved = () => api.movedFolderCandidates().then(setMoved, () => setMoved([]));
  useEffect(() => {
    refreshMoved();
  }, []);
  const bringHere = () => setBringing({ destination: state.folder, from: null });
  useAction("relocate-folder", bringHere, true);
  const relocateMenu = {
    moved: moved.filter((m) => !dismissedMoves.includes(m.old)),
    onRelocate: (from: MovedFolder | null) => (from ? setBringing({ destination: from.suggested, from: from.old }) : bringHere()),
    onDismiss: (old: string) => setDismissedMoves([...dismissedMoves, old]),
  };
  const loadRecentFolders = () => {
    refreshMoved();
    return api.recentFolders();
  };
  // A move is recorded: the folder's saved state follows it, in storage and in the state kept here (which the next save
  // would otherwise write back as it was).
  const carryFolderState = (old: string, next: string) => {
    const changed: Migrated = migrateFolderState(localStorage, old, next);
    const take = <T,>(key: string) => changed[key] as T | undefined;
    const modes = take<Record<string, string>>("settings.modeByFolder");
    if (modes) setModes(modes);
    const auto = take<Record<string, boolean>>("settings.autoApproveByFolder");
    if (auto) setAutoBy(auto);
    const prompts = take<Record<string, string[]>>("settings.promptHistory");
    if (prompts) setPromptsBy(prompts);
    const harness = take<Record<string, string>>("settings.harnessByFolder");
    if (harness) setHarnessByFolder(harness);
    const collapsed = take<Record<string, boolean>>("review.collapsedByFolder");
    if (collapsed) setCollapsedBy(collapsed);
    const pinned = take<Record<string, string[]>>("settings.pinnedSessions");
    if (pinned) setPinnedBy(pinned);
    const last = take<string>(LAST_FOLDER);
    if (last) setLastFolder(last);
    if (changed[OPEN_CHATS]) setOffer((chats) => chats.map((c) => (c.folder === old ? { ...c, folder: next } : c)));
  };
  // One place's sessions came over. The dialog stays open for the others, so only the saved state moves here.
  const relocated = (old: string, next: string) => {
    carryFolderState(old, next);
    refreshMoved();
    refreshMoves();
  };
  const sessionActions: SessionActions | null = state.folder
    ? {
        folder: state.folder,
        pinned: pinnedBy[state.folder] ?? [],
        onTogglePin: (id) => {
          const folder = state.folder!;
          const pinned = pinnedBy[folder] ?? [];
          setPinnedBy({ ...pinnedBy, [folder]: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id] });
        },
        onRename: async (id, title) => {
          await api.renameSession(id, title);
          setTitles((all) => ({ ...all, [id]: title }));
        },
        onExport: (id, title) => {
          const folder = state.folder!;
          // The transcript as the chat would show it, read without starting claude: its prompts, replies and steps.
          api
            .sessionEvents(folder, id)
            .then((events) => {
              const replayed = reducer({ ...initialState, folder }, { type: "history_loaded", sessionId: id, events });
              return api.exportText(exportFileName(title), sessionMarkdown(title, replayed.items, folder));
            })
            .catch((e) => dispatch({ type: "failed", text: errText(e) }));
        },
      }
    : null;

  const restartToUpdate = () => {
    setInstallStarted(true);
    setSettingsAt(null);
    api.restartToUpdate().catch((e) => {
      setInstallStarted(false);
      // The attempt used the download up: it has to be fetched again.
      setUpdate(null);
      dispatch({ type: "failed", text: errText(e) });
    });
  };
  const updateOffer = update && !updateLater ? { version: update.version, busy: Object.values(chats.slots).filter(isBusy).length, onRestart: restartToUpdate, onLater: () => setUpdateLater(true) } : undefined;
  const composer = (
    <MessageInput
      key={`input-${active}-${composerEpoch}`}
      status={state.status}
      onSend={(text, draft) => {
        // Starting something new instead: the chats from last time aren't offered any more.
        if (hero) setOffer([]);
        sendIn(active, text, draft);
      }}
      onStop={stop}
      onCancelStart={() => cancelStart(active)}
      onRun={(command) => {
        if (hero) setOffer([]);
        runShell(active, command);
      }}
      mode={state.folder ? state.mode : undefined}
      flavour={flavour}
      onModeChange={changeMode}
      model={state.model}
      idlePlaceholder={stepsView ? (flavour === "review" ? "Ask about this file…" : "Ask about this page or change it…") : stepsMode && hero ? HERO_PLACEHOLDER[flavour ?? "none"] : undefined}
      sendAndNext={stepsView ? (text) => sendIn(active, andNext(text)) : undefined}
      hero={hero}
      folder={state.folder}
      onOpenFolder={openFolder}
      sessions={{ load: loadSessions, currentId: state.sessionId, onOpen: openSession, open: openChats, onSwitch: switchTo }}
      folders={{ load: loadRecentFolders, onPick: (path) => startFresh(path), relocate: relocateMenu }}
      models={{ chosen: settingsFor(active).model, onChoose: chooseModel, defaultModel, ids: modelIds, options: state.models }}
      effort={{ chosen: settingsFor(active).effort, onChoose: changeEffort }}
      harness={state.folder ? { presets, chosen: harnessOf(active).id, onChoose: (id) => switchHarness(findHarness(presets, id)), onEdit: () => setSettingsAt("harness") } : undefined}
      usage={{ used: state.contextUsed, window: contextWindow, lastTurnMs, session: { cost: state.sessionCost, tokens: state.sessionTokens }, actions: state.folder && !stepsMode ? { onCompact: () => sendIn(active, "/compact"), onClear: () => clearChat(active) } : undefined }}
      queue={{ items: state.queued, set: (items) => dispatch({ type: "queue_set", items }) }}
      history={state.folder ? { entries: promptsBy[state.folder] ?? [], remember: (entry) => setPromptsBy({ ...promptsBy, [state.folder!]: withPrompt(promptsBy[state.folder!] ?? [], entry) }) } : undefined}
      commands={state.commands}
      skillIndex={skillIndex}
      findFiles={state.folder ? (query) => api.findFiles(active, query) : undefined}
      mcpIssues={mcpIssues[active]}
      onOpenSettings={() => setSettingsAt("mcp")}
      draft={{
        initial: drafts.current[active] ?? "",
        save: (text) => {
          drafts.current[active] = text;
          saveOpen();
        },
      }}
      update={updateOffer}
    />
  );

  if (state.status === "locating") return <div className="center muted">Looking for the claude CLI…</div>;
  if (state.status === "setup") return <SetupScreen error={state.setupError} onCheck={locate} />;

  return (
    <SlotContext.Provider value={active}><ModeGuideContext.Provider value={setGuideAt}><SessionActionsContext.Provider value={sessionActions}>
      <div className="app">
        <TopBar
          folder={state.folder}
          status={state.status}
          changeCount={state.changedFiles.length}
          reviewCollapsed={reviewCollapsed}
          onOpenFolder={openFolder}
          onToggleReview={() => setReviewCollapsed(!reviewCollapsed)}
          onOpenSettings={() => setSettingsAt("general")}
          sessionId={state.sessionId}
          loadSessions={loadSessions}
          onOpenSession={openSession}
          onNewSession={() => state.folder && startFresh(state.folder)}
          loadRecent={loadRecentFolders}
          onPickFolder={(path) => startFresh(path)}
          relocate={relocateMenu}
          bringOld={{ load: () => (state.folder ? api.oldLocations(state.folder) : Promise.resolve([])), onOpen: bringHere }}
          openChats={openChats}
          onSwitchChat={switchTo}
          onCloseChat={closeChat}
          branch={branch}
          activity={activityStatus(state, finishedAt[active] ?? null)}
          issues={{ failed, waiting }}
          background={state.backgroundTasks}
          onStopTask={(id) => api.stopTask(active, id)}
          onClearFailures={() => setClearedFailures({ ...clearedFailures, [active]: failedKey })}
          onShowFailure={showFailure}
          orchestra={{ view: showCanvas ? "canvas" : "chat", exists: inOrchestra, attention: attention.length, onView: setView, onNew: newOrchestra }}
        />
        <Hud event={hud} onOpenChat={switchTo} />
        {state.banner && <BannerView banner={state.banner} onRestart={() => (relaunch.current[active] ? relaunch.current[active]() : restart(active, state.mode))} onDismiss={() => dispatch({ type: "dismiss_banner" })} />}
        {showCanvas ? (
          <ChatStoreContext.Provider value={chatStore}>
            <NodeActionsContext.Provider value={nodeActions}>
              <ErrorBoundary name="canvas">
                <Canvas nodes={nodes} layout={canvasLayout.current} activeSlot={active} attention={attention} onFocus={canvasFocus} onOpen={canvasOpen} />
              </ErrorBoundary>
            </NodeActionsContext.Provider>
          </ChatStoreContext.Provider>
        ) : (
        <SplitPane
          ratio={splitRatio}
          collapsed={reviewCollapsed}
          onRatio={setSplitRatio}
          left={
            <section className="chat-pane">
              {hero ? (
                <div className="hero-wrap">
                  <div className="hero-stack">
                    {offer.length > 0 && state.claudePath && (
                      <RestoreCard chats={offer} folder={state.folder} onRestoreAll={restoreAll} onRestore={restoreOne} onDismiss={() => setOffer([])} />
                    )}
                    {stepsMode && state.folder && <StepsIntro picked={state.flavourPick} onPick={pickFlavour} />}
                    {composer}
                  </div>
                </div>
              ) : (
                <>
                  {/* Keyed by chat: a crash in one chat's stream doesn't stay on screen when another chat is shown. */}
                  <ErrorBoundary key={active} name="chat">
                    <ArchitecturePane.Provider value={state.folder ? openArchitecture : null}>
                    <FileLinksProvider key={active} slot={active} folder={state.folder} epoch={state.seq} onOpen={openMention}>
                      {stepsView ? (
                        <StepsView key={`steps-${active}`} state={state} {...streamHandlers} onNext={(message) => sendIn(active, message ?? "Next")} onSend={(text) => sendIn(active, text)} flavour={flavour} onPickFlavour={pickFlavour} autoApprove={autoFor(state.folder)}
                          onAutoApprove={(on) =>
                            unlessBackground(active, () => {
                              if (!state.folder) return;
                              setAutoBy({ ...autoBy, [state.folder]: on });
                              to(active)({ type: "restarting" });
                              api.restartSession(active, state.mode, settingsFor(active).effort, on).then(() => to(active)({ type: "session_ready" })).catch((e) => to(active)({ type: "failed", text: errText(e) }));
                            })
                          } onPage={setPageRange} onShown={(page) => setShownPage({ slot: active, page })} onReviewFile={setReviewFile} jump={pageJump?.slot === active ? pageJump : null} />
                      ) : (
                        <ChatView key={`chat-${active}`} state={state} {...streamHandlers} resend={resendHandlers} />
                      )}
                    </FileLinksProvider>
                    </ArchitecturePane.Provider>
                  </ErrorBoundary>
                  {composer}
                </>
              )}
            </section>
          }
          right={
            <ErrorBoundary name="review pane">
              <ReviewPanel
                agents={state.folder ? { tree, graph, usage: state.modelUsage, openKey: agentsOpenKey } : undefined}
                architecture={archMap ? { map: archMap, current: shownCovers, pageNames: archPageNames, onOpenPage: openPageIn(active), openKey: archOpenKey } : undefined}
                summary={stepsSummary ? { slot: active, data: stepsSummary, changed: state.changedFiles, running: state.status === "running", onOpenPage: openPageIn(active), doc: { pages: stepPages ?? [], title: chatTitle(state, titles), folder: state.folder } } : undefined}
                folder={state.folder}
                ready={state.status !== "starting"}
                files={shownFiles}
                scope={scope}
                onScope={setChangeScope}
                scopeCounts={{ turn: turnFiles.length, session: state.changedFiles.length, git: gitFiles?.error ? null : (gitFiles?.files.length ?? null), pr: shownPr?.error ? null : (shownPr?.files.length ?? null), branch: shownBranch?.error ? null : (shownBranch?.files.length ?? null) }}
                gitError={scope === "git" ? (gitFiles?.error ?? null) : scope === "pr" ? (shownPr?.error ?? null) : scope === "branch" ? (shownBranch?.error ?? null) : null}
                pr={reviewPr}
                branch={reviewBranch ? (shownBranch?.review ?? null) : undefined}
                stepRange={stepsView ? pageRange : undefined}
                testRuns={state.testRuns}
                searchKey={searchKey}
                openRequest={openRequest}
                focusRun={focusRun}
                selected={state.selectedFile}
                follow={state.follow}
                refreshKey={state.editCount}
                onSaved={() => syncChanges(active)}
                // Sent now when Claude is free, queued behind the turn when it's working.
                onSummarizeRequest={
                  state.status === "idle" || state.status === "running"
                    ? (item) => (state.status === "running" ? dispatch({ type: "queue_set", items: [...state.queued, summarizeRequest(item)] }) : sendIn(active, summarizeRequest(item)))
                    : undefined
                }
                revert={{
                  slot: active,
                  blocked: state.status === "running" ? "Wait for Claude to finish before reverting." : null,
                  latestTurn: latestTurnOf(state.items),
                  undo: state.revertUndo,
                  onUndo: () => undoRevert(active),
                  onReverted: (req, outcomes) => revertDone(active, req, outcomes),
                }}
                onSelect={selectFile}
                onFollow={() => dispatch({ type: "follow_latest" })}
              />
            </ErrorBoundary>
          }
        />
        )}
        <SettingsView
          open={settingsAt}
          onClose={() => setSettingsAt(null)}
          slot={state.folder ? active : null}
          live={state.status === "idle" || state.status === "running"}
          mcpTools={state.mcpTools}
          commands={state.commands}
          onCommands={(commands) => dispatch({ type: "ui_event", event: { kind: "commands", commands } })}
          onRestartChat={() => restart(active, state.mode)}
          general={{ notify: notifyPrefs, onNotify: setNotifyPrefs, appearance, onAppearance: setAppearance, textSize, onTextSize: setTextSize }}
          updates={{
            version: updates.version,
            state: updates.state,
            onCheck: updates.check,
            ready: updateOffer ?? null,
            whatsNew: versionsWithNotes(localStorage, [updates.version, update?.version]),
            onWhatsNew: showWhatsNew,
          }}
          harness={{
            saved: presets.slice(1),
            onSave: (next) => {
              setSavedPresets(next);
              // The chat on screen runs its preset as edited (when it's not in the middle of a turn).
              const mine = next.find((h) => h.id === harnessOf(active).id);
              if (mine && state.folder && state.status === "idle" && JSON.stringify(settingsFor(active, mine)) !== JSON.stringify(settingsFor(active))) switchHarness(mine);
            },
            folder: state.folder,
            folderDefault: state.folder ? (harnessByFolder[state.folder] ?? DEFAULT_HARNESS) : DEFAULT_HARNESS,
            onFolderDefault: (id) => state.folder && setHarnessByFolder({ ...harnessByFolder, [state.folder]: id }),
            fallbackModel: defaultModel,
          }}
        />
        {installing && <UpdatingOverlay state={updates.state} version={update?.version ?? null} />}
        {palette && <CommandPalette entries={palette} onClose={() => setPalette(null)} />}
        {shortcutsOpen && <ShortcutSheet available={availableActions().map((a) => a.id)} onClose={() => setShortcutsOpen(false)} />}
        {whatsNew && <WhatsNew version={whatsNew.version} notes={whatsNew.notes} onClose={() => setWhatsNew(null)} />}
        {bringing && (
          <BringOldSessionsDialog
            destination={bringing.destination}
            from={bringing.from}
            pickFolder={() => open({ directory: true, multiple: false }).then((picked) => (typeof picked === "string" ? picked : null))}
            onClose={() => setBringing(null)}
            onRelocated={relocated}
            onOpenHistory={state.folder && bringing.destination === state.folder ? () => { setBringing(null); runAction("session-history"); } : undefined}
          />
        )}
        <ModeGuide
          open={guideAt}
          mode={state.mode}
          flavour={flavour}
          onUse={state.folder && !isBusy(state) ? (key) => {
            setGuideAt(null);
            if (key === "ask" || key === "auto" || key === "steps") changeMode(key);
            else pickFlavour(key);
          } : undefined}
          onClose={() => setGuideAt(null)}
        />
      </div>
    </SessionActionsContext.Provider></ModeGuideContext.Provider></SlotContext.Provider>
  );
}
