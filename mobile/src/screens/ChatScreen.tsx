import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionState, useController, useDeviceId, useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { Button, Txt } from "../ui/components";
import { colors, shadow, space } from "../ui/theme";
import { timeline, type Row } from "../view/timeline";
import type { PageAction } from "../view/pages";
import { AssistantRow, Composer, DesktopRow, DiffSheet, PageRow, PromptRow, StepsRow, TurnRow, UserRow } from "./ChatParts";

export interface ChatProps {
  slot: string;
  onBack: () => void;
  /** Opens the full-screen decision for one of this chat's prompts. */
  onReview: (requestId: string) => void;
}

/** How long "Caught up on 14 events" stays up. */
const BANNER_MS = 4000;

/** A chat, as a timeline with a message box under it. */
export function ChatScreen({ slot, onBack, onReview }: ChatProps) {
  const controller = useController();
  const { sync } = controller;
  const { chats, views } = useSyncState();
  const connection = useConnectionState();
  const me = useDeviceId();
  const insets = useSafeAreaInsets();
  const chat = chats.find((c) => c.slot === slot);
  const view = views[slot] ?? emptyView;
  const rows = useMemo(() => timeline(view.items), [view.items]);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<string[] | null>(null);
  const [banner, setBanner] = useState(false);
  const [waking, setWaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
  const working = chat?.status === "working";
  const loadDiff = useCallback((path: string) => sync.diff(slot, path), [sync, slot]);

  const reply = (id: string, a: PageAction) => {
    setAnswered((s) => new Set(s).add(id));
    if (a.reply) void sync.send(slot, a.reply);
  };
  const fail = (e: unknown) => setProblem((e as Error).message);

  const renderRow = ({ item: row }: { item: Row }) => {
    switch (row.kind) {
      case "user":
        return <UserRow item={row.item} />;
      case "assistant":
        return <AssistantRow item={row.item} />;
      case "page":
        return <PageRow row={row} answered={answered.has(row.item.id)} onAction={(a) => reply(row.item.id, a)} />;
      case "steps":
        return <StepsRow chips={row.chips} onFiles={setFiles} />;
      case "prompt":
        return <PromptRow item={row.item} me={me} onReview={() => onReview(row.item.id)} />;
      case "desktop":
        return <DesktopRow item={row.item} />;
      case "turn":
        return <TurnRow item={row.item} />;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 10 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8} style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" }, shadow.float, { shadowOpacity: 0.08 }]}>
          <View accessibilityElementsHidden style={{ width: 12, height: 12, marginLeft: 4, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: colors.ink, borderRadius: 2, transform: [{ rotate: "45deg" }] }} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Txt variant="heading" numberOfLines={1} accessibilityRole="header">
            {chat?.title?.trim() || "Chat"}
          </Txt>
          <Txt variant="small" tone="ink2" numberOfLines={1}>
            {[chat?.project, asleep ? "asleep" : working ? "working" : null].filter(Boolean).join(", ")}
          </Txt>
        </View>
        {working && (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={() => sync.interrupt(slot).catch(fail)} hitSlop={8} style={{ height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.ink, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: 11, height: 11, borderRadius: 2, backgroundColor: colors.white }} />
            <Txt variant="small" tone="white" style={{ fontWeight: "700" }}>
              Stop
            </Txt>
          </Pressable>
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

      <FlashList
        data={rows}
        renderItem={renderRow}
        keyExtractor={(r) => r.key}
        getItemType={(r) => (r.kind === "page" ? `page-${r.live}` : r.kind)}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true }}
        ListHeaderComponent={
          view.hidden > 0 ? (
            <View style={{ padding: space.lg, alignItems: "center" }}>
              <Button label={`Show earlier messages (${view.hidden} ${view.hidden === 1 ? "turn" : "turns"})`} kind="ghost" onPress={() => sync.loadEarlier(slot).catch(fail)} />
            </View>
          ) : null
        }
        ListFooterComponent={
          working ? (
            <Txt variant="small" tone="ink3" style={{ paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 6 }}>
              Claude is working…
            </Txt>
          ) : (
            <View style={{ height: 8 }} />
          )
        }
        ListEmptyComponent={
          <Txt variant="body" tone="ink2" style={{ padding: space.xl }}>
            {view.resetting || !online ? "Loading this chat…" : "Nothing in this chat yet."}
          </Txt>
        }
      />

      {asleep ? (
        <View style={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16), gap: 6 }}>
          <Txt variant="small" tone="ink2">
            This chat is asleep to save memory. It picks up where it left off.
          </Txt>
          <Button
            label={waking ? "Waking…" : "Wake this chat"}
            disabled={!online || waking}
            onPress={() => {
              setWaking(true);
              sync.wake(slot).catch(fail).finally(() => setWaking(false));
            }}
          />
        </View>
      ) : (
        <Composer disabled={!online} onSend={(text) => void sync.send(slot, text)} />
      )}
      {files && <DiffSheet files={files} load={loadDiff} onClose={() => setFiles(null)} />}
    </View>
  );
}
