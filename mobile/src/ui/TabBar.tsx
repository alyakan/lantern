/**
 * The phone's tab bar: the tabs in one capsule of Liquid Glass floating over the page (a solid card with a shadow before iOS 26),
 * and beside it a glass circle that starts a chat, as iOS 26 sets its search beside the tabs. It lives on the screen at the bottom of
 * the stack, so a chat pushed over it covers it: there is no tab bar in a chat.
 */
import { Platform, View } from "react-native";
import { Host, Image } from "@expo/ui/swift-ui";
import type { SFSymbol } from "sf-symbols-typescript";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Tab } from "../prefs";
import { Txt } from "./components";
import { Glass } from "./Glass";
import { PressScale } from "./motion";
import { radius, useColors } from "./theme";

/** How tall the bar is, and how far it sits above the home indicator: a page keeps its last row clear of both. */
export const TAB_BAR_HEIGHT = 58;
export const TAB_BAR_GAP = 6;
/** The room a page under the bar leaves at its bottom. */
export const tabBarRoom = (bottomInset: number) => bottomInset + TAB_BAR_GAP + TAB_BAR_HEIGHT + 24;

export interface TabChoice {
  id: Tab;
  label: string;
  /** How many wait on the user there (none: no badge). */
  badge?: number;
}

/** Apple's own symbol for a tab (iOS), filled while it is the one shown. Insights keeps its drawn bars. */
const SYMBOLS: Partial<Record<Tab, { off: SFSymbol; on: SFSymbol }>> = {
  chats: { off: "bubble.left.and.bubble.right", on: "bubble.left.and.bubble.right.fill" },
  work: { off: "checklist", on: "checklist" },
};

/** An SF Symbol, sized as the tab bar's pictures are. */
function SFIcon({ name, color, size = 20 }: { name: SFSymbol; color: string; size?: number }) {
  return (
    <Host style={{ width: size + 6, height: size + 2 }} alignment="center">
      <Image systemName={name} size={size} color={color} />
    </Host>
  );
}

/** A tab's picture: Apple's symbol on iOS, else drawn (a speech bubble, a tick); Insights' three bars are always drawn. */
function Glyph({ id, color, on = false }: { id: Tab; color: string; on?: boolean }) {
  const symbol = Platform.OS === "ios" ? SYMBOLS[id] : undefined;
  if (symbol) return <SFIcon name={on ? symbol.on : symbol.off} color={color} />;
  if (id === "chats")
    return (
      <View style={{ width: 22, height: 20 }}>
        <View style={{ width: 22, height: 16, borderRadius: 6, borderWidth: 2, borderColor: color }} />
        <View style={{ position: "absolute", left: 4, bottom: 0, width: 6, height: 6, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ skewY: "-30deg" }] }} />
      </View>
    );
  if (id === "work")
    return (
      <View style={{ width: 22, height: 20, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 13, height: 7, borderLeftWidth: 2.4, borderBottomWidth: 2.4, borderColor: color, transform: [{ rotate: "-45deg" }], marginTop: -4 }} />
      </View>
    );
  return (
    <View style={{ width: 22, height: 20, flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 3 }}>
      {[10, 18, 13].map((h, i) => (
        <View key={i} style={{ width: 4, height: h, borderRadius: 2, backgroundColor: color }} />
      ))}
    </View>
  );
}

/** Starting a chat: Apple's compose symbol on iOS, else a plus. */
function Plus({ color }: { color: string }) {
  if (Platform.OS === "ios") return <SFIcon name="square.and.pencil" color={color} size={21} />;
  return (
    <View accessibilityElementsHidden style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: 20, height: 2.4, borderRadius: 1.2, backgroundColor: color }} />
      <View style={{ position: "absolute", width: 2.4, height: 20, borderRadius: 1.2, backgroundColor: color }} />
    </View>
  );
}

export function TabBar({ tabs, value, onChange, onCompose, onComposeVoice }: { tabs: TabChoice[]; value: Tab; onChange: (tab: Tab) => void; /** Starts a chat, typed. */ onCompose: () => void; /** Held down: starts a chat by talking. */ onComposeVoice: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View testID="tab-bar" pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom - 8, 0) + TAB_BAR_GAP, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Glass accessibilityRole="tablist" lift={0.12} style={{ flex: 1, height: TAB_BAR_HEIGHT, borderRadius: TAB_BAR_HEIGHT / 2, flexDirection: "row", padding: 4 }}>
        {tabs.map((t) => {
          const on = t.id === value;
          const tone = on ? colors.cobalt : colors.ink2;
          return (
            <PressScale key={t.id} accessibilityRole="tab" accessibilityLabel={t.badge ? `${t.label}, ${t.badge} waiting` : t.label} accessibilityState={{ selected: on }} onPress={() => onChange(t.id)} haptic="select" scaleTo={0.92} style={{ flex: 1, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", gap: 2, backgroundColor: on ? colors.wash : "transparent" }}>
              <Glyph id={t.id} color={tone} on={on} />
              <Txt variant="tiny" style={{ color: tone, fontWeight: "600" }}>
                {t.label}
              </Txt>
              {!!t.badge && (
                <View accessibilityElementsHidden style={{ position: "absolute", top: 4, right: "24%", minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: colors.hi }}>
                  <Txt variant="tiny" tone="on-hi" style={{ fontWeight: "800", fontSize: 10 }}>
                    {t.badge > 99 ? "99+" : t.badge}
                  </Txt>
                </View>
              )}
            </PressScale>
          );
        })}
      </Glass>
      <PressScale accessibilityRole="button" accessibilityLabel="New chat" accessibilityHint="Hold to talk" onPress={onCompose} onLongPress={onComposeVoice} delayLongPress={300} accessibilityActions={[{ name: "longpress", label: "New chat by voice" }]} onAccessibilityAction={(e) => e.nativeEvent.actionName === "longpress" && onComposeVoice()} haptic="light" scaleTo={0.9}>
        <Glass lift={0.12} style={{ width: TAB_BAR_HEIGHT, height: TAB_BAR_HEIGHT, borderRadius: TAB_BAR_HEIGHT / 2, alignItems: "center", justifyContent: "center" }}>
          <Plus color={colors.ink} />
        </Glass>
      </PressScale>
    </View>
  );
}
