import { View } from "react-native";
import { Txt } from "../ui/components";
import { Markdown } from "../ui/Markdown";
import { PressScale } from "../ui/motion";
import { radius, shadow, space, useColors } from "../ui/theme";
import { isPath, unitName, type FrameUnit, type ReviewFrame } from "../view/review";

/** Added and removed counts, as the Mac's pages show them. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <View accessible accessibilityLabel={`${added} lines added, ${removed} removed`} style={{ flexDirection: "row", gap: 6 }}>
      <Txt variant="small" tone="go" style={{ fontWeight: "700" }}>
        +{added}
      </Txt>
      <Txt variant="small" tone="stop" style={{ fontWeight: "700" }}>
        −{removed}
      </Txt>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Txt variant="small" tone="ink2" accessibilityRole="header" style={{ fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {title}
      </Txt>
      {children}
    </View>
  );
}

/** The unit's number in a ring, grey while its page isn't written yet. */
function Mark({ n, on }: { n: number; on: boolean }) {
  const colors = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.cobalt : colors.rule }}>
      <Txt variant="tiny" tone={on ? "white" : "ink2"} style={{ fontWeight: "700" }}>
        {n}
      </Txt>
    </View>
  );
}

/** One unit of the route: its number, what it is, its counts and why to look. Opens its page once it is written. */
function UnitRow({ unit, onOpen }: { unit: FrameUnit; onOpen: (() => void) | null }) {
  const colors = useColors();
  const path = isPath(unit.title);
  const slash = unit.title.lastIndexOf("/");
  const label = `${unit.n}. ${unitName(unit.title)}${unit.note ? `: ${unit.note}` : ""}${onOpen ? "" : ", not reached yet"}`;
  return (
    <PressScale accessibilityRole={onOpen ? "link" : "text"} accessibilityLabel={label} accessibilityHint={onOpen ? `Opens the page of ${unit.title}` : undefined} disabled={!onOpen} onPress={onOpen ?? undefined} scaleTo={0.98} style={{ flexDirection: "row", gap: 10, paddingVertical: 8, opacity: onOpen ? 1 : 0.6 }}>
      <Mark n={unit.n} on={!!onOpen} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Txt variant="body" style={{ fontWeight: "700", flexShrink: 1 }}>
            {path ? unit.title.slice(slash + 1) : unit.title}
          </Txt>
          {unit.added !== null && <Counts added={unit.added} removed={unit.removed ?? 0} />}
        </View>
        {path && slash > 0 && (
          <Txt variant="tiny" tone="ink3" numberOfLines={1} ellipsizeMode="head">
            {unit.title.slice(0, slash)}
          </Txt>
        )}
        {!!unit.note && (
          <Txt variant="small" tone="ink2">
            {unit.note}
          </Txt>
        )}
      </View>
      {onOpen && <View accessibilityElementsHidden style={{ width: 8, height: 8, alignSelf: "center", borderRightWidth: 2, borderTopWidth: 2, borderColor: colors.ink3, transform: [{ rotate: "45deg" }] }} />}
    </PressScale>
  );
}

/**
 * A Review's Frame, drawn from its sections as the Mac draws it: what the change is, a line of totals, the risks (each with the
 * units it is in) and the route of units, each opening its page once it is written. Any other section follows as written.
 * `onUnit(n)` is how to open unit n's page (null: not reached yet).
 */
export function ReviewFramePage({ kicker, title, frame, onUnit, onFile }: { kicker: string; title: string; frame: ReviewFrame; onUnit: (n: number) => (() => void) | null; onFile?: (path: string) => void }) {
  const colors = useColors();
  const counted = frame.units.filter((u) => u.added !== null);
  const added = counted.reduce((n, u) => n + (u.added ?? 0), 0);
  const removed = counted.reduce((n, u) => n + (u.removed ?? 0), 0);
  const titleOf = (n: number) => frame.units.find((u) => u.n === n)?.title ?? null;
  const risks = frame.risks.length;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12, gap: 16 }}>
      <View style={[{ backgroundColor: colors.card, borderRadius: radius.block, padding: 14, gap: 6 }, shadow.card, { shadowOpacity: 0.06 }]}>
        <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
          {kicker}
        </Txt>
        <Txt variant="heading">{title}</Txt>
        {!!frame.preface && <Markdown text={frame.preface} onFile={onFile} surface={colors.card} />}
      </View>
      {frame.units.length > 0 && (
        <View testID="review-totals" accessible accessibilityLabel={`This review: ${frame.units.length} unit${frame.units.length === 1 ? "" : "s"}${counted.length ? `, ${added} lines added, ${removed} removed` : ""}, ${risks} risk${risks === 1 ? "" : "s"}`} style={{ flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <Txt variant="small" tone="ink2">
            <Txt variant="small" style={{ fontWeight: "700" }}>
              {frame.units.length}
            </Txt>{" "}
            unit{frame.units.length === 1 ? "" : "s"}
          </Txt>
          {counted.length > 0 && <Counts added={added} removed={removed} />}
          <Txt variant="small" tone="ink2">
            <Txt variant="small" style={{ fontWeight: "700" }}>
              {risks}
            </Txt>{" "}
            risk{risks === 1 ? "" : "s"}
          </Txt>
        </View>
      )}
      {risks > 0 && (
        <Section title="Risks">
          {frame.risks.map((r, i) => (
            <View key={i} testID={`review-risk-${i}`} style={{ borderRadius: radius.inner, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.card, padding: 12, gap: 6 }}>
              <Txt variant="body" style={{ fontWeight: "700" }}>
                {r.title}
              </Txt>
              {!!r.text && <Markdown text={r.text} onFile={onFile} surface={colors.card} />}
              {r.units.length > 0 && (
                <View accessibilityLabel="In units" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {r.units.map((n) => {
                    const go = onUnit(n);
                    const name = titleOf(n);
                    return (
                      <PressScale key={n} accessibilityRole={go ? "link" : "text"} accessibilityLabel={name ? `Unit ${n}, ${unitName(name)}${go ? "" : ", not reached yet"}` : `Unit ${n}${go ? "" : ", not reached yet"}`} accessibilityHint={go ? "Opens its page" : undefined} disabled={!go} onPress={go ?? undefined} hitSlop={4} scaleTo={0.95} style={{ flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.rule, paddingVertical: 3, paddingLeft: 3, paddingRight: 10, opacity: go ? 1 : 0.6 }}>
                        <Mark n={n} on={!!go} />
                        {!!name && (
                          <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flexShrink: 1, maxWidth: 180 }}>
                            {unitName(name)}
                          </Txt>
                        )}
                      </PressScale>
                    );
                  })}
                </View>
              )}
            </View>
          ))}
        </Section>
      )}
      {frame.units.length > 0 && (
        <Section title="Route">
          <View>
            {frame.units.map((u, i) => (
              <View key={u.n} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.rule }}>
                <UnitRow unit={u} onOpen={onUnit(u.n)} />
              </View>
            ))}
          </View>
        </Section>
      )}
      {!!frame.rest && <Markdown text={frame.rest} onFile={onFile} />}
    </View>
  );
}
