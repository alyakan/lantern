import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { loadVoiceEngine, saveVoiceEngine, type VoiceEngine } from "../prefs";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";

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

const ENGINES: { value: VoiceEngine; title: string; detail: string }[] = [
  { value: "model", title: "iOS 26 speech model", detail: "Listens on the phone. Downloaded the first time you dictate in a language; until then, and before iOS 26, the older recognizer is used." },
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
      {() => (
        <View style={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 6 }}>
          <Txt variant="heading" accessibilityRole="header">
            Settings
          </Txt>
          <Txt variant="small" tone="ink2" style={{ marginBottom: 8 }}>
            For this phone only.
          </Txt>
          <Txt variant="small" tone="ink3" accessibilityRole="header" style={{ fontWeight: "600" }}>
            Voice typing
          </Txt>
          <View accessibilityRole="radiogroup" style={{ backgroundColor: colors.card, borderRadius: radius.inner, borderWidth: 1, borderColor: colors.rule, overflow: "hidden" }}>
            {ENGINES.map((o, i) => {
              const on = engine === o.value;
              return (
                <PressScale
                  key={o.value}
                  accessibilityRole="radio"
                  accessibilityLabel={o.title}
                  accessibilityHint={o.detail}
                  accessibilityState={{ checked: on }}
                  haptic="select"
                  scaleTo={0.98}
                  onPress={() => pick(o.value)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, minHeight: 44, borderTopWidth: i ? 1 : 0, borderTopColor: colors.rule }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt variant="body">{o.title}</Txt>
                    <Txt variant="small" tone="ink3">
                      {o.detail}
                    </Txt>
                  </View>
                  <Txt variant="body" style={{ color: colors.cobalt, fontWeight: "700", opacity: on ? 1 : 0 }}>
                    ✓
                  </Txt>
                </PressScale>
              );
            })}
          </View>
        </View>
      )}
    </Sheet>
  );
}
