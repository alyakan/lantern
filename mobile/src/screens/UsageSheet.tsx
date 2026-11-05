import { claudeUsage, currentUsageWindows } from "../view/providerUsage";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PlanUsage } from "../sync/reducer";
import type { ProviderUsage } from "../protocol/generated/ProviderUsage";
import { useUsageHistory } from "../usageHistory";
import { Button, Txt } from "../ui/components";
import { WindowRow } from "./ChatExtras";
import { Sheet } from "../ui/Sheet";
import { space, useColors } from "../ui/theme";
import { dailyBars, daysKnown } from "../view/usageHistory";

const CHART_HEIGHT = 72;

export function UsageSheet({ plan, providers = {}, onClose }: { plan: PlanUsage | null; providers?: Record<string, ProviderUsage>; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const claude = claudeUsage(plan);
  return <Sheet size="large" onClose={onClose}>{(close, scroll) => <ScrollView ref={scroll} contentContainerStyle={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 12 }}>
    <Txt variant="heading" accessibilityRole="header">Usage by provider</Txt>
    {[...new Set(["claude", "codex", ...Object.keys(providers)])].map(id => <ProviderSection key={id} id={id} reading={id === "claude" ? claude : providers[id]} />)}
    <Button label="Close" onPress={close} />
  </ScrollView>}</Sheet>;
}

function ProviderSection({ id, reading }: { id: string; reading?: ProviderUsage }) {
  const colors = useColors();
  const history = useUsageHistory(id);
  const now = Date.now();
  const windows = currentUsageWindows(reading, now);
  const bars = dailyBars(history, now);
  const known = daysKnown(history, now);
  const name = id === "claude" ? "Claude" : id === "codex" ? "Codex" : id;
  return <View style={{ gap: 8 }}>
    <Txt variant="heading">{name}</Txt>
    {windows.length === 0 ? <Txt variant="body" tone="ink3">Usage unavailable</Txt> : windows.map(w => <WindowRow key={w.label} window={w} />)}
    {!!reading?.updated_at && <Txt variant="tiny" tone="ink3">Last updated {new Date(reading.updated_at * 1000).toLocaleTimeString()}</Txt>}
    <Txt variant="small" tone="ink3" style={{ fontWeight: "700", marginTop: 8 }}>Highest session use each day</Txt>
    <View testID={id === "claude" ? "usage-chart" : `usage-chart-${id}`} accessible accessibilityLabel={`${name}, highest session use each day: ${bars.map(b => `${b.label} ${b.peak === null ? "nothing seen" : `${b.peak} percent`}`).join(", ")}`} style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, height: CHART_HEIGHT + 34 }}>
      {bars.map((b, i) => <View key={i} style={{ flex: 1, alignItems: "center", gap: 4 }}>
        <Txt variant="tiny" tone="ink3">{b.peak === null ? "–" : `${b.peak}%`}</Txt>
        <View style={{ width: "100%", height: CHART_HEIGHT, justifyContent: "flex-end", backgroundColor: colors.wash, borderRadius: 6, overflow: "hidden" }}>{b.peak !== null && <View style={{ height: Math.max(3, b.peak / 100 * CHART_HEIGHT), backgroundColor: b.peak >= 100 ? colors.stop : b.peak >= 80 ? colors.hi : colors.go, borderRadius: 6 }} />}</View>
        <Txt variant="tiny" tone={b.today ? "ink" : "ink3"}>{b.label}</Txt>
      </View>)}
    </View>
    <Txt variant="tiny" tone="ink3">{known === 0 ? "This phone has not seen enough yet." : `This phone has seen ${known === 1 ? "1 day" : `${known} days`} of numbers. Days it was not connected show a dash.`} Kept on this phone only.</Txt>
  </View>;
}
