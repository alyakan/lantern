import { useEffect, useRef, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, View } from "react-native";
import { PIN_AT, follow, settle, swiping, trayWidth, BUTTON } from "../view/rowSwipe";
import { useAccent } from "./accent";
import { Txt } from "./components";
import { buzz, skips } from "./motion";
import { PinIcon } from "./PinIcon";
import { useColors } from "./theme";

export interface TrayButton {
  key: string;
  label: string;
  /** "danger" is red; the rest are the accent. */
  tone?: "accent" | "danger";
  onPress: () => void;
}

/** Further from the screen's left edge than this, a swipe right is the row's (nearer, it is the system's). */
const EDGE = 20;

/**
 * A row that can be swiped: right pins it (the row is let go past the pin hint and springs back, the phone tapping as it crosses),
 * left lays out its buttons, which stay until the row is tapped, swiped back, or another opens. The tray is controlled (`open`), so
 * the list can keep one open at a time. A screen reader isn't offered the swipe: the row's own actions do all of it.
 */
export function SwipeRow({ children, background, pin, tray, open, onOpenChange }: { children: ReactNode; /** The colour behind the row: it covers what the swipe uncovers. */ background: string; /** What a swipe right does (none: the row does not go right). */ pin?: { label: string; onTrigger: () => void } | null; tray: TrayButton[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const colors = useColors();
  const accent = useAccent();
  const x = useRef(new Animated.Value(0)).current;
  const pos = useRef(0);
  const from = useRef(0);
  const crossed = useRef(false);
  const width = trayWidth(tray.length);
  const canPin = !!pin;
  // What the pan handlers need is read from here, since they are made once.
  const live = useRef({ width, canPin, pin, open, onOpenChange });
  live.current = { width, canPin, pin, open, onOpenChange };

  const go = (to: number) => {
    pos.current = to;
    if (skips()) x.setValue(to);
    else Animated.spring(x, { toValue: to, useNativeDriver: true, speed: 18, bounciness: 6 }).start();
  };
  // The tray follows `open`: another row opening (or a tap on this one) closes it.
  useEffect(() => {
    go(open ? -width : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, width]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => {
        if (!swiping(g.dx, g.dy)) return false;
        const l = live.current;
        // Left needs buttons to lay out; right needs something to pin (and not to start at the edge), or an open tray to close.
        return g.dx < 0 ? l.width > 0 : l.open || (l.canPin && g.x0 >= EDGE);
      },
      onPanResponderGrant: () => {
        from.current = pos.current;
        crossed.current = false;
        x.stopAnimation();
      },
      // Once it has the swipe, the list it sits in doesn't take it away.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        const { width: w, canPin: p } = live.current;
        const v = follow(from.current, g.dx, w, p);
        pos.current = v;
        x.setValue(v);
        if (p && v >= PIN_AT && !crossed.current) {
          crossed.current = true;
          buzz("select");
        } else if (v < PIN_AT) crossed.current = false;
      },
      onPanResponderRelease: (_, g) => {
        const { width: w, canPin: p, pin: pinning, open: was, onOpenChange: tell } = live.current;
        const how = settle(pos.current, g.vx, w, p);
        if (how === "pin") {
          buzz("success");
          go(0);
          if (was) tell(false);
          pinning?.onTrigger();
        } else if (how === "open") {
          if (!was) buzz("light");
          go(-w);
          tell(true);
        } else {
          go(0);
          if (was) tell(false);
        }
      },
      onPanResponderTerminate: () => go(live.current.open ? -live.current.width : 0),
    }),
  ).current;

  return (
    <View style={{ overflow: "hidden" }}>
      {pin && (
        <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: accent, justifyContent: "center", paddingLeft: 24, opacity: x.interpolate({ inputRange: [0, 24], outputRange: [0, 1], extrapolate: "clamp" }) }]}>
          <Animated.View style={{ alignItems: "center", width: 56, gap: 4, transform: [{ scale: x.interpolate({ inputRange: [0, PIN_AT - 1, PIN_AT], outputRange: [0.8, 0.95, 1.12], extrapolate: "clamp" }) }] }}>
            <PinIcon color={colors.white} size={16} />
            <Txt variant="tiny" tone="white" style={{ fontWeight: "700" }}>
              {pin.label}
            </Txt>
          </Animated.View>
        </Animated.View>
      )}
      {tray.length > 0 && (
        <View pointerEvents={open ? "auto" : "none"} accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width, flexDirection: "row" }}>
          {tray.map((b) => (
            <Pressable
              key={b.key}
              accessibilityRole="button"
              accessibilityLabel={b.label}
              onPress={() => {
                buzz("select");
                onOpenChange(false);
                b.onPress();
              }}
              style={{ width: BUTTON, alignItems: "center", justifyContent: "center", backgroundColor: b.tone === "danger" ? colors.stop : accent }}
            >
              <Txt variant="small" tone="white" style={{ fontWeight: "700" }}>
                {b.label}
              </Txt>
            </Pressable>
          ))}
        </View>
      )}
      <Animated.View {...pan.panHandlers} style={{ backgroundColor: background, transform: [{ translateX: x }] }}>
        {children}
        {/* Open, the row is a way to close the tray, not to open the chat. */}
        {open && <Pressable accessibilityElementsHidden importantForAccessibility="no" testID="swipe-close" onPress={() => onOpenChange(false)} style={StyleSheet.absoluteFill} />}
      </Animated.View>
    </View>
  );
}
