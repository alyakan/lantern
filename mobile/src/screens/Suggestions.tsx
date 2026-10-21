import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, View } from "react-native";
import type { Suggestion } from "../protocol/generated/Suggestion";
import { useController, useSyncState } from "../shell/hooks";
import { Button, Txt } from "../ui/components";
import { FadeSlideIn, PressScale, skips } from "../ui/motion";
import { colors, radius, shadow, space } from "../ui/theme";
import type { Draft } from "./NewChatSheet";

type State = { status: "loading" | "ready" | "failed"; items: Suggestion[]; error?: string };

/** A card's worth of grey, breathing while Claude thinks. */
function Skeleton({ delay }: { delay: number }) {
  const p = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    if (skips()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(p, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(p, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [p, delay]);
  return (
    <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ opacity: p, backgroundColor: colors.card, borderRadius: radius.card, padding: 14, gap: 8 }}>
      <View style={{ width: "36%", height: 10, borderRadius: 5, backgroundColor: colors.rule }} />
      <View style={{ width: "78%", height: 14, borderRadius: 7, backgroundColor: colors.rule }} />
      <View style={{ width: "58%", height: 10, borderRadius: 5, backgroundColor: colors.rule }} />
    </Animated.View>
  );
}

/**
 * What Claude suggests when nothing waits on you: a few drafts from your recent chats, each opening a sheet where you read
 * and change it before it goes anywhere (starting something of your own is Home's "New chat"). The Mac makes them with a call that costs
 * usage, so they are asked for when this appears and again only when you ask.
 */
export function Suggestions({ onPick }: { onPick: (draft: Draft) => void }) {
  const { sync } = useController();
  const { chats } = useSyncState();
  const [state, setState] = useState<State>({ status: "loading", items: [] });
  const live = useRef(true);

  const load = useCallback(
    (refresh: boolean) => {
      setState((s) => ({ ...s, status: "loading", error: undefined }));
      sync.suggest(refresh).then(
        (r) => live.current && setState({ status: "ready", items: r.items }),
        (e: Error) => live.current && setState({ status: "failed", items: [], error: e.message }),
      );
    },
    [sync],
  );
  useEffect(() => {
    live.current = true;
    load(false);
    return () => {
      live.current = false;
    };
  }, [load]);

  const titleOf = (slot: string) => chats.find((c) => c.slot === slot)?.title?.trim() || "this chat";
  // Carrying on a chat that has since gone isn't offered.
  const shown = state.items.filter((s) => s.target.kind === "new_chat" || chats.some((c) => c.slot === (s.target as { slot: string }).slot));
  const pick = (s: Suggestion) => (s.target.kind === "continue" ? onPick({ text: s.message, continueChat: { slot: s.target.slot, title: titleOf(s.target.slot) } }) : onPick({ text: s.message, project: s.target.project }));

  return (
    <View style={{ paddingHorizontal: space.xl, paddingTop: 4, gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Txt variant="small" style={{ fontWeight: "700" }}>
          Claude suggests
        </Txt>
        {state.status !== "loading" && (
          <PressScale accessibilityRole="button" accessibilityLabel="New ideas" onPress={() => load(true)} hitSlop={8} scaleTo={0.92}>
            <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
              New ideas
            </Txt>
          </PressScale>
        )}
      </View>

      {state.status === "loading" && (
        <View accessibilityLabel="Thinking about what is next" style={{ gap: 10 }}>
          <Skeleton delay={0} />
          <Skeleton delay={180} />
          <Txt variant="small" tone="ink3">
            Thinking about what's next…
          </Txt>
        </View>
      )}

      {state.status === "failed" && (
        <View style={{ gap: 8 }}>
          <Txt variant="small" tone="ink2" accessibilityRole="alert">
            {state.error}
          </Txt>
          <Button label="Try again" kind="ghost" onPress={() => load(true)} />
        </View>
      )}

      {state.status === "ready" && shown.length === 0 && (
        <FadeSlideIn from={8}>
          <Txt variant="small" tone="ink2">
            Nothing in particular comes to mind.
          </Txt>
        </FadeSlideIn>
      )}

      {state.status === "ready" &&
        shown.map((s, i) => (
          <FadeSlideIn key={s.id} from={14} delay={i * 80}>
            <PressScale accessibilityRole="button" accessibilityLabel={`${s.title}. ${s.why}`} onPress={() => pick(s)} scaleTo={0.97} haptic="select" style={[{ backgroundColor: colors.card, borderRadius: radius.card, padding: 14, gap: 4 }, shadow.card, { shadowOpacity: 0.06 }]}>
              <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
                {s.target.kind === "continue" ? `Carry on · ${titleOf(s.target.slot)}` : `New chat · ${s.target.project_name}`}
              </Txt>
              <Txt variant="heading">{s.title}</Txt>
              <Txt variant="small" tone="ink2">
                {s.why}
              </Txt>
              <Txt variant="small" tone="ink3" numberOfLines={2} style={{ marginTop: 4 }}>
                “{s.message}”
              </Txt>
            </PressScale>
          </FadeSlideIn>
        ))}

    </View>
  );
}
