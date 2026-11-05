/**
 * The phone's tab bar: the tabs in one capsule of Liquid Glass floating over the page (a solid card with a shadow before iOS 26),
 * and beside it a glass circle that starts a chat, as iOS 26 sets its search beside the tabs. It lives on the screen at the bottom of
 * the stack, so a chat pushed over it covers it: there is no tab bar in a chat.
 */
import { View } from "react-native";
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

/** A rounded bar, the stroke every tab picture is drawn with. */
function Bar({ x, y, w, h = 4, color }: { x: number; y: number; w: number; h?: number; color: string }) {
  return <View style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 2, backgroundColor: color }} />;
}

/** A tab's picture, drawn in rounded bars: the chats as lines of a conversation, Work as a list with one done and one to do,
 * Insights as a bar chart. */
function Glyph({ id, color }: { id: Tab; color: string }) {
  return (
    <View accessibilityElementsHidden style={{ width: 22, height: 20 }}>
      {id === "chats" ? (
        <>
          <Bar x={1} y={2} w={16} color={color} />
          <Bar x={5} y={8} w={16} color={color} />
          <Bar x={1} y={14} w={11} color={color} />
        </>
      ) : id === "work" ? (
        <>
          <View style={{ position: "absolute", left: 1, top: 2.5, width: 5, height: 5, borderRadius: 2.5, backgroundColor: color }} />
          <Bar x={8} y={3} w={13} color={color} />
          <View style={{ position: "absolute", left: 0.6, top: 12.1, width: 5.8, height: 5.8, borderRadius: 2.9, borderWidth: 1.8, borderColor: color }} />
          <Bar x={8} y={13} w={9} color={color} />
        </>
      ) : (
        <>
          <Bar x={3.5} y={10} w={4} h={10} color={color} />
          <Bar x={9} y={2} w={4} h={18} color={color} />
          <Bar x={14.5} y={7} w={4} h={13} color={color} />
        </>
      )}
    </View>
  );
}

/** Starting a chat: a plus of the same bars, centred in its circle. */
function Plus({ color }: { color: string }) {
  return (
    <View accessibilityElementsHidden style={{ width: 18, height: 18 }}>
      <Bar x={7} y={0} w={4} h={18} color={color} />
      <Bar x={0} y={7} w={18} h={4} color={color} />
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
              <Glyph id={t.id} color={tone} />
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
