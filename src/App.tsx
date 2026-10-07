import { useEffect, useReducer, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type BranchReview, type ChangeScope } from "./api";
import { prNumberOf, reviewHints } from "./lib/review";
import { openFind } from "./lib/editorFind";
import { StepsIntro } from "./components/StepsIntro";
import { windowFocused } from "./lib/windowFocus";
import { initialState, type Action, type ChangedFile, type ChatItem, type Status } from "./store";
import { chatsReducer, chatState, chatTitle, firstPrompt, initialChats, isBusy, queuesToSend } from "./sessions";
import type { Mode } from "./types";
import { attentionFor } from "./lib/attention";
import { basename } from "./lib/diff";
import { withShellContext } from "./lib/shell";
import { stepFile, usePersistentState } from "./lib/layout";
import { notify } from "./lib/notify";
import { useShortcut } from "./lib/shortcuts";
import { activityStatus } from "./lib/status";
import { failedCount } from "./lib/activity";
import { scrollWithin } from "./lib/scrollWithin";

import { SlotContext } from "./lib/slot";
import { ModeGuideContext } from "./lib/modeGuide";
import { ModeGuide, type GuideKey } from "./components/ModeGuide";
import { BannerView } from "./components/BannerView";
import { ChatView } from "./components/ChatView";
import { StepsView } from "./components/StepsView";
import { andNext } from "./lib/steps";
import { flavourOf, savedMode, withFlavourNote, type Flavour } from "./lib/flavour";
import { FileLinksProvider } from "./lib/fileLinks";
import { Hud, type HudEvent } from "./components/Hud";
import type { OpenChat } from "./components/HistoryMenu";
import { MessageInput } from "./components/MessageInput";
import { describeInput } from "./components/PermissionCard";
import { ReviewPanel } from "./components/ReviewPanel";
import { SetupScreen } from "./components/SetupScreen";
import { RestoreCard } from "./components/RestoreCard";
import { chatsToSave, loadSaved, save, screenFirst, withOffered, type SavedChat } from "./lib/restore";
import { SplitPane } from "./components/SplitPane";
import { TopBar } from "./components/TopBar";
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
};

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

// J/K should navigate files unless the user is typing. Monaco's read-only diff uses a textarea too, so allow that one.
const isTyping = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) && !el.closest(".monaco-editor");

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
  const autoFor = (folder: string | null) => (folder ? (autoBy[folder] ?? false) : false);
  const [lastFolder, setLastFolder] = usePersistentState<string | null>("settings.lastFolder", null);
  const [model, setModel] = usePersistentState<string | null>("settings.model", null);
  // Thinking effort (--effort); null = Claude Code's default. App-wide, like the model.
  const [effort, setEffort] = usePersistentState<string | null>("settings.effort", null);
  const [defaultModel, setDefaultModel] = usePersistentState<string | null>("settings.defaultModel", null);
  const [modelIds, setModelIds] = usePersistentState<Record<string, string>>("settings.modelIds", {});
  // Each model's context window as last reported, so the meter can show a percentage before a turn reports one.
  const [windows, setWindows] = usePersistentState<Record<string, number>>("settings.contextWindows", {});
  // Every open chat. The one on screen is `active`; the others keep running in the background.
  const [chats, dispatchChats] = useReducer(chatsReducer, undefined, () => initialChats({ ...initialState, mode: lastFolder ? modeFor(lastFolder) : "ask" }));
  const active = chats.active;
  const state = chats.slots[active];
  const reopened = useRef(false);
  const slotSeq = useRef(1);
  // Each chat's unsent text, so switching away and back doesn't lose it. A ref: typing needn't re-render the app.
  const drafts = useRef<Record<string, string>>({});
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
  useShortcut("p", () => openSearch("files"), !!state.folder);
  useShortcut("f", () => openSearch("text"), !!state.folder, true);
  // ⌘F: find in the file the right pane shows (Monaco's find bar), from anywhere in the window.
  useShortcut("f", () => void openFind(), !reviewCollapsed);
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

  // Actions for one chat. Async results always go to the chat that asked, even if another is on screen by then.
  const to = (slot: string) => (action: Action) => dispatchChats({ type: "in", slot, action });
  const dispatch = to(active);

  const locate = (pathOverride: string | null) =>
    api.locateClaude(pathOverride).then(
      (path) => dispatch({ type: "claude_found", path }),
      (e) => dispatch({ type: "claude_missing", error: errText(e) }),
    );

  useEffect(() => {
    const unlisten = api.onUiEvent((slot, event) => dispatchChats({ type: "in", slot, action: { type: "ui_event", event } }));
    locate(null);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // The update may have been found before this window was listening, so ask as well as listen.
  useEffect(() => {
    const unlisten = api.onUpdateReady(setUpdate);
    api.updateStatus().then((u) => u && setUpdate(u), () => {});
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const restart = (slot: string, mode: Mode, withEffort: string | null = effort) => {
    to(slot)({ type: "restarting" });
    api.restartSession(slot, mode, withEffort, autoFor(chats.slots[slot]?.folder ?? null)).then(() => to(slot)({ type: "session_ready" })).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };

  // If Stop made claude exit instead of just ending the turn, resume the session.
  useEffect(() => {
    for (const [slot, s] of Object.entries(chats.slots)) if (s.status === "ended" && s.stopRequested) restart(slot, s.mode);
  }, [chats.slots]);

  /**
   * Leaving a chat keeps it open (running or not) so switching back is instant; only an empty chat with nothing typed
   * is closed. Open chats are closed from the history menu.
   */
  const leave = (slot: string) => {
    const s = chats.slots[slot];
    if (!s || s.items.length > 0 || isBusy(s) || drafts.current[slot]?.trim()) return;
    closeChat(slot);
  };

  const closeChat = (slot: string) => {
    if (slot === active || !chats.slots[slot]) return;
    dispatchChats({ type: "remove", slot });
    delete drafts.current[slot];
    api.closeSession(slot).catch(() => {});
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
   * chat is left: kept in the background if busy, closed if not).
   */
  const takeSlot = (): string => {
    if (state.items.length === 0 && !isBusy(state)) return active;
    const slot = `s${++slotSeq.current}`;
    dispatchChats({ type: "add", slot });
    dispatchChats({ type: "activate", slot });
    leave(active);
    return slot;
  };

  // `quiet`: reopening the remembered project at launch; if that fails (e.g. the folder is gone), just forget it.
  const startFresh = (folder: string, quiet = false) => {
    if (state.claudePath) startIn(takeSlot(), folder, quiet);
  };

  const startIn = (slot: string, folder: string, quiet = false) => {
    const { claudePath } = state;
    if (!claudePath) return;
    const mode = modeFor(folder);
    to(slot)({ type: "folder_opened", folder });
    to(slot)({ type: "mode_changed", mode });
    api.startSession(slot, claudePath, folder, { mode, model, effort, auto_approve: autoFor(folder) }).then(
      () => {
        setLastFolder(folder);
        to(slot)({ type: "session_ready" });
      },
      (e) => {
        if (!quiet) return to(slot)({ type: "failed", text: errText(e) });
        setLastFolder(null);
        to(slot)({ type: "folder_cleared" });
      },
    );
  };

  useEffect(() => {
    if (state.folder && modes[state.folder] !== state.mode) setModes({ ...modes, [state.folder]: state.mode });
  }, [state.mode, state.folder]);
  useEffect(() => {
    if (state.sessionId && sessionModes[state.sessionId] !== state.mode) setSessionModes({ ...sessionModes, [state.sessionId]: state.mode });
  }, [state.mode, state.sessionId]);

  // With no model chosen, whatever claude runs is Claude Code's default: remember it so the menu can name it.
  // And for an alias, the version it currently resolves to.
  useEffect(() => {
    if (model === null && state.model) setDefaultModel(state.model);
    else if (model && state.model?.includes(model) && modelIds[model] !== state.model) setModelIds({ ...modelIds, [model]: state.model });
  }, [model, state.model]);

  // Reopen the last project once claude has been found.
  useEffect(() => {
    if (reopened.current || state.status !== "no_folder" || !state.claudePath) return;
    reopened.current = true;
    if (lastFolder) startFresh(lastFolder, true);
  }, [state.status, state.claudePath]);

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
    resumeIn(takeSlot(), folder, sessionId, reuse);
  };

  const resumeIn = (slot: string, folder: string, sessionId: string, reuse = false) => {
    const { claudePath } = state;
    if (!claudePath) return;
    // The mode it was last in (and for an older Debug, Teach or Review session, that flavour of Step by step); one from
    // before modes were kept per session reopens as a plain chat, not as whatever this folder's newest chat is doing.
    const { mode, flavour: flavourStart } = savedMode(sessionModes[sessionId]);
    to(slot)(reuse ? { type: "restarting" } : { type: "folder_opened", folder });
    to(slot)({ type: "mode_changed", mode, flavourStart });
    api
      .openSession(slot, claudePath, folder, { mode, model, effort, auto_approve: autoFor(folder) }, sessionId)
      .then((events) => {
        to(slot)({ type: "history_loaded", sessionId, events });
        to(slot)({ type: "session_ready" });
      })
      .catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };

  // The chats that were open when Lantern last closed, offered back at launch until restored, dismissed, or a message
  // is sent in a new chat instead.
  const [offer, setOffer] = useState<SavedChat[]>(loadSaved);
  // Bumped to remount the chat box when a restore puts unsent text back into the chat on screen.
  const [composerEpoch, setComposerEpoch] = useState(0);

  // A chat from last time, into `slot`: its conversation continued, or (typed but never sent) a new one in its folder;
  // either way with its unsent text back in the box.
  const restoreInto = (slot: string, c: SavedChat) => {
    if (c.draft) drafts.current[slot] = c.draft;
    if (c.sessionId) resumeIn(slot, c.folder, c.sessionId);
    else startIn(slot, c.folder);
  };
  const openAlready = (c: SavedChat) => (c.sessionId ? Object.entries(chats.slots).find(([, s]) => s.sessionId === c.sessionId)?.[0] : undefined);

  // One chat, on screen (in the empty chat on screen if there is one).
  const restoreOne = (c: SavedChat) => {
    setOffer((o) => o.filter((x) => x !== c));
    const already = openAlready(c);
    if (already) return switchTo(already);
    if (!state.claudePath) return;
    restoreInto(takeSlot(), c);
    setComposerEpoch((e) => e + 1);
    setLastFolder(c.folder);
  };

  // Every chat: the one that was on screen comes back on screen, the others open behind it.
  const restoreAll = () => {
    const [first, ...rest] = screenFirst(offer);
    if (!first || !state.claudePath) return;
    restoreOne(first);
    setOffer([]);
    for (const c of rest) {
      if (openAlready(c)) continue;
      const slot = `s${++slotSeq.current}`;
      dispatchChats({ type: "add", slot });
      restoreInto(slot, c);
    }
  };

  const syncChanges = (slot: string) =>
    api.changeSummary(slot).then((files) => to(slot)({ type: "changes_synced", files }), () => {});

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

  // A flavour picked since the chat's last message goes with this one, in a note telling Claude.
  const sendIn = (slot: string, text: string) => {
    const pick = chats.slots[slot]?.flavourPick ?? null;
    to(slot)({ type: "user_sent", text, ...(pick ? { switchedTo: pick } : {}) });
    // Commands run since the last message go first, so Claude sees what they printed.
    const items = chats.slots[slot]?.items ?? [];
    api.sendMessage(slot, withShellContext(items, pick ? withFlavourNote(pick, text) : text)).then(
      (turn) => typeof turn === "number" && to(slot)({ type: "turn_numbered", turn }),
      (e) => to(slot)({ type: "failed", text: errText(e) }),
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
  }, [chats.slots]);

  const changeMode = (mode: Mode) => {
    if (mode !== "steps") dispatch({ type: "flavour_picked", flavour: null });
    dispatch({ type: "mode_changed", mode });
    if (state.folder) restart(active, mode);
  };

  // Step by step's flavour as you see it: one you picked and haven't sent yet, or the conversation's.
  const chatFlavour = (s: typeof state) => (s.mode === "steps" ? (s.flavourPick ?? flavourOf(s.items, s.flavourStart)) : null);
  const flavour = chatFlavour(state);
  // Picking the flavour the chat is already in takes back a pick; one from outside Step by step switches to it.
  const pickFlavour = (next: Flavour | null) => {
    const inChat = state.mode === "steps" ? flavourOf(state.items, state.flavourStart) : null;
    dispatch({ type: "flavour_picked", flavour: next === inChat ? null : next });
    if (state.mode !== "steps") {
      dispatch({ type: "mode_changed", mode: "steps" });
      if (state.folder) restart(active, "steps");
    }
  };

  // Effort is a launch flag, so the chat's claude restarts on the same session to pick it up (like the mode).
  const changeEffort = (next: string | null) => {
    setEffort(next);
    if (state.folder) restart(active, state.mode, next);
  };

  // App-wide: applies in-band from each open chat's next message, and to new chats and restarts.
  const chooseModel = (next: string | null) => {
    setModel(next);
    for (const slot of Object.keys(chats.slots)) api.setModel(slot, next).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };

  const stop = () => {
    dispatch({ type: "stop_requested" });
    api.interrupt(active).catch(() => {});
  };

  // `note`: what the user wrote on a reproduce card; it goes back to Claude with the answer.
  const decide = (id: string, allow: boolean, note?: string) => {
    const slot = active;
    to(slot)({ type: "permission_decided", id, allow, note });
    api.respondPermission(slot, id, allow, note ?? null).catch((e) => to(slot)({ type: "failed", text: errText(e) }));
  };

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
  // Reviewing with no PR named (a local branch): "Branch", its commits since it left the default branch.
  const reviewing = flavour === "review" && state.items.length > 0;
  const reviewPr = reviewing ? prNumberOf(state.items) : null;
  const reviewBranch = reviewing && reviewPr === null;
  const hints = reviewing ? reviewHints(state.items, state.folder) : [];
  const hintKey = hints.join("\n");
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
    const key = `${active}:${hintKey}`;
    Promise.all([api.branchReview(active, hints), api.changeSummary(active, "branch", null, null, null, hints)]).then(
      ([review, files]) => live && setBranchFiles({ key, review, files, error: null }),
      (e) => live && setBranchFiles({ key, review: null, files: [], error: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [scope, active, state.folder, hintKey, state.seq]);
  const shownBranch = branchFiles?.key.startsWith(`${active}:`) ? branchFiles : null;
  const [prFiles, setPrFiles] = useState<{ pr: number; files: ChangedFile[]; error: string | null } | null>(null);
  useEffect(() => {
    if (scope !== "pr" || reviewPr === null || !state.folder) return;
    let live = true;
    if (prFiles?.pr !== reviewPr) setPrFiles(null);
    api.changeSummary(active, "pr", null, null, reviewPr, hints).then(
      (files) => live && setPrFiles({ pr: reviewPr, files, error: null }),
      (e) => live && setPrFiles({ pr: reviewPr, files: [], error: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [scope, active, state.folder, reviewPr]);
  const shownPr = prFiles?.pr === reviewPr ? prFiles : null;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "\\") {
        e.preventDefault();
        setReviewCollapsed(!reviewCollapsed);
        return;
      }
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
  const saveOpen = () => save(withOffered(chatsToSave(chats.slots, active, drafts.current, titles), offer));
  useEffect(saveOpen, [chats.slots, active, titles, offer]);

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
      if (!windowFocused() || slot !== chats.active) notify(a.title, a.body);
      // Another chat finished or needs an answer: say so in the window too, and let the toast take you there.
      if (slot !== chats.active) {
        if (a.kind === "finished" || a.kind === "failed") setUnread((u) => ({ ...u, [slot]: true }));
        const project = s.folder && s.folder !== state.folder ? basename(s.folder) : null;
        setHud({ key: Date.now(), kind: a.kind, body: a.body, chat: { slot, title: chatTitle(s, titles), project } });
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
    .map(([slot, s]) => ({ slot, title: chatTitle(s, titles), state: chatState(s, drafts.current[slot]), unread: !!unread[slot], background: s.backgroundTasks.length, sessionId: s.sessionId, elsewhere: s.folder && s.folder !== state.folder ? basename(s.folder) : null }));

  // For the title bar: steps that failed in the latest turn, and other chats waiting for an answer.
  const lastPrompt = state.items.map((it) => it.type).lastIndexOf("user");
  const turnTools = state.items.slice(lastPrompt + 1).flatMap((it) => (it.type === "tool" ? [it] : []));
  // Cleared from the title bar: hidden until a different set of steps has failed.
  const failedKey = turnTools.filter((t) => t.status === "error").map((t) => t.id).join(",");
  const failed = clearedFailures[active] === failedKey ? 0 : failedCount(turnTools);
  const waiting = openChats.filter((c) => c.state === "waiting").length;

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
  const hero = state.items.length === 0 && !state.thinking;
  // "How the modes work", open on a mode's page.
  const [guideAt, setGuideAt] = useState<GuideKey | null>(null);
  const composer = (
    <MessageInput
      key={`input-${active}-${composerEpoch}`}
      status={state.status}
      onSend={(text) => {
        // Starting something new instead: the chats from last time aren't offered any more.
        if (hero) setOffer([]);
        sendIn(active, text);
      }}
      onStop={stop}
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
      folders={{ load: api.recentFolders, onPick: (path) => startFresh(path) }}
      models={{ chosen: model, onChoose: chooseModel, defaultModel, ids: modelIds, options: state.models }}
      effort={{ chosen: effort, onChoose: changeEffort }}
      usage={{ used: state.contextUsed, window: contextWindow, lastTurnMs }}
      queue={{ items: state.queued, set: (items) => dispatch({ type: "queue_set", items }) }}
      commands={state.commands}
      draft={{
        initial: drafts.current[active] ?? "",
        save: (text) => {
          drafts.current[active] = text;
          saveOpen();
        },
      }}
      update={
        update && !updateLater
          ? {
              version: update.version,
              busy: Object.values(chats.slots).filter(isBusy).length,
              onRestart: () => api.restartToUpdate().catch((e) => dispatch({ type: "failed", text: errText(e) })),
              onLater: () => setUpdateLater(true),
            }
          : undefined
      }
    />
  );

  if (state.status === "locating") return <div className="center muted">Looking for the claude CLI…</div>;
  if (state.status === "setup") return <SetupScreen error={state.setupError} onCheck={locate} />;

  return (
    <SlotContext.Provider value={active}><ModeGuideContext.Provider value={setGuideAt}>
      <div className="app">
        <TopBar
          folder={state.folder}
          status={state.status}
          changeCount={state.changedFiles.length}
          reviewCollapsed={reviewCollapsed}
          onOpenFolder={openFolder}
          onToggleReview={() => setReviewCollapsed(!reviewCollapsed)}
          sessionId={state.sessionId}
          loadSessions={loadSessions}
          onOpenSession={openSession}
          onNewSession={() => state.folder && startFresh(state.folder)}
          loadRecent={api.recentFolders}
          onPickFolder={(path) => startFresh(path)}
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
        />
        <Hud event={hud} onOpenChat={switchTo} />
        {state.banner && <BannerView banner={state.banner} onRestart={() => restart(active, state.mode)} onDismiss={() => dispatch({ type: "dismiss_banner" })} />}
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
                  <FileLinksProvider slot={active} folder={state.folder} epoch={state.seq} onOpen={openMention}>
                    {stepsView ? (
                      <StepsView key={`steps-${active}`} state={state} {...streamHandlers} onNext={(message) => sendIn(active, message ?? "Next")} onSend={(text) => sendIn(active, text)} flavour={flavour} onPickFlavour={pickFlavour} autoApprove={autoFor(state.folder)}
                        onAutoApprove={(on) => {
                          if (!state.folder) return;
                          setAutoBy({ ...autoBy, [state.folder]: on });
                          to(active)({ type: "restarting" });
                          api.restartSession(active, state.mode, effort, on).then(() => to(active)({ type: "session_ready" })).catch((e) => to(active)({ type: "failed", text: errText(e) }));
                        }} onPage={setPageRange} onReviewFile={setReviewFile} />
                    ) : (
                      <ChatView key={`chat-${active}`} state={state} {...streamHandlers} />
                    )}
                  </FileLinksProvider>
                  {composer}
                </>
              )}
            </section>
          }
          right={
            <ReviewPanel
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
              onSelect={selectFile}
              onFollow={() => dispatch({ type: "follow_latest" })}
            />
          }
        />
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
    </ModeGuideContext.Provider></SlotContext.Provider>
  );
}
