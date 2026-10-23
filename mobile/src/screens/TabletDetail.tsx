import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { space, useColors } from "../ui/theme";
import { COLUMN_MAX } from "../view/layout";
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
  onBack: () => void;
  onReview: (slot: string, requestId: string) => void;
}

/** What a tablet shows beside the chats: the chat they picked, in a column that reads well, or a word to pick one. */
export function TabletDetail({ slot, decide, layout, onShowChats, onBack, onReview }: TabletDetailProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
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
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <View style={{ flex: 1, width: "100%", maxWidth: COLUMN_MAX, alignSelf: "center" }}>
        {/* Keyed by the chat: another chat is a new screen, which follows its own events and keeps nothing of the last one's. */}
        <ChatScreen key={slot} slot={slot} lead={layout === "split" ? "none" : "sidebar"} onSidebar={onShowChats} onBack={onBack} onReview={(requestId) => onReview(slot, requestId)} />
      </View>
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
