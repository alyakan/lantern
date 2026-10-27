import { useEffect, useRef, useState } from "react";
import { Animated, Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { loadFolded, loadGrouping, saveFolded, saveGrouping } from "../prefs";
import { markSeen, markUnread, settleSeen, useSeen } from "../seen";
import { setPinned, settlePins, usePins } from "../pins";
import { useConnectionState, useController, useSyncState } from "../shell/hooks";
import { useMacCan } from "../shell/useControls";
import { useTipJar, useTips } from "../shell/tipsContext";
import { Button, ProjectTag, Tag, Tile, Txt } from "../ui/components";
import { FadeSlideIn, PressScale, PulseDot } from "../ui/motion";
import { useAccent } from "../ui/accent";
import { Chevron } from "../ui/Chevron";
import { Dots, HomeSkeleton } from "../ui/skeleton";
import { radius, shadow, space, useColors } from "../ui/theme";
import { countsOf, diffPreviewOf } from "../view/diffPreview";
import { cards, groups, headline, projectTint, rows, type Card, type Grouping, type Group, type Row } from "../view/home";
import type { Draft } from "./NewChatSheet";
import { UsageStrip } from "./ChatExtras";
import { ChatActionsSheet } from "./ChatActions";
import { CloseChatSheet } from "./CloseChat";
import { Suggestions } from "./Suggestions";
import { UsageSheet } from "./UsageSheet";

export interface HomeProps {
  onOpenChat: (slot: string) => void;
  /** Opens the full-screen decision for one prompt. */
  onReview: (slot: string, requestId: string) => void;
  /** The Mac's own sheet (its name, unpairing). */
  onOpenMac: () => void;
  /** Android's "Message a chat". */
  onCompose: () => void;
  /** Starts a chat in a project, with a first message the user writes (or a suggestion's draft); or carries one on. */
  onNewChat: (draft?: Draft) => void;
  /** Opens the optional tips. */
  onSupport: () => void;
  /** On a tablet, Home is the side column and the chat open beside it is marked here. */
  selectedSlot?: string | null;
  /** On a tablet, whether the chats are pinned beside the chat, and the button that pins or unpins them (none on a phone). */
  pinned?: boolean;
  onTogglePin?: () => void;
}

/** The sidebar, drawn: a window with its left third set apart, filled in when the chats are pinned beside the chat. */
function PinGlyph({ pinned }: { pinned: boolean }) {
  const colors = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 24, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: pinned ? colors.ink : colors.ink3, flexDirection: "row", overflow: "hidden" }}>
      <View style={{ width: 8, backgroundColor: pinned ? colors.ink : "transparent", borderRightWidth: 1.5, borderRightColor: pinned ? colors.ink : colors.ink3 }} />
    </View>
  );
}

/** A thin bar that slides while a chat is working. */
function Working() {
  const colors = useColors();
  const accent = useAccent();
  const x = useRef(new Animated.Value(-1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(x, { toValue: 2.5, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [x]);
  return (
    <View accessibilityLabel="Working" style={{ width: 54, height: 4, borderRadius: 2, backgroundColor: colors.rule, overflow: "hidden" }}>
      <Animated.View style={{ width: "40%", height: "100%", backgroundColor: accent, borderRadius: 2, transform: [{ translateX: Animated.multiply(x, 22) }] }} />
    </View>
  );
}

function Deck({ list, onOpenChat, onReview }: { list: Card[]; onOpenChat: HomeProps["onOpenChat"]; onReview: HomeProps["onReview"] }) {
  const colors = useColors();
  const front = list[0];
  const behind = Math.min(2, list.length - 1);
  // A file change says how big it is before it is opened.
  const change = diffPreviewOf(front.waiting.tool_name, front.waiting.input);
  return (
    <View style={{ marginHorizontal: space.lg, paddingBottom: 14 }}>
      {behind >= 2 && <View style={{ position: "absolute", left: 14, right: 14, top: 14, bottom: -8, backgroundColor: colors.card, borderRadius: radius.card, opacity: 0.6 }} />}
      {behind >= 1 && <View style={{ position: "absolute", left: 7, right: 7, top: 7, bottom: -2, backgroundColor: colors.card, borderRadius: radius.card, opacity: 0.85 }} />}
      {/* A new card on top (the one before was answered) comes in, instead of the text changing under the eye. */}
      <FadeSlideIn key={front.waiting.request_id} from={12} style={[{ backgroundColor: colors.card, borderRadius: radius.card, padding: 18, gap: 4 }, shadow.card]}>
        <Tag>{front.view.tag}</Tag>
        <Txt variant="heading" style={{ marginTop: 8 }}>
          {front.view.title}
        </Txt>
        <Txt variant="small" tone="ink2">
          {front.from}
        </Txt>
        {front.view.detail && (
          <View style={{ backgroundColor: colors.paper, borderRadius: radius.inner, padding: 10, marginTop: 8 }}>
            <Txt variant="mono" numberOfLines={3}>
              {front.view.detail}
            </Txt>
          </View>
        )}
        {!!change && (
          <Txt variant="small" tone="ink2" testID="deck-change" style={{ marginTop: 6 }}>
            {change.partial ? "At least " : ""}
            {countsOf(change)} lines. Review shows the change.
          </Txt>
        )}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button label="Open chat" kind="ghost" style={{ flex: 1 }} onPress={() => onOpenChat(front.waiting.slot)} />
          <Button label="Review" style={{ flex: 1 }} onPress={() => onReview(front.waiting.slot, front.waiting.request_id)} />
        </View>
      </FadeSlideIn>
    </View>
  );
}

/** How far a project card's header and chats are from its edge. */
const CARD_INSET = 16;

/** `inset`: the space on either side of the row (the page's, unless the row sits in a card that has its own). */
function ChatRow({ row, index, onPress, onLongPress, showProject = true, inset = space.xl, selected = false }: { row: Row; index: number; onPress: () => void; onLongPress?: () => void; showProject?: boolean; inset?: number; selected?: boolean }) {
  const colors = useColors();
  // The tile is the chat's project's colour (the desktop sidebar's), so a chat is placed by it before it is read.
  const { bg, fg } = projectTint(row.projectColor, colors.plainTint);
  const accent = useAccent();
  // The space between the row's own edge and its content.
  const pad = inset > 8 ? inset - 8 : inset;
  const status = row.unread ? ", unread" : row.status === "needs_you" ? ", needs you" : row.status === "working" ? ", working" : row.status === "asleep" ? ", asleep" : row.status === "ended" ? ", stopped" : "";
  return (
    // The rows come in one after the other when Home opens (and a new chat comes in alone); a press gives under the finger.
    <FadeSlideIn from={14} delay={Math.min(index, 8) * 45 + 120}>
    <PressScale accessibilityRole="button" accessibilityLabel={`${row.title}${showProject && row.project ? `, ${row.project}` : ""}${status}${row.pinned ? ", pinned" : ""}`} accessibilityState={{ selected }} onPress={onPress} onLongPress={onLongPress} accessibilityActions={onLongPress ? [{ name: "longpress", label: "More actions: pin, mark read, close" }] : undefined} onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && onLongPress?.()} haptic="none" scaleTo={0.975} opacity={row.status === "asleep" ? 0.7 : 1} style={[{ flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: inset > 8 ? 8 : 0, paddingHorizontal: pad, paddingVertical: 9, minHeight: 56 }]}>
      {/* The chat you are in: underlined with a line of the accent, from where the row's content starts to where it ends. */}
      {selected && <View accessibilityElementsHidden testID="selected-underline" style={{ position: "absolute", left: pad, right: pad, bottom: 0, height: 2, borderRadius: 1, backgroundColor: accent }} />}
      <View>
        <Tile letter={row.initial} bg={bg} fg={fg} />
        {/* Something new in it: a dot on the tile (cut out from the page behind it), and the title in bold below. */}
        {row.unread && <View accessibilityElementsHidden testID="unread-dot" style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: 7, backgroundColor: accent, borderWidth: 2, borderColor: colors.paper }} />}
      </View>
      <View style={{ flex: 1 }}>
        <Txt variant="body" numberOfLines={1} style={{ fontWeight: row.unread ? "800" : "400" }}>
          {row.pinned && (
            <Txt variant="tiny" tone="ink3" accessibilityElementsHidden>
              {"📌 "}
            </Txt>
          )}
          {row.title}
        </Txt>
        {showProject && !!row.project && (
          <View style={{ marginTop: 3 }}>
            <ProjectTag name={row.project} color={row.projectColor} />
          </View>
        )}
      </View>
      {row.status === "working" ? (
        <Working />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {row.status === "needs_you" && <PulseDot color={colors.hi} />}
          <Txt variant="tiny" tone={row.unread ? "ink" : "ink3"} style={row.unread ? { fontWeight: "700" } : undefined}>
            {row.note}
          </Txt>
        </View>
      )}
    </PressScale>
    </FadeSlideIn>
  );
}

/** How the chats are listed: most recent first, or under their projects. */
function GroupingSwitch({ value, onChange }: { value: Grouping; onChange: (g: Grouping) => void }) {
  const colors = useColors();
  const option = (g: Grouping, label: string) => (
    <PressScale key={g} accessibilityRole="button" accessibilityLabel={`${label}${value === g ? ", selected" : ""}`} accessibilityState={{ selected: value === g }} onPress={() => onChange(g)} scaleTo={0.95} haptic="select" style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: value === g ? colors.ink : "transparent" }}>
      <Txt variant="small" tone={value === g ? "on-ink" : "ink2"} style={{ fontWeight: "700" }}>
        {label}
      </Txt>
    </PressScale>
  );
  return <View style={{ flexDirection: "row", gap: 2, padding: 2, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule }}>{[option("recent", "Recent"), option("project", "Projects")]}</View>;
}

/**
 * One project and its chats as a card, tinted with the project's colour: its name on a band of that colour, which folds
 * the chats away when pressed, and the chats under it. The shadow is on the outer view, since clipping the corners would
 * clip it too.
 */
function ProjectGroup({ group, open, onToggle, onOpenChat, onAskClose, selectedSlot }: { group: Group; open: boolean; onToggle: () => void; onOpenChat: HomeProps["onOpenChat"]; onAskClose?: (r: Row) => void; selectedSlot?: string | null }) {
  const colors = useColors();
  const name = group.project || "No project";
  const { bg, fg } = projectTint(group.rows[0]?.projectColor ?? null, colors.plainTint);
  const accent = useAccent();
  return (
    <View testID={`project-card-${name}`} style={[{ marginHorizontal: space.lg, marginTop: 12, borderRadius: radius.card, backgroundColor: colors.card }, shadow.card]}>
      <View style={{ borderRadius: radius.card, borderWidth: 1, borderColor: bg, overflow: "hidden" }}>
        <PressScale accessibilityRole="button" accessibilityLabel={`${name}, ${group.rows.length === 1 ? "1 chat" : `${group.rows.length} chats`}${group.needsYou ? `, ${group.needsYou} need you` : ""}${group.unread ? `, ${group.unread} unread` : ""}`} accessibilityState={{ expanded: open }} onPress={onToggle} haptic="select" scaleTo={0.985} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: CARD_INSET, backgroundColor: bg, minHeight: 44 }}>
          <Chevron open={open} />
          <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: fg }} />
          <Txt variant="small" style={{ fontWeight: "700", flexShrink: 1, color: fg }} numberOfLines={1}>
            {name}
          </Txt>
          <Txt variant="small" tone="ink3">
            {group.rows.length}
          </Txt>
          {group.needsYou > 0 && <PulseDot color={colors.hi} />}
          {/* A folded card keeps what is new in it in view. */}
          {group.unread > 0 && !open && <View accessibilityElementsHidden testID="unread-card-dot" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: accent }} />}
        </PressScale>
        {open &&
          group.rows.map((r, i) => (
            // Every chat is held in from the card's edges (the row has 8 of its own inside, so the open chat's wash has room around
            // what is on it); no lines between one and the next.
            <View key={r.slot} testID={`card-row-${r.slot}`} style={{ marginHorizontal: CARD_INSET - 8 }}>
              <ChatRow row={r} index={i} showProject={false} inset={8} selected={r.slot === selectedSlot} onPress={() => onOpenChat(r.slot)} onLongPress={onAskClose && (() => onAskClose(r))} />
            </View>
          ))}
      </View>
    </View>
  );
}

/** A quiet way in to the tip jar, under the chats: a tip is optional and nothing is locked behind it. Once there has been one this month it says thanks instead. */
function SupportCard({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const jar = useTipJar();
  const { pledger } = useTips();
  const tipped = jar.hasTippedThisMonth() || pledger;
  return (
    <FadeSlideIn from={10} delay={200} style={{ paddingHorizontal: space.lg, paddingTop: 26 }}>
      <PressScale accessibilityRole="button" accessibilityLabel="Support development" accessibilityHint="Opens the optional tips" onPress={onPress} scaleTo={0.97} haptic="select" style={[{ flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.card, borderRadius: radius.card - 6, paddingVertical: 14, paddingHorizontal: 16 }, shadow.card, { shadowOpacity: 0.05 }]}>
        <Txt variant="heading" accessibilityElementsHidden style={{ width: 28, textAlign: "center" }}>
          {pledger ? "🔥" : tipped ? "✅" : "💛"}
        </Txt>
        <View style={{ flex: 1 }}>
          <Txt variant="small" style={{ fontWeight: "700" }}>
            {tipped ? "Thank you for supporting Lantern" : "Support development"}
          </Txt>
          <Txt variant="tiny" tone="ink2">
            {pledger ? "Ember glows for you" : tipped ? "You can leave another, if you like" : "Everything stays free either way"}
          </Txt>
        </View>
        <Txt variant="body" tone="ink3" accessibilityElementsHidden>
          ›
        </Txt>
      </PressScale>
    </FadeSlideIn>
  );
}

/** Home: what waits on you, as a headline and a stack, then your chats. */
export function HomeScreen({ onOpenChat, onReview, onOpenMac, onCompose, onNewChat, onSupport, selectedSlot, pinned = false, onTogglePin }: HomeProps) {
  const colors = useColors();
  const controller = useController();
  const { chats, workingSince, waiting, chatsLoaded, waitingLoaded, plan } = useSyncState();
  const loading = !chatsLoaded || !waitingLoaded;
  const connection = useConnectionState();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  // How the chats are listed, and which project cards are folded away, are remembered on this phone.
  const [grouping, setGrouping] = useState<Grouping>("recent");
  const [folded, setFolded] = useState<string[]>([]);
  // Holding a chat down offers to close it (on the Mac too), for a Mac that can.
  const canClose = useMacCan("close");
  const [closing, setClosing] = useState<Row | null>(null);
  // Holding a chat down also offers to pin it, and to mark it read or unread (on this phone only).
  const [acting, setActing] = useState<Row | null>(null);
  const pins = usePins();
  const [usageOpen, setUsageOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void loadGrouping().then((g) => live && setGrouping(g));
    // A card folded before this was read stays folded with the rest.
    void loadFolded().then((kept) => live && setFolded((now) => [...kept.filter((p) => !now.includes(p)), ...now]));
    return () => {
      live = false;
    };
  }, []);
  const group = (g: Grouping) => {
    setGrouping(g);
    void saveGrouping(g);
  };
  const toggle = (project: string) => {
    const next = folded.includes(project) ? folded.filter((p) => p !== project) : [...folded, project];
    setFolded(next);
    void saveFolded(next);
  };
  const seen = useSeen();
  useEffect(() => settleSeen(chats), [chats]);
  useEffect(() => settlePins(chats.map((c) => c.slot)), [chats]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const stack = cards(waiting, chats);
  const head = headline(stack.length);
  const list = rows(chats, now, seen, workingSince, pins);
  const macName = connection.kind === "connected" ? connection.welcome.mac_name : null;

  const refresh = async () => {
    setRefreshing(true);
    controller.resume();
    await controller.sync.refreshWaiting();
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {/* Pulling down still refreshes, but with no system spinner (it is made clear: the dots under the Mac's name say it is working). */}
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 96 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="transparent" colors={["transparent"]} progressBackgroundColor="transparent" />}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.xl }}>
          <PressScale accessibilityRole="button" accessibilityLabel={macName ? `${macName}, connected` : "Your Mac"} onPress={onOpenMac} hitSlop={10} haptic="select" scaleTo={0.94} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
            {macName ? <PulseDot color={colors.go} size={8} ms={2600} /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ink3 }} />}
            <Txt variant="small" tone="ink2">
              {macName ?? "Your Mac"}
            </Txt>
          </PressScale>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {refreshing && (
              <View accessibilityLabel="Refreshing" accessibilityRole="progressbar" accessible>
                <Dots />
              </View>
            )}
            {/* A tablet's chats: beside the chat, or slid in when asked and away once a chat is chosen. */}
            {onTogglePin && (
              <PressScale accessibilityRole="button" accessibilityLabel={pinned ? "Unpin the chats" : "Pin the chats beside the chat"} accessibilityState={{ selected: pinned }} onPress={onTogglePin} hitSlop={12} haptic="select" scaleTo={0.9} style={{ minHeight: 32, justifyContent: "center" }}>
                <PinGlyph pinned={pinned} />
              </PressScale>
            )}
          </View>
        </View>
        {plan && <UsageStrip plan={plan} onPress={() => setUsageOpen(true)} />}
        {/* Until the Mac has sent what it has, the shape of it: "nothing waiting" would be a guess. */}
        {loading ? (
          <HomeSkeleton />
        ) : (
          <>
        <View accessibilityRole="header" style={{ paddingHorizontal: space.xl, paddingTop: 14, paddingBottom: 16 }}>
          <Txt variant="headline">{head.big}</Txt>
          <Txt variant="headline" tone="ink3">
            {head.small}
          </Txt>
        </View>

        {stack.length > 0 && <Deck list={stack} onOpenChat={onOpenChat} onReview={onReview} />}
        {/* Nothing waits: Claude suggests what to do next (starting something of your own is "New chat", below). */}
        {stack.length === 0 && macName && <Suggestions onPick={onNewChat} />}
        {stack.length > 1 && (
          <Txt variant="small" tone="ink2" style={{ paddingHorizontal: space.xl, paddingTop: 2 }}>
            {stack.length - 1} more after this one
          </Txt>
        )}

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.xl, paddingTop: 22, paddingBottom: 6 }}>
          <Txt variant="small" style={{ fontWeight: "700" }}>
            All chats
          </Txt>
          {list.length > 1 && <GroupingSwitch value={grouping} onChange={group} />}
          <PressScale accessibilityRole="button" accessibilityLabel="New chat" onPress={() => onNewChat()} hitSlop={8} scaleTo={0.92} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule }}>
            <Txt variant="small" style={{ fontWeight: "700" }}>
              + New chat
            </Txt>
          </PressScale>
        </View>
        {list.length === 0 ? (
          <Txt variant="body" tone="ink2" style={{ paddingHorizontal: space.xl, paddingTop: 8 }}>
            No chats are open on your Mac. Start one in Lantern and it shows up here.
          </Txt>
        ) : grouping === "project" ? (
          groups(list).map((g) => <ProjectGroup key={g.project} group={g} open={!folded.includes(g.project)} onToggle={() => toggle(g.project)} onOpenChat={onOpenChat} onAskClose={setActing} selectedSlot={selectedSlot} />)
        ) : (
          list.map((r, i) => <ChatRow key={r.slot} row={r} index={i} selected={r.slot === selectedSlot} onPress={() => onOpenChat(r.slot)} onLongPress={() => setActing(r)} />)
        )}
        <SupportCard onPress={onSupport} />
          </>
        )}
      </ScrollView>
      {usageOpen && plan && <UsageSheet plan={plan} onClose={() => setUsageOpen(false)} />}
      {acting && (
        <ChatActionsSheet
          title={acting.title}
          project={acting.project}
          pinned={!!acting.pinned}
          unread={acting.status === "idle" ? acting.unread : null}
          onTogglePin={() => setPinned(acting.slot, !acting.pinned)}
          onToggleUnread={acting.status === "idle" ? () => (acting.unread ? markSeen(acting.slot, acting.activeAt) : markUnread(acting.slot)) : null}
          onClose={canClose ? () => setClosing(acting) : null}
          onDismiss={() => setActing(null)}
        />
      )}
      {closing && (
        <CloseChatSheet
          title={closing.title}
          why={closing.status === "working" || closing.status === "needs_you" ? "Claude is busy in this chat. Stop it first, then close it." : null}
          onConfirm={() => controller.sync.close(closing.slot)}
          onClose={() => setClosing(null)}
        />
      )}
      {Platform.OS === "android" && list.length > 0 && (
        <PressScale accessibilityRole="button" accessibilityLabel="Message a chat" onPress={onCompose} scaleTo={0.92} style={[{ position: "absolute", right: 18, bottom: insets.bottom + 18, backgroundColor: colors.ink, borderRadius: 18, paddingHorizontal: 18, minHeight: 52, flexDirection: "row", alignItems: "center", gap: 8 }, shadow.float]}>
          <Txt variant="body" tone="on-ink" style={{ fontWeight: "700" }}>
            + Message a chat
          </Txt>
        </PressScale>
      )}
    </View>
  );
}
