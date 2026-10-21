import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, useWindowDimensions, View } from "react-native";
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

/**
 * The screens of the app's stack, with Home kept underneath: a new one slides in over the one before, and going back
 * slides it away again. The first screens are just there, with no entrance.
 */
export function AnimatedStack({ items }: { items: StackItem[] }) {
  const { width, height } = useWindowDimensions();
  const [entries, setEntries] = useState<Entry[]>(() => items.map((i) => ({ ...i, leaving: false })));
  const keys = items.map((i) => i.key).join("|");
  const [seen, setSeen] = useState(keys);
  // Which screens there are changed: work out the drawing now, so a screen that left is never missing for a frame.
  if (keys !== seen) {
    setSeen(keys);
    setEntries(merge(entries, items));
  }

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
    // Gone for good: forget their animation state, so coming back to one starts from off screen.
    for (const k of [...values.current.keys()]) {
      if (!entries.some((e) => e.key === k)) {
        values.current.delete(k);
        targets.current.delete(k);
      }
    }
  }, [entries]);

  const top = entries.filter((e) => !e.leaving).length - 1;
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
            style={[StyleSheet.absoluteFill, { transform: [slide] }, e.kind === "push" && i > 0 ? { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: -4, height: 0 } } : null]}
          >
            {element}
          </Animated.View>
        );
      })}
    </View>
  );
}
