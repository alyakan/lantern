import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, useWindowDimensions, View } from "react-native";
import { run, runPane, skips } from "./motion";

/** How long one screen takes to give way to the next in place (one chat to another). */
const SWAP_MS = 220;
/** How long a decision takes to rise over its chat, and to go back down (the phone's, see `AnimatedStack`). */
const RISE_MS = 340;

/**
 * Whether something asked to go is still on screen while it leaves, and how far in it is (0 away, 1 in). What is shown from the
 * start is just there; shown later, it comes in, and asked to go, it stays until its exit has played.
 */
function useLeaving(shown: boolean, play: (p: Animated.Value, to: number, done?: () => void) => void) {
  const [mounted, setMounted] = useState(shown);
  const p = useRef(new Animated.Value(shown ? 1 : 0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (shown) setMounted(true);
    play(p, shown ? 1 : 0, shown ? undefined : () => setMounted(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  return { mounted: mounted || shown, p };
}

/**
 * A pane at the right of a row (the Changes beside a chat) that slides in from the right edge when `shown`, and back out when
 * not. While it goes it no longer takes room in the row, so what is beside it widens into its place as it leaves (with
 * `movePanes`), rather than after.
 */
export function SidePane({ shown, width, children, style }: { shown: boolean; width: number; children: ReactNode; style?: object }) {
  const { mounted, p } = useLeaving(shown, runPane);
  // What it showed stays on it as it goes (its chat may have gone first).
  const kept = useRef(children);
  if (shown) kept.current = children;
  if (!mounted) return null;
  return (
    <Animated.View
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      pointerEvents={shown ? "auto" : "none"}
      style={[{ width }, style, !shown && { position: "absolute", right: 0, top: 0, bottom: 0 }, { transform: [{ translateX: p.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) }] }]}
    >
      {kept.current}
    </Animated.View>
  );
}

const rise = (p: Animated.Value, to: number, done?: () => void) => run(p, to, RISE_MS, done);

/**
 * Something over the whole of its parent (a decision over its chat) that rises from the bottom when `shown` and goes back down
 * when not. `children` is kept from when it was last shown, so what it said stays on it as it leaves.
 */
export function Rise({ shown, children, style, testID }: { shown: boolean; children: ReactNode; style?: object; testID?: string }) {
  const { height } = useWindowDimensions();
  const { mounted, p } = useLeaving(shown, rise);
  const kept = useRef(children);
  if (shown) kept.current = children;
  if (!mounted) return null;
  return (
    <Animated.View testID={testID} pointerEvents={shown ? "auto" : "none"} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"} style={[StyleSheet.absoluteFill, style, { transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }]}>
      {kept.current}
    </Animated.View>
  );
}

interface Screen {
  id: string;
  node: ReactNode;
}

/**
 * One screen giving way to the next in the same place (one chat to another): the one before stays on top and fades away over
 * the new one, which is under it from the start. It is the one going that fades, and never the one coming: Liquid Glass that
 * fades in stays clear (see `opacityOf` in motion), and glass that fades out is fine. The one going keeps its own state as it
 * goes (it is the same screen, only moved on top), and takes no touches.
 */
export function CrossFade({ id, children }: { id: string; children: ReactNode }) {
  const [leaving, setLeaving] = useState<Screen[]>([]);
  const last = useRef<Screen>({ id, node: children });
  const [seen, setSeen] = useState(id);
  if (id !== seen) {
    setSeen(id);
    const gone = last.current;
    // Coming back to one that is still going takes it back: it is the one shown, under the rest.
    if (!skips()) setLeaving((ls) => [...ls.filter((l) => l.id !== gone.id && l.id !== id), gone]);
    else if (leaving.length) setLeaving([]);
  }
  last.current = { id, node: children };
  const values = useRef(new Map<string, Animated.Value>());
  const valueOf = (key: string) => {
    let v = values.current.get(key);
    if (!v) values.current.set(key, (v = new Animated.Value(1)));
    return v;
  };
  const fading = useRef(new Set<string>());
  useEffect(() => {
    for (const l of leaving) {
      if (l.id === id || fading.current.has(l.id)) continue;
      fading.current.add(l.id);
      const v = valueOf(l.id);
      v.setValue(1);
      run(v, 0, SWAP_MS, () => {
        fading.current.delete(l.id);
        values.current.delete(l.id);
        setLeaving((ls) => ls.filter((x) => x.id !== l.id));
      });
    }
    // One that came back before it had gone is shown again, whole.
    for (const k of [...fading.current]) {
      if (leaving.some((l) => l.id === k && l.id !== id)) continue;
      values.current.get(k)?.stopAnimation();
      fading.current.delete(k);
      values.current.delete(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving, id]);
  // One list, keyed, so a screen moving from shown to going (or back) is the same screen, not a new one.
  const screens = [{ id, node: children, live: true }, ...leaving.filter((l) => l.id !== id).map((l) => ({ ...l, live: false }))];
  return (
    <View style={{ flex: 1 }}>
      {screens.map((s) => (
        <Animated.View
          key={s.id}
          pointerEvents={s.live ? "auto" : "none"}
          accessibilityElementsHidden={!s.live}
          importantForAccessibility={s.live ? "auto" : "no-hide-descendants"}
          style={[StyleSheet.absoluteFill, { opacity: s.live ? 1 : valueOf(s.id) }]}
        >
          {s.node}
        </Animated.View>
      ))}
    </View>
  );
}
