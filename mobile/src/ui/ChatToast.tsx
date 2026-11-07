import { useEffect, useRef } from "react";
import { Animated, PanResponder, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EMBER, useRegular } from "./accent";
import { Txt } from "./components";
import { Glass } from "./Glass";
import { PressScale, skips } from "./motion";
import { useColors } from "./theme";

export interface ToastShown {
  /** A new one each time, so a second toast about the same chat starts over. */
  id: number;
  slot: string;
  kind: "done" | "needs";
  title: string;
  project: string | null;
}

/** How long a toast stays, unless it is swiped away first. */
export const TOAST_MS = { done: 4000, needs: 4000 } as const;

/** How far up a swipe takes it before it goes when let go (a quick flick goes from less). */
const SWIPE_AWAY = 24;

/**
 * A chat that finished, or needs you, while you were looking at something else: a card of Liquid Glass that drops in at the top,
 * as iOS's own notifications do, and goes by itself. Pressing it opens the chat; swiping it up puts it away at once (it is over
 * the screen's own bar, so it never stays there unasked).
 */
export function ChatToast({ toast, onOpen, onDone }: { toast: ToastShown | null; onOpen: (slot: string) => void; onDone: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const regular = useRegular();
  const id = toast?.id;
  const kind = toast?.kind;
  // Where it is: -1 up and out of sight, 0 in place; a finger moves it (in points) through `drag`.
  const at = useRef(new Animated.Value(-1)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const done = useRef(onDone);
  done.current = onDone;
  // Once going it goes once: a swipe and the timer both ending it would otherwise end the next toast too.
  const leaving = useRef<number | undefined>(undefined);
  const leave = () => {
    if (leaving.current === id) return;
    leaving.current = id;
    if (skips()) return done.current();
    Animated.timing(at, { toValue: -1, duration: 200, useNativeDriver: true }).start(() => done.current());
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    if (id === undefined || !kind) return;
    drag.setValue(0);
    if (skips()) at.setValue(0);
    else Animated.spring(at, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 5 }).start();
    const t = setTimeout(() => leaveRef.current(), TOAST_MS[kind]);
    return () => clearTimeout(t);
  }, [id, kind]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      // Up it follows the finger; down it gives a little, as a notification does.
      onPanResponderMove: (_, g) => drag.setValue(g.dy < 0 ? g.dy : g.dy / 6),
      onPanResponderRelease: (_, g) => {
        if (g.dy < -SWIPE_AWAY || g.vy < -0.5) leaveRef.current();
        else Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;
  if (!toast) return null;
  const needs = toast.kind === "needs";
  const what = needs ? "Needs you" : "Finished";
  const dot = needs ? (regular ? EMBER : colors.hi) : colors.go;
  const translateY = Animated.add(at.interpolate({ inputRange: [-1, 0], outputRange: [-(insets.top + 120), 0] }), drag);
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 4, left: 10, right: 10, alignItems: "center" }}>
      <Animated.View testID="chat-toast" {...pan.panHandlers} style={{ width: "100%", maxWidth: 440, transform: [{ translateY }] }}>
        <PressScale
          accessibilityRole="alert"
          accessibilityLabel={`${toast.title}: ${what.toLowerCase()}`}
          accessibilityHint="Opens the chat. Swipe up to dismiss."
          accessibilityActions={[{ name: "escape", label: "Dismiss" }]}
          onAccessibilityAction={(e) => e.nativeEvent.actionName === "escape" && leaveRef.current()}
          onPress={() => {
            done.current();
            onOpen(toast.slot);
          }}
          haptic="select"
          scaleTo={0.98}
        >
          <Glass lift={0.18} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 24 }}>
            {/* The app's mark, in what happened's colour: a square like a notification's icon, holding the dot. */}
            <View accessibilityElementsHidden style={{ width: 36, height: 36, borderRadius: 9, backgroundColor: `${dot}26`, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: dot }} />
            </View>
            <View style={{ flex: 1 }}>
              <Txt variant="small" style={{ fontWeight: "700" }} numberOfLines={1}>
                {toast.title}
              </Txt>
              <Txt variant="small" tone="ink2" numberOfLines={1}>
                {toast.project ? `${what} · ${toast.project}` : what}
              </Txt>
            </View>
          </Glass>
        </PressScale>
      </Animated.View>
    </View>
  );
}
