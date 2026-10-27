import { useRef, type ReactNode } from "react";
import { Animated, type LayoutChangeEvent } from "react-native";
import { run } from "./motion";

/**
 * Lets what it holds glide to a new place instead of jumping: when its row of the list is laid out somewhere else (a chat changed
 * status and the list reordered, a line appeared above it), it starts from where it was and eases to where it is. It moves only
 * itself, unlike LayoutAnimation, which animates every layout change on the screen (a chat open beside the list included).
 */
export function Glide({ children, testID }: { children: ReactNode; testID?: string }) {
  const dy = useRef(new Animated.Value(0)).current;
  const was = useRef<number | null>(null);
  const placed = (e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    const before = was.current;
    was.current = y;
    // Its first place is just where it is; a nudge of a point or less isn't a move.
    if (before === null || Math.abs(before - y) < 1) return;
    dy.setValue(before - y);
    run(dy, 0, 260);
  };
  return (
    <Animated.View testID={testID} onLayout={placed} style={{ transform: [{ translateY: dy }] }}>
      {children}
    </Animated.View>
  );
}
