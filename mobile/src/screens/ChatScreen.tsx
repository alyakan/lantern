import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Pressable, StyleSheet, View, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { markSeen } from "../seen";
import { useConnectionState, useController, useDeviceId, useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { Button, ProjectTag, Txt } from "../ui/components";
import { barRoom, KEYBOARD_GAP } from "../ui/keyboard";
import { buzz, FadeSlideIn, PopIn, PressScale } from "../ui/motion";
import { ChatSkeleton, Dots } from "../ui/skeleton";
import { Glass, useGlass } from "../ui/Glass";
import { PageSheet } from "../ui/PageSheet";
import { control, radius, space, useColors } from "../ui/theme";
import { platformSpeech } from "../platformSpeech";
import { currentMatch, findRows, quickReplies, quote, stepMatch } from "../view/chatText";
import { projectColorOf } from "../view/home";
import { hasHiddenChars, tellClaude } from "../view/shell";
import { queuedIds } from "../view/queue";
import { timeline, type Row } from "../view/timeline";
import { pageOfKey, stepPagesOf } from "../view/stepPages";
import { StepNav, StepPager, type PagePlaces } from "./StepPager";
import { keepOffset, keepPage, placeOf } from "../view/stepPlace";
import { changedFiles } from "../view/changes";
import { ChangesPane } from "./ChangesPane";
import { ArtifactsPane } from "./ArtifactsPane";
import { ChangesIcon, PanelMenu, type Panel } from "./PanelMenu";
import { keepPanel, panelOf } from "../view/panelChoice";
import { ReviewFilePage } from "./ReviewPage";
import { parseReviewFile, verdictMessage, verdictsFromNext, type ReviewFile, type Verdict } from "../view/review";
import type { PageAction } from "../view/pages";
import { useKeepPlace } from "./useKeepPlace";
import { distanceFromEnd, JumpToBottom, MessageActionsSheet, PlanCard, QuickReplies, StepOutputSheet, type ComposeSeed } from "./ChatExtras";
import { SearchBar, type BarSearch, type BarTool } from "./SearchBar";
import { TodosPane } from "./TodosPane";
import { useMacCan } from "../shell/useControls";
import { useAppLock } from "../shell/lockContext";
import { ChatSettings } from "./ChatSettings";
import { AssistantRow, Composer, DayRow, DesktopRow, DiffSheet, HookRow, PageActionsFloat, PageRow, PromptRow, StepsRow, SummaryRow, TurnRow, UserRow } from "./ChatParts";
import { activityOf, elapsed } from "../view/activity";
import { RunCommandCard } from "./RunCommand";
import { ShellCard } from "./ShellCard";

/** What no search, or a search that finds nothing, marks: the same each time, so the list has nothing to draw again for it. */
const NO_MATCHES: ReturnType<typeof findRows> = [];
const NO_MARKS = { here: null as string | null, all: new Set<string>() };

export interface ChatProps {
  slot: string;
  onBack: () => void;
  /** Opens the full-screen decision for one of this chat's prompts. */
  onReview: (requestId: string) => void;
  /** What leads the header: a back button (the phone), the chats' button (a tablet with them away: they slide in), or nothing (the chats are beside the chat, with their own button). */
  lead?: "back" | "sidebar" | "none";
  onSidebar?: () => void;
  /** The chats' button is there to take its place but out of sight, while the chats are slid in over the chat with a button of their own. */
  leadHidden?: boolean;
  /** The Changes button opens what the chat changed in a sheet; with this it shows or hides them in a pane beside the chat instead (`shown` says which). */
  changesPane?: { shown: boolean; onToggle: () => void; /** A file link tapped: the pane shows it if it can (one of the files changed), and says whether it did; else it opens in a sheet. */ onFile?: (path: string) => boolean };
  /** The chat bar's To-dos, on a tablet with room beside the chat: the pane shows the to-dos, in place of this chat's own sheet. */
  onTodos?: () => void;
  /** The Done page's "Start something new": opens the new-chat sheet on this chat's project (its folder's name; null when it has none). */
  onStartNew?: (project: string | null) => void;
  /** The chat's width is being dragged (the Changes pane's divider): the reader's place is put back once, when it ends. */
  resizing?: boolean;
}

/** The header's buttons take a touch a little way around them, but not above: that is the status bar, whose tap scrolls a list to its top. */
const HEADER_SLOP = { top: 0, left: 8, right: 8, bottom: 8 };

/** How long "Caught up on 14 events" stays up. */
const BANNER_MS = 4000;
/** How much has to have happened while away for "Caught up on…" to be said: a few events is just the chat going on. */
export const BANNER_AT = 10;

/** The line under a working chat: what Claude is doing right now, and for how long it has been at it. */
function WorkingFooter({ activity, since }: { activity: string; since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 6 }}>
      <Dots />
      {/* What it is doing is said when it changes; the seconds are not read out each time they tick. */}
      <Txt variant="small" tone="ink3" numberOfLines={1} accessibilityLiveRegion="polite" style={{ flexShrink: 1 }}>
        {activity}
      </Txt>
      {since !== null && (
        <Txt variant="small" tone="ink3" accessibilityElementsHidden importantForAccessibility="no">
          · {elapsed(now - since)}
        </Txt>
      )}
    </View>
  );
}
/** How long "Waking…" waits for the chat to be awake before the button comes back. */
export const WAKE_WAIT_MS = 20_000;

/** A chat, as a timeline with a message box under it. */
/** How much of the page's colour is left at each step down the header's fade, from its top to its bottom edge. */
const HEADER_FADE = [0.96, 0.92, 0.85, 0.75, 0.6, 0.42, 0.25, 0.1, 0];

export function ChatScreen({ slot, onBack, onReview, lead = "back", onSidebar, leadHidden = false, changesPane, onTodos, onStartNew, resizing = false }: ChatProps) {
  const colors = useColors();
  const controller = useController();
  const { sync } = controller;
  const { chats, views, plan, workingSince } = useSyncState();
  const canOutput = useMacCan("output");
  // A Mac that can read a reviewed file's diff from the PR or branch under review; an older one only has the chat's own edits.
  const canReviewDiff = useMacCan("reviewdiff");
  const canShell = useMacCan("shell");
  const canImages = useMacCan("images");
  const canTodos = useMacCan("todos");
  const canRename = useMacCan("rename");
  const lock = useAppLock();
  const [output, setOutput] = useState<{ id: string; text: string } | null>(null);
  // A command typed in the terminal, shown back to be run by a swipe: `resolve` says whether it was run.
  const [confirming, setConfirming] = useState<{ command: string; resolve: (ran: boolean) => void } | null>(null);
  // Whether the swipe happened: one swipe is one command, however often the card is touched after it.
  const swiped = useRef(false);
  const connection = useConnectionState();
  const me = useDeviceId();
  const insets = useSafeAreaInsets();
  // Whether the chats' button came after the chat opened (the chats were unpinned), rather than being there from the start.
  const firstLead = useRef(lead);
  const sidebarLeadLate = lead === "sidebar" && firstLead.current !== "sidebar";
  // On iOS 26 the list runs under the header and the message box: how much room they take.
  const glass = useGlass();
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(0);
  const chat = chats.find((c) => c.slot === slot);
  const view = views[slot] ?? emptyView;
  const working = chat?.status === "working";
  const rows = useMemo(() => timeline(view.items, Date.now(), working), [view.items, working]);
  // Messages sent while Claude was busy say they are waiting for it.
  const queued = useMemo(() => queuedIds(view.items, working), [view.items, working]);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<string[] | null>(null);
  // A Review page's file whose change is open, and the verdicts picked on each page not yet sent (by the page's message id).
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Record<number, Verdict>>>({});
  // Every file the chat changed, each with its diff: the tablet's Changes pane, as a sheet.
  const changed = useMemo(() => changedFiles(view.items), [view.items]);
  const [changesOpen, setChangesOpen] = useState(false);
  // What the sheet shows: the chat's changes, (a Mac that lists "artifacts") the artifacts of its folder, or (one that lists
  // "todos") its project's to-do list.
  const canArtifacts = useMacCan("artifacts");
  // Each chat's own: the one picked in it the last time, which the Changes button opens on.
  const [panel, setShownPanel] = useState<Panel>(() => panelOf(slot));
  const setPanel = (p: Panel) => {
    keepPanel(slot, p);
    setShownPanel(p);
  };
  // The Done page's Changes opens the sheet on the changes, whatever it showed last.
  const openChanges = () => {
    setPanel("changes");
    setChangesOpen(true);
  };
  const [banner, setBanner] = useState(false);
  const [waking, setWaking] = useState(false);
  // While a swipe to allow is being dragged the chat holds still: it can't scroll out from under the finger.
  const [swiping, setSwiping] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Holding a message down (what can be done with it), searching the chat, being scrolled away from its end, and words put in
  // the message box (a quote, an edit).
  const [actions, setActions] = useState<{ text: string; own: boolean; last: boolean; at?: number | null } | null>(null);
  // Searching: what is typed, and which match it is on (a message's key; none means the newest, where looking starts). Null when not searching.
  const [find, setFind] = useState<{ query: string; cursor: string | null } | null>(null);
  // Step by step reads a page at a time, side by side, as on the Mac (or as one list, if asked). The page on screen: none
  // means the newest, followed as pages come; `of` is how many there were when another was picked, so a new one is said.
  const stepsChat = chat?.workflow === "steps";
  const [asList, setAsList] = useState(false);
  const pages = useMemo(() => (stepsChat ? stepPagesOf(rows) : []), [stepsChat, rows]);
  // The newest page's heading: its buttons, and a Review page's verdicts, can still be given (until one is pressed).
  const newest = pages.length ? [...pages[pages.length - 1].rows].reverse().find((r): r is Extract<Row, { kind: "page" }> => r.kind === "page") : undefined;
  const paged = stepsChat && !asList && pages.length > 0;
  const [picked, setPicked] = useState<{ index: number; of: number } | null>(null);
  // Opened again, it is on the page it was left on (and says so if new ones came meanwhile), as soon as its pages are loaded:
  // before the pages are first drawn, so they don't slide there from the newest.
  const placed = useRef(false);
  if (!placed.current && pages.length > 0) {
    placed.current = true;
    const left = placeOf(slot);
    const i = left ? pages.findIndex((p) => p.key === left.page) : -1;
    const of = left?.of || pages.length;
    if (i >= 0 && (i < pages.length - 1 || pages.length > of)) setPicked({ index: i, of });
  }
  const pageAt = picked ? Math.min(picked.index, pages.length - 1) : pages.length - 1;
  const freshPage = !!picked && pages.length > picked.of;
  const toPage = (i: number) => setPicked(i >= pages.length - 1 ? null : { index: i, of: pages.length });
  const pageKey = pages[pageAt]?.key;
  const pageOf = picked ? picked.of : pages.length;
  useEffect(() => {
    if (paged && pageKey) keepPage(slot, pageKey, pageOf);
  }, [paged, slot, pageKey, pageOf]);
  const places = useMemo<PagePlaces>(() => ({ offset: (page) => placeOf(slot)?.offsets[page], keep: (page, y) => keepOffset(slot, page, y) }), [slot]);
  // How tall the newest page's floating buttons are: the page makes that much more room under its last line.
  const [floatHeight, setFloatHeight] = useState(0);
  // Opening the search (nothing typed yet) changes none of these, so the list isn't drawn again then, while the keyboard comes.
  const query = find?.query ?? null;
  const matches = useMemo(() => (query === null ? NO_MATCHES : findRows(rows, query)), [rows, query]);
  const here = find ? currentMatch(matches, find.cursor) : null;
  const markedHere = here?.key ?? null;
  const marks = useMemo(() => (matches.length === 0 && markedHere === null ? NO_MARKS : { here: markedHere, all: new Set(matches.map((m) => m.key)) }), [matches, markedHere]);
  // The chat goes to each match as it is chosen (and to the newest as the search finds it).
  const hereRef = useRef(here);
  hereRef.current = here;
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const hereKey = here?.key;
  useEffect(() => {
    const m = hereRef.current;
    if (!m) return;
    // On pages, a match is found by going to its page.
    if (pagedRef.current) {
      const i = pageOfKey(pagesRef.current, m.key);
      if (i >= 0) setPicked(i >= pagesRef.current.length - 1 ? null : { index: i, of: pagesRef.current.length });
    } else list.current?.scrollToIndex({ index: m.index, animated: true, viewPosition: 0.3 });
  }, [hereKey]);
  const step = (dir: 1 | -1) => {
    if (!find) return;
    const m = stepMatch(matches, find.cursor, dir);
    if (m) setFind({ ...find, cursor: m.key });
  };
  // What the chat bar needs to search: the circle beside it, and the field it turns into.
  const barSearch: BarSearch = {
    active: !!find,
    query: find?.query ?? "",
    count: matches.length,
    position: here ? matches.indexOf(here) + 1 : 0,
    onOpen: () => setFind({ query: "", cursor: null }),
    onChange: (query) => setFind({ query, cursor: null }),
    onStep: step,
    onCancel: () => setFind(null),
  };
  // A message being read aloud: reading stops when the chat is left.
  const [reading, setReading] = useState(false);
  useEffect(() => () => platformSpeech.stop(), []);
  const [away, setAway] = useState<{ since: number } | null>(null);
  const [seed, setSeed] = useState<ComposeSeed | undefined>(undefined);
  const [repliedTo, setRepliedTo] = useState<string | null>(null);
  const list = useRef<FlashListRef<Row>>(null);
  // The reader's place survives the chat getting narrower or wider (the chats pinned beside it, put away, or the tablet turned).
  const keep = useKeepPlace(list);
  const { hold } = keep;
  useEffect(() => hold(resizing), [hold, resizing]);

  // Whatever the chat did while it is open is seen: it isn't unread on Home. Once more when it closes, for what came as it went.
  const activeAt = chat?.active_at;
  const latest = useRef<number | undefined>(activeAt);
  latest.current = activeAt;
  useEffect(() => {
    if (activeAt !== undefined) markSeen(slot, activeAt);
  }, [slot, activeAt]);
  useEffect(
    () => () => {
      if (latest.current !== undefined) markSeen(slot, latest.current);
    },
    [slot],
  );

  // The chat's events come for as long as this screen is open.
  useEffect(() => {
    sync.follow(slot);
    return () => sync.unfollow(slot);
  }, [sync, slot]);

  // Looking at a chat that has stopped clears its card on the lock screen (opening it, and coming back to the app while it is
  // open). While the chat is still working, or waiting on you, the card stays: you may open the chat and lock the phone again,
  // and it clears once the chat has stopped, if you are looking at it then.
  const busy = chat?.status === "working" || chat?.status === "needs_you";
  useEffect(() => {
    if (busy) return;
    void controller.liveCards.opened(slot);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void controller.liveCards.opened(slot));
    return () => sub.remove();
  }, [controller, slot, busy]);

  // A catch-up that covered a stretch away says so for a moment.
  useEffect(() => {
    if (view.caughtUp < BANNER_AT) return;
    setBanner(true);
    const t = setTimeout(() => setBanner(false), BANNER_MS);
    return () => clearTimeout(t);
  }, [view.caughtUp, view.seq]);

  const online = connection.kind === "connected";
  const asleep = chat?.status === "asleep";
  // The Mac accepting the wake isn't the chat being awake: "Waking…" stays until the chat is no longer asleep, or a while
  // has passed (it didn't wake: the button comes back to try again).
  useEffect(() => {
    if (!waking) return;
    if (!asleep) return setWaking(false);
    const t = setTimeout(() => setWaking(false), WAKE_WAIT_MS);
    return () => clearTimeout(t);
  }, [waking, asleep]);
  const loadDiff = useCallback((path: string) => sync.diff(slot, path), [sync, slot]);
  const loadReviewed = useCallback((path: string) => (canReviewDiff ? sync.reviewDiff(slot, path) : sync.diff(slot, path)), [sync, slot, canReviewDiff]);
  /** A Review file page's parts, when its message has them. */
  const reviewOf = (row: Extract<Row, { kind: "page" }>): ReviewFile | null => (row.page.kind === "file" ? parseReviewFile(row.page.title, row.page.body) : null);
  /** The verdicts a Review page's Next carried, read back from that message (the first of yours after the page). */
  const sentVerdicts = (row: Extract<Row, { kind: "page" }>, file: ReviewFile) => {
    for (let i = rows.indexOf(row) + 1; i < rows.length && rows[i].kind !== "page"; i++) {
      const r = rows[i];
      if (r.kind === "user") return verdictsFromNext(r.item.text, file.findings);
    }
    return undefined;
  };
  const pickVerdict = (id: string, index: number, v: Verdict | null) =>
    setVerdicts((all) => {
      const mine = { ...all[id] };
      if (v) mine[index] = v;
      else delete mine[index];
      return { ...all, [id]: mine };
    });

  const reply = (id: string, a: PageAction) => {
    // The Done page's own buttons: they open something here and the page can still be answered.
    if (a.go === "changes") return changesPane ? (changesPane.shown ? undefined : changesPane.onToggle()) : openChanges();
    if (a.go === "new") return onStartNew?.(chat?.project ?? null);
    setAnswered((s) => new Set(s).add(id));
    if (a.reply) void sync.send(slot, a.reply);
  };
  const fail = (e: unknown) => {
    setProblem((e as Error).message);
    buzz("warning");
  };

  /**
   * A command typed in the terminal. The phone first checks who is holding it by Face ID (or Touch ID, never the passcode
   * instead): every command, and whether or not the app lock is on; a phone that can't do that can't run commands. Then it
   * shows the command back to be run by a swipe. Whether it ran: the box keeps what was typed until it did.
   */
  const runCommand = async (command: string): Promise<boolean> => {
    // What can't be seen can't be read back to be approved: a command with such a character in it is not run.
    if (hasHiddenChars(command)) {
      setProblem("That command has a character that can't be seen, so it wasn't run. Type it again.");
      return false;
    }
    const proof = await lock.verify("Run a command on your Mac");
    if (proof === "cancelled") return false;
    if (proof === "unavailable") {
      setProblem("Running commands needs Face ID (or Touch ID) set up on this phone, and it isn't. Turn it on in the phone's Settings.");
      return false;
    }
    if (proof !== "ok") {
      setProblem("That didn't work, so nothing was run. Try again.");
      return false;
    }
    swiped.current = false;
    return new Promise<boolean>((resolve) => setConfirming({ command, resolve }));
  };
  // Swiped: it goes to the Mac; a refusal (the chat is asleep, too long…) is said, and the box keeps the command.
  const startCommand = () => {
    const c = confirming;
    if (!c || swiped.current) return;
    swiped.current = true;
    sync.shellRun(slot, c.command).then(
      () => c.resolve(true),
      (e) => {
        fail(e);
        c.resolve(false);
      },
    );
  };

  // What was in the chat when it finished loading just is; what comes after (a message sent, Claude's words, a prompt)
  // comes in with a fade and a rise.
  const known = useRef<Set<string> | null>(null);
  if (known.current === null && !view.resetting && rows.length > 0) known.current = new Set(rows.map((r) => r.key));
  const arrives = (key: string) => known.current !== null && !known.current.has(key);

  // Your last message can be edited and sent again; what Claude's last message asks, if it is a yes or no, can be answered at once.
  const lastUser = [...rows].reverse().find((r) => r.kind === "user")?.key;
  const lastWords = [...rows].reverse().find((r) => r.kind !== "turn" && r.kind !== "steps" && r.kind !== "hook" && r.kind !== "day");
  // A turn that failed can be tried again: its message is sent once more (only the last turn, and only its words).
  const lastTurn = [...rows].reverse().find((r) => r.kind === "turn" || r.kind === "user");
  const lastUserText = [...rows].reverse().find((r) => r.kind === "user");
  // Not when it was the post-hook that failed (that marks the whole turn failed): the task itself is done, and sending its message
  // again would do it all over.
  const hookFailed = lastTurn?.kind === "turn" && rows.slice(rows.indexOf(lastUserText as Row) + 1, rows.indexOf(lastTurn)).some((r) => r.kind === "hook");
  const retry = lastTurn?.kind === "turn" && lastTurn.item.isError && !hookFailed && lastUserText?.kind === "user" && lastUserText.item.text ? () => void sync.send(slot, (lastUserText as Extract<Row, { kind: "user" }>).item.text) : undefined;
  // A file link goes to the Changes pane when there is one that can show it, else to a sheet over the chat.
  const pane = useRef(changesPane);
  pane.current = changesPane;
  const openFile = useCallback((path: string) => void (pane.current?.onFile?.(path) || setFiles([path])), []);
  const openFiles = useCallback((paths: string[]) => (paths.length === 1 ? openFile(paths[0]) : setFiles(paths)), [openFile]);
  const open = chat?.status === "needs_you";
  const replies = lastWords && (lastWords.kind === "assistant" || lastWords.kind === "summary") && !working && !open && !asleep && repliedTo !== lastWords.key ? quickReplies(lastWords.item.text) : [];
  const send = (text: string) => {
    if (lastWords) setRepliedTo(lastWords.key);
    void sync.send(slot, text);
  };
  // The chat bar's tools, beside Search. Compact and Clear are Claude's own commands, as the Mac's context meter sends them (not in
  // Step by step, whose pages they would cut across, not during a turn, which the Mac waits for too, and not while the chat sleeps);
  // Clear asks first, as the Mac does. To-dos opens this project's list, in the chat's sheet beside Changes and Artifacts.
  const commandHint = (what: string) => (asleep ? "Wake the chat first" : working ? "Once Claude has finished its turn" : what);
  const barTools: BarTool[] = [
    ...(stepsChat
      ? []
      : [
          { label: "Compact", icon: "compact" as const, hint: commandHint("Summarises the chat so far to free up context"), disabled: !online || working || asleep, onPress: () => void sync.send(slot, "/compact") },
          {
            label: "Clear",
            icon: "clear" as const,
            hint: commandHint("Starts the conversation afresh"),
            disabled: !online || working || asleep,
            onPress: () =>
              Alert.alert("Clear this conversation?", "Claude forgets this conversation. The files it changed stay as they are.", [
                { text: "Keep it", style: "cancel" },
                { text: "Clear", style: "destructive", onPress: () => void sync.send(slot, "/clear") },
              ]),
          },
        ]),
    ...(canTodos
      ? [
          {
            label: "To-dos",
            icon: "todos" as const,
            hint: "This project's to-do list",
            onPress: () => {
              if (onTodos) return onTodos();
              setPanel("todos");
              setChangesOpen(true);
            },
          },
        ]
      : []),
    ...(canRename && chat?.workflow !== "team"
      ? [
          {
            label: "Rename",
            icon: "rename" as const,
            hint: "Names this chat, here and on the Mac",
            disabled: !online,
            onPress: () =>
              Alert.prompt("Rename this chat", undefined, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Rename",
                  onPress: (name?: string) => {
                    const title = name?.trim();
                    if (title) sync.rename(slot, title).catch(fail);
                  },
                },
              ], "plain-text", chat?.title?.trim() ?? ""),
          },
        ]
      : []),
  ];
  // How far scrolled from the latest, and what came since: a button takes you back, with how many new rows.
  const onScroll = (e: Parameters<typeof distanceFromEnd>[0]) => {
    const far = distanceFromEnd(e) > 260;
    keep.remember(!far);
    setAway((a) => (far ? (a ?? { since: rows.length }) : null));
  };
  const unseen = away ? Math.max(0, rows.length - away.since) : 0;

  const renderRow = ({ item: row }: { item: Row }) => {
    // What is searched for, given only to the messages that say it: the rest are not drawn again as it is typed.
    const term = marks.all.has(row.key) ? find?.query : undefined;
    const body = (() => {
      switch (row.kind) {
        case "user":
          return <UserRow item={row.item} showTime={row.showTime} queued={queued.has(row.item.id)} mark={term} onActions={() => setActions({ text: row.item.text, own: true, last: row.key === lastUser, at: row.item.at })} />;
        case "assistant":
          return <AssistantRow item={row.item} mark={term} files={row.files} onFile={openFile} onActions={() => setActions({ text: row.item.text, own: false, last: false })} />;
        case "summary":
          return <SummaryRow row={row} onFiles={openFiles} onFile={openFile} mark={term} onActions={() => setActions({ text: row.item.text, own: false, last: false })} />;
        case "page": {
          // On a page of its own, a Review file page is laid out as the Mac's: its file a link to its change, and its findings.
          const file = paged ? reviewOf(row) : null;
          if (file) {
            const open = row === newest && !answered.has(row.item.id) && !working;
            return <ReviewFilePage kicker={row.page.kicker} file={file} verdicts={open ? verdicts[row.item.id] : (sentVerdicts(row, file) ?? verdicts[row.item.id])} onVerdict={open ? (i, v) => pickVerdict(row.item.id, i, v) : undefined} onOpen={setReviewed} />;
          }
          return <PageRow row={row} answered={answered.has(row.item.id)} mark={term} paged={paged} onFile={openFile} onAction={(a) => reply(row.item.id, a)} />;
        }
        case "steps":
          return <StepsRow rowKey={row.key} chips={row.chips} took={row.took} onFiles={openFiles} onOutput={canOutput ? setOutput : undefined} />;
        case "prompt":
          return (
            <PromptRow
              item={row.item}
              me={me}
              onReview={() => onReview(row.item.id)}
              onSwiping={setSwiping}
              onAllow={() =>
                sync.answer(slot, row.item.id, true).catch((e) => {
                  fail(e);
                  throw e;
                })
              }
            />
          );
        case "desktop":
          return <DesktopRow item={row.item} />;
        case "turn":
          return <TurnRow item={row.item} onRetry={row === lastTurn && online ? retry : undefined} />;
        case "day":
          return <DayRow label={row.label} />;
        case "hook":
          return <HookRow row={row} onFiles={openFiles} onOutput={canOutput ? setOutput : undefined} />;
        case "shell":
          return (
            <View style={{ paddingHorizontal: space.lg, paddingTop: 10 }}>
              <ShellCard item={row.item} onTell={() => setSeed({ id: Date.now(), text: tellClaude(row.item.command, row.item.output, row.item.status, row.item.code), mode: "append" })} onInput={(text) => sync.shellInput(slot, row.item.id, text).catch(fail)} onStop={() => sync.shellStop(slot, row.item.id).catch(fail)} />
            </View>
          );
      }
    })();
    // While searching, the match being looked at has an outline in the accent, and the other matches a faint one.
    const mark = marks.here === row.key ? "here" : marks.all.has(row.key) ? "other" : null;
    return (
      <FadeSlideIn animate={arrives(row.key)} from={row.kind === "user" ? 18 : 12} ms={row.kind === "user" ? 280 : 240}>
        {body}
        {mark && <View testID={`match-${mark}`} pointerEvents="none" style={[StyleSheet.absoluteFill, { marginHorizontal: 6, borderRadius: radius.inner, borderWidth: mark === "here" ? 2 : 1, borderColor: mark === "here" ? colors.cobalt : `${colors.cobalt}55` }]} />}
      </FadeSlideIn>
    );
  };

  // The pieces of the screen. On iOS 26 the list runs under the header and the message box, which are glass; elsewhere they sit above and below it as before.
  const head = (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 10 }}>
        {lead === "back" && (
          <PressScale accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={HEADER_SLOP} scaleTo={0.88}>
            <Glass style={{ width: control, height: control, borderRadius: control / 2, alignItems: "center", justifyContent: "center" }}>
              <View accessibilityElementsHidden style={{ width: 12, height: 12, marginLeft: 4, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: colors.ink, borderRadius: 2, transform: [{ rotate: "45deg" }] }} />
            </Glass>
          </PressScale>
        )}
        {lead === "sidebar" && (
          // It pops in when the chats are unpinned and go away (not when the chat opens with them away: then it was just there).
          // While they are slid in it stays where it is, under them, so they cover and uncover it as they move.
          <PopIn glass animate={sidebarLeadLate}>
            <PressScale accessibilityRole="button" accessibilityLabel="Show chats" accessibilityElementsHidden={leadHidden} importantForAccessibility={leadHidden ? "no-hide-descendants" : "auto"} disabled={leadHidden} onPress={onSidebar} hitSlop={HEADER_SLOP} scaleTo={0.88}>
              <Glass style={{ width: control, height: control, borderRadius: control / 2, alignItems: "center", justifyContent: "center" }}>
                {/* A window with its side panel: the chats. */}
                <View accessibilityElementsHidden style={{ width: 20, height: 16, borderRadius: 4, borderWidth: 2, borderColor: colors.ink, flexDirection: "row", overflow: "hidden" }}>
                  <View style={{ width: 5, borderRightWidth: 2, borderColor: colors.ink }} />
                </View>
              </Glass>
            </PressScale>
          </PopIn>
        )}
        {/* The title bar opens the chat's settings (what it runs on, and its models) when the Mac can say what those are. */}
        <ChatSettings
          slot={slot}
          chat={chat}
          plan={plan}
          context={view.context}
          pages={
            stepsChat
              ? {
                  on: !asList,
                  onChange: (on) => {
                    setAsList(!on);
                    setPicked(null);
                  },
                }
              : undefined
          }
          onProblem={setProblem}
          onClosed={onBack}
        >
          {(line) => (
            // A capsule of glass like the buttons beside it (a solid card with its shadow where there is no glass).
            <Glass style={{ flex: 1, height: control, borderRadius: control / 2, paddingHorizontal: 18, justifyContent: "center" }}>
              <Txt variant="heading" numberOfLines={1} accessibilityRole="header" style={{ lineHeight: 21 }}>
                {chat?.title?.trim() || "Chat"}
              </Txt>
              {/* The project in its colour (the desktop sidebar's), then how the chat stands and what it runs on. */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {!!chat?.project && <ProjectTag name={chat.project} color={projectColorOf(chat.project_color)} />}
                {!!([asleep ? "asleep" : working ? "working" : null, line].filter(Boolean).length) && (
                  <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flexShrink: 1, lineHeight: 16 }}>
                    {[asleep ? "asleep" : working ? "working" : null, line].filter(Boolean).join(" · ")}
                  </Txt>
                )}
              </View>
            </Glass>
          )}
        </ChatSettings>
        <PressScale accessibilityRole="button" accessibilityLabel="Changes" accessibilityState={changesPane ? { expanded: changesPane.shown } : undefined} accessibilityHint={changed.length ? `${changed.length} ${changed.length === 1 ? "file" : "files"} changed` : "Nothing changed yet"} onPress={changesPane ? changesPane.onToggle : () => setChangesOpen(true)} haptic="select" hitSlop={HEADER_SLOP} scaleTo={0.88}>
          <Glass style={{ width: control, height: control, borderRadius: control / 2, alignItems: "center", justifyContent: "center" }}>
            <ChangesIcon color={colors.ink} />
          </Glass>
        </PressScale>
      </View>
      {paged && <StepNav pages={pages} index={pageAt} onIndex={toPage} fresh={freshPage} />}

      {banner && (
        <View accessibilityRole="alert" style={{ marginHorizontal: 16, marginBottom: 6, backgroundColor: colors.card, borderRadius: 10, padding: 10, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.go }} />
          <Txt variant="small" tone="ink2">
            Caught up on {view.caughtUp} {view.caughtUp === 1 ? "event" : "events"} from while you were away
          </Txt>
        </View>
      )}
      {problem && (
        <Pressable accessibilityRole="alert" onPress={() => setProblem(null)} style={{ marginHorizontal: 16, marginBottom: 6, backgroundColor: "#d93b3b14", borderRadius: 10, padding: 10 }}>
          <Txt variant="small" tone="stop">
            {problem}
          </Txt>
        </Pressable>
      )}
    </>
  );
  const foot = (
    <>
      <PlanCard todos={view.todos} />
      {replies.length > 0 && <QuickReplies replies={replies} onSend={send} />}
      {/* A command typed in the terminal, shown back to be run by a swipe: here in the chat, where the swipe takes a drag. */}
      {confirming && (
        <RunCommandCard
          command={confirming.command}
          project={chat?.project ?? null}
          onSwiping={setSwiping}
          onRun={() => {
            startCommand();
            // The card says "Running" for a moment, then goes; the command's own card in the chat takes over.
            setTimeout(() => setConfirming(null), 450);
          }}
          onCancel={() => {
            // Not run, and the box keeps what was typed.
            confirming.resolve(false);
            setConfirming(null);
          }}
        />
      )}
      {asleep ? (
        <View style={{ padding: 16, paddingBottom: barRoom(insets.bottom), gap: 6, backgroundColor: colors.paper }}>
          <Txt variant="small" tone="ink2">
            This chat is asleep to save memory. It picks up where it left off.
          </Txt>
          {/* The chat can still be searched while it sleeps: the same circle, beside the one button there is. */}
          <SearchBar search={barSearch} tools={barTools} capsule={{ flexDirection: "row", alignItems: "center", borderRadius: 26, padding: 6 }}>
            <View style={{ flex: 1 }}>
              <Button
                label={waking ? "Waking…" : "Wake this chat"}
                disabled={!online || waking}
                onPress={() => {
                  setWaking(true);
                  sync.wake(slot).catch((e) => {
                    setWaking(false);
                    fail(e);
                  });
                }}
              />
            </View>
          </SearchBar>
        </View>
      ) : (
        <Composer draftKey={slot} disabled={!online} canAttach={canImages} onSend={(text, images) => void sync.send(slot, text, images)} onRun={canShell ? runCommand : undefined} seed={seed} commands={view.commands} search={barSearch} tools={barTools} working={working} onStop={() => sync.interrupt(slot).catch(fail)} />
      )}
    </>
  );
  // The keyboard. The list keeps its size, and what is in it rises with the keyboard, frame by frame, by as much as the bar does
  // (the keyboard's height less the room the bar already has under it): once, with the keyboard. It used to get shorter as the
  // keyboard came, which held the messages at the top where they were, with the last ones behind the keyboard, and then scrolled
  // them up after it (seen on the simulator: two moves, the first leaving the end hidden).
  const lift = barRoom(insets.bottom) - KEYBOARD_GAP;
  const scrollComponent = useMemo(
    () => forwardRef<never, ScrollViewProps>((props, ref) => <KeyboardChatScrollView ref={ref} {...props} offset={lift} keyboardLiftBehavior="always" />),
    [lift],
  );
  const listEl = (
      <FlashList
        renderScrollComponent={scrollComponent}
        testID="chat-list"
        // A tap on the status bar would jump to the oldest message loaded, which in a chat is never where the reader wants to be,
        // and on a tablet the header's buttons are right under it.
        scrollsToTop={false}
        contentContainerStyle={glass ? { paddingTop: top, paddingBottom: bottom } : undefined}
        ref={list}
        onScroll={onScroll}
        scrollEventThrottle={64}
        data={rows}
        extraData={marks}
        renderItem={renderRow}
        keyExtractor={(r) => r.key}
        scrollEnabled={!swiping}
        getItemType={(r) => (r.kind === "page" ? `page-${r.live}` : r.kind)}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true }}
        ListHeaderComponent={
          loadingEarlier ? (
            <ChatSkeleton label="Loading earlier messages" />
          ) : view.hidden > 0 ? (
            <View style={{ padding: space.lg, alignItems: "center" }}>
              <Button
                label={`Show earlier messages (${view.hidden} ${view.hidden === 1 ? "turn" : "turns"})`}
                kind="ghost"
                onPress={() => {
                  setLoadingEarlier(true);
                  sync.loadEarlier(slot).catch(fail).finally(() => setLoadingEarlier(false));
                }}
              />
            </View>
          ) : null
        }
        ListFooterComponent={
          working ? (
            <WorkingFooter activity={activityOf(view.items, view.thinking)} since={workingSince[slot] ?? null} />
          ) : (
            <View style={{ height: 8 }} />
          )
        }
        ListEmptyComponent={
          // Never a bare "nothing": it is loading (the shape of a chat, breathing), it failed (and says why, with a way to try again), or it is truly empty.
          view.loadError && !view.loaded && online ? (
            <View accessibilityRole="alert" style={{ padding: space.xl, gap: 10, alignItems: "flex-start" }}>
              <Txt variant="heading">Couldn't load this chat</Txt>
              <Txt variant="small" tone="ink2">
                {view.loadError}
              </Txt>
              <Button label="Try again" kind="ghost" onPress={() => sync.retryLoad(slot)} />
            </View>
          ) : !view.loaded || view.resetting || !online ? (
            // The shape of a chat in grey, breathing (the banner above already says when the Mac can't be reached).
            <ChatSkeleton label={online ? "Loading this chat" : "Waiting for your Mac"} />
          ) : (
            <Txt variant="body" tone="ink2" style={{ padding: space.xl }}>
              {asleep ? "Nothing to show yet. Wake this chat to pick up where it left off." : "Nothing in this chat yet."}
            </Txt>
          )
        }
      />
  );
  // The newest page's buttons float above the message box while it is on screen, and stay while the step is talked about (until
  // one is pressed, or Claude is at work). On an older page there are none: they would answer a page not on screen.
  const heading = paged && pageAt === pages.length - 1 ? newest : undefined;
  // A Review file page's Next carries its verdicts, as the Mac's does ("Next. Agreed: line 42."; a plain "Next" with none).
  const nextOf = (h: Extract<Row, { kind: "page" }>, a: PageAction): PageAction => {
    const file = a.reply === "Next" ? reviewOf(h) : null;
    if (!file) return a;
    const message = verdictMessage(file.findings, verdicts[h.item.id]);
    return { ...a, reply: message === "Next." ? "Next" : message };
  };
  const pageBar = heading && !working && !answered.has(heading.item.id) && heading.page.actions.length > 0 ? <PageActionsFloat actions={heading.page.actions} lift={glass ? bottom : 0} onHeight={setFloatHeight} onAction={(a) => reply(heading.item.id, nextOf(heading, a))} /> : null;
  const body = paged ? <StepPager pages={pages} index={pageAt} onIndex={toPage} renderRow={renderRow} padTop={glass ? top : 0} padBottom={glass ? bottom : 0} endRoom={pageBar ? floatHeight + 10 : 0} places={places} lift={lift} held={swiping} footer={working ? <WorkingFooter activity={activityOf(view.items, view.thinking)} since={workingSince[slot] ?? null} /> : null} /> : listEl;
  // What floats over the list rides the keyboard with the bar.
  const riding = (el: React.ReactNode) =>
    el ? (
      <KeyboardStickyView offset={{ closed: 0, opened: lift }} style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {el}
      </KeyboardStickyView>
    ) : null;
  const jump = away && !paged && <JumpToBottom unseen={unseen} lift={glass ? bottom : 0} onPress={() => list.current?.scrollToEnd({ animated: true })} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {glass ? (
        <View style={{ flex: 1 }}>
          <View style={StyleSheet.absoluteFill} onLayout={(e) => keep.widthChanged(e.nativeEvent.layout.width)}>
            {body}
          </View>
          {riding(jump)}
          {riding(pageBar)}
          {/* The back button, the title and the rest float over the chat as glass. The page's colour fades out behind them (strong at
              the top, where the clock is, to nothing below) so the words under them never run into them. */}
          <View style={{ position: "absolute", top: 0, left: 0, right: 0 }} onLayout={(e) => setTop(e.nativeEvent.layout.height)}>
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              {HEADER_FADE.map((a) => (
                <View key={a} style={{ flex: 1, backgroundColor: `${colors.paper}${Math.round(a * 255).toString(16).padStart(2, "0")}` }} />
              ))}
            </View>
            {head}
            <View style={{ height: 18 }} />
          </View>
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0 }} onLayout={(e) => setBottom(e.nativeEvent.layout.height)}>
            <KeyboardStickyView offset={{ closed: 0, opened: lift }}>{foot}</KeyboardStickyView>
          </View>
        </View>
      ) : (
        <>
          {head}
          <View style={{ flex: 1 }} onLayout={(e) => keep.widthChanged(e.nativeEvent.layout.width)}>
            {body}
            {riding(jump)}
            {riding(pageBar)}
          </View>
          <KeyboardStickyView offset={{ closed: 0, opened: lift }}>{foot}</KeyboardStickyView>
        </>
      )}
      {actions && (
        <MessageActionsSheet
          text={actions.text}
          onQuote={() => setSeed({ id: Date.now(), text: quote(actions.text), mode: "append" })}
          onEdit={actions.own && actions.last ? () => setSeed({ id: Date.now(), text: actions.text, mode: "replace" }) : undefined}
          reading={reading}
          sentAt={actions.at ?? null}
          onReadAloud={() => {
            if (reading) {
              platformSpeech.stop();
              setReading(false);
              return;
            }
            setReading(true);
            platformSpeech.read(actions.text).then(
              () => setReading(false),
              (e: Error) => {
                setReading(false);
                fail(e);
              },
            );
          }}
          onClose={() => setActions(null)}
        />
      )}
      <PageSheet visible={changesOpen} onClose={() => setChangesOpen(false)}>
        {panel === "artifacts" && canArtifacts ? (
          <ArtifactsPane slot={slot} inSheet hideLabel="Close" title={<PanelMenu value="artifacts" artifacts todos={canTodos} onPick={setPanel} />} onHide={() => setChangesOpen(false)} />
        ) : panel === "todos" && canTodos ? (
          <TodosPane projectName={chat?.project ?? null} inSheet hideLabel="Close" title={<PanelMenu value="todos" artifacts={canArtifacts} todos onPick={setPanel} />} onHide={() => setChangesOpen(false)} />
        ) : (
          <ChangesPane slot={slot} inSheet hideLabel="Close" title={<PanelMenu value="changes" artifacts={canArtifacts} todos={canTodos} onPick={setPanel} />} onHide={() => setChangesOpen(false)} />
        )}
      </PageSheet>
      {files && <DiffSheet files={files} load={loadDiff} onClose={() => setFiles(null)} />}
      {reviewed && <DiffSheet files={[reviewed]} load={loadReviewed} onClose={() => setReviewed(null)} />}
      {output && <StepOutputSheet title={output.text} load={() => sync.stepOutput(slot, output.id)} onClose={() => setOutput(null)} />}
    </View>
  );
}
