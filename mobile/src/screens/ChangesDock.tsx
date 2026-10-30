import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { runPane, skips } from "../ui/motion";
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

type Frame = { x: number; y: number; w: number; h: number };

/**
 * The Changes pane on a tablet, as one view whatever it does, so what it shows (the file picked, its diff) stays as it moves.
 * Beside the chat it slides in from the right edge and back out, with a divider on its left edge that drags it wider or
 * narrower. Floated, it grows from where it sat into a big card in the middle, with rounded corners, a shadow, and the chat
 * dimmed around it; put back, it shrinks into its place beside the chat. Put away while it floats, it goes down.
 *
 * Every move runs on the native driver. Floating or putting back, the view is laid out once, at the frame it ends at, and a
 * translate and a scale carry it there from the frame it had. Moving the frame itself (as it once did) laid the diff out
 * again at every step, in JavaScript, and stuttered.
 */
export function ChangesDock({ mode, width, room, onScrim, onResizeStart, onResize, onResizeEnd, onStep, share, children }: ChangesDockProps) {
  const colors = useColors();
  // How far it floats (0 beside the chat, 1 the card: the dimming, the shadow), how far in it is (0 away, 1 in), and how far it
  // has come from the frame it had (0) to the one it is laid out at (1).
  const f = useRef(new Animated.Value(mode === "float" ? 1 : 0)).current;
  const p = useRef(new Animated.Value(mode === "hidden" ? 0 : 1)).current;
  const t = useRef(new Animated.Value(1)).current;
  const [mounted, setMounted] = useState(mode !== "hidden");
  // Which way it leaves: to the right from beside the chat, down from the middle.
  const [via, setVia] = useState<"right" | "down">(mode === "float" ? "down" : "right");
  // The frame it is laid out at, which changes a frame after the mode does: the chat's change of width (`movePanes`) is laid out
  // by iOS in the commit the mode changes in, and that animation would carry this frame too, on top of its own move. (After a
  // press React runs effects in the same task, so an effect alone could still land in that commit.) While it floats or is put
  // back, `from` is where it was, so it is carried from there.
  const [laid, setLaid] = useState<"dock" | "float">(mode === "float" ? "float" : "dock");
  const laidNow = useRef(laid);
  laidNow.current = laid;
  const [from, setFrom] = useState<"dock" | "float" | null>(null);
  const last = useRef(mode);
  useEffect(() => {
    const before = last.current;
    last.current = mode;
    if (before === mode) return;
    if (mode === "hidden") {
      setVia(before === "float" ? "down" : "right");
      runPane(p, 0, () => last.current === "hidden" && setMounted(false));
      return;
    }
    setMounted(true);
    if (before === "hidden") {
      // It comes in the way it would go: from the right to beside the chat, from below to the middle.
      f.setValue(mode === "float" ? 1 : 0);
      t.setValue(1);
      setLaid(mode);
      setFrom(null);
      setVia(mode === "float" ? "down" : "right");
      runPane(p, 1);
      return;
    }
    runPane(f, mode === "float" ? 1 : 0);
    const move = () => {
      // Floated and put back again within the frame: it is carried from wherever it is laid out now, to where it is to be.
      const to = last.current;
      if (to === "hidden" || to === laidNow.current) return;
      setFrom(laidNow.current);
      setLaid(to);
      t.setValue(0);
      runPane(t, 1, () => last.current === to && setFrom(null));
    };
    if (skips()) move();
    else requestAnimationFrame(move);
  }, [mode, f, p, t]);

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
  const floating = mode === "float";
  const card: Frame = floatFrame(room.width, room.height, room.top, room.bottom);
  const dock: Frame = { x: room.width - width, y: 0, w: width, h: room.height };
  // Laid out where it is going (where it was, while it slides away), carried there from where it was.
  const at = laid === "float" ? card : dock;
  const was = from === "float" ? card : from === "dock" ? dock : at;
  const step = (a: number, b: number) => t.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const sx = step(was.w / at.w, 1);
  const sy = step(was.h / at.h, 1);
  const flip = [{ translateX: step(was.x + was.w / 2 - (at.x + at.w / 2), 0) }, { translateY: step(was.y + was.h / 2 - (at.y + at.h / 2), 0) }, { scaleX: sx }, { scaleY: sy }];
  // What it shows is scaled back by as much, so its words aren't squashed or stretched on the way: drawn at the size it lands at,
  // from the frame's top left corner, and cut off by the frame as it grows or shrinks around them.
  const ix = Animated.divide(1, sx);
  const iy = Animated.divide(1, sy);
  const unflip = [{ translateX: Animated.add(Animated.multiply(ix, at.w / 2), -at.w / 2) }, { translateY: Animated.add(Animated.multiply(iy, at.h / 2), -at.h / 2) }, { scaleX: ix }, { scaleY: iy }];
  const away = via === "right" ? { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) } : { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [room.height - card.y, 0] }) };
  // Its corners are the card's from the start of its way there to the end of its way back.
  const rounded = at === card || from === "float";
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
        style={{ position: "absolute", left: at.x, top: at.y, width: at.w, height: at.h, transform: [away, ...flip] }}
      >
        {/* Its shadow while it floats. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.card, borderRadius: radius.sheet, opacity: f, shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } }]} />
        <View style={{ flex: 1, overflow: "hidden", backgroundColor: colors.card, borderRadius: rounded ? radius.sheet : 0 }}>
          <Animated.View testID="changes-content" style={{ flex: 1, transform: unflip }}>{kept.current}</Animated.View>
        </View>
        {/* Its line against the chat while it is beside it. */}
        <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: colors.rule, opacity: f.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }} />
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
          style={{ position: "absolute", top: 0, bottom: 0, left: dock.x - GRAB / 2, width: GRAB, alignItems: "center", justifyContent: "center" }}
          {...grab}
        >
          {/* A grip in the middle of the line, as iPadOS draws one between two apps side by side. */}
          <View style={{ width: 6, height: 44, borderRadius: 3, backgroundColor: colors.ink3, opacity: 0.55 }} />
        </View>
      )}
    </>
  );
}
