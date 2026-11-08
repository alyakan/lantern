import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSyncState } from "../shell/hooks";
import { useAccent } from "../ui/accent";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { useColors } from "../ui/theme";
import { byDay, historyEvents, type HistoryKind } from "../view/history";

const MARK: Record<HistoryKind, string> = { waiting: "needs you", working: "working", done: "finished", failed: "failed", stopped: "stopped" };
/** A ring's size, and how far down its row its middle is: level with the middle of the chat's name. */
const RING = 11;
const RING_Y = 21;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The Timeline side of a tablet's column, as the Mac's sidebar has it: what is going on now at the top, then each answer that
 * finished, under its day, newest first. A row opens its chat beside the column; the chat shown has its rows marked.
 */
export function TimelineColumn({ onOpenChat, selectedSlot, gutter }: { onOpenChat: (slot: string) => void; selectedSlot?: string | null; gutter: number }) {
  const colors = useColors();
  const accent = useAccent();
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
        <View key={d.day} accessibilityLabel={d.day} style={{ paddingTop: 16 }}>
          {/* The day's name as the Mac's: small, in capitals, quiet. */}
          <Txt variant="tiny" tone="ink3" accessibilityRole="header" style={{ fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: gutter, paddingBottom: 4 }}>
            {d.day}
          </Txt>
          {d.events.map((e, n) => {
            const bad = e.kind === "failed" || e.kind === "stopped";
            // A ring each, in its state's colour, as the Mac's: filled only for what needs you.
            const ring = e.kind === "waiting" ? colors.hi : e.kind === "working" ? accent : e.kind === "failed" ? colors.stop : e.kind === "stopped" ? colors.ink3 : colors.go;
            const first = n === 0;
            const last = n === d.events.length - 1;
            const selected = e.slot === selectedSlot;
            return (
              // Flat rows on the column's gutter, with the Mac's line running down through every ring of the day (from the first
              // ring to the last). The chat shown has its rows marked by a bar at the column's edge, as its row in the chats is, not
              // filled in: a chat has several rows here, and filled they stacked into cards.
              <PressScale
                key={e.key}
                accessibilityRole="button"
                accessibilityLabel={`${e.title}, ${MARK[e.kind]}${e.line ? `, ${e.line}` : ""}`}
                accessibilityHint="Opens the chat"
                accessibilityState={{ selected }}
                onPress={() => onOpenChat(e.slot)}
                haptic="select"
                scaleTo={0.99}
                style={{ flexDirection: "row", gap: 12, paddingLeft: gutter, paddingRight: gutter }}
              >
                {selected && <View testID="timeline-selected" accessibilityElementsHidden pointerEvents="none" style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2, backgroundColor: accent }} />}
                <View testID="timeline-rail" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: RING, alignItems: "center" }}>
                  {!(first && last) && <View style={{ position: "absolute", width: 1.5, backgroundColor: colors.shapeStrong, top: first ? RING_Y : 0, ...(last ? { height: RING_Y } : { bottom: 0 }) }} />}
                  <View style={{ marginTop: RING_Y - RING / 2, width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2, borderColor: ring, backgroundColor: e.kind === "waiting" ? ring : colors.paper }} />
                </View>
                <View style={{ flex: 1, gap: 1, paddingVertical: 9 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                    <Txt variant="body" numberOfLines={1} style={{ fontWeight: "600", flex: 1 }}>
                      {e.title}
                    </Txt>
                    <Txt variant="tiny" tone={bad ? "stop" : e.kind === "waiting" ? "ink" : "ink3"} style={e.kind === "working" ? { color: accent, fontWeight: "700" } : e.kind === "waiting" ? { fontWeight: "700" } : undefined}>
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
