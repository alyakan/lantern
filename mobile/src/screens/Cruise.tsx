import { View } from "react-native";
import type { Suggestion } from "../protocol/generated/Suggestion";
import { Txt } from "../ui/components";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Dots } from "../ui/skeleton";
import { radius, shadow, space, useColors } from "../ui/theme";

/**
 * Cruise, over the message box: a pill that turns it on; then, each time the chat goes idle, the next step Claude drafted
 * from its last few turns. "Do it" sends that draft (and Cruise asks again when the turn ends); "Another" asks for a
 * different one; the ✕ stops it. It never sends anything by itself, and a real prompt (a permission, a question) always
 * breaks the loop: the chat's own card takes the box back.
 */
export function CruiseBar({ on, resting, asking, draft, error, onToggle, onDo, onAnother, onStop }: {
  on: boolean;
  /** The chat is idle: no turn running and nothing waiting on you. While it isn't, Cruise waits instead of offering a step. */
  resting: boolean;
  asking: boolean;
  draft: Suggestion | null;
  error: string | null;
  onToggle: () => void;
  onDo: () => void;
  onAnother: () => void;
  onStop: () => void;
}) {
  const colors = useColors();
  if (!on)
    return (
      <View style={{ paddingHorizontal: space.lg, paddingBottom: 6 }}>
        <PressScale
          accessibilityRole="button"
          accessibilityLabel="Cruise: suggest the next step each time the chat is idle"
          onPress={onToggle}
          haptic="select"
          scaleTo={0.97}
          style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8, borderColor: colors.rule, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.card }}
        >
          <Txt variant="small" tone="cobalt" style={{ fontWeight: "800" }}>
            ✨ Cruise
          </Txt>
          <Txt variant="small" tone="ink3">
            Suggest the next step
          </Txt>
        </PressScale>
      </View>
    );
  return (
    <FadeSlideIn from={8} ms={180} style={{ marginHorizontal: 12, marginBottom: 6 }}>
      <View style={[{ backgroundColor: colors.card, borderRadius: radius.card, padding: 12, gap: 4 }, shadow.card, { shadowOpacity: 0.06 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Txt variant="tiny" tone="cobalt" style={{ fontWeight: "800" }}>
            ✨ CRUISE ON
          </Txt>
          <View style={{ flex: 1 }} />
          {resting && !draft && !asking && (
            <PressScale accessibilityRole="button" accessibilityLabel="Suggest a next step" onPress={onAnother} hitSlop={10} haptic="select" scaleTo={0.94}>
              <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
                Next step
              </Txt>
            </PressScale>
          )}
          <PressScale accessibilityRole="button" accessibilityLabel="Stop Cruise" onPress={onStop} hitSlop={12} haptic="light" scaleTo={0.85} style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center" }}>
            <Txt variant="tiny" tone="ink2" accessibilityElementsHidden style={{ fontWeight: "700", lineHeight: 14 }}>
              ✕
            </Txt>
          </PressScale>
        </View>
        {!resting && (
          <Txt variant="small" tone="ink3">
            Waiting for this turn to end…
          </Txt>
        )}
        {resting && asking && !draft && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 }}>
            <Dots />
            <Txt variant="small" tone="ink2">
              Thinking about the next step…
            </Txt>
          </View>
        )}
        {resting && !!error && !asking && (
          <Txt variant="small" tone="stop" accessibilityRole="alert">
            {error}
          </Txt>
        )}
        {resting && draft && (
          <>
            <Txt variant="heading">{draft.title}</Txt>
            <Txt variant="small" tone="ink2">
              {draft.why}
            </Txt>
            <Txt variant="small" tone="ink3" numberOfLines={3} style={{ marginTop: 2 }}>
              “{draft.message}”
            </Txt>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <PressScale accessibilityRole="button" accessibilityLabel={`Do it: ${draft.title}`} onPress={onDo} haptic="select" scaleTo={0.96} style={{ flex: 1 }}>
                <View style={{ backgroundColor: colors.cobalt, borderRadius: radius.inner, alignItems: "center", paddingVertical: 10 }}>
                  <Txt variant="small" tone="white" style={{ fontWeight: "800" }}>
                    Do it
                  </Txt>
                </View>
              </PressScale>
              <PressScale
                accessibilityRole="button"
                accessibilityLabel={asking ? "Asking for another suggestion" : "Another suggestion"}
                accessibilityState={{ disabled: asking }}
                disabled={asking}
                onPress={onAnother}
                haptic="select"
                scaleTo={0.96}
                style={{ flex: 1 }}
              >
                <View style={{ backgroundColor: colors.paper, borderRadius: radius.inner, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, opacity: asking ? 0.6 : 1 }}>
                  {asking && <Dots size={4} />}
                  <Txt variant="small" tone="ink" style={{ fontWeight: "700" }}>
                    {asking ? "Another…" : "Another"}
                  </Txt>
                </View>
              </PressScale>
            </View>
          </>
        )}
      </View>
    </FadeSlideIn>
  );
}
