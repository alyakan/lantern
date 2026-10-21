import { memo, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Item } from "../sync/reducer";
import { Button, Chip, Tag, Txt } from "../ui/components";
import { useKeyboardUp } from "../ui/keyboard";
import { Markdown } from "../ui/Markdown";
import { bounce, buzz, PopIn, PressScale, skips } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { colors, fonts, radius, shadow, space } from "../ui/theme";
import { promptView } from "../view/prompts";
import { turnLine, type Row, type StepChip } from "../view/timeline";
import type { PageAction } from "../view/pages";

/** "22:09": a message's time, in the phone's own way of writing it. */
export const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type UserItem = Extract<Item, { kind: "user" }>;

export const UserRow = memo(function UserRow({ item }: { item: UserItem }) {
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12, alignItems: "flex-start" }}>
      {item.at !== null && (
        <Txt variant="tiny" tone="ink3" style={{ marginBottom: 4, marginLeft: 2 }}>
          {timeOf(item.at)}
        </Txt>
      )}
      <View accessibilityLabel={`You: ${item.text}`} style={{ backgroundColor: colors.ink, borderRadius: 18, borderBottomLeftRadius: 6, paddingHorizontal: 13, paddingVertical: 9, maxWidth: "90%", opacity: item.sending ? 0.6 : 1 }}>
        <Txt variant="body" tone="white">
          {item.text}
        </Txt>
      </View>
      {item.failed && (
        <Txt variant="small" tone="stop" style={{ marginTop: 4, marginLeft: 2 }}>
          Not sent. {item.failed}
        </Txt>
      )}
    </View>
  );
});

export const AssistantRow = memo(function AssistantRow({ item }: { item: Extract<Item, { kind: "assistant" }> }) {
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <Markdown text={item.text} />
    </View>
  );
});

export const StepsRow = memo(function StepsRow({ chips, onFiles }: { chips: StepChip[]; onFiles: (files: string[]) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.lg, paddingTop: 10 }}>
      {chips.map((c) => (
        <Chip key={c.key} tone={c.tone} onPress={c.files ? () => onFiles(c.files!) : undefined}>
          {c.label}
        </Chip>
      ))}
    </View>
  );
});

/** A Step-by-step page: its heading as a card, the start of it, and (while it is the live one) its buttons. */
export const PageRow = memo(function PageRow({ row, answered, onAction }: { row: Extract<Row, { kind: "page" }>; answered: boolean; onAction: (a: PageAction) => void }) {
  const [open, setOpen] = useState(false);
  const { page } = row;
  const body = open || page.body.length < 260 ? page.body : `${page.body.slice(0, 240).trimEnd()}…`;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <View style={[{ backgroundColor: colors.card, borderRadius: 18, padding: 14, gap: 6 }, shadow.card, { shadowOpacity: 0.06 }]}>
        <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
          {page.kicker}
        </Txt>
        <Txt variant="heading">{page.title}</Txt>
        {!!body && <Markdown text={body} />}
        {page.body.length >= 260 && (
          <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} hitSlop={8}>
            <Txt variant="small" tone="cobalt">
              {open ? "Show less" : "Show the whole page"}
            </Txt>
          </Pressable>
        )}
        {row.live && !answered && page.actions.length > 0 && (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
            {page.actions.map((a) => (
              <Button key={a.label} label={a.label} kind={a.primary ? "ink" : "ghost"} style={{ flex: 1 }} onPress={() => onAction(a)} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
});

/** Who answered a prompt, in words: you, the Mac, or another phone. */
export function answeredBy(by: string | null, me: string | null): string {
  if (by === "desktop") return "on your Mac";
  if (by && me && by === me) return "from this phone";
  if (by?.startsWith("phone-")) return "on another phone";
  return "";
}

export const PromptRow = memo(function PromptRow({ item, me, onReview }: { item: Extract<Item, { kind: "prompt" }>; me: string | null; onReview: () => void }) {
  const view = promptView(item.toolName, item.input);
  if (item.state === "open") {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
        <View style={{ backgroundColor: colors.hiSoft, borderColor: colors.hi, borderWidth: 1.5, borderRadius: 18, padding: 14, gap: 6 }}>
          <Tag>{view.tag}</Tag>
          <Txt variant="heading">{view.title}</Txt>
          {view.detail && (
            <Txt variant="mono" numberOfLines={2}>
              {view.detail}
            </Txt>
          )}
          <Button label="Review" style={{ marginTop: 6 }} onPress={onReview} />
        </View>
      </View>
    );
  }
  const text = item.state === "withdrawn" ? "Claude stopped asking" : `${item.state === "allowed" ? (view.kind === "question" ? "Answered" : "Allowed") : view.kind === "question" ? "Declined" : "Denied"} ${answeredBy(item.by, me)}`.trim();
  // A question this phone answered says with what, as a chip beneath it: the answer itself, not how it was sent.
  if (item.answer && item.state === "allowed") {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingTop: 10, alignItems: "flex-start", gap: 4 }}>
        <Txt variant="small" tone="ink2">
          {view.title.replace(/\?$/, "")}
        </Txt>
        <PopIn>
          <View style={{ backgroundColor: colors.card, borderColor: colors.go, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View accessibilityElementsHidden style={{ width: 10, height: 6, marginTop: -2, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.go, transform: [{ rotate: "-45deg" }] }} />
            <Txt variant="small" style={{ fontWeight: "700" }}>
              {item.answer}
            </Txt>
          </View>
        </PopIn>
      </View>
    );
  }
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 10 }}>
      <Txt variant="small" tone="ink2">
        {view.title.replace(/\?$/, "")}: {text}
      </Txt>
    </View>
  );
});

export const DesktopRow = memo(function DesktopRow({ item }: { item: Extract<Item, { kind: "desktop" }> }) {
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <View style={{ backgroundColor: colors.card, borderColor: colors.rule, borderWidth: 1, borderRadius: 14, padding: 12, gap: 2 }}>
        <Txt variant="small" style={{ fontWeight: "700" }}>
          Answer this on your Mac
        </Txt>
        <Txt variant="small" tone="ink2">
          {item.what}
        </Txt>
      </View>
    </View>
  );
});

export const TurnRow = memo(function TurnRow({ item }: { item: Extract<Item, { kind: "turn" }> }) {
  const line = turnLine(item);
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 8 }}>
      <Txt variant="tiny" tone={line.bad ? "stop" : "ink3"}>
        {line.text}
      </Txt>
    </View>
  );
});

/** The message box: a capsule with a send button; typing and sending only while connected. */
export function Composer({ onSend, disabled, placeholder = "Message Claude" }: { onSend: (text: string) => void; disabled?: boolean; placeholder?: string }) {
  const [text, setText] = useState("");
  const insets = useSafeAreaInsets();
  // With the keyboard up it sits right under the box: the home-indicator space would be a gap.
  const keyboard = useKeyboardUp();
  const ready = text.trim().length > 0 && !disabled;
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 12), backgroundColor: colors.paper }}>
      <View style={[{ flexDirection: "row", alignItems: "flex-end", gap: 8, backgroundColor: colors.card, borderRadius: 26, paddingLeft: 16, paddingRight: 6, paddingVertical: 6 }, shadow.float, { shadowOpacity: 0.12 }]}>
        <TextInput
          accessibilityLabel="Message"
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.ink3}
          multiline
          editable={!disabled}
          style={{ flex: 1, maxHeight: 120, minHeight: 36, fontSize: 15, color: colors.ink, paddingTop: 8, paddingBottom: 8 }}
        />
        <SendButton
          ready={ready}
          onPress={() => {
            onSend(text.trim());
            setText("");
          }}
        />
      </View>
    </View>
  );
}

/**
 * The send button: grey until there is something to send, then it takes its colour with a little spring; pressing it
 * sends the arrow up and out, and a fresh one rises into place.
 */
function SendButton({ ready, onPress }: { ready: boolean; onPress: () => void }) {
  const tint = useRef(new Animated.Value(ready ? 1 : 0)).current;
  const spring = useRef(new Animated.Value(1)).current;
  const fly = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (skips()) tint.setValue(ready ? 1 : 0);
    else Animated.timing(tint, { toValue: ready ? 1 : 0, duration: 180, useNativeDriver: false }).start();
    // Becoming ready is a small event: the button pops.
    if (!first.current && ready) {
      spring.setValue(0.8);
      bounce(spring, 1, { bounciness: 18 });
    }
    first.current = false;
  }, [ready, tint, spring]);
  const send = () => {
    buzz("light");
    if (!skips()) {
      Animated.sequence([
        Animated.timing(fly, { toValue: 1, duration: 130, useNativeDriver: true }),
        Animated.timing(fly, { toValue: -1, duration: 0, useNativeDriver: true }),
        Animated.timing(fly, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    onPress();
  };
  return (
    <Animated.View style={{ transform: [{ scale: spring }] }}>
      <PressScale accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !ready }} disabled={!ready} onPress={send} haptic="none" scaleTo={0.88} style={{ width: 40, height: 40, borderRadius: 20, overflow: "hidden" }}>
        <Animated.View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: tint.interpolate({ inputRange: [0, 1], outputRange: [colors.rule, colors.cobalt] }) }}>
          <Animated.View style={{ opacity: fly.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0] }), transform: [{ translateY: fly.interpolate({ inputRange: [-1, 0, 1], outputRange: [22, 0, -22] }) }] }}>
            <Txt variant="heading" tone="white">
              ↑
            </Txt>
          </Animated.View>
        </Animated.View>
      </PressScale>
    </Animated.View>
  );
}

/** A file's diff, as a sheet: pick one of the files an edit chip stands for, and read its lines. */
export function DiffSheet({ files, load, onClose }: { files: string[]; load: (path: string) => Promise<string>; onClose: () => void }) {
  const [path, setPath] = useState(files[0]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    load(path).then(
      (t) => live && setText(t),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [path, load]);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ flexShrink: 1, backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: insets.bottom + 8 }}>
          <View style={{ padding: space.lg, gap: 8 }}>
            <Txt variant="heading">What changed</Txt>
            {files.length > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {files.map((f) => (
                  <Chip key={f} tone={f === path ? "ok" : "plain"} onPress={() => setPath(f)}>
                    {f.split("/").pop() ?? f}
                  </Chip>
                ))}
              </ScrollView>
            )}
            <Txt variant="small" tone="ink2" numberOfLines={1}>
              {path}
            </Txt>
          </View>
          <ScrollView style={{ flexShrink: 1, paddingHorizontal: space.lg }}>
            {text === null && !error && <ActivityIndicator style={{ margin: 24 }} />}
            {error && <Txt tone="stop">{error}</Txt>}
            {text !== null &&
              text.split("\n").map((line, i) => (
                <Txt key={i} variant="mono" style={{ fontFamily: fonts.mono, color: line.startsWith("+") && !line.startsWith("+++") ? colors.go : line.startsWith("-") && !line.startsWith("---") ? colors.stop : colors.ink2 }}>
                  {line || " "}
                </Txt>
              ))}
          </ScrollView>
          <View style={{ padding: space.lg }}>
            <Button label="Close" kind="ghost" onPress={close} />
          </View>
        </View>
      )}
    </Sheet>
  );
}
