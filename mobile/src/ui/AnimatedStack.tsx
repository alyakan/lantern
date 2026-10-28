import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { BACK_EDGE_WIDTH, goesBack, pulled } from "../view/back";
import { velocityOf } from "../view/drawer";
import { run } from "./motion";

/** One screen of the stack: a "push" slides in from the right (a chat), a "modal" rises from the bottom (a decision). */
export interface StackItem {
  key: string;
  kind: "push" | "modal";
  element: ReactNode;
}

interface Entry extends StackItem {
  leaving: boolean;
}

/** The screens to draw: the stack's, then those that just left, kept on top until their exit has played. */
function merge(entries: Entry[], items: StackItem[]): Entry[] {
  const keys = new Set(items.map((i) => i.key));
  return [...items.map((i) => ({ ...i, leaving: false })), ...entries.filter((e) => !keys.has(e.key)).map((e) => ({ ...e, leaving: true }))];
}

const MS = { push: 280, modal: 340 };
const ZERO = new Animated.Value(0);
/** How far the screen beneath a push slides left as the new one covers it. */
const PARALLAX = 0.25;

const at = (e: GestureResponderEvent) => e.nativeEvent.timestamp ?? Date.now();

/** One finger's drag from the left edge: where it began, where it was last and when (for how fast it is going), and which screen it has. */
interface Drag {
  x: number;
  lastX: number;
  lastAt: number;
  velocity: number;
  key: string;
  kind: StackItem["kind"];
}

/**
 * The screens of the app's stack, with Home kept underneath: a new one slides in over the one before, and going back
 * slides it away again. The first screens are just there, with no entrance.
 *
 * The top screen (when it isn't Home) can be dragged away to go back (`onBack`), from a strip at the screen's left edge: a
 * chat follows the finger with Home sliding out from beneath it, as it did coming in, and a decision is taken off to the
 * right. It goes back if it was pulled far enough or flicked, and springs back to where it was if not.
 */
export function AnimatedStack({ items, onBack }: { items: StackItem[]; onBack?: () => void }) {
  const { width, height } = useWindowDimensions();
  const [entries, setEntries] = useState<Entry[]>(() => items.map((i) => ({ ...i, leaving: false })));
  const keys = items.map((i) => i.key).join("|");
  const [seen, setSeen] = useState(keys);
  // Which screens there are changed: work out the drawing now, so a screen that left is never missing for a frame.
  if (keys !== seen) {
    setSeen(keys);
    setEntries(merge(entries, items));
  }

  // How far a decision (a screen that rises, not slides in) has been taken off to the right.
  const away = useRef(new Animated.Value(0)).current;
  const values = useRef(new Map<string, Animated.Value>());
  const targets = useRef(new Map<string, number>());
  const started = useRef(false);
  const valueFor = (key: string) => {
    let v = values.current.get(key);
    if (!v) {
      // Those there from the start are in place; later ones come in from off screen.
      v = new Animated.Value(started.current ? 0 : 1);
      values.current.set(key, v);
      if (!started.current) targets.current.set(key, 1);
    }
    return v;
  };
  entries.forEach((e) => valueFor(e.key));

  useEffect(() => {
    for (const e of entries) {
      const to = e.leaving ? 0 : 1;
      if (targets.current.get(e.key) === to) continue;
      targets.current.set(e.key, to);
      run(valueFor(e.key), to, MS[e.kind], e.leaving ? () => setEntries((es) => es.filter((x) => !(x.key === e.key && x.leaving))) : undefined);
    }
    started.current = true;
    if (!entries.some((e) => e.kind === "modal")) away.setValue(0);
    // Gone for good: forget their animation state, so coming back to one starts from off screen.
    for (const k of [...values.current.keys()]) {
      if (!entries.some((e) => e.key === k)) {
        values.current.delete(k);
        targets.current.delete(k);
      }
    }
  }, [entries, away]);

  const top = entries.filter((e) => !e.leaving).length - 1;

  // The drag back, from the strip at the left edge. What it reads is kept in a ref, since the handlers outlive a render.
  const latest = useRef({ entries, top, width, onBack });
  latest.current = { entries, top, width, onBack };
  const drag = useRef<Drag | null>(null);
  const place = (d: Drag, dx: number) => {
    const p = pulled(dx, latest.current.width);
    // A chat is placed by its own position (1 in place, 0 away) and Home beneath it follows; a decision is moved sideways.
    if (d.kind === "push") values.current.get(d.key)?.setValue(1 - p);
    else away.setValue(p * latest.current.width);
  };
  const edge = {
    onStartShouldSetResponder: () => latest.current.top > 0 && !!latest.current.onBack,
    onResponderGrant: (e: GestureResponderEvent) => {
      const entry = latest.current.entries[latest.current.top];
      if (!entry) return;
      const { pageX } = e.nativeEvent;
      values.current.get(entry.key)?.stopAnimation();
      drag.current = { x: pageX, lastX: pageX, lastAt: at(e), velocity: 0, key: entry.key, kind: entry.kind };
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const d = drag.current;
      if (!d) return;
      const { pageX } = e.nativeEvent;
      const now = at(e);
      d.velocity = velocityOf(d.lastX, d.lastAt, pageX, now);
      d.lastX = pageX;
      d.lastAt = now;
      place(d, pageX - d.x);
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const progress = pulled(e.nativeEvent.pageX - d.x, latest.current.width);
      if (goesBack(progress, d.velocity)) {
        // It carries on from where the finger left it: a chat's own exit runs from there, and a decision is taken the rest of the way off.
        if (d.kind === "modal") run(away, latest.current.width, 160, () => latest.current.onBack?.());
        else latest.current.onBack?.();
      } else if (d.kind === "push") run(values.current.get(d.key) ?? ZERO, 1, 200);
      else run(away, 0, 200);
    },
  };
  return (
    <View style={{ flex: 1, overflow: "hidden" }}>
      {entries.map((e, i) => {
        const v = valueFor(e.key);
        const next = entries[i + 1];
        const covered = next && next.kind === "push" ? valueFor(next.key).interpolate({ inputRange: [0, 1], outputRange: [0, -width * PARALLAX] }) : ZERO;
        const slide = e.kind === "modal" ? { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) } : { translateX: Animated.add(v.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }), covered) };
        const live = !e.leaving && i === top;
        const element = items.find((x) => x.key === e.key)?.element ?? e.element;
        return (
          <Animated.View
            key={e.key}
            pointerEvents={live ? "auto" : "none"}
            accessibilityElementsHidden={!live}
            importantForAccessibility={live ? "auto" : "no-hide-descendants"}
            style={[StyleSheet.absoluteFill, { transform: e.kind === "modal" ? [slide, { translateX: away }] : [slide] }, e.kind === "push" && i > 0 ? { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: -4, height: 0 } } : null]}
          >
            {element}
          </Animated.View>
        );
      })}
      {onBack && top > 0 && <View testID="back-edge" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: BACK_EDGE_WIDTH }} {...edge} />}
    </View>
  );
}
