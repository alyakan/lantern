import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useController, useSyncState } from "../shell/hooks";
import { Button, Tag, Txt } from "../ui/components";
import { SwipeToAllow } from "../ui/SwipeToAllow";
import { colors, radius, space } from "../ui/theme";
import { approvalOf, promptView, type PromptView, type Question } from "../view/prompts";
import type { Waiting } from "../protocol/generated/Waiting";

export interface DecideProps {
  slot: string;
  requestId: string;
  onClose: () => void;
}

/** How long "Answered on your Mac" stays before the screen closes by itself. */
export const CLOSE_AFTER_MS = 2500;

type Outcome = { kind: "none" } | { kind: "sending" } | { kind: "done"; allowed: boolean } | { kind: "elsewhere" } | { kind: "failed"; why: string };

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

function Options({ q, picks, typed, onPick, onType }: { q: Question; picks: string[]; typed: string; onPick: (label: string) => void; onType: (text: string) => void }) {
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
      {q.options.map((o) => {
        const on = picks.includes(o.label) && !typed.trim();
        return (
          <Pressable
            key={o.label}
            accessibilityRole={q.multiSelect ? "checkbox" : "radio"}
            accessibilityState={{ selected: on, checked: on }}
            onPress={() => onPick(o.label)}
            style={{ borderRadius: radius.inner, borderWidth: 1.5, borderColor: on ? colors.hi : "rgba(255,255,255,0.18)", backgroundColor: on ? "rgba(255,194,26,0.14)" : "transparent", padding: 12, minHeight: 56 }}
          >
            <Txt variant="body" tone="white" style={{ fontWeight: "600" }}>
              {o.label}
            </Txt>
            {!!o.description && (
              <Txt variant="small" tone="night">
                {o.description}
              </Txt>
            )}
          </Pressable>
        );
      })}
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
  const controller = useController();
  const { waiting, chats } = useSyncState();
  const insets = useSafeAreaInsets();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  // What was asked is kept as it was first seen: once answered it leaves the list, and the screen still says what it was.
  const live = waiting.find((w) => w.request_id === requestId);
  const kept = useRef<Waiting | undefined>(live);
  if (live) kept.current = live;
  const asked = kept.current;
  const chat = chats.find((c) => c.slot === slot);

  const gone = !live && !!asked;
  useEffect(() => {
    if (!gone || outcome.kind !== "none") return;
    setOutcome({ kind: "elsewhere" });
  }, [gone, outcome.kind]);
  useEffect(() => {
    if (outcome.kind !== "elsewhere" && outcome.kind !== "done") return;
    const t = setTimeout(onClose, CLOSE_AFTER_MS);
    return () => clearTimeout(t);
  }, [outcome.kind, onClose]);

  if (!asked) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.night, padding: space.xl, paddingTop: insets.top + 60, gap: 16 }}>
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
  const answers = view.kind === "question" ? answersFrom(view.questions, picks, typed) : null;
  const busy = outcome.kind === "sending";

  const answer = async (allow: boolean, withAnswers: Record<string, string> | null = null) => {
    setOutcome({ kind: "sending" });
    try {
      await controller.sync.answer(slot, requestId, allow, withAnswers);
      setOutcome({ kind: "done", allowed: allow });
    } catch (e) {
      setOutcome({ kind: "failed", why: (e as Error).message });
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
    <View style={{ flex: 1, backgroundColor: colors.night, paddingTop: insets.top + 56, paddingBottom: Math.max(insets.bottom, 20), paddingHorizontal: 22 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingBottom: 16 }}>
        <Tag>{view.tag}</Tag>
        <Txt variant="title" tone="white" accessibilityRole="header">
          {view.title}
        </Txt>
        <Txt variant="body" tone="night">
          {chat?.title ? `${chat.title}${chat.project ? `, in ${chat.project}` : ""}` : "A chat on your Mac"}
        </Txt>

        {view.kind === "allow" && view.detail && (
          <View style={{ backgroundColor: colors.nightRaised, borderRadius: radius.inner, padding: 14, marginTop: 6 }}>
            <Txt variant="mono" tone="white" selectable>
              {view.detail}
            </Txt>
          </View>
        )}
        {view.kind === "allow" && (
          <Txt variant="small" tone="night">
            This runs on <Txt variant="small" style={{ color: colors.hi, fontWeight: "700" }}>your Mac</Txt>, not this phone.
          </Txt>
        )}
        {view.kind === "question" && view.questions.map((q) => <Options key={q.question} q={q} picks={picks[q.question] ?? []} typed={typed[q.question] ?? ""} onPick={(l) => toggle(q, l)} onType={(t) => setTyped((s) => ({ ...s, [q.question]: t }))} />)}
      </ScrollView>

      {outcome.kind === "failed" && (
        <Txt variant="small" tone="white" style={{ backgroundColor: "#d93b3b55", padding: 10, borderRadius: 10, marginBottom: 10 }} accessibilityRole="alert">
          {outcome.why}
        </Txt>
      )}
      {outcome.kind === "elsewhere" && (
        <Txt variant="body" tone="white" style={{ marginBottom: 12 }} accessibilityRole="alert">
          Answered on your Mac.
        </Txt>
      )}
      {outcome.kind === "done" && (
        <Txt variant="body" tone="white" style={{ marginBottom: 12 }} accessibilityRole="alert">
          {outcome.allowed ? (view.kind === "question" ? "Answer sent." : "Allowed.") : view.kind === "question" ? "Declined." : "Denied."}
        </Txt>
      )}

      {outcome.kind === "none" || outcome.kind === "sending" || outcome.kind === "failed" ? (
        view.kind === "question" ? (
          <View style={{ gap: 8 }}>
            <Button label="Send answer" disabled={!answers || busy} onPress={() => answers && answer(true, answers)} style={{ backgroundColor: colors.hi }} />
            <Button label="Decline" kind="night-ghost" disabled={busy} onPress={() => answer(false)} />
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {!busy && <SwipeToAllow label={approval ? "Swipe to approve" : "Swipe to allow"} onAllow={() => answer(true)} />}
            <Button label={approval ? "Don't approve" : "Deny"} kind="night-stop" disabled={busy} onPress={() => answer(false)} style={{ backgroundColor: "transparent" }} />
          </View>
        )
      ) : (
        <Button label="Done" kind="night-ghost" onPress={onClose} />
      )}
    </View>
  );
}
