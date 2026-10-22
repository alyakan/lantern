import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { radius, shadow, space, useColors } from "../ui/theme";

/**
 * Closing a chat, asked first: it closes on the Mac too (as closing it in the window's sidebar does), and its conversation
 * stays in History there. `why` is a reason it can't be closed now (Claude is busy): the question is replaced by it.
 */
export function CloseChatSheet({ title, why, onConfirm, onClose }: { title: string; why: string | null; onConfirm: () => Promise<void>; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 10 }, shadow.float]}>
          <Txt variant="title" accessibilityRole="header">
            Close this chat?
          </Txt>
          <Txt variant="body" tone="ink2">
            {why ?? `“${title}” closes on your Mac too. Its conversation stays in History there.`}
          </Txt>
          {error && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {error}
            </Txt>
          )}
          {!why && (
            <Button
              label={busy ? "Closing…" : "Close chat"}
              disabled={busy}
              style={{ backgroundColor: colors.stop }}
              onPress={() => {
                setBusy(true);
                setError(null);
                onConfirm().then(close, (e: Error) => {
                  setError(e.message);
                  setBusy(false);
                });
              }}
            />
          )}
          <Button label={why ? "OK" : "Keep it"} kind="ghost" disabled={busy} onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
