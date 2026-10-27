/**
 * Searching the chat list. A search circle floats at the bottom right of Home, the same one as beside a chat's message box; pressed,
 * it opens into a field across the bottom that rides on the keyboard. What is typed narrows the list to the chats whose title,
 * project or preview say it.
 */
import { Keyboard, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Txt } from "../ui/components";
import { Glass } from "../ui/Glass";
import { FadeSlideIn, PopIn, PressScale } from "../ui/motion";
import { useColors } from "../ui/theme";
import { Magnifier } from "./SearchBar";

export interface HomeSearchProps {
  active: boolean;
  query: string;
  /** How many chats answer what is typed (shown once something is). */
  found: number;
  /** Extra room under it, where something else sits at the corner (Android's "Message a chat"). */
  lift?: number;
  onOpen: () => void;
  onChange: (text: string) => void;
  onClose: () => void;
}

const CIRCLE = 48;

export function HomeSearch({ active, query, found, lift = 0, onOpen, onChange, onClose }: HomeSearchProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const typed = query.trim().length > 0;
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom - 8 }} style={{ position: "absolute", left: 0, right: 0, bottom: 0 }} pointerEvents="box-none">
      <View pointerEvents="box-none" style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 14 + lift, alignItems: "flex-end" }}>
        {active ? (
          <FadeSlideIn glass from={10} ms={180} style={{ alignSelf: "stretch" }}>
            <Glass style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: CIRCLE, paddingLeft: 16, paddingRight: 8, borderRadius: CIRCLE / 2 }}>
              <Magnifier color={colors.ink3} />
              <TextInput
                autoFocus
                accessibilityLabel="Search chats"
                value={query}
                onChangeText={onChange}
                onSubmitEditing={() => Keyboard.dismiss()}
                placeholder="Search chats"
                placeholderTextColor={colors.ink3}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                clearButtonMode="while-editing"
                style={{ flex: 1, fontSize: 16, color: colors.ink, paddingVertical: 10 }}
              />
              {typed && (
                <Txt accessibilityLiveRegion="polite" variant="tiny" tone="ink2">
                  {found === 0 ? "No match" : found === 1 ? "1 chat" : `${found} chats`}
                </Txt>
              )}
              <PressScale accessibilityRole="button" accessibilityLabel="Cancel search" onPress={onClose} hitSlop={6} haptic="select" scaleTo={0.88}>
                <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.ink}12` }}>
                  <View accessibilityElementsHidden style={{ width: 12, height: 12 }}>
                    <View style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink, transform: [{ rotate: "45deg" }] }} />
                    <View style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink, transform: [{ rotate: "-45deg" }] }} />
                  </View>
                </View>
              </PressScale>
            </Glass>
          </FadeSlideIn>
        ) : (
          <PopIn glass>
            <PressScale accessibilityRole="button" accessibilityLabel="Search chats" onPress={onOpen} scaleTo={0.9} haptic="light">
              <Glass style={{ width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, alignItems: "center", justifyContent: "center" }}>
                <Magnifier />
              </Glass>
            </PressScale>
          </PopIn>
        )}
      </View>
    </KeyboardStickyView>
  );
}
