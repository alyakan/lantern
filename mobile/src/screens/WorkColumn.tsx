import { View } from "react-native";
import { useSyncState } from "../shell/hooks";
import { useAccent } from "../ui/accent";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Dots } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";
import { askOf, bucketOf, featureFor, workGroups } from "../view/work";
import { hueOf } from "./WorkScreen";

/**
 * The Work side of a tablet's left column: each feature (or, without Linear, each project) as a row, with what needs you in it,
 * the most pressing first, and how much of it is open. A row opens the feature's page beside the column; the row of the page
 * shown is marked, as the chat shown is on the Chats side.
 */
export function WorkColumn({ picked, shown, onPick, gutter }: { /** The feature picked last (null: none yet, so the page shows the one that needs you). */ picked: string | null; /** Whether the page beside the column is Work's (not a chat's, or Insights'): only then is a row marked. */ shown: boolean; onPick: (key: string) => void; gutter: number }) {
  const colors = useColors();
  const accent = useAccent();
  const { work } = useSyncState();
  if (work === null)
    return (
      <View accessible accessibilityLabel="Loading your work" style={{ alignItems: "center", paddingVertical: 40 }}>
        <Dots />
      </View>
    );
  const issues = work.issues === true;
  const groups = workGroups(work.items, issues);
  if (groups.length === 0)
    return (
      <Txt variant="body" tone="ink2" style={{ paddingHorizontal: gutter, paddingTop: 18 }}>
        {work.looked ? "Nothing open." : "Your Mac hasn't looked yet: open a project on it to see its work."}
      </Txt>
    );
  // The same one the page beside shows: the one picked, or the one that needs you.
  const current = shown ? featureFor(groups, picked)?.key : undefined;
  return (
    <View accessibilityLabel={issues ? "Features" : "Projects"} style={{ paddingTop: 6 }}>
      <Txt variant="small" style={{ fontWeight: "700", paddingHorizontal: gutter, paddingTop: 12, paddingBottom: 6 }}>
        {issues ? "Features" : "Projects"}
      </Txt>
      {groups.map((g) => {
        const live = g.items.filter((i) => bucketOf(i) !== "shipped").length;
        const ask = askOf(g.items);
        const first = ask[0];
        const selected = g.key === current;
        const word = first ? (first.next?.warn ? "Bypasses review" : first.word) : "Nothing needs you";
        return (
          <PressScale
            key={g.key}
            accessibilityRole="button"
            accessibilityLabel={`${g.label}, ${ask.length > 0 ? `${ask.length} need${ask.length === 1 ? "s" : ""} you, ${word}` : "nothing needs you"}, ${live} open`}
            accessibilityState={{ selected }}
            onPress={() => onPick(g.key)}
            haptic="select"
            scaleTo={0.98}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: space.sm, paddingHorizontal: Math.max(gutter - space.sm, 8), paddingVertical: 10, minHeight: 56, borderRadius: radius.inner, backgroundColor: selected ? colors.card : "transparent" }}
          >
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: first ? hueOf(first, colors) : colors.ink3, opacity: first ? 1 : 0.45 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="body" numberOfLines={2} style={{ fontWeight: "600" }}>
                {g.label}
              </Txt>
              <Txt variant="small" tone="ink3" numberOfLines={1}>
                {first ? (
                  <Txt variant="small" style={{ color: hueOf(first, colors), fontWeight: "700" }}>
                    {word}
                  </Txt>
                ) : (
                  word
                )}
                {` · ${live} open`}
              </Txt>
            </View>
            {ask.length > 0 && (
              <Txt variant="small" style={{ fontWeight: "700", color: accent }}>
                {ask.length}
              </Txt>
            )}
          </PressScale>
        );
      })}
    </View>
  );
}
