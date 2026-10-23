import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { markSeen } from "../seen";
import { useConnectionState, useController, useDeviceId, useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { Button, ProjectTag, Txt } from "../ui/components";
import { AboveKeyboard } from "../ui/keyboard";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { ChatSkeleton, Dots } from "../ui/skeleton";
import { Glass, useGlass } from "../ui/Glass";
import { space, useColors } from "../ui/theme";
import { quickReplies, quote, searchRows } from "../view/chatText";
import { projectColorOf } from "../view/home";
import { hasHiddenChars } from "../view/shell";
import { timeline, type Row } from "../view/timeline";
import type { PageAction } from "../view/pages";
import { ChatSearchSheet, distanceFromEnd, JumpToBottom, MessageActionsSheet, PlanCard, QuickReplies, StepOutputSheet, type ComposeSeed } from "./ChatExtras";
import { useMacCan } from "../shell/useControls";
import { useAppLock } from "../shell/lockContext";
import { ChatSettings } from "./ChatSettings";
import { AssistantRow, Composer, DesktopRow, DiffSheet, PageRow, PromptRow, StepsRow, SummaryRow, TurnRow, UserRow } from "./ChatParts";
import { RunCommandCard } from "./RunCommand";
import { ShellCard } from "./ShellCard";

export interface ChatProps {
  slot: string;
  onBack: () => void;
  /** Opens the full-screen decision for one of this chat's prompts. */
  onReview: (requestId: string) => void;
  /** What leads the header: a back button (the phone), the chats' button (a tablet held upright: they slide in), or nothing (they are beside the chat). */
  lead?: "back" | "sidebar" | "none";
  onSidebar?: () => void;
}

/** How long "Caught up on 14 events" stays up. */
const BANNER_MS = 4000;
/** How long "Waking…" waits for the chat to be awake before the button comes back. */
export const WAKE_WAIT_MS = 20_000;

/** A chat, as a timeline with a message box under it. */
export function ChatScreen({ slot, onBack, onReview, lead = "back", onSidebar }: ChatProps) {
  const colors = useColors();
  const controller = useController();
  const { sync } = controller;
  const { chats, views, plan } = useSyncState();
  const canOutput = useMacCan("output");
  const canShell = useMacCan("shell");
  const lock = useAppLock();
  const [output, setOutput] = useState<{ id: string; text: string } | null>(null);
  // A command typed in the terminal, shown back to be run by a swipe: `resolve` says whether it was run.
  const [confirming, setConfirming] = useState<{ command: string; resolve: (ran: boolean) => void } | null>(null);
  // Whether the swipe happened: one swipe is one command, however often the card is touched after it.
  const swiped = useRef(false);
  const connection = useConnectionState();
  const me = useDeviceId();
  const insets = useSafeAreaInsets();
  // On iOS 26 the list runs under the header and the message box: how much room they take.
  const glass = useGlass();
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(0);
  const chat = chats.find((c) => c.slot === slot);
  const view = views[slot] ?? emptyView;
  const rows = useMemo(() => timeline(view.items), [view.items]);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<string[] | null>(null);
  const [banner, setBanner] = useState(false);
  const [waking, setWaking] = useState(false);
  // While a swipe to allow is being dragged the chat holds still: it can't scroll out from under the finger.
  const [swiping, setSwiping] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Holding a message down (what can be done with it), searching the chat, being scrolled away from its end, and words put in
  // the message box (a quote, an edit).
  const [actions, setActions] = useState<{ text: string; own: boolean; last: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [away, setAway] = useState<{ since: number } | null>(null);
  const [seed, setSeed] = useState<ComposeSeed | undefined>(undefined);
  const [repliedTo, setRepliedTo] = useState<string | null>(null);
  const list = useRef<FlashListRef<Row>>(null);

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

  // A catch-up that covered a stretch away says so for a moment.
  useEffect(() => {
    if (view.caughtUp <= 0) return;
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
  const working = chat?.status === "working";
  const loadDiff = useCallback((path: string) => sync.diff(slot, path), [sync, slot]);

  const reply = (id: string, a: PageAction) => {
    setAnswered((s) => new Set(s).add(id));
    if (a.reply) void sync.send(slot, a.reply);
  };
  const fail = (e: unknown) => setProblem((e as Error).message);

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
  const lastWords = [...rows].reverse().find((r) => r.kind !== "turn" && r.kind !== "steps");
  const open = chat?.status === "needs_you";
  const replies = lastWords && (lastWords.kind === "assistant" || lastWords.kind === "summary") && !working && !open && !asleep && repliedTo !== lastWords.key ? quickReplies(lastWords.item.text) : [];
  const send = (text: string) => {
    if (lastWords) setRepliedTo(lastWords.key);
    void sync.send(slot, text);
  };
  // How far scrolled from the latest, and what came since: a button takes you back, with how many new rows.
  const onScroll = (e: Parameters<typeof distanceFromEnd>[0]) => {
    const far = distanceFromEnd(e) > 260;
    setAway((a) => (far ? (a ?? { since: rows.length }) : null));
  };
  const unseen = away ? Math.max(0, rows.length - away.since) : 0;

  const renderRow = ({ item: row }: { item: Row }) => {
    const body = (() => {
      switch (row.kind) {
        case "user":
          return <UserRow item={row.item} onActions={() => setActions({ text: row.item.text, own: true, last: row.key === lastUser })} />;
        case "assistant":
          return <AssistantRow item={row.item} onActions={() => setActions({ text: row.item.text, own: false, last: false })} />;
        case "summary":
          return <SummaryRow row={row} onFiles={setFiles} onActions={() => setActions({ text: row.item.text, own: false, last: false })} />;
        case "page":
          return <PageRow row={row} answered={answered.has(row.item.id)} onAction={(a) => reply(row.item.id, a)} />;
        case "steps":
          return <StepsRow chips={row.chips} onFiles={setFiles} onOutput={canOutput ? setOutput : undefined} />;
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
          return <TurnRow item={row.item} />;
        case "shell":
          return (
            <View style={{ paddingHorizontal: space.lg, paddingTop: 10 }}>
              <ShellCard item={row.item} onInput={(text) => sync.shellInput(slot, row.item.id, text).catch(fail)} onStop={() => sync.shellStop(slot, row.item.id).catch(fail)} />
            </View>
          );
      }
    })();
    return (
      <FadeSlideIn animate={arrives(row.key)} from={row.kind === "user" ? 18 : 12} ms={row.kind === "user" ? 280 : 240}>
        {body}
      </FadeSlideIn>
    );
  };

  // The pieces of the screen. On iOS 26 the list runs under the header and the message box, which are glass; elsewhere they sit above and below it as before.
  const head = (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 10 }}>
        {lead === "back" && (
          <PressScale accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8} scaleTo={0.88}>
            <Glass style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
              <View accessibilityElementsHidden style={{ width: 12, height: 12, marginLeft: 4, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: colors.ink, borderRadius: 2, transform: [{ rotate: "45deg" }] }} />
            </Glass>
          </PressScale>
        )}
        {lead === "sidebar" && (
          <PressScale accessibilityRole="button" accessibilityLabel="Show chats" onPress={onSidebar} hitSlop={8} scaleTo={0.88}>
            <Glass style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
              {/* A window with its side panel: the chats. */}
              <View accessibilityElementsHidden style={{ width: 20, height: 16, borderRadius: 4, borderWidth: 2, borderColor: colors.ink, flexDirection: "row" }}>
                <View style={{ width: 5, borderRightWidth: 2, borderColor: colors.ink }} />
              </View>
            </Glass>
          </PressScale>
        )}
        {/* The title bar opens the chat's settings (what it runs on, and its models) when the Mac can say what those are. */}
        <ChatSettings slot={slot} chat={chat} plan={plan} context={view.context} onProblem={setProblem} onClosed={onBack}>
          {(line) => (
            <View style={{ flex: 1 }}>
              <Txt variant="heading" numberOfLines={1} accessibilityRole="header">
                {chat?.title?.trim() || "Chat"}
              </Txt>
              {/* The project in its colour (the desktop sidebar's), then how the chat stands and what it runs on. */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {!!chat?.project && <ProjectTag name={chat.project} color={projectColorOf(chat.project_color)} />}
                {!!([asleep ? "asleep" : working ? "working" : null, line].filter(Boolean).length) && (
                  <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {[asleep ? "asleep" : working ? "working" : null, line].filter(Boolean).join(" · ")}
                  </Txt>
                )}
              </View>
            </View>
          )}
        </ChatSettings>
        {/* Looking for something said in this chat. */}
        <PressScale accessibilityRole="button" accessibilityLabel="Search this chat" onPress={() => setSearching(true)} hitSlop={8} scaleTo={0.88}>
          <Glass style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
            <View accessibilityElementsHidden style={{ width: 20, height: 20 }}>
              <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: colors.ink }} />
              <View style={{ position: "absolute", left: 11, top: 12, width: 8, height: 2.5, borderRadius: 2, backgroundColor: colors.ink, transform: [{ rotate: "45deg" }] }} />
            </View>
          </Glass>
        </PressScale>
        {working && (
          <FadeSlideIn from={-6} ms={200}>
            <PressScale accessibilityRole="button" accessibilityLabel="Stop" onPress={() => sync.interrupt(slot).catch(fail)} hitSlop={8} scaleTo={0.92} style={{ height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.ink, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 11, height: 11, borderRadius: 2, backgroundColor: colors.onInk }} />
              <Txt variant="small" tone="on-ink" style={{ fontWeight: "700" }}>
                Stop
              </Txt>
            </PressScale>
          </FadeSlideIn>
        )}
      </View>

      {!online && (
        <View accessibilityRole="alert" style={{ marginHorizontal: 16, marginBottom: 6, backgroundColor: colors.card, borderRadius: 10, padding: 10 }}>
          <Txt variant="small" tone="ink2">
            {connection.kind === "offline" ? "Not connected to your Mac. It reconnects by itself." : "Connecting to your Mac…"}
          </Txt>
        </View>
      )}
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
        <View style={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16), gap: 6, backgroundColor: colors.paper }}>
          <Txt variant="small" tone="ink2">
            This chat is asleep to save memory. It picks up where it left off.
          </Txt>
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
      ) : (
        <Composer disabled={!online} onSend={(text) => void sync.send(slot, text)} onRun={canShell ? runCommand : undefined} seed={seed} commands={view.commands} />
      )}
    </>
  );
  const listEl = (
      <FlashList
        testID="chat-list"
        contentContainerStyle={glass ? { paddingTop: top, paddingBottom: bottom } : undefined}
        ref={list}
        onScroll={onScroll}
        scrollEventThrottle={64}
        data={rows}
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 6 }}>
              <Dots />
              <Txt variant="small" tone="ink3">
                Claude is working…
              </Txt>
            </View>
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
  const jump = away && <JumpToBottom unseen={unseen} lift={glass ? bottom : 0} onPress={() => list.current?.scrollToEnd({ animated: true })} />;

  return (
    <AboveKeyboard style={{ backgroundColor: colors.paper }}>
      {glass ? (
        <View style={{ flex: 1 }}>
          <View style={StyleSheet.absoluteFill}>{listEl}</View>
          {jump}
          {/* The header is solid, with the page's colour fading out below it, so the words under it never run into the title. */}
          <View style={{ position: "absolute", top: 0, left: 0, right: 0 }} onLayout={(e) => setTop(e.nativeEvent.layout.height)}>
            <View style={{ backgroundColor: colors.paper }}>{head}</View>
            <View pointerEvents="none" style={{ height: 18 }}>
              {[0.95, 0.7, 0.4, 0.15].map((a) => (
                <View key={a} style={{ flex: 1, backgroundColor: `${colors.paper}${Math.round(a * 255).toString(16).padStart(2, "0")}` }} />
              ))}
            </View>
          </View>
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0 }} onLayout={(e) => setBottom(e.nativeEvent.layout.height)}>
            {foot}
          </View>
        </View>
      ) : (
        <>
          {head}
          <View style={{ flex: 1 }}>
            {listEl}
            {jump}
          </View>
          {foot}
        </>
      )}
      {actions && (
        <MessageActionsSheet
          text={actions.text}
          onQuote={() => setSeed({ id: Date.now(), text: quote(actions.text), mode: "append" })}
          onEdit={actions.own && actions.last ? () => setSeed({ id: Date.now(), text: actions.text, mode: "replace" }) : undefined}
          onClose={() => setActions(null)}
        />
      )}
      {searching && (
        <ChatSearchSheet
          search={(q) => searchRows(rows, q)}
          onPick={(hit) => {
            list.current?.scrollToIndex({ index: hit.index, animated: true, viewPosition: 0.3 });
          }}
          onClose={() => setSearching(false)}
        />
      )}
      {files && <DiffSheet files={files} load={loadDiff} onClose={() => setFiles(null)} />}
      {output && <StepOutputSheet title={output.text} load={() => sync.stepOutput(slot, output.id)} onClose={() => setOutput(null)} />}
    </AboveKeyboard>
  );
}
