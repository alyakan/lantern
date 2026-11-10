import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { radius, space, useColors } from "../ui/theme";
import { excerptOf } from "../view/reviewCode";
import { parseUnifiedDiff } from "../view/fileDiff";
import { DiffView } from "./DiffView";

type Loaded = { text: string } | { error: string } | null;

/**
 * A reviewed file's change, in a card that stays shut until it is opened (the Mac's "Show the diff" under What changed, and
 * "Show the code" on a finding): with no `span`, the whole diff; with one, the lines a finding names and three around them,
 * from the same diff. The diff is asked for only when the card is first opened. What the phone has is the unified diff the
 * Mac sends, so a finding on a line far from any change has no lines here: the card says so and offers the whole change.
 */
export function ReviewDiffCard({ path, span, load, onOpen }: { path: string; /** The new-file lines a finding names. */ span?: [number, number]; load: (path: string) => Promise<string>; /** Opens the whole change in the file. */ onOpen: (path: string) => void }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded(null);
    load(path).then(
      // What the Mac sends is read, never trusted to be the shape it should be.
      (text) => live && setLoaded(typeof text === "string" ? { text } : { error: "The diff didn't come through." }),
      (e) => live && setLoaded({ error: (e as Error)?.message ?? String(e) }),
    );
    return () => {
      live = false;
    };
  }, [open, load, path]);
  const lines = span ? (span[0] === span[1] ? `line ${span[0]}` : `lines ${span[0]}–${span[1]}`) : null;
  const what = span ? "code" : "diff";
  const rows = useMemo(() => (loaded && "text" in loaded && span ? excerptOf(loaded.text, span[0], span[1]) : null), [loaded, span]);
  // Whether the diff has any line of the file in it (the Mac sends none for a file with no change in its text).
  const hasLines = useMemo(() => !!loaded && "text" in loaded && parseUnifiedDiff(loaded.text).some((r) => r.kind === "add" || r.kind === "del" || r.kind === "ctx"), [loaded]);
  return (
    <View testID={`review-${what}`}>
      <PressScale accessibilityRole="button" accessibilityLabel={`${open ? "Hide" : "Show"} the ${what}${lines ? `, ${lines}` : ""}`} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} hitSlop={8} haptic="select" scaleTo={0.97} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
        <Txt variant="small" tone="cobalt" accessibilityElementsHidden style={{ fontWeight: "700", transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          ›
        </Txt>
        <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
          {open ? `Hide the ${what}` : `Show the ${what}`}
        </Txt>
        {!!lines && (
          <Txt variant="small" tone="ink3">
            {lines}
          </Txt>
        )}
      </PressScale>
      {open && (
        <View style={{ marginTop: 6, gap: 8 }}>
          <View style={{ backgroundColor: colors.paper, borderRadius: radius.inner, overflow: "hidden", borderWidth: 1, borderColor: colors.rule }}>
            {loaded === null ? (
              <Txt variant="small" tone="ink2" style={{ padding: space.md }}>
                Loading…
              </Txt>
            ) : "error" in loaded ? (
              <Txt variant="small" tone="stop" accessibilityRole="alert" style={{ padding: space.md }}>
                Couldn't read the diff: {loaded.error}
              </Txt>
            ) : span ? (
              rows && rows.length > 0 ? (
                <DiffView path={path} rows={rows} named={span} wrap />
              ) : (
                <Txt variant="small" tone="ink2" style={{ padding: space.md }}>
                  {hasLines ? `${lines ? lines[0].toUpperCase() + lines.slice(1) : "That line"} isn't near a change in this diff.` : "No changes in this file's text."}
                </Txt>
              )
            ) : hasLines ? (
              <DiffView path={path} text={loaded.text} wrap />
            ) : (
              <Txt variant="small" tone="ink2" style={{ padding: space.md }}>
                No changes in this file's text.
              </Txt>
            )}
          </View>
          <Button label="Open the whole change" kind="ghost" onPress={() => onOpen(path)} />
        </View>
      )}
    </View>
  );
}
