import { useEffect, useRef, useState } from "react";
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
import { Bar, Pulse } from "../ui/skeleton";
import { SheetBar } from "../ui/Sheet";
import { barButton, MIN_TARGET, radius, shadow, space, useBody, useColors } from "../ui/theme";
import { autoNote, MODES, noAutoOn, providersOf, WORKFLOWS } from "../view/controls";
import { projectColorOf, projectTint } from "../view/home";
import { loadLastProject, loadNewChatPermissions, saveLastProject, saveNewChatPermissions } from "../prefs";
import { useAttachments } from "../ui/useAttachments";
import { useDictation } from "../ui/useDictation";
import { guessProject } from "../view/compose";
import { MicButton, SendButton, Thumbnails } from "./ChatParts";
import { MarkupSheet } from "./MarkupSheet";
import type { PickedImage } from "../view/attachments";

/** What the sheet starts from: a suggestion's draft, the project it names, or the chat it carries on. */
export interface Draft {
  text: string;
  project?: string;
  /** The project by its folder's name, when only that is known (a chat's): the sheet finds its folder in the Mac's list. */
  projectName?: string | null;
  continueChat?: { slot: string; title: string };
  /** Opened by holding the compose button: the microphone starts at once. */
  voice?: boolean;
}

export interface NewChatProps {
  /** The project to start in, by its folder's name (a chat's own project): picked once the Mac's list is here. */
  initialProjectName?: string | null;
  /** A draft to start from (a suggestion's), which the user may change. */
  initialText?: string;
  /** The project to start in (a suggestion's), when the Mac lists it. */
  initialProject?: string;
  /** Send the draft to this open chat instead of starting a new one (a suggestion to carry on). */
  continueChat?: { slot: string; title: string };
  /** Start listening at once (the compose button was held down). */
  listen?: boolean;
  onClose: () => void;
  /** The chat was started on the Mac: its slot. */
  onStarted: (slot: string) => void;
}

/**
 * Starting a chat from the phone: which project, and what to start with. It starts on Ask unless Auto is chosen (and the
 * Mac lets phones use it), so Claude asks before it runs anything, and the questions come to this phone like any other.
 * Where it runs, then its model: the project's own, one of that provider's models (with an effort), or one of the presets (a model
 * for each role), as on the Mac. Only a project the user already works in on the Mac is
 * offered (the Mac decides, whatever is sent).
 */
export function NewChatSheet({ initialText = "", initialProject, initialProjectName, continueChat, listen = false, onClose, onStarted }: NewChatProps) {
  const colors = useColors();
  // The box takes the chat's type: 16 on a phone, 17 on a tablet.
  const body = useBody();
  const { sync } = useController();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardUp();
  // A project's colour is the one the Mac's sidebar gives it, known from a chat the Mac has open there.
  const { chats } = useSyncState();
  const colorOf = (name: string) => projectTint(projectColorOf(chats.find((c) => c.project === name)?.project_color), colors.plainTint).fg;
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState<string | null>(initialProject ?? null);
  const [text, setText] = useState(initialText);
  // Return after "1. item" starts "2. ", after "- item" starts "- ".
  const list = useListInput(text, setText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Talking instead of typing, and photos to go with the first message (a Mac that takes them).
  const dictation = useDictation(text, setText);
  const attach = useAttachments();
  const canPhotos = useMacCan("newchatimages") && !continueChat;
  const [marking, setMarking] = useState<PickedImage | null>(null);
  useEffect(() => {
    if (listen) void dictation.start();
    // Once, as the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The project follows the words until one is picked by hand (or the sheet was opened on one): a project they name, else the one
  // this phone last started in, else the Mac's first.
  const byHand = useRef(!!initialProject || !!initialProjectName);
  const [last, setLast] = useState<string | null>(null);
  const [choosingProject, setChoosingProject] = useState(false);
  // What it runs on: Ask unless chosen, and the project's own models unless a preset is.
  const { supported, controls } = useControls();
  // Ask or Auto as the last chat was started with, from this phone (Ask until one was).
  const [permissions, setPermissions] = useState<RemotePermissions>("ask");
  const picked = useRef(false);
  useEffect(() => {
    let live = true;
    // (A choice made before it is read stands.)
    void loadNewChatPermissions().then((p) => live && !picked.current && setPermissions(p));
    return () => {
      live = false;
    };
  }, []);
  // A chat started: the sheet slides away first (iOS's own sheet stays up if it is just taken away), then the chat opens.
  const started = useRef<string | null>(null);
  const closeSheet = useRef<(() => void) | null>(null);
  // Swiped away while the chat was starting: there is no sheet left to wait for, and the chat still opens.
  const gone = useRef(false);
  const finish = (slot: string) => {
    started.current = slot;
    if (closeSheet.current && !gone.current) closeSheet.current();
    else onStarted(slot);
  };
  const [preset, setPreset] = useState<string | null>(null);
  // Where it runs: the project's own unless chosen. A Mac with only Claude Code to offer (or an older one) offers no choice.
  const providers = providersOf(controls);
  const [provider, setProvider] = useState<string | null>(null);
  const chosen = providers.find((p) => p.id === provider) ?? null;
  // Its model: one of where it runs' models (a Mac that can take one), and the effort that model takes. A model and a preset are two
  // ways to say the same thing, so picking one lets go of the other.
  const canModel = useMacCan("newchatmodel");
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // Where it runs, when the phone knows: the one chosen, or Claude Code when it is the only one (the project's own is the Mac's to know).
  const runsOn = chosen?.id ?? (providers.length === 0 ? "claude" : null);
  const models = (canModel && runsOn ? controls?.models?.find((m) => m.provider === runsOn)?.models : null) ?? [];
  const pickedModel = models.find((m) => m.value === model) ?? null;
  const pickModel = (value: string | null) => {
    setModel(value);
    setEffort(null);
    if (value) setPreset(null);
  };
  const pickPreset = (id: string | null) => {
    setPreset(id);
    if (id) {
      setModel(null);
      setEffort(null);
    }
  };
  const chooseProvider = (id: string | null) => {
    setProvider(id);
    // Another provider's models are its own.
    setModel(null);
    setEffort(null);
    // What the new one has none of is let go of, so a choice made for another provider is never sent to it (nor shown as if it were).
    const next = providers.find((p) => p.id === id);
    if (next && !next.auto) setPermissions("ask");
    if (next && !next.presets) setPreset(null);
  };
  const canFlow = useMacCan("workflow");
  const [workflow, setWorkflow] = useState<Exclude<RemoteWorkflow, "team">>("chat");
  // The options behind the line that says what it runs on.
  const [opened, setOpened] = useState(false);

  // Asking for the projects failed: said where the project goes, with Try again (which bumps `asks`).
  const [projectsProblem, setProjectsProblem] = useState<string | null>(null);
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    // Carrying on a chat needs no project.
    if (continueChat) return;
    let live = true;
    setProjectsProblem(null);
    sync.projects().then(
      (list) => {
        if (!live) return;
        // Listed by name so the list stays put; the one used last (the Mac's first) is still the one picked.
        setProjects([...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
        setProject((now) => (now && list.some((p) => p.id === now) ? now : (list.find((p) => p.name === initialProjectName)?.id ?? list[0]?.id ?? null)));
        if (initialProjectName && !list.some((p) => p.name === initialProjectName)) byHand.current = false;
      },
      (e: Error) => {
        if (!live) return;
        setProjectsProblem(e.message || "Couldn't reach your Mac.");
      },
    );
    return () => {
      live = false;
    };
  }, [sync, continueChat, asks]);

  useEffect(() => {
    let live = true;
    void loadLastProject().then((p) => live && setLast(p));
    return () => {
      live = false;
    };
  }, []);
  const guess = projects && !byHand.current ? guessProject(text, projects, last) : null;
  useEffect(() => {
    if (guess && guess.project.id !== project) setProject(guess.project.id);
  }, [guess?.project.id]);
  const guessed = !!guess?.guessed && guess.project.id === project;
  const pickProject = (id: string) => {
    byHand.current = true;
    setProject(id);
    setChoosingProject(false);
  };

  const ready = (!!continueChat || !!project) && text.trim().length > 0 && !busy && !attach.busy;
  const start = async () => {
    if (!ready) return;
    if (continueChat) {
      // A send never throws: it shows in the chat at once, and says there if it didn't go.
      void sync.send(continueChat.slot, text.trim());
      return finish(continueChat.slot);
    }
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // Only what was chosen is sent, and only to a Mac that can take it.
      // (A provider with no Auto, or no presets, is sent neither, whatever was chosen before it was; nor Auto to a Mac that doesn't let phones use it.)
      dictation.cancel();
      // (A model only from the list of where it runs, and its effort only if that model takes it.)
      const ownModel = pickedModel ? { model: pickedModel.value, ...(effort && pickedModel.effort_levels.includes(effort) ? { effort } : {}) } : {};
      const slot = await sync.newChat(project, text.trim(), supported ? { permissions: mode, ...(preset && (!chosen || chosen.presets) ? { preset } : {}), ...(canFlow && workflow === "steps" ? { workflow } : {}), ...(chosen ? { provider: chosen.id } : {}), ...ownModel } : {}, canPhotos ? attach.images : []);
      void saveLastProject(project);
      // What was chosen is what the next chat starts on; one forced to Ask (no Auto here) doesn't change that.
      if (supported && !note) void saveNewChatPermissions(permissions);
      finish(slot);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const workflowName = WORKFLOWS.find((w) => w.value === workflow)?.label ?? "Chat";
  const presetLabel = controls?.presets.find((p) => p.id === preset)?.name ?? "Project's own";
  // What it runs on, said in a word or two: the model picked (and its effort), the preset, or the project's own.
  const modelLabel = pickedModel ? [pickedModel.name, effort ? EFFORT_WORDS[effort] ?? effort : null].filter(Boolean).join(", ") : presetLabel;
  // Where it runs has no Auto, or no presets (the Mac's presets are Claude Code's): what it can't do is shown off, with why.
  const noAuto = chosen && !chosen.auto ? noAutoOn(chosen.name) : null;
  const showPresets = (controls?.presets.length ?? 0) > 0 && (!chosen || chosen.presets);
  // What it will run on, said in a line: the options themselves open from it.
  const note = noAuto ?? autoNote(controls);
  // What it starts on: Ask where Auto can't be had (a remembered Auto included).
  const mode: RemotePermissions = note ? "ask" : permissions;
  const summary = [chosen?.name, canFlow ? workflowName : null, MODES.find((m) => m.value === mode)?.label, pickedModel || !chosen || chosen.presets ? modelLabel : null].filter(Boolean).join(" · ");

  return (
    <Sheet
      onClose={() => {
        gone.current = true;
        if (started.current) onStarted(started.current);
        else onClose();
      }}
    >
      {(close, scroll) => {
        closeSheet.current = close;
        return (
        <View style={[{ flexShrink: 1 }]}>
          {/* iOS's sheet bar: Cancel in glass at the left, the title in the middle (a swipe down closes it too). */}
          <SheetBar title={continueChat ? "Carry on" : "New chat"} close={{ label: "Cancel", onPress: close, disabled: busy }} />
          {/* It scrolls when the keyboard leaves less room than it needs (a small phone). */}
          <ScrollView ref={scroll} style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 8, paddingBottom: keyboard ? 16 : Math.max(insets.bottom, 16) + 8, gap: 12 }}>
            {continueChat && (
              <Txt variant="small" tone="ink2" style={{ marginHorizontal: 4 }}>
                This goes to “{continueChat.title}”. Read it first: you can change it.
              </Txt>
            )}

            {/* The chat's own message box: the words, and under them its row of tools, photos and options at the left, the
                microphone and send at the right. */}
            <View testID="new-chat-box" style={[{ backgroundColor: colors.card, borderRadius: BOX_RADIUS, borderWidth: 1, borderColor: colors.rule, padding: 6 }, shadow.card, { shadowOpacity: 0.05 }]}>
              {attach.images.length > 0 && <Thumbnails images={attach.images} onRemove={attach.remove} onMarkUp={setMarking} />}
              <TextInput
                accessibilityLabel="What to start with"
                value={text}
                {...list}
                onChangeText={(t) => {
                  dictation.edited();
                  list.onChangeText(t);
                }}
                autoFocus={!listen}
                placeholder={dictation.listening ? (dictation.ready ? "Listening…" : "Getting ready…") : chosen ? `What should ${chosen.name} start with?` : "What should the agent work on?"}
                placeholderTextColor={colors.ink3}
                multiline
                editable={!busy}
                style={{ minHeight: 96, maxHeight: 200, color: colors.ink, fontSize: body.fontSize, lineHeight: body.lineHeight, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4, textAlignVertical: "top" }}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: barButton }}>
                {canPhotos && (
                  <PressScale accessibilityRole="button" accessibilityLabel="Add photos" accessibilityHint="Hold to take a photo" disabled={attach.busy || attach.full} opacity={attach.busy || attach.full ? 0.4 : 1} onPress={() => void attach.add("library")} onLongPress={() => void attach.add("camera")} accessibilityActions={[{ name: "longpress", label: "Take a photo" }]} onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && void attach.add("camera")} haptic="light" scaleTo={0.88} style={{ width: barButton, height: barButton, alignItems: "center", justifyContent: "center" }}>
                    <PhotoGlyph color={colors.ink2} />
                  </PressScale>
                )}
                {!continueChat && supported && controls && (
                  <PressScale accessibilityRole="button" accessibilityLabel={`Runs on: ${summary}`} accessibilityHint={opened ? "Hides the options" : "Shows the options"} accessibilityState={{ expanded: opened }} onPress={() => setOpened(!opened)} haptic="select" scaleTo={0.88} style={{ width: barButton, height: barButton, alignItems: "center", justifyContent: "center" }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: opened ? colors.ink : "transparent" }}>
                      <MoreGlyph color={opened ? colors.onInk : colors.ink2} />
                    </View>
                  </PressScale>
                )}
                <View style={{ flex: 1 }} />
                {dictation.available && !busy && <MicButton listening={dictation.listening} ready={dictation.ready} onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())} />}
                <SendButton ready={ready} label={continueChat ? "Send" : "Start the chat"} onPress={() => void start()} />
              </View>
            </View>

            {/* Where it goes: a guess until picked. While the projects come, one quiet pill holds its place. */}
            {!continueChat && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: MIN_TARGET, marginHorizontal: 4 }}>
                {!(projects && projects.length === 0) && (
                  <Txt variant="small" tone="ink2">
                    In
                  </Txt>
                )}
                {projects === null && projectsProblem ? (
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Txt variant="small" tone="stop" accessibilityRole="alert" numberOfLines={2} style={{ flexShrink: 1 }}>
                      {projectsProblem}
                    </Txt>
                    <Button label="Try again" kind="ghost" onPress={() => setAsks((n) => n + 1)} />
                  </View>
                ) : projects === null ? (
                  <Pulse label="Looking at your projects">
                    <Bar w={120} h={32} r={radius.pill} />
                  </Pulse>
                ) : projects.length === 0 ? (
                  <Txt variant="small" tone="ink2" style={{ flex: 1 }}>
                    No projects yet. Open a folder in Lantern on your Mac first.
                  </Txt>
                ) : (
                  <PressScale accessibilityRole="button" accessibilityLabel={`Project: ${projects.find((p) => p.id === project)?.name ?? "none"}${guessed ? ", guessed from what you said" : ""}`} accessibilityHint="Picks another project" accessibilityState={{ expanded: choosingProject }} onPress={() => setChoosingProject(!choosingProject)} haptic="select" scaleTo={0.95} hitSlop={{ top: 6, bottom: 6 }} style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, minHeight: 32, borderRadius: radius.pill, backgroundColor: colors.wash }}>
                    <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colorOf(projects.find((p) => p.id === project)?.name ?? "") }} />
                    <Txt variant="small" numberOfLines={1} style={{ fontWeight: "700", flexShrink: 1 }}>
                      {projects.find((p) => p.id === project)?.name ?? "Pick a project"}
                    </Txt>
                    {guessed && (
                      <Txt variant="tiny" tone="ink3">
                        guessed
                      </Txt>
                    )}
                    <Chevron open={choosingProject} size={5} />
                  </PressScale>
                )}
              </View>
            )}
            {!continueChat && !(supported && controls) && (
              <Txt variant="small" tone="ink2" style={{ marginHorizontal: 4 }}>
                It starts on Ask: the agent asks you before it runs anything, and its questions come to this phone.
              </Txt>
            )}
            {(dictation.problem ?? attach.problem) && (
              <Txt variant="small" tone="stop" accessibilityRole="alert">
                {(dictation.problem ?? attach.problem)!.words}
              </Txt>
            )}

            {choosingProject && projects && projects.length > 0 && (
              <FadeSlideIn from={6} ms={180}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                  {projects.map((p) => (
                    <Pill key={p.id} label={p.name} on={p.id === project} dot={colorOf(p.name)} onPress={() => pickProject(p.id)} />
                  ))}
                </ScrollView>
              </FadeSlideIn>
            )}

            {!continueChat && supported && controls && (
              <FadeSlideIn from={8}>
                <Txt variant="tiny" tone="ink2">
                  {note && !opened ? note : `Runs on ${summary}`}
                </Txt>
                {opened && (
                  <FadeSlideIn from={6} ms={180}>
                    <View style={{ gap: 12, paddingTop: 12 }}>
                      {providers.length > 1 && (
                        <View>
                          <Caption>Provider</Caption>
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                            {[{ id: null as string | null, name: "As on your Mac" }, ...providers].map((p) => (
                              <Pill key={p.id ?? "own"} label={p.name} on={p.id === provider} onPress={() => chooseProvider(p.id)} />
                            ))}
                          </ScrollView>
                          <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                            {chosen ? `The chat runs on ${chosen.name}.` : "As on your Mac uses this project’s selected provider."}
                          </Txt>
                        </View>
                      )}
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
                            const off = m.value === "auto" ? note : null; // (the Mac's setting, or the provider having none)
                            return <Pill key={m.value} label={m.label} hint={off ?? m.hint} on={m.value === mode} disabled={!!off} onPress={() => {
                              picked.current = true;
                              setPermissions(m.value);
                            }} />;
                          })}
                        </View>
                        <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                          {note ?? (mode === "auto" ? "It starts on Auto: a classifier approves most actions, so the agent rarely asks. Its questions come to this phone." : "It starts on Ask: the agent asks you before it runs anything, and its questions come to this phone.")}
                        </Txt>
                      </View>
                      {(models.length > 0 || showPresets) && (
                        <View>
                          <Caption>Model</Caption>
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                            {[{ value: null as string | null, name: "Project's own" }, ...models].map((m) => (
                              <Pill key={m.value ?? "own"} label={m.name} on={m.value === model && (m.value !== null || preset === null)} onPress={() => {
                                pickModel(m.value);
                                if (!m.value) pickPreset(null);
                              }} />
                            ))}
                          </ScrollView>
                          {pickedModel && pickedModel.effort_levels.length > 0 && (
                            <View style={{ marginTop: 10 }}>
                              <Caption>Effort</Caption>
                              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                                {[null, ...pickedModel.effort_levels].map((e) => (
                                  <Pill key={e ?? "own"} label={e ? (EFFORT_WORDS[e] ?? e) : "Its own"} on={e === effort} onPress={() => setEffort(e)} />
                                ))}
                              </View>
                            </View>
                          )}
                          {showPresets && (
                            <View style={{ marginTop: 10 }}>
                              <Caption>Presets: a model for each role</Caption>
                              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                                {controls.presets.map((p) => (
                                  <Pill key={p.id} label={p.name} hint={p.summary} on={p.id === preset} onPress={() => pickPreset(p.id === preset ? null : p.id)} />
                                ))}
                              </ScrollView>
                            </View>
                          )}
                          {canModel && models.length === 0 && providers.length > 0 && !chosen && (
                            <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                              Pick where it runs to pick its model.
                            </Txt>
                          )}
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
            {busy && (
              <Txt variant="small" tone="ink2" accessibilityLiveRegion="polite">
                {continueChat ? "Sending…" : "Starting…"}
              </Txt>
            )}
          </ScrollView>
          {marking && <MarkupSheet image={marking} onDone={(marked) => attach.replace(marking.id, marked)} onClose={() => setMarking(null)} />}
        </View>
        );
      }}
    </Sheet>
  );
}

/** The box's corners, as the chat's message box has them. */
const BOX_RADIUS = 18;

/** More, drawn: three dots in a row, in the middle of the circle (a "⋯" glyph sits on the type's baseline, low in it). */
function MoreGlyph({ color }: { color: string }) {
  return (
    <View accessibilityElementsHidden style={{ flexDirection: "row", gap: 3 }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
      ))}
    </View>
  );
}

/** A photo, drawn: a frame with a sun and a hill. */
function PhotoGlyph({ color }: { color: string }) {
  return (
    <View accessibilityElementsHidden style={{ width: 18, height: 14, borderRadius: 3, borderWidth: 1.8, borderColor: color, overflow: "hidden" }}>
      <View style={{ position: "absolute", left: 3, top: 2, width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
      <View style={{ position: "absolute", left: 4, bottom: -6, width: 12, height: 12, backgroundColor: color, transform: [{ rotate: "45deg" }] }} />
    </View>
  );
}

/** Effort's levels as words ("xhigh" is "Extra high"), as the chat's settings say them. */
const EFFORT_WORDS: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

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
