/**
 * Searching a chat from the chat bar. A search circle sits at the right of the bar. Pressed, the circle itself grows leftwards
 * over the bar into the search field (the magnifier stays in it and moves to the field's left; the words, how many matches, the
 * arrows and a way out come in beside it), and when the search ends it shrinks back into the circle. The bar does not stretch: it
 * stays where it is, under the growing field, and fades. It is a spring: the field passes its full width a little and settles, and
 * the circle passes its size a little as it returns.
 *
 * Typing in the message box is a different thing: the circle gives its room to the bar, which does widen then.
 *
 * The message box never leaves the bar or changes how it takes touches: the field is a layer over it, there only while searching
 * (`display: none` otherwise, so it can't catch a touch meant for the box). What was typed in the box is kept, and the keyboard is
 * handed from one text field to the other without dropping.
 */
import { useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from "react";
import { Animated, Keyboard, TextInput, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { Txt } from "../ui/components";
import { Chevron } from "../ui/Chevron";
import { Glass } from "../ui/Glass";
import { useKeyboardUp } from "../ui/keyboard";
import { easeLayout, PressScale, springLayout } from "../ui/motion";
import { control, useColors } from "../ui/theme";

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

/** The circle's size until the bar has been measured; it then takes the bar's own height, which is the same number at rest. */
const CIRCLE = control;
const GAP = 8;
/** Room at the search field's left inside the bar. */
const FIELD_LEFT = 16;
/** How long the field waits for the keyboard to start coming before it grows anyway. */
const GROW_WAIT_MS = 400;
/** How long the search, opened here, waits for its field to have the keyboard before it tells the chat anyway. */
const OPEN_TELL_MS = 300;
/** The magnifier's own size. */
const MAGNIFIER = 20;
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
 * 0 and 1 for something being off and on. With `spring`, on the way to 1 it springs, passing 1 a little, and on the way back to
 * 0 it doesn't pass 0. Without, it eases into place both ways and passes neither.
 */
function useSwap(active: boolean, spring = true): Animated.Value {
  const t = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (spring) springLayout(t, active ? 1 : 0, active ? { bounciness: 6, speed: 11 } : { bounciness: 0, speed: 12 });
    else easeLayout(t, active ? 1 : 0);
  }, [active, spring, t]);
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

/** What the grown circle holds beside its magnifier: the field, "2 of 5", the arrows, and the way out. */
function SearchContents({ search, input, onFocused, onCancel }: { search: BarSearch; input: RefObject<ComponentRef<typeof TextInput> | null>; onFocused: () => void; onCancel: () => void }) {
  const colors = useColors();
  const typed = search.query.trim().length >= 2;
  const none = typed && search.count === 0;
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: GAP, minHeight: 36 }}>
      <TextInput
        ref={input}
        accessibilityLabel="Search"
        value={search.query}
        onChangeText={search.onChange}
        // Return goes to the next older match, like the up arrow.
        onSubmitEditing={() => search.onStep(-1)}
        onFocus={() => {
          onFocused();
        }}
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
      <RoundButton label="Cancel search" onPress={onCancel}>
        <View accessibilityElementsHidden style={{ width: 12, height: 12 }}>
          <View style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink, transform: [{ rotate: "45deg" }] }} />
          <View style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink, transform: [{ rotate: "-45deg" }] }} />
        </View>
      </RoundButton>
    </View>
  );
}

/**
 * A bar (the message box, or the asleep chat's Wake button) with a search circle at its right that grows into the search field.
 * `children` are what the bar holds, laid out in a row; `capsule` is the bar's own shape and padding. `back` puts the keyboard back
 * in the message box when the search ends, if the keyboard was up when it began (else the keyboard goes down, as it was).
 */
export function SearchBar({ search, circle = true, typing = false, capsule, lift, fill, back, children }: { search?: BarSearch; /** Words are being typed in the message box: the circle gives its room to the bar. */ typing?: boolean; /** False where there is no room for it (a terminal). */ circle?: boolean; capsule: StyleProp<ViewStyle>; lift?: number; fill?: string; back?: () => void; children: ReactNode }) {
  const keyboard = useKeyboardUp();
  const { width: screenWidth } = useWindowDimensions();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  // The search opens here first: the field is shown and asks for the keyboard at once, and the chat is told once the field has
  // it. Told first, the chat drew itself again before the field could ask (about 70 ms on the simulator, more on a phone), and
  // the keyboard came late, after the field had started to grow, so the bar caught up with it instead of riding it from the start.
  const [opening, setOpening] = useState(false);
  const active = !!search?.active || opening;
  const told = useRef(false);
  const tell = () => {
    if (told.current || !search) return;
    told.current = true;
    search.onOpen();
  };
  useEffect(() => {
    if (search?.active) setOpening(false);
  }, [search?.active]);
  useEffect(() => {
    if (!opening) return;
    told.current = false;
    // If the field never says it has the keyboard, the chat is told anyway.
    const t = setTimeout(tell, OPEN_TELL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening]);
  const hasCircle = !!search && circle;
  // Two values, each for one thing: `gone` for the circle giving its room to the bar while words are typed, `open` for the circle
  // being grown into the field. Nothing else may follow either (the box going blank was one value doing both).
  const gone = useSwap(typing && !active);
  // The field grows across the whole row: the bar's little overshoot, barely seen on its short way (the circle's width), was a
  // wobble over that distance, and even a spring without bounce passed its place a little (the bar overshot as the field went).
  // So it has no spring: it eases in and out.
  // The field starts growing when the keyboard starts coming, not at the press. Grown from the press, it was growing (its width
  // moving every frame) as the keyboard set off, and the bar then went straight to where the keyboard would end and waited for
  // it, instead of riding it up as it does when the message box is tapped (seen on the simulator, frame by frame; with the field
  // shown at once it rode the keyboard, and so it does when the two start together). If the keyboard is up already, or doesn't
  // say it is coming, it grows anyway.
  const [grow, setGrow] = useState(active);
  useEffect(() => {
    if (!active) {
      setGrow(false);
      return;
    }
    if (keyboard) {
      setGrow(true);
      return;
    }
    const sub = Keyboard.addListener("keyboardWillShow", () => setGrow(true));
    const t = setTimeout(() => setGrow(true), GROW_WAIT_MS);
    return () => {
      sub.remove();
      clearTimeout(t);
    };
    // (Only the search starting or ending runs this: the keyboard is read, not followed.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const open = useSwap(grow, false);
  // The circle is as tall as the bar is at rest: the least height the bar has had (it grows with a long message, the circle doesn't).
  const [seen, setSeen] = useState<number | null>(null);
  const size = seen ?? CIRCLE;
  // How wide the row is, which is how wide the field grows to (until it is measured, the screen less the page's margins).
  const [rowWidth, setRowWidth] = useState(screenWidth - 24);
  // While the bar is shrunk (any part of the way), its words and buttons keep the width they had at rest and run on, faded, under
  // the field: let narrow, a typed draft would wrap to more lines, and the bar would grow taller as it shrank. And the field stays
  // there (fading) until the circle is back: taken away at once as the search ended, it had the keyboard, and the chat and the bar
  // jumped down in one frame while the keyboard was still going (seen on the simulator).
  const [innerWidth, setInnerWidth] = useState<number | null>(null);
  const [shrunk, setShrunk] = useState(active);
  useEffect(() => {
    const id = open.addListener(({ value }) => setShrunk(value > 0.01));
    return () => open.removeListener(id);
  }, [open]);
  const keyboardBefore = useRef(false);
  const was = useRef(false);
  useEffect(() => {
    if (active) {
      keyboardBefore.current = keyboard;
      was.current = true;
      // The keyboard comes at once, with the field starting to grow: the bar rides it from the start, as when the message box is
      // tapped. (It used to wait 80 ms for the field, and the bar then caught up with a keyboard already on its way.) The field is
      // laid out by now: this runs after the render that shows it.
      input.current?.focus();
      return;
    }
    if (was.current) {
      was.current = false;
      if (keyboardBefore.current) back?.();
      else Keyboard.dismiss();
    }
    // (Only the search starting or ending runs this: the keyboard moving is read here, not a reason to run it again.)
  }, [active]);

  // The circle: its width is the circle's (which goes to nothing as the bar takes its room) until it opens, then the whole row's.
  const base = gone.interpolate({ inputRange: [0, 1], outputRange: [size, 0], extrapolateRight: "clamp" });
  const notOpen = open.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  // (The field's share of the width never goes below nothing: a spring that passed 0 on its way back took the circle well under its size.)
  const width = Animated.add(Animated.multiply(base, notOpen), open.interpolate({ inputRange: [0, 1], outputRange: [0, rowWidth], extrapolateLeft: "clamp" }));
  // The bar has what the circle leaves: as the circle grows into the field the bar shrinks away beside it (the field doesn't
  // slide over it), and as words are typed it widens into the circle's room. Its words and buttons fade first, so what is seen
  // shrinking is the bar itself; the bar fades at the end, as it is all but gone.
  const barRight = Animated.add(width, gone.interpolate({ inputRange: [0, 1], outputRange: [GAP, 0], extrapolate: "clamp" }));
  const contentFade = open.interpolate({ inputRange: [0, 0.3], outputRange: [1, 0], extrapolate: "clamp" });
  const barFade = open.interpolate({ inputRange: [0.6, 0.95], outputRange: [1, 0], extrapolate: "clamp" });
  const shown = Animated.add(gone.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: "clamp" }), open).interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" });
  // The magnifier moves from the middle of the circle to the field's left; the rest comes in beside it.
  const magnifierLeft = open.interpolate({ inputRange: [0, 1], outputRange: [(size - MAGNIFIER) / 2, FIELD_LEFT], extrapolate: "clamp" });
  const fieldFade = open.interpolate({ inputRange: [0.35, 0.85], outputRange: [0, 1], extrapolate: "clamp" });
  const none = !!search && search.query.trim().length >= 2 && search.count === 0;

  return (
    <View>
      {active && none && (
        <Txt variant="tiny" tone="ink2" style={{ marginBottom: 6, marginHorizontal: 8 }}>
          Nothing says that in the messages loaded here. Earlier turns are loaded from the top of the chat.
        </Txt>
      )}
      <View testID="chat-bar-row" style={{ flexDirection: "row", alignItems: "flex-end" }} onLayout={(e) => setRowWidth(Math.round(e.nativeEvent.layout.width))}>
        <Animated.View
          testID="chat-bar"
          accessibilityElementsHidden={active}
          importantForAccessibility={active ? "no-hide-descendants" : "auto"}
          style={{ flex: 1, marginRight: hasCircle ? barRight : 0, opacity: barFade }}
          onLayout={(e) => {
            const h = Math.round(e.nativeEvent.layout.height * 2) / 2;
            if (h < BAR_MIN || h > BAR_MAX) return;
            setSeen((prev) => (prev === null || h < prev ? h : prev));
          }}
        >
          <Glass lift={lift} fill={fill} style={capsule}>
            <Animated.View
              testID="chat-bar-content"
              style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: GAP, opacity: contentFade, minWidth: (active || shrunk) && innerWidth !== null ? innerWidth : undefined }}
              onLayout={(e) => {
                if (!active && !shrunk) setInnerWidth(e.nativeEvent.layout.width);
              }}
            >
              {children}
            </Animated.View>
          </Glass>
        </Animated.View>
        {hasCircle && search && (
          <Animated.View
            testID="search-circle"
            // While the circle has given its room to the bar it is not there to a screen reader either (it has no width to be touched at).
            accessibilityElementsHidden={typing && !active}
            importantForAccessibility={typing && !active ? "no-hide-descendants" : "auto"}
            style={{ position: "absolute", right: 0, bottom: 0, width, height: size, opacity: shown }}
          >
            {/* While it is a circle the whole of it is the button; once it is the field it is not (its own buttons are), and it says nothing of being one. */}
            <PressScale
              accessible={!active}
              accessibilityRole={active ? undefined : "button"}
              accessibilityLabel={active ? undefined : "Search this chat"}
              disabled={active}
              onPress={() => setOpening(true)}
              scaleTo={0.94}
              haptic="light"
              style={{ flex: 1 }}
            >
              <Glass style={{ flex: 1, borderRadius: size / 2 }}>
                <Animated.View style={{ position: "absolute", left: magnifierLeft, top: (size - MAGNIFIER) / 2 }}>
                  <Magnifier />
                </Animated.View>
                <Animated.View style={{ position: "absolute", left: FIELD_LEFT + MAGNIFIER + GAP, right: 6, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", display: active || shrunk ? "flex" : "none", opacity: fieldFade }}>
                  <SearchContents
                    search={search}
                    input={input}
                    onFocused={() => {
                      if (opening) tell();
                    }}
                    onCancel={() => {
                      setOpening(false);
                      search.onCancel();
                    }}
                  />
                </Animated.View>
              </Glass>
            </PressScale>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
