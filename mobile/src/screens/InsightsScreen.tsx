/**
 * Insights, a phone's third tab: four questions, each answered in a sentence first and then one chart or row of figures that
 * backs it up. Where the usage goes, whether the savings work, what got done, and how the user works. The Mac works them out
 * from Claude Code's logs and git; this only shows them.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Insights } from "../protocol/generated/Insights";
import type { InsightsBar } from "../protocol/generated/InsightsBar";
import type { InsightsRange } from "../protocol/generated/InsightsRange";
import type { InsightsShare } from "../protocol/generated/InsightsShare";
import { useController, useSyncState } from "../shell/hooks";
import { Txt } from "../ui/components";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Dots } from "../ui/skeleton";
import { tabBarRoom } from "../ui/TabBar";
import { TOP_BAR_GAP, TOP_BAR_HEIGHT } from "../ui/TopBar";
import { radius, shadow, space, useColors } from "../ui/theme";
import { projectColorOf, projectTint } from "../view/home";
import { change, percent, tokens, wait } from "../view/insights";

const RANGES: { id: InsightsRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

// What was shown last, per stretch: the tab opens on it while the Mac works out a fresh one.
const kept = new Map<InsightsRange, Insights>();

function Section({ label, headline, children }: { label: string; headline: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Txt variant="tiny" tone="ink3" accessibilityRole="header" style={{ fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: 4 }}>
        {label}
      </Txt>
      <Txt variant="heading" style={{ paddingHorizontal: 4 }}>
        {headline}
      </Txt>
      {children}
    </View>
  );
}

function Card({ children, label }: { children: ReactNode; label?: string }) {
  const colors = useColors();
  return (
    <View accessibilityLabel={label} style={[{ backgroundColor: colors.card, borderRadius: radius.card - 6, padding: 14, gap: 8 }, shadow.card, { shadowOpacity: 0.04 }]}>
      {children}
    </View>
  );
}

/** A figure, what it is, and how it moved. */
function Figure({ value, label, delta }: { value: string; label: string; delta?: { text: string; good: boolean } | null }) {
  const colors = useColors();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}${delta ? `, ${delta.text === "same" ? "about the same" : delta.text.replace("▲", "up").replace("▼", "down")}` : ""}`} style={{ flex: 1, backgroundColor: colors.card, borderRadius: 14, padding: 10, gap: 2 }}>
      <Txt variant="heading" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Txt>
      <Txt variant="tiny" tone="ink2">
        {label}
      </Txt>
      {delta && (
        <Txt variant="tiny" style={{ fontWeight: "700", color: delta.text === "same" ? colors.ink3 : delta.good ? colors.go : colors.stop }}>
          {delta.text === "same" ? "— same" : delta.text}
        </Txt>
      )}
    </View>
  );
}

/** Bars over time: the highest is full height, the latest in the accent. */
function Bars({ bars, every }: { bars: InsightsBar[]; /** Label only every nth bar (a month has 30). */ every: number }) {
  const colors = useColors();
  const top = Math.max(1, ...bars.map((b) => b.weighted));
  const H = 84;
  return (
    <View accessibilityLabel={`Usage over time. Highest: ${tokens(top)} weighted tokens.`} accessible>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: H, gap: bars.length > 12 ? 2 : 6 }}>
        {bars.map((b, i) => (
          <View key={i} style={{ flex: 1, height: Math.max(2, (b.weighted / top) * H), borderRadius: 3, backgroundColor: i === bars.length - 1 ? colors.cobalt : b.weighted === 0 ? colors.rule : colors.shapeStrong }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: bars.length > 12 ? 2 : 6, marginTop: 4 }}>
        {bars.map((b, i) => (
          <Txt key={i} variant="tiny" tone="ink3" numberOfLines={1} style={{ flex: 1, textAlign: "center", fontSize: 10 }}>
            {i % every === 0 || i === bars.length - 1 ? b.label : ""}
          </Txt>
        ))}
      </View>
    </View>
  );
}

/** Parts of the whole as rows of bars, each in its project's colour where the Mac gave one. */
function Shares({ list, colorOf }: { list: InsightsShare[]; colorOf: (name: string) => string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      {list.map((s) => (
        <View key={s.name} accessible accessibilityLabel={`${s.name}: ${percent(s.share)}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Txt variant="small" numberOfLines={1} style={{ width: 88 }}>
            {s.name}
          </Txt>
          <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.wash, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(2, s.share * 100)}%`, height: "100%", borderRadius: 4, backgroundColor: colorOf(s.name) }} />
          </View>
          <Txt variant="small" tone="ink2" style={{ width: 40, textAlign: "right", fontVariant: ["tabular-nums"] }}>
            {percent(s.share)}
          </Txt>
        </View>
      ))}
    </View>
  );
}

export function InsightsScreen({ top }: { top: ReactNode; onOpenChat?: (slot: string) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  const { chats } = useSyncState();
  const [range, setRange] = useState<InsightsRange>("week");
  const [shown, setShown] = useState<Insights | null>(kept.get("week") ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [barHeight, setBarHeight] = useState(0);
  const asked = useRef(0);
  const load = (r: InsightsRange) => {
    const n = ++asked.current;
    setLoading(true);
    setError(null);
    sync.insights(r).then(
      (i) => {
        kept.set(r, i);
        if (n !== asked.current) return;
        setShown(i);
        setLoading(false);
      },
      (e: Error) => {
        if (n !== asked.current) return;
        setError(e.message);
        setLoading(false);
      },
    );
  };
  useEffect(() => load(range), [range]);
  const pick = (r: InsightsRange) => {
    setShown(kept.get(r) ?? null);
    setRange(r);
  };
  // A project's colour is the one the Mac's sidebar gives it, known from a chat open there.
  const colorOf = (name: string) => {
    const c = chats.find((chat) => chat.project === name)?.project_color;
    return c ? projectTint(projectColorOf(c), colors.plainTint).fg : colors.cobalt;
  };
  const i = shown;
  const hoursTop = i ? Math.max(1, ...i.habits.hours) : 1;
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: (barHeight || insets.top + TOP_BAR_GAP + TOP_BAR_HEIGHT) + 12, paddingBottom: tabBarRoom(insets.bottom), gap: 22 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => load(range)} />}
      >
        <View accessibilityRole="tablist" style={{ flexDirection: "row", padding: 2, borderRadius: radius.pill, backgroundColor: colors.wash }}>
          {RANGES.map((r) => (
            <PressScale key={r.id} accessibilityRole="tab" accessibilityLabel={r.label} accessibilityState={{ selected: r.id === range }} onPress={() => pick(r.id)} haptic="select" scaleTo={0.95} style={[{ flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: radius.pill }, r.id === range ? [{ backgroundColor: colors.card }, shadow.card, { shadowOpacity: 0.06 }] : null]}>
              <Txt variant="small" tone={r.id === range ? "ink" : "ink2"} style={{ fontWeight: "700" }}>
                {r.label}
              </Txt>
            </PressScale>
          ))}
        </View>

        {loading && (
          <View accessible accessibilityLabel="Working out your insights" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
            <Dots />
            <Txt variant="small" tone="ink2">
              {i ? "Updating…" : "Your Mac is reading your chats' logs. The first time takes a little while."}
            </Txt>
          </View>
        )}
        {error && !loading && (
          <Txt variant="small" tone="stop" accessibilityRole="alert" style={{ paddingHorizontal: 4 }}>
            {error}
          </Txt>
        )}

        {i && (
          <FadeSlideIn from={8} style={{ gap: 26 }}>
            <Section label="Usage" headline={i.usage.headline}>
              <Card>
                <Bars bars={i.usage.bars} every={i.range === "month" ? 5 : i.range === "today" ? 6 : 1} />
                <Txt variant="tiny" tone="ink2">
                  {tokens(i.usage.weighted)} weighted tokens · {tokens(i.usage.tokens)} sent and received
                </Txt>
              </Card>
              {i.usage.projects.length > 0 && (
                <Card label="By project">
                  <Shares list={i.usage.projects} colorOf={colorOf} />
                  {i.usage.models.length > 1 && (
                    <Txt variant="tiny" tone="ink2">
                      {i.usage.models.map((m) => `${m.name} ${percent(m.share)}`).join(" · ")}
                    </Txt>
                  )}
                </Card>
              )}
              {i.usage.heavy.length > 0 && (
                <Card label="The chats that cost the most">
                  <Txt variant="tiny" tone="ink3" style={{ fontWeight: "700" }}>
                    Cost the most
                  </Txt>
                  {i.usage.heavy.map((h, n) => (
                    <View key={n} accessible accessibilityLabel={`${h.title}, ${h.project}, ${tokens(h.weighted)}${h.why ? `, ${h.why}` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: n === 0 ? 0 : 8, borderTopWidth: n === 0 ? 0 : 1, borderTopColor: colors.rule }}>
                      <View style={{ flex: 1 }}>
                        <Txt variant="small" numberOfLines={1} style={{ fontWeight: "600" }}>
                          {h.title}
                        </Txt>
                        <Txt variant="tiny" tone="ink2">
                          {h.project} · {tokens(h.weighted)}
                        </Txt>
                      </View>
                      {h.why && (
                        <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.wash }}>
                          <Txt variant="tiny" tone="ink2" style={{ fontWeight: "700" }}>
                            {h.why}
                          </Txt>
                        </View>
                      )}
                    </View>
                  ))}
                </Card>
              )}
            </Section>

            <Section label="Savings" headline={i.savings.headline}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Figure value={tokens(i.savings.per_call.now)} label="context a call" delta={change(i.savings.per_call, true)} />
                <Figure value={tokens(i.savings.chat_start.now)} label="a chat's start" delta={change(i.savings.chat_start, true)} />
                <Figure value={percent(i.savings.cached.now)} label="from the cache" delta={change(i.savings.cached, false, true)} />
              </View>
              <Txt variant="tiny" tone="ink2" style={{ paddingHorizontal: 4 }}>
                Compared with {i.before}.{i.savings.note ? ` ${i.savings.note}` : ""}
              </Txt>
            </Section>

            <Section label="Done" headline={i.done.headline}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Figure value={`${i.done.merged}`} label="PRs merged" />
                <Figure value={`${i.done.releases}`} label="releases" />
                <Figure value={`${i.done.commits}`} label="commits" />
                <Figure value={`${i.done.chats}`} label="chats" />
              </View>
              {(i.done.added > 0 || i.done.removed > 0) && (
                <Txt variant="tiny" tone="ink2" style={{ paddingHorizontal: 4 }}>
                  <Txt variant="tiny" style={{ color: colors.go, fontWeight: "700" }}>{`+${i.done.added.toLocaleString()}`}</Txt>
                  {"  "}
                  <Txt variant="tiny" style={{ color: colors.stop, fontWeight: "700" }}>{`−${i.done.removed.toLocaleString()}`}</Txt>
                  {"  lines in your commits"}
                </Txt>
              )}
              {i.done.projects.length > 1 && (
                <Card label="Commits by project">
                  <Shares list={i.done.projects} colorOf={colorOf} />
                </Card>
              )}
            </Section>

            <Section label="Habits" headline={i.habits.headline}>
              <Card label="When you write to your chats, by hour">
                <View style={{ flexDirection: "row", alignItems: "flex-end", height: 44, gap: 2 }}>
                  {i.habits.hours.map((n, h) => (
                    <View key={h} style={{ flex: 1, height: Math.max(2, (n / hoursTop) * 44), borderRadius: 2, backgroundColor: n === hoursTop ? colors.cobalt : n === 0 ? colors.rule : colors.shapeStrong }} />
                  ))}
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  {["12 am", "6 am", "noon", "6 pm", "12 am"].map((l, n) => (
                    <Txt key={n} variant="tiny" tone="ink3" style={{ fontSize: 10 }}>
                      {l}
                    </Txt>
                  ))}
                </View>
              </Card>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Figure value={i.habits.reply_ms === null ? "—" : wait(i.habits.reply_ms)} label="a chat waits for you" />
                <Figure value={percent(i.habits.away)} label="ran while you were away" />
              </View>
            </Section>
          </FadeSlideIn>
        )}
      </ScrollView>
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: colors.paper }} />
      <View pointerEvents="box-none" onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: insets.top + TOP_BAR_GAP }}>
        {top}
      </View>
    </View>
  );
}
