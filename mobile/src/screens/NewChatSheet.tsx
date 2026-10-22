import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import type { RemoteWorkflow } from "../protocol/generated/RemoteWorkflow";
import { useController, useSyncState } from "../shell/hooks";
import { useControls, useMacCan } from "../shell/useControls";
import { Chevron } from "../ui/Chevron";
import { Button, Txt } from "../ui/components";
import { useKeyboardUp } from "../ui/keyboard";
import { useListInput } from "../ui/useListInput";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { ProjectsSkeleton } from "../ui/skeleton";
import { radius, shadow, space, useColors } from "../ui/theme";
import { autoNote, MODES, WORKFLOWS } from "../view/controls";
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
  const colors = useColors();
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
  const canFlow = useMacCan("workflow");
  const [workflow, setWorkflow] = useState<Exclude<RemoteWorkflow, "team">>("chat");
  // The options behind the line that says what it runs on.
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    // Carrying on a chat needs no project.
    if (continueChat) return;
    let live = true;
    sync.projects().then(
      (list) => {
        if (!live) return;
        // Listed by name so the list stays put; the one used last (the Mac's first) is still the one picked.
        setProjects([...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
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
      onStarted(await sync.newChat(project, text.trim(), supported ? { permissions, ...(preset ? { preset } : {}), ...(canFlow && workflow === "steps" ? { workflow } : {}) } : {}));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const workflowName = WORKFLOWS.find((w) => w.value === workflow)?.label ?? "Chat";
  const presetLabel = controls?.presets.find((p) => p.id === preset)?.name ?? "Project's own";
  // What it will run on, said in a line: the options themselves open from it.
  const summary = [canFlow ? workflowName : null, MODES.find((m) => m.value === permissions)?.label, presetLabel].filter(Boolean).join(" · ");
  const note = autoNote(controls);

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, flexShrink: 1 }, shadow.float]}>
          {/* It scrolls when the keyboard leaves less room than it needs (a small phone). */}
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, paddingBottom: keyboard ? 16 : Math.max(insets.bottom, 16) + 8, gap: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Txt variant="title" accessibilityRole="header">
                {continueChat ? "Carry on" : "New chat"}
              </Txt>
              {/* The way out for a screen reader too, which has no outside to tap. */}
              <PressScale accessibilityRole="button" accessibilityLabel="Cancel" disabled={busy} onPress={close} hitSlop={12} scaleTo={0.92} haptic="none" style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
                <Txt variant="body" tone="cobalt" style={{ fontWeight: "600" }}>
                  Cancel
                </Txt>
              </PressScale>
            </View>

            {continueChat ? (
              <Txt variant="small" tone="ink2">
                This goes to “{continueChat.title}”. Read it first: you can change it.
              </Txt>
            ) : !(supported && controls) ? (
              <Txt variant="small" tone="ink2">
                It starts on Ask: Claude asks you before it runs anything, and its questions come to this phone.
              </Txt>
            ) : null}

            <TextInput
              accessibilityLabel="What to start with"
              value={text}
              {...list}
              placeholder="What should Claude start with?"
              placeholderTextColor={colors.ink3}
              multiline
              editable={!busy}
              style={{ backgroundColor: colors.paper, borderRadius: 14, padding: 12, minHeight: 110, maxHeight: 200, color: colors.ink, fontSize: 15, textAlignVertical: "top" }}
            />

            {continueChat ? null : projects === null ? (
              <ProjectsSkeleton />
            ) : projects.length === 0 ? (
              <Txt variant="body" tone="ink2">
                {error ?? "No projects yet. Open a folder in Lantern on your Mac first, then it is here."}
              </Txt>
            ) : (
              <FadeSlideIn from={8}>
                <Caption>Project</Caption>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                  {projects.map((p) => (
                    <Pill key={p.id} label={p.name} on={p.id === project} dot={colorOf(p.name)} onPress={() => setProject(p.id)} />
                  ))}
                </ScrollView>
              </FadeSlideIn>
            )}

            {!continueChat && supported && controls && (
              <FadeSlideIn from={8}>
                {/* One line says what it runs on; the options are behind it. */}
                <PressScale accessibilityRole="button" accessibilityLabel={`Runs on: ${summary}`} accessibilityHint={opened ? "Hides the options" : "Shows the options"} accessibilityState={{ expanded: opened }} onPress={() => setOpened(!opened)} haptic="select" scaleTo={0.98} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.paper, borderRadius: 14, paddingHorizontal: 14, minHeight: 48 }}>
                  <View style={{ flexShrink: 1 }}>
                    <Txt variant="tiny" tone="ink2" style={{ fontWeight: "700" }}>
                      Runs on
                    </Txt>
                    <Txt variant="body" style={{ fontWeight: "600" }} numberOfLines={1}>
                      {summary}
                    </Txt>
                  </View>
                  <Chevron open={opened} />
                </PressScale>
                {note && !opened && (
                  <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                    {note}
                  </Txt>
                )}
                {opened && (
                  <FadeSlideIn from={6} ms={180}>
                    <View style={{ gap: 12, paddingTop: 12 }}>
                      {canFlow && (
                        <View>
                          <Caption>How it works</Caption>
                          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                            {WORKFLOWS.map((w) => (
                              <Pill key={w.value} label={w.label} hint={w.hint} on={w.value === workflow} onPress={() => setWorkflow(w.value)} />
                            ))}
                          </View>
                        </View>
                      )}
                      <View>
                        <Caption>Permissions</Caption>
                        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                          {MODES.map((m) => {
                            const off = m.value === "auto" ? note : null;
                            return <Pill key={m.value} label={m.label} hint={off ?? m.hint} on={m.value === permissions} disabled={!!off} onPress={() => setPermissions(m.value)} />;
                          })}
                        </View>
                        <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                          {note ?? (permissions === "auto" ? "It starts on Auto: a classifier approves most actions, so Claude rarely asks. Its questions come to this phone." : "It starts on Ask: Claude asks you before it runs anything, and its questions come to this phone.")}
                        </Txt>
                      </View>
                      {controls.presets.length > 0 && (
                        <View>
                          <Caption>Models</Caption>
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                            {[{ id: null as string | null, name: "Project's own" }, ...controls.presets].map((p) => (
                              <Pill key={p.id ?? "own"} label={p.name} on={p.id === preset} onPress={() => setPreset(p.id)} />
                            ))}
                          </ScrollView>
                        </View>
                      )}
                    </View>
                  </FadeSlideIn>
                )}
              </FadeSlideIn>
            )}

            {error && (continueChat || (projects && projects.length > 0)) && (
              <Txt variant="small" tone="stop" accessibilityRole="alert">
                {error}
              </Txt>
            )}
            <Button label={continueChat ? "Send" : busy ? "Starting…" : "Start the chat"} disabled={!ready} onPress={() => void start()} />
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}

/** A small label over a group of choices. */
function Caption({ children }: { children: string }) {
  return (
    <Txt variant="tiny" tone="ink2" style={{ fontWeight: "700", marginBottom: 6 }}>
      {children}
    </Txt>
  );
}

/** One choice of a group: filled when it is the one chosen. A radio for a screen reader, with what it means as its hint. */
function Pill({ label, on, onPress, hint, disabled, dot }: { label: string; on: boolean; onPress: () => void; hint?: string; disabled?: boolean; /** A project's colour, as a dot before its name. */ dot?: string }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="radio" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ selected: on, checked: on, disabled: !!disabled }} disabled={disabled} opacity={disabled ? 0.45 : 1} onPress={onPress} haptic="select" scaleTo={0.94} style={{ backgroundColor: on ? colors.ink : colors.paper, borderRadius: radius.pill, paddingHorizontal: 13, paddingVertical: 8, borderWidth: 1, borderColor: on ? colors.ink : colors.rule }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        {dot && <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />}
        <Txt variant="small" tone={on ? "on-ink" : "ink"} style={{ fontWeight: "700" }}>
          {label}
        </Txt>
      </View>
    </PressScale>
  );
}
