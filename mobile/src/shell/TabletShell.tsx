import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { runPane, settleDrawer } from "../ui/motion";
import { useColors } from "../ui/theme";
import { dragProgress, EDGE_WIDTH, isSideways, settlesOpen, velocityOf } from "../view/drawer";
import { SIDEBAR_WIDTH } from "../view/layout";

/** How far past its own edge the column's shadow reaches: it slides that much further away, so no edge of it is left on the screen. */
const SHADOW_REACH = 32;
/** A change of the column that comes this soon after the window changed size came with it (the tablet was turned): iOS turns the screen, so it is just there. */
const TURN_MS = 600;

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
 * A tablet's screen: the chats in a column on the left, and the chat (`children`) taking the rest. Pinned ("split") the
 * column is always there. Not pinned ("overlay") the chat has the whole width and the column slides in over it when
 * `open`, with the chat dimmed behind: a tap on the dimmed chat, or `onClose`, slides it away. It can also be dragged: from
 * the screen's left edge to the right to bring it in (`onOpen`), and to the left, on the column or on the dimmed chat, to
 * send it away. It follows the finger, and when let go springs the rest of the way, in or out from how far it got and how
 * fast the finger went, carrying on at the finger's speed.
 *
 * Pinning and unpinning move the column and the chat together: the chat's room is laid out again on the same curve as the
 * column (Root asks for that with `movePanes`), so the chat's edge stays on the column's as both move. Slid in, the column
 * floats with a shadow over a dimmed chat; pinned, it sits flat with a hairline. Going from one to the other the dimming
 * fades and the shadow gives way to the line, rather than either cutting.
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
  // How much it floats over the chat (1, slid in: shadow and dimming) rather than sitting beside it (0, pinned: a hairline).
  const float = useRef(new Animated.Value(split ? 0 : 1)).current;
  // When the window last changed size.
  const lastWidth = useRef(width);
  const resizedAt = useRef(0);
  if (width !== lastWidth.current) {
    lastWidth.current = width;
    resizedAt.current = Date.now();
  }
  // Where a finger let go of the column sent it: it is on its way, so the state catching up doesn't start it over.
  const aimed = useRef<0 | 1 | null>(null);
  const was = useRef({ shown, split });
  useEffect(() => {
    const before = was.current;
    was.current = { shown, split };
    if (before.shown === shown && before.split === split) return;
    const to = shown ? 1 : 0;
    if (Date.now() - resizedAt.current < TURN_MS) {
      aimed.current = null;
      p.setValue(to);
      float.setValue(split ? 0 : 1);
      return;
    }
    if (before.split !== split) {
      // Pinned: it stays where it is and settles flat, the dimming going. Unpinned: it slides away flat, beside the chat
      // that widens into its place, and only floats again once it is gone.
      if (split) {
        runPane(p, to);
        runPane(float, 0);
      } else runPane(p, to, () => float.setValue(1));
      return;
    }
    // Not pinned, it floats: also when it is asked back before an unpin's slide away had finished (and set that).
    runPane(float, 1);
    if (aimed.current === to) {
      aimed.current = null;
      return;
    }
    aimed.current = null;
    settleDrawer(p, to);
  }, [p, float, shown, split]);
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
    // It carries on at the finger's speed (points a millisecond, as a share of its travel a second). The state may already say
    // where it goes (a drag that came back to where it began), and then nothing else would move it.
    aimed.current = goesIn === open ? null : goesIn ? 1 : 0;
    settleDrawer(p, goesIn ? 1 : 0, (d.velocity * 1000) / travel);
    if (goesIn && !open) onOpen();
    if (!goesIn && open) onClose();
  };
  // Dragging in from the screen's edge, while the column is away.
  const fromEdge = {
    onStartShouldSetResponder: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      p.stopAnimation();
      // A pull that cuts an unpin's slide away short: it floats from here, dimming and all.
      float.setValue(1);
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

  const over = !split && open;
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {/* With the chats slid in over the chat, the chat is behind them: out of the screen reader's reach too. */}
      <View accessibilityElementsHidden={over} importantForAccessibility={over ? "no-hide-descendants" : "auto"} style={{ flex: 1, marginLeft: split ? columnWidth : 0 }}>
        {children}
      </View>
      {!split && !open && <View testID="chats-edge" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: EDGE_WIDTH }} {...fromEdge} />}
      {/* The dimming over the chat: as deep as the column is in, and only while it floats, so pinning fades it away. */}
      <Animated.View pointerEvents={over ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: Animated.multiply(p, float) }]} {...(split ? {} : toEdge)}>
        <Pressable accessibilityLabel="Close chats" accessibilityRole="button" accessibilityElementsHidden={!over} importantForAccessibility={over ? "auto" : "no-hide-descendants"} onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        testID="chats-column"
        pointerEvents={shown ? "auto" : "none"}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: columnWidth, backgroundColor: colors.paper, transform: [{ translateX: p.interpolate({ inputRange: [0, 1], outputRange: [-travel, 0] }) }] }}
        {...(split ? {} : toEdge)}
      >
        {/* Its shadow while it floats, and its hairline while it is pinned: one gives way to the other. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.paper, opacity: float, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 4, height: 0 } }]} />
        {sidebar}
        <Animated.View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: StyleSheet.hairlineWidth, backgroundColor: colors.rule, opacity: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }} />
      </Animated.View>
    </View>
  );
}
