import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { Chevron } from "../ui/Chevron";
import { useKeyboardUp } from "../ui/keyboard";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { colors, radius, shadow, space } from "../ui/theme";
import type { Hit } from "../view/chatText";

/** One thing a sheet offers: a row with a name. */
function ActionRow({ label, hint, onPress, tone = "ink" }: { label: string; hint?: string; onPress: () => void; tone?: "ink" | "stop" }) {
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} haptic="select" scaleTo={0.98} style={{ borderRadius: radius.inner, backgroundColor: colors.paper, paddingVertical: 13, paddingHorizontal: 14, gap: 2 }}>
      <Txt variant="body" tone={tone} style={{ fontWeight: "700" }}>
        {label}
      </Txt>
      {hint && (
        <Txt variant="small" tone="ink2">
          {hint}
        </Txt>
      )}
    </PressScale>
  );
}

/**
 * What can be done with a message held down: copy it, quote it in a reply, select part of it, and (your own last one) edit
 * it and send it again. Each does it and closes the sheet.
 */
export function MessageActionsSheet({ text, onQuote, onEdit, onClose }: { text: string; onQuote: () => void; /** Only for your own last message. */ onEdit?: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [selecting, setSelecting] = useState(false);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 8, maxHeight: "100%" }, shadow.float]}>
          {selecting ? (
            <>
              <Txt variant="heading" accessibilityRole="header">
                Select text
              </Txt>
              <ScrollView style={{ maxHeight: 360 }}>
                <Text selectable accessibilityLabel="The message's text" style={{ fontSize: 15, lineHeight: 21, color: colors.ink }}>
                  {text}
                </Text>
              </ScrollView>
              <Button label="Done" kind="ghost" onPress={close} />
            </>
          ) : (
            <>
              <ActionRow
                label="Copy"
                onPress={() => {
                  void Promise.resolve(Clipboard.setStringAsync(text)).catch(() => {});
                  close();
                }}
              />
              <ActionRow
                label="Quote in a reply"
                hint="Puts it in the message box, to answer under it"
                onPress={() => {
                  onQuote();
                  close();
                }}
              />
              <ActionRow label="Select text" hint="Pick just the part you want" onPress={() => setSelecting(true)} />
              {onEdit && (
                <ActionRow
                  label="Edit and send again"
                  hint="Puts it back in the message box"
                  onPress={() => {
                    onEdit();
                    close();
                  }}
                />
              )}
              <Button label="Cancel" kind="ghost" onPress={close} />
            </>
          )}
        </View>
      )}
    </Sheet>
  );
}

/** Looking for something in the chat: type, and the messages that say it come, the newest first; one opens where it is. */
export function ChatSearchSheet({ search, onPick, onClose }: { search: (query: string) => Hit[]; onPick: (hit: Hit) => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardUp();
  const [query, setQuery] = useState("");
  const hits = search(query);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 16) + 8, gap: 10 }, shadow.float]}>
          <Txt variant="heading" accessibilityRole="header">
            Search this chat
          </Txt>
          <TextInput accessibilityLabel="Search" autoFocus value={query} onChangeText={setQuery} placeholder="Words in a message" placeholderTextColor={colors.ink3} autoCorrect={false} autoCapitalize="none" returnKeyType="search" style={{ backgroundColor: colors.paper, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, color: colors.ink }} />
          <ScrollView style={{ maxHeight: 340 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6 }}>
            {query.trim().length >= 2 && hits.length === 0 && (
              <Txt variant="small" tone="ink2">
                Nothing says that in the messages loaded here. Earlier turns are loaded from the top of the chat.
              </Txt>
            )}
            {hits.map((h) => (
              <PressScale
                key={h.key}
                accessibilityRole="button"
                accessibilityLabel={`${h.who}: ${h.before}${h.match}${h.after}`}
                onPress={() => {
                  onPick(h);
                  close();
                }}
                haptic="select"
                scaleTo={0.98}
                style={{ borderRadius: radius.inner, backgroundColor: colors.paper, padding: 11, gap: 3 }}
              >
                <Txt variant="tiny" tone="ink3" style={{ fontWeight: "700" }}>
                  {h.who}
                </Txt>
                <Txt variant="small" numberOfLines={3}>
                  {h.before}
                  <Txt variant="small" style={{ fontWeight: "700", backgroundColor: colors.hiSoft }}>
                    {h.match}
                  </Txt>
                  {h.after}
                </Txt>
              </PressScale>
            ))}
          </ScrollView>
          <Button label="Close" kind="ghost" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}

/** A round button over the chat that takes it to the latest message, with how many came while it was scrolled away. */
export function JumpToBottom({ unseen, onPress }: { unseen: number; onPress: () => void }) {
  return (
    <FadeSlideIn from={8} ms={160} style={{ position: "absolute", right: 14, bottom: 10, alignItems: "flex-end", gap: 6 }}>
      {unseen > 0 && (
        <View accessibilityElementsHidden style={{ backgroundColor: colors.ink, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 }}>
          <Txt variant="tiny" tone="white" style={{ fontWeight: "700" }}>
            {unseen} new
          </Txt>
        </View>
      )}
      <PressScale accessibilityRole="button" accessibilityLabel={unseen > 0 ? `Jump to the latest, ${unseen} new` : "Jump to the latest"} onPress={onPress} haptic="light" scaleTo={0.9} style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" }, shadow.float, { shadowOpacity: 0.16 }]}>
        <View style={{ transform: [{ rotate: "90deg" }] }}>
          <Chevron open={false} color={colors.ink} />
        </View>
      </PressScale>
    </FadeSlideIn>
  );
}

/** Answers Claude's yes-or-no question asks for, one press each; they go as a message and are gone. */
export function QuickReplies({ replies, onSend }: { replies: string[]; onSend: (text: string) => void }) {
  return (
    <View accessibilityLabel="Quick replies" style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 6 }}>
      {replies.map((r, i) => (
        <FadeSlideIn key={r} from={8} delay={i * 50} ms={180}>
          <PressScale accessibilityRole="button" accessibilityLabel={`Reply: ${r}`} onPress={() => onSend(r)} haptic="select" scaleTo={0.94} style={{ backgroundColor: colors.card, borderColor: colors.rule, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 9 }}>
            <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
              {r}
            </Txt>
          </PressScale>
        </FadeSlideIn>
      ))}
    </View>
  );
}

/** The height of the chat's scrolled position from its end, from a scroll event: how far from the latest message it is. */
export function distanceFromEnd(e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }): number {
  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
  return Math.max(0, contentSize.height - (contentOffset.y + layoutMeasurement.height));
}

/** Where a seed for the message box came from: a new one each time replaces nothing already typed unless it says so. */
export interface ComposeSeed {
  id: number;
  text: string;
  /** Add to what is typed (a quote), or replace it (an edit). */
  mode: "append" | "replace";
}

export function useSeed(seed: ComposeSeed | undefined, apply: (seed: ComposeSeed) => void) {
  const last = useRef(0);
  useEffect(() => {
    if (seed && seed.id !== last.current) {
      last.current = seed.id;
      apply(seed);
    }
  }, [seed, apply]);
}
