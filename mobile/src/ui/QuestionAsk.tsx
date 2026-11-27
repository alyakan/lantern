import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, LayoutAnimation, ScrollView, TextInput, View } from "react-native";
import { Button, Txt } from "./components";
import { PopIn, PressScale, run, skips } from "./motion";
import { radius, useBody, useColors, type Palette } from "./theme";
import type { Question } from "../view/prompts";

/**
 * How long a picked option shows as picked before the next question comes (long enough to see it, the other options dimming
 * beside it), how long a question takes to fade away, and how long the next one takes to come in (the panel's height gliding
 * to it over the same time).
 */
export const PICK_BEAT_MS = 450;
export const LEAVE_MS = 200;
export const STEP_IN_MS = 320;

/** Claude marks the option it recommends: "(Recommended)" at the end of its label. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** Whether a question has an answer yet: something typed, or something picked. */
const hasAnswer = (q: Question, picks: Record<string, string[]>, typed: Record<string, string>) => !!typed[q.question]?.trim() || (picks[q.question] ?? []).length > 0;

/** What the answers to a prompt's questions come to, one string per question (a multi-select joined with commas); null until all have one. */
export function answersFrom(qs: Question[], picks: Record<string, string[]>, typed: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of qs) {
    const text = typed[q.question]?.trim();
    const answer = text ? text : (picks[q.question] ?? []).join(", ");
    if (!answer) return null;
    out[q.question] = answer;
  }
  return out;
}

/** Where the questions are shown: on the full-screen decision's night, or on the chat's own page where the message box was. */
export type QuestionTone = "night" | "paper";

const look = (colors: Palette, tone: QuestionTone) =>
  tone === "night"
    ? { text: "white" as const, sub: "night" as const, line: colors.nightLine, field: colors.nightRaised, on: `${colors.hi}2e`, num: colors.nightLine, numText: colors.nightText, input: colors.white, placeholder: colors.nightText, skip: "night-ghost" as const }
    : { text: "ink" as const, sub: "ink2" as const, line: colors.rule, field: colors.card, on: colors.hiSoft, num: colors.wash, numText: colors.ink2, input: colors.ink, placeholder: colors.ink3, skip: "ghost" as const };

/** The question shown comes in from the side it is on: from the right going on, from the left going back. */
function StepIn({ back, children }: { back: boolean; children: ReactNode }) {
  const p = useRef(new Animated.Value(skips() ? 1 : 0)).current;
  useEffect(() => run(p, 1, STEP_IN_MS), [p]);
  return <Animated.View style={{ opacity: p, transform: [{ translateX: p.interpolate({ inputRange: [0, 1], outputRange: [back ? -10 : 10, 0] }) }] }}>{children}</Animated.View>;
}

/** One answer to choose, a row of the list: its number, its words, and a check popping in once picked, the row taking the highlighter's wash. */
function OptionRow({ n, on, multi, label, description, tone, first, dim, onPress }: { n: number; on: boolean; multi: boolean; label: string; description: string; tone: QuestionTone; first: boolean; /** Another option was just picked and is being shown: this one steps back. */ dim: boolean; onPress: () => void }) {
  const colors = useColors();
  const l = look(colors, tone);
  const sel = useRef(new Animated.Value(on ? 1 : 0)).current;
  const fade = useRef(new Animated.Value(dim ? 0.45 : 1)).current;
  useEffect(() => {
    if (skips()) sel.setValue(on ? 1 : 0);
    else Animated.timing(sel, { toValue: on ? 1 : 0, duration: 180, useNativeDriver: false }).start();
  }, [on, sel]);
  useEffect(() => run(fade, dim ? 0.45 : 1, 240), [dim, fade]);
  const recommended = RECOMMENDED.test(label);
  return (
    <PressScale accessibilityRole={multi ? "checkbox" : "radio"} accessibilityState={{ selected: on, checked: on }} onPress={onPress} haptic="select" scaleTo={0.985}>
      <Animated.View style={{ opacity: fade }}>
      <Animated.View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52, borderTopWidth: first ? 0 : 1, borderTopColor: l.line, backgroundColor: sel.interpolate({ inputRange: [0, 1], outputRange: [`${l.field}00`, l.on] }) }}>
        <View accessibilityElementsHidden style={{ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.hi : l.num }}>
          <Txt variant="small" tone={on ? "on-hi" : l.sub} style={{ fontWeight: "700", fontVariant: ["tabular-nums"] }}>
            {n}
          </Txt>
        </View>
        <View style={{ flex: 1, gap: 2, paddingTop: 2 }}>
          <Txt variant="body" tone={l.text} style={{ fontWeight: "600" }}>
            {label.replace(RECOMMENDED, "")}
            {recommended ? (
              <Txt variant="small" tone={l.sub} style={{ fontWeight: "400" }}>
                {"  ·  Recommended"}
              </Txt>
            ) : null}
          </Txt>
          {!!description && (
            <Txt variant="small" tone={l.sub}>
              {description}
            </Txt>
          )}
        </View>
        {on && (
          <PopIn style={{ alignSelf: "center" }}>
            <View accessibilityElementsHidden style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.hi, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 10, height: 5, marginTop: -2, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: colors.onHi, transform: [{ rotate: "-45deg" }] }} />
            </View>
          </PopIn>
        )}
      </Animated.View>
      </Animated.View>
    </PressScale>
  );
}

/** A round button with an arrow: back to the question before, or on to one already reached. */
function Arrow({ dir, disabled, tone, onPress }: { dir: "back" | "on"; disabled: boolean; tone: QuestionTone; onPress: () => void }) {
  const colors = useColors();
  const l = look(colors, tone);
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={dir === "back" ? "Previous question" : "Next question"} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} haptic="select" scaleTo={0.85} hitSlop={8}>
      <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: disabled ? "transparent" : l.num, opacity: disabled ? 0.35 : 1 }}>
        {/* A chevron drawn, not a glyph: the text face draws ‹ › small and thin. */}
        <View accessibilityElementsHidden style={{ width: 9, height: 9, marginLeft: dir === "back" ? 3 : -3, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: tone === "night" ? colors.white : colors.ink, transform: [{ rotate: dir === "back" ? "45deg" : "-135deg" }] }} />
      </View>
    </PressScale>
  );
}

/** One row of the recap: the question, small, and what was chosen for it under; a tap goes back to change it. */
function RecapRow({ n, question, answer, tone, first, disabled, onPress }: { n: number; question: string; answer: string; tone: QuestionTone; first: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useColors();
  const l = look(colors, tone);
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={`${question}: ${answer || "no answer yet"}. Change it`} disabled={disabled} onPress={onPress} haptic="select" scaleTo={0.985}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52, borderTopWidth: first ? 0 : 1, borderTopColor: l.line }}>
        <View accessibilityElementsHidden style={{ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: l.num }}>
          <Txt variant="small" tone={l.sub} style={{ fontWeight: "700", fontVariant: ["tabular-nums"] }}>
            {n}
          </Txt>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="small" tone={l.sub} numberOfLines={2}>
            {question}
          </Txt>
          <Txt variant="body" tone={answer ? l.text : l.sub} style={{ fontWeight: answer ? "600" : "400", fontStyle: answer ? "normal" : "italic" }}>
            {answer ? answer.replace(RECOMMENDED, "") : "No answer yet"}
          </Txt>
        </View>
        {/* A chevron drawn, as the arrows are: this row opens its question again. */}
        <View accessibilityElementsHidden style={{ width: 8, height: 8, marginRight: 4, borderRightWidth: 2, borderTopWidth: 2, borderColor: tone === "night" ? colors.nightText : colors.ink3, transform: [{ rotate: "45deg" }] }} />
      </View>
    </PressScale>
  );
}

/** The next layout change (the panel growing or shrinking to the question coming in) glides there instead of jumping. */
function glideNextLayout() {
  if (skips()) return;
  LayoutAnimation.configureNext({ duration: STEP_IN_MS, update: { type: LayoutAnimation.Types.easeOut } });
}

/**
 * Claude's questions as the Claude app asks them, one at a time: "Claude is asking" with "1 of 3" and arrows, the question, its
 * options as numbered rows of one list, and a last row to write your own answer; Skip and Next under them. Picking an option of a
 * question with one answer holds it lit for a beat (the others dimming), then moves on, the question fading away as the next
 * eases in from the side and the panel's height gliding to it; a pick-any question, or something typed, moves on from Next (or
 * the keyboard's return). After the last comes a recap: each question with what you chose (a tap goes back to change it), and
 * Send. Nothing goes until Send. The arrows go back to an earlier question with its answer kept, and on again to one reached.
 *
 * Used where the chat's message box was (`paper`), and on the full-screen decision (`night`). `onSend` and `onSkip` may be called
 * again after a send fails (`busy` goes back to false); the caller keeps a second press from sending twice.
 */
export function QuestionAsk({ questions, who = "Claude", tone, busy = false, kicker = true, onSend, onSkip, maxListHeight, onStepped }: { questions: Question[]; who?: string; tone: QuestionTone; busy?: boolean; /** "Claude is asking" over the question (the full screen has its own title that says so). */ kicker?: boolean; onSend: (answers: Record<string, string>) => void; onSkip: () => void; /** The options scroll past this height (where the message box was, so the chat stays in view). */ maxListHeight?: number; /** A new question is shown: the full screen goes back to its top. */ onStepped?: () => void }) {
  const colors = useColors();
  const body = useBody();
  const l = look(colors, tone);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  // The furthest question reached (the recap is one past the last): the arrows go back and forth up to it.
  const [reached, setReached] = useState(0);
  const [stepBack, setStepBack] = useState(false);
  // A pick being shown before the panel moves on: the other options dim, and nothing else is picked meanwhile.
  const [settling, setSettling] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leave = useRef(new Animated.Value(1)).current;
  const moving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopMoving = () => {
    if (moving.current) clearTimeout(moving.current);
    moving.current = null;
    setSettling(false);
  };
  useEffect(
    () => () => {
      if (moving.current) clearTimeout(moving.current);
    },
    [],
  );

  const many = questions.length > 1;
  // Past the last question: the recap of what was chosen, with Send.
  const recap = questions.length > 0 && step >= questions.length;
  const at = recap ? questions.length : Math.min(step, Math.max(questions.length - 1, 0));
  const last = at === questions.length - 1;
  const q = recap ? undefined : questions[at];

  // To question `to` (or the recap): the one shown fades away the way it is going first (at once when motion is reduced).
  const goTo = (to: number) => {
    stopMoving();
    setStepBack(to < at);
    const swap = () => {
      glideNextLayout();
      setLeaving(false);
      setSettling(false);
      setStep(to);
      setReached((r) => Math.max(r, to));
      leave.setValue(1);
      onStepped?.();
    };
    if (skips()) return swap();
    setLeaving(true);
    Animated.timing(leave, { toValue: 0, duration: LEAVE_MS, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => swap());
  };
  // On from the question shown: to the next, or, from the last, to the recap (or to the first still unanswered, if one is).
  const onward = (p: Record<string, string[]>, t: Record<string, string>) => {
    if (!last) return goTo(at + 1);
    const waiting = questions.findIndex((x) => !hasAnswer(x, p, t));
    goTo(waiting === -1 ? questions.length : waiting);
  };

  if (questions.length === 0) {
    return (
      <View style={{ gap: 12 }}>
        <Txt variant="body" tone={l.sub}>
          {who} asked something Lantern couldn't read. Skip it, and answer in the chat instead.
        </Txt>
        <Button label="Skip" kind={l.skip} disabled={busy} onPress={onSkip} />
      </View>
    );
  }

  // A pick: a question with one answer moves on once the pick has been seen; one where several can be picked waits for Next.
  const toggle = (label: string) => {
    if (!q || leaving) return;
    const now = picks[q.question] ?? [];
    const nextPicks = { ...picks, [q.question]: q.multiSelect ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : [label] };
    const nextTyped = { ...typed, [q.question]: "" };
    setPicks(nextPicks);
    setTyped(nextTyped);
    if (q.multiSelect || busy) return;
    stopMoving();
    setSettling(true);
    moving.current = setTimeout(() => onward(nextPicks, nextTyped), PICK_BEAT_MS);
  };

  const allReady = !!answersFrom(questions, picks, typed);
  const frame = { borderRadius: radius.inner, borderWidth: 1, borderColor: l.line, backgroundColor: l.field, overflow: "hidden" as const };
  const scrolls = (rows: ReactNode) =>
    maxListHeight ? (
      <ScrollView style={{ maxHeight: maxListHeight }} keyboardShouldPersistTaps="handled" bounces={false}>
        {rows}
      </ScrollView>
    ) : (
      rows
    );

  let shown: ReactNode;
  let hint: string;
  let primary: ReactNode;
  if (q) {
    const picked = picks[q.question] ?? [];
    const own = typed[q.question] ?? "";
    const ready = hasAnswer(q, picks, typed);
    hint = q.multiSelect ? "Pick any, then Next" : "Pick one, or write your own";
    primary = <Button label="Next" kind="hi" disabled={!ready || busy || leaving} onPress={() => onward(picks, typed)} />;
    shown = (
      <View style={{ gap: 12 }}>
        <Txt variant="heading" tone={l.text}>
          {q.question}
        </Txt>
        {scrolls(
          <View style={frame}>
            {q.options.map((o, i) => {
              const on = picked.includes(o.label) && !own.trim();
              return <OptionRow key={o.label} n={i + 1} first={i === 0} on={on} dim={(settling || leaving) && !on} multi={q.multiSelect} label={o.label} description={o.description} tone={tone} onPress={() => toggle(o.label)} />;
            })}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, minHeight: 52, borderTopWidth: q.options.length ? 1 : 0, borderTopColor: l.line, backgroundColor: own.trim() ? l.on : "transparent", opacity: (settling || leaving) && !own.trim() ? 0.45 : 1 }}>
              <View accessibilityElementsHidden style={{ width: 26, alignItems: "center" }}>
                <Txt variant="body" tone={l.sub}>
                  ✎
                </Txt>
              </View>
              <TextInput
                accessibilityLabel="Something else"
                value={own}
                editable={!busy}
                onChangeText={(t) => {
                  // Writing your own answer: a pick that was about to move on waits.
                  stopMoving();
                  setTyped((s) => ({ ...s, [q.question]: t }));
                }}
                placeholder="Something else…"
                placeholderTextColor={l.placeholder}
                returnKeyType="next"
                onSubmitEditing={() => own.trim() && onward(picks, typed)}
                style={{ flex: 1, color: l.input, paddingVertical: 14, fontSize: body.fontSize }}
              />
            </View>
          </View>,
        )}
      </View>
    );
  } else {
    hint = "Tap one to change it";
    primary = (
      <Button
        label={many ? "Send answers" : "Send answer"}
        kind="hi"
        disabled={!allReady || busy || leaving}
        onPress={() => {
          const all = answersFrom(questions, picks, typed);
          if (all) {
            stopMoving();
            onSend(all);
          }
        }}
      />
    );
    shown = (
      <View style={{ gap: 12 }}>
        <Txt variant="heading" tone={l.text}>
          {many ? "Check your answers" : "Check your answer"}
        </Txt>
        {scrolls(
          <View testID="question-recap" style={frame}>
            {questions.map((x, i) => (
              <RecapRow key={x.question} n={i + 1} first={i === 0} question={x.question} answer={typed[x.question]?.trim() || (picks[x.question] ?? []).join(", ")} tone={tone} disabled={busy || leaving} onPress={() => goTo(i)} />
            ))}
          </View>,
        )}
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {(kicker || many) && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 30 }}>
          <Txt variant="small" tone={l.sub} style={{ fontWeight: "600" }}>
            {kicker ? (many ? `${who} has ${questions.length} questions` : `${who} is asking`) : ""}
          </Txt>
          {many && (
            <View testID="question-steps" style={{ flexDirection: "row", alignItems: "center" }}>
              <Arrow dir="back" tone={tone} disabled={at === 0 || busy || leaving} onPress={() => goTo(at - 1)} />
              <Txt variant="small" tone={l.sub} style={{ fontVariant: ["tabular-nums"], paddingHorizontal: 2 }} accessibilityLiveRegion="polite">
                {recap ? "Review" : `${at + 1} of ${questions.length}`}
              </Txt>
              <Arrow dir="on" tone={tone} disabled={at >= reached || busy || leaving} onPress={() => goTo(at + 1)} />
            </View>
          )}
        </View>
      )}
      {/* One question at a time: the one shown drifts out the way it is going as the next eases in from the other side. */}
      <Animated.View key={at} testID="question-step" style={{ opacity: leave, transform: [{ translateX: leave.interpolate({ inputRange: [0, 1], outputRange: [stepBack ? 6 : -6, 0] }) }] }}>
        <StepIn back={stepBack}>{shown}</StepIn>
      </Animated.View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Txt variant="small" tone={l.sub} style={{ flex: 1 }} numberOfLines={2}>
          {hint}
        </Txt>
        <Button
          label="Skip"
          kind={l.skip}
          disabled={busy}
          onPress={() => {
            stopMoving();
            onSkip();
          }}
        />
        {primary}
      </View>
    </View>
  );
}
