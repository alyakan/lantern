import type { ReactNode } from "react";
import { View } from "react-native";
import { useColors } from "./theme";

/** Half a ring, coloured on two sides of a circle: turned 45° it is the right half, 225° the left. */
function Half({ color, deg, left, size, stroke }: { color: string; deg: number; left: number; size: number; stroke: number }) {
  return <View style={{ position: "absolute", top: 0, left, width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: "transparent", borderTopColor: color, borderRightColor: color, transform: [{ rotate: `${deg}deg` }] }} />;
}

/**
 * A thin ring round what it holds (the Mac's dot), filled clockwise from the top to `fill` (0 to 1). Each half of the circle is a
 * mask: the right one shows a half ring turning in from the left, the left one, past half, a half ring turning on from the right.
 * Drawn with views (there is no SVG in the app). Nothing is drawn round it when `fill` is null.
 */
export function UsageRing({ fill, tone, children, size = 20, stroke = 2 }: { fill: number | null; tone: "ok" | "warn" | "stop"; children: ReactNode; /** The ring's width (the Mac's dot's is 20), and its line's. */ size?: number; stroke?: number }) {
  const colors = useColors();
  const p = fill === null ? 0 : Math.max(0, Math.min(1, fill));
  const color = tone === "stop" ? colors.stop : tone === "warn" ? colors.hi : colors.go;
  return (
    <View testID={fill === null ? undefined : "usage-ring"} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {fill !== null && (
        <>
          <View style={{ position: "absolute", top: 0, left: 0, width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: colors.rule }} />
          <View style={{ position: "absolute", top: 0, left: size / 2, width: size / 2, height: size, overflow: "hidden" }}>
            <Half color={color} left={-size / 2} size={size} stroke={stroke} deg={p <= 0.5 ? 225 + p * 360 : 45} />
          </View>
          {p > 0.5 && (
            <View style={{ position: "absolute", top: 0, left: 0, width: size / 2, height: size, overflow: "hidden" }}>
              <Half color={color} left={0} size={size} stroke={stroke} deg={45 + (p - 0.5) * 360} />
            </View>
          )}
        </>
      )}
      {children}
    </View>
  );
}
