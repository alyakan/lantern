import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { run } from "../ui/motion";
import { useColors } from "../ui/theme";
import { dragProgress, EDGE_WIDTH, isSideways, settlesOpen, velocityOf } from "../view/drawer";
import { SIDEBAR_WIDTH } from "../view/layout";

/** How long the column takes to slide in or away. */
const SLIDE_MS = 260;
/** How far past its own edge the column's shadow reaches: it slides that much further away, so no edge of it is left on the screen. */
const SHADOW_REACH = 32;

/** One finger's drag: where it began, where it was last and when (for how fast it is going), and how in the column was when it began. */
interface Drag {
  x: number;
  y: number;
  lastX: number;
  lastAt: number;
  velocity: number;
  from: 0 | 1;
}

const at = (e: GestureResponderEvent) => e.nativeEvent.timestamp ?? Date.now();

/**
 * A tablet's screen: the chats in a column on the left, and the chat (`children`) taking the rest. Held sideways ("split")
 * the column is always there. Held upright ("overlay") the chat has the whole width and the column slides in over it when
 * `open`, with the chat dimmed behind: a tap on the dimmed chat, or `onClose`, slides it away. It can also be dragged: from
 * the screen's left edge to the right to bring it in (`onOpen`), and to the left, on the column or on the dimmed chat, to
 * send it away. It follows the finger, and settles in or out from how far it got and how fast the finger went.
 *
 * The column is the same view in both, only placed differently, so turning the tablet does not rebuild it (which would lose
 * the projects folded away and where it was scrolled to).
 */
export function TabletShell({ layout, open, onOpen, onClose, sidebar, children }: { layout: "overlay" | "split"; open: boolean; onOpen: () => void; onClose: () => void; sidebar: ReactNode; children: ReactNode }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const split = layout === "split";
  const shown = split || open;
  // How far in the column is: 0 away, 1 in place.
  const p = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    run(p, shown ? 1 : 0, SLIDE_MS);
  }, [p, shown]);
  // A column that takes most of a narrow window would leave nothing to tap away.
  const columnWidth = Math.min(SIDEBAR_WIDTH, width * 0.85);
  // It travels its own width and the shadow's reach, so under the finger it moves as far as the finger does.
  const travel = columnWidth + SHADOW_REACH;

  const drag = useRef<Drag | null>(null);
  const begin = (e: GestureResponderEvent, from: 0 | 1) => {
    const { pageX, pageY } = e.nativeEvent;
    drag.current = { x: pageX, y: pageY, lastX: pageX, lastAt: at(e), velocity: 0, from };
  };
  const follow = (e: GestureResponderEvent) => {
    const d = drag.current;
    if (!d) return;
    const { pageX } = e.nativeEvent;
    const now = at(e);
    d.velocity = velocityOf(d.lastX, d.lastAt, pageX, now);
    d.lastX = pageX;
    d.lastAt = now;
    p.setValue(dragProgress(d.from, pageX - d.x, travel));
  };
  const release = (e: GestureResponderEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const progress = dragProgress(d.from, e.nativeEvent.pageX - d.x, travel);
    const goesIn = settlesOpen(progress, d.velocity);
    // The state may already say so (a drag that came back to where it began), and then nothing else would move it.
    run(p, goesIn ? 1 : 0, SLIDE_MS);
    if (goesIn && !open) onOpen();
    if (!goesIn && open) onClose();
  };
  // Dragging in from the screen's edge, while the column is away.
  const fromEdge = {
    onStartShouldSetResponder: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      p.stopAnimation();
      begin(e, 0);
    },
    onResponderMove: follow,
    onResponderRelease: release,
    onResponderTerminate: release,
  };
  // Dragging it away, on the column or the dimmed chat: taken from what is under the finger (a list that scrolls) once it is plainly going left.
  const toEdge = {
    onStartShouldSetResponderCapture: (e: GestureResponderEvent) => {
      begin(e, 1);
      return false;
    },
    onMoveShouldSetResponderCapture: (e: GestureResponderEvent) => {
      const d = drag.current;
      if (!d) return false;
      const dx = e.nativeEvent.pageX - d.x;
      return dx < 0 && isSideways(dx, e.nativeEvent.pageY - d.y);
    },
    onResponderGrant: () => p.stopAnimation(),
    onResponderMove: follow,
    onResponderRelease: release,
    onResponderTerminate: release,
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {/* With the chats slid in over the chat, the chat is behind them: out of the screen reader's reach too. */}
      <View accessibilityElementsHidden={!split && open} importantForAccessibility={!split && open ? "no-hide-descendants" : "auto"} style={{ flex: 1, marginLeft: split ? columnWidth : 0 }}>
        {children}
      </View>
      {!split && !open && <View testID="chats-edge" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: EDGE_WIDTH }} {...fromEdge} />}
      {!split && (
        <Animated.View pointerEvents={open ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: p }]} {...toEdge}>
          <Pressable accessibilityLabel="Close chats" accessibilityRole="button" accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"} onPress={onClose} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      <Animated.View
        testID="chats-column"
        pointerEvents={shown ? "auto" : "none"}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
        style={[
          { position: "absolute", left: 0, top: 0, bottom: 0, width: columnWidth, backgroundColor: colors.paper, transform: [{ translateX: p.interpolate({ inputRange: [0, 1], outputRange: [-travel, 0] }) }] },
          split ? { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.rule } : { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 4, height: 0 } },
        ]}
        {...(split ? {} : toEdge)}
      >
        {sidebar}
      </Animated.View>
    </View>
  );
}
