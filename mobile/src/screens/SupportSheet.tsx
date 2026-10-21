import { useEffect } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTipJar, useTips } from "../shell/tipsContext";
import { EMBER } from "../ui/accent";
import { Button, Txt } from "../ui/components";
import { buzz, FadeSlideIn, PopIn, PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Bar, Dots, Pulse } from "../ui/skeleton";
import { colors, radius, shadow, space } from "../ui/theme";

/** How long the thank-you stays before the sheet goes. */
export const THANKS_MS = 2400;

/** Where the two documents a subscription has to link to are. */
export const PRIVACY_URL = "https://alyakan.github.io/lantern/privacy.html";
export const TERMS_URL = Platform.OS === "ios" ? "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/" : "https://play.google.com/about/play-terms/";

const MARKS = ["☕", "💛", "✨"];

/** The tips and pledges before the store has said which there are: rows. */
function TipsSkeleton() {
  const row = (w: number, i: number) => (
    <View key={`${w}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.paper, borderRadius: radius.inner + 2, padding: 14 }}>
      <Bar w={30} h={30} r={15} />
      <Bar w={`${w - i * 6}%`} h={14} />
      <View style={{ flex: 1 }} />
      <Bar w={46} h={14} />
    </View>
  );
  return (
    <Pulse label="Looking up the tips" style={{ gap: 10 }}>
      <View style={{ gap: 10 }}>
        {[0, 1, 2].map((i) => row(46, i))}
        <Bar w={120} h={12} style={{ marginTop: 6 }} />
        {[0, 1].map((i) => row(40, i))}
      </View>
    </Pulse>
  );
}

const link = (url: string) => () => void Linking.openURL(url).catch(() => {});

/**
 * "Support development": optional tips and optional pledges, nothing the app needs behind either. The tips come from the
 * store; while they do there is their shape, and if the store can't be reached it says so with a way to try again. A tip or
 * pledge that went through is thanked, and the sheet closes itself a moment later. A regular (someone with a running
 * pledge) is told so, and can manage the pledge.
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
          onThanksSeen={() => {
            jar.acknowledge();
            close();
          }}
        />
      )}
    </Sheet>
  );
}

function Content({ close, bottom, thanked, onThanksSeen }: { close: () => void; bottom: number; thanked: boolean; onThanksSeen: () => void }) {
  const jar = useTipJar();
  const tips = useTips();
  const busy = tips.phase === "purchasing";
  const tipped = tips.lastTipAt !== null || tips.pledger;

  useEffect(() => {
    if (!thanked) return;
    buzz("success");
    const t = setTimeout(onThanksSeen, THANKS_MS);
    return () => clearTimeout(t);
  }, [thanked, onThanksSeen]);

  return (
    <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, flexShrink: 1 }, shadow.float]}>
      {thanked ? (
        <View accessibilityRole="alert" style={{ alignItems: "center", gap: 10, paddingVertical: 28, paddingHorizontal: space.xl, paddingBottom: bottom + 8 }}>
          <PopIn>
            <Txt variant="title" style={{ fontSize: 44, lineHeight: 52 }}>
              {tips.thanksFor === "pledge" ? "🔥" : "💛"}
            </Txt>
          </PopIn>
          <FadeSlideIn from={8} delay={120}>
            <Txt variant="title" style={{ textAlign: "center" }}>
              Thank you
            </Txt>
          </FadeSlideIn>
          <FadeSlideIn from={8} delay={220}>
            <Txt variant="small" tone="ink2" style={{ textAlign: "center" }}>
              {tips.thanksFor === "pledge" ? "You're a regular now: Ember glows for you. Everything else stays free for everyone." : "That means a lot. Everything stays free either way."}
            </Txt>
          </FadeSlideIn>
        </View>
      ) : (
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: space.xl, paddingBottom: bottom, gap: 14 }}>
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

              {tips.pledges.length > 0 && (
                <View style={{ gap: 10, marginTop: 6 }}>
                  <Txt variant="tiny" tone="ink2" accessibilityRole="header" style={{ fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" }}>
                    Or become a regular
                  </Txt>

                  {tips.pledger ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.paper, borderRadius: radius.inner + 2, padding: 14 }}>
                      <Txt variant="heading" accessibilityElementsHidden>
                        🔥
                      </Txt>
                      <Txt variant="small" style={{ flex: 1, fontWeight: "600" }}>
                        You're a regular here: Ember glows for you. Thank you.
                      </Txt>
                      <PressScale accessibilityRole="button" accessibilityLabel="Manage pledge" onPress={() => void jar.manage()} hitSlop={10} haptic="select" scaleTo={0.92}>
                        <Txt variant="small" style={{ fontWeight: "700", color: EMBER }}>
                          Manage
                        </Txt>
                      </PressScale>
                    </View>
                  ) : (
                    <>
                      {tips.pledges.map((pledge) => (
                        <PressScale key={pledge.id} accessibilityRole="button" accessibilityLabel={`${pledge.name}, ${pledge.price}`} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void jar.pledge(pledge.id)} scaleTo={0.97} haptic="select" opacity={busy ? 0.55 : 1} style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.paper, borderRadius: radius.inner + 2, paddingHorizontal: 14, paddingVertical: 14, minHeight: 56 }}>
                          <Txt variant="heading" accessibilityElementsHidden style={{ width: 30, textAlign: "center" }}>
                            🔥
                          </Txt>
                          <View style={{ flex: 1 }}>
                            <Txt variant="body" style={{ fontWeight: "600" }}>
                              {pledge.name}
                            </Txt>
                            <Txt variant="tiny" tone="ink2">
                              {pledge.per === "year" ? "Two months on the house" : "A small monthly thank-you"}
                            </Txt>
                          </View>
                          <Txt variant="body" tone="ink2" style={{ fontWeight: "700" }}>
                            {pledge.price}
                          </Txt>
                        </PressScale>
                      ))}
                      <Txt variant="small" tone="ink2">
                        Regulars get Ember, a warm accent for Lantern. Everything else stays free for everyone, always.
                      </Txt>
                      <Txt variant="tiny" tone="ink3">
                        A pledge renews by itself until you cancel it, any time, in your {Platform.OS === "ios" ? "App Store" : "Google Play"} account settings. Payment is charged to that account when you confirm.{" "}
                        <Txt variant="tiny" accessibilityRole="link" onPress={link(TERMS_URL)} style={{ color: EMBER, textDecorationLine: "underline" }}>
                          Terms of Use
                        </Txt>
                        {" · "}
                        <Txt variant="tiny" accessibilityRole="link" onPress={link(PRIVACY_URL)} style={{ color: EMBER, textDecorationLine: "underline" }}>
                          Privacy Policy
                        </Txt>
                      </Txt>
                      <PressScale accessibilityRole="button" accessibilityLabel="Restore purchases" accessibilityHint="Brings back a pledge you made on this account" disabled={busy} onPress={() => void jar.restore()} hitSlop={10} haptic="select" scaleTo={0.94} style={{ alignSelf: "flex-start" }}>
                        <Txt variant="small" style={{ fontWeight: "700", color: EMBER }}>
                          Restore purchases
                        </Txt>
                      </PressScale>
                    </>
                  )}
                </View>
              )}

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
                  Yours is waiting for approval. It goes through when it is approved.
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
        </ScrollView>
      )}
    </View>
  );
}
