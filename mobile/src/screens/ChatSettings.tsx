import { useEffect, useState, type ReactNode } from "react";
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
import { Button, Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { radius, shadow, space, useColors } from "../ui/theme";
import { autoNote, MODES, modeLabel, noAutoOn, presetName, whyNotNow, WORKFLOWS, workflowLabel } from "../view/controls";
import { contextOf, usageOf } from "../view/plan";

/** How long "Switching…" waits for the chat to say it changed before it gives up and says so. */
export const SWITCH_WAIT_MS = 20_000;

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

/** The chat's settings, as a sheet: what it runs on (Ask or Auto) and its models. A switch closes the sheet, and the title bar says "Switching…" until the chat does. */
function SettingsSheet({ chat, plan, context, off, loading, workflows, modes, presets, onWorkflow, onMode, onPreset, onAskClose, onClose }: { chat: RemoteChat; /** The subscription's usage, when the Mac has said it. */ plan?: PlanUsage | null; /** What the chat holds of its context, when the Mac has said it. */ context?: { tokens: number; window: number | null } | null; off: string | null; loading: boolean; /** Empty when this Mac can't switch it, or the chat leads a team. */ workflows: Option[]; modes: Option[]; presets: Option[]; onWorkflow: (v: string) => void; onMode: (v: string) => void; onPreset: (v: string) => void; /** Present when this Mac can close chats. */ onAskClose?: () => void; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, flexShrink: 1 }, shadow.float]}>
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 8 }}>
            <Txt variant="title" accessibilityRole="header">
              Chat settings
            </Txt>
            <Txt variant="small" tone="ink2">
              {off ?? "Claude restarts on the same conversation when you change these."}
            </Txt>
            {context && <ContextRow context={context} />}
            {plan && <UsageRow plan={plan} />}
            {plan?.week && <WeekRow week={plan.week} />}
            {loading ? (
              <View accessibilityLabel="Loading" accessibilityRole="progressbar" accessible style={{ paddingVertical: 16 }}>
                <Dots />
              </View>
            ) : (
              <>
                {workflows.length > 0 && (
                  <>
                    <Txt variant="small" style={{ fontWeight: "700", marginTop: 8 }} accessibilityRole="header">
                      Workflow
                    </Txt>
                    {workflows.map((o) => (
                      <OptionRow
                        key={o.value}
                        option={o}
                        selected={o.value === chat.workflow}
                        onPick={() => {
                          onWorkflow(o.value);
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
                <Txt variant="small" style={{ fontWeight: "700", marginTop: 8 }} accessibilityRole="header">
                  Permissions
                </Txt>
                {modes.map((o) => (
                  <OptionRow
                    key={o.value}
                    option={o}
                    selected={o.value === chat.permissions}
                    onPick={() => {
                      onMode(o.value);
                      close();
                    }}
                  />
                ))}
                {presets.length > 0 && (
                  <>
                    <Txt variant="small" style={{ fontWeight: "700", marginTop: 8 }} accessibilityRole="header">
                      Models
                    </Txt>
                    {presets.map((o) => (
                      <OptionRow
                        key={o.value}
                        option={o}
                        selected={o.value === chat.preset}
                        onPick={() => {
                          onPreset(o.value);
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
            {onAskClose && (
              <PressScale
                accessibilityRole="button"
                accessibilityLabel="Close this chat"
                onPress={() => {
                  close();
                  onAskClose();
                }}
                haptic="select"
                scaleTo={0.98}
                style={{ marginTop: 8, paddingVertical: 12, alignItems: "center" }}
              >
                <Txt variant="body" tone="stop" style={{ fontWeight: "700" }}>
                  Close this chat
                </Txt>
              </PressScale>
            )}
            <Button label="Done" kind="ghost" onPress={close} />
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
export function ChatSettings({ slot, chat, plan, context, onProblem, onClosed, waitMs = SWITCH_WAIT_MS, children }: { slot: string; chat: RemoteChat | undefined; /** The subscription's usage, when the Mac has said it: shown in the sheet, and in the line once it runs low. */ plan?: PlanUsage | null; /** What the chat holds of its context, when the Mac has said it: shown in the line and the sheet. */ context?: { tokens: number; window: number | null } | null; onProblem: (why: string) => void; /** The chat was closed on the Mac: the screen has nothing to show any more. */ onClosed?: () => void; waitMs?: number; children: (line: string | null) => ReactNode }) {
  const { sync } = useController();
  const { supported, controls, reload } = useControls();
  const [open, setOpen] = useState(false);
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
          modes={MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint, off: off ?? (m.value === "auto" ? (provider ? noAutoOn(provider) : autoNote(controls)) : null) }))}
          presets={provider ? [] : (controls?.presets ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.summary, off }))}
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
