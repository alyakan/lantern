import { currentUsageWindows } from "../view/providerUsage";
import type { ProviderUsage } from "../protocol/generated/ProviderUsage";
import type { ConversationSettings } from "../sync/sync";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemoteWhen } from "../protocol/generated/RemoteWhen";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import type { RemoteWorkflow } from "../protocol/generated/RemoteWorkflow";
import type { PlanUsage } from "../sync/reducer";
import { useController } from "../shell/hooks";
import { useControls, useMacCan } from "../shell/useControls";
import { ContextRow, UsageRow, WeekRow, WindowRow } from "./ChatExtras";
import { CloseChatSheet } from "./CloseChat";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { DangerButton, LOOKS, MenuRow, noteOf, PendingRow, SettingsSection, SheetHeader, SliderRow, type Choice, type Look } from "../ui/Settings";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";
import { UsageRing } from "../ui/UsageRing";
import { autoNote, MODES, modeLabel, noAutoOn, presetName, whyNotNow, WORKFLOWS, workflowLabel } from "../view/controls";
import { contextOf, usageOf } from "../view/plan";

/** How long "Switching…" waits for the chat to say it changed before it gives up and says so. */
export const SWITCH_WAIT_MS = 20_000;

/** How a Step by step chat is shown on this phone. */
export interface PagesChoice {
  on: boolean;
  onChange: (on: boolean) => void;
}

const SHOW: Option[] = [
  { value: "pages", label: "Pages", hint: "One page at a time, side by side, as on the Mac" },
  { value: "list", label: "One list", hint: "The whole chat as one list of messages" },
];

type Option = Choice;

/** What is being switched, and to what: until the chat says it changed. */
export type Switching = { kind: "mode" | "preset" | "workflow"; to: string } | null;

/** The presets' id for Standard: no preset, just the model and effort. */
const STANDARD = "default";
/** The title over the presets in the Model menu, as on the Mac. */
const PRESETS_TITLE = "Presets: a model for each role";

/** Effort's levels as words ("xhigh" is "Extra high"). */
const effortLabel = (e: string) => ({ xhigh: "Extra high", max: "Max", medium: "Medium", low: "Low", high: "High", minimal: "Minimal" })[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/** The chat, in a card at the top: its name, where it runs and on what, and how full its context is. */
function Summary({ chat, model, context }: { chat: RemoteChat; model: string | null; context?: { tokens: number; window: number | null } | null }) {
  const colors = useColors();
  const held = context ? contextOf(context) : null;
  const line = [chat.project, chat.provider ?? "Claude", model].filter(Boolean).join(" · ");
  return (
    <View accessible accessibilityLabel={`${chat.title?.trim() || "This chat"}. ${line}${held ? `. ${held.label}` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.inner, backgroundColor: colors.wash }}>
      <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: LOOKS.provider.tint, alignItems: "center", justifyContent: "center" }}>
        <Txt variant="heading" tone="white">
          {(chat.title?.trim() || "?").charAt(0).toUpperCase()}
        </Txt>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="body" numberOfLines={1} style={{ fontWeight: "700" }}>
          {chat.title?.trim() || "This chat"}
        </Txt>
        <Txt variant="small" tone="ink2" numberOfLines={1}>
          {line}
        </Txt>
      </View>
      {held?.percent != null && (
        <UsageRing fill={held.percent / 100} tone={held.tone} size={42} stroke={4}>
          <Txt variant="tiny" style={{ fontWeight: "700" }}>
            {held.percent}%
          </Txt>
        </UsageRing>
      )}
    </View>
  );
}

/**
 * The chat's settings, as a sheet: the chat at the top; how it runs (Ask or Auto, Chat or Step by step); what it runs on (the
 * provider, the model, its effort, the preset); its usage; how this phone shows it; and closing it. A choice is changed in place
 * and the sheet stays: what is switching says so until the chat does, and a refusal is said here.
 */
function SettingsSheet({ chat, plan, providerUsage, context, off, loading, workflows, modes, presets, pages, switching, problem, onWorkflow, onMode, onPreset, onAskClose, onClose, configuration, configuring, providers, onConfigure }: { configuration?: ConversationSettings | null; /** The provider's settings are still being asked of the Mac: their rows are held. */ configuring?: boolean; providers?: { id: string; name: string }[]; onConfigure?: (change: {provider?: string; model?: string | null; effort?: string | null}) => void; chat: RemoteChat; /** Step by step's pages or one list: how this phone shows the chat (Claude isn't restarted). */ pages?: PagesChoice; /** The subscription's usage, when the Mac has said it. */ plan?: PlanUsage | null; providerUsage?: ProviderUsage; /** What the chat holds of its context, when the Mac has said it. */ context?: { tokens: number; window: number | null } | null; off: string | null; loading: boolean; /** Empty when this Mac can't switch it, or the chat leads a team. */ workflows: Option[]; modes: Option[]; presets: Option[]; switching: Switching; /** Why the last change didn't happen, while the sheet is up. */ problem: string | null; onWorkflow: (v: string) => void; onMode: (v: string) => void; onPreset: (v: string) => void; /** Present when this Mac can close chats. */ onAskClose?: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const next = useRef<(() => void) | null>(null);
  // What is chosen is what the chat says, or what it is switching to, or what the Mac holds for it: a refused switch goes back on its own.
  const pending = chat.pending ?? null;
  const held = (kind: NonNullable<Switching>["kind"]) => (kind === "mode" ? pending?.permissions : kind === "workflow" ? pending?.workflow : pending?.preset) ?? null;
  const now = (kind: NonNullable<Switching>["kind"], value: string) => (switching?.kind === kind ? switching.to : (held(kind) ?? value));
  // Ask or Auto, Chat or Step by step: a menu, with what the chosen one does (or why one is off) under it, and Switching… while it does.
  const choiceRow = ({ look, title, kind, choices, value, onPick }: { look: Look; title: string; kind: NonNullable<Switching>["kind"]; choices: Option[]; value: string; onPick: (v: string) => void }) => {
    const selected = now(kind, value);
    const busy = switching?.kind === kind || (!!held(kind) && pending?.when === "now");
    const label = choices.find((c) => c.value === selected)?.label ?? selected;
    // Held until the turn ends, it says so; being applied now, Switching…
    const shown = busy ? "Switching…" : held(kind) ? `${label}, after this turn` : label;
    return <MenuRow key={kind} look={look} title={title} value={shown} detail={noteOf(choices, selected, off)} choices={choices} selected={selected} onPick={onPick} disabled={busy} />;
  };
  const providerName = configuration ? (providers?.find((p) => p.id === configuration.provider)?.name ?? chat.provider ?? (configuration.provider === "claude" ? "Claude" : configuration.provider)) : null;
  const presetLabel = presets.find((p) => p.value === chat.preset)?.label ?? null;
  const model = configuration?.model ?? presetLabel;
  const activeUsage = currentUsageWindows(providerUsage);
  const exhausted = (activeUsage.some((w) => w.used >= 0.95) || (!!plan && Math.max(plan.used, plan.week?.used ?? 0) >= 0.95)) && configuration?.provider === "claude" && !off && !!providers?.some((p) => p.id === "codex") && !!onConfigure;
  const hasUsage = !!context || !!plan || !!providerUsage || !!chat.provider;
  const models = configuration?.capabilities.model_switchable ? [{ value: "", label: "Provider default", off }, ...configuration.models.map((m) => ({ value: m, label: m, off }))] : [];
  const efforts = configuration?.capabilities.supports_effort ? configuration.effort_levels.map((e) => ({ value: e, label: effortLabel(e), off })) : [];
  // The presets are one more way to pick the model (a model for each role), so they sit in the Model menu after the models. A
  // preset that is on is named after the model it runs. Only a Mac that can't list the models still gets a row of its own for them.
  const presetSelected = now("preset", chat.preset ?? "");
  const presetSwitching = switching?.kind === "preset";
  const presetOn = !!presetSelected && presetSelected !== STANDARD;
  const presetNow = presets.find((p) => p.value === presetSelected);
  const modelValue = presetSwitching ? "Switching…" : [configuration?.model ?? "Provider default", presetOn ? presetNow?.label : null].filter(Boolean).join(" · ");
  return (
    <Sheet onClose={() => { onClose(); next.current?.(); }}>
      {(close, scroll) => (
        <View style={{ flexShrink: 1 }}>
          <SheetHeader title="Chat settings" onDone={close} />
          <ScrollView ref={scroll} style={{ flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 6 }}>
            <Summary chat={chat} model={model} context={context} />
            {pending && (
              <View accessible accessibilityLabel={pending.when === "now" ? `Stopping to change to ${pending.text}` : `Changes to ${pending.text} once ${chat.provider ?? "Claude"} finishes`} style={{ backgroundColor: colors.wash, borderRadius: radius.inner, padding: 12, marginTop: 6 }}>
                <Txt variant="small" tone="ink2">
                  {pending.when === "now" ? `Stopping to change to ${pending.text}…` : `Changes to ${pending.text} once ${chat.provider ?? "Claude"} finishes.`}
                </Txt>
              </View>
            )}
            {(problem || off) && (
              <View accessible={!!problem} accessibilityRole={problem ? "alert" : undefined} style={{ backgroundColor: problem ? colors.wash : colors.hiSoft, borderRadius: radius.inner, padding: 12, marginTop: 6 }}>
                <Txt variant="small" tone={problem ? "stop" : "cobalt"}>{problem ?? off}</Txt>
              </View>
            )}
            {exhausted && (
              <PressScale accessibilityRole="button" accessibilityLabel="Switch this chat to Codex" onPress={() => onConfigure!({ provider: "codex" })} haptic="select" scaleTo={0.98} style={{ marginTop: 6, padding: 12, borderRadius: radius.inner, backgroundColor: colors.wash }}>
                <Txt variant="body" tone="cobalt" style={{ fontWeight: "600" }}>Switch this chat to Codex</Txt>
                <Txt variant="tiny" tone="ink3">Claude's limit is nearly used up: Codex carries on the conversation.</Txt>
              </PressScale>
            )}
            {loading ? (
              <View accessibilityLabel="Loading" accessibilityRole="progressbar" accessible style={{ paddingVertical: 16 }}><Dots /></View>
            ) : (
              <>
                <SettingsSection label="How it runs">
                  {choiceRow({ look: LOOKS.permissions, title: "Permissions", kind: "mode", choices: modes, value: chat.permissions ?? "ask", onPick: onMode })}
                  {workflows.length > 0 && choiceRow({ look: LOOKS.workflow, title: "Workflow", kind: "workflow", choices: workflows, value: chat.workflow ?? "chat", onPick: onWorkflow })}
                </SettingsSection>
                <SettingsSection label="Model">
                  {configuring && <PendingRow look={LOOKS.provider} title="Provider" />}
                  {configuring && <PendingRow look={LOOKS.model} title="Model" />}
                  {configuration && onConfigure && !!providers?.length && <MenuRow look={LOOKS.provider} title="Provider" value={providerName ?? ""} choices={providers.map((p) => ({ value: p.id, label: p.name, off }))} selected={configuration.provider} onPick={(provider) => onConfigure({ provider })} disabled={!!off} />}
                  {configuration && onConfigure && models.length > 0 && <MenuRow look={LOOKS.model} title="Model" value={modelValue} detail={presetOn ? presetNow?.hint : null} choices={models} selected={configuration.model ?? ""} onPick={(m) => onConfigure({ model: m || null })} shown={6} moreLabel="Older models" disabled={!!off || presetSwitching} section={presets.length > 0 ? { title: PRESETS_TITLE, choices: presets, selected: presetSelected, onPick: onPreset } : undefined} />}
                  {configuration && onConfigure && efforts.length > 0 && <SliderRow look={LOOKS.effort} title="Effort" choices={efforts} selected={configuration.effort ?? ""} onPick={(effort) => onConfigure({ effort })} disabled={!!off} />}
                  {presets.length > 0 && !configuring && models.length === 0 && <MenuRow look={LOOKS.preset} title="Preset" value={presetSwitching ? "Switching…" : (presetLabel ?? "Standard")} detail={presetNow?.hint} choices={presets} selected={presetSelected} onPick={onPreset} disabled={!!off || presetSwitching} />}
                </SettingsSection>
                {hasUsage && (
                  <>
                    <Txt variant="tiny" tone="ink3" accessibilityRole="header" style={{ fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginLeft: 6, marginTop: 16 }}>Usage</Txt>
                    {context && <ContextRow context={context} />}
                    {activeUsage.length ? activeUsage.map((w) => <WindowRow key={w.label} window={w} provider={chat.provider ?? undefined} />) : plan ? <>
                      <UsageRow plan={plan} />
                      {plan.week && <WeekRow week={plan.week} />}
                    </> : <Txt variant="small" tone="ink3">{chat.provider ?? "Claude"} · Usage unavailable</Txt>}
                  </>
                )}
                {pages && (
                  <SettingsSection label="On this phone">
                    <MenuRow look={LOOKS.show} title="Show" value={pages.on ? "Pages" : "One list"} detail={noteOf(SHOW, pages.on ? "pages" : "list")} choices={SHOW} selected={pages.on ? "pages" : "list"} onPick={(v) => pages.onChange(v === "pages")} />
                  </SettingsSection>
                )}
                {onAskClose && (
                  <DangerButton label="Close this chat" onPress={() => {
                    // The question comes once this sheet is away: iOS shows no sheet while another is still going.
                    next.current = onAskClose;
                    close();
                  }} footer="It closes on your Mac too." />
                )}
              </>
            )}
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}

/**
 * The chat's title bar, which opens the chat's settings when pressed: what it runs on (Ask or Auto) and its models, as
 * text under the title ("lantern · Auto · Max") and a sheet of choices, like the Mac's Permissions and Models menus. Nothing
 * opens for a Mac that can't say, or a chat whose mode it hasn't said yet. A switch restarts Claude on the Mac, so it is
 * only offered while the chat is doing nothing; "Switching…" stays in the line until the chat says it changed.
 * `children` draws the title and what is under it, given the settings line (null when there is none).
 */
export function ChatSettings({ slot, chat, plan, providerUsage, context, pages, onProblem, onClosed, waitMs = SWITCH_WAIT_MS, children }: { slot: string; /** For a Step by step chat: pages or one list. */ pages?: PagesChoice; chat: RemoteChat | undefined; /** The subscription's usage, when the Mac has said it: shown in the sheet, and in the line once it runs low. */ plan?: PlanUsage | null; providerUsage?: ProviderUsage; /** What the chat holds of its context, when the Mac has said it: shown in the line and the sheet. */ context?: { tokens: number; window: number | null } | null; onProblem: (why: string) => void; /** The chat was closed on the Mac: the screen has nothing to show any more. */ onClosed?: () => void; waitMs?: number; children: (line: string | null) => ReactNode }) {
  const { sync } = useController();
  const { supported, controls, reload } = useControls();
  const [open, setOpen] = useState(false);
  const canConversation = useMacCan("conversation");
  const [configuration, setConfiguration] = useState<ConversationSettings | null>(null);
  // The Mac didn't say them: their rows aren't held for them any more.
  const [unconfigured, setUnconfigured] = useState(false);
  useEffect(() => {
    let current = true;
    // Their rows go, and the sheet says why rather than leaving them out without a word.
    if (open && canConversation) sync.conversationSettings(slot).then((v) => { if (current) setConfiguration(v); }, (e: Error) => { if (current) { setUnconfigured(true); setProblem(`Couldn't get the provider and model: ${e.message}`); } });
    return () => { current = false; };
  }, [open, slot, chat?.provider, canConversation, sync]);
  const [closing, setClosing] = useState(false);
  const canClose = useMacCan("close");
  const canFlow = useMacCan("workflow");
  // A Mac that can change a working chat: it stops the turn and carries on, or waits for it, as asked.
  const canBusy = useMacCan("switchbusy");
  const [switching, setSwitching] = useState<Switching>(null);
  // Why the last change didn't happen: said in the sheet while it is up (it stays up now), and to the screen.
  const [problem, setProblem] = useState<string | null>(null);
  const say = (why: string) => {
    setProblem(why);
    onProblem(why);
  };

  // The switch is over once the chat reports it, or has had long enough.
  const reported = switching && (switching.kind === "mode" ? chat?.permissions === switching.to : switching.kind === "workflow" ? chat?.workflow === switching.to : chat?.preset === switching.to);
  useEffect(() => {
    if (!switching) return;
    if (reported) return setSwitching(null);
    // While the Mac holds the change (stopping the turn first), it isn't late: it says when it is applied.
    if (chat?.pending) return;
    const t = setTimeout(() => {
      setSwitching(null);
      setProblem("It didn't change. Look at Lantern on your Mac.");
      onProblem("It didn't change. Look at Lantern on your Mac.");
    }, waitMs);
    return () => clearTimeout(t);
  }, [switching, reported, onProblem, waitMs, !!chat?.pending]);

  if (!supported || !chat?.permissions) return <View style={{ flex: 1 }}>{children(null)}</View>;
  const working = chat.status === "working" || chat.status === "needs_you";
  const off = canBusy && working ? null : whyNotNow(chat);
  // A change to a working chat asks first: stop it and change it now, or once it finishes. Cancel changes nothing.
  const ask = (go: (when?: RemoteWhen) => void) => {
    if (!(canBusy && working)) return go();
    const agent = chat.provider ?? "Claude";
    Alert.alert("Change it now?", `${agent} is working. Apply now stops its turn, changes this, and tells it to carry on where it left off. Or change it once it finishes.`, [
      { text: "Apply now", onPress: () => go("now") },
      { text: "When it finishes", onPress: () => go("finished") },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const pick = (kind: "mode" | "preset" | "workflow", to: string) =>
    ask((when) => {
      // Held for later, the Mac says what waits (the chat's `pending`): nothing is late.
      if (when !== "finished") setSwitching({ kind, to });
      setProblem(null);
      const sent = kind === "mode" ? sync.setPermissions(slot, to as RemotePermissions, when) : kind === "workflow" ? sync.setWorkflow(slot, to as Exclude<RemoteWorkflow, "team">, when) : sync.setPreset(slot, to, when);
      sent.catch((e: Error) => {
        setSwitching(null);
        say(e.message);
      });
    });
  const mode = switching?.kind === "mode" ? "Switching…" : modeLabel(chat.permissions);
  // (A chat on another provider than Claude's runs on its own model: the Mac records a preset for every chat, but it isn't one it runs on.)
  const preset = switching?.kind === "preset" ? "Switching…" : chat.preset && !chat.provider ? presetName(controls, chat.preset) : null;
  // Step by step is said; a plain chat is the usual, and isn't.
  const flow = switching?.kind === "workflow" ? "Switching…" : chat.workflow && chat.workflow !== "chat" ? workflowLabel(chat.workflow) : null;
  const usage = plan ? usageOf(plan) : null;
  const providerPercent = providerUsage?.windows.filter(w => w.resets_at === null || w.resets_at * 1000 > Date.now()).reduce((n, w) => Math.max(n, Math.round(w.used * 100)), 0);
  const low = providerPercent !== undefined && providerPercent >= 80 ? providerPercent >= 100 ? "Limit reached" : `${providerPercent}% used` : usage && usage.tone !== "ok" ? (usage.tone === "stop" ? "Limit reached" : `${usage.percent}% used`) : null;
  const held = context ? contextOf(context) : null;
  // What it runs on, said first when that isn't Claude Code ("Ollama · Ask · 12k tokens"); a Claude chat's line is as it always was.
  const provider = chat.provider ?? null;
  const line = [provider, flow, mode, preset, held?.label, low].filter(Boolean).join(" · ");

  return (
    <>
      <PressScale
        accessibilityRole="button"
        accessibilityLabel="Chat settings"
        accessibilityHint="Opens this chat's permissions and models"
        onPress={() => {
          reload();
          setProblem(null);
          setOpen(true);
        }}
        haptic="select"
        scaleTo={0.98}
        style={{ flex: 1 }}
      >
        {children(line)}
      </PressScale>
      {open && (
        <SettingsSheet
          chat={chat}
          plan={plan}
          providerUsage={providerUsage}
          context={context}
          off={off}
          loading={!controls}
          workflows={canFlow && (chat.workflow === "chat" || chat.workflow === "steps") ? WORKFLOWS.map((w) => ({ value: w.value, label: w.label, hint: w.hint, off })) : []}
          onWorkflow={(v) => v !== chat.workflow && pick("workflow", v)}
          // Another provider than Claude's has no Auto mode, and the Mac's presets are Claude Code's models: neither is offered for its chat.
          configuration={configuration}
          configuring={canConversation && configuration === null && !unconfigured}
          switching={switching}
          problem={problem}
          providers={controls?.providers ?? []}
          onConfigure={(change) => ask((when) => { setProblem(null); void sync.conversationSettings(slot, change, when).then(setConfiguration).catch((e: Error) => say(e.message)); })}
          modes={MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint, off: off ?? (m.value === "auto" ? (configuration ? (configuration.capabilities.supports_auto_mode ? autoNote(controls) : noAutoOn(provider ?? configuration.provider)) : provider ? noAutoOn(provider) : autoNote(controls)) : null) }))}
          pages={pages}
          presets={(configuration ? !configuration.capabilities.supports_advisor : !!provider) ? [] : (controls?.presets ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.summary, off }))}
          onMode={(v) => v !== chat.permissions && pick("mode", v)}
          onPreset={(v) => v !== chat.preset && pick("preset", v)}
          onAskClose={canClose ? () => setClosing(true) : undefined}
          onClose={() => setOpen(false)}
        />
      )}
      {closing && (
        <CloseChatSheet
          title={chat.title?.trim() || "this chat"}
          why={chat.status === "working" || chat.status === "needs_you" ? "The agent is busy in this chat. Stop it first, then close it." : null}
          onConfirm={() => sync.close(slot).then(() => onClosed?.())}
          onClose={() => setClosing(false)}
        />
      )}
    </>
  );
}
