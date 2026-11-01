import { ProviderBadge } from "../ui/ProviderBadge";
import { Fragment, useEffect, useRef, useState } from "react";
import { Animated, LayoutAnimation, Platform, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { loadFolded, loadGrouping, loadHomeMode, saveFolded, saveGrouping, saveHomeMode } from "../prefs";
import { markSeen, markUnread, settleSeen, useSeen } from "../seen";
import { setPinned, settlePins, usePins } from "../pins";
import { useConnectionState, useController, useSyncState } from "../shell/hooks";
import { useMacCan } from "../shell/useControls";
import { useTipJar, useTips } from "../shell/tipsContext";
import { Button, ProjectTag, Tag, Tile, Txt } from "../ui/components";
import { FadeSlideIn, PressScale, PulseDot, run, skips } from "../ui/motion";
import { useAccent } from "../ui/accent";
import { Chevron } from "../ui/Chevron";
import { Glide } from "../ui/Glide";
import { DarkLantern } from "../ui/lanterns";
import { PinIcon } from "../ui/PinIcon";
import { Dots, HomeSkeleton } from "../ui/skeleton";
import { SwipeRow } from "../ui/SwipeRow";
import { radius, shadow, space, useColors } from "../ui/theme";
import { countsOf, diffPreviewOf } from "../view/diffPreview";
import { cards, groups, headline, matches, projectTint, rows, sections, type Card, type Grouping, type Group, type Row } from "../view/home";
import type { Draft } from "./NewChatSheet";
import { HomeSearch } from "./HomeSearch";
import { UsageStrip } from "./ChatExtras";
import { ChatActionsSheet } from "./ChatActions";
import { CloseChatSheet } from "./CloseChat";
import { DeskScreen } from "./DeskScreen";
import { Deck } from "./NeedsDeck";
import { FocusGlyph, SingleBanner, SingleSheet } from "./SingleProject";
import { Suggestions } from "./Suggestions";
import { UsageSheet } from "./UsageSheet";
import { SettingsGlyph, SettingsSheet } from "./SettingsSheet";

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
  /** On a tablet, the Desk is in the main area: this opens it there (its button sits at the top of the chats). None on a phone. */
  onOpenDesk?: () => void;
  /** On a tablet, the Desk is what the main area shows now. */
  deskShown?: boolean;
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

/** Home as the Desk (every chat at once, and a box that finds the chat) or as the list of chats. */
function ModeSwitch({ value, onChange }: { value: "desk" | "chats"; onChange: (m: "desk" | "chats") => void }) {
  const colors = useColors();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: colors.card, borderRadius: radius.pill, padding: 3, borderWidth: 1, borderColor: colors.rule }}>
      {(["desk", "chats"] as const).map((m) => (
        <PressScale key={m} accessibilityRole="tab" accessibilityState={{ selected: value === m }} onPress={() => onChange(m)} haptic="select" scaleTo={0.94} style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: value === m ? colors.ink : "transparent" }}>
          <Txt variant="small" tone={value === m ? "on-ink" : "ink2"} style={{ fontWeight: "700" }}>
            {m === "desk" ? "Desk" : "Chats"}
          </Txt>
        </PressScale>
      ))}
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

/** How far a project card's header and chats are from its edge. */
const CARD_INSET = 16;

/** What swiping a row does: its tray (open or not, one at a time on the list) and what each button and the pin do. */
interface RowSwipe {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPin: () => void;
  /** Mark read or unread, for a chat that is waiting (others have no such thing). */
  onToggleUnread: (() => void) | null;
  /** Close it (on the Mac too), for a Mac that can. */
  onClose: (() => void) | null;
}

/** `inset`: the space on either side of the row (the page's, unless the row sits in a card that has its own). `background`: what is behind the row (the page, or its card). */
/** Where the open chat is among the rows as drawn (top to bottom), so its bar can travel from one to the next. */
interface Place {
  /** This row's place, the open chat's, and where the open chat was before (-1: none or not in the list). */
  at: number;
  selectedAt: number;
  previousAt: number;
}

/** How long the open chat's bar takes to shrink away, and to grow in (a beat later, so it reads as one bar travelling). */
const BAR_MS = 200;
const BAR_DELAY = 90;
/** How tall the bar is, at most, and how far in from the row's top and bottom it stops. */
const BAR_INSET = 10;

/**
 * The bar down the left of the open chat. It is not drawn again on the next chat, it travels: the one that was open shrinks
 * away toward the chat that is open now, and that one grows in from the side the last one was on. Which side is told by where
 * the rows are (`place`). A row that is open when it first appears just has it.
 */
function OpenBar({ selected, place, color }: { selected: boolean; place: Place; color: string }) {
  const s = useRef(new Animated.Value(selected ? 1 : 0)).current;
  const [h, setH] = useState(0);
  // Which edge it holds to while it grows or shrinks: the side of the chat it came from or goes to.
  const [side, setSide] = useState<"above" | "below" | "middle">("middle");
  const was = useRef(selected);
  useEffect(() => {
    if (was.current === selected) return;
    was.current = selected;
    const other = selected ? place.previousAt : place.selectedAt;
    setSide(other < 0 || place.at < 0 ? "middle" : other < place.at ? "above" : "below");
    s.stopAnimation();
    if (selected) run(s, 1, BAR_MS, undefined, BAR_DELAY);
    else run(s, 0, BAR_MS);
    // Only when it becomes open or stops being open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  const reach = side === "above" ? -h / 2 : side === "below" ? h / 2 : 0;
  return (
    <View accessibilityElementsHidden pointerEvents="none" testID={selected ? "selected-bar" : undefined} onLayout={(e) => setH(e.nativeEvent.layout.height)} style={{ position: "absolute", left: 0, top: BAR_INSET, bottom: BAR_INSET, width: 3 }}>
      <Animated.View style={{ flex: 1, borderRadius: 1.5, backgroundColor: color, opacity: s.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] }), transform: [{ translateY: s.interpolate({ inputRange: [0, 1], outputRange: [reach, 0] }) }, { scaleY: s.interpolate({ inputRange: [0, 1], outputRange: [0.05, 1] }) }] }} />
    </View>
  );
}

function ChatRow({ row, index, onPress, onLongPress, showProject = true, inset = space.xl, selected = false, place = { at: -1, selectedAt: -1, previousAt: -1 }, background, swipe }: { row: Row; index: number; onPress: () => void; onLongPress?: () => void; showProject?: boolean; inset?: number; selected?: boolean; place?: Place; background: string; swipe?: RowSwipe }) {
  const colors = useColors();
  // The tile is the chat's project's colour (the desktop sidebar's), so a chat is placed by it before it is read.
  const { bg, fg } = projectTint(row.projectColor, colors.plainTint);
  const accent = useAccent();
  // The space between the row's own edge and its content.
  const pad = inset > 8 ? inset - 8 : inset;
  const status = row.unread ? ", unread" : row.status === "needs_you" ? ", needs you" : row.status === "working" ? ", working" : row.status === "asleep" ? ", asleep" : row.status === "ended" ? ", stopped" : "";
  const body = (
    <PressScale accessibilityRole="button" accessibilityLabel={`${row.title}, ${row.provider ?? "Claude"}${showProject && row.project ? `, ${row.project}` : ""}${status}${row.pinned ? ", pinned" : ""}${row.preview ? `, ${row.preview}` : ""}`} accessibilityState={{ selected }} onPress={onPress} onLongPress={onLongPress} accessibilityActions={onLongPress ? [{ name: "longpress", label: "More actions: pin, mark read, close" }] : undefined} onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && onLongPress?.()} haptic="none" scaleTo={0.975} opacity={row.status === "asleep" ? 0.7 : 1} style={[{ flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: inset > 8 ? 8 : 0, paddingHorizontal: pad, paddingVertical: 9, minHeight: 56 }]}>
      {/* The chat you are in: a bar of the accent down the row's left, which travels to the next chat you open. */}
      <OpenBar selected={selected} place={place} color={accent} />
      <View>
        <Tile letter={row.initial} bg={bg} fg={fg} />
        {/* Something new in it: a dot on the tile (cut out from the page behind it), and the title in bold below. */}
        {row.unread && <View accessibilityElementsHidden testID="unread-dot" style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: 7, backgroundColor: accent, borderWidth: 2, borderColor: background }} />}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {row.pinned && <PinIcon />}
          <Txt variant="body" numberOfLines={1} style={{ flexShrink: 1, fontWeight: row.unread ? "800" : "400" }}>
            {row.title}
          </Txt>
        </View>
        {/* What it is doing, or last said (a Mac that doesn't say leaves the row as it was). */}
        {!!row.preview && (
          <Txt variant="small" tone="ink2" numberOfLines={1} style={{ marginTop: 1 }}>
            {row.preview}
          </Txt>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 3 }}>
          {showProject && !!row.project && <ProjectTag name={row.project} color={row.projectColor} />}
          <ProviderBadge provider={row.provider} />
        </View>
      </View>
      {row.status === "working" ? (
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <Working />
          {!!row.elapsed && (
            <Txt variant="tiny" tone="ink3">
              {row.elapsed}
            </Txt>
          )}
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {row.status === "needs_you" && <PulseDot color={colors.hi} />}
          <Txt variant="tiny" tone={row.unread ? "ink" : "ink3"} style={row.unread ? { fontWeight: "700" } : undefined}>
            {row.note}
          </Txt>
        </View>
      )}
    </PressScale>
  );
  return (
    // A row glides to its new place when the list reorders; the rows come in one after the other when Home opens (and a new chat
    // comes in alone); a press gives under the finger.
    <Glide>
      <FadeSlideIn from={14} delay={Math.min(index, 8) * 45 + 120}>
        {swipe ? (
          <SwipeRow
            background={background}
            open={swipe.open}
            onOpenChange={swipe.onOpenChange}
            pin={{ label: row.pinned ? "Unpin" : "Pin", onTrigger: swipe.onPin }}
            tray={[...(swipe.onToggleUnread ? [{ key: "read", label: row.unread ? "Read" : "Unread", onPress: swipe.onToggleUnread }] : []), ...(swipe.onClose ? [{ key: "close", label: "Close", tone: "danger" as const, onPress: swipe.onClose }] : [])]}
          >
            {body}
          </SwipeRow>
        ) : (
          body
        )}
      </FadeSlideIn>
    </Glide>
  );
}

/** A quiet label over a stretch of the list ("Waiting on you", "Earlier"). */
function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingHorizontal: space.xl, paddingTop: 14, paddingBottom: 2 }}>
      <Txt variant="tiny" tone="ink3" style={{ fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>
        {label}
      </Txt>
      <Txt variant="tiny" tone="ink3">
        {count}
      </Txt>
    </View>
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
function ProjectGroup({ group, open, onToggle, onOpenChat, onAskClose, swipeFor, selectedSlot, placeOf }: { group: Group; open: boolean; onToggle: () => void; onOpenChat: HomeProps["onOpenChat"]; onAskClose?: (r: Row) => void; swipeFor: (r: Row) => RowSwipe; selectedSlot?: string | null; placeOf: (slot: string) => Place }) {
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
              <ChatRow row={r} index={i} showProject={false} inset={8} background={colors.card} swipe={swipeFor(r)} selected={r.slot === selectedSlot} place={placeOf(r.slot)} onPress={() => onOpenChat(r.slot)} onLongPress={onAskClose && (() => onAskClose(r))} />
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
export function HomeScreen({ onOpenChat, onReview, onOpenMac, onCompose, onNewChat, onSupport, selectedSlot, pinned = false, onTogglePin, onOpenDesk, deskShown = false }: HomeProps) {
  const colors = useColors();
  const controller = useController();
  const { chats: allChats, workingSince, waiting: allWaiting, chatsLoaded, waitingLoaded, plan, single } = useSyncState();
  // The Mac's One project: only its chats, and what they wait on, are listed (the Desk and search of the past are left as they are).
  const canSingle = useMacCan("single");
  const [picking, setPicking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chats = single ? allChats.filter((c) => c.project === single.name) : allChats;
  const waiting = single ? allWaiting.filter((w) => chats.some((c) => c.slot === w.slot)) : allWaiting;
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
  // The chat whose swipe buttons are out (one at a time), and the search of the list (what is typed narrows it).
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  // How far the page is scrolled: the headline fades and trails as it goes.
  const scrollY = useRef(new Animated.Value(0)).current;
  // The Desk, for a Mac that has one (remembered on this phone; the Desk unless the list was chosen).
  const canDesk = useMacCan("desk");
  const [mode, setMode] = useState<"desk" | "chats">("desk");
  const pickMode = (m: "desk" | "chats") => {
    setMode(m);
    void saveHomeMode(m);
  };
  useEffect(() => {
    let live = true;
    void loadHomeMode().then((m) => live && setMode(m));
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
    // A card folds and unfolds as a height, with what is under it following (asked for by the press itself, so only Home's own layout moves).
    if (!skips()) LayoutAnimation.configureNext(LayoutAnimation.create(220, "easeInEaseOut", "opacity"));
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
  // What is searched for narrows the list; while it is, the rest of Home (what waits on you) steps aside.
  const asked = searching ? query.trim() : "";
  const shown = asked ? list.filter((r) => matches(r, asked)) : list;
  // The rows as drawn, top to bottom (a folded card's are not there): the open chat's bar travels by where they are.
  const order = (grouping === "project" ? groups(shown).filter((g) => !folded.includes(g.project)).flatMap((g) => g.rows) : sections(shown).flatMap((x) => x.rows)).map((r) => r.slot);
  const selectedAt = selectedSlot ? order.indexOf(selectedSlot) : -1;
  // Where the open chat was before this one: set once this render is on the screen.
  const lastAt = useRef(-1);
  const previousAt = lastAt.current;
  useEffect(() => {
    lastAt.current = selectedAt;
  }, [selectedAt]);
  const placeOf = (slot: string): Place => ({ at: order.indexOf(slot), selectedAt, previousAt });

  const swipeFor = (r: Row): RowSwipe => ({
    open: openSlot === r.slot,
    onOpenChange: (o) => setOpenSlot((cur) => (o ? r.slot : cur === r.slot ? null : cur)),
    onPin: () => setPinned(r.slot, !r.pinned),
    onToggleUnread: r.status === "idle" ? () => (r.unread ? markSeen(r.slot, r.activeAt) : markUnread(r.slot)) : null,
    onClose: canClose ? () => setClosing(r) : null,
  });
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const refresh = async () => {
    setRefreshing(true);
    controller.resume();
    await controller.sync.refreshWaiting();
    setRefreshing(false);
  };

  const top = (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.xl, gap: 10 }}>
      <PressScale accessibilityRole="button" accessibilityLabel={macName ? `${macName}, connected` : "Your Mac"} onPress={onOpenMac} hitSlop={10} haptic="select" scaleTo={0.94} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, flexShrink: 1 }}>
        {macName ? <PulseDot color={colors.go} size={8} ms={2600} /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ink3 }} />}
        <Txt variant="small" tone="ink2" numberOfLines={1}>
          {macName ?? "Your Mac"}
        </Txt>
      </PressScale>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        {refreshing && (
          <View accessibilityLabel="Refreshing" accessibilityRole="progressbar" accessible>
            <Dots />
          </View>
        )}
        {canDesk && !onOpenDesk && <ModeSwitch value={mode} onChange={pickMode} />}
        {canSingle && !single && (
          <PressScale accessibilityRole="button" accessibilityLabel="One project" onPress={() => setPicking(true)} hitSlop={12} haptic="select" scaleTo={0.9} style={{ minHeight: 32, justifyContent: "center" }}>
            <FocusGlyph color={colors.ink2} />
          </PressScale>
        )}
        {/* A tablet's chats: beside the chat, or slid in when asked and away once a chat is chosen. */}
        {onTogglePin && (
          <PressScale accessibilityRole="button" accessibilityLabel={pinned ? "Unpin the chats" : "Pin the chats beside the chat"} accessibilityState={{ selected: pinned }} onPress={onTogglePin} hitSlop={12} haptic="select" scaleTo={0.9} style={{ minHeight: 32, justifyContent: "center" }}>
            <PinGlyph pinned={pinned} />
          </PressScale>
        )}
        <PressScale accessibilityRole="button" accessibilityLabel="Settings" onPress={() => setSettingsOpen(true)} hitSlop={12} haptic="select" scaleTo={0.9} style={{ minHeight: 32, justifyContent: "center" }}>
          <SettingsGlyph color={colors.ink2} />
        </PressScale>
      </View>
    </View>
  );

  // A tablet has the Desk in its main area (with the chats here, beside it); a phone has it here, in place of the list.
  const banner = single && <SingleBanner single={single} onShowAll={() => void controller.sync.setSingle(null).catch(() => {})} />;
  if (canDesk && mode === "desk" && !onOpenDesk)
    return (
      <>
        <DeskScreen
          top={
            <>
              {top}
              {banner}
            </>
          }
          onOpenChat={onOpenChat}
          onReview={onReview}
        />
        {picking && <SingleSheet chats={allChats} onDismiss={() => setPicking(false)} />}
        {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      </>
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {/* Pulling down still refreshes, but with no system spinner (it is made clear: the dots under the Mac's name say it is working). */}
      <Animated.ScrollView
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        // Buttons a swipe laid out go back in when the list moves.
        onScrollBeginDrag={() => setOpenSlot(null)}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="transparent" colors={["transparent"]} progressBackgroundColor="transparent" />}
      >
        {top}
        {banner}
        {canDesk && onOpenDesk && (
          <PressScale accessibilityRole="button" accessibilityLabel={stack.length > 0 ? `Desk, ${stack.length} waiting` : "Desk"} accessibilityState={{ selected: deskShown }} onPress={onOpenDesk} haptic="select" scaleTo={0.98} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: space.lg, marginTop: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.inner, backgroundColor: deskShown ? colors.card : "transparent" }}>
            <Txt variant="body" style={{ fontWeight: "700", flex: 1 }}>
              Desk
            </Txt>
            {stack.length > 0 && (
              <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.hi }}>
                <Txt variant="tiny" tone="on-hi" style={{ fontWeight: "700" }}>
                  {stack.length}
                </Txt>
              </View>
            )}
          </PressScale>
        )}
        {plan && <UsageStrip plan={plan} onPress={() => setUsageOpen(true)} />}
        {/* Until the Mac has sent what it has, the shape of it: "nothing waiting" would be a guess. */}
        {loading ? (
          <HomeSkeleton />
        ) : (
          <>
        {!asked && (
          <>
            {/* The headline fades and trails behind as the page scrolls up over it. */}
            <Animated.View accessibilityRole="header" style={{ paddingHorizontal: space.xl, paddingTop: 14, paddingBottom: 16, opacity: scrollY.interpolate({ inputRange: [0, 110], outputRange: [1, 0.2], extrapolate: "clamp" }), transform: [{ translateY: scrollY.interpolate({ inputRange: [0, 130], outputRange: [0, 40], extrapolate: "clamp" }) }] }}>
              <Txt variant="headline">{head.big}</Txt>
              <Txt variant="headline" tone="ink3">
                {head.small}
              </Txt>
            </Animated.View>

            {stack.length > 0 && <Deck list={stack} onOpenChat={onOpenChat} onReview={onReview} />}
            {/* Nothing waits: Claude suggests what to do next (starting something of your own is "New chat", below). */}
            {/* Not with One project: a suggestion can be about any project. */}
            {stack.length === 0 && macName && !single && <Suggestions onPick={onNewChat} />}
            {stack.length > 1 && (
              <Txt variant="small" tone="ink2" style={{ paddingHorizontal: space.xl, paddingTop: 2 }}>
                {stack.length - 1} more after this one
              </Txt>
            )}
          </>
        )}

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.xl, paddingTop: asked ? 14 : 22, paddingBottom: 6 }}>
          <Txt variant="small" style={{ fontWeight: "700" }}>
            {asked ? "Results" : "All chats"}
          </Txt>
          {list.length > 1 && <GroupingSwitch value={grouping} onChange={group} />}
          <PressScale accessibilityRole="button" accessibilityLabel="New chat" onPress={() => (single ? onNewChat({ text: "", project: single.project }) : onNewChat())} hitSlop={8} scaleTo={0.92} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule }}>
            <Txt variant="small" style={{ fontWeight: "700" }}>
              + New chat
            </Txt>
          </PressScale>
        </View>
        {list.length === 0 ? (
          <View style={{ alignItems: "center", paddingHorizontal: space.xxl, paddingTop: 36, paddingBottom: 12 }}>
            <View style={{ transform: [{ scale: 0.75 }], marginBottom: 6 }}>
              <DarkLantern />
            </View>
            <Txt variant="heading" style={{ textAlign: "center" }}>
              Quiet in here
            </Txt>
            <Txt variant="body" tone="ink2" style={{ textAlign: "center", marginTop: 6 }}>
              {single ? `Nothing is open in ${single.name}. Start a chat there and it shows up here.` : "No chats are open on your Mac. Start one in Lantern and it shows up here."}
            </Txt>
          </View>
        ) : shown.length === 0 ? (
          <View accessibilityLiveRegion="polite" style={{ alignItems: "center", paddingHorizontal: space.xxl, paddingTop: 36 }}>
            <Txt variant="heading" style={{ textAlign: "center" }}>
              No chat says that
            </Txt>
            <Txt variant="body" tone="ink2" style={{ textAlign: "center", marginTop: 6 }}>
              Search looks at the title, the project and the line under it.
            </Txt>
          </View>
        ) : grouping === "project" ? (
          groups(shown).map((g) => <ProjectGroup key={g.project} group={g} open={!folded.includes(g.project)} onToggle={() => toggle(g.project)} onOpenChat={onOpenChat} onAskClose={setActing} swipeFor={swipeFor} selectedSlot={selectedSlot} placeOf={placeOf} />)
        ) : (
          // Labelled stretches (Pinned, Waiting on you, Working, Earlier, Asleep) once there is more than one of them.
          (() => {
            const parts = sections(shown);
            let n = 0;
            return parts.map((s) => (
              <Fragment key={s.key}>
                {parts.length > 1 && <SectionLabel label={s.label} count={s.rows.length} />}
                {s.rows.map((r) => (
                  <ChatRow key={r.slot} row={r} index={n++} background={colors.paper} swipe={swipeFor(r)} selected={r.slot === selectedSlot} place={placeOf(r.slot)} onPress={() => onOpenChat(r.slot)} onLongPress={() => setActing(r)} />
                ))}
              </Fragment>
            ));
          })()
        )}
        {!asked && <SupportCard onPress={onSupport} />}
          </>
        )}
      </Animated.ScrollView>
      {/* The search circle: for a list long enough to need it (a few chats are all in view anyway), and whenever a search is going. */}
      {!loading && (list.length >= 4 || searching) && <HomeSearch active={searching} query={query} found={shown.length} lift={Platform.OS === "android" && list.length > 0 ? 70 : 0} onOpen={() => setSearching(true)} onChange={setQuery} onClose={closeSearch} />}
      {picking && <SingleSheet chats={allChats} onDismiss={() => setPicking(false)} />}
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
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
