import { useEffect, useRef, useState } from "react";
import type { RemoteCommand } from "../protocol/generated/RemoteCommand";
import type { RemoteTodo } from "../protocol/generated/RemoteTodo";
import type { PlanUsage } from "../sync/reducer";
import { contextOf, progressOf, shortTokens, usageOf, weekOf } from "../view/plan";
import { ScrollView, Share, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { Chevron } from "../ui/Chevron";
import { Glass } from "../ui/Glass";
import { useKeyboardUp } from "../ui/keyboard";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { fonts, radius, space, useColors } from "../ui/theme";

/** One thing a sheet offers: a row with a name. */
function ActionRow({ label, hint, onPress, tone = "ink" }: { label: string; hint?: string; onPress: () => void; tone?: "ink" | "stop" }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} haptic="select" scaleTo={0.98} style={{ borderRadius: radius.inner, backgroundColor: colors.wash, paddingVertical: 13, paddingHorizontal: 14, gap: 2 }}>
      <Txt variant="body" tone={tone} style={{ fontWeight: "700" }}>
        {label}
      </Txt>
      {hint && (
        <Txt variant="small" tone="ink2">
          {hint}
        </Txt>
      )}
    </PressScale>
  );
}

/**
 * What can be done with a message held down: copy it, quote it in a reply, select part of it, and (your own last one) edit
 * it and send it again. Each does it and closes the sheet.
 */
export function MessageActionsSheet({ text, onQuote, onEdit, onReadAloud, reading = false, sentAt = null, onClose }: { text: string; onQuote: () => void; /** Only for your own last message. */ onEdit?: () => void; /** Reads the message aloud (or stops reading it). */ onReadAloud?: () => void; reading?: boolean; /** When it was sent (your messages): said at the top, since the chat shows a time only now and then. */ sentAt?: number | null; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [selecting, setSelecting] = useState(false);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 8, maxHeight: "100%" }]}>
          {selecting ? (
            <>
              <Txt variant="heading" accessibilityRole="header">
                Select text
              </Txt>
              <ScrollView style={{ maxHeight: 360 }}>
                <Text selectable accessibilityLabel="The message's text" style={{ fontSize: 15, lineHeight: 21, color: colors.ink }}>
                  {text}
                </Text>
              </ScrollView>
              <Button label="Done" kind="ghost" onPress={close} />
            </>
          ) : (
            <>
              {sentAt !== null && (
                <Txt variant="small" tone="ink3" style={{ marginBottom: 2 }}>
                  Sent {new Date(sentAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </Txt>
              )}
              <ActionRow
                label="Copy"
                onPress={() => {
                  void Promise.resolve(Clipboard.setStringAsync(text)).catch(() => {});
                  close();
                }}
              />
              <ActionRow
                label="Quote in a reply"
                hint="Puts it in the message box, to answer under it"
                onPress={() => {
                  onQuote();
                  close();
                }}
              />
              <ActionRow label="Select text" hint="Pick just the part you want" onPress={() => setSelecting(true)} />
              <ActionRow
                label="Share"
                hint="Send it to another app"
                onPress={() => {
                  void Share.share({ message: text }).catch(() => {});
                  close();
                }}
              />
              {onReadAloud && (
                <ActionRow
                  label={reading ? "Stop reading" : "Read aloud"}
                  hint={reading ? undefined : "The phone's voice reads the words, not the code"}
                  onPress={() => {
                    onReadAloud();
                    close();
                  }}
                />
              )}
              {onEdit && (
                <ActionRow
                  label="Edit and send again"
                  hint="Puts it back in the message box"
                  onPress={() => {
                    onEdit();
                    close();
                  }}
                />
              )}
              <Button label="Cancel" kind="ghost" onPress={close} />
            </>
          )}
        </View>
      )}
    </Sheet>
  );
}

/** A round button over the chat that takes it to the latest message, with how many came while it was scrolled away. */
export function JumpToBottom({ unseen, onPress, lift = 0 }: { unseen: number; onPress: () => void; /** How far above the bottom of its box it sits, where the message box floats over the list. */ lift?: number }) {
  const colors = useColors();
  return (
    <FadeSlideIn glass from={8} ms={160} style={{ position: "absolute", right: 14, bottom: 10 + lift, alignItems: "flex-end", gap: 6 }}>
      {unseen > 0 && (
        <View accessibilityElementsHidden style={{ backgroundColor: colors.ink, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 }}>
          <Txt variant="tiny" tone="on-ink" style={{ fontWeight: "700" }}>
            {unseen} new
          </Txt>
        </View>
      )}
      <PressScale accessibilityRole="button" accessibilityLabel={unseen > 0 ? `Jump to the latest, ${unseen} new` : "Jump to the latest"} onPress={onPress} haptic="light" scaleTo={0.9}>
        <Glass lift={0.16} style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
          <View style={{ transform: [{ rotate: "90deg" }] }}>
            <Chevron open={false} color={colors.ink} />
          </View>
        </Glass>
      </PressScale>
    </FadeSlideIn>
  );
}

/**
 * What Claude's last message asks for, one press each: Yes and No under a yes-or-no question, or the exact words it asked to
 * be said ("Say "admin merge""). They go as a message and are gone; longer ones wrap to a second line.
 */
export function QuickReplies({ replies, onSend }: { replies: string[]; onSend: (text: string) => void }) {
  const colors = useColors();
  return (
    <View accessibilityLabel="Quick replies" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 6 }}>
      {replies.map((r, i) => (
        <FadeSlideIn key={r} from={8} delay={i * 50} ms={180}>
          <PressScale accessibilityRole="button" accessibilityLabel={`Reply: ${r}`} onPress={() => onSend(r)} haptic="select" scaleTo={0.94}>
            <Glass solid lift={0.06} style={{ borderColor: colors.rule, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 9 }}>
              <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
                {r}
              </Txt>
            </Glass>
          </PressScale>
        </FadeSlideIn>
      ))}
    </View>
  );
}

/**
 * The plan Claude is keeping, over the message box: one line (how far, and what it is doing now) that opens to every step.
 * Gone once every step is done.
 */
export function PlanCard({ todos }: { todos: RemoteTodo[] }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const p = progressOf(todos);
  if (todos.length === 0 || p.finished) return null;
  return (
    <FadeSlideIn from={8} ms={180} style={{ marginHorizontal: 12, marginBottom: 6 }}>
      <Glass solid style={{ borderRadius: radius.inner, overflow: "hidden" }}>
        <PressScale accessibilityRole="button" accessibilityLabel={`Plan, ${p.done} of ${p.total} done${p.current ? `, now: ${p.current}` : ""}`} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} haptic="select" scaleTo={0.99} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
          <View style={{ backgroundColor: colors.paper, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Txt variant="tiny" tone="ink2" style={{ fontWeight: "700" }}>
              {p.done}/{p.total}
            </Txt>
          </View>
          <Txt variant="small" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
            {p.current ?? "Plan"}
          </Txt>
          <Chevron open={open} />
        </PressScale>
        {open && (
          <ScrollView style={{ maxHeight: 220 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 10, gap: 6 }}>
            {todos.map((t, i) => (
              <View key={`${i}-${t.content}`} accessibilityLabel={`${t.status === "completed" ? "Done" : t.status === "in_progress" ? "Doing" : "To do"}: ${t.content}`} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
                <Txt variant="small" tone={t.status === "completed" ? "go" : t.status === "in_progress" ? "cobalt" : "ink3"} style={{ width: 16, fontWeight: "700" }}>
                  {t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}
                </Txt>
                <Txt variant="small" tone={t.status === "completed" ? "ink3" : "ink"} style={{ flex: 1, textDecorationLine: t.status === "completed" ? "line-through" : "none" }}>
                  {t.status === "in_progress" ? t.active_form : t.content}
                </Txt>
              </View>
            ))}
          </ScrollView>
        )}
      </Glass>
    </FadeSlideIn>
  );
}

/** What can be typed after the "/": the matching commands and skills, one tap puts one in the message box. */
export function SlashPicker({ matches, onPick }: { matches: RemoteCommand[]; onPick: (command: RemoteCommand) => void }) {
  const colors = useColors();
  if (matches.length === 0) return null;
  return (
    <FadeSlideIn from={6} ms={140} style={{ marginHorizontal: 12, marginBottom: 6 }}>
      <Glass solid accessibilityLabel="Commands" lift={0.1} style={{ borderRadius: radius.inner, overflow: "hidden" }}>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 232 }}>
          {matches.map((c, i) => (
            <PressScale key={c.name} accessibilityRole="button" accessibilityLabel={`/${c.name}${c.description ? `, ${c.description}` : ""}`} onPress={() => onPick(c)} haptic="select" scaleTo={0.99} style={{ paddingVertical: 9, paddingHorizontal: 12, gap: 1, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.rule }}>
              <Txt variant="small" style={{ fontWeight: "700" }}>
                /{c.name}
                {c.argument_hint ? (
                  <Txt variant="small" tone="ink3">
                    {" "}
                    {c.argument_hint}
                  </Txt>
                ) : null}
              </Txt>
              {c.description ? (
                <Txt variant="tiny" tone="ink2" numberOfLines={1}>
                  {c.description}
                </Txt>
              ) : null}
            </PressScale>
          ))}
        </ScrollView>
      </Glass>
    </FadeSlideIn>
  );
}

/** How much of the subscription's five-hour window is used, as a bar with when it resets. */
export function UsageRow({ plan }: { plan: PlanUsage }) {
  const colors = useColors();
  const u = usageOf(plan);
  const fill = u.tone === "stop" ? colors.stop : u.tone === "warn" ? colors.hi : colors.go;
  return (
    <View accessibilityLabel={`Session: ${u.percent} percent of the five-hour window used. ${u.resets}`} style={{ backgroundColor: colors.wash, borderRadius: radius.inner, paddingVertical: 12, paddingHorizontal: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Txt variant="body" style={{ fontWeight: "700" }}>
          Session
        </Txt>
        <Txt variant="small" tone={u.tone === "stop" ? "stop" : "ink2"} style={{ fontWeight: "700" }}>
          {u.tone === "stop" ? "Limit reached" : `${u.percent}% used`}
        </Txt>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.rule, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(u.percent, 2)}%`, height: 6, backgroundColor: fill }} />
      </View>
      {u.resets !== "" && (
        <Txt variant="tiny" tone="ink2">
          Five-hour window · {u.resets.toLowerCase()}
        </Txt>
      )}
    </View>
  );
}

/** The weekly limit, as a bar with where the pace so far leads (when it runs out, or where the week ends up). */
export function WeekRow({ week }: { week: { used: number; resetsAt: number | null } }) {
  const colors = useColors();
  const w = weekOf(week);
  const fill = w.tone === "stop" ? colors.stop : w.tone === "warn" ? colors.hi : colors.go;
  return (
    <View accessibilityLabel={`Weekly limit: ${w.sentence}`} style={{ backgroundColor: colors.wash, borderRadius: radius.inner, paddingVertical: 12, paddingHorizontal: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Txt variant="body" style={{ fontWeight: "700" }}>
          Weekly limit
        </Txt>
        <Txt variant="small" tone={w.tone === "stop" ? "stop" : "ink2"} style={{ fontWeight: "700" }}>
          {w.tone === "stop" ? "Limit reached" : `${w.percent}% used`}
        </Txt>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.rule, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(w.percent, 2)}%`, height: 6, backgroundColor: fill }} />
      </View>
      <Txt variant="tiny" tone="ink2">
        {w.sentence.replace(/^\d+% of the weekly limit used\. /, "")}
      </Txt>
    </View>
  );
}

/** How full the chat's context is, as a bar with the tokens it holds. */
export function ContextRow({ context }: { context: { tokens: number; window: number | null } }) {
  const colors = useColors();
  const c = contextOf(context);
  const fill = c.tone === "stop" ? colors.stop : c.tone === "warn" ? colors.hi : colors.go;
  return (
    <View accessibilityLabel={`Context: ${c.label}`} style={{ backgroundColor: colors.wash, borderRadius: radius.inner, paddingVertical: 12, paddingHorizontal: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Txt variant="body" style={{ fontWeight: "700" }}>
          Context
        </Txt>
        <Txt variant="small" tone={c.tone === "stop" ? "stop" : "ink2"} style={{ fontWeight: "700" }}>
          {c.label}
        </Txt>
      </View>
      {c.percent !== null && (
        <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.rule, overflow: "hidden" }}>
          <View style={{ width: `${Math.max(c.percent, 2)}%`, height: 6, backgroundColor: fill }} />
        </View>
      )}
      <Txt variant="tiny" tone="ink2">
        {c.percent !== null && context.window ? `${shortTokens(context.tokens)} of ${shortTokens(context.window)} tokens. ` : ""}
        {c.tone === "ok" ? "Claude forgets the oldest of it when it fills." : "Nearly full: ask for a /compact, or start a new chat."}
      </Txt>
    </View>
  );
}

/** On Home: how much of the subscription's five-hour window is used, in a line with a thin bar under it. */
export function UsageStrip({ plan, onPress }: { plan: PlanUsage; /** Opens the usage in full (the chart). */ onPress?: () => void }) {
  const colors = useColors();
  const u = usageOf(plan);
  const fill = u.tone === "stop" ? colors.stop : u.tone === "warn" ? colors.hi : colors.go;
  return (
    <PressScale accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={`Session: ${u.percent} percent of the five-hour window used. ${u.resets}`} accessibilityHint={onPress ? "Opens the usage history" : undefined} accessible disabled={!onPress} onPress={onPress} haptic="select" scaleTo={0.98} style={{ marginHorizontal: space.xl, marginTop: 10, gap: 5 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Txt variant="tiny" tone={u.tone === "stop" ? "stop" : "ink2"} style={{ fontWeight: "700" }}>
          {u.tone === "stop" ? "Session limit reached" : `Session · ${u.percent}% used`}
        </Txt>
        {u.resets !== "" && (
          <Txt variant="tiny" tone="ink3">
            {u.resets}
          </Txt>
        )}
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.rule, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(u.percent, 2)}%`, height: 4, backgroundColor: fill }} />
      </View>
      {plan.week && <WeekStrip week={plan.week} />}
    </PressScale>
  );
}

/** The weekly limit under the five-hour one: how much is used, and where the pace so far leads. */
function WeekStrip({ week }: { week: { used: number; resetsAt: number | null } }) {
  const colors = useColors();
  const w = weekOf(week);
  const fill = w.tone === "stop" ? colors.stop : w.tone === "warn" ? colors.hi : colors.go;
  return (
    <View accessible accessibilityLabel={`Weekly limit: ${w.sentence}`} style={{ gap: 5, marginTop: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Txt variant="tiny" tone={w.tone === "stop" ? "stop" : "ink2"} style={{ fontWeight: "700" }}>
          {w.tone === "stop" ? "Weekly limit reached" : `Week · ${w.percent}% used`}
        </Txt>
        {w.short !== "" && (
          <Txt variant="tiny" tone={w.tone === "warn" ? "ink2" : "ink3"} style={w.tone === "warn" ? { fontWeight: "700" } : undefined}>
            {w.short}
          </Txt>
        )}
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.rule, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(w.percent, 2)}%`, height: 4, backgroundColor: fill }} />
      </View>
    </View>
  );
}

/** What a finished step printed, as a sheet of monospaced text (asked of the Mac when it opens). */
export function StepOutputSheet({ title, load, onClose }: { title: string; load: () => Promise<string>; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (text) => live && setState({ text }),
      (e: Error) => live && setState({ error: e.message || "That didn't come through." }),
    );
    return () => {
      live = false;
    };
    // Asked once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 10, maxHeight: "100%" }]}>
          <Txt variant="heading" accessibilityRole="header" numberOfLines={2}>
            {title}
          </Txt>
          {state === null ? (
            <View accessibilityLabel="Loading" accessibilityRole="progressbar" accessible style={{ paddingVertical: 16 }}>
              <Dots />
            </View>
          ) : "error" in state ? (
            <Txt variant="small" tone="ink2">
              {state.error}
            </Txt>
          ) : (
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingBottom: 4 }}>
              <Text selectable accessibilityLabel="What it printed" style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: colors.ink }}>
                {state.text.trim() === "" ? "It printed nothing." : state.text}
              </Text>
            </ScrollView>
          )}
          <Button label="Done" kind="ghost" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}

/** The height of the chat's scrolled position from its end, from a scroll event: how far from the latest message it is. */
export function distanceFromEnd(e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }): number {
  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
  return Math.max(0, contentSize.height - (contentOffset.y + layoutMeasurement.height));
}

/** Where a seed for the message box came from: a new one each time replaces nothing already typed unless it says so. */
export interface ComposeSeed {
  id: number;
  text: string;
  /** Add to what is typed (a quote), or replace it (an edit). */
  mode: "append" | "replace";
}

export function useSeed(seed: ComposeSeed | undefined, apply: (seed: ComposeSeed) => void) {
  const last = useRef(0);
  useEffect(() => {
    if (seed && seed.id !== last.current) {
      last.current = seed.id;
      apply(seed);
    }
  }, [seed, apply]);
}
