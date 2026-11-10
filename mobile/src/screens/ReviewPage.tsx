import { memo, type ReactNode } from "react";
import { View } from "react-native";
import { Txt } from "../ui/components";
import { Markdown } from "../ui/Markdown";
import { PressScale } from "../ui/motion";
import { radius, shadow, space, useColors } from "../ui/theme";
import type { Finding, ReviewFile, Severity, Verdict } from "../view/review";
import { ReviewDiffCard } from "./ReviewDiffCard";

const SEVERITY: Record<Severity, string> = { blocker: "Blocker", "should-fix": "Should fix", nit: "Nit" };

/** A link to the change in a file: a path, or a line in it. */
function FileLink({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  return (
    <PressScale accessibilityRole="link" accessibilityHint={hint} onPress={onPress} hitSlop={6}>
      <Txt variant="small" tone="cobalt" style={{ fontWeight: "700", textDecorationLine: "underline" }}>
        {label}
      </Txt>
    </PressScale>
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

/** One finding: how bad, where (a link to the change there), what, its code (shut), and your verdict on it. */
function FindingCard({ finding, verdict, onVerdict, onLine, onFile, code }: { finding: Finding; verdict: Verdict | undefined; /** Present while the page can still be answered. */ onVerdict?: (v: Verdict | null) => void; onLine: () => void; /** A path in its words was tapped. */ onFile: (path: string) => void; /** The lines it names, from the diff (a card that is shut until opened). */ code?: ReactNode }) {
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
      <Markdown text={finding.text} onFile={onFile} />
      {code}
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
 * A Review file page, laid out as the Mac lays it out: the file (a link to its change), or a group's title with each of its
 * files, what changed with the diff of each file (shut), the findings with your verdict on each while the page is the live
 * one (and what you said, after) and the lines each names (shut), and the notes. A path named anywhere on it
 * (`a/b.swift:42`, a page of several files lists each) is a link to its change too, as the heading is. `load`, given when
 * the Mac can read a reviewed file's diff, reads one: without it the diff and code cards aren't offered.
 */
export const ReviewFilePage = memo(function ReviewFilePage({ kicker, file, verdicts, onVerdict, onOpen, load }: { kicker: string; file: ReviewFile; verdicts: Record<number, Verdict> | undefined; onVerdict?: (index: number, v: Verdict | null) => void; /** Opens the change in the file. */ onOpen: (path: string) => void; /** A reviewed file's unified diff. */ load?: (path: string) => Promise<string> }) {
  const colors = useColors();
  const path = file.path;
  // Where a finding is, when it doesn't say: this page's file, or the only one a group has.
  const only = path ?? (file.files.length === 1 ? file.files[0] : null);
  const diffs = path ? [path] : file.files;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12, gap: 16 }}>
      <View style={[{ backgroundColor: colors.card, borderRadius: radius.block, padding: 14, gap: 6 }, shadow.card, { shadowOpacity: 0.06 }]}>
        <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
          {kicker}
        </Txt>
        {path ? (
          <PressScale accessibilityRole="link" accessibilityLabel={path} accessibilityHint="Opens the change in this file" onPress={() => onOpen(path)} hitSlop={6}>
            <Txt variant="heading" tone="cobalt" style={{ textDecorationLine: "underline" }}>
              {path}
            </Txt>
          </PressScale>
        ) : file.group ? (
          <Txt variant="heading" accessibilityRole="header">
            {file.group}
          </Txt>
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
        {file.files.length > 0 && (
          <View accessibilityLabel="Files on this page" style={{ gap: 2, marginTop: 2 }}>
            {file.files.map((f) => (
              <PressScale key={f} accessibilityRole="link" accessibilityLabel={f} accessibilityHint="Opens the change in this file" onPress={() => onOpen(f)} hitSlop={4} style={{ paddingVertical: 4 }}>
                <Txt variant="small" tone="cobalt" numberOfLines={1} ellipsizeMode="head" style={{ textDecorationLine: "underline" }}>
                  {f}
                </Txt>
              </PressScale>
            ))}
          </View>
        )}
        {!!file.preface && <Markdown text={file.preface} onFile={onOpen} />}
      </View>
      {(!!file.changed || (!!load && diffs.length > 0)) && (
        <Section title="What changed">
          {!!file.changed && <Markdown text={file.changed} onFile={onOpen} />}
          {!!load &&
            diffs.map((p) => (
              <View key={p} style={{ gap: 2 }}>
                {/* A group says which file each diff is of. */}
                {!path && (
                  <Txt variant="tiny" tone="ink3" numberOfLines={1} ellipsizeMode="head">
                    {p}
                  </Txt>
                )}
                <ReviewDiffCard path={p} load={load} onOpen={onOpen} />
              </View>
            ))}
        </Section>
      )}
      <Section title={file.findings.length ? `Findings (${file.findings.length})` : "Findings"}>
        {file.clean || file.findings.length === 0 ? (
          <Txt variant="body" tone="ink2">
            No findings in this file.
          </Txt>
        ) : (
          file.findings.map((f) => {
            const at = f.path ?? only;
            return <FindingCard key={f.index} finding={f} verdict={verdicts?.[f.index]} onVerdict={onVerdict && ((v) => onVerdict(f.index, v))} onLine={() => { if (at) onOpen(at); }} onFile={onOpen} code={load && at && f.line !== null ? <ReviewDiffCard path={at} span={[f.line, f.lineEnd ?? f.line]} load={load} onOpen={onOpen} /> : undefined} />;
          })
        )}
      </Section>
      {!!file.notes && (
        <Section title="Notes">
          <Markdown text={file.notes} onFile={onOpen} />
        </Section>
      )}
    </View>
  );
});
