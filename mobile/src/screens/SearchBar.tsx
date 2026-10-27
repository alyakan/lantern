/**
 * Searching a chat from the chat bar. A search circle sits at the right of the bar; pressed, it narrows to nothing as the bar
 * takes its room and turns into the search field (the words, how many matches, arrows between them, a way out), and it swells
 * back out of the bar when the search ends. The bar swells a little as it grows, and the circle overshoots as it returns: a
 * spring, not a slide.
 *
 * The message box never leaves the bar or changes how it takes touches: the search field is a layer over it, there only while
 * searching (and not there at all otherwise, so it can't catch a touch meant for the box). What was typed in the box is kept, and
 * the keyboard is handed from one text field to the other without dropping.
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
/** Room at the search field's left inside the bar, and how long the keyboard waits for the field to be there and the bar to start growing. */
const FIELD_LEFT = 16;
const FOCUS_DELAY_MS = 80;
/**
 * What the bar can measure at rest (a 36 point field with 6 points around it, more with large text). A measurement outside it is a
 * layout in passing, not the bar, and must not be what the circle is sized by: the circle keeps the least height seen, so one odd
 * one would shrink it for good.
 */
const BAR_MIN = 40;
const BAR_MAX = 80;

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
function SearchContents({ search, input }: { search: BarSearch; input: RefObject<ComponentRef<typeof TextInput> | null> }) {
  const colors = useColors();
  const typed = search.query.trim().length >= 2;
  const none = typed && search.count === 0;
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: GAP, minHeight: 36 }}>
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
export function SearchBar({ search, circle = true, typing = false, capsule, lift, fill, back, children }: { search?: BarSearch; /** Words are being typed in the message box: the circle gives its room to the bar, as it does for the search field. */ typing?: boolean; /** False where there is no room for it (a terminal). */ circle?: boolean; capsule: StyleProp<ViewStyle>; lift?: number; fill?: string; back?: () => void; children: ReactNode }) {
  const keyboard = useKeyboardUp();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const active = !!search?.active;
  // The circle is out while the bar is the search field and while words are being typed in the message box.
  const shut = active || typing;
  const t = useSwap(shut);
  // The search field and the message box fading in and out of each other follow the SEARCH alone. They must not follow `t`, which
  // also moves while words are typed in the message box (the circle makes room): that faded the box out and left the bar blank.
  const f = useSwap(active);
  // The circle is as tall as the bar is at rest: the least height the bar has had (it grows with a long message, the circle doesn't).
  const [seen, setSeen] = useState<number | null>(null);
  const size = seen ?? CIRCLE;
  const keyboardBefore = useRef(false);
  const was = useRef(false);
  useEffect(() => {
    if (active) {
      keyboardBefore.current = keyboard;
      was.current = true;
      // The field was not there a frame ago: a moment for it to be laid out, and for the bar to start growing before the keyboard
      // rises, so the two don't both begin at once.
      const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (was.current) {
      was.current = false;
      if (keyboardBefore.current) back?.();
      else Keyboard.dismiss();
    }
    // (Only the search starting or ending runs this: the keyboard moving is read here, not a reason to run it again.)
  }, [active]);

  const swell = t.interpolate({ inputRange: [0, 0.55, 1], outputRange: [1, 1.04, 1], extrapolate: "clamp" });
  const width = t.interpolate({ inputRange: [0, 1], outputRange: [size, 0], extrapolateRight: "clamp" });
  const margin = t.interpolate({ inputRange: [0, 1], outputRange: [GAP, 0], extrapolateRight: "clamp" });
  const fade = t.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: "clamp" });
  const shrink = t.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3], extrapolate: "clamp" });
  const none = !!search && search.query.trim().length >= 2 && search.count === 0;
  // The message box fades out as the field fades in over it. Nothing is ever made untouchable: the field is there only while searching.
  const boxFade = f.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: "clamp" });
  const fieldFade = f.interpolate({ inputRange: [0.25, 0.8], outputRange: [0, 1], extrapolate: "clamp" });

  return (
    <View>
      {active && none && (
        <Txt variant="tiny" tone="ink2" style={{ marginBottom: 6, marginHorizontal: 8 }}>
          Nothing says that in the messages loaded here. Earlier turns are loaded from the top of the chat.
        </Txt>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <Animated.View testID="chat-bar" style={{ flex: 1, transform: [{ scale: swell }] }} onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height * 2) / 2;
          if (h < BAR_MIN || h > BAR_MAX) return;
          setSeen((prev) => (prev === null || h < prev ? h : prev));
        }}>
          <Glass lift={lift} fill={fill} style={capsule}>
            <Animated.View accessibilityElementsHidden={active} importantForAccessibility={active ? "no-hide-descendants" : "auto"} style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: GAP, opacity: boxFade }}>
              {children}
            </Animated.View>
            {search && (
              <Animated.View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", paddingLeft: FIELD_LEFT, paddingRight: 6, display: active ? "flex" : "none", opacity: fieldFade }}>
                <SearchContents search={search} input={input} />
              </Animated.View>
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
