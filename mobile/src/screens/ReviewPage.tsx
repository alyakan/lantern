import { memo } from "react";
import { Pressable, View } from "react-native";
import { Txt } from "../ui/components";
import { Markdown } from "../ui/Markdown";
import { PressScale } from "../ui/motion";
import { radius, space, useColors } from "../ui/theme";
import type { Finding, ReviewFile, Severity, Verdict } from "../view/review";

const SEVERITY: Record<Severity, string> = { blocker: "Blocker", "should-fix": "Should fix", nit: "Nit" };

/** A link to the change in a file: a path, or a line in it. */
function FileLink({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" accessibilityHint={hint} onPress={onPress} hitSlop={6}>
      <Txt variant="small" tone="cobalt" style={{ fontWeight: "700", textDecorationLine: "underline" }}>
        {label}
      </Txt>
    </Pressable>
  );
}

function VerdictPill({ label, on, tone, onPress }: { label: string; on: boolean; tone: "go" | "stop"; onPress: () => void }) {
  const colors = useColors();
  const c = tone === "go" ? colors.go : colors.stop;
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPress} haptic="select" scaleTo={0.95} style={{ borderRadius: radius.pill, borderWidth: 1.5, borderColor: on ? c : colors.rule, backgroundColor: on ? c : "transparent", paddingHorizontal: 14, paddingVertical: 6 }}>
      <Txt variant="small" tone={on ? "white" : "ink2"} style={{ fontWeight: "700" }}>
        {label}
      </Txt>
    </PressScale>
  );
}

/** One finding: how bad, where (a link to the change there), what, and your verdict on it. */
function FindingCard({ finding, verdict, onVerdict, onLine }: { finding: Finding; verdict: Verdict | undefined; /** Present while the page can still be answered. */ onVerdict?: (v: Verdict | null) => void; onLine: () => void }) {
  const colors = useColors();
  const sev = finding.severity;
  const sevColor = sev === "blocker" ? colors.stop : sev === "should-fix" ? colors.hi : colors.ink3;
  const where = finding.line === null ? null : `line ${finding.line}${finding.lineEnd ? `–${finding.lineEnd}` : ""}`;
  return (
    <View testID={`finding-${finding.index}`} style={{ borderRadius: radius.inner, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.card, padding: 12, gap: 8, opacity: verdict === "reject" ? 0.6 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {sev && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: sevColor }} />
            <Txt variant="small" style={{ fontWeight: "700" }}>
              {SEVERITY[sev]}
            </Txt>
          </View>
        )}
        {where && <FileLink label={where} hint="Opens the change in this file" onPress={onLine} />}
        {!onVerdict && verdict && (
          <Txt variant="small" tone={verdict === "agree" ? "go" : "stop"} style={{ fontWeight: "700", marginLeft: "auto" }}>
            {verdict === "agree" ? "Agreed" : "Rejected"}
          </Txt>
        )}
      </View>
      <Markdown text={finding.text} />
      {onVerdict && (
        <View accessibilityRole="radiogroup" accessibilityLabel="Your verdict" style={{ flexDirection: "row", gap: 8 }}>
          <VerdictPill label="Agree" tone="go" on={verdict === "agree"} onPress={() => onVerdict(verdict === "agree" ? null : "agree")} />
          <VerdictPill label="Reject" tone="stop" on={verdict === "reject"} onPress={() => onVerdict(verdict === "reject" ? null : "reject")} />
        </View>
      )}
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

/**
 * A Review file page, laid out as the Mac lays it out: the file (a link to its change), what changed, the findings with your
 * verdict on each while the page is the live one (and what you said, after), and the notes.
 */
export const ReviewFilePage = memo(function ReviewFilePage({ kicker, file, verdicts, onVerdict, onOpen }: { kicker: string; file: ReviewFile; verdicts: Record<number, Verdict> | undefined; onVerdict?: (index: number, v: Verdict | null) => void; /** Opens the change in the file. */ onOpen: (path: string) => void }) {
  const colors = useColors();
  const path = file.path;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12, gap: 16 }}>
      <View style={{ backgroundColor: colors.card, borderRadius: 18, padding: 14, gap: 6 }}>
        <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
          {kicker}
        </Txt>
        {path ? (
          <Pressable accessibilityRole="link" accessibilityLabel={path} accessibilityHint="Opens the change in this file" onPress={() => onOpen(path)} hitSlop={6}>
            <Txt variant="heading" tone="cobalt" style={{ textDecorationLine: "underline" }}>
              {path}
            </Txt>
          </Pressable>
        ) : null}
        {(file.added !== null || file.removed !== null) && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Txt variant="small" tone="go">
              +{file.added ?? 0}
            </Txt>
            <Txt variant="small" tone="stop">
              −{file.removed ?? 0}
            </Txt>
          </View>
        )}
        {!!file.preface && <Markdown text={file.preface} />}
      </View>
      {!!file.changed && (
        <Section title="What changed">
          <Markdown text={file.changed} />
        </Section>
      )}
      <Section title={file.findings.length ? `Findings (${file.findings.length})` : "Findings"}>
        {file.clean || file.findings.length === 0 ? (
          <Txt variant="body" tone="ink2">
            No findings in this file.
          </Txt>
        ) : (
          file.findings.map((f) => <FindingCard key={f.index} finding={f} verdict={verdicts?.[f.index]} onVerdict={onVerdict && ((v) => onVerdict(f.index, v))} onLine={() => path && onOpen(path)} />)
        )}
      </Section>
      {!!file.notes && (
        <Section title="Notes">
          <Markdown text={file.notes} />
        </Section>
      )}
    </View>
  );
});
