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
import { barButton, MIN_TARGET, radius, space, useColors } from "../ui/theme";
import { accountsOf, autoNote, MODES, noAutoOn, providersOf, WORKFLOWS } from "../view/controls";
import { projectColorOf, projectTint } from "../view/home";
import { loadLastProject, loadNewChatPermissions, saveLastProject, saveNewChatPermissions } from "../prefs";
import { useAttachments } from "../ui/useAttachments";
import { useDictation } from "../ui/useDictation";
import { guessProject } from "../view/compose";
import { BOX_RADIUS, FIELD, MicButton, PlusButton, SendButton, Thumbnails, type SfName } from "./ChatParts";
import { PastedCards, PastedSheet } from "./PastedText";
import { pastedPart } from "../view/paste";
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
  const { sync } = useController();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardUp();
  // A project's colour is the one the Mac's sidebar gives it, known from a chat the Mac has open there.
  const { chats } = useSyncState();
  const colorOf = (name: string) => projectTint(projectColorOf(chats.find((c) => c.project === name)?.project_color), colors.plainTint).fg;
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState<string | null>(initialProject ?? null);
  const [text, setText] = useState(initialText);
  // Long pastes are held above the box as cards, as in the chat's box, and the one open to read.
  const [pasted, setPasted] = useState<{ id: string; text: string }[]>([]);
  const [readingPaste, setReadingPaste] = useState<string | null>(null);
  const hasWords = text.trim().length > 0 || pasted.length > 0;
  // What goes out: what was pasted first, then what was typed.
  const message = () => [...pasted.map((p) => p.text.trim()), text.trim()].filter(Boolean).join("\n\n");
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
  // Which Claude account it runs on: the default login unless chosen. Only for a chat that is known to run on Claude Code (the project's
  // own provider is the Mac's to know), on a Mac that lists accounts.
  const canAccount = useMacCan("accounts");
  const accounts = canAccount && runsOn === "claude" ? accountsOf(controls) : [];
  const [account, setAccount] = useState<string | null>(null);
  const chosenAccount = accounts.find((a) => a.id === account) ?? null;
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

  const ready = (!!continueChat || !!project) && hasWords && !busy && !attach.busy;
  const start = async () => {
    if (!ready) return;
    if (continueChat) {
      // A send never throws: it shows in the chat at once, and says there if it didn't go.
      void sync.send(continueChat.slot, message());
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
      const slot = await sync.newChat(project, message(), supported ? { permissions: mode, ...(preset && (!chosen || chosen.presets) ? { preset } : {}), ...(canFlow && workflow === "steps" ? { workflow } : {}), ...(chosen ? { provider: chosen.id } : {}), ...ownModel, ...(chosenAccount ? { account: chosenAccount.id } : {}) } : {}, canPhotos ? attach.images : []);
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
  const summary = [chosen?.name, chosenAccount?.name, canFlow ? workflowName : null, MODES.find((m) => m.value === mode)?.label, pickedModel || !chosen || chosen.presets ? modelLabel : null].filter(Boolean).join(" · ");

  // What the + offers besides photos: the options behind "Runs on" (where it runs, how it works, permissions, model).
  const menu: { label: string; symbol: SfName; onPress: () => void }[] = !continueChat && supported && controls ? [{ label: opened ? "Hide options" : "Options", symbol: "slider.horizontal.3", onPress: () => setOpened((o) => !o) }] : [];

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
            <View testID="new-chat-box" style={{ backgroundColor: colors.card, borderRadius: BOX_RADIUS, borderWidth: 1, borderColor: colors.rule, padding: 6 }}>
              {pasted.length > 0 && <PastedCards items={pasted} onOpen={(id) => setReadingPaste(pasted.find((p) => p.id === id)?.text ?? null)} onRemove={(id) => setPasted((l) => l.filter((x) => x.id !== id))} />}
              {attach.images.length > 0 && <Thumbnails images={attach.images} onRemove={attach.remove} onMarkUp={setMarking} />}
              {/* One row, as the chat's box is: the + (photos, the options), the words, the microphone, and Send. */}
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
                {(canPhotos || menu.length > 0) && <PlusButton busy={attach.busy} full={attach.full} canAttach={canPhotos} items={menu} onPress={() => void attach.add("library")} onPick={(source) => setTimeout(() => void attach.add(source), 350)} />}
                <TextInput
                  accessibilityLabel="What to start with"
                  value={text}
                  {...list}
                  onChangeText={(t) => {
                    dictation.edited();
                    // A long paste is taken out of the box and held above it.
                    const out = pastedPart(text, t);
                    if (out) {
                      setPasted((l) => [...l, { id: `p${Date.now()}${l.length}`, text: out.pasted }]);
                      list.onChangeText(out.rest);
                      return;
                    }
                    list.onChangeText(t);
                  }}
                  autoFocus={!listen}
                  placeholder={dictation.listening ? (dictation.ready ? "Listening\u2026" : "Getting ready\u2026") : chosen ? `What should ${chosen.name} start with?` : "What should the agent work on?"}
                  placeholderTextColor={colors.ink3}
                  multiline
                  editable={!busy}
                  style={{ flex: 1, minHeight: barButton, maxHeight: 200, color: colors.ink, ...FIELD, paddingHorizontal: 8, paddingTop: 11, paddingBottom: 11, textAlignVertical: "top" }}
                />
                {/* Once there are words, the box is for sending them: the microphone steps aside (unless it is listening). */}
                {dictation.available && !busy && (!hasWords || dictation.listening) && <MicButton listening={dictation.listening} ready={dictation.ready} onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())} />}
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
                  <PressScale accessibilityRole="button" accessibilityLabel={`Project: ${projects.find((p) => p.id === project)?.name ?? "none"}${guessed ? ", guessed from what you said" : ""}`} accessibilityHint="Picks another project" accessibilityState={{ expanded: choosingProject }} onPress={() => setChoosingProject(!choosingProject)} haptic="select" scaleTo={0.95} hitSlop={{ top: 6, bottom: 6 }} style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, minHeight: 34, borderRadius: radius.pill, backgroundColor: colors.wash }}>
                    <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colorOf(projects.find((p) => p.id === project)?.name ?? "") }} />
                    <Txt variant="small" numberOfLines={1} style={{ fontWeight: "700", flexShrink: 1, lineHeight: 18 }}>
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
                    <View testID="new-chat-options" style={{ gap: 18, marginTop: 10, padding: 16, borderRadius: 22, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule }}>
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
                      {accounts.length > 0 && (
                        <View>
                          <Caption>Claude account</Caption>
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                            {[{ id: null as string | null, name: "Default login" }, ...accounts].map((a) => (
                              <Pill key={a.id ?? "default"} label={a.name} on={a.id === (chosenAccount?.id ?? null)} onPress={() => setAccount(a.id)} />
                            ))}
                          </ScrollView>
                          <Txt variant="tiny" tone="ink2" style={{ marginTop: 6 }}>
                            {chosenAccount ? `The chat uses ${chosenAccount.name}'s sign-in and limits.` : "The chat uses your own Claude sign-in."}
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
          {readingPaste !== null && <PastedSheet text={readingPaste} onClose={() => setReadingPaste(null)} />}
          {marking && <MarkupSheet image={marking} onDone={(marked) => attach.replace(marking.id, marked)} onClose={() => setMarking(null)} />}
        </View>
        );
      }}
    </Sheet>
  );
}

/** Effort's levels as words ("xhigh" is "Extra high"), as the chat's settings say them. */
const EFFORT_WORDS: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** A small label over a group of choices. */
function Caption({ children }: { children: string }) {
  return (
    <Txt variant="small" style={{ fontWeight: "600", marginBottom: 8 }}>
      {children}
    </Txt>
  );
}

/** One choice of a group: filled when it is the one chosen. A radio for a screen reader, with what it means as its hint. */
function Pill({ label, on, onPress, hint, disabled, dot }: { label: string; on: boolean; onPress: () => void; hint?: string; disabled?: boolean; /** A project's colour, as a dot before its name. */ dot?: string }) {
  const colors = useColors();
  // The one chosen is a soft tint with an ink edge, not a solid black block; the rest are quiet outlines.
  return (
    <PressScale accessibilityRole="radio" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ selected: on, checked: on, disabled: !!disabled }} disabled={disabled} opacity={disabled ? 0.45 : 1} onPress={onPress} haptic="select" scaleTo={0.94} style={{ backgroundColor: on ? `${colors.ink}14` : "transparent", borderRadius: radius.pill, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", borderWidth: on ? 1.5 : 1, borderColor: on ? colors.ink : colors.rule }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        {dot && <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />}
        <Txt variant="small" tone={on ? "ink" : "ink2"} style={{ fontWeight: on ? "700" : "500", lineHeight: 18 }}>
          {label}
        </Txt>
      </View>
    </PressScale>
  );
}
