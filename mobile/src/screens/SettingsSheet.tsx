import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LanternSpeech } from "../../modules/lantern-speech";
import { loadVoiceEngine, saveVoiceEngine, type VoiceEngine } from "../prefs";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { LOOKS, SettingsSection, SheetHeader, Tile } from "../ui/Settings";
import { space, useColors } from "../ui/theme";

/** Three sliders, each with its knob somewhere else: Settings. */
export function SettingsGlyph({ color, size = 18 }: { color: string; size?: number }) {
  const knob = size * 0.34;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, justifyContent: "space-between", paddingVertical: size * 0.08 }}>
      {[0.2, 0.65, 0.4].map((at, i) => (
        <View key={i} style={{ height: knob, justifyContent: "center" }}>
          <View style={{ height: 1.5, borderRadius: 1, backgroundColor: color }} />
          <View style={{ position: "absolute", left: (size - knob) * at, width: knob, height: knob, borderRadius: knob / 2, borderWidth: 1.5, borderColor: color }} />
        </View>
      ))}
    </View>
  );
}

/** iOS 26's model where the phone has it (modules/lantern-speech); the older recognizer, on-device where it can, where it hasn't. */
const ENGINES: { value: VoiceEngine; title: string; detail: string }[] = [
  LanternSpeech
    ? { value: "model", title: "iOS 26 speech model", detail: "Uses the phone's own speech model where it can. It downloads the first time you dictate in a language; until then, Apple's speech service may stand in." }
    : { value: "model", title: "This phone's recognizer", detail: "Listens on the phone where it can; for some languages, Apple's speech service stands in." },
  { value: "server", title: "Apple's speech service", detail: "Sends what you say to Apple to be written out. Try it if the model mishears you." },
];

/** This phone's own settings (nothing here is on the Mac): for now, what turns speech into text in the message box. */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void loadVoiceEngine().then((e) => live.current && setEngine(e));
    return () => {
      live.current = false;
    };
  }, []);
  const pick = (e: VoiceEngine) => {
    setEngine(e);
    void saveVoiceEngine(e);
  };
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <SheetHeader title="Voice typing" onDone={close} />
          <View style={{ paddingHorizontal: space.lg, gap: 6 }}>
            <SettingsSection label="Turns your words into text" footer="For this phone only.">
              {ENGINES.map((o) => {
                const on = engine === o.value;
                return (
                  <PressScale key={o.value} accessibilityRole="radio" accessibilityLabel={o.title} accessibilityHint={o.detail} accessibilityState={{ checked: on }} haptic="select" scaleTo={0.99} onPress={() => pick(o.value)} style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 11, paddingHorizontal: 12, minHeight: 46 }}>
                    <Tile {...(o.value === "model" ? LOOKS.voice : { symbol: "network", glyph: "☁", tint: "#2f5bff" })} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="body">{o.title}</Txt>
                      <Txt variant="tiny" tone="ink3">
                        {o.detail}
                      </Txt>
                    </View>
                    <Txt variant="body" style={{ color: colors.cobalt, fontWeight: "700", opacity: on ? 1 : 0 }}>
                      ✓
                    </Txt>
                  </PressScale>
                );
              })}
            </SettingsSection>
          </View>
        </View>
      )}
    </Sheet>
  );
}
