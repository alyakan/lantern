import type { ConversationSettings } from "../sync/sync";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import type { RemoteWorkflow } from "../protocol/generated/RemoteWorkflow";
import type { PlanUsage } from "../sync/reducer";
import { useController } from "../shell/hooks";
import { useControls, useMacCan } from "../shell/useControls";
import { ContextRow, UsageRow, WeekRow } from "./ChatExtras";
import { CloseChatSheet } from "./CloseChat";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";
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

interface Option {
  value: string;
  label: string;
  hint: string;
  /** Why it can't be picked now; the row is shown but off. */
  off?: string | null;
}

/** One choice of a few, as a row: its name and what it does, or why it can't be picked now. */
function OptionRow({ option, selected, onPick }: { option: Option; selected: boolean; onPick: () => void }) {
  const colors = useColors();
  return (
    <PressScale
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={{ selected, checked: selected, disabled: !!option.off }}
      disabled={!!option.off}
      opacity={option.off ? 0.5 : 1}
      haptic="select"
      scaleTo={0.98}
      onPress={onPick}
      style={{ borderRadius: radius.inner, borderWidth: 1, borderColor: selected ? colors.ink : colors.rule, backgroundColor: selected ? colors.paper : colors.card, padding: 12, gap: 2 }}
    >
      <Txt variant="body" style={{ fontWeight: "700" }}>
        {selected ? `${option.label} ✓` : option.label}
      </Txt>
      <Txt variant="small" tone="ink2">
        {option.off ?? option.hint}
      </Txt>
    </PressScale>
  );
}

interface SettingsSection {
  id: string;
  title: string;
  value: string;
  options: Option[];
  selected: string;
  onPick: (value: string) => void;
}

/** A setting's current value, opening its choices inline without changing pages. */
function SettingsLink({ title, value, expanded, onPress }: { title: string; value: string; expanded: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={`${title}, ${value}`} accessibilityHint={expanded ? "Collapses choices" : "Expands choices"} accessibilityState={{ expanded }} onPress={onPress} haptic="select" scaleTo={0.98}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: colors.card, borderRadius: radius.inner }}>
      <Txt variant="body" style={{ flexShrink: 0 }}>{title}</Txt>
      <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flex: 1, textAlign: "right" }}>{value}</Txt>
      <Txt variant="body" tone="ink3" accessibilityElementsHidden>{expanded ? "⌃" : "⌄"}</Txt>
    </PressScale>
  );
}

/** The chat's settings, as a sheet: what it runs on (Ask or Auto) and its models. A switch closes the sheet, and the title bar says "Switching…" until the chat does. */
function SettingsSheet({ chat, plan, context, off, loading, workflows, modes, presets, pages, onWorkflow, onMode, onPreset, onAskClose, onClose, configuration, providers, onConfigure }: { configuration?: ConversationSettings | null; providers?: { id: string; name: string }[]; onConfigure?: (change: {provider?: string; model?: string | null; effort?: string | null}) => void; chat: RemoteChat; /** Step by step's pages or one list: how this phone shows the chat (Claude isn't restarted). */ pages?: PagesChoice; /** The subscription's usage, when the Mac has said it. */ plan?: PlanUsage | null; /** What the chat holds of its context, when the Mac has said it. */ context?: { tokens: number; window: number | null } | null; off: string | null; loading: boolean; /** Empty when this Mac can't switch it, or the chat leads a team. */ workflows: Option[]; modes: Option[]; presets: Option[]; onWorkflow: (v: string) => void; onMode: (v: string) => void; onPreset: (v: string) => void; /** Present when this Mac can close chats. */ onAskClose?: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const next = useRef<(() => void) | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((current) => current === id ? null : id);
  const sections: SettingsSection[] = [];
  if (configuration && onConfigure) {
    const provider = providers?.find((p) => p.id === configuration.provider)?.name ?? chat.provider ?? (configuration.provider === "claude" ? "Claude" : configuration.provider);
    if (providers?.length) sections.push({ id: "provider", title: "Provider", value: provider, selected: configuration.provider,
      options: providers.map((p) => ({ value: p.id, label: p.name, hint: "Continue this conversation with this provider", off })),
      onPick: (provider) => onConfigure({ provider }) });
    if (configuration.capabilities.model_switchable) sections.push({ id: "model", title: "Model", value: configuration.model ?? "Provider default", selected: configuration.model ?? "",
      options: [{ value: "", label: "Provider default", hint: "Used for the next turn", off }, ...configuration.models.map((m) => ({ value: m, label: m, hint: "Used for the next turn", off }))],
      onPick: (model) => onConfigure({ model: model || null }) });
    if (configuration.capabilities.supports_effort && configuration.effort_levels.length) sections.push({ id: "effort", title: "Effort", value: configuration.effort ?? "Provider default", selected: configuration.effort ?? "",
      options: configuration.effort_levels.map((e) => ({ value: e, label: e, hint: "Thinking effort", off })), onPick: (effort) => onConfigure({ effort }) });
  }
  if (workflows.length) sections.push({ id: "workflow", title: "Workflow", value: workflowLabel(chat.workflow ?? "chat"), selected: chat.workflow ?? "", options: workflows, onPick: onWorkflow });
  if (pages) sections.push({ id: "show", title: "Show", value: pages.on ? "Pages" : "One list", selected: pages.on ? "pages" : "list", options: SHOW, onPick: (v) => pages.onChange(v === "pages") });
  sections.push({ id: "permissions", title: "Permissions", value: modeLabel(chat.permissions ?? "ask"), selected: chat.permissions ?? "", options: modes, onPick: onMode });
  if (presets.length) sections.push({ id: "presets", title: "Model preset", value: presets.find((p) => p.value === chat.preset)?.label ?? "Standard", selected: chat.preset ?? "", options: presets, onPick: onPreset });
  const hasUsage = !!context || !!plan;
  return (
    <Sheet size="large" onClose={() => { onClose(); next.current?.(); }}>
      {(close, scroll) => (
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 10, gap: 8 }}>
            <Txt variant="body" accessibilityRole="header" style={{ flex: 1, fontWeight: "700" }}>Chat settings</Txt>
            <PressScale accessibilityRole="button" accessibilityLabel="Done" onPress={close} hitSlop={8} style={{ minWidth: 60, minHeight: 44, alignItems: "flex-end", justifyContent: "center" }}><Txt variant="body" tone="cobalt" style={{ fontWeight: "700" }}>Done</Txt></PressScale>
          </View>
          <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 8 }}>
            <Txt variant="small" tone="ink2">{off ?? "Changes apply to this conversation."}</Txt>
            {loading ? (
              <View accessibilityLabel="Loading" accessibilityRole="progressbar" accessible style={{ paddingVertical: 16 }}><Dots /></View>
            ) : (
              <>
                {sections.map((section) => (
                  <Fragment key={section.id}>
                    <SettingsLink title={section.title} value={section.value} expanded={expanded === section.id} onPress={() => toggle(section.id)} />
                    {expanded === section.id && <View style={{ gap: 6, paddingHorizontal: 6 }}>
                      {section.options.map((option) => <OptionRow key={option.value} option={option} selected={option.value === section.selected} onPick={() => { section.onPick(option.value); close(); }} />)}
                    </View>}
                  </Fragment>
                ))}
                {hasUsage && <SettingsLink title="Usage & context" value={context ? contextOf(context).label : "View usage"} expanded={expanded === "usage"} onPress={() => toggle("usage")} />}
                {expanded === "usage" && <>
                  {context && <ContextRow context={context} />}
                  {plan && <UsageRow plan={plan} />}
                  {plan?.week && <WeekRow week={plan.week} />}
                </>}
                {onAskClose && (
                  <PressScale accessibilityRole="button" accessibilityLabel="Close this chat" onPress={() => {
                    // The question comes once this sheet is away: iOS shows no sheet while another is still going.
                    next.current = onAskClose;
                    close();
                  }} haptic="select" scaleTo={0.98} style={{ marginTop: 8, paddingVertical: 12, alignItems: "center" }}>
                    <Txt variant="body" tone="stop" style={{ fontWeight: "700" }}>Close this chat</Txt>
                  </PressScale>
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
export function ChatSettings({ slot, chat, plan, context, pages, onProblem, onClosed, waitMs = SWITCH_WAIT_MS, children }: { slot: string; /** For a Step by step chat: pages or one list. */ pages?: PagesChoice; chat: RemoteChat | undefined; /** The subscription's usage, when the Mac has said it: shown in the sheet, and in the line once it runs low. */ plan?: PlanUsage | null; /** What the chat holds of its context, when the Mac has said it: shown in the line and the sheet. */ context?: { tokens: number; window: number | null } | null; onProblem: (why: string) => void; /** The chat was closed on the Mac: the screen has nothing to show any more. */ onClosed?: () => void; waitMs?: number; children: (line: string | null) => ReactNode }) {
  const { sync } = useController();
  const { supported, controls, reload } = useControls();
  const [open, setOpen] = useState(false);
  const canConversation = useMacCan("conversation");
  const [configuration, setConfiguration] = useState<ConversationSettings | null>(null);
  useEffect(() => {
    let current = true;
    if (open && canConversation) sync.conversationSettings(slot).then((v) => { if (current) setConfiguration(v); }, () => {});
    return () => { current = false; };
  }, [open, slot, chat?.provider, canConversation, sync]);
  const [closing, setClosing] = useState(false);
  const canClose = useMacCan("close");
  const canFlow = useMacCan("workflow");
  const [switching, setSwitching] = useState<{ kind: "mode" | "preset" | "workflow"; to: string } | null>(null);

  // The switch is over once the chat reports it, or has had long enough.
  const reported = switching && (switching.kind === "mode" ? chat?.permissions === switching.to : switching.kind === "workflow" ? chat?.workflow === switching.to : chat?.preset === switching.to);
  useEffect(() => {
    if (!switching) return;
    if (reported) return setSwitching(null);
    const t = setTimeout(() => {
      setSwitching(null);
      onProblem("It didn't change. Look at Lantern on your Mac.");
    }, waitMs);
    return () => clearTimeout(t);
  }, [switching, reported, onProblem, waitMs]);

  if (!supported || !chat?.permissions) return <View style={{ flex: 1 }}>{children(null)}</View>;
  const off = whyNotNow(chat);
  const pick = (kind: "mode" | "preset" | "workflow", to: string) => {
    setSwitching({ kind, to });
    const sent = kind === "mode" ? sync.setPermissions(slot, to as RemotePermissions) : kind === "workflow" ? sync.setWorkflow(slot, to as Exclude<RemoteWorkflow, "team">) : sync.setPreset(slot, to);
    sent.catch((e: Error) => {
      setSwitching(null);
      onProblem(e.message);
    });
  };
  const mode = switching?.kind === "mode" ? "Switching…" : modeLabel(chat.permissions);
  // (A chat on another provider than Claude's runs on its own model: the Mac records a preset for every chat, but it isn't one it runs on.)
  const preset = switching?.kind === "preset" ? "Switching…" : chat.preset && !chat.provider ? presetName(controls, chat.preset) : null;
  // Step by step is said; a plain chat is the usual, and isn't.
  const flow = switching?.kind === "workflow" ? "Switching…" : chat.workflow && chat.workflow !== "chat" ? workflowLabel(chat.workflow) : null;
  const usage = plan ? usageOf(plan) : null;
  const low = usage && usage.tone !== "ok" ? (usage.tone === "stop" ? "Limit reached" : `${usage.percent}% used`) : null;
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
          context={context}
          off={off}
          loading={!controls}
          workflows={canFlow && (chat.workflow === "chat" || chat.workflow === "steps") ? WORKFLOWS.map((w) => ({ value: w.value, label: w.label, hint: w.hint, off })) : []}
          onWorkflow={(v) => v !== chat.workflow && pick("workflow", v)}
          // Another provider than Claude's has no Auto mode, and the Mac's presets are Claude Code's models: neither is offered for its chat.
          configuration={configuration}
          providers={controls?.providers ?? []}
          onConfigure={(change) => { void sync.conversationSettings(slot, change).then(setConfiguration).catch((e: Error) => onProblem(e.message)); }}
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
          why={chat.status === "working" || chat.status === "needs_you" ? "Claude is busy in this chat. Stop it first, then close it." : null}
          onConfirm={() => sync.close(slot).then(() => onClosed?.())}
          onClose={() => setClosing(false)}
        />
      )}
    </>
  );
}
