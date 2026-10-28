import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { space, useColors } from "../ui/theme";
import { useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { PressScale } from "../ui/motion";
import { changedFiles } from "../view/changes";
import { CHANGES_WIDTH, COLUMN_MAX, hasRoomForChanges } from "../view/layout";
import { ChangesPane } from "./ChangesPane";
import { ChatScreen } from "./ChatScreen";
import { DecideScreen } from "./DecideScreen";

/** The widest a decision goes: it is a card to read and swipe, not a page. */
const DECISION_MAX = 560;

export interface TabletDetailProps {
  /** The chat to show; none asks to pick one. */
  slot: string | null;
  /** The prompt being decided in that chat, shown over it. */
  decide: { slot: string; requestId: string } | null;
  /** Whether the chats are beside the chat ("split") or slide in over it ("overlay"). */
  layout: "overlay" | "split";
  onShowChats: () => void;
  /** Takes the chats away from beside the chat, so the chat has the whole width. */
  onHideChats: () => void;
  onBack: () => void;
  onReview: (slot: string, requestId: string) => void;
}

/** What a tablet shows beside the chats: the chat they picked, in a column that reads well, or a word to pick one. */
export function TabletDetail({ slot, decide, layout, onShowChats, onHideChats, onBack, onReview }: TabletDetailProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { views } = useSyncState();
  // On a window wide enough, the files the chat has changed are beside it, and a button brings the pane back once hidden.
  const [changesOpen, setChangesOpen] = useState(true);
  const changed = slot ? changedFiles((views[slot] ?? emptyView).items) : [];
  const room = hasRoomForChanges(layout, width) && changed.length > 0;
  if (!slot) {
    return (
      <View testID="pick-a-chat" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, paddingTop: insets.top, gap: 12 }}>
        <Txt variant="heading">Pick a chat</Txt>
        <Txt variant="body" tone="ink2" style={{ textAlign: "center" }}>
          {layout === "split" ? "Choose one from the list, or start a new one." : "Open the list of chats, then choose one or start a new one."}
        </Txt>
        {layout === "overlay" && <Button label="Show chats" onPress={onShowChats} />}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, flexDirection: "row" }}>
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1, width: "100%", maxWidth: COLUMN_MAX, alignSelf: "center" }}>
          {/* Keyed by the chat: another chat is a new screen, which follows its own events and keeps nothing of the last one's. */}
          <ChatScreen key={slot} slot={slot} changesButton={!room} lead={layout === "split" ? "hide" : "sidebar"} onSidebar={layout === "split" ? onHideChats : onShowChats} onBack={onBack} onReview={(requestId) => onReview(slot, requestId)} />
        </View>
        {room && !changesOpen && (
          <PressScale accessibilityRole="button" accessibilityLabel={`Show the ${changed.length} changed ${changed.length === 1 ? "file" : "files"}`} onPress={() => setChangesOpen(true)} haptic="select" scaleTo={0.94} style={{ position: "absolute", top: insets.top + 8, right: 16, height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule, justifyContent: "center" }}>
            <Txt variant="small" style={{ fontWeight: "700" }}>
              Changes · {changed.length}
            </Txt>
          </PressScale>
        )}
      </View>
      {room && changesOpen && (
        <View style={{ width: CHANGES_WIDTH, borderLeftWidth: 1, borderLeftColor: colors.rule }}>
          <ChangesPane key={slot} slot={slot} onHide={() => setChangesOpen(false)} />
        </View>
      )}
      {decide && (
        <View testID="decision-pane" style={[StyleSheet.absoluteFill, { backgroundColor: colors.night }]}>
          <View style={{ flex: 1, width: "100%", maxWidth: DECISION_MAX, alignSelf: "center" }}>
            <DecideScreen key={decide.requestId} slot={decide.slot} requestId={decide.requestId} onClose={onBack} />
          </View>
        </View>
      )}
    </View>
  );
}
