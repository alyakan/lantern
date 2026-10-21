import { useEffect, useRef, useState } from "react";
import { Animated, Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionState, useController, useSyncState } from "../shell/hooks";
import { Button, Tag, Tile, Txt } from "../ui/components";
import { FadeSlideIn, PressScale, PulseDot } from "../ui/motion";
import { Dots, HomeSkeleton } from "../ui/skeleton";
import { colors, radius, shadow, space } from "../ui/theme";
import { cards, headline, rows, tileColors, type Card, type Row } from "../view/home";
import type { Draft } from "./NewChatSheet";
import { Suggestions } from "./Suggestions";

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
}

/** A thin bar that slides while a chat is working. */
function Working() {
  const x = useRef(new Animated.Value(-1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(x, { toValue: 2.5, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [x]);
  return (
    <View accessibilityLabel="Working" style={{ width: 54, height: 4, borderRadius: 2, backgroundColor: colors.rule, overflow: "hidden" }}>
      <Animated.View style={{ width: "40%", height: "100%", backgroundColor: colors.cobalt, borderRadius: 2, transform: [{ translateX: Animated.multiply(x, 22) }] }} />
    </View>
  );
}

function Deck({ list, onOpenChat, onReview }: { list: Card[]; onOpenChat: HomeProps["onOpenChat"]; onReview: HomeProps["onReview"] }) {
  const front = list[0];
  const behind = Math.min(2, list.length - 1);
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
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button label="Open chat" kind="ghost" style={{ flex: 1 }} onPress={() => onOpenChat(front.waiting.slot)} />
          <Button label="Review" style={{ flex: 1 }} onPress={() => onReview(front.waiting.slot, front.waiting.request_id)} />
        </View>
      </FadeSlideIn>
    </View>
  );
}

function ChatRow({ row, index, onPress }: { row: Row; index: number; onPress: () => void }) {
  const [bg, fg] = tileColors(row.title);
  const status = row.status === "needs_you" ? ", needs you" : row.status === "working" ? ", working" : row.status === "asleep" ? ", asleep" : row.status === "ended" ? ", stopped" : "";
  return (
    // The rows come in one after the other when Home opens (and a new chat comes in alone); a press gives under the finger.
    <FadeSlideIn from={14} delay={Math.min(index, 8) * 45 + 120}>
    <PressScale accessibilityRole="button" accessibilityLabel={`${row.title}${row.project ? `, ${row.project}` : ""}${status}`} onPress={onPress} haptic="none" scaleTo={0.975} opacity={row.status === "asleep" ? 0.7 : 1} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: space.xl, paddingVertical: 9, minHeight: 56 }}>
      <Tile letter={row.initial} bg={bg} fg={fg} />
      <View style={{ flex: 1 }}>
        <Txt variant="body" numberOfLines={1} style={{ fontWeight: "600" }}>
          {row.title}
        </Txt>
        {!!row.project && (
          <Txt variant="small" tone="ink2" numberOfLines={1}>
            {row.project}
          </Txt>
        )}
      </View>
      {row.status === "working" ? (
        <Working />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {row.status === "needs_you" && <PulseDot color={colors.hi} />}
          <Txt variant="tiny" tone="ink3">
            {row.note}
          </Txt>
        </View>
      )}
    </PressScale>
    </FadeSlideIn>
  );
}

/** Home: what waits on you, as a headline and a stack, then your chats. */
export function HomeScreen({ onOpenChat, onReview, onOpenMac, onCompose, onNewChat }: HomeProps) {
  const controller = useController();
  const { chats, waiting, chatsLoaded, waitingLoaded } = useSyncState();
  const loading = !chatsLoaded || !waitingLoaded;
  const connection = useConnectionState();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const stack = cards(waiting, chats);
  const head = headline(stack.length);
  const list = rows(chats, now);
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
          {refreshing && (
            <View accessibilityLabel="Refreshing" accessibilityRole="progressbar" accessible>
              <Dots />
            </View>
          )}
        </View>
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
        ) : (
          list.map((r, i) => <ChatRow key={r.slot} row={r} index={i} onPress={() => onOpenChat(r.slot)} />)
        )}
          </>
        )}
      </ScrollView>
      {Platform.OS === "android" && list.length > 0 && (
        <PressScale accessibilityRole="button" accessibilityLabel="Message a chat" onPress={onCompose} scaleTo={0.92} style={[{ position: "absolute", right: 18, bottom: insets.bottom + 18, backgroundColor: colors.ink, borderRadius: 18, paddingHorizontal: 18, minHeight: 52, flexDirection: "row", alignItems: "center", gap: 8 }, shadow.float]}>
          <Txt variant="body" tone="white" style={{ fontWeight: "700" }}>
            + Message a chat
          </Txt>
        </PressScale>
      )}
    </View>
  );
}
