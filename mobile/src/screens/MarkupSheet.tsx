import { memo, useRef, useState, type ComponentRef } from "react";
import { Image, View, useWindowDimensions, type GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureMarkedUp } from "../platformMarkup";
import { Button, Txt } from "../ui/components";
import { buzz } from "../ui/motion";
import { Sheet, SheetBar, SheetPill } from "../ui/Sheet";
import { space, useColors } from "../ui/theme";
import type { PickedImage } from "../view/attachments";
import { begin, extend, fitInside, PEN, pieces, undo, type Stroke } from "../view/markup";

/** The pen's colour: a red that shows on most photos and screenshots. */
const INK = "#ff3b30";

/**
 * One stroke, as its straight pieces. A stroke that is finished is the same list from then on, so it isn't drawn again while the
 * next is: only the one under the finger is (a long scribble was redrawing every piece of every stroke on each move).
 */
const StrokeView = memo(function StrokeView({ stroke }: { stroke: Stroke }) {
  return (
    <>
      {pieces(stroke).map((p, i) => (
        <View key={i} pointerEvents="none" style={{ position: "absolute", left: p.cx - (p.length + PEN) / 2, top: p.cy - PEN / 2, width: p.length + PEN, height: PEN, borderRadius: PEN / 2, backgroundColor: INK, transform: [{ rotate: `${p.angle}deg` }] }} />
      ))}
    </>
  );
});

/**
 * Drawing on a photo before it is sent: circle the bug, underline the word. Strokes are drawn with a finger over the photo, which
 * is shown at the size it will be sent (no letterbox), and Done takes a picture of the two together as the photo to send.
 */
export function MarkupSheet({ image, onDone, onClose }: { image: PickedImage; onDone: (marked: PickedImage) => void; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const fit = fitInside(image.width, image.height, win.width - 2 * space.lg, win.height * 0.55);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canvas = useRef<ComponentRef<typeof View>>(null);
  // The finger's place in the photo, from the touch itself (the strokes and the photo let touches through, so it is the canvas's own).
  const at = (e: GestureResponderEvent) => ({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
  const done = async (close: () => void) => {
    if (strokes.length === 0 || !canvas.current) return close();
    setBusy(true);
    setProblem(null);
    try {
      const marked = await captureMarkedUp(canvas.current, fit.width, fit.height);
      buzz("light");
      onDone(marked);
      close();
    } catch {
      setBusy(false);
      setProblem("That couldn't be saved. Try again, or send the photo without it.");
    }
  };
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ padding: space.lg, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 10, alignItems: "center" }]}>
          <SheetBar title="Mark up" close={{ label: "Cancel", onPress: close, disabled: busy }} right={<SheetPill label={busy ? "Saving…" : "Done"} tone="accent" disabled={busy} onPress={() => void done(close)} />} inset={0} />
          <Txt variant="small" tone="ink2" style={{ alignSelf: "flex-start" }}>
            Draw on it with your finger. Claude sees it as you leave it.
          </Txt>
          {/* The photo and the strokes are one view, so what is captured is what is seen. */}
          <View ref={canvas} collapsable={false} testID="markup-canvas" accessibilityLabel="Photo to draw on" onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false} onResponderGrant={(e) => setStrokes((s) => begin(s, at(e)))} onResponderMove={(e) => setStrokes((s) => extend(s, at(e)))} style={{ width: fit.width, height: fit.height, backgroundColor: colors.rule, overflow: "hidden" }}>
            <Image pointerEvents="none" source={{ uri: image.uri }} style={{ width: fit.width, height: fit.height }} />
            {strokes.map((stroke, n) => (
              <StrokeView key={n} stroke={stroke} />
            ))}
          </View>
          {problem && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {problem}
            </Txt>
          )}
          <View style={{ flexDirection: "row", gap: 8, alignSelf: "stretch" }}>
            <Button label="Undo" kind="ghost" disabled={busy || strokes.length === 0} onPress={() => setStrokes(undo)} style={{ flex: 1 }} />
            <Button label="Clear" kind="ghost" disabled={busy || strokes.length === 0} onPress={() => setStrokes([])} style={{ flex: 1 }} />
          </View>
        </View>
      )}
    </Sheet>
  );
}
