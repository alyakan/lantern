import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import { useController } from "../shell/hooks";
import { Button, Txt } from "../ui/components";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { colors, radius, shadow, space } from "../ui/theme";

export interface NewChatProps {
  /** A draft to start from (a suggestion's), which the user may change. */
  initialText?: string;
  /** The project to start in (a suggestion's), when the Mac lists it. */
  initialProject?: string;
  onClose: () => void;
  /** The chat was started on the Mac: its slot. */
  onStarted: (slot: string) => void;
}

/**
 * Starting a chat from the phone: which project, and what to start with. It starts on Ask, so Claude asks before it
 * runs anything, and the questions come to this phone like any other. Only a project the user already works in on the
 * Mac is offered (the Mac decides, whatever is sent).
 */
export function NewChatSheet({ initialText = "", initialProject, onClose, onStarted }: NewChatProps) {
  const { sync } = useController();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState<string | null>(initialProject ?? null);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    sync.projects().then(
      (list) => {
        if (!live) return;
        setProjects(list);
        setProject((now) => (now && list.some((p) => p.id === now) ? now : (list[0]?.id ?? null)));
      },
      (e: Error) => {
        if (!live) return;
        setProjects([]);
        setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [sync]);

  const ready = !!project && text.trim().length > 0 && !busy;
  const start = async () => {
    if (!ready || !project) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await sync.newChat(project, text.trim()));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable accessibilityLabel="Close" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#00000066" }} />
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 12, maxHeight: "88%" }, shadow.float]}>
          <Txt variant="title" accessibilityRole="header">
            New chat
          </Txt>
          <Txt variant="small" tone="ink2">
            It starts on Ask: Claude asks you before it runs anything, and its questions come to this phone.
          </Txt>

          {projects === null ? (
            <Txt variant="body" tone="ink2">
              Looking at your projects…
            </Txt>
          ) : projects.length === 0 ? (
            <Txt variant="body" tone="ink2">
              {error ?? "No projects yet. Open a folder in Lantern on your Mac first, then it is here."}
            </Txt>
          ) : (
            <FadeSlideIn from={8}>
              <Txt variant="small" style={{ fontWeight: "700", marginBottom: 6 }}>
                Project
              </Txt>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                {projects.map((p) => {
                  const on = p.id === project;
                  return (
                    <PressScale key={p.id} accessibilityRole="radio" accessibilityLabel={p.name} accessibilityState={{ selected: on, checked: on }} onPress={() => setProject(p.id)} haptic="select" scaleTo={0.94} style={{ backgroundColor: on ? colors.ink : colors.paper, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: on ? colors.ink : colors.rule }}>
                      <Txt variant="small" tone={on ? "white" : "ink"} style={{ fontWeight: "700" }}>
                        {p.name}
                      </Txt>
                    </PressScale>
                  );
                })}
              </ScrollView>
            </FadeSlideIn>
          )}

          <TextInput
            accessibilityLabel="What to start with"
            value={text}
            onChangeText={setText}
            placeholder="What should Claude start with?"
            placeholderTextColor={colors.ink3}
            multiline
            editable={!busy}
            style={{ backgroundColor: colors.paper, borderRadius: 14, padding: 12, minHeight: 96, maxHeight: 200, color: colors.ink, fontSize: 15, textAlignVertical: "top" }}
          />

          {error && projects && projects.length > 0 && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {error}
            </Txt>
          )}
          <Button label={busy ? "Starting…" : "Start the chat"} disabled={!ready} onPress={() => void start()} />
          <Button label="Cancel" kind="ghost" disabled={busy} onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
