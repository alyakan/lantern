import { useEffect, useRef, useState } from "react";
import { Animated, ScrollView, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useController, useSyncState } from "../shell/hooks";
import { Button, Tag, Txt } from "../ui/components";
import { AboveKeyboard, useKeyboardUp } from "../ui/keyboard";
import { buzz, FadeSlideIn, PopIn, PressScale, skips } from "../ui/motion";
import { Chevron } from "../ui/Chevron";
import { SwipeToAllow } from "../ui/SwipeToAllow";
import { radius, space, useColors } from "../ui/theme";
import { diffPreviewOf } from "../view/diffPreview";
import { approvalOf, promptView, type PromptView, type Question } from "../view/prompts";
import { DiffPreviewCard } from "./DiffPreviewCard";
import type { Waiting } from "../protocol/generated/Waiting";

export interface DecideProps {
  slot: string;
  requestId: string;
  onClose: () => void;
}

/** How long "Answered on your Mac" (what someone else did) stays before the screen closes by itself: it is news, so it is read. */
export const CLOSE_AFTER_MS = 1500;

/** How long what this phone just did ("Answer sent", "Denied") stays: it is what was just pressed, so there is little to read. */
export const DONE_CLOSE_MS = 800;

/** An approval, swiped, closes sooner: the bar closing in to a check says it, and there is nothing to read. */
export const APPROVED_CLOSE_MS = 1000;

/** `elsewhere`: it left the Mac's list without this screen's answer coming back (`ours`: this phone had sent one, and it went through even though the reply didn't). */
type Outcome = { kind: "none" } | { kind: "sending" } | { kind: "done"; allowed: boolean; /** Approved with a swipe (not a question's answers): it closes sooner, in green. */ swiped: boolean } | { kind: "elsewhere"; ours: boolean } | { kind: "failed"; why: string };

/** What the answers to a prompt's questions come to, one string per question (a multi-select joined with commas). */
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

/** One answer to choose: it takes the highlighter colour as it is picked, with a check popping in, and gives under a press. */
function OptionCard({ on, multi, label, description, onPress }: { on: boolean; multi: boolean; label: string; description?: string; onPress: () => void }) {
  const colors = useColors();
  const sel = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    if (skips()) sel.setValue(on ? 1 : 0);
    else Animated.timing(sel, { toValue: on ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [on, sel]);
  return (
    <PressScale accessibilityRole={multi ? "checkbox" : "radio"} accessibilityState={{ selected: on, checked: on }} onPress={onPress} haptic="select" scaleTo={0.97}>
      <Animated.View
        style={{
          borderRadius: radius.inner,
          borderWidth: 1.5,
          borderColor: sel.interpolate({ inputRange: [0, 1], outputRange: ["rgba(255,255,255,0.18)", colors.hi] }),
          backgroundColor: sel.interpolate({ inputRange: [0, 1], outputRange: ["rgba(255,194,26,0)", "rgba(255,194,26,0.14)"] }),
          padding: 12,
          minHeight: 56,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <View style={{ flex: 1 }}>
          <Txt variant="body" tone="white" style={{ fontWeight: "600" }}>
            {label}
          </Txt>
          {!!description && (
            <Txt variant="small" tone="night">
              {description}
            </Txt>
          )}
        </View>
        {on && (
          <PopIn>
            <View accessibilityElementsHidden style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: colors.hi, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 11, height: 6, marginTop: -2, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: colors.night, transform: [{ rotate: "-45deg" }] }} />
            </View>
          </PopIn>
        )}
      </Animated.View>
    </PressScale>
  );
}

function Options({ q, picks, typed, onPick, onType }: { q: Question; picks: string[]; typed: string; onPick: (label: string) => void; onType: (text: string) => void }) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      {q.header ? (
        <Txt variant="small" tone="night">
          {q.header}
        </Txt>
      ) : null}
      <Txt variant="heading" tone="white">
        {q.question}
      </Txt>
      {q.options.map((o, i) => (
        <FadeSlideIn key={o.label} from={12} delay={260 + i * 60}>
          <OptionCard on={picks.includes(o.label) && !typed.trim()} multi={!!q.multiSelect} label={o.label} description={o.description} onPress={() => onPick(o.label)} />
        </FadeSlideIn>
      ))}
      <TextInput
        accessibilityLabel="Something else"
        value={typed}
        onChangeText={onType}
        placeholder="Something else: write your own answer"
        placeholderTextColor={colors.nightText}
        style={{ borderRadius: radius.inner, borderWidth: 1.5, borderColor: typed.trim() ? colors.hi : "rgba(255,255,255,0.18)", color: colors.white, padding: 12, minHeight: 48, fontSize: 15 }}
      />
    </View>
  );
}

/** The decision on its own, full screen: what is asked, where it runs, and a swipe to allow or a tap to deny. */
export function DecideScreen({ slot, requestId, onClose }: DecideProps) {
  const colors = useColors();
  const controller = useController();
  const { waiting, chats } = useSyncState();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardUp();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  // What was asked is kept as it was first seen: once answered it leaves the list, and the screen still says what it was.
  const live = waiting.find((w) => w.request_id === requestId);
  const kept = useRef<Waiting | undefined>(live);
  if (live) kept.current = live;
  const asked = kept.current;
  const chat = chats.find((c) => c.slot === slot);

  // Once the Mac no longer lists it, it is answered, whatever this screen last heard: an answer that went through but whose
  // reply was lost (a poor connection) lands in "failed" or stays "sending", and would otherwise keep a swipe up for ever.
  const gone = !live && !!asked;
  useEffect(() => {
    if (!gone) return;
    setOutcome((o) => (o.kind === "done" || o.kind === "elsewhere" ? o : { kind: "elsewhere", ours: o.kind !== "none" }));
  }, [gone, outcome.kind]);
  useEffect(() => {
    if (outcome.kind !== "elsewhere" && outcome.kind !== "done") return;
    const t = setTimeout(onClose, outcome.kind === "done" ? (outcome.swiped ? APPROVED_CLOSE_MS : DONE_CLOSE_MS) : CLOSE_AFTER_MS);
    return () => clearTimeout(t);
  }, [outcome, onClose]);

  if (!asked) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.night, padding: space.xl, paddingTop: insets.top + 60, gap: 16 }}>
        <StatusBar style="light" />
        <Txt variant="title" tone="white">
          This was answered already
        </Txt>
        <Txt variant="body" tone="night">
          It isn't waiting on you any more.
        </Txt>
        <Button label="Close" kind="night-ghost" onPress={onClose} />
      </View>
    );
  }

  const approval = approvalOf(asked.tool_name, asked.input);
  const base: PromptView = promptView(asked.tool_name, asked.input);
  // A question's own words are shown once, above its options; the title only says that Claude asks.
  const view: PromptView = approval ? { ...base, tag: "Approval", title: `Approve ${approval.action}?`, detail: approval.why || null } : base.kind === "question" ? { ...base, title: base.questions.length > 1 ? "Claude has questions" : "Claude has a question" } : base;
  // A file change is shown as the diff it would make, read from the prompt's own input, so what is approved is what is seen.
  const preview = view.kind === "allow" && !approval ? diffPreviewOf(asked.tool_name, asked.input) : null;
  const answers = view.kind === "question" ? answersFrom(view.questions, picks, typed) : null;
  const busy = outcome.kind === "sending";

  const answer = async (allow: boolean, withAnswers: Record<string, string> | null = null) => {
    setOutcome({ kind: "sending" });
    try {
      await controller.sync.answer(slot, requestId, allow, withAnswers);
      // A reply that comes late, after the Mac stopped listing it, doesn't undo that.
      setOutcome((o) => (o.kind === "elsewhere" ? o : { kind: "done", allowed: allow, swiped: allow && !withAnswers }));
      // The swipe buzzes for itself; the rest say what it came to.
      if (!allow) buzz("warning");
      else if (withAnswers) buzz("success");
    } catch (e) {
      setOutcome((o) => (o.kind === "elsewhere" ? o : { kind: "failed", why: (e as Error).message }));
    }
  };

  const toggle = (q: Question, label: string) => {
    setTyped((t) => ({ ...t, [q.question]: "" }));
    setPicks((p) => {
      const now = p[q.question] ?? [];
      return { ...p, [q.question]: q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label] };
    });
  };

  return (
    // The keyboard (for "Something else") pushes the buttons up with it, and the list above gets shorter.
    <AboveKeyboard style={{ backgroundColor: colors.night, overflow: "hidden", paddingTop: insets.top + 56, paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 20), paddingHorizontal: 22 }}>
      <StatusBar style="light" />
      {/* The decision can be put away at any point (it keeps waiting, in the chat and on Home) and come back to with Review. */}
      <PressScale accessibilityRole="button" accessibilityLabel="Minimize" accessibilityHint="Back to the chat. The decision keeps waiting." onPress={onClose} haptic="select" scaleTo={0.94} hitSlop={10} style={{ position: "absolute", top: insets.top + 8, left: 14, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, minHeight: 40 }}>
        <Chevron open color={colors.white} />
        <Txt variant="small" tone="white" style={{ fontWeight: "700" }}>
          Minimize
        </Txt>
      </PressScale>
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingBottom: 16 }}>
        {/* The parts of the decision arrive one after another as the screen rises. */}
        <FadeSlideIn from={10} delay={80} style={{ alignSelf: "flex-start" }}>
          <Tag>{view.tag}</Tag>
        </FadeSlideIn>
        <FadeSlideIn from={14} delay={130}>
          <Txt variant="title" tone="white" accessibilityRole="header">
            {view.title}
          </Txt>
        </FadeSlideIn>
        <FadeSlideIn from={12} delay={180}>
          <Txt variant="body" tone="night">
            {chat?.title ? `${chat.title}${chat.project ? `, in ${chat.project}` : ""}` : "A chat on your Mac"}
          </Txt>
        </FadeSlideIn>

        {view.kind === "allow" && view.detail && (
          <FadeSlideIn from={14} delay={240}>
            <View style={{ backgroundColor: colors.nightRaised, borderRadius: radius.inner, padding: 14, marginTop: 6 }}>
              <Txt variant="mono" tone="white" selectable>
                {view.detail}
              </Txt>
            </View>
          </FadeSlideIn>
        )}
        {preview && (
          <FadeSlideIn from={14} delay={270}>
            <DiffPreviewCard preview={preview} file={null} />
          </FadeSlideIn>
        )}
        {view.kind === "allow" && (
          <FadeSlideIn from={10} delay={300}>
            <Txt variant="small" tone="night">
              This runs on <Txt variant="small" style={{ color: colors.hi, fontWeight: "700" }}>your Mac</Txt>, not this phone.
            </Txt>
          </FadeSlideIn>
        )}
        {view.kind === "question" && view.questions.map((q) => <Options key={q.question} q={q} picks={picks[q.question] ?? []} typed={typed[q.question] ?? ""} onPick={(l) => toggle(q, l)} onType={(t) => setTyped((s) => ({ ...s, [q.question]: t }))} />)}
      </ScrollView>

      {outcome.kind === "failed" && (
        <Txt variant="small" tone="white" style={{ backgroundColor: "#d93b3b55", padding: 10, borderRadius: 10, marginBottom: 10 }} accessibilityRole="alert">
          {outcome.why}
        </Txt>
      )}
      {outcome.kind === "elsewhere" && (
        <Txt variant="small" tone="night" style={{ marginBottom: 12 }} accessibilityRole="alert">
          {outcome.ours ? "It isn't waiting any more." : "Answered on your Mac."}
        </Txt>
      )}
      {outcome.kind === "done" && (
        <FadeSlideIn from={8}>
          <Txt variant="small" tone="night" style={{ marginBottom: 12 }} accessibilityRole="alert">
            {outcome.allowed ? (view.kind === "question" ? "Answer sent." : "Allowed.") : view.kind === "question" ? "Declined." : "Denied."}
          </Txt>
        </FadeSlideIn>
      )}

      {outcome.kind === "none" || outcome.kind === "sending" || outcome.kind === "failed" ? (
        view.kind === "question" ? (
          <View style={{ gap: 8 }}>
            <Button label="Send answer" kind="hi" disabled={!answers || busy} onPress={() => answers && answer(true, answers)} />
            <Button label="Decline" kind="night-ghost" link disabled={busy} onPress={() => answer(false)} />
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {/* It stays up while the answer goes, and shows it was allowed (it can't be dragged again). */}
            {/* A failed answer brings a fresh one back (the key), not the one that looks allowed. */}
            <SwipeToAllow key={outcome.kind === "failed" ? "again" : "first"} label={approval ? "Swipe to approve" : "Swipe to allow"} doneLabel={approval ? "Approved" : "Allowed"} onAllow={() => answer(true)} />
            <Button label={approval ? "Don't approve" : "Deny"} kind="night-stop" link disabled={busy} onPress={() => answer(false)} />
          </View>
        )
      ) : outcome.kind === "done" && outcome.allowed && view.kind !== "question" ? (
        <View testID="approved" style={{ gap: 12 }}>
          {/* The same bar, now closed in to a circle with the check: it closes this by itself, and a tap on it does so at once. */}
          <SwipeToAllow key="first" label={approval ? "Swipe to approve" : "Swipe to allow"} doneLabel={approval ? "Approved" : "Allowed"} onAllow={() => {}} onDone={onClose} />
          {/* Deny's place is kept, unseen, so the circle stays where the bar was and isn't pushed down. */}
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ opacity: 0 }}>
            <Button label={approval ? "Don't approve" : "Deny"} kind="night-stop" link disabled onPress={() => {}} />
          </View>
        </View>
      ) : (
        <Button label="Done" kind="night-ghost" onPress={onClose} />
      )}
    </AboveKeyboard>
  );
}
