import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSyncState } from "../shell/hooks";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { radius, space, useColors } from "../ui/theme";
import { byDay, historyEvents, type HistoryKind } from "../view/history";

const MARK: Record<HistoryKind, string> = { waiting: "needs you", working: "working", done: "finished", failed: "failed", stopped: "stopped" };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The Timeline side of a tablet's column, as the Mac's sidebar has it: what is going on now at the top, then each answer that
 * finished, under its day, newest first. A row opens its chat beside the column; the chat shown has its rows marked.
 */
export function TimelineColumn({ onOpenChat, selectedSlot, gutter }: { onOpenChat: (slot: string) => void; selectedSlot?: string | null; gutter: number }) {
  const colors = useColors();
  const { chats, desk, workingSince, single } = useSyncState();
  // Today becomes Yesterday at midnight, and the list with it.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const days = byDay(historyEvents(chats, desk, workingSince, single?.name ?? null), now);
  if (days.length === 0)
    return (
      <Txt variant="body" tone="ink2" style={{ paddingHorizontal: gutter, paddingTop: 18 }}>
        Nothing yet. What the chats do shows here as it happens.
      </Txt>
    );
  return (
    <View accessibilityLabel="Timeline">
      {days.map((d) => (
        <View key={d.day} accessibilityLabel={d.day} style={{ paddingTop: 10 }}>
          <Txt variant="small" accessibilityRole="header" style={{ fontWeight: "700", paddingHorizontal: gutter, paddingTop: 6, paddingBottom: 4 }}>
            {d.day}
          </Txt>
          {d.events.map((e) => {
            const bad = e.kind === "failed" || e.kind === "stopped";
            const dot = e.kind === "waiting" ? colors.hi : e.kind === "working" ? colors.working : bad ? colors.stop : colors.go;
            const selected = e.slot === selectedSlot;
            return (
              <PressScale
                key={e.key}
                accessibilityRole="button"
                accessibilityLabel={`${e.title}, ${MARK[e.kind]}${e.line ? `, ${e.line}` : ""}`}
                accessibilityHint="Opens the chat"
                accessibilityState={{ selected }}
                onPress={() => onOpenChat(e.slot)}
                haptic="select"
                scaleTo={0.98}
                style={{ flexDirection: "row", gap: 10, marginHorizontal: space.sm, paddingHorizontal: Math.max(gutter - space.sm, 8), paddingVertical: 9, borderRadius: radius.inner, backgroundColor: selected ? colors.card : "transparent" }}
              >
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: dot }} />
                <View style={{ flex: 1, gap: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                    <Txt variant="body" numberOfLines={1} style={{ fontWeight: "600", flex: 1 }}>
                      {e.title}
                    </Txt>
                    <Txt variant="tiny" tone={bad ? "stop" : "ink3"}>
                      {d.day === "Now" || bad || e.at === null ? MARK[e.kind] : clock(e.at)}
                    </Txt>
                  </View>
                  {!!e.project && (
                    <Txt variant="tiny" tone="ink3" numberOfLines={1}>
                      {e.project}
                    </Txt>
                  )}
                  {!!e.line && (
                    <Txt variant="small" tone="ink2" numberOfLines={2}>
                      {e.line}
                    </Txt>
                  )}
                </View>
              </PressScale>
            );
          })}
        </View>
      ))}
    </View>
  );
}
