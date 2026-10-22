import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import { useController, useSyncState } from "../shell/hooks";
import { useControls } from "../shell/useControls";
import { Button, Txt } from "../ui/components";
import { useKeyboardUp } from "../ui/keyboard";
import { useListInput } from "../ui/useListInput";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { ProjectsSkeleton } from "../ui/skeleton";
import { colors, radius, shadow, space } from "../ui/theme";
import { autoNote, MODES } from "../view/controls";
import { projectColorOf, projectTint } from "../view/home";

/** What the sheet starts from: a suggestion's draft, the project it names, or the chat it carries on. */
export interface Draft {
  text: string;
  project?: string;
  continueChat?: { slot: string; title: string };
}

export interface NewChatProps {
  /** A draft to start from (a suggestion's), which the user may change. */
  initialText?: string;
  /** The project to start in (a suggestion's), when the Mac lists it. */
  initialProject?: string;
  /** Send the draft to this open chat instead of starting a new one (a suggestion to carry on). */
  continueChat?: { slot: string; title: string };
  onClose: () => void;
  /** The chat was started on the Mac: its slot. */
  onStarted: (slot: string) => void;
}

/**
 * Starting a chat from the phone: which project, and what to start with. It starts on Ask unless Auto is chosen (and the
 * Mac lets phones use it), so Claude asks before it runs anything, and the questions come to this phone like any other.
 * The models are the project's own unless a preset is chosen. Only a project the user already works in on the Mac is
 * offered (the Mac decides, whatever is sent).
 */
export function NewChatSheet({ initialText = "", initialProject, continueChat, onClose, onStarted }: NewChatProps) {
  const { sync } = useController();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardUp();
  // A project's colour is the one the Mac's sidebar gives it, known from a chat the Mac has open there.
  const { chats } = useSyncState();
  const colorOf = (name: string) => projectTint(projectColorOf(chats.find((c) => c.project === name)?.project_color)).fg;
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState<string | null>(initialProject ?? null);
  const [text, setText] = useState(initialText);
  // Return after "1. item" starts "2. ", after "- item" starts "- ".
  const list = useListInput(text, setText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What it runs on: Ask unless chosen, and the project's own models unless a preset is.
  const { supported, controls } = useControls();
  const [permissions, setPermissions] = useState<RemotePermissions>("ask");
  const [preset, setPreset] = useState<string | null>(null);

  useEffect(() => {
    // Carrying on a chat needs no project.
    if (continueChat) return;
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
  }, [sync, continueChat]);

  const ready = (!!continueChat || !!project) && text.trim().length > 0 && !busy;
  const start = async () => {
    if (!ready) return;
    if (continueChat) {
      // A send never throws: it shows in the chat at once, and says there if it didn't go.
      void sync.send(continueChat.slot, text.trim());
      return onStarted(continueChat.slot);
    }
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // Only what was chosen is sent, and only to a Mac that can take it.
      onStarted(await sync.newChat(project, text.trim(), supported ? { permissions, ...(preset ? { preset } : {}) } : {}));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, flexShrink: 1 }, shadow.float]}>
         {/* It scrolls when the keyboard leaves less room than it needs (a small phone). */}
         <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, paddingBottom: keyboard ? 16 : Math.max(insets.bottom, 16) + 8, gap: 12 }}>
          <Txt variant="title" accessibilityRole="header">
            {continueChat ? "Carry on" : "New chat"}
          </Txt>
          <Txt variant="small" tone="ink2">
            {continueChat ? `This goes to “${continueChat.title}”. Read it first: you can change it.` : permissions === "auto" ? "It starts on Auto: a classifier approves most actions, so Claude rarely asks. Its questions come to this phone." : "It starts on Ask: Claude asks you before it runs anything, and its questions come to this phone."}
          </Txt>

          {continueChat ? null : projects === null ? (
            <ProjectsSkeleton />
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
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                        <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colorOf(p.name) }} />
                        <Txt variant="small" tone={on ? "white" : "ink"} style={{ fontWeight: "700" }}>
                          {p.name}
                        </Txt>
                      </View>
                    </PressScale>
                  );
                })}
              </ScrollView>
            </FadeSlideIn>
          )}

          {!continueChat && supported && controls && (
            <FadeSlideIn from={8}>
              <Txt variant="small" style={{ fontWeight: "700", marginBottom: 6 }}>
                Runs on
              </Txt>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {MODES.map((m) => {
                  const on = m.value === permissions;
                  const off = m.value === "auto" ? autoNote(controls) : null;
                  return (
                    <PressScale key={m.value} accessibilityRole="radio" accessibilityLabel={m.label} accessibilityHint={off ?? m.hint} accessibilityState={{ selected: on, checked: on, disabled: !!off }} disabled={!!off} opacity={off ? 0.45 : 1} onPress={() => setPermissions(m.value)} haptic="select" scaleTo={0.94} style={{ backgroundColor: on ? colors.ink : colors.paper, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: on ? colors.ink : colors.rule }}>
                      <Txt variant="small" tone={on ? "white" : "ink"} style={{ fontWeight: "700" }}>
                        {m.label}
                      </Txt>
                    </PressScale>
                  );
                })}
              </View>
              {autoNote(controls) && (
                <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                  {autoNote(controls)}
                </Txt>
              )}
              {controls.presets.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8, paddingTop: 8 }}>
                  {[{ id: null as string | null, name: "Project's own" }, ...controls.presets].map((p) => {
                    const on = p.id === preset;
                    return (
                      <PressScale key={p.id ?? "own"} accessibilityRole="radio" accessibilityLabel={p.name} accessibilityState={{ selected: on, checked: on }} onPress={() => setPreset(p.id)} haptic="select" scaleTo={0.94} style={{ backgroundColor: on ? colors.ink : colors.paper, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: on ? colors.ink : colors.rule }}>
                        <Txt variant="small" tone={on ? "white" : "ink"} style={{ fontWeight: "700" }}>
                          {p.name}
                        </Txt>
                      </PressScale>
                    );
                  })}
                </ScrollView>
              )}
            </FadeSlideIn>
          )}

          <TextInput
            accessibilityLabel="What to start with"
            value={text}
            {...list}
            placeholder="What should Claude start with?"
            placeholderTextColor={colors.ink3}
            multiline
            editable={!busy}
            style={{ backgroundColor: colors.paper, borderRadius: 14, padding: 12, minHeight: 96, maxHeight: 200, color: colors.ink, fontSize: 15, textAlignVertical: "top" }}
          />

          {error && (continueChat || (projects && projects.length > 0)) && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {error}
            </Txt>
          )}
          <Button label={continueChat ? "Send" : busy ? "Starting…" : "Start the chat"} disabled={!ready} onPress={() => void start()} />
          <Button label="Cancel" kind="ghost" disabled={busy} onPress={close} />
         </ScrollView>
        </View>
      )}
    </Sheet>
  );
}
