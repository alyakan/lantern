import { View } from "react-native";
import { useColors } from "./theme";

/** The pictures of the chat bar's tools, each drawn from a few views like the app's other glyphs (there is no icon set). */
export type ToolIconName = "compact" | "clear" | "todos" | "rename";

const SIZE = 20;

/** A short bar, rotated about its middle. */
const Bar = ({ color, x, y, w, h, turn = 0 }: { color: string; x: number; y: number; w: number; h: number; turn?: number }) => (
  <View style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: h / 2, backgroundColor: color, transform: [{ rotate: `${turn}deg` }] }} />
);

/** A chevron's two arms: a square showing two of its borders, turned to point where it should. */
const Arrow = ({ color, x, y, turn }: { color: string; x: number; y: number; turn: number }) => (
  <View style={{ position: "absolute", left: x, top: y, width: 7, height: 7, borderRightWidth: 2, borderBottomWidth: 2, borderColor: color, borderRadius: 1, transform: [{ rotate: `${turn}deg` }] }} />
);

/**
 * Compact: two arrows closing in on a line (the chat squeezed). Clear: a bin. To-dos: a ticked box. Rename: a pencil. Decoration
 * only: the button around it says what it is.
 */
export function ToolIcon({ name, color }: { name: ToolIconName; color?: string }) {
  const colors = useColors();
  const c = color ?? colors.ink;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: SIZE, height: SIZE }}>
      {name === "compact" && (
        <>
          <Arrow color={c} x={6.5} y={0.5} turn={45} />
          <Bar color={c} x={2} y={9} w={16} h={2} />
          <Arrow color={c} x={6.5} y={12.5} turn={-135} />
        </>
      )}
      {name === "clear" && (
        <>
          <Bar color={c} x={3} y={4} w={14} h={2} />
          <Bar color={c} x={7.5} y={1.5} w={5} h={2} />
          <View style={{ position: "absolute", left: 5, top: 7, width: 10, height: 11, borderWidth: 2, borderTopWidth: 0, borderColor: c, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 }} />
        </>
      )}
      {name === "todos" && (
        <>
          <View style={{ position: "absolute", left: 2, top: 2, width: 16, height: 16, borderRadius: 4, borderWidth: 2, borderColor: c }} />
          <View style={{ position: "absolute", left: 6, top: 6.5, width: 9, height: 5, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: c, transform: [{ rotate: "-45deg" }] }} />
        </>
      )}
      {name === "rename" && (
        <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", transform: [{ rotate: "45deg" }] }}>
          <View style={{ width: 6, height: 10, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: c }} />
          <View style={{ width: 0, height: 0, borderLeftWidth: 3, borderRightWidth: 3, borderTopWidth: 5, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: c }} />
        </View>
      )}
    </View>
  );
}
