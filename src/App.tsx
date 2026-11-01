import { setProviderUsage, setPlanUsage } from "./lib/planUsage";
import { setWeekUsage } from "./lib/weekUsage";
import { pushAgentLimit } from "./lib/agentLimit";
import { pushAutoMergeTests } from "./lib/mergeTests";
import { useAutoTidy } from "./lib/useAutoTidy";
import { pushRestorePoints } from "./lib/restorePointsSetting";
import { agentsAtRest, canSleep, membersToSleep, sweep, teamSlots, teamsAtRest, useSleepMinutes } from "./lib/idleSleep";
import { knownProject, menuBarChats, pushMenuBar, validChatText } from "./lib/menuBar";
import { checkRemoteClose, checkRemoteNewChat, checkRemoteSwitch, windowChats, windowPresets, windowProviders, type RemoteContext, type RemoteNewChat, type RemoteSetPermissions, type RemoteSetPreset, type RemoteSetWorkflow } from "./lib/remoteChats";
import { connectedNames } from "./lib/remoteControl";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, type BranchReview, type ChangeScope, type RestoreResult, type RevertOutcome, type WorkView } from "./api";
import { baseBranchOf, prNumberOf, reviewHints, reviewTargetOf } from "./lib/review";
import { guidesByFlavour, mapNote, pageNote, withPageNote, type Guides } from "./lib/pageNote";
import { openFind } from "./lib/editorFind";
import { summarizeRequest } from "./lib/network";
import { refreshArtifact } from "./lib/artifacts";
import { FREE_UP_SPACE_REQUEST, suggestedCount, useStorageView } from "./components/StorageTab";
import { StoragePanel } from "./components/StoragePanel";
import { StartScreen } from "./components/StartScreen";
import { ReviewPrDialog } from "./components/ReviewPrDialog";
import { TeamWarning } from "./components/TeamWarning";
import { usageRows, workingTeams, type WorkingTeam } from "./lib/usage";
import { windowFocused } from "./lib/windowFocus";
import { initialState, reducer, RUN_PREFIX, type Action, type ChangedFile, type ChatItem, type Status } from "./store";
import { SessionActionsContext, exportFileName, sessionMarkdown, type SessionActions } from "./lib/sessionActions";
import { chatsReducer, chatState, chatTitle, firstPrompt, initialChats, isBusy, queuesToSend, wakesToSend } from "./sessions";
import type { Capabilities, ChatHit, Mode, ProviderInfo, ProviderListing, UiEvent } from "./types";
import { modelOptionsFor } from "./lib/models";
import { CLAUDE, CLAUDE_CAPABILITIES, ProvidersContext, agentName, capabilitiesOf, choicesOf, isGateway, modeOn, providerIdOf, providerName, wireProvider } from "./lib/provider";
import { batchPerFrame } from "./lib/frameBatch";
import { attentionFor } from "./lib/attention";
import { basename } from "./lib/diff";
import { isTyping } from "./lib/typing";
import { withShellContext } from "./lib/shell";
import { prependDraft } from "./lib/paste";
import { withPrompt } from "./lib/promptHistory";
import { latestTurnOf, sinceLabel, withRevertNote, type RevertRequest } from "./lib/revert";
import { withSkillNote } from "./lib/skillNote";
import { BUILT_IN, CUSTOM_HARNESS, customOf, DEFAULT_HARNESS, findHarness, presetsOf, settingsOf, type Harness } from "./lib/harness";
import { describeCommands } from "./lib/complete";
import type { McpIssue } from "./components/CompletionMenu";
import type { CloseAgreed, CloseCheck, McpServer, MenuBarAction, MovedFolder, NewRule, NewWorker, OpenPr, RecentFolder, RelocationEntry, SkillEntry, UpdateInfo } from "./types";
import { LAST_FOLDER, OPEN_CHATS, migrateFolderState, withMovedNote, type Migrated } from "./lib/relocate";
import { BringOldSessionsDialog } from "./components/BringOldSessionsDialog";
import { ProjectNotesDialog } from "./components/ProjectNotesDialog";
import { NotesApplied } from "./components/NotesApplied";
import { notedFolders, notesOf, withNotes } from "./lib/projectNotes";
import { readStored, stepFile, usePersistentState } from "./lib/layout";
import { fromKept, markRead, markUnread, toKeep, unreadBySlot, UNREAD_KEY, type Unread } from "./lib/unread";
import { PROJECT_COLORS } from "./lib/projectColors";
import { NOTIFY_DEFAULTS, NOTIFY_KEY, shouldNotify, type NotifyPrefs } from "./lib/notifyPrefs";
import { applyTheme, readCustomTheme, readTheme, type TextSize } from "./lib/theme";
import { THEMES, isThemeId, readCustom, type CustomTheme, type ThemeId } from "./lib/themes";
import { notify } from "./lib/notify";
import { parseTodoCommand, todoPrompt, useTodoCounts, useTodos, type Todo, type TodoReminder } from "./lib/todos";
import { TodoDoneBar, type TodoChat } from "./components/TodosTab";
import { availableActions, runAction, useAction } from "./lib/actions";
import { useChatHistory } from "./lib/chatHistory";
import type { PaletteEntry } from "./lib/palette";
import { newVersionToShow, notesFor, rememberNotes, versionsWithNotes } from "./lib/whatsNew";
import { NEW_ISSUE_URL } from "./lib/bugReport";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { WhatsNew } from "./components/WhatsNew";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { activityStatus } from "./lib/status";
import { failedCount } from "./lib/activity";
import { scrollWithin } from "./lib/scrollWithin";

import { SlotContext } from "./lib/slot";
import { ModeGuideContext } from "./lib/modeGuide";
import { ModeGuide, type GuideKey } from "./components/ModeGuide";
import { SettingsView, TAB_LABEL, type SettingsTab } from "./components/SettingsView";
import { UpdatingOverlay } from "./components/UpdatingOverlay";
import { isInstalling, useUpdateState } from "./lib/updates";
import { BannerView } from "./components/BannerView";
import { ChatView } from "./components/ChatView";
import { StepsView } from "./components/StepsView";
import { andNext, continueText, pageLabel, pagesOf, pageTitle, UPDATE_MAP } from "./lib/steps";
import { architectureMap, coversOf } from "./lib/architecture";
import { ArchitecturePane } from "./lib/architecturePane";
import { summarize } from "./lib/stepsSummary";
import { canExplain, FLAVOUR_LABEL, flavourState, savedMode, withFlavourNote, type Flavour } from "./lib/flavour";
import { NO_REVIEW, readReview, reviewFor, type ReviewSetting } from "./lib/reviewChain";
import { launchOf, migrateModeSettings, permissionsOf, PERMISSIONS_LABEL, WORKFLOW_LABEL, workflowOf, savedModeOf, type Permissions, type Subagents, type Workflow } from "./lib/workflow";
import { FileLinksProvider } from "./lib/fileLinks";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Hud, type HudEvent } from "./components/Hud";
import { HistoryPopover, type HistoryProject } from "./components/HistoryPopover";
import { Sidebar, SIDEBAR_BAR, SIDEBAR_DEFAULT, sidebarMemory } from "./components/Sidebar";
import { needsYou, openProjects, projectLabels, sidebarProjects } from "./lib/sidebar";
import { clip, deskHistory, FULL_MAX, LOG_MAX, readLog, replyOf, routeCandidates, windowDesk, type DeskEntry } from "./lib/desk";
import { addDesk, deskOf, NO_DESKS, openOn, readDesks, waitingBy } from "./lib/desks";
import { DeskView } from "./components/DeskView";
import { DeskAsk } from "./components/DeskAsk";
import { timelineEvents } from "./lib/timeline";
import { deskInbox, deskProjects as projectRows } from "./lib/deskBoard";
import { useDeskStatus } from "./lib/deskStatus";
import { anythingWorking } from "./lib/awake";
import { useRoutines } from "./lib/useRoutines";
import { type Routine, routineTitle } from "./lib/routines";
import { checkItems, type InboxItem, inboxItems } from "./lib/inbox";
import { useTeamGuards } from "./lib/teamGuards";
import { PlanPaused } from "./components/PlanPaused";
import { usePeek } from "./lib/peek";
import { MessageInput } from "./components/MessageInput";
import { describeInput } from "./components/PermissionCard";
import { ReviewPanel } from "./components/ReviewPanel";
import type { DiffComment } from "./lib/diffComments";
import { ShipDialog } from "./components/ShipDialog";
import { PrChecksDialog } from "./components/PrChecksDialog";
import { settingFor as prSettingFor, type PrSetting } from "./lib/prChecks";
import { usePrChecks } from "./lib/usePrChecks";
import { SetupScreen } from "./components/SetupScreen";
import { Welcome } from "./components/Welcome";
import { RestoreCard } from "./components/RestoreCard";
import { agentSessionsOf, chatsToSave, clearRestoreAfterUpdate, currentFolder, loadSaved, markRestoreAfterUpdate, restoreAfterUpdatePending, restorable, save, savedChatOf, screenFirst, startsNow, sessionModesToSave, toCurrentFolders, withOffered, withoutGone, type SavedChat } from "./lib/restore";
import { SplitPane } from "./components/SplitPane";
import { TopBar } from "./components/TopBar";
import { Canvas, newLayout } from "./components/Canvas";
import { ChatStoreContext, createChatStore, KnownWindowsContext, NodeActionsContext, type NodeActions } from "./lib/canvasContext";
import { windowOf } from "./lib/contextShare";
import { lostText, needingYou, orchestraNodes, teamActivity, teamMain, teamNodes } from "./lib/orchestraView";
import { ProjectSetupContext, pushProjectSetups, runCommandOf, type ProjectSetup, type SetupByFolder } from "./lib/projectSetup";
import { NO_HOOKS, readHooks, type HookTable, type ProjectHooks } from "./lib/chatHooks";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ProjectSetupDialog } from "./components/ProjectSetupDialog";
import { RunPanel } from "./components/RunPanel";
import { SetupNotice } from "./components/SetupNotice";
import "./styles.css";
import { AGENT_MODEL } from "./lib/models";
import { templateMessage, type AgentRole, type TeamTemplate } from "./lib/roles";
import { RoleStoreProvider, TemplateTeamContext, useRoleStoreState } from "./lib/roleStore";
import { TeamTemplateDialog } from "./components/TeamTemplateDialog";

/** How many `name` steps have finished, subagents' included. */
/** Commands the user ran from the chat box that have ended. */
const shellsDone = (items: ChatItem[]) => items.filter((it) => it.type === "shell" && it.status !== "running").length;

function countFinished(items: ChatItem[], name: string): number {
  return items.reduce((n, it) => (it.type === "tool" ? n + (it.name === name && it.status !== "running" ? 1 : 0) + countFinished(it.children, name) : n), 0);
}

/** What an empty Step-by-step chat's box asks, for the flavour picked (or none yet). */
const heroPlaceholder = (agent: string): Record<Flavour | "none", string> => ({
  none: `What are you working on? ${agent} suggests how to go about it`,
  build: "What should we build, step by step?",
  review: "Which change? e.g. Review PR 128, or Review my branch",
  debug: "What's going wrong, and when?",
  architecture: "What should be designed? A feature, a fix, or e.g. PR 128",
});

/** The chat whose merge cards include `worker`'s: its main agent's, even if the worker's own chat has been closed. */
function mergeOwner(chats: { slots: Record<string, { proposals: { worker: string }[] }> }, worker: string): string | undefined {
  return Object.keys(chats.slots).find((slot) => chats.slots[slot].proposals.some((p) => p.worker === worker));
}

/**
 * What a restored chat was in an orchestra. A worker is reopened under its main agent once that has finished opening
 * (`parentReady`), so the backend knows the main agent by the time it adopts the worker.
 */
type TeamRole =
  | { role: "main"; review?: ReviewSetting }
  | { role: "worker"; parent: string; name: string; branch: string | null; base: string | null; isolation: "worktree" | "shared"; agentRole?: AgentRole; hidden?: boolean; model?: string; parentReady?: Promise<boolean> };

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

// A stable empty list, so a chat with no skills loaded yet doesn't hand the composer a new one each render.
const NO_SKILLS: SkillEntry[] = [];

/** `startOnDesk`: the window opens on the Desk (every chat at once) once a chat is open, rather than on the last chat. */
export default function App({ startOnDesk = false }: { startOnDesk?: boolean } = {}) {
  // What older Lanterns saved per project (one mode, Step by step's own auto-approve, how a team ran) becomes the two
  // settings below, before anything reads them.
  useState(() => migrateModeSettings(localStorage));
  // Remembered across launches: each project's last Permissions (Ask or Auto) and Workflow (a project in Step by step stays
  // there; another stays a chat; a Team is not remembered, the next chat in the project starts as a chat). They are what a
  // new chat in the project starts with.
  const [permissionsBy, setPermissionsBy] = usePersistentState<Record<string, Permissions>>("settings.permissionsByFolder", {});
  const [workflowBy, setWorkflowBy] = usePersistentState<Record<string, Workflow>>("settings.workflowByFolder", {});
  // A team's Subagents setting, per project too: the next team in it starts with the last choice.
  const [subagentsBy, setSubagentsBy] = usePersistentState<Record<string, Subagents>>("settings.subagentsByFolder", {});
  // The text the user keeps for each project (Project notes): every chat started in it afterwards is told it. It is Lantern's
  // own, never written into the project's files.
  const [notesBy, setNotesBy] = usePersistentState<Record<string, string>>("settings.projectNotes", {});
  // The project whose notes are being edited.
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const permissionsFor = (folder: string): Permissions => (permissionsBy[folder] === "auto" ? "auto" : "ask");
  const launchFor = (folder: string, team = false) => launchOf(permissionsFor(folder), team ? "team" : workflowBy[folder] === "steps" ? "steps" : "chat");
  // Each session's own mode, so reopening one from History brings back the mode it was in, not the folder's latest.
  // Saved as strings: older ones can name modes that are gone (see savedMode).
  const [sessionModes, setSessionModes] = usePersistentState<Record<string, string>>("settings.modeBySession", {});
  // The conversations of agents (workers of a team): they belong to their team, so the past chats never list them.
  const [agentSessions, setAgentSessions] = usePersistentState<string[]>("session.agentIds", []);
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
  // What each project runs in a new agent's worktree before it starts, and its Run command (see lib/projectSetup.ts).
  const [setupBy, setSetupBy] = usePersistentState<SetupByFolder>("settings.projectSetupByFolder", {});
  const [harnessBySession, setHarnessBySession] = usePersistentState<Record<string, string>>("settings.harnessBySession", {});
  // Which agent CLI each project's new chats start on (absent: Claude Code, as before there was a choice), and each session's
  // when it isn't Claude's. The model and effort of every provider but Claude, whose own are the app-wide ones above.
  const [providerByFolder, setProviderByFolder] = usePersistentState<Record<string, string>>("settings.providerByFolder", {});
  const [providerBySession, setProviderBySession] = usePersistentState<Record<string, string>>("settings.providerBySession", {});
  const [providerPrefs, setProviderPrefs] = usePersistentState<Record<string, { model: string | null; effort: string | null }>>("settings.providerPrefs", {});
  const prefsOf = (id: string) => {
    if (id === CLAUDE) return { model, effort };
    const saved = providerPrefs[id] ?? { model: null, effort: null };
    if (!isGateway(id)) return saved;
    // An endpoint has no default model: a chat on it is on the one chosen if it still lists it, else its first.
    const models = providers.list.find((p) => p.id === id)?.models ?? [];
    return { model: saved.model && models.includes(saved.model) ? saved.model : (models[0] ?? null), effort: null };
  };
  // General: which events are told about (and paused), the theme and the text size.
  const [notifyPrefs, setNotifyPrefs] = usePersistentState<NotifyPrefs>(NOTIFY_KEY, NOTIFY_DEFAULTS);
  // Keep the Mac from idle sleep while anything works (see anythingWorking); anything but off means on.
  const [keepAwakeSaved, setKeepAwake] = usePersistentState<boolean>("settings.keepAwake", true);
  const keepAwake = keepAwakeSaved !== false;
  const [savedTheme, setTheme] = usePersistentState<ThemeId>("settings.theme", readTheme());
  const [savedCustom, setCustomTheme] = usePersistentState<CustomTheme>("settings.customTheme", readCustomTheme());
  // What was saved may be anything (storage is editable): only a known theme and checked colours are used.
  const theme = isThemeId(savedTheme) ? savedTheme : "system";
  const customTheme = useMemo(() => readCustom(savedCustom), [savedCustom]);
  const [textSize, setTextSize] = usePersistentState<TextSize>("settings.textSize", "default");
  useEffect(() => applyTheme(theme, textSize, customTheme), [theme, textSize, customTheme]);
  // Asking before a team starts while another is working ("Don't ask again" turns it off; General brings it back).
  const [warnTeams, setWarnTeams] = usePersistentState<boolean>("settings.warnSecondTeam", true);
  const [teamAsk, setTeamAsk] = useState<{ teams: WorkingTeam[]; go: () => void; cancel?: () => void } | null>(null);
  // Each open chat's preset.
  const [harnessBySlot, setHarnessBySlot] = useState<Record<string, string>>({});
  // The Permissions a paired phone last put each chat on, so that they aren't taken for the project's own choice.
  const phoneMode = useRef<Record<string, Permissions>>({});
  // And the Workflow a phone last put each chat on, likewise.
  const phoneFlow = useRef<Record<string, Workflow>>({});
  // Every open chat. The one on screen is `active`; the others keep running in the background.
  const [chats, dispatchChats] = useReducer(chatsReducer, undefined, () => initialChats({ ...initialState, ...(lastFolder ? { mode: launchFor(lastFolder).mode, autoApprove: launchFor(lastFolder).autoApprove } : {}) }));
  const active = chats.active;
  const state = chats.slots[active];
  // An orchestra shows as a canvas of its agents or as one chat at a time. The canvas's layout is kept here, so going to a
  // chat and back finds the agents where they were; its chats are handed to it through a store, so each agent redraws only
  // for its own chat.
  const [view, setView] = useState<"chat" | "canvas">("chat");
  // The Desk: every open chat at once, in place of the chat (see DeskView). Going to a chat puts it away.
  const [desk, setDesk] = useState(startOnDesk);
  // The Desks (see lib/desks.ts) and the messages typed on them (see lib/desk.ts), kept across launches.
  const [desksStored, setDesks] = usePersistentState<unknown>("desk.desks", NO_DESKS);
  const desks = useMemo(() => readDesks(desksStored), [desksStored]);
  const [deskLog, setDeskLog] = useState<DeskEntry[]>(() => readLog(readStored("desk.log", [])));
  useEffect(() => {
    try {
      localStorage.setItem("desk.log", JSON.stringify(deskLog.slice(-LOG_MAX)));
    } catch {
      // storage unavailable; the Desk's messages just won't survive a restart
    }
  }, [deskLog]);
  const canvasLayout = useRef(newLayout());
  const [chatStore] = useState(createChatStore);
  chatStore.assign(chats.slots);
  useLayoutEffect(() => chatStore.notify(), [chats.slots, chatStore]);
  const reopened = useRef(false);
  // This launch follows a restart to update, which asked for the chats back: they are restored by themselves, not offered.
  // The window's own restart marks it in storage; a restart that bypassed the window (a swap script) leaves a file, read once here.
  const [restoringAfterUpdate, setRestoringAfterUpdate] = useState(restoreAfterUpdatePending);
  const [markerChecked, setMarkerChecked] = useState(false);
  useEffect(() => {
    api.takeRestoreMarker().then(
      (asked) => {
        if (asked) setRestoringAfterUpdate(true);
        setMarkerChecked(true);
      },
      () => setMarkerChecked(true),
    );
  }, []);
  // The offered agents whose worktrees are gone have been left out (nothing to check counts as checked).
  const [goneChecked, setGoneChecked] = useState(false);
  const slotSeq = useRef(1);
  // Each chat's unsent text, so switching away and back doesn't lose it. A ref: typing needn't re-render the app.
  const drafts = useRef<Record<string, string>>({});
  // How to start a chat again when its start failed: claude never got far enough to be restarted (see the banner).
  const relaunch = useRef<Record<string, () => void>>({});
  // Counts each chat's starts, so one that was cancelled can tell its late answer is stale.
  const startGen = useRef<Record<string, number>>({});
  // The chats being woken from sleep (see Status): until their history is back they have no messages, but aren't empty chats to close.
  const waking = useRef(new Set<string>());
  // Whether the right pane is hidden, per project like the mode. The old app-wide setting is the default.
  const [collapsedDefault, setCollapsedDefault] = usePersistentState("review.collapsed", false);
  const [collapsedBy, setCollapsedBy] = usePersistentState<Record<string, boolean>>("review.collapsedByFolder", {});
  // On the canvas the panel is one setting for the whole team: which agent's chat is on screen there changes as agents are
  // clicked, and each has a folder of its own.
  const canvasMain = view === "canvas" ? teamMain(chats, active) : null;
  const showCanvas = canvasMain !== null;
  const [canvasPanel, setCanvasPanel] = usePersistentState("review.canvasPanel", false);
  const reviewCollapsed = showCanvas ? !canvasPanel : ((state.folder ? collapsedBy[state.folder] : undefined) ?? collapsedDefault);
  const setReviewCollapsed = (collapsed: boolean) => {
    // Opening it shows something of the chat (a file, Changes, a search): the Desk, whose right pane is Ask, steps aside for it.
    if (!collapsed) setDesk(false);
    if (showCanvas) setCanvasPanel(!collapsed);
    else if (state.folder) setCollapsedBy({ ...collapsedBy, [state.folder]: collapsed });
    else setCollapsedDefault(collapsed);
  };
  const [splitRatio, setSplitRatio] = usePersistentState("review.ratio", 0.5);
  // On the Desk the right pane is Ask: open or not, and how wide, its own, not the project's Changes.
  const [askCollapsed, setAskCollapsed] = usePersistentState("desk.askCollapsed", false);
  const [askRatio, setAskRatio] = usePersistentState("desk.askRatio", 0.68);
  // The Changes pane's filter: everything this chat changed, or only what the last turn changed.
  const [changeScope, setChangeScope] = usePersistentState<ChangeScope>("review.scope", "session");
  const [turnFiles, setTurnFiles] = useState<ChangedFile[]>([]);
  // The agent whose branch a merge card asked to see in Changes, and the base to compare it with (null: Lantern finds it);
  // `key` brings the Changes tab up each time.
  const [branchPeek, setBranchPeek] = useState<{ slot: string; base: string | null; key: number } | null>(null);
  // Review comments on diff lines, kept for each chat while the app runs (a worker's branch review is its own chat's).
  const [diffComments, setDiffComments] = useState<Record<string, DiffComment[]>>({});
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
  useAction("find-in-file", () => void openFind(), !reviewCollapsed && !desk);
  // Per chat: which failed steps the title bar's count was cleared for.
  const [clearedFailures, setClearedFailures] = useState<Record<string, string>>({});
  // A test run the chat asked the right pane to show.
  const [focusRun, setFocusRun] = useState<{ id: string; key: number } | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  // The backend checks the user's limit on agents running at once: it learns it from here.
  useEffect(() => {
    void pushAgentLimit();
    void pushAutoMergeTests();
    void pushRestorePoints();
    // The menu bar item is built by the backend from the user's choice: it learns it from here.
    void pushMenuBar();
  }, []);
  // The backend runs a project's setup in a new worktree, and its Run command: it learns both from here, at launch and on every save.
  useEffect(() => {
    void pushProjectSetups(setupBy);
  }, [setupBy]);
  // The pre- and post-hook (Settings → Hooks): the same for every project, and a project's own in place of them. The backend
  // applies them where a message goes out and a turn ends: it learns them from here, at launch and on every change.
  const [hooksAll, setHooksAll] = usePersistentState<Pick<HookTable, "pre" | "post">>("settings.chatHooks", { pre: NO_HOOKS.pre, post: NO_HOOKS.post });
  const [hooksBy, setHooksBy] = usePersistentState<Record<string, ProjectHooks>>("settings.chatHooksByFolder", {});
  const chatHooks = useMemo(() => readHooks({ ...hooksAll, projects: hooksBy }), [hooksAll, hooksBy]);
  useEffect(() => {
    api.setChatHooks(chatHooks).catch(() => {});
  }, [chatHooks]);
  // When each chat's last turn ended, for the title bar's "Done | Today at 19:22".
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
    const unlisten = api.onUiEvent((slot, event) => {
      // The plan's usage is the account's, not the chat's: kept once, for the top bar and the canvas.
      if (event.kind === "provider_usage") setProviderUsage(event.usage);
      else if (event.kind === "plan_usage") setPlanUsage({ used: event.used, resetsAt: event.resets_at });
      else if (event.kind === "week_usage") setWeekUsage({ used: event.used, resetsAt: event.resets_at });
      else batch.push({ slot, event });
    });
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

  // The chats routines started, by slot: each runs on the model its routine names (while it is on the standard preset), and is called "Routine: name".
  const routineSlots = useRef<Record<string, { name: string; model: string | null }>>({});
  // The agent CLIs a chat can run on: Claude Code, and each other that is installed. Until the backend answers (or when it
  // can't) there is only Claude Code, which is all a window with one provider ever shows.
  const [providerList, setProviderList] = useState<ProviderListing[] | null>(null);
  useEffect(() => {
    api.listProviders().then(setProviderList, () => setProviderList([]));
  }, []);
  const providers = useMemo(() => choicesOf(providerList && state.claudePath && !providerList.some((p) => p.id === CLAUDE) ? [{ id: CLAUDE, capabilities: CLAUDE_CAPABILITIES, binary: state.claudePath, models: ["opus", "sonnet", "haiku"] }, ...providerList] : providerList), [providerList, state.claudePath]);
  /** A provider the chat can start on: Claude Code always (the window has found it), another only while its CLI is installed. */
  const listingOf = (id: string) => providers.list.find((p) => p.id === id);
  const isAvailable = (id: string) => (id === CLAUDE && !!state.claudePath) || !!listingOf(id);
  const agentReady = !!state.claudePath || providers.list.some((p) => !!p.binary);
  useEffect(() => { if (agentReady && state.status === "setup") dispatch({ type: "agent_available" }); }, [agentReady, state.status]);
  /**
   * The program that starts a chat on provider `id`: Claude Code's, which the window found, for Claude and for every endpoint
   * (an endpoint is Claude Code sent elsewhere), but only while the endpoint is still set up: a chat on one that was deleted
   * is never started on Claude instead. Another provider's own program otherwise. None when it can't be started.
   */
  const binaryOf = (id: string) => (id === CLAUDE ? (state.claudePath ?? listingOf(id)?.binary) : isGateway(id) ? (listingOf(id) ? state.claudePath : undefined) : listingOf(id)?.binary);
  /** What a project's new chats run on: its choice, if that provider is still there. */
  const providerFor = (folder: string | null) => {
    const id = folder ? providerByFolder[folder] : undefined;
    return id && isAvailable(id) ? id : isAvailable(CLAUDE) ? CLAUDE : providers.list[0]?.id ?? CLAUDE;
  };
  /** The provider a chat is on and what it can do; Claude Code's until told otherwise. */
  const infoOf = (id: string): ProviderInfo | null => {
    const l = listingOf(id);
    return l ? { id: l.id, capabilities: l.capabilities } : null;
  };
  const configuredRef = useRef<(r: Parameters<Parameters<typeof api.onConversationConfigured>[0]>[0]) => void>(() => {});
  configuredRef.current = (r) => {
    to(r.slot)({ type: "provider_set", provider: r.provider });
    to(r.slot)({ type: "mode_changed", mode: r.mode, autoApprove: r.autoApprove });
    to(r.slot)({ type: "session_ready" });
    if (r.provider.id === CLAUDE) { setModel(r.model); setEffort(r.effort); }
    else setProviderPrefs({ ...providerPrefs, [r.provider.id]: { model: r.model, effort: r.effort } });
  };
  useEffect(() => {
    const off = api.onConversationConfigured((r) => configuredRef.current(r));
    return () => { off.then((f) => f()); };
  }, []);
  const capsOf = (slot: string) => capabilitiesOf(chats.slots[slot]?.provider);
  const caps = capabilitiesOf(state.provider);
  const activeProvider = providerIdOf(state.provider);

  // The harness (which models do what) is Claude Code's: a provider with no advisor runs Standard, its own model and effort.
  const harnessFor = (c: { supports_advisor: boolean }, id: string | undefined | null) => (c.supports_advisor ? findHarness(presets, id) : BUILT_IN[0]);
  const harnessOf = (slot: string) => harnessFor(capsOf(slot), harnessBySlot[slot]);
  /** A launch on a provider with no Auto: Ask, whatever the Permissions asked for (what the backend caps to as well). */
  const onProvider = (l: { mode: Mode; autoApprove: boolean }, can: Capabilities) => (can.supports_auto_mode ? l : { mode: modeOn(l.mode, can), autoApprove: false });
  /**
   * What a chat runs with: its preset's models, or (Default) the model and effort chosen for its provider; a routine's chat on
   * Claude runs on the model its routine names. `provider`: the chat's, when it isn't in `chats` yet (it is being started). A
   * provider with no effort level is given none.
   */
  const settingsFor = (slot: string, h: Harness = harnessOf(slot), provider: ProviderInfo | null = chats.slots[slot]?.provider ?? null) => {
    const id = providerIdOf(provider);
    const prefs = id === CLAUDE && h.id === DEFAULT_HARNESS && slot in routineSlots.current ? { model: routineSlots.current[slot].model, effort } : prefsOf(id);
    const s = settingsOf(h, prefs);
    return capabilitiesOf(provider).supports_effort ? s : { ...s, effort: null };
  };

  /** `change`: Step by step's Permissions and Workflow Team, when this restart is what sets them (see `launchOf`); else the chat keeps its own. */
  const restart = (slot: string, mode: Mode, withEffort: string | null = settingsFor(slot).effort, change: { autoApprove?: boolean; team?: boolean } = {}) => {
    to(slot)({ type: "restarting" });
    api.restartSession(slot, mode, withEffort, (change.autoApprove ?? chats.slots[slot]?.autoApprove ?? false) && capsOf(slot).supports_auto_mode, change.team ?? null).then(() => to(slot)({ type: "session_ready" })).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
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
   * is closed. Open chats are closed from the sidebar.
   */
  const leave = (slot: string) => {
    const s = chats.slots[slot];
    if (!s || s.items.length > 0 || isBusy(s) || drafts.current[slot]?.trim() || s.status === "asleep" || waking.current.has(slot)) return;
    forget(slot);
  };

  // Gives up on a start that never answers: whatever it says later is ignored, and the banner offers another go.
  const cancelStart = (slot: string) => {
    startGen.current[slot] = (startGen.current[slot] ?? 0) + 1;
    api.closeSession(slot).catch(() => {});
    to(slot)({ type: "failed", text: `${agentName(chats.slots[slot]?.provider)} didn't start.` });
  };

  /**
   * Closes chats from the sidebar, the one on screen too: the app then goes to another chat (a project's, else any), or
   * to the start screen when none is left. Asking whether to stop something that is working is the sidebar's job.
   */
  const closeChats = (slots: string[]) => {
    dispatchChats({ type: "close", slots, fresh: `s${++slotSeq.current}` });
    for (const slot of slots) {
      delete drafts.current[slot];
      delete relaunch.current[slot];
      api.closeSession(slot).catch(() => {});
    }
  };

  // How each team was left: the chat that was full size, or "canvas". Going back to a team's Lead finds it that way, and
  // falls back to the canvas for a chat that has been closed since.
  const teamView = useRef<Record<string, string>>({});
  const viewOf = (team: string) => {
    const left = teamView.current[team];
    if (left === undefined) return null;
    return left !== "canvas" && chats.slots[left] && teamMain(chats, left) === team ? left : "canvas";
  };
  const switchTo = (slot: string) => {
    if (chats.slots[slot]) setDesk(false);
    if (slot === active || !chats.slots[slot]) return;
    const left = chats.slots[slot].orchestrator ? viewOf(slot) : null;
    const shown = left && left !== "canvas" ? left : slot;
    dispatchChats({ type: "activate", slot: shown });
    if (left) setView(left === "canvas" ? "canvas" : "chat");
    leave(active);
    const folder = chats.slots[shown].folder;
    if (folder) setLastFolder(folder);
  };
  // Back (the title bar's arrow, ⌘[): the chats shown before this one, newest first, those still open.
  const chatHistory = useChatHistory(active, (slot) => !!chats.slots[slot], (slot) => switchTo(slot));
  // The chat opened from the Desk (its timeline, a project's row, Needs you, a file): Back takes it back to the Desk. Putting the
  // Desk away with its own button isn't opening a chat from it.
  const [deskReturn, setDeskReturn] = useState<string | null>(null);
  const deskByButton = useRef(false);
  const wasDesk = useRef(desk);
  useEffect(() => {
    if (wasDesk.current && !desk) setDeskReturn(deskByButton.current ? null : active);
    if (desk) setDeskReturn(null);
    deskByButton.current = false;
    wasDesk.current = desk;
  }, [desk]);
  const backToDesk = deskReturn !== null && deskReturn === active && !desk;
  const goBack = backToDesk ? () => setDesk(true) : chatHistory.canGoBack ? chatHistory.goBack : undefined;
  useAction("go-back", () => goBack?.(), !!goBack);

  /**
   * The chat to start something new in: the one on screen if it's still empty, otherwise a new one (and the current
   * chat is left: kept in the background if busy, closed if not). A chat that is still starting isn't reused: its start
   * is on its way, and a second one would race it.
   */
  const takeSlot = (): string => {
    if (state.items.length === 0 && !isBusy(state) && state.status !== "starting" && state.status !== "asleep") return active;
    const slot = `s${++slotSeq.current}`;
    dispatchChats({ type: "add", slot });
    dispatchChats({ type: "activate", slot });
    leave(active);
    return slot;
  };

  // `quiet`: reopening the remembered project at launch; if that fails (e.g. the folder is gone), just forget it.
  const startFresh = (folder: string, quiet = false, team = false, first?: string, review?: ReviewSetting) => {
    if (agentReady) startIn(takeSlot(), folder, quiet, team, first, undefined, review);
  };

  // To-dos (see lib/todos.ts). A chat started from an item (its ▶) is linked to it, and asks "Mark done?" when a turn ends;
  // `asked` is how far the chat was when the user said "Not yet", so it asks again after the next turn.
  const [todoChats, setTodoChats] = useState<Record<string, { folder: string; id: string; asked: number }>>({});
  const [todosOpenKey, setTodosOpenKey] = useState(0);
  const startTodo = (folder: string, todo: Todo) => {
    if (!agentReady) return;
    const slot = takeSlot();
    startIn(slot, folder, false, false, todoPrompt(todo));
    setTodoChats((all) => ({ ...all, [slot]: { folder, id: todo.id, asked: -1 } }));
    void api.todosEdit(folder, { op: "link", id: todo.id, chat: slot, title: todo.title }).catch(() => {});
  };
  // "/todo …" in the message box adds to the project's list instead of going to Claude, and shows it in the Todos tab.
  const addTodoFromBox = (text: string): boolean => {
    const cmd = parseTodoCommand(text);
    if (!cmd) return false;
    if (!state.folder) {
      dispatch({ type: "failed", text: "Open a folder first: a to-do belongs to a project." });
      return true;
    }
    if (!cmd.title) {
      setTodosOpenKey((k) => k + 1);
      return true;
    }
    api.todosEdit(state.folder, { op: "add", title: cmd.title, due: cmd.due }).then(
      () => setTodosOpenKey((k) => k + 1),
      (e) => dispatch({ type: "failed", text: errText(e) }),
    );
    return true;
  };
  const todoList = useTodos(state.folder);
  // A to-do's reminder went off (the backend pushes it to phones too): one notification per project.
  useEffect(() => {
    const unlisten = api
      .onTodosRemind((due: TodoReminder[]) => {
        const byProject = new Map<string, TodoReminder[]>();
        for (const r of due) byProject.set(r.key, [...(byProject.get(r.key) ?? []), r]);
        for (const [key, list] of byProject) notify(basename(key), list.length === 1 ? `Due: ${list[0].todo.title}` : `${list.length} to-dos are due`, "reminder");
      })
      .catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
  }, []);

  /**
   * `team`: the chat is the Lead of a team, which can start agents, on the project's last Permissions (the agents never exceed them).
   * `first`: a team from a template: the Lead's first instruction, which names its members and their roles.
   * `routine`: a routine's chat, on the routine's own Permissions (never the project's) and the standard preset; it doesn't become the project to reopen.
   * `remote`: a chat a paired phone started: on Ask, or on Auto when the Mac's Settings let phones use it (the caller has checked),
   * whatever the project's Permissions are, and on the preset the phone chose (else the project's own); it doesn't become the
   * project to reopen either, and neither the project's Permissions nor its preset are remembered from it.
   * `providerId`: the agent CLI it runs on, by default the one the project's new chats start on (a team's Lead is always Claude
   * Code's: it is the one that has Lantern's tools to start agents with).
   */
  const startIn = (slot: string, folder: string, quiet = false, team = false, first?: string, routine?: Routine, review?: ReviewSetting, remote: { permissions: Permissions; preset: string | null; workflow: "chat" | "steps" } | false = false, providerId: string = team ? CLAUDE : providerFor(folder)) => {
    if (!agentReady) return;
    // A chat opened before the last project was reopened (that waits on the moves): it isn't reopened over it later.
    reopened.current = true;
    // A team's Lead runs on the project's last Permissions, which its agents never exceed; Team is not remembered as the
    // project's Workflow (see the effect below).
    const info = infoOf(providerId);
    const binary = binaryOf(providerId);
    const can = capabilitiesOf(info);
    // A provider with no Auto runs on Ask.
    const { mode, autoApprove } = onProvider(remote ? launchOf(remote.permissions, remote.workflow) : routine ? launchOf(routine.permissions, "chat") : launchFor(folder, team), can);
    const orchestrator = team;
    const h = routine ? BUILT_IN[0] : harnessFor(can, remote && remote.preset ? remote.preset : harnessByFolder[folder]);
    setHarnessBySlot((all) => ({ ...all, [slot]: h.id }));
    to(slot)({ type: "folder_opened", folder });
    // Known before the start answers, so what the provider lacks is never shown, even for a moment.
    if (info) to(slot)({ type: "provider_set", provider: info });
    to(slot)({ type: "mode_changed", mode, autoApprove });
    to(slot)({ type: "orchestrator_set", on: orchestrator });
    if (!binary) return to(slot)({ type: "failed", text: isGateway(providerId) ? `${providerName(providerId)} isn't set up any more: add it back in Settings → Endpoints.` : `${providerName(providerId)} isn't installed.` });
    if (!quiet) relaunch.current[slot] = () => startIn(slot, folder, false, team, first, routine, review, remote, providerId);
    // The notes the chat starts with: what is saved now, which a later change doesn't reach.
    const notes = notesOf(notesBy, folder);
    to(slot)({ type: "notes_applied", text: notes || null });
    const gen = (startGen.current[slot] = (startGen.current[slot] ?? 0) + 1);
    api.startSession(slot, binary, folder, { ...wireProvider(providerId), mode, ...settingsFor(slot, h, info), auto_approve: autoApprove, ...(orchestrator ? { orchestrator } : {}), ...(notes ? { project_notes: notes } : {}) }).then(
      (provider) => {
        if (startGen.current[slot] !== gen) return;
        // (The backend calls every endpoint "gateway": the chat is known by which one.)
        if (provider) to(slot)({ type: "provider_set", provider: { ...provider, id: providerId } });
        delete relaunch.current[slot];
        if (orchestrator) {
          startSubagents(slot, folder);
          startRoles(slot, folder);
          startReview(slot, review);
        }
        if (!routine && !remote) setLastFolder(folder);
        to(slot)({ type: "session_ready" });
        // A team from a template: the Lead's first instruction names its members and their roles.
        if (first) doingRef.current.send(slot, first);
      },
      (e) => {
        if (startGen.current[slot] !== gen) return;
        if (!quiet) return to(slot)({ type: "failed", text: errText(e) });
        setLastFolder(null);
        to(slot)({ type: "folder_cleared" });
      },
    );
  };

  /**
   * An empty chat is moved to another provider: it is the project's new choice (its next chats start there too), and the chat
   * starts again on it, which replaces the CLI that was running with nothing said to it yet.
   */
  const chooseProvider = (id: string) => {
    const folder = state.folder;
    if (!folder || id === activeProvider || !isAvailable(id)) return;
    if (state.items.length > 0) {
      if (isBusy(state) || state.status !== "idle" || chats.agents[active]) return;
      if (state.backgroundTasks.length > 0) return dispatch({ type: "failed", text: "Stop this chat's background tasks before switching providers." });
      {
        dispatch({ type: "restarting" });
        api.conversationSettings(active, { provider: id, ...prefsOf(id) }).then((config) => {
          dispatch({ type: "provider_set", provider: { id: config.provider, capabilities: config.capabilities } });
          dispatch({ type: "session_ready" });
          setProviderByFolder({ ...providerByFolder, [folder]: id });
          if (state.sessionId) setProviderBySession({ ...providerBySession, [state.sessionId!]: id });
        }).catch((e) => { dispatch({ type: "session_ready" }); dispatch({ type: "failed", text: errText(e) }); });
      }
      return;
    }
    setProviderByFolder({ ...providerByFolder, [folder]: id });
    // A provider that can't lead a team starts it as a plain chat: its Workflow leaves Team.
    startIn(active, folder, false, state.orchestrator && capabilitiesOf(infoOf(id)).can_lead_team, undefined, undefined, undefined, false, id);
  };

  useEffect(() => {
    // Not a worker's: its folder is a worktree that's gone with it, and its Permissions are capped by its Lead. Nor a routine's:
    // looking at one must not make the project's next chat start on its Permissions.
    // Nor an asleep chat's, which has the mode of whichever chat was open when it was made, until it wakes on its own.
    if (!state.folder || chats.agents[active] || routineSlots.current[active] || state.status === "asleep") return;
    const permissions = permissionsOf(state);
    // A phone's switch isn't the project's next default: nobody chose it at the Mac (a change here forgets it, and counts).
    const fromPhone = phoneMode.current[active] === permissions;
    // A chat on a provider with no Auto runs on Ask where the project's Permissions are Auto: that is the provider's limit, not
    // the user's choice, so it doesn't replace what the project is set to.
    const capped = !caps.supports_auto_mode && permissions === "ask" && permissionsBy[state.folder] === "auto";
    if (!fromPhone && !capped && permissionsBy[state.folder] !== permissions) setPermissionsBy({ ...permissionsBy, [state.folder]: permissions });
    // A Team is the chat's own: the project's next chat starts as a chat (or in Step by step, if that is where it was).
    const workflow = workflowOf(state);
    if (workflow !== "team" && phoneFlow.current[active] !== workflow && workflowBy[state.folder] !== workflow) setWorkflowBy({ ...workflowBy, [state.folder]: workflow });
  }, [state.mode, state.autoApprove, state.orchestrator, state.folder]);
  // Every open chat's, not just the one on screen: a worker's mode is set in the background (and may be lowered there).
  const modesKey = Object.values(chats.slots).map((s) => `${s.sessionId}:${savedModeOf(s)}`).join(" ");
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
  // (Claude's: the model another provider's chat runs is not Claude Code's default.)
  useEffect(() => {
    if (activeProvider !== CLAUDE) return;
    if (model === null && state.model) setDefaultModel(state.model);
    else if (model && state.model?.includes(model) && modelIds[model] !== state.model) setModelIds({ ...modelIds, [model]: state.model });
  }, [model, state.model, activeProvider]);
  // A session on a provider other than Claude is remembered as such, so reopening it from History starts that provider's CLI.
  useEffect(() => {
    const news = Object.values(chats.slots).filter((s) => s.sessionId && providerBySession[s.sessionId] !== providerIdOf(s.provider));
    if (news.length) setProviderBySession({ ...providerBySession, ...Object.fromEntries(news.map((s) => [s.sessionId!, providerIdOf(s.provider)])) });
  }, [chats.slots]);

  // Chats on another provider than Claude come back once the providers are known (with Claude alone there is nothing to wait for).
  const waitsForProviders = providerList === null && [...Object.values(providerBySession), ...Object.values(providerByFolder)].some((p) => p !== CLAUDE);
  // After a restart to update the chats that were open come back by themselves, in place of the last project (which the
  // first of them is, or else the project is reopened as usual). Ahead of that effect, which it then keeps from running.
  useEffect(() => {
    if (!restoringAfterUpdate || !agentReady || !moves || !goneChecked || !markerChecked || waitsForProviders) return;
    clearRestoreAfterUpdate();
    setRestoringAfterUpdate(false);
    // Something was opened meanwhile: nothing is restored over it, and the card is back.
    if (!reopened.current && state.status === "no_folder" && offer.length > 0) {
      reopened.current = true;
      restoreAll();
    }
  }, [restoringAfterUpdate, agentReady, moves, goneChecked, markerChecked, waitsForProviders]);

  // Reopen the last project once claude has been found (where it is now, if it moved), unless the chats are coming back instead.
  useEffect(() => {
    if (!markerChecked || restoringAfterUpdate || reopened.current || state.status !== "no_folder" || !agentReady || !moves || waitsForProviders) return;
    reopened.current = true;
    if (lastFolder) startFresh(here(lastFolder), true);
  }, [markerChecked, restoringAfterUpdate, state.status, agentReady, moves, waitsForProviders]);

  const openFolder = async () => {
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder !== "string") return;
    // A folder removed from the recents comes back when it is opened on purpose.
    if (hiddenFolders.includes(folder)) setHiddenFolders(hiddenFolders.filter((f) => f !== folder));
    startFresh(folder);
  };

  // The past chats of a project: the user's own. An agent's conversation (a shared one is in the project's folder too) stays with its team.
  const listPast = (folder: string) => api.listSessions(folder).then((all) => all.filter((x) => !agentSessions.includes(x.id)));
  // The chats whose text has the query, without the ones agents ran (as listPast does).
  const searchPast = (query: string) => api.searchHistory(query).then((r) => ({ ...r, chats: r.chats.filter((c) => !agentSessions.includes(c.id)) }));
  const loadSessions = () => (state.folder ? listPast(state.folder) : Promise.resolve([]));

  // Replays a past session into a chat, then continues it with `claude --resume`. A session that's already open
  // in a chat is switched to instead.
  // `folder`: the project it belongs to, which may not be the one on screen (the sidebar lists every project's chats).
  const openSession = (sessionId: string, inFolder: string | null = state.folder) => {
    const already = Object.entries(chats.slots).find(([, s]) => s.sessionId === sessionId);
    if (already) return switchTo(already[0]);
    const folder = inFolder;
    if (!agentReady || !folder) return;
    // An empty chat is reused; if it was in another project it starts over in this one.
    const empty = state.items.length === 0 && !isBusy(state);
    const reuse = empty && state.folder === folder;
    // A second open into the chat that's still loading would load another session into it: ignored.
    if (empty && state.status === "starting") return;
    resumeIn(takeSlot(), folder, sessionId, reuse);
  };

  /**
   * `team`: the chat was part of an orchestra: a main agent (reopened as one), or a worker of an open main agent, which
   * is reopened as its worker once that main agent has finished opening (`parentReady`; the backend adopts a worker only
   * into a main agent it already knows). Resolves to whether the chat opened.
   */
  const resumeIn = async (slot: string, folder: string, sessionId: string, reuse = false, team?: TeamRole): Promise<boolean> => {
    if (!agentReady) return Promise.resolve(false);
    reopened.current = true;
    // The provider it ran on: Claude's unless it was saved as another's (a session from before there was a choice is Claude's).
    const providerId = (await api.conversationMetadata(sessionId).catch(() => null)) ?? providerBySession[sessionId] ?? CLAUDE;
    const info = infoOf(providerId);
    const binary = binaryOf(providerId);
    const can = capabilitiesOf(info);
    // The mode it was last in (and for an older Debug, Teach or Review session, that flavour of Step by step); one from
    // before modes were kept per session reopens as a plain chat, not as whatever this folder's newest chat is doing.
    const saved = savedMode(sessionModes[sessionId]);
    const { flavour: flavourStart, explain: explainStart } = saved;
    // Step by step's Permissions: as the session saved them, else (an older save) the project's. A provider with no Auto
    // reopens it on Ask.
    const { mode, autoApprove } = onProvider({ mode: saved.mode, autoApprove: saved.mode === "steps" && (saved.autoApprove ?? permissionsFor(folder) === "auto") }, can);
    // The preset it last ran with, else the folder's.
    const h = harnessFor(can, harnessBySession[sessionId] ?? harnessByFolder[folder]);
    setHarnessBySlot((all) => ({ ...all, [slot]: h.id }));
    to(slot)(reuse ? { type: "restarting" } : { type: "folder_opened", folder });
    if (info) to(slot)({ type: "provider_set", provider: info });
    to(slot)({ type: "mode_changed", mode, autoApprove, flavourStart, explainStart });
    if (!binary) {
      // (An endpoint that is gone is never swapped for Claude: the chat's words would go somewhere its user didn't choose.)
      to(slot)({ type: "failed", text: isGateway(providerId) ? `${providerName(providerId)} isn't set up any more, so this chat can't be reopened. Add it back in Settings → Endpoints.` : `${providerName(providerId)} isn't installed, so this chat can't be reopened.` });
      return Promise.resolve(false);
    }
    to(slot)({ type: "orchestrator_set", on: team?.role === "main" });
    // A worker is part of its team from the start, not only once it has opened: until then it would be an ordinary chat in the sidebar.
    if (team?.role === "worker") dispatchChats({ type: "adopt", slot, meta: { parent: team.parent, name: team.name, brief: "", folder, branch: team.branch, base: team.base, isolation: team.isolation, ...(team.agentRole ? { role: team.agentRole } : {}), ...(team.hidden ? { hidden: true } : {}) } });
    // Trying again later doesn't wait on a main agent that has long since opened (or not).
    const again: TeamRole | undefined = team?.role === "worker" ? { ...team, parentReady: undefined } : team;
    relaunch.current[slot] = () => void resumeIn(slot, folder, sessionId, reuse, again);
    const gen = (startGen.current[slot] = (startGen.current[slot] ?? 0) + 1);
    // An agent is told its Lead's notes (the app looks them up), not the notes of its worktree's folder.
    const notes = team?.role === "worker" ? "" : notesOf(notesBy, folder);
    const open = (as: TeamRole | undefined) =>
      api.openSession(
        slot,
        binary,
        folder,
        // An agent comes back on the model it had (or, on Claude, Sonnet, the agents' default), not on its project's own model.
        { ...wireProvider(providerId), mode, ...settingsFor(slot, h, info), ...(as?.role === "worker" ? { model: as.model ?? (providerId === CLAUDE ? AGENT_MODEL : null) } : {}), auto_approve: autoApprove, ...(as?.role === "main" ? { orchestrator: true } : {}), ...(notes ? { project_notes: notes } : {}), ...(as?.role === "worker" ? { worker: { name: as.name, parent: as.parent, branch: as.branch, shared: as.isolation === "shared", read_only: !!as.agentRole?.read_only, ...(as.agentRole ? { role: as.agentRole } : {}) } } : {}) },
        sessionId,
      );
    // A worker waits for its main agent: if that one didn't open, this one stays closed too, under it, where Retry can try again.
    const adopted = team?.role === "worker" && team.parentReady ? team.parentReady.then((ok) => (ok ? team : Promise.reject("Its Lead didn't open, so this agent can't come back yet."))) : Promise.resolve(team);
    return adopted
      .then((as) => open(as).then((opened) => ({ opened, as })))
      .then(({ opened, as }) => {
        if (startGen.current[slot] !== gen) return false;
        if (opened.provider) to(slot)({ type: "provider_set", provider: { ...opened.provider, id: opened.provider.id === "gateway" ? providerId : opened.provider.id } });
        // Not resumed (its copy into this folder failed): the transcript is shown, and Retry copies it again.
        if (opened.read_only) {
          to(slot)({ type: "history_loaded", sessionId, events: opened.events, earlier: opened.earlier });
          to(slot)({ type: "failed", text: opened.read_only });
          return false;
        }
        delete relaunch.current[slot];
        if (as?.role === "main") {
          startSubagents(slot, folder);
          startRoles(slot, folder);
          startReview(slot, as.review);
        }
        to(slot)({ type: "history_loaded", sessionId, events: opened.events, movedFrom: opened.moved_from, earlier: opened.earlier });
        if (notes) to(slot)({ type: "notes_applied", text: notes });
        to(slot)({ type: "session_ready" });
        return true;
      })
      .catch((e) => {
        if (startGen.current[slot] === gen) to(slot)({ type: "failed", text: errText(e) });
        return false;
      });
  };

  // "Show earlier messages": the turns before the ones a long session opened with. They come from the transcript each time,
  // so the window never holds more of the session than is on screen.
  const loadEarlier = (slot: string): Promise<void> => {
    const s = chats.slots[slot];
    if (!s?.sessionId || !s.folder || s.earlierTurns <= 0) return Promise.resolve();
    const { sessionId, folder, earlierTurns: expected } = s;
    return api.earlierEvents(folder, sessionId, expected).then(
      (page) => to(slot)({ type: "earlier_loaded", sessionId, events: page.events, expected, hidden: page.hidden }),
      (e) => to(slot)({ type: "earlier_failed", text: `Couldn't load the earlier messages: ${errText(e)}` }),
    );
  };

  // A team's Lead and agents wake together: the Lead first, so the backend knows it by the time it adopts the agents.
  const wakeTeam = (lead: string) => {
    const asleep = teamSlots(chats, lead).filter((slot) => chats.slots[slot].status === "asleep" && chats.slots[slot].asleepSaved && !waking.current.has(slot));
    const opened: Record<string, { slot: string; ready: Promise<boolean> }> = {};
    for (const slot of [lead, ...asleep.filter((m) => m !== lead)]) {
      const saved = asleep.includes(slot) ? chats.slots[slot].asleepSaved : null;
      if (!saved) continue;
      waking.current.add(slot);
      const ready = restoreInto(slot, saved, opened);
      if (slot === lead && saved.sessionId) opened[saved.sessionId] = { slot, ready };
      void ready.finally(() => waking.current.delete(slot));
    }
  };

  // Wakes an asleep chat (with its team, when it has one); nothing for one that is awake or already waking.
  const wakeChat = (slot: string) => {
    const s = chats.slots[slot];
    if (s?.status !== "asleep" || !s.folder || !s.sessionId || waking.current.has(slot)) return;
    const lead = teamMain(chats, slot);
    if (lead && s.asleepSaved?.orchestra) return wakeTeam(lead);
    waking.current.add(slot);
    void resumeIn(slot, s.folder, s.sessionId).finally(() => waking.current.delete(slot));
  };
  // An asleep chat is woken as soon as it is on screen, however it got there (the sidebar, a notification, Restore all…).
  useEffect(() => wakeChat(active), [active, state.status]);
  // A paired phone asked for a chat that is asleep (the backend checked it is one of these): it wakes where it is, without
  // taking the screen. The ref is read when it happens, so it sees the chats as they are then.
  const wakeRef = useRef(wakeChat);
  wakeRef.current = wakeChat;
  useEffect(() => {
    const unlisten = api.onRemoteWake((slot) => wakeRef.current(slot)).catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
  }, []);
  // The backend makes one call of its own to Claude (what to suggest on a phone): it is told where this window found it.
  useEffect(() => {
    if (state.claudePath) void api.remoteClaudePath(state.claudePath).catch(() => {});
  }, [state.claudePath]);
  // What a phone may choose, read when it asks: whether Settings let phones use Auto (the backend's saved setting, not anything the
  // request says) and which presets there are.
  // Where a phone may start a chat: Claude Code and each endpoint (not Codex, whose questions a phone can't answer yet).
  const phoneProviders = windowProviders(providers.list, providerName);
  const remoteContext = async (): Promise<RemoteContext> => {
    const view = await api.remoteSettings().catch(() => null);
    return { allowAuto: view?.allow_phone_auto === true, presetIds: presets.map((h) => h.id), providers: phoneProviders };
  };
  // A paired phone asked to start a chat in a project (the backend checked it too). It starts on Ask or Auto, beside what is on screen:
  // this window doesn't switch to it, and neither the project's Permissions nor the folder to reopen change. The backend is
  // answered with the slot it made, or why not. The ref is read when it happens, so it sees the chats as they are then.
  const newChatRef = useRef<(r: RemoteNewChat) => void>(() => {});
  newChatRef.current = (r) => {
    const fail = (why: string) => void api.remoteNewChatDone(r.id, null, why).catch(() => {});
    Promise.all([api.recentFolders(), remoteContext()]).then(
      ([recent, ctx]) => {
        const openFolders = Object.values(chats.slots).map((s) => s.folder);
        const why = checkRemoteNewChat(r, knownProject(r.folder, recent, openFolders), validChatText(r.text), ctx);
        if (why) return fail(why);
        if (!agentReady) return fail("No agent provider is set up on your Mac yet.");
        const slot = `s${++slotSeq.current}`;
        dispatchChats({ type: "add", slot });
        // Where the phone chose, else the project's own; but a project on a provider whose questions a phone can't answer starts on
        // Claude here (the chat would stop at its first one). Never written down as the project's choice: it is this chat's alone.
        const own = providerFor(r.folder);
        const providerId = r.provider ?? (capabilitiesOf(infoOf(own)).phone_approvals ? own : CLAUDE);
        startIn(slot, r.folder, false, false, r.text, undefined, undefined, { permissions: r.permissions === "auto" ? "auto" : "ask", preset: r.preset ?? null, workflow: r.workflow === "steps" ? "steps" : "chat" }, providerId);
        void api.remoteNewChatDone(r.id, slot, null).catch(() => {});
      },
      () => fail("Lantern couldn't look up your projects."),
    );
  };
  useEffect(() => {
    const unlisten = api.onRemoteNewChat((r) => newChatRef.current(r)).catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
  }, []);
  // A paired phone asked to put a chat on Ask or Auto, or on a preset (the backend checked it; any window can emit this, so this
  // window checks again, reading Settings' "Let paired phones use Auto" itself). Nothing is asked of the user: with background tasks
  // running, whose restart the window would ask about, it just doesn't switch. The project's Permissions and preset aren't changed.
  const remoteSwitchRef = useRef<(slot: string, change: { permissions: string } | { preset: string } | { workflow: string }) => void>(() => {});
  remoteSwitchRef.current = (slot, change) => {
    const s = chats.slots[slot];
    const team = !!s && (!!s.orchestrator || !!chats.agents[slot]);
    remoteContext().then((ctx) => {
      // (A chat on another provider than Claude's has no Auto and no Claude presets: the phone is told why, nothing restarts.)
      const onId = s?.provider ? providerIdOf(s.provider) : CLAUDE;
      const target = { known: !!s && !team, idle: s?.status === "idle", asleep: s?.status === "asleep", background: s?.backgroundTasks.length ?? 0, provider: onId === CLAUDE ? null : { name: providerName(onId), auto: capabilitiesOf(s?.provider).supports_auto_mode } };
      if (team) return;
      if (checkRemoteSwitch(change, target, ctx)) return;
      if ("permissions" in change) {
        const permissions: Permissions = change.permissions === "auto" ? "auto" : "ask";
        phoneMode.current[slot] = permissions;
        setSettings(slot, permissions, workflowOf(s));
      } else if ("workflow" in change) {
        const workflow: Workflow = change.workflow === "steps" ? "steps" : "chat";
        phoneFlow.current[slot] = workflow;
        setSettings(slot, permissionsOf(s), workflow);
      } else {
        applyHarness(findHarness(presets, change.preset), slot, false);
      }
    });
  };
  useEffect(() => {
    const offs = [api.onRemoteSetPermissions((r: RemoteSetPermissions) => remoteSwitchRef.current(r.slot, { permissions: r.permissions })), api.onRemoteSetPreset((r: RemoteSetPreset) => remoteSwitchRef.current(r.slot, { preset: r.preset })), api.onRemoteSetWorkflow((r: RemoteSetWorkflow) => remoteSwitchRef.current(r.slot, { workflow: r.workflow }))].map((p) => p.catch(() => null));
    return () => {
      offs.forEach((p) => p.then((f) => f?.()));
    };
  }, []);
  // A paired phone asked to close a chat (the backend checked it is listed and not busy): closed as the sidebar closes one, and
  // nothing is asked of the user, so one with background tasks, or a team's, is left open.
  const remoteCloseRef = useRef<(slot: string) => void>(() => {});
  remoteCloseRef.current = (slot) => {
    const s = chats.slots[slot];
    const why = checkRemoteClose({ known: !!s, team: !!s && (!!s.orchestrator || !!chats.agents[slot]), busy: !!s && isBusy(s), background: s?.backgroundTasks.length ?? 0 });
    if (!why) closeChats([slot]);
  };
  useEffect(() => {
    const off = api.onRemoteClose((r) => remoteCloseRef.current(r.slot)).catch(() => null);
    return () => {
      off.then((f) => f?.());
    };
  }, []);
  // The presets a phone may choose between, as Settings › Models has them, and where it may start a chat: told again when an
  // endpoint is added or removed, so a phone isn't left offering one that is gone (or missing one that was just set up).
  const controlsKey = JSON.stringify([windowPresets(presets), phoneProviders]);
  useEffect(() => {
    void api.remoteWindowControls(windowPresets(presets), phoneProviders).catch(() => {});
  }, [controlsKey]);

  // An agent's conversation is recorded once it has one, so it can be told from the user's own chats.
  useEffect(() => {
    const ids = Object.keys(chats.agents).flatMap((slot) => chats.slots[slot]?.sessionId ?? []);
    if (ids.some((id) => !agentSessions.includes(id))) setAgentSessions([...new Set([...agentSessions, ...ids])]);
  }, [chats.slots, chats.agents]);

  // The chats that were open when Lantern last closed, offered back at launch until restored, dismissed, or a message
  // is sent in a new chat instead.
  const [offer, setOffer] = useState<SavedChat[]>(() => restorable(loadSaved(), new Set(agentSessions)));
  // What was saved before this launch says which conversations were agents' (an older version saved them as chats).
  useEffect(() => {
    const known = agentSessionsOf(loadSaved());
    if (known.some((id) => !agentSessions.includes(id))) setAgentSessions([...new Set([...agentSessions, ...known])]);
  }, []);
  // A worker's worktree is removed once its branch is merged: it isn't brought back from a folder that is gone.
  useEffect(() => {
    const folders = [...new Set(offer.filter((c) => c.orchestra?.role === "worker").map((c) => c.folder))];
    if (folders.length === 0) return setGoneChecked(true);
    // Settled either way, so a restore by itself (after an update) doesn't start before the offer is cleaned.
    api.foldersGone(folders).then(
      (gone) => {
        if (gone.length > 0) setOffer((o) => withoutGone(o, new Set(gone)));
        setGoneChecked(true);
      },
      () => setGoneChecked(true),
    );
  }, []);
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
    if (o?.role === "main") team = { role: "main", review: o.review ? readReview(o.review) : undefined };
    else if (o?.role === "worker") {
      const parent = opened[o.parentSession] ?? openMainOf(o.parentSession);
      // An agent only comes back inside its team: without its main agent it stays closed, never an ordinary chat.
      if (!parent) return Promise.resolve(false);
      team = { role: "worker", parent: parent.slot, name: o.name, branch: o.branch, base: o.base, isolation: o.isolation, agentRole: o.agentRole, hidden: o.hidden, model: o.model, parentReady: parent.ready };
    }
    if (c.sessionId) return resumeIn(slot, c.folder, c.sessionId, false, team);
    // Typed in the box but never sent: a new chat in its folder, as a main agent again if it was one.
    startIn(slot, c.folder, false, team?.role === "main", undefined, undefined, team?.role === "main" ? team.review : undefined);
    return Promise.resolve(true);
  };
  // What the restore card lists: agents aren't, they come back with their team.
  const offeredTop = offer.filter((c) => c.orchestra?.role !== "worker");
  const openAlready = (c: SavedChat) => (c.sessionId ? Object.entries(chats.slots).find(([, s]) => s.sessionId === c.sessionId)?.[0] : undefined);
  /** The main agent already open for this session, if there is one (already opened, so there is nothing to wait for). */
  const openMainOf = (session: string) => {
    const slot = Object.entries(chats.slots).find(([, s]) => s.orchestrator && s.sessionId === session)?.[0];
    return slot ? { slot, ready: Promise.resolve(true) } : undefined;
  };

  // One chat, on screen (in the empty chat on screen if there is one).
  // A team's agents come back with it (they are never offered on their own).
  const restoreOne = (offered: SavedChat) => {
    const team = offered.orchestra?.role === "main" && offered.sessionId ? offer.filter((w) => w.orchestra?.role === "worker" && w.orchestra.parentSession === offered.sessionId) : [];
    setOffer((o) => o.filter((x) => x !== offered && !team.includes(x)));
    // Chosen before the moves were read, it still goes where its folder is now.
    const c = { ...offered, folder: here(offered.folder) };
    const already = openAlready(c);
    if (already) return switchTo(already);
    if (!agentReady) return;
    const slot = takeSlot();
    const ready = restoreInto(slot, c);
    if (c.sessionId) {
      const opened = { [c.sessionId]: { slot, ready } };
      for (const w of team) {
        const own = `s${++slotSeq.current}`;
        dispatchChats({ type: "add", slot: own });
        void restoreInto(own, { ...w, folder: here(w.folder) }, opened);
      }
    }
    setComposerEpoch((e) => e + 1);
    setLastFolder(c.folder);
  };

  // Every chat: the one that was on screen comes back on screen, the others open behind it. Main agents of an orchestra
  // are opened first, so their workers can be put back under them.
  const restoreAll = () => {
    const ordered = screenFirst(toCurrentFolders(offer, moves ?? []));
    const [first] = ordered;
    if (!first || !agentReady) return;
    const isMain = (c: SavedChat) => c.orchestra?.role === "main";
    const teamOpen = ({ orchestra: o }: SavedChat) => o?.role !== "worker" || ordered.some((m) => isMain(m) && m.sessionId === o.parentSession) || !!openMainOf(o.parentSession);
    // The chat on screen, and the team it is in, start now; every other chat and team is asleep in the sidebar until it is opened
    // (a team sleeps and wakes as one: its Lead and its agents).
    const leadSlots = Object.entries(chats.slots).flatMap(([slot, s]) => (s.orchestrator && s.sessionId ? [[s.sessionId, slot, s.status] as const] : []));
    const awakeLeads = new Set(leadSlots.filter(([, , status]) => status !== "asleep").map(([session]) => session));
    const lazy = (c: SavedChat) => !startsNow(c, first, awakeLeads);
    // An agent whose Lead is asleep comes back with that team when it wakes, not on its own now.
    const asleepLeads: Record<string, string> = Object.fromEntries(leadSlots.filter(([, , status]) => status === "asleep").map(([session, slot]) => [session, slot]));
    const waitsForLead = (c: SavedChat) => c.orchestra?.role === "worker" && c.orchestra.parentSession in asleepLeads && !openAlready(c);
    // The ones that start now go first (into the empty chat on screen), each Lead before its agents.
    const inOrder = [...ordered.filter(isMain), ...ordered.filter((c) => !isMain(c) && teamOpen(c))].filter((c) => !waitsForLead(c)).sort((a, b) => Number(lazy(a)) - Number(lazy(b)));
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
        if (i !== 0 && lazy(c) && c.sessionId) {
          if (c.draft) drafts.current[slot] = c.draft;
          const o = c.orchestra;
          if (o?.role === "main") {
            to(slot)({ type: "orchestrator_set", on: true });
            if (o.review) to(slot)({ type: "review_set", review: readReview(o.review) });
            asleepLeads[c.sessionId] = slot;
          }
          to(slot)({ type: "sleep", folder: c.folder, sessionId: c.sessionId, title: c.title, saved: { ...c, active: false } });
          // An agent is part of its team in the sidebar and on the canvas, asleep or not.
          const lead = o?.role === "worker" ? asleepLeads[o.parentSession] : undefined;
          if (o?.role === "worker" && lead) {
            dispatchChats({ type: "adopt", slot, meta: { parent: lead, name: o.name, brief: "", folder: c.folder, branch: o.branch, base: o.base, isolation: o.isolation, ...(o.agentRole ? { role: o.agentRole } : {}), ...(o.hidden ? { hidden: true } : {}) } });
          }
        } else {
          const ready = restoreInto(slot, c, opened);
          if (isMain(c) && c.sessionId) opened[c.sessionId] = { slot, ready };
        }
      }
      if (c === first) onScreen = slot;
    });
    if (onScreen) dispatchChats({ type: "activate", slot: onScreen });
    setComposerEpoch((e) => e + 1);
    // The project to reopen next time is a chat's, never an agent's worktree.
    setLastFolder((inOrder.find((c) => c.orchestra?.role !== "worker") ?? first).folder);
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
    if (!caps.supports_skills || state.status !== "idle" || !state.folder || Date.now() - (mcpCheckedAt.current[active] ?? 0) < 30_000) return;
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
  // `switchTo`: a flavour this message switches to itself (a page's button, the badge mid-chat), over any pick.
  const mapNoted = useRef<Record<string, string>>({});
  const sendIn = (slot: string, text: string, draft?: string, auto = false, switchTo?: { flavour: Flavour; explain: boolean }) => {
    const pick = switchTo?.flavour ?? chats.slots[slot]?.flavourPick ?? null;
    const explain = pick !== null && canExplain(pick) && (switchTo ? switchTo.explain : !!chats.slots[slot]?.explainPick);
    const chat = chats.slots[slot];
    // Claude's last reply looked like a page Lantern couldn't read: it hears so with this message, and the headings.
    const unread = chat && chat.mode === "steps" && !pick ? pageNote(chat.items, chatFlavour(chat), guides) : null;
    // The latest Architecture Overview's map doesn't read, so the Plan tab can't draw it: said once for each Overview.
    const map = chat && chat.mode === "steps" ? architectureMap(pagesOf(chat.items)) : null;
    const broken = map?.kind === "broken" && mapNoted.current[slot] !== map.page ? mapNote(map) : null;
    if (map?.kind === "broken" && broken) mapNoted.current[slot] = map.page;
    to(slot)({ type: "user_sent", text, ...(auto ? { auto } : {}), ...(pick ? { switchedTo: pick, ...(explain ? { explained: true } : {}) } : {}), ...(draft ? { draft } : {}) });
    // Commands run since the last message go first, so Claude sees what they printed; skills named mid-message get
    // a note so Claude uses them.
    const items = chats.slots[slot]?.items ?? [];
    const noted = withSkillNote(text, skillNames(slot));
    // Files reverted since the last message: Claude is told, so it doesn't act on what it last wrote.
    const reverted = withRevertNote(withPageNote([unread, broken].filter(Boolean).join("\n\n") || null, pick ? withFlavourNote(pick, noted, { guide: guides[pick]?.text, explain, explainGuide: guides.explain?.text }) : noted), chats.slots[slot]?.revertNotes ?? []);
    // A chat opened from a place the folder moved from: Claude is told once that the paths in earlier messages are old.
    const moved = withMovedNote(reverted, chats.slots[slot]?.movedFrom ?? null, chats.slots[slot]?.folder ?? null);
    api.sendMessage(slot, withShellContext(items, moved), auto).then(
      (turn) => typeof turn === "number" && to(slot)({ type: "turn_numbered", turn }),
      (e) => to(slot)({ type: "turn_failed", text: errText(e) }),
    );
  };

  // "!command" in the chat box: run in the chat's folder, its output streaming into the conversation.
  const shellSeq = useRef(0);
  const runSeq = useRef(0);
  // The project a chat belongs to: its Lead's folder for an agent (its own folder is a worktree), else its own.
  const projectFolderOf = (slot: string) => {
    const parent = chats.agents[slot]?.parent;
    return (parent && chats.slots[parent]?.folder) || chats.slots[slot]?.folder || null;
  };
  const runShell = (slot: string, command: string) => {
    const id = `sh-${Date.now().toString(36)}-${++shellSeq.current}`;
    to(slot)({ type: "shell_started", id, command });
    api.runShell(slot, id, command).catch((e) => {
      to(slot)({ type: "ui_event", event: { kind: "shell_output", id, text: errText(e) } });
      to(slot)({ type: "ui_event", event: { kind: "shell_done", id, code: null, stopped: false } });
    });
  };

  // What keeps a team from running unwatched: the pause when the plan reaches the user's limit (while it lasts, nothing
  // below starts a turn by itself).
  const guards = useTeamGuards(chats, {
    stop: (slot) => stopIn(slot),
    send: (slot, text) => sendIn(slot, text),
    queue: (slot, items) => to(slot)({ type: "queue_set", items }),
    warn: (text) => setHud({ key: Date.now(), kind: "warning", body: text }),
    paused: (text) => {
      setHud({ key: Date.now(), kind: "warning", detail: "Paused", body: text });
      if (!windowFocused()) void notify("Lantern", text, "waiting");
    },
  });
  const paused = guards.pause !== null;
  // Routines: prompts that go out by themselves while Lantern is open. Each run is a new chat in the project, opened behind the
  // one on screen on the routine's own Permissions and model, and sent the prompt once it is ready.
  const routines = useRoutines({
    ready: agentReady,
    chats: chats.slots,
    send: sendIn,
    open: async (r) => {
      const folder = here(r.folder);
      const gone = await api.foldersGone([folder]).catch(() => [] as string[]);
      if (gone.length > 0) throw new Error("its project folder isn't there any more");
      if (!agentReady) throw new Error("No agent provider is ready");
      const slot = `s${++slotSeq.current}`;
      dispatchChats({ type: "add", slot });
      routineSlots.current[slot] = { name: r.name, model: r.model };
      startIn(slot, folder, false, false, undefined, r);
      return slot;
    },
  });

  // A chat's queued messages go out when its turn ends normally, whether or not it's on screen.
  const prevStatus = useRef<Record<string, Status>>({});
  useEffect(() => {
    const held = (slot: string) => guards.heldSlots.includes(slot);
    const due = queuesToSend(prevStatus.current, chats.slots).filter(({ slot }) => !held(slot));
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
    for (const { slot, text } of wakesToSend(chats.slots, new Set(due.map((d) => d.slot))).filter(({ slot }) => !held(slot))) {
      to(slot)({ type: "wakes_taken" });
      sendIn(slot, text, undefined, true);
    }
  }, [chats.slots, paused, guards.heldSlots.join(",")]);

  /**
   * Restarting a chat's claude (a new mode, effort or preset) stops what it runs in the background: workflows,
   * background subagents and commands. With any running, ask first; `go` runs only if the answer is yes.
   */
  const unlessBackground = async (slot: string, go: () => void) => {
    const n = chats.slots[slot]?.backgroundTasks.length ?? 0;
    if (n > 0) {
      const them = n === 1 ? "it" : "them";
      const agent = agentName(chats.slots[slot]?.provider);
      const sure = await ask(`${n === 1 ? "A background task is" : `${n} background tasks are`} running in this chat (a workflow, a subagent or a command). Changing this restarts ${agent}, which stops ${them}.`, {
        title: `Restart ${agent}?`,
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
    const sure = await ask("The agent forgets this conversation. The files it changed stay as they are.", {
      title: "Clear this conversation?",
      kind: "warning",
      okLabel: "Clear",
      cancelLabel: "Keep it",
    });
    if (sure) void api.conversationAction(slot, "clear").catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };

  /** A team's Subagents setting for a Lead that has just started: the project's last choice, told to the backend and shown. */
  const startSubagents = (slot: string, folder: string) => {
    const subagents = subagentsBy[folder] ?? "canvas";
    to(slot)({ type: "subagents_set", subagents });
    api.setSubagents(slot, subagents).catch(() => {});
  };
  // The project's own roles and team templates. A Lead is told its project's roles so it can ask for one by id: when its team
  // starts or comes back, and again whenever they change.
  const roleStore = useRoleStoreState();
  const startRoles = (slot: string, folder: string) => {
    api.setRoles(slot, roleStore.roles(folder)).catch(() => {});
  };
  useEffect(() => {
    for (const [slot, s] of Object.entries(chats.slots)) if (s.orchestrator && s.folder) startRoles(slot, s.folder);
  }, [roleStore]);
  /** A team's review setting for a Lead that has just started or come back (a team from a template is on, any other off, until the user says): told to the backend and shown. */
  const startReview = (slot: string, review: ReviewSetting = NO_REVIEW) => {
    to(slot)({ type: "review_set", review });
    api.setReview(slot, review).catch(() => {});
  };
  /** The team's "Review and test what an agent builds" setting: kept with the team, and told to the backend. */
  const changeReview = (slot: string, review: ReviewSetting) => {
    if (!chats.slots[slot]?.orchestrator) return;
    to(slot)({ type: "review_set", review });
    api.setReview(slot, review).catch((e) => to(slot)({ type: "notice", text: errText(e) }));
  };
  const [templateDialog, setTemplateDialog] = useState(false);
  const startFromTemplate = (template: TeamTemplate, task: string) => {
    const folder = state.folder;
    if (!folder) return;
    setTemplateDialog(false);
    const review = reviewFor(template);
    const message = templateMessage(template, roleStore.roles(folder), task, review.on);
    askTeam(null, () => {
      startFresh(folder, false, true, message, review);
      setView("canvas");
    });
  };
  /** The team's Subagents setting: where its Lead's built-in helpers run. Remembered for the project's next team. */
  const changeSubagents = (slot: string, subagents: Subagents) => {
    const s = chats.slots[slot];
    if (!s?.orchestrator) return;
    to(slot)({ type: "subagents_set", subagents });
    api.setSubagents(slot, subagents).catch((e) => to(slot)({ type: "notice", text: errText(e) }));
    if (s.folder) setSubagentsBy({ ...subagentsBy, [s.folder]: subagents });
  };

  /**
   * Runs `go` (something that starts a team or one of its agents), after asking when a team other than `except`'s is
   * working: every agent spends the same plan. `cancel` runs if it is turned down.
   */
  const askTeam = (except: string | null, go: () => void, cancel?: () => void) => {
    const teams = warnTeams ? workingTeams(chats, except) : [];
    if (teams.length === 0) go();
    else setTeamAsk({ teams, go, cancel });
  };

  /** A team's Lead still has agents on the canvas, which would be left with nobody to report to if it left Team. */
  const holdsAgents = (slot: string) => !!chats.slots[slot]?.orchestrator && Object.values(chats.agents).some((a) => a.parent === slot);

  /**
   * Sets a chat's Permissions and Workflow together (they are one restart of its claude): Permissions Ask or Auto, the
   * same in every workflow; Workflow Chat, Step by step or Team, where Team makes the chat the Lead of a team (see
   * restart_session) and leaving it needs the team's agents closed first. An agent of a team keeps its Workflow's team,
   * and its Permissions are capped by its Lead's (the backend lowers them and says so).
   */
  const setSettings = (slot: string, permissions: Permissions, workflow: Workflow) =>
    unlessBackground(slot, () => {
      const s = chats.slots[slot];
      if (!s) return;
      const agent = !!chats.agents[slot];
      const leaving = s.orchestrator && workflow !== "team";
      if (leaving && holdsAgents(slot)) return to(slot)({ type: "notice", text: "This team still has agents. Close them first, then switch its Workflow." });
      const { mode, autoApprove, team } = launchOf(permissions, agent ? workflowOf(s) : workflow);
      if (team && !agent && !s.orchestrator && !capabilitiesOf(s.provider).can_lead_team) return to(slot)({ type: "notice", text: `${agentName(s.provider)} can't lead a team yet: a team's Lead runs on Claude Code.` });
      const apply = () => {
        if (mode !== "steps") to(slot)({ type: "flavour_picked", flavour: null });
        to(slot)({ type: "mode_changed", mode, autoApprove });
        if (!agent) to(slot)({ type: "orchestrator_set", on: team });
        if (s.folder) restart(slot, mode, settingsFor(slot).effort, { autoApprove, ...(agent ? {} : team && !s.orchestrator ? { team: true } : leaving ? { team: false } : {}) });
        // Becoming a Lead: its agents will appear on the canvas, so that is where it goes.
        if (team && !s.orchestrator) {
          startSubagents(slot, s.folder ?? "");
          startRoles(slot, s.folder ?? "");
          startReview(slot);
          focusAgent(slot);
          setView("canvas");
        }
      };
      if (team && !s.orchestrator && !agent) askTeam(null, apply);
      else apply();
    });
  const changePermissions = (permissions: Permissions, slot = active) => {
    delete phoneMode.current[slot];
    const s = chats.slots[slot];
    if (s && permissionsOf(s) !== permissions) setSettings(slot, permissions, workflowOf(s));
  };
  const changeWorkflow = (workflow: Workflow, slot = active) => {
    delete phoneFlow.current[slot];
    const s = chats.slots[slot];
    if (s && workflowOf(s) !== workflow) setSettings(slot, permissionsOf(s), workflow);
  };

  // Step by step's flavour as you see it (and whether Explain as you go is on): one you picked and haven't sent yet, or
  // the conversation's.
  const inConversation = (s: typeof state) => (s.mode === "steps" ? flavourState(s.items, s.flavourStart, s.explainStart) : { flavour: null, explain: false });
  const chatFlavourState = (s: typeof state) => (s.mode === "steps" && s.flavourPick ? { flavour: s.flavourPick, explain: s.explainPick } : inConversation(s));
  const chatFlavour = (s: typeof state) => chatFlavourState(s).flavour;
  const { flavour, explain } = chatFlavourState(state);
  // Picking the flavour (and option) the chat is already in takes back a pick; one from outside Step by step switches to it.
  // `wantExplain`: the Explain as you go option; left out, it stays as it is when the new flavour has it.
  const pickFlavour = (next: Flavour | null, wantExplain?: boolean) => {
    const inChat = inConversation(state);
    const explainNext = next !== null && canExplain(next) && (wantExplain ?? explain);
    const pick = next === inChat.flavour && explainNext === inChat.explain ? null : next;
    if (state.mode !== "steps") {
      if (holdsAgents(active)) return dispatch({ type: "notice", text: "This team still has agents. Close them first, then switch its Workflow." });
      return unlessBackground(active, () => {
        const autoApprove = permissionsOf(state) === "auto";
        dispatch({ type: "flavour_picked", flavour: pick, explain: explainNext });
        dispatch({ type: "mode_changed", mode: "steps", autoApprove });
        dispatch({ type: "orchestrator_set", on: false });
        if (state.folder) restart(active, "steps", settingsFor(active).effort, { autoApprove, ...(state.orchestrator ? { team: false } : {}) });
      });
    }
    dispatch({ type: "flavour_picked", flavour: pick, explain: explainNext });
  };
  // The badge on a Step-by-step chat that's under way switches to another flavour at once, while Claude is idle: "Continue
  // in Review." goes with the note, and Claude starts the flavour from where the work is. Busy, or only turning Explain as
  // you go on or off (which shouldn't start the flavour over), it waits for your next message.
  const pickFlavourNow = (next: Flavour, wantExplain?: boolean) => {
    const inChat = inConversation(state);
    const explainNext = canExplain(next) && (wantExplain ?? explain);
    if (state.mode !== "steps" || state.status !== "idle" || !state.items.length || next === inChat.flavour) return pickFlavour(next, wantExplain);
    if (state.flavourPick) dispatch({ type: "flavour_picked", flavour: null, explain: false });
    sendIn(active, continueText(FLAVOUR_LABEL[next], explainNext), undefined, false, { flavour: next, explain: explainNext });
  };

  /**
   * Switches a chat to a preset (and makes it its folder's): its claude restarts on the same session with the
   * preset's models, as for a new mode.
   */
  const switchHarness = (h: Harness, slot = active) => unlessBackground(slot, () => applyHarness(h, slot));
  // `remember`: it also becomes the folder's preset, for the project's next chats; a phone's switch doesn't (nobody chose it at the Mac).
  const applyHarness = (h: Harness, slot: string, remember = true) => {
    setHarnessBySlot((all) => ({ ...all, [slot]: h.id }));
    const folder = chats.slots[slot]?.folder;
    if (!folder) return;
    if (remember) setHarnessByFolder({ ...harnessByFolder, [folder]: h.id });
    to(slot)({ type: "restarting" });
    api.applyHarness(slot, settingsFor(slot, h)).then(() => to(slot)({ type: "session_ready" })).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };
  // Changing model or effort on a chat with a preset makes it Custom: that preset with the change.
  const customize = (patch: Partial<Harness>) => {
    const custom = customOf(harnessOf(active), patch);
    setSavedPresets([...savedPresets.filter((h) => h.id !== CUSTOM_HARNESS), custom]);
    switchHarness(custom);
  };
  const presetOn = harnessOf(active).id !== DEFAULT_HARNESS;

  // Effort is a launch flag, so the chat's claude restarts on the same session to pick it up (like the mode).
  // The effort and model are each provider's own: Claude's are the app-wide ones, another provider's are kept beside them.
  const changeEffort = (next: string | null) => {
    if (presetOn) return customize({ effort: next });
    unlessBackground(active, () => {
      if (activeProvider === CLAUDE) setEffort(next);
      else setProviderPrefs({ ...providerPrefs, [activeProvider]: { ...prefsOf(activeProvider), effort: next } });
      if (state.folder) restart(active, state.mode, next);
    });
  };

  // For every open chat on the same provider: applies in-band from each one's next message (or, for a provider whose model
  // is fixed while it runs, from its next start), and to new chats and restarts. Chats on a preset keep the preset's model.
  const chooseModel = (next: string | null) => {
    if (presetOn) return customize({ model: next });
    if (activeProvider === CLAUDE) setModel(next);
    else setProviderPrefs({ ...providerPrefs, [activeProvider]: { ...prefsOf(activeProvider), model: next } });
    for (const slot of Object.keys(chats.slots)) {
      if (providerIdOf(chats.slots[slot].provider) === activeProvider && harnessOf(slot).id === DEFAULT_HARNESS) api.setModel(slot, next).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
    }
  };

  const stopIn = (slot: string) => {
    to(slot)({ type: "stop_requested" });
    api.interrupt(slot).catch((e) => to(slot)({ type: "stop_failed", text: errText(e) }));
  };
  const stop = () => stopIn(active);

  // `note`: what the user wrote on a reproduce or approval card; it goes back to Claude with the answer.
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
  // The worktree this chat is working in, when Claude entered one itself: Git and Branch read from it (the backend
  // decides from the chat's latest edit), and `worktreeKey` makes them read again when it, or the user's choice of the
  // chat's own folder instead, changes.
  const [worktree, setWorktree] = useState<{ slot: string; view: WorkView | null } | null>(null);
  useEffect(() => {
    if (!state.folder) return setWorktree(null);
    let live = true;
    api.workFolder(active).then((view) => live && setWorktree({ slot: active, view }), () => live && setWorktree(null));
    return () => {
      live = false;
    };
  }, [active, state.folder, state.changedFiles, state.status]);
  const shownWorktree = worktree?.slot === active ? worktree.view : null;
  const worktreeKey = shownWorktree ? `${shownWorktree.path}:${shownWorktree.main}` : "";
  const chooseWorktreeView = (main: boolean) => {
    if (!shownWorktree) return;
    const slot = active;
    api.setViewMain(slot, main).then(() => setWorktree((w) => (w?.slot === slot && w.view ? { slot, view: { ...w.view, main } } : w)), () => {});
  };
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
  }, [changeScope, active, state.folder, state.changedFiles, state.status, state.seq, worktreeKey]);
  // "PR #N" while a pull request is reviewed: its files against its base. Picked when the review names its PR.
  // Reviewing with no PR named (a local branch): "Branch", its commits since it left its base. What Claude set with
  // mcp__lantern__review_target comes first, in any flavour; without it, the review's own text says.
  const reviewTarget = useMemo(() => state.reviewTarget ?? reviewTargetOf(state.items), [state.reviewTarget, state.items]);
  // A merge card's "Review diff": this agent's branch against its base, whatever the chat is about.
  const peek = branchPeek?.slot === active ? branchPeek : null;
  const reviewing = ((flavour === "review" || reviewTarget !== null) && state.items.length > 0) || peek !== null;
  const reviewPr = peek || !reviewing ? null : reviewTarget ? reviewTarget.pr : prNumberOf(state.items);
  const reviewBranch = reviewing && reviewPr === null;
  const hints = reviewing ? reviewHints(state.items, state.folder) : [];
  const hintKey = hints.join("\n");
  // A local branch stacked on another: the base the review's Frame names (null: the backend works it out).
  const reviewBase = !reviewing ? null : peek ? peek.base : reviewTarget ? reviewTarget.base : baseBranchOf(state.items);
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
  }, [scope, active, state.folder, hintKey, reviewBase, state.seq, worktreeKey]);
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

  useAction("toggle-changes", () => (desk && Object.keys(chats.slots).length > 0 ? setAskCollapsed(!askCollapsed) : setReviewCollapsed(!reviewCollapsed)), !!state.folder || desk);

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
  // A new team: a Lead chat on the project's last Permissions, which its agents never exceed (change them from any window's
  // title bar, or under the box).
  const newOrchestra = (inFolder: string | null = state.folder) => {
    const folder = inFolder;
    if (!folder) return;
    askTeam(null, () => {
      startFresh(folder, false, true);
      setView("canvas");
    });
  };
  const doing = {
    send: sendIn,
    // The canvas asked the user already (its Clear is confirmed in the menu), so this doesn't ask again.
    clear: (slot: string) => sendIn(slot, "/clear"),
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
    answerSetup: (slot: string, answer: "start" | "again" | "stop") => api.answerSetup(slot, answer).catch((e) => Promise.reject(errText(e))),
    // The project's Run command in the chat's folder. One that is going is stopped first; its own id keeps its ending from touching the new run.
    run: (slot: string) => {
      const s = chats.slots[slot];
      const command = runCommandOf(setupBy, projectFolderOf(slot));
      if (!s?.folder || !command) return;
      if (s.run?.status === "running") api.stopShell(slot, s.run.id).catch(() => {});
      const id = `${RUN_PREFIX}${Date.now().toString(36)}-${++runSeq.current}`;
      to(slot)({ type: "run_started", id, command });
      api.runProject(slot, id).catch((e) => {
        to(slot)({ type: "ui_event", event: { kind: "shell_output", id, text: errText(e) } });
        to(slot)({ type: "ui_event", event: { kind: "shell_done", id, code: null, stopped: false } });
      });
    },
    stopRun: (slot: string) => {
      const run = chats.slots[slot]?.run;
      if (run?.status === "running") api.stopShell(slot, run.id).catch(() => {});
    },
    closeRun: (slot: string) => {
      const run = chats.slots[slot]?.run;
      if (run?.status === "running") api.stopShell(slot, run.id).catch(() => {});
      to(slot)({ type: "run_closed" });
    },
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
      return api.declineMerge(worker).then(
        () => {},
        (e) => {
          if (main) to(main)({ type: "ui_event", event: { kind: "merge_resolved", worker, outcome: "failed", detail: errText(e) } });
        },
      );
    },
    // The worker's chat is the one on screen (its folder is the branch's worktree), in the panel's Changes on the branch since it
    // left its base, at the file when one is named.
    reviewMerge: (worker: string, file?: string) => {
      if (!chats.slots[worker]?.folder) return;
      focusAgent(worker);
      setBranchPeek({ slot: worker, base: chats.agents[worker]?.base ?? null, key: Date.now() });
      setChangeScope("branch");
      setReviewFile(file ?? null);
      setReviewCollapsed(false);
    },
    removeWorktree: (worker: string) => api.discardWorktree(worker, false).catch((e) => Promise.reject(errText(e))),
    closeCheck: (worker: string) => api.closeWorkerCheck(worker).catch((e) => Promise.reject(errText(e))),
    // The backend has stopped it and told the main agent by the time this resolves; the chat goes from the app now.
    closeWorker: (worker: string, agreed?: CloseAgreed) => api.closeWorker(worker, agreed).then(() => forget(worker, true), (e) => Promise.reject(errText(e))),
    // The card comes from the backend's agent_spawned, like any worker's.
    // "+ Agent" asks first when another team is working; turning that down leaves the form as it was.
    spawn: (main: string, worker: NewWorker) =>
      new Promise<void>((resolve, reject) =>
        askTeam(
          main,
          () => api.spawnWorker(main, worker).then(() => resolve(), (e) => reject(errText(e))),
          () => reject("Cancelled: nothing was started."),
        ),
      ),
    // Hiding the agent whose chat is on screen moves the rest of the app to its main agent, so it isn't about a card nobody sees.
    hide: (worker: string) => {
      const parent = chats.agents[worker]?.parent;
      dispatchChats({ type: "set_hidden", slot: worker, hidden: true });
      if (worker === active && parent) focusAgent(parent);
    },
    show: (worker: string) => dispatchChats({ type: "set_hidden", slot: worker, hidden: false }),
    setPermissions: (slot: string, permissions: Permissions) => changePermissions(permissions, slot),
    setWorkflow: (slot: string, workflow: Workflow) => changeWorkflow(workflow, slot),
    setSubagents: changeSubagents,
    setReview: changeReview,
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
  // "Tidy up an agent after its merge: Automatically" closes a merged agent that has nothing left to lose.
  useAutoTidy(chats.slots, { closeCheck: doing.closeCheck, closeWorker: doing.closeWorker });
  const nodeActions = useMemo<NodeActions>(
    () => ({
      send: (slot, text) => doingRef.current.send(slot, text),
      clear: (slot) => doingRef.current.clear(slot),
      stop: (slot) => doingRef.current.stop(slot),
      queue: (slot, items) => doingRef.current.queue(slot, items),
      decide: (slot, id, allow, note, answered) => doingRef.current.decide(slot, id, allow, note, answered),
      openFile: (slot, path) => doingRef.current.openFile(slot, path),
      openTestRun: (slot, id) => doingRef.current.openTestRun(slot, id),
      stopShell: (slot, id) => doingRef.current.stopShell(slot, id),
      answerSetup: (slot, answer) => doingRef.current.answerSetup(slot, answer),
      run: (slot) => doingRef.current.run(slot),
      stopRun: (slot) => doingRef.current.stopRun(slot),
      closeRun: (slot) => doingRef.current.closeRun(slot),
      shellInput: (slot, id, text) => doingRef.current.shellInput(slot, id, text),
      restart: (slot) => doingRef.current.restart(slot),
      approveMerge: (worker) => doingRef.current.approveMerge(worker),
      declineMerge: (worker) => doingRef.current.declineMerge(worker),
      reviewMerge: (worker, file) => doingRef.current.reviewMerge(worker, file),
      removeWorktree: (worker) => doingRef.current.removeWorktree(worker),
      spawn: (main, worker) => doingRef.current.spawn(main, worker),
      closeCheck: (worker) => doingRef.current.closeCheck(worker),
      closeWorker: (worker, agreed) => doingRef.current.closeWorker(worker, agreed),
      hide: (worker) => doingRef.current.hide(worker),
      show: (worker) => doingRef.current.show(worker),
      setPermissions: (slot, permissions) => doingRef.current.setPermissions(slot, permissions),
      setWorkflow: (slot, workflow) => doingRef.current.setWorkflow(slot, workflow),
      setSubagents: (main, subagents) => doingRef.current.setSubagents(main, subagents),
      setReview: (main, review) => doingRef.current.setReview(main, review),
      draft: (slot) => doingRef.current.draft(slot),
      setDraft: (slot, text) => doingRef.current.setDraft(slot, text),
    }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (reviewCollapsed || desk || e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement)) return;
      const delta = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
      const next = delta && stepFile(shownFiles, state.selectedFile, delta);
      if (next && next !== state.selectedFile) selectFile(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewCollapsed, desk, shownFiles, state.selectedFile]);

  // The branch can change between turns (Claude may check out one), so re-read it whenever a turn ends.
  const idle = state.status === "idle";
  // The title bar names the project: on a team's canvas that's the Lead's folder, not the folder of whichever agent is on screen.
  const titleFolder = canvasMain ? (chats.slots[canvasMain]?.folder ?? state.folder) : state.folder;
  useEffect(() => {
    if (!titleFolder) return setBranch(null);
    let live = true;
    api.gitBranch(titleFolder).then((b) => live && setBranch(b), () => live && setBranch(null));
    return () => {
      live = false;
    };
  }, [titleFolder, idle]);

  // Tell the user when a turn ends or Claude needs a permission answer, if they're in another app or another chat.
  // Item ids restart in every session, so the session id is part of what counts as "already announced".
  // Short titles for the open chats, by session id, made once each session has its first prompt.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const titling = useRef(new Set<string>());
  // Naming a session: the name beats every other title it has, and the open chat of that session takes it too.
  const renameSession = async (id: string, typed: string) => {
    // Trimmed as the backend keeps it, so the chat shows what was saved.
    const title = typed.trim();
    await api.renameSession(id, title);
    setTitles((all) => ({ ...all, [id]: title }));
  };
  // A paired phone asked to name a chat (the backend checked it has a conversation and the name is one): named as the History
  // menu's Rename names one. A team's Lead or agent keeps its own name.
  const renameChat = (slot: string, title: string) => {
    const s = chats.slots[slot];
    if (!s?.sessionId || s.orchestrator || chats.agents[slot] || !title.trim()) return;
    renameSession(s.sessionId, title).catch(() => {});
  };
  const remoteRenameRef = useRef<(slot: string, title: string) => void>(() => {});
  remoteRenameRef.current = renameChat;
  useEffect(() => {
    const off = api.onRemoteRename((r) => remoteRenameRef.current(r.slot, r.title)).catch(() => null);
    return () => {
      off.then((f) => f?.());
    };
  }, []);
  useEffect(() => {
    for (const [slot, s] of Object.entries(chats.slots)) {
      const prompt = firstPrompt(s);
      const id = s.sessionId;
      // (Titles are made with Claude Code from a session's first prompt: another provider's chat is called by that prompt.)
      if (!id || !prompt || !s.folder || !s.claudePath || providerIdOf(s.provider) !== CLAUDE || titles[id] || titling.current.has(id)) continue;
      titling.current.add(id);
      // A routine's chat is called after the routine, not after what its prompt says (also when it is reopened later).
      const own = routineSlots.current[slot];
      const routine = own ? routineTitle(own.name) : routines.titles[id];
      if (routine) {
        setTitles((all) => ({ ...all, [id]: routine }));
        continue;
      }
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

  // A chat that has sat idle off screen for the time in Settings goes to sleep: its claude is stopped and its messages are
  // dropped from memory. It is still in the sidebar, and wakes (resumed, history and all) when opened.
  const sleepAfter = useSleepMinutes();
  const idleClock = useRef<Record<string, number>>({});
  // A team goes to sleep as one, once every member has rested: its Lead's slot stands for it in the clock.
  const sleepSlots = (slots: string[]) => {
    // What each one is, saved before any of them is put to sleep (an agent's is its place in the team: its Lead's session).
    const saved = Object.fromEntries(slots.map((slot) => [slot, savedChatOf(slot, chats.slots, active, drafts.current, titles, chats.agents)]));
    for (const slot of slots) {
      const s = chats.slots[slot];
      delete idleClock.current[slot];
      delete relaunch.current[slot];
      // Asleep first, so the end of its process (which closing it makes) is not taken for a crash.
      to(slot)({ type: "sleep", folder: s.folder!, sessionId: s.sessionId!, title: chatTitle(s, titles), ...(saved[slot] ? { saved: saved[slot]! } : {}) });
    }
    // Agents first, then the Lead that knows them.
    for (const slot of [...slots].reverse()) api.closeSession(slot).catch(() => {});
  };
  const sleepSweep = () => {
    const alone = Object.entries(chats.slots).flatMap(([slot, s]) => (canSleep(s, { active: slot === active, agent: !!chats.agents[slot], routine: slot in routineSlots.current }) ? [slot] : []));
    const routine = (slot: string) => slot in routineSlots.current;
    // An agent of a team that goes on stands for itself, with its own clock; a team that is all at rest stands for itself, by its Lead.
    const resting = teamsAtRest(chats, routine);
    const inRestingTeam = (slot: string) => resting.includes(chats.agents[slot]?.parent ?? "");
    const agents = agentsAtRest(chats, routine).filter((slot) => !inRestingTeam(slot));
    const eligible = new Set([...alone, ...resting, ...agents]);
    const { clock, due } = sweep(idleClock.current, eligible, Date.now(), sleepAfter * 60_000);
    idleClock.current = clock;
    for (const slot of due) {
      // An agent has its claude stopped and stays in its team and on the canvas (the backend says when it has: it refuses when
      // the agent is in the middle of something). A Lead stands for its team: the Lead first in the list, its agents after it.
      if (agents.includes(slot)) {
        delete idleClock.current[slot];
        api.sleepAgent(slot).catch(() => {});
      } else sleepSlots(chats.slots[slot]?.orchestrator && !chats.agents[slot] ? membersToSleep(chats, slot) : [slot]);
    }
  };
  const sweepNow = useRef(sleepSweep);
  sweepNow.current = sleepSweep;
  useEffect(() => sweepNow.current(), [chats.slots, active, sleepAfter]);
  useEffect(() => {
    const id = setInterval(() => sweepNow.current(), 30_000);
    return () => clearInterval(id);
  }, []);

  const working = anythingWorking(chats);
  useEffect(() => {
    api.keepAwake(working, keepAwake).catch(() => {});
  }, [working, keepAwake]);

  const announced = useRef<Record<string, string>>({});
  // Chats that finished in the background and haven't been looked at since: a blue dot, like an unread message.
  // Kept by session across launches (lib/unread.ts); `unread` is the open chats' share of it, by slot.
  const [unreadBy, setUnreadBy] = useState<Unread>(() => fromKept(readStored(UNREAD_KEY, {})));
  useEffect(() => {
    try {
      localStorage.setItem(UNREAD_KEY, JSON.stringify(toKeep(unreadBy)));
    } catch {
      // storage unavailable; unread just won't survive a restart
    }
  }, [unreadBy]);
  const unread = useMemo(() => unreadBySlot(unreadBy, chats.slots), [unreadBy, chats.slots]);
  // The chat on screen is read: once it is opened (a restored one too, once its session is known), or once the Desk in front of it is put away.
  const activeSession = chats.slots[active]?.sessionId;
  useEffect(() => {
    if (!desk) setUnreadBy((u) => markRead(u, active, chats.slots[active]));
  }, [active, desk, activeSession]);
  useEffect(() => {
    for (const [slot, s] of Object.entries(chats.slots)) {
      const a = attentionFor(s.items, s.folder, describeInput, agentName(s.provider));
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
      // A chat finished that isn't on screen (the one last open isn't while the Desk is): unread until it is opened.
      if ((slot !== chats.active || desk) && (a.kind === "finished" || a.kind === "failed")) setUnreadBy((u) => markUnread(u, slot, s, Date.now()));
      // Another chat finished or needs an answer: say so in the window too, and let the toast take you there.
      if (slot !== chats.active) {
        const project = s.folder && s.folder !== state.folder ? basename(s.folder) : null;
        if (wanted) setHud({ key: Date.now(), kind: a.kind, body: a.body, chat: { slot, title: chats.agents[slot]?.name ?? chatTitle(s, titles), project } });
      }
    }
  }, [chats.slots]);

  // The review and test of a builder's work came in, and the builder isn't the chat on screen: the inbox says so until it is looked at.
  const reviewSeen = useRef(new Set<string>());
  useEffect(() => {
    for (const lead of Object.values(chats.slots)) {
      for (const r of lead.reviews) {
        const key = `${r.builder}:${r.commit}`;
        if (!r.done || reviewSeen.current.has(key)) continue;
        reviewSeen.current.add(key);
        if (r.builder !== active && chats.slots[r.builder]) setUnreadBy((u) => markUnread(u, r.builder, chats.slots[r.builder], r.at));
      }
    }
  }, [chats.slots]);

  // A toast about a chat goes once you're in that chat; "Needs you" also once it isn't waiting any more.
  useEffect(() => {
    const slot = hud?.chat?.slot;
    if (!slot) return;
    const s = chats.slots[slot];
    if (active === slot || !s || (hud.kind === "waiting" && chatState(s, drafts.current[slot]) !== "waiting")) setHud(null);
  }, [hud, active, chats.slots]);

  // For the title bar: steps that failed in the latest turn.
  const lastPrompt = state.items.map((it) => it.type).lastIndexOf("user");
  const turnTools = state.items.slice(lastPrompt + 1).flatMap((it) => (it.type === "tool" ? [it] : []));
  // Cleared from the title bar: hidden until a different set of steps has failed.
  const failedKey = turnTools.filter((t) => t.status === "error").map((t) => t.id).join(",");
  const failed = clearedFailures[active] === failedKey ? 0 : failedCount(turnTools);

  // The team of the chat on screen (its main agent and workers), the ones waiting for you, and whether the canvas is what's
  // shown. Another chat, outside any team, has no canvas, and neither does the toggle for it.
  const team = teamMain(chats, active);
  const mains = Object.values(chats.slots).filter((s) => s.orchestrator).length;
  const nodes = team ? teamNodes(orchestraNodes(chats, (_slot, s) => (mains > 1 && s.folder ? `Lead · ${basename(s.folder)}` : "Lead")), team) : [];
  const inOrchestra = team !== null;
  const attention = needingYou(nodes, chats.slots);
  useEffect(() => {
    if (team) teamView.current[team] = view === "chat" ? active : "canvas";
  }, [team, view, active]);
  useAction("toggle-canvas", () => setView((v) => (v === "canvas" ? "chat" : "canvas")), inOrchestra);

  const lastTurn = [...state.items].reverse().find((it) => it.type === "turn");
  const lastTurnMs = lastTurn?.type === "turn" ? lastTurn.durationMs : null;
  // Recorded when a turn ends: the window it reported belongs to the model that ran it. (The next turn's init
  // changes the model before a new window arrives, so recording on every change could file it under the wrong one.)
  useEffect(() => {
    if (state.model && state.contextWindow && windows[state.model] !== state.contextWindow) setWindows({ ...windows, [state.model]: state.contextWindow });
  }, [lastTurn?.id]);
  // What the window is, or null when nothing says: the meter then shows the tokens, not a percent against a guess.
  const contextWindow = windowOf(state, windows);
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
  // "Restore files to here" on a sent message: what it did is said in the chat and told to Claude with the next message.
  const restoreEvents = state.folder && !stepsMode
    ? {
        onRestored: (since: string, result: RestoreResult, summary: string, files: { path: string; trashed: boolean }[]) => {
          to(active)({ type: "restore_done", id: result.id, since, summary, files });
          syncChanges(active);
        },
        onUndone: (id: number, text: string) => {
          to(active)({ type: "restore_undone", id, text });
          syncChanges(active);
        },
      }
    : undefined;
  const hero = state.items.length === 0 && !state.thinking;
  // At launch the last project is on its way back: say so, rather than flashing the screen for having none.
  const openingLast = !state.folder && lastFolder !== null && !reopened.current;
  // The Plan tab: the plan so far, from the same pages the Step-by-step view shows. A row asks the view to open its
  // page; the chat it was for is kept so a request can't land in another one.
  const stepPages = useMemo(() => (stepsView ? pagesOf(state.items) : null), [stepsView, state.items]);
  const stepsSummary = useMemo(() => {
    const summary = stepPages ? summarize(stepPages) : null;
    return summary && summary.rows.length > 0 ? summary : null;
  }, [stepPages]);
  const [pageJump, setPageJump] = useState<{ slot: string; page: string; key: number } | null>(null);
  const openPageIn = (slot: string) => (page: string) => setPageJump((j) => ({ slot, page, key: (j?.key ?? 0) + 1 }));
  // The Plan tab's map: the latest Architecture Overview's map, lit for the page on screen. A new Overview (not one already
  // there when the chat was opened) brings the tab up.
  const archMap = useMemo(() => (stepPages ? architectureMap(stepPages) : null), [stepPages]);
  // The Done page's "Review the changes": the side panel on Changes, showing everything this chat changed.
  const [changesAsked, setChangesAsked] = useState(0);
  // Ship it: the dialog that sends Claude one message to commit, push and open a pull request.
  const [shipping, setShipping] = useState(false);
  const handoff = stepsView && state.folder
    ? {
        slot: active,
        summary: stepsSummary,
        changed: state.changedFiles,
        doc: { pages: stepPages ?? [], title: chatTitle(state, titles), folder: state.folder },
        running: state.status === "running",
        onReviewChanges: () => {
          setChangeScope("session");
          setReviewCollapsed(false);
          setChangesAsked((n) => n + 1);
        },
        onStartNew: () => startFresh(state.folder!),
        onShip: () => setShipping(true),
      }
    : undefined;
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
  // A box a part's chip named: the Plan tab comes up on the map with it lit.
  const [archBox, setArchBox] = useState<{ id: string; key: number } | null>(null);
  const openArchitecture = {
    open: (box?: string) => {
      setReviewCollapsed(false);
      setArchOpenKey((k) => k + 1);
      if (box) setArchBox((b) => ({ id: box, key: (b?.key ?? 0) + 1 }));
    },
    label: (id: string) => (archMap?.kind === "native" ? (archMap.spec.nodes.find((n) => n.id === id)?.label ?? id) : id),
  };
  // "How the modes work", open on a mode's page.
  const [guideAt, setGuideAt] = useState<GuideKey | null>(null);
  const [settingsAt, setSettingsAt] = useState<SettingsTab | null>(null);
  useAction("settings", () => setSettingsAt(settingsAt ?? "general"));
  // The disk scan: a panel like Settings, from the title bar's Storage button (or the palette), for the whole app. Claude's
  // suggestions on it wear a dot on the button.
  const [storageOpen, setStorageOpen] = useState(false);
  const storage = useStorageView();
  // Sent now when Claude is free, queued behind the turn when it's working.
  const askStorage = state.status === "idle" || state.status === "running" ? () => (state.status === "running" ? dispatch({ type: "queue_set", items: [...state.queued, FREE_UP_SPACE_REQUEST] }) : sendIn(active, FREE_UP_SPACE_REQUEST)) : null;
  // ⇧⌘P: every action that can run, and the things that aren't shortcuts: switching Permissions, Workflow or Models, and each Settings
  // page. Listed as they are when the palette opens.
  const [palette, setPalette] = useState<PaletteEntry[] | null>(null);
  const paletteEntries = (): PaletteEntry[] => {
    const ready = !!state.folder && !isBusy(state);
    const permissions = (["ask", "auto"] as const)
      .filter((p) => ready && p !== permissionsOf(state) && (p !== "auto" || caps.supports_auto_mode))
      .map((p): PaletteEntry => ({ id: `permissions:${p}`, title: `Permissions: ${PERMISSIONS_LABEL[p]}`, group: "Permissions", shortcut: null, run: () => changePermissions(p) }));
    const workflows = (["chat", "steps", "team"] as const)
      .filter((w) => ready && w !== workflowOf(state) && !(w === "team" && (chats.agents[active] || !caps.can_lead_team)))
      .map((w): PaletteEntry => ({ id: `workflow:${w}`, title: `Workflow: ${WORKFLOW_LABEL[w]}${w === "steps" ? "…" : ""}`, group: "Workflow", shortcut: null, run: () => changeWorkflow(w) }));
    const harnesses = presets
      .filter((h) => ready && caps.supports_advisor && h.id !== harnessOf(active).id)
      .map((h): PaletteEntry => ({ id: `harness:${h.id}`, title: `Models: ${h.name}`, group: "Models", shortcut: null, run: () => switchHarness(h) }));
    const tabs = (["general", "harness", "endpoints", "mcp", "skills", "permissions", "prs", "updates"] as SettingsTab[])
      .filter((t) => (t !== "harness" || (!!state.folder && caps.supports_advisor)) && (t !== "skills" || caps.supports_skills))
      .map((t): PaletteEntry => ({ id: `settings:${t}`, title: `Settings: ${TAB_LABEL[t]}`, group: "Settings", shortcut: null, run: () => setSettingsAt(t) }));
    const routinesEntry: PaletteEntry = { id: "routines", title: "Routines…", group: "Routines", shortcut: null, run: () => setSettingsAt("routines") };
    const themes = THEMES.filter((t) => t.id !== theme && t.id !== "custom").map((t): PaletteEntry => ({ id: `theme:${t.id}`, title: `Theme: ${t.label}`, group: "Theme", shortcut: null, run: () => setTheme(t.id) }));
    // History with its search box ready: what was said in any past chat.
    const storageEntry: PaletteEntry = { id: "storage", title: "Storage", group: "View", shortcut: null, run: () => setStorageOpen(true) };
    const searchChats: PaletteEntry = { id: "search-chats", title: "Search all chats…", group: "View", shortcut: null, run: () => void openHistory() };
    const project = state.folder ? [{ id: "project-notes", title: "Project notes…", group: "Project", shortcut: null, run: () => setEditingNotes(state.folder) } satisfies PaletteEntry] : [];
    return [...availableActions(), searchChats, storageEntry, ...project, ...permissions, ...workflows, ...harnesses, routinesEntry, ...themes, ...tabs];
  };
  // The Work menu: Build, Debug and Design are Step by step in that flavour; Review a PR lists the open pull requests and
  // starts a review on the one chosen; Start a team makes an empty chat a team's Lead, and otherwise starts a new one.
  const workReady = !!state.folder && !isBusy(state) && !chats.agents[active];
  const [prPicker, setPrPicker] = useState(false);
  const pendingPrompt = useRef<{ slot: string; text: string; at: number } | null>(null);
  const startReviewOf = (pr: OpenPr) => {
    setPrPicker(false);
    pickFlavour("review");
    pendingPrompt.current = { slot: active, text: `Review PR #${pr.number}`, at: Date.now() };
  };
  // The message waits for the chat to be Step by step and idle (switching restarts its claude).
  useEffect(() => {
    const pending = pendingPrompt.current;
    const s = pending && chats.slots[pending.slot];
    if (!pending || !s) return;
    if (Date.now() - pending.at > 60_000) pendingPrompt.current = null;
    else if (s.mode === "steps" && s.status === "idle" && chatFlavour(s) === "review") {
      pendingPrompt.current = null;
      sendIn(pending.slot, pending.text);
    }
  }, [chats.slots]);
  // (On a provider that can't lead a team, a new chat is the Lead instead: it is Claude Code's.)
  const startTeam = () => (hero && caps.can_lead_team ? changeWorkflow("team") : newOrchestra());
  useAction("work-build", () => pickFlavour("build"), workReady);
  useAction("work-review-pr", () => setPrPicker(true), workReady);
  useAction("work-debug", () => pickFlavour("debug"), workReady);
  useAction("work-design", () => pickFlavour("architecture"), workReady);
  useAction("work-team", startTeam, workReady);
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
  // The project whose setup dialog is open.
  const [settingUp, setSettingUp] = useState<string | null>(null);
  // Closing an agent from the full-size chat's setup card: asked what would be lost first, as the canvas does.
  const [closingFull, setClosingFull] = useState<{ slot: string; check: CloseCheck } | null>(null);
  const [closingBusy, setClosingBusy] = useState(false);
  const [bringing, setBringing] = useState<{ destination: string | null; from: string | null } | null>(null);
  const refreshMoved = () => api.movedFolderCandidates().then(setMoved, () => setMoved([]));
  useEffect(() => {
    refreshMoved();
  }, []);
  const bringHere = () => setBringing({ destination: state.folder, from: null });
  useAction("relocate-folder", bringHere, true);
  useAction("ship-it", () => setShipping(true), !!state.folder && (state.status === "idle" || state.status === "running"));
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
    const permissions = take<Record<string, Permissions>>("settings.permissionsByFolder");
    if (permissions) setPermissionsBy(permissions);
    const workflows = take<Record<string, Workflow>>("settings.workflowByFolder");
    if (workflows) setWorkflowBy(workflows);
    const subagents = take<Record<string, Subagents>>("settings.subagentsByFolder");
    if (subagents) setSubagentsBy(subagents);
    const prompts = take<Record<string, string[]>>("settings.promptHistory");
    if (prompts) setPromptsBy(prompts);
    const harness = take<Record<string, string>>("settings.harnessByFolder");
    if (harness) setHarnessByFolder(harness);
    const provider = take<Record<string, string>>("settings.providerByFolder");
    if (provider) setProviderByFolder(provider);
    const collapsed = take<Record<string, boolean>>("review.collapsedByFolder");
    if (collapsed) setCollapsedBy(collapsed);
    const pinned = take<Record<string, string[]>>("settings.pinnedSessions");
    if (pinned) setPinnedBy(pinned);
    roleStore.carry(changed);
    const notes = take<Record<string, string>>("settings.projectNotes");
    if (notes) setNotesBy(notes);
    const colors = take<Record<string, number>>("sidebar.projectColors");
    if (colors) setProjectColors(colors);
    const setups = take<SetupByFolder>("settings.projectSetupByFolder");
    if (setups) setSetupBy(setups);
    const hooks = take<Record<string, ProjectHooks>>("settings.chatHooksByFolder");
    if (hooks) setHooksBy(hooks);
    const order = take<string[]>("sidebar.projectOrder");
    if (order) setProjectOrder(order);
    const prs = take<Record<string, Partial<PrSetting>>>("prChecks.byFolder");
    if (prs) setPrSettings(prs);
    if (changed["prChecks.loopByFolder"]) prChecks.reloadLoops();
    const last = take<string>(LAST_FOLDER);
    if (last) setLastFolder(last);
    if (changed["settings.routines"]) routines.replace(changed["settings.routines"]);
    if (changed[OPEN_CHATS]) setOffer((chats) => chats.map((c) => (c.folder === old ? { ...c, folder: next } : c)));
  };
  // One place's sessions came over. The dialog stays open for the others, so only the saved state moves here.
  const relocated = (old: string, next: string) => {
    carryFolderState(old, next);
    refreshMoved();
    refreshMoves();
  };
  // The actions on a folder's past chats: for the one on screen, and for the project a History is open for.
  const actionsFor = (folder: string | null): SessionActions | null =>
    folder
      ? {
          folder,
          pinned: pinnedBy[folder] ?? [],
          onTogglePin: (id) => {
            const pinned = pinnedBy[folder] ?? [];
            setPinnedBy({ ...pinnedBy, [folder]: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id] });
          },
          onRename: renameSession,
          onExport: (id, title) => {
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
  // The same object until something in it changes: a new one each time the app drew made React look through every
  // component for readers of it, for each word an agent streamed.
  const sessionActions = useMemo(() => actionsFor(state.folder), [state.folder, pinnedBy, active]);
  const startTemplate = useCallback(() => setTemplateDialog(true), []);

  // The sidebar: every project, and the chats open in each. It is pinned open, collapsed (a slim column of the open chats that
  // opens over the chat when the pointer rests on it) or hidden: whether it is hidden and whether it is collapsed ("compact")
  // are saved apart (so showing it again returns to whichever it was), and so is its width. The first key is the one that
  // once said "minimized to the rail": that is hidden now.
  const [sidebarHidden, setSidebarHidden] = usePersistentState("sidebar.collapsed", false);
  const [sidebarCompact, setSidebarCompact] = usePersistentState("sidebar.compact", false);
  const [projectColors, setProjectColors] = usePersistentState<Record<string, number>>("sidebar.projectColors", {});
  // The sidebar's One project: kept here, not in the sidebar (a peek mounts a new one, and a hidden one isn't there), so a phone
  // that picks one is heard whatever the sidebar is doing, and the phones that follow it are told each time it changes.
  const [singleProject, setSingleProject] = usePersistentState<string | null>("sidebar.single", null);
  const singleColor = singleProject !== null && projectColors[singleProject] !== undefined ? (PROJECT_COLORS[projectColors[singleProject]] ?? null) : null;
  useEffect(() => {
    void api.remoteWindowSingle(singleProject !== null ? { folder: singleProject, color: singleColor } : null).catch(() => {});
  }, [singleProject, singleColor]);
  useEffect(() => {
    const off = api.onRemoteSingle((r) => setSingleProject(r.folder)).catch(() => null);
    return () => {
      off.then((f) => f?.());
    };
  }, []);
  // The user's order of the projects (see orderProjects).
  const [projectOrder, setProjectOrder] = usePersistentState<string[]>("sidebar.projectOrder", []);
  // What the sidebar last listed, so showing it again (a peek mounts a new one) starts from that instead of empty.
  const sidebarMemoryRef = useRef(sidebarMemory());
  const [sidebarWidth, setSidebarWidth] = usePersistentState("sidebar.width", SIDEBAR_DEFAULT);
  // Projects removed from the recents here (Claude Code keeps their chats; one with a chat open is listed regardless).
  const [hiddenFolders, setHiddenFolders] = usePersistentState<string[]>("sidebar.hidden", []);
  // Whether a project's chats move up the list when they do something (Settings → General); off, they keep their places.
  const [sortByActivity, setSortByActivity] = usePersistentState<boolean>("settings.sortChatsByActivity", false);
  const openByProject = openProjects(chats, { titles, drafts: drafts.current, unread, pinned: pinnedBy, byActivity: sortByActivity });
  // The menu bar panel (another window) lists the open chats: told when they change, and when the panel asks.
  const menuBarList = menuBarChats(openByProject);
  const menuBarKey = JSON.stringify(menuBarList);
  const menuBarSent = useRef(menuBarList);
  menuBarSent.current = menuBarList;
  useEffect(() => {
    void api.publishMenubarChats(menuBarSent.current).catch(() => {});
  }, [menuBarKey]);
  // The phones connected now (Remote control), for the title bar: asked again whenever one connects or goes.
  const [phonesOn, setPhonesOn] = useState<string[]>([]);
  useEffect(() => {
    const refresh = () => api.remoteSettings().then((v) => setPhonesOn(connectedNames(v)), () => {});
    refresh();
    const unlisten = api.onRemoteChanged(refresh).catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
  }, []);
  // The backend's session hub knows where each chat stands from its events; what only this window knows (the title it
  // shows, which chats are asleep) it is told when that changes.
  // A chat on another provider than Claude's is named (a restored one that isn't open yet from what was saved of its session): a
  // phone shows it, and nothing said in the chat is put to Claude for a phone's suggestions.
  const providerLabel = (slot: string) => {
    const s = chats.slots[slot];
    const id = s?.provider ? providerIdOf(s.provider) : ((s?.sessionId && providerBySession[s.sessionId]) || CLAUDE);
    return id !== CLAUDE ? providerName(id) : null;
  };
  const hubList = windowChats(chats, openByProject, harnessBySlot, projectColors, providerLabel);
  const hubKey = JSON.stringify(hubList);
  useEffect(() => {
    void api.remoteWindowChats(hubList).catch(() => {});
  }, [hubKey]);
  // A phone's Desk: what the Desks hold, told when it changes. Nothing said in a chat on another provider is put to Claude.
  const phoneDesk = windowDesk(chats, openByProject, desks);
  const phoneDeskKey = JSON.stringify(phoneDesk);
  useEffect(() => {
    void api.remoteWindowDesk(phoneDesk).catch(() => {});
  }, [phoneDeskKey]);
  // What the panel asked of this window, which the backend already checked and brought forward: open a chat, start one in a
  // project the user knows, or open Storage or Settings. The ref is read when it happens, so it sees the chats as they are then.
  const menuBarAct = useRef<(a: MenuBarAction) => void>(() => {});
  menuBarAct.current = (a) => {
    if (a.kind === "chat") switchTo(a.slot);
    else if (a.kind === "storage") setStorageOpen(true);
    else if (a.kind === "settings") setSettingsAt("general");
    else if (a.kind === "new_chat" && validChatText(a.text)) {
      const openFolders = Object.values(chats.slots).map((s) => s.folder);
      api.recentFolders().then(
        (recent) => knownProject(a.folder, recent, openFolders) && startFresh(a.folder, false, false, a.text),
        () => {},
      );
    }
  };
  useEffect(() => {
    const unlistenAct = api.onMenubarAction((a) => menuBarAct.current(a)).catch(() => null);
    const unlistenNeed = api.onMenubarNeedChats(() => void api.publishMenubarChats(menuBarSent.current).catch(() => {})).catch(() => null);
    return () => {
      unlistenAct.then((f) => f?.());
      unlistenNeed.then((f) => f?.());
    };
  }, []);
  // Pull request checks: each project's choice (Off, Tell me, Fix it myself), and the loop that watches the pull request.
  const [prSettings, setPrSettings] = usePersistentState<Record<string, Partial<PrSetting>>>("prChecks.byFolder", {});
  const [prDialog, setPrDialog] = useState<string | null>(null);
  const prChecks = usePrChecks({
    chats: Object.entries(chats.slots).flatMap(([slot, s]) => (s.folder ? [{ slot, folder: s.folder, live: s.status === "idle" || s.status === "running", busy: isBusy(s) }] : [])),
    active,
    settings: prSettings,
    send: (slot, text) => sendIn(slot, text),
    onFailed: (folder, slot, snap) => {
      const body = `${basename(folder)}: pull request #${snap.pr.number}`;
      const wanted = shouldNotify(notifyPrefs, "failed");
      if (wanted && (!windowFocused() || slot !== chats.active)) notify(`Checks failed on ${snap.pr.branch}`, body, "failed");
      const s = chats.slots[slot];
      if (wanted && s && slot !== chats.active) setHud({ key: Date.now(), kind: "failed", body: `Checks failed on ${snap.pr.branch}`, chat: { slot, title: chats.agents[slot]?.name ?? chatTitle(s, titles), project: basename(folder) } });
    },
  });
  // Settings → Pull requests lists every project: the open ones and the recents (read when Settings opens).
  const [prFolders, setPrFolders] = useState<string[]>([]);
  useEffect(() => {
    if (settingsAt === null) return;
    const list = (recent: RecentFolder[]) => sidebarProjects({ recent, hidden: hiddenFolders, open: openByProject, order: projectOrder }).map((p) => p.folder);
    loadRecentFolders().then((recent) => setPrFolders(list(recent)), () => setPrFolders(list([])));
  }, [settingsAt]);
  const prRows = checkItems(
    Object.values(prChecks.views).flatMap((v) => {
      const slot = Object.entries(chats.slots).filter(([, s]) => s.folder === v.folder && (s.status === "idle" || s.status === "running")).map(([id]) => id);
      const target = slot.includes(active) ? active : slot[slot.length - 1];
      return v.needsYou && v.snap && target ? [{ folder: v.folder, slot: target, where: basename(v.folder), branch: v.snap.pr.branch, number: v.snap.pr.number, failed: v.snap.checks.filter((c) => c.bucket === "fail").length }] : [];
    }),
  );
  const inbox = [...inboxItems(chats, openByProject, { unread, describe: describeInput }), ...prRows];
  // The Desk shows once something is open: until then the window's start (open a folder, chats to bring back) is what there is.
  const deskShown = desk && Object.keys(openByProject).length > 0;
  // What the Desk on screen has: its projects' chats only.
  const deskOpen = openOn(desks, desks.on, openByProject);
  const onThisDesk = (slot: string) => {
    const folder = projectFolderOf(slot);
    return folder !== null && deskOf(desks, folder) === desks.on;
  };
  // The projects a message on this Desk may start a chat in: the ones open on it, and the ones given to it.
  const deskFolders = [...new Set([...Object.keys(deskOpen), ...(desks.on === "home" ? [] : (desks.list.find((d) => d.id === desks.on)?.projects ?? []))])];
  // A project's own page on the Desk (its folder), kept while you are in one of its chats; the Desk's button goes back to all.
  const [deskPage, setDeskPage] = useState<string | null>(null);
  const pageOn = deskPage !== null && deskFolders.includes(deskPage) ? deskPage : null;
  // Ask asks about that project only while its page is open: its chats to route to, and it to start one in. The board itself
  // (to-dos, status) still covers the whole Desk.
  const askOpen = pageOn ? (deskOpen[pageOn] ? { [pageOn]: deskOpen[pageOn] } : {}) : deskOpen;
  const askFolders = pageOn ? [pageOn] : deskFolders;
  const deskCandidates = routeCandidates(chats, askOpen);
  const deskTargets = deskCandidates.map((c) => ({ slot: c.id, title: c.title, where: c.project }));
  const deskProjects = askFolders.map((folder, i) => ({ folder, label: projectLabels(askFolders)[i] }));
  // The board's to-do counts, read only while the Desk is on screen.
  const deskTodos = useTodoCounts(deskShown ? deskFolders : []);
  // And how its repositories stand (branches, pull requests, releases): the Mac's, for this Desk's projects only.
  const allRepos = useDeskStatus(deskShown, deskFolders);
  const deskRepos = allRepos && allRepos.filter((r) => r.folders.some((f) => deskFolders.includes(f.folder)));
  const deskRows = deskShown ? deskInbox(chats, deskOpen) : [];
  const deskNeeds = inbox.filter((it) => onThisDesk(it.slot));
  const deskEdit = (id: string, change: (e: DeskEntry) => DeskEntry) => setDeskLog((all) => all.map((e) => (e.id === id ? change(e) : e)));
  // A message goes to a chat as if typed there: now when the chat is free, queued behind its turn when it's working.
  const deliver = (slot: string, text: string): { queued: boolean } | string => {
    const s = chats.slots[slot];
    if (!s) return "That chat is closed.";
    if (s.status === "idle") {
      sendIn(slot, text);
      return { queued: false };
    }
    if (s.status === "running") {
      to(slot)({ type: "queue_set", items: [...s.queued, text] });
      return { queued: true };
    }
    return s.status === "asleep" ? "That chat is asleep. Open it to wake it, then send it again." : s.status === "starting" ? "That chat is still starting. Send it again in a moment." : "That chat isn't running.";
  };
  const deskSendTo = (entry: DeskEntry, slot: string) => {
    const done = deliver(slot, entry.text);
    const title = deskTargets.find((t) => t.slot === slot)?.title ?? chatTitle(chats.slots[slot] ?? initialState, titles);
    if (typeof done === "string") {
      // What the Desk said it would do didn't happen: it goes, so it never claims what didn't happen.
      if (entry.outcome.kind !== "sent") deskEdit(entry.id, (e) => ({ ...e, say: undefined, outcome: { kind: "failed", why: done } }));
      else setHud({ key: Date.now(), kind: "warning", body: done });
      return;
    }
    deskEdit(entry.id, (e) => (e.outcome.kind === "sent" ? { ...e, also: [...e.also, { slot, title }] } : { ...e, outcome: { kind: "sent", slot, title, started: false, queued: done.queued }, reply: { status: "waiting" } }));
  };
  const deskStartIn = (entry: DeskEntry, folder: string, workflow: "chat" | "steps" = "chat") => {
    if (!agentReady) return deskEdit(entry.id, (e) => ({ ...e, say: undefined, outcome: { kind: "failed", why: "No agent provider is installed yet." } }));
    const slot = takeSlot();
    startIn(slot, folder, false, false, entry.text, undefined, undefined, workflow === "steps" ? { permissions: permissionsFor(folder), preset: null, workflow } : false);
    deskEdit(entry.id, (e) => ({ ...e, outcome: { kind: "sent", slot, title: clip(entry.text, 60), started: true, queued: false }, reply: { status: "waiting" } }));
  };
  // The router answers after the chats may have changed: what it says is carried out with the newest of these.
  const deskNow = useRef({ deskSendTo, deskStartIn });
  deskNow.current = { deskSendTo, deskStartIn };
  const desksNow = useRef(desks);
  desksNow.current = desks;
  const deskSend = (text: string, picked: string | null) => {
    const entry: DeskEntry = { id: `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, desk: desks.on, at: Date.now(), text, outcome: { kind: "routing" }, also: [] };
    setDeskLog((all) => [...all, entry].slice(-LOG_MAX));
    if (picked) return deskSendTo(entry, picked);
    // What the router is shown is kept: its answer is matched against this, whatever the Desk shows by the time it comes.
    const sentTargets = deskTargets;
    const sentProjects = deskProjects;
    const deskId = desks.on;
    const sentScope = pageOn;
    const ask = (chats: string[], unsure: boolean) => {
      const asked = chats.map((slot) => sentTargets.find((t) => t.slot === slot)).filter((t): t is (typeof sentTargets)[number] => !!t);
      // Unsure, or nothing to pick from: a new chat is offered too. Unsure, what the Desk said it would do didn't happen.
      deskEdit(entry.id, (e) => ({ ...e, ...(unsure ? { say: undefined } : {}), outcome: { kind: "ask", chats: asked, projects: unsure || asked.length === 0 ? sentProjects : [], unsure } }));
    };
    // The Desk talks (its Sonnet agent, which reads the chats): what it says back is shown to you only; what it does is checked as the router's choice is.
    const history = deskHistory(deskLog, deskId);
    api.deskTalk(state.claudePath ?? "", deskId, text, history, deskCandidates, sentProjects.map((p) => p.label)).then(
      ({ say, route: r }) => {
        const now = deskNow.current;
        if (say) deskEdit(entry.id, (e) => ({ ...e, say }));
        if (r === null) deskEdit(entry.id, (e) => ({ ...e, outcome: { kind: "talk" } }));
        else if (r.kind === "route") now.deskSendTo(entry, r.chat);
        else if (r.kind === "start") {
          const folder = sentProjects.find((p) => p.label === r.project)?.folder;
          if (folder) now.deskStartIn(entry, folder, r.workflow);
          else ask([], true);
        } else if (r.kind === "search" || r.kind === "answer") {
          const answering = r.kind === "answer";
          deskEdit(entry.id, (e) => ({ ...e, outcome: answering ? { kind: "answer", terms: r.terms, hits: null, text: null } : { kind: "search", terms: r.terms, hits: null } }));
          // A question about how things stand: the Desk answers it from the chats found (only you are shown it).
          // Never from a chat that ran on another provider: nothing said there is put to Claude.
          const onClaude = (hits: ChatHit[]) => hits.slice(0, 5);
          const answer = (hits: ChatHit[]) => {
            const done = (text: string | null, error?: string) => deskEdit(entry.id, (e) => (e.outcome.kind === "answer" ? { ...e, outcome: { ...e.outcome, text, ...(error ? { error } : {}) } } : e));
            if (hits.length === 0) return done("");
            api.deskAnswer(state.claudePath ?? "", text, hits.map((h) => ({ id: h.id, folder: h.folder, title: h.title.map((p) => p.text).join(""), project: h.project }))).then(
              (t) => done(t),
              (err) => done(null, errText(err)),
            );
          };
          // Found once and kept with the message. A newer search cancels this one: it looks again, once.
          const found = (hits: ChatHit[] | "failed") => {
            const kept = answering && hits !== "failed" ? onClaude(hits) : hits;
            deskEdit(entry.id, (e) => (e.outcome.kind === "search" || e.outcome.kind === "answer" ? { ...e, outcome: { ...e.outcome, hits: kept } } : e));
            if (answering && kept !== "failed") answer(kept);
          };
          const look = (again: boolean): Promise<void> =>
            searchPast(r.terms).then((res) => (res.cancelled ? (again ? look(false) : found("failed")) : found(res.chats.filter((c) => deskOf(desksNow.current, c.folder) === deskId && (sentScope === null || c.folder === sentScope)).slice(0, 5))));
          look(true).catch(() => found("failed"));
        } else ask(r.chats, r.unsure);
      },
      (e) => deskEdit(entry.id, (x) => ({ ...x, outcome: { kind: "failed", why: errText(e) } })),
    );
  };
  // What came back from the chat a Desk message went to: once its turn finishes, a short summary (Haiku) under the message.
  // Each is asked for once (the in-flight set guards a redraw), and only for messages sent since the Desk talks; a chat on
  // another provider gets none, as nothing said there is put to Claude.
  const summarizing = useRef(new Set<string>());
  useEffect(() => {
    for (const e of deskLog) {
      if (e.outcome.kind !== "sent" || e.reply?.status !== "waiting" || summarizing.current.has(e.id)) continue;
      const slot = e.outcome.slot;
      // Only a chat still on the Desk the message was typed on: no other Desk's chat is read for it.
      const folder = projectFolderOf(slot);
      if (folder === null || deskOf(desks, folder) !== e.desk) continue;
      const s = chats.slots[slot];
      const found = s ? replyOf(slot, s, e.text, e.at) : null;
      if (!found) continue;
      const full = found.said.slice(0, FULL_MAX);
      const base = { key: found.key, full, outcome: found.outcome };
      if (!full.trim()) {
        deskEdit(e.id, (x) => ({ ...x, reply: { status: "done", ...base, summary: found.outcome === "done" ? "It finished without saying anything." : found.outcome === "failed" ? "It failed without saying why." : "It was stopped." } }));
        continue;
      }
      summarizing.current.add(e.id);
      deskEdit(e.id, (x) => ({ ...x, reply: { status: "summarizing", ...base } }));
      api.deskSummary(state.claudePath ?? "", e.text, full).then(
        (summary) => deskEdit(e.id, (x) => ({ ...x, reply: { status: "done", ...base, summary } })),
        (err) => deskEdit(e.id, (x) => ({ ...x, reply: { status: "failed", ...base, why: errText(err) } })),
      );
    }
  }, [chats, deskLog, desks]);
  useAction("toggle-sidebar", () => setSidebarHidden(!sidebarHidden), true, sidebarHidden ? "Show Sidebar" : "Hide Sidebar");
  useAction("toggle-compact", () => setSidebarCompact(!sidebarCompact), true, sidebarCompact ? "Expand Sidebar" : "Collapse Sidebar");
  useEffect(() => {
    api.sidebarMenu(sidebarHidden, sidebarCompact).catch(() => {});
  }, [sidebarHidden, sidebarCompact]);
  // Hidden, it slides in over the chat when the pointer rests on the window's left edge.
  const sidebarPeek = usePeek(sidebarHidden);
  // The peek's own button keeps the sidebar open: pinned.
  const keepSidebarOpen = () => {
    setSidebarHidden(false);
    setSidebarCompact(false);
  };
  // History: the past chats of every project, from the sidebar's History button or ⌘K (a project's, filtered to it, from
  // "Bring old chats here"). The projects are read when it opens, so it lists the ones the sidebar knows now.
  const [history, setHistory] = useState<{ folder: string | null; projects: HistoryProject[] } | null>(null);
  const openHistory = (folder: string | null = null) =>
    loadRecentFolders().then(
      (recent) => setHistory({ folder, projects: sidebarProjects({ recent, hidden: hiddenFolders, open: openByProject, order: projectOrder }).map((p) => ({ folder: p.folder, label: p.label })) }),
      () => setHistory({ folder, projects: [] }),
    );
  const toggleHistory = () => (history ? setHistory(null) : void openHistory());
  const canStart = !!state.folder && state.status !== "starting";
  useAction("session-history", toggleHistory, true);
  useAction("new-session", () => state.folder && startFresh(state.folder), canStart);
  const openChatIds = Object.values(chats.slots).flatMap((s) => (s.sessionId ? [s.sessionId] : []));
  const inTeam = (team: string) => teamMain(chats, active) === team;
  const sidebarBase = {
    onRename: renameChat,
    onChat: switchTo,
    // Its canvas, unless the team was left with a chat full size, which it comes back to (a click while in it is the way back to the canvas).
    onTeam: (slot: string) => {
      setDesk(false);
      const here = inTeam(slot);
      if (here) focusAgent(slot);
      else switchTo(slot);
      if (here || viewOf(slot) === null) setView("canvas");
    },
    // An agent is focused on its team's canvas, leaving the team's Lead where it is.
    onAgent: (slot: string, team: string) => {
      setDesk(false);
      if (!inTeam(team)) switchTo(team);
      focusAgent(slot);
      setView("canvas");
    },
    onCloseChats: closeChats,
    closeCheck: doing.closeCheck,
    closeWorker: doing.closeWorker,
    onHistory: toggleHistory,
    onNewChatIn: (folder: string) => startFresh(folder),
    onNewTeamIn: (folder: string) => newOrchestra(folder),
    onBringOld: (folder: string) => setBringing({ destination: folder, from: null }),
    onProjectNotes: (folder: string) => setEditingNotes(folder),
    onSetup: (folder: string) => setSettingUp(folder),
    onReveal: (folder: string) => void revealItemInDir(folder).catch(() => {}),
    onRemove: (folder: string) => setHiddenFolders([...hiddenFolders.filter((f) => f !== folder), folder]),
    onPrChecks: (folder: string) => setPrDialog(folder),
    onOpenFolder: openFolder,
    onNewChat: () => state.folder && startFresh(state.folder),
    onNewTeam: () => newOrchestra(),
    onNewTeamTemplate: () => state.folder && setTemplateDialog(true),
    onReviewPr: () => setPrPicker(true),
  };
  // The inbox's Allow and Deny answer the request the row named, and only while it is still waiting (one answered in the
  // chat, or withdrawn, meanwhile is left alone; a later request is a new row).
  const answerFromInbox = (item: InboxItem, allow: boolean) => {
    const waiting = chats.slots[item.slot]?.items.some((it) => it.type === "permission" && it.id === item.requestId && it.decision === null);
    if (item.requestId && waiting) decideIn(item.slot, item.requestId, allow);
  };
  // The inbox's Go: the same place the sidebar's row for it goes to.
  const goToInbox = (item: InboxItem) => (item.role === "agent" && item.team ? sidebarHandlers.onAgent(item.slot, item.team) : item.role === "lead" ? sidebarHandlers.onTeam(item.slot) : sidebarHandlers.onChat(item.slot));
  // Starting something from the sidebar leaves the Desk for it.
  const leaveDesk = <A extends unknown[]>(run: (...args: A) => void) => (...args: A) => {
    setDesk(false);
    run(...args);
  };
  const sidebarHandlers = {
    ...sidebarBase,
    onNewChatIn: leaveDesk(sidebarBase.onNewChatIn),
    onNewTeamIn: leaveDesk(sidebarBase.onNewTeamIn),
    onNewChat: leaveDesk(sidebarBase.onNewChat),
    onNewTeam: leaveDesk(sidebarBase.onNewTeam),
    onNewTeamTemplate: leaveDesk(sidebarBase.onNewTeamTemplate),
    onReviewPr: leaveDesk(sidebarBase.onReviewPr),
    onSetup: leaveDesk(sidebarBase.onSetup),
  };
  // Picking something in the peeked sidebar takes you there and puts it away.
  const then = <A extends unknown[]>(run: (...args: A) => void) => (...args: A) => {
    sidebarPeek.close();
    run(...args);
  };
  const peekHandlers = {
    ...sidebarHandlers,
    onChat: then(sidebarHandlers.onChat),
    onTeam: then(sidebarHandlers.onTeam),
    onAgent: then(sidebarHandlers.onAgent),
    onHistory: then(sidebarHandlers.onHistory),
    onNewChatIn: then(sidebarHandlers.onNewChatIn),
    onNewTeamIn: then(sidebarHandlers.onNewTeamIn),
    onBringOld: then(sidebarHandlers.onBringOld),
    onProjectNotes: then(sidebarHandlers.onProjectNotes),
    onSetup: then(sidebarHandlers.onSetup),
    onOpenFolder: then(sidebarHandlers.onOpenFolder),
    onNewChat: then(sidebarHandlers.onNewChat),
    onNewTeam: then(sidebarHandlers.onNewTeam),
    onNewTeamTemplate: then(sidebarHandlers.onNewTeamTemplate),
    onReviewPr: then(sidebarHandlers.onReviewPr),
  };
  const sidebarProps = {
    memory: sidebarMemoryRef.current,
    order: projectOrder,
    onOrder: setProjectOrder,
    width: sidebarWidth,
    onWidth: setSidebarWidth,
    open: openByProject,
    currentFolder: state.folder,
    branch,
    canNew: canStart,
    loadRecent: loadRecentFolders,
    hidden: hiddenFolders,
    moved: relocateMenu.moved,
    onRelocate: (from: MovedFolder) => relocateMenu.onRelocate(from),
    onDismissMoved: relocateMenu.onDismiss,
    colors: projectColors,
    onColors: setProjectColors,
    single: singleProject,
    onSingle: setSingleProject,
    noted: notedFolders(notesBy),
    desk: {
      on: deskShown,
      needs: needsYou(openByProject),
      onOpen: () => {
        deskByButton.current = true;
        setDeskPage(null);
        setDesk(!deskShown);
      },
    },
    timeline: () => timelineEvents(chats, openByProject, inbox),
  };

  const restartToUpdate = () => {
    setInstallStarted(true);
    setSettingsAt(null);
    // The chats are saved as they change: the next launch brings them back by itself.
    markRestoreAfterUpdate();
    api.restartToUpdate().catch((e) => {
      clearRestoreAfterUpdate();
      setInstallStarted(false);
      // The attempt used the download up: it has to be fetched again.
      setUpdate(null);
      dispatch({ type: "failed", text: errText(e) });
    });
  };
  const updateOffer = update && !updateLater ? { version: update.version, busy: Object.values(chats.slots).filter(isBusy).length, onRestart: restartToUpdate, onLater: () => setUpdateLater(true) } : undefined;
  // The chats open now, for an item's link in the Todos tab.
  const todoChatList: Record<string, TodoChat> = Object.fromEntries(Object.entries(chats.slots).map(([slot, s]) => [slot, { title: chats.agents[slot]?.name ?? chatTitle(s, titles), working: isBusy(s) }]));
  const composer = (
    <MessageInput
      key={`input-${active}-${composerEpoch}`}
      status={state.status}
      provider={state.provider}
      // (Not for a main agent that already has workers: starting it again on another provider would pull it out from under them.)
      providers={providers.multi && state.folder && !Object.values(chats.agents).some((a) => a.parent === active) ? { options: providers.list.map((l) => ({ id: l.id, name: providerName(l.id), capabilities: l.capabilities })), chosen: activeProvider, onChoose: chooseProvider } : undefined}
      onSend={(text, draft) => {
        if (addTodoFromBox(text)) return;
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
      permissions={state.folder ? permissionsOf(state) : undefined}
      workflow={state.folder ? workflowOf(state) : undefined}
      flavour={flavour}
      onPermissionsChange={(p) => changePermissions(p)}
      onWorkflowChange={(w) => changeWorkflow(w)}
      holdsAgents={holdsAgents(active)}
      model={state.model}
      idlePlaceholder={stepsView ? (flavour === "review" ? "Ask about this file…" : "Ask about this page or change it…") : stepsMode && hero ? explain && flavour === "build" ? "What do you want to learn, and what for?" : heroPlaceholder(agentName(state.provider))[flavour ?? "none"] : undefined}
      sendAndNext={stepsView ? (text) => sendIn(active, andNext(text)) : undefined}
      hero={hero}
      folder={state.folder}
      onOpenFolder={openFolder}
      sessions={{ load: loadSessions, exclude: openChatIds, onOpen: (id) => openSession(id) }}
      folders={{ load: loadRecentFolders, onPick: (path) => startFresh(path), relocate: relocateMenu }}
      models={{
        chosen: settingsFor(active).model,
        onChoose: chooseModel,
        // The defaults and versions seen are Claude's; another provider's chat lists its own models.
        defaultModel: activeProvider === CLAUDE ? defaultModel : null,
        ids: activeProvider === CLAUDE ? modelIds : undefined,
        // Another provider's, until its session lists them: the names its CLI takes (Claude's built-in list would be wrong for it).
        // An endpoint's is always its own list from Settings: its session, being Claude Code, reports Claude's, which it hasn't.
        options: isGateway(activeProvider) ? modelOptionsFor(listingOf(activeProvider)?.models ?? [], providerName(activeProvider), true) : activeProvider === CLAUDE || state.models.length > 0 ? state.models : modelOptionsFor(listingOf(activeProvider)?.models ?? [], providerName(activeProvider)),
      }}
      effort={{ chosen: settingsFor(active).effort, onChoose: changeEffort }}
      harness={state.folder ? { presets, chosen: harnessOf(active).id, onChoose: (id) => switchHarness(findHarness(presets, id)), onEdit: () => setSettingsAt("harness") } : undefined}
      usage={{ used: state.contextUsed, window: contextWindow, lastTurnMs, session: { cost: state.sessionCost, tokens: state.sessionTokens }, actions: state.folder && !stepsMode ? { onCompact: () => void api.conversationAction(active, "compact").catch((e) => dispatch({ type: "failed", text: errText(e) })), onClear: () => clearChat(active) } : undefined }}
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

  // The project's Run command in the title bar, for a chat that isn't on the canvas (the canvas cards have their own).
  const topRun = !showCanvas && state.folder && !state.setup && state.status !== "starting" ? runCommandOf(setupBy, projectFolderOf(active)) : null;
  // A worker's setup, and the project's Run command, above the chat box.
  // The to-do this chat was started on, still open, once a turn has ended since the user last said "Not yet".
  const todoLink = todoChats[active];
  const todoOnScreen = todoLink && todoLink.folder === state.folder ? todoList.listing?.items.find((t) => t.id === todoLink.id && !t.done) : undefined;
  const askTodo = !!todoOnScreen && state.status === "idle" && state.items.length > 0 && state.items.length > todoLink.asked && state.items.some((i) => i.type === "assistant");
  const chatExtras = (state.setup || state.run || askTodo) && (
    <div className="chat-extras">
      {state.setup && <SetupNotice key={active} card={state.setup} onAnswer={(answer) => doing.answerSetup(active, answer)} onClose={() => void closeFull(active)} />}
      {state.run && <RunPanel key={state.run.id} run={state.run} onStop={() => doing.stopRun(active)} onRestart={() => doing.run(active)} onClose={() => doing.closeRun(active)} />}
      {askTodo && todoOnScreen && (
        <TodoDoneBar
          todo={todoOnScreen}
          onDone={() => void todoList.edit({ op: "done", id: todoOnScreen.id, done: true }).catch((e) => dispatch({ type: "failed", text: errText(e) }))}
          onNotYet={() => setTodoChats((all) => ({ ...all, [active]: { ...todoLink, asked: state.items.length } }))}
        />
      )}
    </div>
  );
  // "Close agent" on a full-size card whose setup failed: nothing to lose closes at once, else the user is asked.
  const closeFull = (slot: string) =>
    doing.closeCheck(slot).then(
      (check) => (lostText(check) ? setClosingFull({ slot, check }) : doing.closeWorker(slot)),
      (e) => dispatch({ type: "failed", text: errText(e) }),
    );
  const closeFullAgent = (slot: string, agreed?: CloseAgreed) => {
    setClosingBusy(true);
    doing.closeWorker(slot, agreed).then(
      () => setClosingFull(null),
      (e) => {
        setClosingFull(null);
        dispatch({ type: "failed", text: errText(e) });
      },
    ).finally(() => setClosingBusy(false));
  };

  if (state.status === "locating") return <div className="center muted">Looking for the claude CLI…</div>;
  if (state.status === "setup" && !agentReady && providerList !== null) return <SetupScreen error={state.setupError} onCheck={(path) => { locate(path); api.listProviders().then(setProviderList, () => {}); }} />;

  return (
    <ProvidersContext.Provider value={providers}><ProjectSetupContext.Provider value={setupBy}><SlotContext.Provider value={active}><ModeGuideContext.Provider value={setGuideAt}><SessionActionsContext.Provider value={sessionActions}><KnownWindowsContext.Provider value={windows}><RoleStoreProvider store={roleStore}><TemplateTeamContext.Provider value={state.folder ? startTemplate : null}>
      <div className="app">
        <TopBar
          folder={titleFolder}
          status={state.status}
          changeCount={state.changedFiles.length}
          reviewCollapsed={deskShown ? askCollapsed : reviewCollapsed}
          onOpenFolder={openFolder}
          onToggleReview={deskShown ? () => setAskCollapsed(!askCollapsed) : state.folder ? () => setReviewCollapsed(!reviewCollapsed) : undefined}
          onOpenSettings={() => setSettingsAt("general")}
          storage={{ onOpen: () => setStorageOpen(true), suggested: suggestedCount(storage), open: storageOpen }}
          mcpIssues={(mcpIssues[active] ?? []).map((i) => `${i.name} ${i.problem}`)}
          onBringOld={bringHere}
          branch={branch}
          activity={showCanvas ? teamActivity(nodes, chats.slots) : activityStatus(state, finishedAt[active] ?? null)}
          issues={{ failed }}
          background={state.backgroundTasks}
          onStopTask={(id) => api.stopTask(active, id)}
          onClearFailures={() => setClearedFailures({ ...clearedFailures, [active]: failedKey })}
          onShowFailure={showFailure}
          orchestra={{ view: showCanvas ? "canvas" : "chat", exists: inOrchestra, attention: attention.length, onView: setView }}
          usage={{ rows: () => usageRows(chats, titles), onOpen: switchTo, switchToCodex: activeProvider === CLAUDE && isAvailable("codex") && state.status === "idle" && !isBusy(state) && !state.orchestrator && !chats.agents[active] && state.backgroundTasks.length === 0 ? () => chooseProvider("codex") : undefined }}
          back={goBack && { run: goBack, label: backToDesk ? "Back to the Desk" : "Back to the previous chat" }}
          inset={sidebarHidden ? 0 : sidebarCompact ? SIDEBAR_BAR : sidebarWidth}
          sidebar={sidebarHidden ? { needs: needsYou(openByProject), onShow: () => setSidebarHidden(false) } : undefined}
          inbox={{ items: inbox, onGo: goToInbox, onDecide: answerFromInbox, paused: guards.pause, onResume: guards.resume, onDismissPause: guards.dismiss }}
          run={topRun ? { command: topRun, running: state.run?.status === "running", onRun: () => doing.run(active) } : undefined}
          phones={phonesOn.length ? { names: phonesOn, onOpen: () => setSettingsAt("remote") } : undefined}
        />
        <Hud event={hud} onOpenChat={switchTo} />
        <div className="app-body">
        {sidebarHidden ? (
          <>
            {sidebarPeek.phase !== "in" && <div className="sidebar-edge" aria-hidden onPointerEnter={(e) => !e.buttons && sidebarPeek.hover()} onPointerLeave={sidebarPeek.unhover} />}
            {sidebarPeek.phase !== "off" && (
              <div className="sidebar-peek" data-phase={sidebarPeek.phase} onPointerLeave={sidebarPeek.close}>
                <Sidebar {...peekHandlers} {...sidebarProps} mode="peek" onToggle={keepSidebarOpen} />
              </div>
            )}
          </>
        ) : (
          <Sidebar {...sidebarHandlers} {...sidebarProps} mode={sidebarCompact ? "collapsed" : "pinned"} onToggle={() => setSidebarCompact(!sidebarCompact)} />
        )}
        <div className="app-main">
        {guards.pause && <PlanPaused pause={guards.pause} onResume={guards.resume} onDismiss={guards.dismiss} />}
        {state.banner && <BannerView banner={state.banner} onRestart={() => (relaunch.current[active] ? relaunch.current[active]() : restart(active, state.mode))} onDismiss={() => dispatch({ type: "dismiss_banner" })} />}
        <SplitPane
          ratio={deskShown ? askRatio : splitRatio}
          collapsed={deskShown ? askCollapsed : reviewCollapsed || !state.folder}
          scope={deskShown ? "desk" : showCanvas ? "canvas" : (state.folder ?? "")}
          onRatio={deskShown ? setAskRatio : setSplitRatio}
          left={
            deskShown ? (
              <ErrorBoundary name="desk">
                <DeskView
                  chats={deskRows}
                  projects={projectRows(
                    deskRows,
                    deskOpen,
                    deskFolders,
                    deskTodos,
                    deskNeeds.filter((it) => it.needsYou).reduce<Record<string, number>>((n, it) => {
                      const folder = projectFolderOf(it.slot);
                      return folder ? { ...n, [folder]: (n[folder] ?? 0) + 1 } : n;
                    }, {}),
                  )}
                  needs={deskNeeds}
                  repos={deskRepos}
                  page={pageOn}
                  onPage={setDeskPage}
                  onNewChat={sidebarHandlers.onNewChatIn}
                  desks={{
                    value: desks,
                    waiting: waitingBy(desks, openByProject),
                    projects: (() => {
                      const all = [...new Set([...Object.keys(openByProject), ...desks.list.flatMap((d) => d.projects)])];
                      const labels = projectLabels(all);
                      return all.map((folder, i) => ({ folder, label: labels[i] }));
                    })(),
                    onChange: setDesks,
                    onAdd: (name) => {
                      const next = addDesk(desks, name, `desk-${Date.now().toString(36)}`);
                      if (next) setDesks(next);
                    },
                  }}
                  onOpen={switchTo}
                  onGo={goToInbox}
                  onDecide={answerFromInbox}
                />
              </ErrorBoundary>
            ) : showCanvas ? (
              <ChatStoreContext.Provider value={chatStore}>
                <NodeActionsContext.Provider value={nodeActions}>
                  <ErrorBoundary name="canvas">
                    <Canvas nodes={nodes} layout={canvasLayout.current} activeSlot={active} attention={attention} onFocus={canvasFocus} onOpen={canvasOpen} />
                  </ErrorBoundary>
                </NodeActionsContext.Provider>
              </ChatStoreContext.Provider>
            ) : (
            <section className="chat-pane">
              {state.folder && state.notesApplied && <NotesApplied text={state.notesApplied} />}
              {!state.folder ? (
                // Until a folder is open: open one, or pick a recent project. No box, no side panel.
                openingLast ? (
                  <div className="center muted">Opening {basename(lastFolder!)}…</div>
                ) : (
                  <Welcome claudePath={state.claudePath ?? ""} loadRecent={loadRecentFolders} skip={[...hiddenFolders, ...relocateMenu.moved.map((m) => m.old)]} onOpenFolder={openFolder} onPick={(path) => startFresh(path)}>
                    {offeredTop.length > 0 && agentReady && !restoringAfterUpdate && <RestoreCard chats={offeredTop} folder={state.folder} onRestoreAll={restoreAll} onRestore={restoreOne} onDismiss={() => setOffer([])} />}
                  </Welcome>
                )
              ) : hero ? (
                <div className="hero-wrap">
                  <div className="hero-stack">
                    {offeredTop.length > 0 && agentReady && !restoringAfterUpdate && (
                      <RestoreCard chats={offeredTop} folder={state.folder} onRestoreAll={restoreAll} onRestore={restoreOne} onDismiss={() => setOffer([])} />
                    )}
                    {chatExtras}
                    {state.folder && <StartScreen picked={stepsMode ? state.flavourPick : null} explain={explain} onExplain={(on) => state.flavourPick && pickFlavour(state.flavourPick, on)} team={workflowOf(state) === "team"} onFlavour={pickFlavour} onReview={() => setPrPicker(true)} onTeam={() => (workflowOf(state) === "team" ? changeWorkflow("chat") : startTeam())} />}
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
                        <StepsView key={`steps-${active}`} state={state} {...streamHandlers} onNext={(message) => sendIn(active, message ?? "Next")} onSend={(text, switchTo) => sendIn(active, text, undefined, false, switchTo ? { flavour: switchTo, explain: false } : undefined)} flavour={flavour} explain={explain} onPickFlavour={pickFlavourNow} onPage={setPageRange} onShown={(page) => setShownPage({ slot: active, page })} onReviewFile={setReviewFile} jump={pageJump?.slot === active ? pageJump : null} handoff={handoff} />
                      ) : (
                        <ChatView key={`chat-${active}`} state={state} {...streamHandlers} resend={resendHandlers} restore={restoreEvents} loadEarlier={() => loadEarlier(active)} />
                      )}
                    </FileLinksProvider>
                    </ArchitecturePane.Provider>
                  </ErrorBoundary>
                  {chatExtras}
                  {composer}
                </>
              )}
            </section>
            )
          }
          right={
            <>
            {deskShown && (
              <ErrorBoundary name="desk ask">
                <DeskAsk
                  entries={deskLog.filter((e) => e.desk === desks.on)}
                  targets={deskTargets}
                  across={askFolders.length > 1}
                  about={pageOn ? deskProjects[0]?.label : undefined}
                  canSend={agentReady}
                  onSend={deskSend}
                  onSendTo={deskSendTo}
                  onStartIn={(entry, folder) => deskStartIn(entry, folder)}
                  onOpenPast={(hit) => {
                    setDesk(false);
                    openSession(hit.id, hit.folder);
                  }}
                  onOpen={switchTo}
                />
              </ErrorBoundary>
            )}
            {/* Kept while the Desk is up (unsaved edits in Files live in it), only not shown. */}
            <div className="review-slot" hidden={deskShown}>
            <ErrorBoundary name="review pane">
              <ReviewPanel
                chat={{ slot: active, session: state.sessionId }}
                architecture={archMap ? { map: archMap, current: shownCovers, pageNames: archPageNames, onOpenPage: openPageIn(active), openKey: archOpenKey, box: archBox, onUpdate: state.status === "idle" ? () => sendIn(active, UPDATE_MAP) : undefined } : undefined}
                summary={stepsSummary ? { slot: active, data: stepsSummary, changed: state.changedFiles, running: state.status === "running", onOpenPage: openPageIn(active), doc: { pages: stepPages ?? [], title: chatTitle(state, titles), folder: state.folder } } : undefined}
                folder={state.folder}
                ready={state.status !== "starting"}
                files={shownFiles}
                chatBusy={state.status === "running"}
                prChecks={state.folder ? { view: prChecks.views[state.folder], busy: isBusy(state), onSend: () => prChecks.sendFailure(state.folder!, active), onStop: () => prChecks.stop(state.folder!) } : undefined}
                onShip={state.folder ? () => setShipping(true) : undefined}
                changesKey={peek?.key ?? (changesAsked || undefined)}
                scope={scope}
                onScope={setChangeScope}
                worktree={shownWorktree ? { name: shownWorktree.name, branch: shownWorktree.branch, main: shownWorktree.main, onToggle: () => chooseWorktreeView(!shownWorktree.main) } : undefined}
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
                lastEdit={{ slot: active, path: state.lastEdited, count: state.claudeEdits }}
                todos={{ chats: todoChatList, onStart: agentReady && state.folder ? (todo) => startTodo(state.folder!, todo) : undefined, onOpenChat: switchTo, openKey: todosOpenKey || undefined }}
                onSaved={() => syncChanges(active)}
                // Sent now when Claude is free, queued behind the turn when it's working.
                onSummarizeRequest={
                  state.status === "idle" || state.status === "running"
                    ? (item) => (state.status === "running" ? dispatch({ type: "queue_set", items: [...state.queued, summarizeRequest(item)] }) : sendIn(active, summarizeRequest(item)))
                    : undefined
                }
                // An artifact's Refresh data: asks Claude, when it is free.
                onRefreshArtifact={state.status === "idle" ? (name) => sendIn(active, refreshArtifact(name)) : undefined}
                comments={
                  state.folder
                    ? {
                        items: diffComments[active] ?? [],
                        update: (change) =>
                          setDiffComments((all) => {
                            const was = all[active] ?? [];
                            const now = change(was);
                            return now === was ? all : { ...all, [active]: now };
                          }),
                        // One message for all of them: sent now when Claude is free, queued behind the turn when it's working.
                        send: state.status === "idle" || state.status === "running" ? (text) => (state.status === "running" ? dispatch({ type: "queue_set", items: [...state.queued, text] }) : sendIn(active, text)) : undefined,
                      }
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
            </div>
            </>
          }
        />
        </div>
        </div>
        <SettingsView
          open={settingsAt}
          provider={state.provider}
          onClose={() => setSettingsAt(null)}
          slot={state.folder ? active : null}
          live={state.status === "idle" || state.status === "running"}
          mcpTools={state.mcpTools}
          commands={state.commands}
          onCommands={(commands) => dispatch({ type: "ui_event", event: { kind: "commands", commands } })}
          onRestartChat={() => restart(active, state.mode)}
          prChecks={{ folders: prFolders, saved: prSettings, onChange: (folder, setting) => setPrSettings({ ...prSettings, [folder]: setting }) }}
          hooks={{
            folders: prFolders,
            table: chatHooks,
            onChange: (t) => {
              setHooksAll({ pre: t.pre, post: t.post });
              setHooksBy(t.projects);
            },
          }}
          endpoints={{ onSaved: () => void api.listProviders().then(setProviderList, () => {}) }}
          general={{ keepAwake, onKeepAwake: setKeepAwake, notify: notifyPrefs, onNotify: setNotifyPrefs, theme, onTheme: setTheme, customTheme, onCustomTheme: setCustomTheme, textSize, onTextSize: setTextSize, warnTeams, onWarnTeams: setWarnTeams, sortByActivity, onSortByActivity: setSortByActivity }}
          routines={{
            ...routines,
            loadProjects: () => api.recentFolders().then((recent) => sidebarProjects({ recent, hidden: hiddenFolders, open: openByProject, order: projectOrder }).map((p) => ({ folder: p.folder, label: p.label }))),
            keepAwake,
            onKeepAwake: setKeepAwake,
            onOpenChat: (sessionId, folder) => {
              setSettingsAt(null);
              openSession(sessionId, folder);
            },
          }}
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
        <StoragePanel open={storageOpen} onClose={() => setStorageOpen(false)} view={storage} onAsk={askStorage} busy={state.status === "running"} />
        {installing && <UpdatingOverlay state={updates.state} version={update?.version ?? null} />}
        {palette && <CommandPalette entries={palette} onClose={() => setPalette(null)} />}
        {prDialog && (
          <PrChecksDialog
            key={prDialog}
            label={basename(prDialog)}
            setting={prSettingFor(prSettings, prDialog)}
            onSave={(setting) => setPrSettings({ ...prSettings, [prDialog]: setting })}
            onClose={() => setPrDialog(null)}
          />
        )}
        {shipping && state.folder && (
          <ShipDialog folder={state.folder} title={chatTitle(state, titles)} files={state.changedFiles} running={state.status === "running"} onSend={(text) => sendIn(active, text)} onClose={() => setShipping(false)} />
        )}
        {shortcutsOpen && <ShortcutSheet available={availableActions().map((a) => a.id)} onClose={() => setShortcutsOpen(false)} />}
        {whatsNew && <WhatsNew version={whatsNew.version} notes={whatsNew.notes} onClose={() => setWhatsNew(null)} />}
        {editingNotes && (
          <ProjectNotesDialog
            project={basename(editingNotes)}
            notes={notesOf(notesBy, editingNotes)}
            onSave={(text) => setNotesBy(withNotes(notesBy, editingNotes, text))}
            onClose={() => setEditingNotes(null)}
          />
        )}
        {settingUp && <ProjectSetupDialog folder={settingUp} saved={setupBy[settingUp]} onSave={(setup: ProjectSetup) => setSetupBy({ ...setupBy, [settingUp]: setup })} onClose={() => setSettingUp(null)} />}
        {closingFull && (
          <div className="app-modal">
            <ConfirmDialog title="Close this agent?" confirmLabel="Discard work and close" busyLabel="Closing…" busy={closingBusy} onConfirm={() => closeFullAgent(closingFull.slot, { uncommitted: closingFull.check.uncommitted, unmerged_commits: closingFull.check.unmerged_commits })} onCancel={() => setClosingFull(null)}>
              <p>
                It has <strong>{lostText(closingFull.check)}</strong>.{" "}
                {closingFull.check.gone ? "Its worktree is already gone. Closing it stops it and deletes" : "Closing it stops it and deletes its worktree"}
                {closingFull.check.branch ? <>{closingFull.check.gone ? " its" : " and"} branch <code>{closingFull.check.branch}</code></> : null}, so that work is gone for good.
              </p>
            </ConfirmDialog>
          </div>
        )}
        {bringing && (
          <BringOldSessionsDialog
            destination={bringing.destination}
            from={bringing.from}
            pickFolder={() => open({ directory: true, multiple: false }).then((picked) => (typeof picked === "string" ? picked : null))}
            onClose={() => setBringing(null)}
            onRelocated={relocated}
            onOpenHistory={bringing.destination ? () => { const folder = bringing.destination!; setBringing(null); void openHistory(folder); } : undefined}
          />
        )}
        {history && (
          <HistoryPopover
            projects={history.projects}
            initial={history.folder}
            exclude={openChatIds}
            load={listPast}
            search={searchPast}
            loadOld={(folder) => api.oldLocations(folder)}
            actionsFor={actionsFor}
            onBring={(folder) => { setHistory(null); setBringing({ destination: folder, from: null }); }}
            onNewChat={(folder) => { setHistory(null); startFresh(folder); }}
            onOpen={(id, folder) => { setHistory(null); openSession(id, folder); }}
            onClose={() => setHistory(null)}
          />
        )}
        {prPicker && state.folder && <ReviewPrDialog folder={state.folder} onPick={startReviewOf} onClose={() => setPrPicker(false)} />}
        {templateDialog && state.folder && <TeamTemplateDialog folder={state.folder} onStart={startFromTemplate} onClose={() => setTemplateDialog(false)} />}
        {teamAsk && (
          <TeamWarning
            teams={teamAsk.teams}
            onStart={(dontAsk) => {
              if (dontAsk) setWarnTeams(false);
              setTeamAsk(null);
              teamAsk.go();
            }}
            onCancel={() => {
              setTeamAsk(null);
              teamAsk.cancel?.();
            }}
          />
        )}
        <ModeGuide
          open={guideAt}
          permissions={permissionsOf(state)}
          workflow={workflowOf(state)}
          auto={caps.supports_auto_mode}
          codex={state.provider?.id === "codex"}
          flavour={flavour}
          explain={explain}
          onUse={state.folder && !isBusy(state) ? (key) => {
            setGuideAt(null);
            if (key === "ask" || key === "auto") changePermissions(key);
            else if (key === "chat" || key === "steps" || key === "team") changeWorkflow(key);
            else if (key === "explain") pickFlavour(canExplain(flavour) ? flavour : "build", true);
            else pickFlavour(key);
          } : undefined}
          onClose={() => setGuideAt(null)}
        />
      </div>
    </TemplateTeamContext.Provider></RoleStoreProvider></KnownWindowsContext.Provider></SessionActionsContext.Provider></ModeGuideContext.Provider></SlotContext.Provider></ProjectSetupContext.Provider></ProvidersContext.Provider>
  );
}
