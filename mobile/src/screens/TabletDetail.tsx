import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { space, useColors } from "../ui/theme";
import { useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
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
  /** Whether the chats are beside the chat ("split") or away until asked for ("overlay"). */
  layout: "overlay" | "split";
  /** The chats are slid in over the chat: they have a button of their own then, and the chat's is out of sight. */
  chatsOpen: boolean;
  onShowChats: () => void;
  onBack: () => void;
  onReview: (slot: string, requestId: string) => void;
  /** The Done page's "Start something new", on the chat's project (its folder's name). */
  onStartNew?: (project: string | null) => void;
}

/** What a tablet shows beside the chats: the chat they picked, in a column that reads well, or a word to pick one. */
export function TabletDetail({ slot, decide, layout, chatsOpen, onShowChats, onBack, onReview, onStartNew }: TabletDetailProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { views } = useSyncState();
  // With the chats away and the window wide enough, the files the chat has changed are beside it, and the chat's Changes button
  // shows or hides them. Otherwise that button opens them in a sheet over the chat.
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
          <ChatScreen key={slot} slot={slot} changesPane={room ? { shown: changesOpen, onToggle: () => setChangesOpen((o) => !o) } : undefined} lead={layout === "split" ? "none" : "sidebar"} leadHidden={chatsOpen} onSidebar={onShowChats} onBack={onBack} onReview={(requestId) => onReview(slot, requestId)} onStartNew={onStartNew} />
        </View>
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
