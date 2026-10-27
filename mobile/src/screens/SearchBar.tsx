/**
 * Searching a chat from the chat bar. A search circle sits at the right of the bar; pressed, it narrows to nothing as the bar
 * takes its room and turns into the search field (the words, how many matches, arrows between them, a way out), and it swells
 * back out of the bar when the search ends. The bar swells a little as it grows, and the circle overshoots as it returns: a
 * spring, not a slide.
 *
 * The message box stays in the bar all the while, out of sight, so what was typed in it is kept, and the keyboard is handed from
 * one text field to the other without dropping.
 */
import { useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from "react";
import { Animated, Keyboard, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import { Txt } from "../ui/components";
import { Chevron } from "../ui/Chevron";
import { Glass } from "../ui/Glass";
import { useKeyboardUp } from "../ui/keyboard";
import { PressScale, springLayout } from "../ui/motion";
import { useColors } from "../ui/theme";

/** What the bar needs to search: the state of the search, and what its buttons do. */
export interface BarSearch {
  active: boolean;
  query: string;
  /** How many messages say it, and which of them is looked at (1-based, from the oldest). */
  count: number;
  position: number;
  onOpen: () => void;
  onChange: (text: string) => void;
  /** -1: on to the older match, 1: the newer. */
  onStep: (dir: 1 | -1) => void;
  onCancel: () => void;
}

/** The circle's size until the bar has been measured: a 36 point field with 6 points around it. It then takes the bar's own height. */
const CIRCLE = 48;
const GAP = 8;

/** A magnifying glass, drawn from a ring and a handle. */
export function Magnifier({ color }: { color?: string }) {
  const colors = useColors();
  const tint = color ?? colors.ink;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 20, height: 20 }}>
      <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: tint }} />
      <View style={{ position: "absolute", left: 11, top: 12, width: 8, height: 2.5, borderRadius: 2, backgroundColor: tint, transform: [{ rotate: "45deg" }] }} />
    </View>
  );
}

/** What is out of the way: not in the layout, no height, can't be touched and isn't read out. (It stays mounted, to be focused.) */
const AWAY = { position: "absolute", left: 0, right: 0, top: 0, height: 0, opacity: 0, overflow: "hidden" } as const;
const away = (hidden: boolean) => ({
  style: hidden ? AWAY : undefined,
  pointerEvents: hidden ? ("none" as const) : ("auto" as const),
  accessibilityElementsHidden: hidden,
  importantForAccessibility: hidden ? ("no-hide-descendants" as const) : ("auto" as const),
});

/** The parts of `away` that go on as props (its style goes in the style array beside the layout's own). */
const rest = (a: ReturnType<typeof away>) => ({ pointerEvents: a.pointerEvents, accessibilityElementsHidden: a.accessibilityElementsHidden, importantForAccessibility: a.importantForAccessibility });

/**
 * 0 while the bar is a message box and 1 while it is the search field. It springs: on the way to 1 it passes it a little, and on
 * the way back to 0 it passes that, which is where the circle swells past its size before it settles.
 */
function useSwap(active: boolean): Animated.Value {
  const t = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    springLayout(t, active ? 1 : 0, { bounciness: 11, speed: 11 });
  }, [active, t]);
  return t;
}

/** A small round button inside the bar. */
function RoundButton({ label, onPress, disabled, children }: { label: string; onPress: () => void; disabled?: boolean; children: ReactNode }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} hitSlop={4} haptic="select" scaleTo={0.88} opacity={disabled ? 0.35 : 1}>
      <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.ink}12` }}>{children}</View>
    </PressScale>
  );
}

/** What the bar holds while it searches: the field, "2 of 5", the arrows, and the way out. */
function SearchContents({ search, input, inset }: { search: BarSearch; input: RefObject<ComponentRef<typeof TextInput> | null>; inset: number }) {
  const colors = useColors();
  const typed = search.query.trim().length >= 2;
  const none = typed && search.count === 0;
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: GAP, minHeight: 36, paddingLeft: inset }}>
      <Magnifier color={colors.ink3} />
      <TextInput
        ref={input}
        accessibilityLabel="Search"
        value={search.query}
        onChangeText={search.onChange}
        // Return goes to the next older match, like the up arrow.
        onSubmitEditing={() => search.onStep(-1)}
        blurOnSubmit={false}
        placeholder="Search this chat"
        placeholderTextColor={colors.ink3}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={{ flex: 1, fontSize: 15, color: colors.ink, paddingVertical: 8 }}
      />
      <Txt accessibilityLiveRegion="polite" variant="tiny" tone="ink2" style={{ minWidth: 44, textAlign: "right" }}>
        {typed ? (none ? "No match" : `${search.position} of ${search.count}`) : ""}
      </Txt>
      <RoundButton label="Older match" onPress={() => search.onStep(-1)} disabled={search.count === 0}>
        <View style={{ transform: [{ rotate: "-90deg" }] }}>
          <Chevron open={false} color={colors.ink} size={7} />
        </View>
      </RoundButton>
      <RoundButton label="Newer match" onPress={() => search.onStep(1)} disabled={search.count === 0}>
        <View style={{ transform: [{ rotate: "90deg" }] }}>
          <Chevron open={false} color={colors.ink} size={7} />
        </View>
      </RoundButton>
      <RoundButton label="Cancel search" onPress={search.onCancel}>
        <View accessibilityElementsHidden style={{ width: 12, height: 12 }}>
          <View style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink, transform: [{ rotate: "45deg" }] }} />
          <View style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink, transform: [{ rotate: "-45deg" }] }} />
        </View>
      </RoundButton>
    </View>
  );
}

/**
 * A bar (the message box, or the asleep chat's Wake button) with a search circle at its right. `children` are what the bar holds
 * when it isn't searching, laid out in a row; `capsule` is the bar's own shape and padding. `back` puts the keyboard back in the
 * message box when the search ends, if the keyboard was up when it began (else the keyboard goes down, as it was).
 */
export function SearchBar({ search, circle = true, typing = false, capsule, lift, fill, inset = 0, back, children }: { search?: BarSearch; /** Words are being typed in the message box: the circle gives its room to the bar, as it does for the search field. */ typing?: boolean; /** False where there is no room for it (a terminal). */ circle?: boolean; capsule: StyleProp<ViewStyle>; lift?: number; fill?: string; /** Room at the field's left, where the bar's own padding is small. */ inset?: number; back?: () => void; children: ReactNode }) {
  const keyboard = useKeyboardUp();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const active = !!search?.active;
  // The circle is out while the bar is the search field and while words are being typed in the message box.
  const shut = active || typing;
  const t = useSwap(shut);
  // The circle is as tall as the bar is at rest: the least height the bar has had (it grows with a long message, the circle doesn't).
  const [seen, setSeen] = useState<number | null>(null);
  const size = seen ?? CIRCLE;
  const keyboardBefore = useRef(false);
  const was = useRef(false);
  useEffect(() => {
    if (active) {
      keyboardBefore.current = keyboard;
      input.current?.focus();
    } else if (was.current) {
      if (keyboardBefore.current) back?.();
      else Keyboard.dismiss();
    }
    was.current = active;
    // (Only the search starting or ending runs this: the keyboard moving is read here, not a reason to run it again.)
  }, [active]);

  const swell = t.interpolate({ inputRange: [0, 0.55, 1], outputRange: [1, 1.04, 1], extrapolate: "clamp" });
  const width = t.interpolate({ inputRange: [0, 1], outputRange: [size, 0], extrapolateRight: "clamp" });
  const margin = t.interpolate({ inputRange: [0, 1], outputRange: [GAP, 0], extrapolateRight: "clamp" });
  const fade = t.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: "clamp" });
  const shrink = t.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3], extrapolate: "clamp" });
  const none = !!search && search.query.trim().length >= 2 && search.count === 0;
  // The message box is out of the way while searching, and the search field while not (both stay, so each can be focused).
  const hideMessage = away(active);
  const hideSearch = away(!active);

  return (
    <View>
      {active && none && (
        <Txt variant="tiny" tone="ink2" style={{ marginBottom: 6, marginHorizontal: 8 }}>
          Nothing says that in the messages loaded here. Earlier turns are loaded from the top of the chat.
        </Txt>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <Animated.View testID="chat-bar" style={{ flex: 1, transform: [{ scale: swell }] }} onLayout={(e) => setSeen((prev) => { const h = Math.round(e.nativeEvent.layout.height * 2) / 2; return prev === null || h < prev ? h : prev; })}>
          <Glass lift={lift} fill={fill} style={capsule}>
            <View style={[{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: GAP }, hideMessage.style]} {...rest(hideMessage)}>
              {children}
            </View>
            {search && (
              <View style={[{ flex: 1 }, hideSearch.style]} {...rest(hideSearch)}>
                <SearchContents search={search} input={input} inset={inset} />
              </View>
            )}
          </Glass>
        </Animated.View>
        {search && circle && (
          <Animated.View pointerEvents={shut ? "none" : "auto"} style={{ width, marginLeft: margin, opacity: fade, transform: [{ scale: shrink }] }}>
            <PressScale accessibilityRole="button" accessibilityLabel="Search this chat" accessibilityElementsHidden={shut} importantForAccessibility={shut ? "no-hide-descendants" : "auto"} onPress={search.onOpen} scaleTo={0.9} haptic="light">
              <Glass testID="search-circle" style={{ width: "100%", height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}>
                <Magnifier />
              </Glass>
            </PressScale>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
