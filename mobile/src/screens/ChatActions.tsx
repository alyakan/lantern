import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { space, useColors } from "../ui/theme";

export interface ChatActionsProps {
  title: string;
  project: string;
  pinned: boolean;
  /** Idle chats can be marked read or unread; the rest say what they are doing already. */
  unread: boolean | null;
  /** Closing needs a Mac that can; null when it cannot. */
  onClose: (() => void) | null;
  onTogglePin: () => void;
  onToggleUnread: (() => void) | null;
  onDismiss: () => void;
}

/** What can be done with a chat held down on Home: pin it to the top, mark it read or unread, close it. */
export function ChatActionsSheet({ title, project, pinned, unread, onClose, onTogglePin, onToggleUnread, onDismiss }: ChatActionsProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onDismiss}>
      {(close) => (
        <View style={[{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 8 }]}>
          <Txt variant="heading" numberOfLines={1} accessibilityRole="header">
            {title}
          </Txt>
          {!!project && (
            <Txt variant="small" tone="ink2" numberOfLines={1} style={{ marginBottom: 6 }}>
              {project}
            </Txt>
          )}
          <Button
            label={pinned ? "Unpin from the top" : "Pin to the top"}
            kind="ghost"
            onPress={() => {
              onTogglePin();
              close();
            }}
          />
          {onToggleUnread && unread !== null && (
            <Button
              label={unread ? "Mark as read" : "Mark as unread"}
              kind="ghost"
              onPress={() => {
                onToggleUnread();
                close();
              }}
            />
          )}
          {onClose && (
            <Button
              label="Close chat…"
              kind="ghost"
              style={{ borderColor: colors.stop }}
              onPress={() => {
                // The question comes in once this sheet has gone: one sheet at a time.
                close();
                setTimeout(onClose, 250);
              }}
            />
          )}
          <Button label="Cancel" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
