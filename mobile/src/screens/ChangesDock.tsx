import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { runPaneFrame } from "../ui/motion";
import { radius, useColors } from "../ui/theme";
import { floatFrame } from "../view/layout";

/** Where the Changes are: away, beside the chat at the right, or floating over it as a big card. */
export type DockMode = "hidden" | "dock" | "float";

/** How wide the divider takes a finger, either side of the line between the chat and the pane. */
const GRAB = 22;

export interface ChangesDockProps {
  mode: DockMode;
  /** How wide the pane is beside the chat. */
  width: number;
  /** The room it is in (the chat's, beside the chats), and the bars at its top and bottom a card stays clear of. */
  room: { width: number; height: number; top: number; bottom: number };
  /** A tap on the dimmed chat around the floating card. */
  onScrim: () => void;
  /** The divider: a drag begins, the pane is dragged to `width` (what the finger asks for: the caller keeps it in bounds), it ends. */
  onResizeStart: () => void;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
  /** The screen reader's swipe up or down on the divider: a step wider (1) or narrower (-1). */
  onStep: (dir: 1 | -1) => void;
  /** What the divider says it is at, for the screen reader ("50%"). */
  share: string;
  children: ReactNode;
}

/**
 * The Changes pane on a tablet, as one view whatever it does, so what it shows (the file picked, its diff) stays as it moves.
 * Beside the chat it slides in from the right edge and back out, with a divider on its left edge that drags it wider or
 * narrower. Floated, its frame grows from where it sat into a big card in the middle, with rounded corners, a shadow, and the
 * chat dimmed around it; put back, it shrinks into its place beside the chat. Put away while it floats, it goes down.
 */
export function ChangesDock({ mode, width, room, onScrim, onResizeStart, onResize, onResizeEnd, onStep, share, children }: ChangesDockProps) {
  const colors = useColors();
  // How far it floats (0 beside the chat, 1 the card) and how far in it is (0 away, 1 in).
  const f = useRef(new Animated.Value(mode === "float" ? 1 : 0)).current;
  const p = useRef(new Animated.Value(mode === "hidden" ? 0 : 1)).current;
  const [mounted, setMounted] = useState(mode !== "hidden");
  // Which way it leaves: to the right from beside the chat, down from the middle.
  const [via, setVia] = useState<"right" | "down">(mode === "float" ? "down" : "right");
  const last = useRef(mode);
  useEffect(() => {
    const before = last.current;
    last.current = mode;
    if (before === mode) return;
    if (mode === "hidden") {
      setVia(before === "float" ? "down" : "right");
      runPaneFrame(p, 0, () => last.current === "hidden" && setMounted(false));
      return;
    }
    setMounted(true);
    if (before === "hidden") {
      // It comes in the way it would go: from the right to beside the chat, from below to the middle.
      f.setValue(mode === "float" ? 1 : 0);
      setVia(mode === "float" ? "down" : "right");
      runPaneFrame(p, 1);
      return;
    }
    runPaneFrame(f, mode === "float" ? 1 : 0);
  }, [mode, f, p]);

  // What it showed stays on it as it goes (its chat may have gone first).
  const kept = useRef(children);
  if (mode !== "hidden") kept.current = children;

  const drag = useRef<{ x: number; from: number } | null>(null);
  const grab = {
    onStartShouldSetResponder: () => true,
    // Nothing under it (the chat's list) takes a drag that began on the divider.
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      drag.current = { x: e.nativeEvent.pageX, from: width };
      onResizeStart();
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const d = drag.current;
      if (d) onResize(d.from - (e.nativeEvent.pageX - d.x));
    },
    onResponderRelease: () => {
      drag.current = null;
      onResizeEnd();
    },
    onResponderTerminate: () => {
      drag.current = null;
      onResizeEnd();
    },
  };

  if (!mounted && mode === "hidden") return null;
  const card = floatFrame(room.width, room.height, room.top, room.bottom);
  const dockX = room.width - width;
  const floating = mode === "float";
  const between = (a: number, b: number) => f.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const away = via === "right" ? { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) } : { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [room.height - card.y, 0] }) };
  return (
    <>
      {/* The chat dimmed around the card: as deep as it floats, and only while it does. */}
      <Animated.View pointerEvents={floating ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: Animated.multiply(f, p) }]}>
        <Pressable testID="changes-scrim" accessibilityRole="button" accessibilityLabel="Close changes" accessibilityElementsHidden={!floating} importantForAccessibility={floating ? "auto" : "no-hide-descendants"} onPress={onScrim} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        testID="changes-dock"
        pointerEvents={mode === "hidden" ? "none" : "box-none"}
        accessibilityViewIsModal={floating}
        accessibilityElementsHidden={mode === "hidden"}
        importantForAccessibility={mode === "hidden" ? "no-hide-descendants" : "auto"}
        style={{ position: "absolute", left: between(dockX, card.x), top: between(0, card.y), width: between(width, card.w), height: between(room.height, card.h), transform: [away] }}
      >
        {/* Its shadow while it floats. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.card, borderRadius: radius.sheet, opacity: f, shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } }]} />
        <Animated.View style={{ flex: 1, overflow: "hidden", backgroundColor: colors.card, borderRadius: between(0, radius.sheet) }}>
          {kept.current}
        </Animated.View>
        {/* Its line against the chat while it is beside it. */}
        <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: colors.rule, opacity: between(1, 0) }} />
      </Animated.View>
      {mode === "dock" && (
        <View
          testID="changes-divider"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Width of the changes"
          accessibilityValue={{ text: share }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) => onStep(e.nativeEvent.actionName === "increment" ? 1 : -1)}
          style={{ position: "absolute", top: 0, bottom: 0, left: dockX - GRAB / 2, width: GRAB, alignItems: "center", justifyContent: "center" }}
          {...grab}
        >
          {/* A grip in the middle of the line, as iPadOS draws one between two apps side by side. */}
          <View style={{ width: 6, height: 44, borderRadius: 3, backgroundColor: colors.ink3, opacity: 0.55 }} />
        </View>
      )}
    </>
  );
}
