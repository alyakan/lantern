import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import { useController } from "../shell/hooks";
import { useControls } from "../shell/useControls";
import { Button, Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { colors, radius, shadow, space } from "../ui/theme";
import { autoNote, MODES, modeLabel, presetName, whyNotNow } from "../view/controls";

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
function SettingsSheet({ chat, off, loading, modes, presets, onMode, onPreset, onClose }: { chat: RemoteChat; off: string | null; loading: boolean; modes: Option[]; presets: Option[]; onMode: (v: string) => void; onPreset: (v: string) => void; onClose: () => void }) {
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
            {loading ? (
              <View accessibilityLabel="Loading" accessibilityRole="progressbar" accessible style={{ paddingVertical: 16 }}>
                <Dots />
              </View>
            ) : (
              <>
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
            <Button label="Close" kind="ghost" onPress={close} />
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
export function ChatSettings({ slot, chat, onProblem, waitMs = SWITCH_WAIT_MS, children }: { slot: string; chat: RemoteChat | undefined; onProblem: (why: string) => void; waitMs?: number; children: (line: string | null) => ReactNode }) {
  const { sync } = useController();
  const { supported, controls, reload } = useControls();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<{ kind: "mode" | "preset"; to: string } | null>(null);

  // The switch is over once the chat reports it, or has had long enough.
  const reported = switching && (switching.kind === "mode" ? chat?.permissions === switching.to : chat?.preset === switching.to);
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
  const pick = (kind: "mode" | "preset", to: string) => {
    setSwitching({ kind, to });
    const sent = kind === "mode" ? sync.setPermissions(slot, to as RemotePermissions) : sync.setPreset(slot, to);
    sent.catch((e: Error) => {
      setSwitching(null);
      onProblem(e.message);
    });
  };
  const mode = switching?.kind === "mode" ? "Switching…" : modeLabel(chat.permissions);
  const preset = switching?.kind === "preset" ? "Switching…" : chat.preset ? presetName(controls, chat.preset) : null;
  const line = [mode, preset].filter(Boolean).join(" · ");

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
          off={off}
          loading={!controls}
          modes={MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint, off: off ?? (m.value === "auto" ? autoNote(controls) : null) }))}
          presets={(controls?.presets ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.summary, off }))}
          onMode={(v) => v !== chat.permissions && pick("mode", v)}
          onPreset={(v) => v !== chat.preset && pick("preset", v)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
