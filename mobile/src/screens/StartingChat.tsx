import { ScrollView, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSyncState } from "../shell/hooks";
import { useLayout } from "../shell/useLayout";
import type { ChatStart, Item } from "../sync/reducer";
import { BackButton } from "../ui/BackButton";
import { BAR_TEXT_SCALE, Button, ProjectTag, Txt } from "../ui/components";
import { Glass } from "../ui/Glass";
import { Dots } from "../ui/skeleton";
import { control, space, useColors } from "../ui/theme";
import { TOP_BAR_GAP, TOP_BAR_HEIGHT } from "../ui/TopBar";
import { projectColorOf } from "../view/home";
import { gutterFor } from "../view/layout";
import { barRoom, KEYBOARD_GAP } from "../ui/keyboard";
import { Composer, UserRow } from "./ChatParts";

/**
 * A chat this phone has asked the Mac to start, open at once: its project, the first message (sending), a word that the Mac is
 * starting it, and the chat's message box. It becomes the chat itself when the Mac has made it: what was sent from here meanwhile
 * goes after the first message, and what was typed and not sent stays in the box. If the Mac couldn't make it, the message says
 * why, with Try again (the same start, so never a second chat); Edit message goes back to the New chat sheet with it, and Discard
 * lets it go. Gone back from, it stays in the chats as a row until it is a chat or let go.
 */
export function StartingChat({ start, onBack, onRetry, onEdit, onDiscard, onQueue }: { start: ChatStart; /** None on a tablet, where the chats are beside it. */ onBack?: () => void; onRetry: () => void; onEdit: () => void; onDiscard: () => void; /** A message sent from the box before the chat is there: it goes once it is. */ onQueue: (text: string) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const gutter = gutterFor(useLayout());
  const { chats } = useSyncState();
  const { problem, queued } = start;
  const color = projectColorOf(chats.find((c) => c.project === start.projectName)?.project_color);
  // The message as the chat will show it, sending until the Mac has the chat (or failed, with why, if it didn't).
  const item: Extract<Item, { kind: "user" }> = { kind: "user", id: `start-${start.id}`, text: start.text, at: null, sentBy: null, ...(problem ? { failed: problem } : { sending: true }), ...(start.thumbs.length ? { images: start.thumbs.length, thumbs: start.thumbs } : {}) };
  return (
    <View testID="starting-chat" style={{ flex: 1, backgroundColor: colors.paper }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: insets.top + TOP_BAR_GAP + (TOP_BAR_HEIGHT - control) / 2, paddingHorizontal: gutter, paddingBottom: 10 }}>
        {onBack && <BackButton onPress={onBack} />}
        <Glass style={{ flex: 1, minHeight: control, borderRadius: control / 2, paddingHorizontal: 18, paddingVertical: 2, justifyContent: "center" }}>
          <Txt variant="heading" numberOfLines={1} maxFontSizeMultiplier={BAR_TEXT_SCALE} accessibilityRole="header" style={{ lineHeight: 21 }}>
            New chat
          </Txt>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <ProjectTag name={start.projectName} color={color} />
            <Txt variant="small" tone="ink2" numberOfLines={1} maxFontSizeMultiplier={BAR_TEXT_SCALE} style={{ flexShrink: 1, lineHeight: 16 }}>
              {problem ? "didn't start" : "starting"}
            </Txt>
          </View>
        </Glass>
      </View>
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingVertical: space.md, gap: 12 }}>
        {/* Not sent, with why and Try again, is the message's own line, as a reply that didn't go says it. */}
        <UserRow item={item} showTime={false} onRetry={problem ? onRetry : undefined} />
        {/* Sent from the box meanwhile: they go, in order, once the chat is there. */}
        {queued.map((text, i) => (
          <UserRow key={i} item={{ kind: "user", id: `start-${start.id}-${i}`, text, at: null, sentBy: null, sending: true }} showTime={false} />
        ))}
        <View style={{ paddingHorizontal: gutter, gap: 10, alignItems: "flex-end" }}>
          {problem ? (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button label="Discard" kind="ghost" onPress={onDiscard} accessibilityHint="Lets this message go" />
              <Button label="Edit message" kind="ghost" onPress={onEdit} accessibilityHint="Opens New chat with this message" />
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start" }} accessibilityLiveRegion="polite" accessibilityLabel="Starting the chat on your Mac">
              <Dots />
              <Txt variant="small" tone="ink2">
                Starting on your Mac…
              </Txt>
            </View>
          )}
        </View>
      </ScrollView>
      {/* The chat's own box, there from the start: what is typed is kept for the chat (under this start until the Mac has it). */}
      <KeyboardStickyView offset={{ closed: 0, opened: barRoom(insets.bottom) - KEYBOARD_GAP }}>
        <Composer draftKey={start.id} placeholder="Sends once your chat starts" canAttach={false} onSend={(text) => onQueue(text)} />
      </KeyboardStickyView>
    </View>
  );
}
