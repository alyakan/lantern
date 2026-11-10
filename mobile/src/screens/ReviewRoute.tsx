import { useEffect, useRef } from "react";
import { ScrollView, View, type ScrollViewInstance } from "react-native";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { radius, useColors } from "../ui/theme";
import type { RouteStop } from "../view/reviewRoute";

/** What a stop says about itself to a screen reader: where it is, its findings and, if it can't be opened, why. */
function describe(s: RouteStop, current: boolean): string {
  const name = s.kind === "unit" ? `Unit ${s.n}, ${s.title}` : s.title.split(":")[0];
  const findings = s.kind === "unit" && s.page !== null && s.findings !== undefined ? (s.findings === 0 ? ", no findings" : `, ${s.findings} finding${s.findings === 1 ? "" : "s"}${s.open ? `, ${s.open} without a verdict` : ""}`) : "";
  const why = s.page !== null ? "" : s.earlier ? ", an earlier page that isn't loaded on this phone" : ", not reached yet";
  return `${name}${findings}${current ? ", the page on screen" : ""}${why}`;
}

/**
 * The route through a Review, under the page bar: the Frame, every unit the Frame planned (those not reached yet greyed), and
 * the Summary, as the Mac's header draws it. The page on screen is filled; a unit that has been read shows its findings, or a
 * tick for none, and one with findings still without a verdict is marked. A reached stop opens its page.
 */
export function ReviewRoute({ stops, at, onGo }: { stops: RouteStop[]; at: number; onGo: (page: number) => void }) {
  const colors = useColors();
  const scroll = useRef<ScrollViewInstance>(null);
  const places = useRef(new Map<string, { x: number; width: number }>());
  const width = useRef(0);
  const current = stops.find((s) => s.page !== null && s.page === at)?.key;
  // The stop on screen stays in view as the route scrolls sideways: centred in it, or as far as it goes.
  const follow = () => {
    const p = current ? places.current.get(current) : undefined;
    if (p && width.current > 0) scroll.current?.scrollTo({ x: Math.max(0, p.x - (width.current - p.width) / 2), animated: true });
  };
  useEffect(follow, [current]);
  return (
    <View accessibilityRole="toolbar" accessibilityLabel="Review route" style={{ paddingBottom: 8 }}>
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} onLayout={(e) => { width.current = e.nativeEvent.layout.width; follow(); }} contentContainerStyle={{ paddingHorizontal: 16, gap: 6, alignItems: "center" }}>
        {stops.map((s) => {
          const here = s.key === current;
          const reached = s.page !== null;
          const mark = s.kind === "unit" ? String(s.n) : s.kind === "frame" ? "◆" : "∑";
          const count = s.kind === "unit" && reached && !here && s.findings !== undefined ? (s.findings === 0 ? "✓" : String(s.findings)) : null;
          const fg = here ? colors.white : reached ? colors.ink : colors.ink3;
          return (
            <PressScale key={s.key} accessibilityRole="button" accessibilityLabel={describe(s, here)} accessibilityState={{ selected: here, disabled: !reached }} disabled={!reached} onPress={() => s.page !== null && onGo(s.page)} onLayout={(e) => {
              places.current.set(s.key, { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width });
              // The strip may be laid out before its chips are measured: the one on screen is brought into view when it is.
              if (here) follow();
            }} haptic="select" scaleTo={0.94} hitSlop={4} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: here ? colors.cobalt : colors.rule, backgroundColor: here ? colors.cobalt : "transparent", opacity: reached ? 1 : 0.55 }}>
              <Txt variant="tiny" accessibilityElementsHidden style={{ color: fg, fontWeight: "700" }}>
                {mark}
              </Txt>
              <Txt variant="small" numberOfLines={1} accessibilityElementsHidden style={{ color: fg, fontWeight: here ? "700" : "500", maxWidth: 140 }}>
                {s.label}
              </Txt>
              {count !== null && (
                <View accessibilityElementsHidden style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: s.open ? colors.hi : colors.wash }}>
                  <Txt variant="tiny" style={{ color: s.open ? colors.onHi : s.findings === 0 ? colors.go : colors.ink2, fontWeight: "700" }}>
                    {count}
                  </Txt>
                </View>
              )}
            </PressScale>
          );
        })}
      </ScrollView>
    </View>
  );
}
