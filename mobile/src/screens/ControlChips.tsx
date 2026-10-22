import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import { useController } from "../shell/hooks";
import { useControls } from "../shell/useControls";
import { Button, Chip, Txt } from "../ui/components";
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

/** A bottom sheet of options, one picked. A row that is off says why under its name. */
export function OptionSheet({ title, note, options, selected, loading, onPick, onClose }: { title: string; note?: string | null; options: Option[]; selected: string | null; loading?: boolean; onPick: (value: string) => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 8 }, shadow.float]}>
          <Txt variant="heading" accessibilityRole="header">
            {title}
          </Txt>
          {note && (
            <Txt variant="small" tone="ink2">
              {note}
            </Txt>
          )}
          {loading ? (
            <View accessibilityLabel="Loading" accessibilityRole="progressbar" accessible style={{ paddingVertical: 16 }}>
              <Dots />
            </View>
          ) : (
            options.map((o) => {
              const on = o.value === selected;
              return (
                <PressScale
                  key={o.value}
                  accessibilityRole="radio"
                  accessibilityLabel={o.label}
                  accessibilityState={{ selected: on, checked: on, disabled: !!o.off }}
                  disabled={!!o.off}
                  opacity={o.off ? 0.5 : 1}
                  haptic="select"
                  scaleTo={0.98}
                  onPress={() => {
                    onPick(o.value);
                    close();
                  }}
                  style={{ borderRadius: radius.inner, borderWidth: 1, borderColor: on ? colors.ink : colors.rule, backgroundColor: on ? colors.paper : colors.card, padding: 12, gap: 2 }}
                >
                  <Txt variant="body" style={{ fontWeight: "700" }}>
                    {on ? `${o.label} ✓` : o.label}
                  </Txt>
                  <Txt variant="small" tone="ink2">
                    {o.off ?? o.hint}
                  </Txt>
                </PressScale>
              );
            })
          )}
          <Button label="Close" kind="ghost" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}

/**
 * Under a chat's title: what it runs on (Ask or Auto, and the preset of models), each a chip that opens its options, like
 * the chips under the Mac's chat box. Nothing for a Mac that can't say, or a chat whose mode it hasn't said yet. A switch
 * restarts Claude on the Mac, so it is only offered while the chat is doing nothing; "Switching…" stays until the chat says it
 * changed.
 */
export function ControlChips({ slot, chat, onProblem, waitMs = SWITCH_WAIT_MS }: { slot: string; chat: RemoteChat | undefined; onProblem: (why: string) => void; waitMs?: number }) {
  const { sync } = useController();
  const { supported, controls, reload } = useControls();
  const [sheet, setSheet] = useState<"mode" | "preset" | null>(null);
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

  if (!supported || !chat?.permissions) return null;
  const off = whyNotNow(chat);
  const open = (which: "mode" | "preset") => {
    reload();
    setSheet(which);
  };
  const pick = (kind: "mode" | "preset", to: string) => {
    setSwitching({ kind, to });
    const sent = kind === "mode" ? sync.setPermissions(slot, to as RemotePermissions) : sync.setPreset(slot, to);
    sent.catch((e: Error) => {
      setSwitching(null);
      onProblem(e.message);
    });
  };
  const modeText = switching?.kind === "mode" ? "Switching…" : modeLabel(chat.permissions);
  const presetText = switching?.kind === "preset" ? "Switching…" : chat.preset ? presetName(controls, chat.preset) : null;

  return (
    <>
      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingBottom: 8 }}>
        <Chip onPress={() => open("mode")}>{`${modeText} ▾`}</Chip>
        {presetText && <Chip onPress={() => open("preset")}>{`${presetText} ▾`}</Chip>}
      </View>
      {sheet === "mode" && (
        <OptionSheet
          title="Permissions"
          note={off ?? "Claude restarts on the same conversation when you switch."}
          selected={chat.permissions}
          loading={!controls}
          options={MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint, off: off ?? (m.value === "auto" ? autoNote(controls) : null) }))}
          onPick={(v) => v !== chat.permissions && pick("mode", v)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "preset" && (
        <OptionSheet
          title="Models"
          note={off ?? "Which model does what in this chat. Claude restarts on the same conversation when you switch."}
          selected={chat.preset}
          loading={!controls}
          options={(controls?.presets ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.summary, off }))}
          onPick={(v) => v !== chat.preset && pick("preset", v)}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}
