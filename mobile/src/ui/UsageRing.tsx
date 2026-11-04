import type { ReactNode } from "react";
import { View } from "react-native";
import { useColors } from "./theme";

/** The ring's width and the line it is drawn with. */
const SIZE = 20;
const STROKE = 2;

/** Half a ring, coloured on two sides of a circle: turned 45° it is the right half, 225° the left. */
function Half({ color, deg, left }: { color: string; deg: number; left: number }) {
  return <View style={{ position: "absolute", top: 0, left, width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: STROKE, borderColor: "transparent", borderTopColor: color, borderRightColor: color, transform: [{ rotate: `${deg}deg` }] }} />;
}

/**
 * A thin ring round what it holds (the Mac's dot), filled clockwise from the top to `fill` (0 to 1). Each half of the circle is a
 * mask: the right one shows a half ring turning in from the left, the left one, past half, a half ring turning on from the right.
 * Drawn with views (there is no SVG in the app). Nothing is drawn round it when `fill` is null.
 */
export function UsageRing({ fill, tone, children }: { fill: number | null; tone: "ok" | "warn" | "stop"; children: ReactNode }) {
  const colors = useColors();
  const p = fill === null ? 0 : Math.max(0, Math.min(1, fill));
  const color = tone === "stop" ? colors.stop : tone === "warn" ? colors.hi : colors.go;
  return (
    <View testID={fill === null ? undefined : "usage-ring"} style={{ width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center" }}>
      {fill !== null && (
        <>
          <View style={{ position: "absolute", top: 0, left: 0, width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: STROKE, borderColor: colors.rule }} />
          <View style={{ position: "absolute", top: 0, left: SIZE / 2, width: SIZE / 2, height: SIZE, overflow: "hidden" }}>
            <Half color={color} left={-SIZE / 2} deg={p <= 0.5 ? 225 + p * 360 : 45} />
          </View>
          {p > 0.5 && (
            <View style={{ position: "absolute", top: 0, left: 0, width: SIZE / 2, height: SIZE, overflow: "hidden" }}>
              <Half color={color} left={0} deg={45 + (p - 0.5) * 360} />
            </View>
          )}
        </>
      )}
      {children}
    </View>
  );
}
