import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PlanUsage } from "../sync/reducer";
import { useUsageHistory } from "../usageHistory";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { space, useColors } from "../ui/theme";
import { usageOf, weekOf } from "../view/plan";
import { dailyBars, daysKnown } from "../view/usageHistory";

const CHART_HEIGHT = 72;

/** The plan's usage, in full: where the five-hour and weekly windows stand, and the highest the five-hour one reached each day this week, as this phone saw it. */
export function UsageSheet({ plan, onClose }: { plan: PlanUsage; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const history = useUsageHistory();
  const now = Date.now();
  const five = usageOf(plan, now);
  const week = plan.week ? weekOf(plan.week, now) : null;
  const bars = dailyBars(history, now);
  const known = daysKnown(history, now);
  const toneColour = (peak: number) => (peak >= 100 ? colors.stop : peak >= 80 ? colors.hi : colors.go);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 10 }]}>
          <Txt variant="heading" accessibilityRole="header">
            Session
          </Txt>
          <Txt variant="body">
            {five.tone === "stop" ? "The five-hour limit is reached." : `${five.percent}% of the five-hour window is used.`} {five.resets}
          </Txt>
          {week && (
            <Txt variant="body" tone="ink2">
              {week.sentence}
            </Txt>
          )}
          <Txt variant="small" tone="ink3" style={{ fontWeight: "700", marginTop: 8 }}>
            Highest five-hour use each day
          </Txt>
          <View testID="usage-chart" accessible accessibilityLabel={`The highest five-hour use each day: ${bars.map((b) => `${b.label} ${b.peak === null ? "nothing seen" : `${b.peak} percent`}`).join(", ")}`} style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, height: CHART_HEIGHT + 34 }}>
            {bars.map((b, i) => (
              <View key={i} style={{ flex: 1, alignItems: "center", gap: 4 }}>
                <Txt variant="tiny" tone="ink3">
                  {b.peak === null ? "–" : `${b.peak}%`}
                </Txt>
                <View style={{ width: "100%", height: CHART_HEIGHT, justifyContent: "flex-end", backgroundColor: colors.wash, borderRadius: 6, overflow: "hidden" }}>
                  {b.peak !== null && <View style={{ height: Math.max(3, (b.peak / 100) * CHART_HEIGHT), backgroundColor: toneColour(b.peak), borderRadius: 6 }} />}
                </View>
                <Txt variant="tiny" tone={b.today ? "ink" : "ink3"} style={b.today ? { fontWeight: "700" } : undefined}>
                  {b.label}
                </Txt>
              </View>
            ))}
          </View>
          <Txt variant="tiny" tone="ink3">
            {known === 0 ? "This phone has not seen enough yet." : `This phone has seen ${known === 1 ? "1 day" : `${known} days`} of numbers. Days it was not connected show a dash.`} Kept on this phone only.
          </Txt>
          <Button label="Close" onPress={close} style={{ marginTop: 6 }} />
        </View>
      )}
    </Sheet>
  );
}
