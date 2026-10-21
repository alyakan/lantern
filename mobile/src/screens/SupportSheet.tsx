import { useEffect } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTipJar, useTips } from "../shell/tipsContext";
import { Button, Txt } from "../ui/components";
import { buzz, FadeSlideIn, PopIn, PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Bar, Dots, Pulse } from "../ui/skeleton";
import { colors, radius, shadow, space } from "../ui/theme";

/** How long the thank-you stays before the sheet goes. */
export const THANKS_MS = 2400;

const MARKS = ["☕", "💛", "✨"];

/** The tips before the store has said which there are: three rows. */
function TipsSkeleton() {
  return (
    <Pulse label="Looking up the tips" style={{ gap: 10 }}>
      <View style={{ gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.paper, borderRadius: radius.inner + 2, padding: 14 }}>
            <Bar w={30} h={30} r={15} />
            <Bar w={`${46 - i * 6}%`} h={14} />
            <View style={{ flex: 1 }} />
            <Bar w={46} h={14} />
          </View>
        ))}
      </View>
    </Pulse>
  );
}

/**
 * "Support development": an optional tip, nothing locked behind it. The tips come from the store; while they do there is
 * their shape, and if the store can't be reached it says so with a way to try again. A tip that went through is thanked,
 * and the sheet closes itself a moment later.
 */
export function SupportSheet({ onClose }: { onClose: () => void }) {
  const jar = useTipJar();
  const tips = useTips();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    void jar.load();
  }, [jar]);

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <Content
          close={close}
          bottom={Math.max(insets.bottom, 16) + 8}
          thanked={tips.phase === "thanked"}
          tipped={tips.lastTipAt !== null}
          onThanksSeen={() => {
            jar.acknowledge();
            close();
          }}
        />
      )}
    </Sheet>
  );
}

function Content({ close, bottom, thanked, tipped, onThanksSeen }: { close: () => void; bottom: number; thanked: boolean; tipped: boolean; onThanksSeen: () => void }) {
  const jar = useTipJar();
  const tips = useTips();
  const busy = tips.phase === "purchasing";

  useEffect(() => {
    if (!thanked) return;
    buzz("success");
    const t = setTimeout(onThanksSeen, THANKS_MS);
    return () => clearTimeout(t);
  }, [thanked, onThanksSeen]);

  return (
    <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: bottom, gap: 14 }, shadow.float]}>
      {thanked ? (
        <View accessibilityRole="alert" style={{ alignItems: "center", gap: 10, paddingVertical: 28 }}>
          <PopIn>
            <Txt variant="title" style={{ fontSize: 44, lineHeight: 52 }}>
              💛
            </Txt>
          </PopIn>
          <FadeSlideIn from={8} delay={120}>
            <Txt variant="title" style={{ textAlign: "center" }}>
              Thank you
            </Txt>
          </FadeSlideIn>
          <FadeSlideIn from={8} delay={220}>
            <Txt variant="small" tone="ink2" style={{ textAlign: "center" }}>
              That means a lot. Everything stays free either way.
            </Txt>
          </FadeSlideIn>
        </View>
      ) : (
        <>
          <Txt variant="title" accessibilityRole="header">
            Support development
          </Txt>
          <Txt variant="small" tone="ink2">
            {tipped ? "You've supported Lantern before: thank you. Everything below is only ever a tip, and everything stays free either way." : "Lantern is made by one person. If it helps you, you can leave a small thanks. Everything stays free either way."}
          </Txt>

          {tips.phase === "loading" && <TipsSkeleton />}

          {tips.phase === "unavailable" && (
            <View style={{ gap: 10 }}>
              <Txt variant="small" tone="ink2" accessibilityRole="alert">
                {tips.error}
              </Txt>
              <Button label="Try again" kind="ghost" onPress={() => void jar.load()} />
            </View>
          )}

          {(tips.phase === "ready" || tips.phase === "purchasing" || tips.phase === "failed") && (
            <View style={{ gap: 10 }}>
              {tips.tips.map((tip, i) => (
                <FadeSlideIn key={tip.id} from={10} delay={i * 70}>
                  <PressScale accessibilityRole="button" accessibilityLabel={`${tip.name}, ${tip.price}`} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void jar.tip(tip.id)} scaleTo={0.97} haptic="select" opacity={busy ? 0.55 : 1} style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.paper, borderRadius: radius.inner + 2, paddingHorizontal: 14, paddingVertical: 14, minHeight: 56 }}>
                    <Txt variant="heading" accessibilityElementsHidden style={{ width: 30, textAlign: "center" }}>
                      {MARKS[i % MARKS.length]}
                    </Txt>
                    <Txt variant="body" style={{ flex: 1, fontWeight: "600" }}>
                      {tip.name}
                    </Txt>
                    <Txt variant="body" tone="ink2" style={{ fontWeight: "700" }}>
                      {tip.price}
                    </Txt>
                  </PressScale>
                </FadeSlideIn>
              ))}
              {busy && (
                <View accessibilityRole="progressbar" accessibilityLabel="Waiting for the store" accessible style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Dots />
                  <Txt variant="small" tone="ink3">
                    Waiting for the store
                  </Txt>
                </View>
              )}
              {tips.awaitingApproval && !busy && (
                <Txt variant="small" tone="ink2">
                  Your tip is waiting for approval. It goes through when it is approved.
                </Txt>
              )}
              {tips.phase === "failed" && (
                <Txt variant="small" tone="stop" accessibilityRole="alert">
                  {tips.error}
                </Txt>
              )}
            </View>
          )}

          <Button label="Close" kind="ghost" disabled={busy} onPress={close} />
        </>
      )}
    </View>
  );
}
