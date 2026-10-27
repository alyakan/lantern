import { memo, useEffect, useRef, useState, type ComponentRef } from "react";
import { Animated, Easing, Image, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Item } from "../sync/reducer";
import * as Clipboard from "expo-clipboard";
import { useAccent } from "../ui/accent";
import { Button, Chip, Tag, Txt } from "../ui/components";
import { useKeyboardUp } from "../ui/keyboard";
import type { RemoteCommand } from "../protocol/generated/RemoteCommand";
import { matchCommands, slashQuery } from "../view/slash";
import { loadDraft, saveDraft } from "../drafts";
import { commandOf, isTerminal, plainTyped } from "../view/shell";
import { term } from "../ui/terminal";
import { SlashPicker, useSeed, type ComposeSeed } from "./ChatExtras";
import { useListInput } from "../ui/useListInput";
import { useDictation } from "../ui/useDictation";
import { useAttachments } from "../ui/useAttachments";
import type { ImageSource } from "../platformImages";
import { MAX_IMAGES, photos, type PickedImage } from "../view/attachments";
import { Markdown } from "../ui/Markdown";
import { bounce, buzz, FadeSlideIn, PopIn, PressScale, skips } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { DiffSkeleton } from "../ui/skeleton";
import { SwipeToAllow } from "../ui/SwipeToAllow";
import { COMPOSER_FILL, Glass, useGlass } from "../ui/Glass";
import { fonts, radius, shadow, space, useColors } from "../ui/theme";
import { diffPreviewOf, fitsInline } from "../view/diffPreview";
import { approvalOf, promptView } from "../view/prompts";
import { DiffPreviewCard } from "./DiffPreviewCard";
import { MarkupSheet } from "./MarkupSheet";
import { turnLine, type Row, type StepChip } from "../view/timeline";
import type { PageAction } from "../view/pages";

/** How long after the last key a draft is written to the phone. */
export const DRAFT_SAVE_MS = 600;

/** "22:09": a message's time, in the phone's own way of writing it. */
export const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type UserItem = Extract<Item, { kind: "user" }>;

export const UserRow = memo(function UserRow({ item, onActions, queued = false }: { item: UserItem; /** Holding the message down: what can be done with it. */ onActions?: () => void; /** Sent while Claude was busy, and not acted on yet. */ queued?: boolean }) {
  const colors = useColors();
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12, alignItems: "flex-start" }}>
      {item.at !== null && (
        <Txt variant="tiny" tone="ink3" style={{ marginBottom: 4, marginLeft: 2 }}>
          {timeOf(item.at)}
        </Txt>
      )}
      <Pressable accessibilityLabel={`You: ${item.text}${item.images ? ` (${photos(item.images)})` : ""}`} accessibilityHint={onActions ? "Hold for copy, quote and more" : undefined} onLongPress={onActions} delayLongPress={350} style={{ backgroundColor: colors.ink, borderRadius: 18, borderBottomLeftRadius: 6, paddingHorizontal: 13, paddingVertical: 9, maxWidth: "90%", opacity: item.sending ? 0.6 : 1 }}>
        {/* The pictures themselves are only here on the phone that sent them (they went to Claude, not back): another time it is just how many. */}
        {!!item.thumbs?.length && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: item.text ? 8 : 0 }}>
            {item.thumbs.map((uri, i) => (
              <Image key={uri} accessibilityLabel={`Photo ${i + 1} you sent`} source={{ uri }} style={{ width: 88, height: 88, borderRadius: 10 }} />
            ))}
          </View>
        )}
        {!item.thumbs?.length && !!item.images && (
          <Txt variant="small" tone="on-ink" style={{ opacity: 0.8, marginBottom: item.text ? 6 : 0 }}>
            {photos(item.images)} sent
          </Txt>
        )}
        {/* Your own message is read as Claude's is: a list you typed is a list, code is code. */}
        {!!item.text && <Markdown text={item.text} tone="on-ink" selectable={!onActions} />}
      </Pressable>
      {item.failed && (
        <Txt variant="small" tone="stop" style={{ marginTop: 4, marginLeft: 2 }}>
          Not sent. {item.failed}
        </Txt>
      )}
      {queued && !item.failed && (
        <Txt variant="tiny" tone="ink3" accessibilityLabel="Queued: Claude reads it after this step" style={{ marginTop: 4, marginLeft: 2 }}>
          Queued · Claude reads it after this step
        </Txt>
      )}
    </View>
  );
});

/** How tall a summary card's text is before "Show all" (a long one is clipped to this). */
const SUMMARY_COLLAPSED = 230;

/**
 * What a turn did, as a card: the turn's closing message when it did real work (see summaryOf), with how long it took, what
 * it changed and ran as chips (the edits one lists their diffs), a Copy, and a long one clipped to a few lines with Show all.
 */
export const SummaryRow = memo(function SummaryRow({ row, onFiles, onActions }: { row: Extract<Row, { kind: "summary" }>; onFiles: (files: string[]) => void; onActions?: () => void }) {
  const colors = useColors();
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const long = height !== null && height > SUMMARY_COLLAPSED + 50;
  const clipped = long && !full;
  const took = row.durationMs ? turnLine({ kind: "turn", id: "", isError: false, result: null, durationMs: row.durationMs }).text.replace("Finished in ", "") : null;
  const copy = () => {
    void Promise.resolve(Clipboard.setStringAsync(row.item.text)).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <View accessibilityLabel="Summary of the work" style={[{ backgroundColor: colors.card, borderRadius: 20, overflow: "hidden", flexDirection: "row" }, shadow.card, { shadowOpacity: 0.07 }]}>
        <View accessibilityElementsHidden style={{ width: 4, backgroundColor: colors.go }} />
        <View style={{ flex: 1, padding: 14, gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View accessibilityElementsHidden style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.go, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 9, height: 5, marginTop: -2, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.white, transform: [{ rotate: "-45deg" }] }} />
            </View>
            <Txt variant="small" style={{ fontWeight: "700", flex: 1 }} accessibilityRole="header">
              Summary
            </Txt>
            {took && (
              <Txt variant="tiny" tone="ink3">
                {took}
              </Txt>
            )}
          </View>
          <Pressable onLongPress={onActions} delayLongPress={350} accessibilityHint={onActions ? "Hold for copy, quote and more" : undefined} style={{ maxHeight: clipped ? SUMMARY_COLLAPSED : undefined, overflow: "hidden" }}>
            <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
              <Markdown text={row.item.text} selectable={!onActions} />
            </View>
            {/* The cut is softened: strips of the card's own colour, more and more of it. */}
            {clipped && (
              <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 44 }}>
                {[0.25, 0.5, 0.75, 0.95].map((a) => (
                  <View key={a} style={{ flex: 1, backgroundColor: `${colors.card}${Math.round(a * 255).toString(16).padStart(2, "0")}` }} />
                ))}
              </View>
            )}
          </Pressable>
          {long && (
            <PressScale accessibilityRole="button" accessibilityLabel={full ? "Show less" : "Show all"} accessibilityState={{ expanded: full }} onPress={() => setFull(!full)} hitSlop={8} haptic="select" scaleTo={0.96} style={{ alignSelf: "flex-start" }}>
              <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
                {full ? "Show less" : "Show all"}
              </Txt>
            </PressScale>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {row.chips.map((c) => (
              <Chip key={c.key} tone={c.tone} onPress={c.files ? () => onFiles(c.files!) : undefined}>
                {c.label}
              </Chip>
            ))}
            <PressScale accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy summary"} onPress={copy} hitSlop={8} haptic="light" scaleTo={0.92} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
              <Txt variant="small" tone={copied ? "go" : "cobalt"} style={{ fontWeight: "700" }}>
                {copied ? "Copied" : "Copy"}
              </Txt>
            </PressScale>
          </View>
        </View>
      </View>
    </View>
  );
});

export const AssistantRow = memo(function AssistantRow({ item, onActions }: { item: Extract<Item, { kind: "assistant" }>; onActions?: () => void }) {
  return (
    <Pressable accessibilityHint={onActions ? "Hold for copy, quote and more" : undefined} onLongPress={onActions} delayLongPress={350} style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <Markdown text={item.text} selectable={!onActions} />
    </Pressable>
  );
});

export const StepsRow = memo(function StepsRow({ chips, onFiles, onOutput }: { chips: StepChip[]; onFiles: (files: string[]) => void; /** Present when the Mac can say what a step printed: a tap on one of a chip's lines asks. */ onOutput?: (step: { id: string; text: string }) => void }) {
  const colors = useColors();
  // A grouped chip ("Ran 5 commands") opens to what it stands for, one line each.
  const [open, setOpen] = useState<string | null>(null);
  const opened = chips.find((c) => c.key === open && c.items);
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 10, gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {chips.map((c) => (
          <Chip key={c.key} tone={c.tone} chevron={c.items ? (open === c.key ? "open" : "closed") : undefined} onPress={c.files ? () => onFiles(c.files!) : c.items ? () => setOpen(open === c.key ? null : c.key) : undefined}>
            {c.label}
          </Chip>
        ))}
      </View>
      {opened?.items && (
        <FadeSlideIn>
          <View accessibilityLabel={opened.label} style={{ backgroundColor: colors.card, borderColor: colors.rule, borderWidth: 1, borderRadius: radius.inner, padding: 10, gap: 6 }}>
            {opened.items.map((it, i) => {
              const line = (
                <Txt variant="mono" tone={it.bad ? "stop" : "ink2"} numberOfLines={3} style={{ fontSize: 12, lineHeight: 17 }}>
                  {it.text}
                </Txt>
              );
              // A step's output can be asked for only where the Mac sends it: not for a chip of "other tools".
              return onOutput && opened.key !== "other" ? (
                <Pressable key={i} accessibilityRole="button" accessibilityLabel={`${it.text}. See what it printed`} onPress={() => onOutput({ id: it.id, text: it.text })} hitSlop={4}>
                  {line}
                </Pressable>
              ) : (
                <View key={i}>{line}</View>
              );
            })}
          </View>
        </FadeSlideIn>
      )}
    </View>
  );
});

/** A Step-by-step page: its heading as a card, the start of it, and (while it is the live one) its buttons. */
export const PageRow = memo(function PageRow({ row, answered, onAction }: { row: Extract<Row, { kind: "page" }>; answered: boolean; onAction: (a: PageAction) => void }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const { page } = row;
  const body = open || page.body.length < 260 ? page.body : `${page.body.slice(0, 240).trimEnd()}…`;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <View style={[{ backgroundColor: colors.card, borderRadius: 18, padding: 14, gap: 6 }, shadow.card, { shadowOpacity: 0.06 }]}>
        <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
          {page.kicker}
        </Txt>
        <Txt variant="heading">{page.title}</Txt>
        {!!body && <Markdown text={body} />}
        {page.body.length >= 260 && (
          <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} hitSlop={8}>
            <Txt variant="small" tone="cobalt">
              {open ? "Show less" : "Show the whole page"}
            </Txt>
          </Pressable>
        )}
        {row.live && !answered && page.actions.length > 0 && (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
            {page.actions.map((a) => (
              <Button key={a.label} label={a.label} kind={a.primary ? "ink" : "ghost"} style={{ flex: 1 }} onPress={() => onAction(a)} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
});

/** Who answered a prompt, in words: you, the Mac, or another phone. */
export function answeredBy(by: string | null, me: string | null): string {
  if (by === "desktop") return "on your Mac";
  if (by && me && by === me) return "from this phone";
  if (by?.startsWith("phone-")) return "on another phone";
  return "";
}

/** The small card a decision leaves behind: a mark in its colour, what was asked, and how it went. */
function DecisionCard({ title, status, mark }: { title: string; status: string; mark: "check" | "cross" | "dash" }) {
  const colors = useColors();
  const color = mark === "check" ? colors.go : mark === "cross" ? colors.stop : colors.ink3;
  return (
    <View style={{ backgroundColor: colors.card, borderColor: colors.rule, borderWidth: 1, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
        {mark === "check" ? <View style={{ width: 10, height: 6, marginTop: -2, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.white, transform: [{ rotate: "-45deg" }] }} /> : mark === "cross" ? <Txt variant="small" tone="white" style={{ fontWeight: "800", lineHeight: 16 }}>×</Txt> : <View style={{ width: 10, height: 2, backgroundColor: colors.white }} />}
      </View>
      <View style={{ flex: 1 }}>
        <Txt variant="small" numberOfLines={1} style={{ fontWeight: "700" }}>
          {title}
        </Txt>
        <Txt variant="tiny" tone="ink2">
          {status}
        </Txt>
      </View>
    </View>
  );
}

/** How long the open card takes to close in to the card a decision leaves, and how long to wait for that card to be measured. */
const SETTLE_MS = 380;
const SETTLE_WAIT_MS = 600;

/**
 * What waits on you, in the chat. Something to allow can be allowed right here with a swipe (and "Expand" opens the full
 * screen: the whole command, and Deny); a question can't be swiped, so it opens the full screen to be answered.
 * `onAllow` rejects when the answer did not go; the bar then comes back fresh, for another try.
 *
 * Once it is decided, the card shrinks into a small one saying how it went (the open card is kept, fading, while it
 * does, so the swipe's check circle doesn't vanish); one that was already decided when the chat loaded is just the small card.
 */
export const PromptRow = memo(function PromptRow({ item, me, onReview, onAllow, onSwiping }: { item: Extract<Item, { kind: "prompt" }>; me: string | null; onReview: () => void; onAllow?: () => Promise<void>; /** Told when the swipe is being dragged: the chat holds still meanwhile. */ onSwiping?: (swiping: boolean) => void }) {
  const colors = useColors();
  const view = promptView(item.toolName, item.input);
  const [tries, setTries] = useState(0);
  const openHeight = useRef(0);
  const [settling, setSettling] = useState<{ from: number } | null>(null);
  const [last, setLast] = useState(item.state);
  const h = useRef(new Animated.Value(0)).current;
  const openOpacity = useRef(new Animated.Value(1)).current;
  const doneOpacity = useRef(new Animated.Value(0)).current;
  const started = useRef(false);
  // It was open and now isn't: close in, from the height it had (when it had been laid out, and motion is wanted).
  if (last !== item.state) {
    setLast(item.state);
    if (last === "open" && openHeight.current > 0 && !skips() && !(item.answer && item.state === "allowed")) {
      // From the very first frame it has the height the open card had.
      h.setValue(openHeight.current);
      setSettling({ from: openHeight.current });
    }
  }

  const finish = () => setSettling(null);
  // The small card's height is known once it has been laid out: then the open one closes in to it.
  const measured = (to: number) => {
    if (!settling || started.current) return;
    started.current = true;
    h.setValue(settling.from);
    Animated.parallel([
      Animated.timing(h, { toValue: to, duration: SETTLE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.timing(openOpacity, { toValue: 0, duration: 200, useNativeDriver: false }),
      Animated.timing(doneOpacity, { toValue: 1, duration: 260, delay: 120, useNativeDriver: false }),
    ]).start(({ finished }) => finished && finish());
  };
  // Never stuck: if the small card is not measured, or the animation is cut off, it ends all the same.
  useEffect(() => {
    if (!settling) {
      started.current = false;
      h.setValue(0);
      openOpacity.setValue(1);
      doneOpacity.setValue(0);
      return;
    }
    const t = setTimeout(finish, SETTLE_WAIT_MS + SETTLE_MS);
    return () => clearTimeout(t);
  }, [settling, h, openOpacity, doneOpacity]);

  const approval = approvalOf(item.toolName, item.input);
  // A file change is drawn in the card, and can only be swiped to allow here when all of it can be read here: a change that is cut
  // short, longer than the card shows, or "everywhere it appears" is opened to be read first.
  const preview = approval ? null : diffPreviewOf(item.toolName, item.input);
  const readHere = !preview || fitsInline(preview);
  const swipe = view.kind === "allow" && !!onAllow && readHere;
  const openCard = (
    <View style={{ backgroundColor: colors.hiSoft, borderColor: colors.hi, borderWidth: 1.5, borderRadius: 18, padding: 14, gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Tag>{view.tag}</Tag>
        {swipe && (
          <PressScale accessibilityRole="button" accessibilityLabel="Expand" accessibilityHint="Opens the whole decision" onPress={onReview} hitSlop={10} haptic="select" scaleTo={0.92} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 }}>
            <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
              Expand
            </Txt>
            <Txt variant="small" tone="cobalt" accessibilityElementsHidden style={{ fontWeight: "700" }}>
              ↗
            </Txt>
          </PressScale>
        )}
      </View>
      <Txt variant="heading">{view.title}</Txt>
      {view.detail && (
        <Txt variant="mono" numberOfLines={2}>
          {view.detail}
        </Txt>
      )}
      {preview && <DiffPreviewCard preview={preview} file={null} tone="paper" />}
      {preview && !readHere && (
        <Txt variant="small" tone="ink2" testID="read-first">
          This is more than fits here. Open it to read all of it before you decide.
        </Txt>
      )}
      {swipe ? (
        // Half the card's width, from the middle to the right edge, where the thumb is.
        <View style={{ marginTop: 8, width: "50%", alignSelf: "flex-end" }}>
          {/* A failed answer brings a fresh bar back (the key), not one that looks allowed; and a list cell reused for another prompt starts it afresh. */}
          <SwipeToAllow key={`${item.id}:${tries}`} compact onDrag={onSwiping} label={approval ? "Swipe to approve" : "Swipe to allow"} doneLabel={approval ? "Approved" : "Allowed"} onAllow={() => void onAllow().catch(() => setTries((t) => t + 1))} />
        </View>
      ) : (
        <Button label={preview ? "Review the change" : "Review"} style={{ marginTop: 6 }} onPress={onReview} />
      )}
    </View>
  );

  const status = item.state === "withdrawn" ? "Claude stopped asking" : `${item.state === "allowed" ? (view.kind === "question" ? "Answered" : "Allowed") : view.kind === "question" ? "Declined" : "Denied"} ${answeredBy(item.by, me)}`.trim();
  const doneCard = <DecisionCard title={view.title.replace(/\?$/, "")} status={status} mark={item.state === "allowed" ? "check" : item.state === "denied" ? "cross" : "dash"} />;

  if (item.state === "open" || settling) {
    const going = !!settling && item.state !== "open";
    return (
      <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
        <Animated.View style={going ? { height: h, overflow: "hidden" } : undefined}>
          <Animated.View
            pointerEvents={going ? "none" : "auto"}
            onLayout={(e) => {
              if (!going) openHeight.current = e.nativeEvent.layout.height;
            }}
            style={going ? { position: "absolute", left: 0, right: 0, top: 0, opacity: openOpacity } : undefined}
          >
            {openCard}
          </Animated.View>
          {going && (
            <Animated.View onLayout={(e) => measured(e.nativeEvent.layout.height)} style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: doneOpacity }}>
              {doneCard}
            </Animated.View>
          )}
        </Animated.View>
      </View>
    );
  }

  // A question this phone answered says with what, as a chip beneath it: the answer itself, not how it was sent.
  if (item.answer && item.state === "allowed") {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingTop: 10, alignItems: "flex-start", gap: 4 }}>
        <Txt variant="small" tone="ink2">
          {view.title.replace(/\?$/, "")}
        </Txt>
        {/* A long answer wraps inside the screen: the chip is never wider than the chat, and its words may shrink to fit beside the check. */}
        <PopIn style={{ maxWidth: "100%" }}>
          <View testID="answer-chip" style={{ backgroundColor: colors.card, borderColor: colors.go, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "100%" }}>
            <View accessibilityElementsHidden style={{ width: 10, height: 6, marginTop: -2, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.go, transform: [{ rotate: "-45deg" }] }} />
            <Txt variant="small" style={{ fontWeight: "700", flexShrink: 1 }}>
              {item.answer}
            </Txt>
          </View>
        </PopIn>
      </View>
    );
  }
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 10 }}>{doneCard}</View>
  );
});

export const DesktopRow = memo(function DesktopRow({ item }: { item: Extract<Item, { kind: "desktop" }> }) {
  const colors = useColors();
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 12 }}>
      <View style={{ backgroundColor: colors.card, borderColor: colors.rule, borderWidth: 1, borderRadius: 14, padding: 12, gap: 2 }}>
        <Txt variant="small" style={{ fontWeight: "700" }}>
          Answer this on your Mac
        </Txt>
        <Txt variant="small" tone="ink2">
          {item.what}
        </Txt>
      </View>
    </View>
  );
});

export const TurnRow = memo(function TurnRow({ item }: { item: Extract<Item, { kind: "turn" }> }) {
  const line = turnLine(item);
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: 8 }}>
      <Txt variant="tiny" tone={line.bad ? "stop" : "ink3"}>
        {line.text}
      </Txt>
    </View>
  );
});

/**
 * The message box: a capsule with a send button; typing and sending only while connected. With `onRun` a "!" at the start
 * turns it into a terminal, as on the Mac: the "!" goes, a prompt takes its place, and what is typed is a command for the
 * Mac to run. `onRun` says whether it ran (it asks first); the box is only emptied when it did.
 */
export function Composer({ onSend, onRun, canAttach, disabled, placeholder = "Message Claude", seed, commands = [], draftKey }: { /** A chat's slot: what is typed and not sent is kept for it on this phone, and put back when it is opened again. */ draftKey?: string; /** `images`: the pictures attached, when any (then `text` may be empty). */ onSend: (text: string, images?: PickedImage[]) => void; onRun?: (command: string) => Promise<boolean>; /** The Mac takes pictures: a + offers the photo library and the camera. */ canAttach?: boolean; disabled?: boolean; placeholder?: string; /** Words to put in the box (a quote, a message to edit): each new seed once. */ seed?: ComposeSeed; /** What claude offers after a "/": typing one offers the matches. */ commands?: RemoteCommand[] }) {
  const colors = useColors();
  // Over a list that runs under it, the box has no ground of its own.
  const glass = useGlass();
  const [text, setText] = useState("");
  // The draft kept for this chat is put back once read (never over words typed meanwhile), and kept as it changes.
  const [draftRead, setDraftRead] = useState(!draftKey);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!draftKey) return;
    let live = true;
    void loadDraft(draftKey).then((d) => {
      if (!live) return;
      if (d) setText((t) => (t === "" ? d : t));
      setDraftRead(true);
    });
    return () => {
      live = false;
    };
  }, [draftKey]);
  useEffect(() => {
    if (!draftKey || !draftRead) return;
    const t = setTimeout(() => void saveDraft(draftKey, text), text === "" ? 0 : DRAFT_SAVE_MS);
    return () => clearTimeout(t);
  }, [draftKey, draftRead, text]);
  // Leaving the chat inside that pause still keeps what was typed.
  const read = useRef(draftRead);
  read.current = draftRead;
  useEffect(
    () => () => {
      if (draftKey && read.current) void saveDraft(draftKey, latest.current);
    },
    [draftKey],
  );
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const termInput = useRef<ComponentRef<typeof TextInput>>(null);
  // Terminal mode: the box starts with "!" (the "!" itself isn't shown), and the Mac can run commands.
  const terminal = !!onRun && isTerminal(text);
  const command = commandOf(text);
  const [running, setRunning] = useState(false);
  const wasTerminal = useRef(false);
  const dictation = useDictation(text, setText);
  const attach = useAttachments();
  // The picker is a screen of its own: it is launched once the sheet that offered it has gone (iOS can't show one over the other).
  const [choosing, setChoosing] = useState(false);
  // The photo being drawn on.
  const [marking, setMarking] = useState<PickedImage | null>(null);
  const chosen = useRef<ImageSource | null>(null);
  useEffect(() => {
    if (choosing || !chosen.current) return;
    const source = chosen.current;
    chosen.current = null;
    const t = setTimeout(() => void attach.add(source), 350);
    return () => clearTimeout(t);
  }, [choosing, attach.add]);
  // A "!" that begins the box (typed, or a quote) makes it a terminal, and the microphone has no place in one; nor does
  // a box that can't be used (the Mac went away): its button is gone, so nothing could stop it.
  useEffect(() => {
    if (terminal || disabled) dictation.cancel();
  }, [terminal, disabled, dictation.cancel]);
  // The keyboard stays up across the change, in whichever box is there.
  useEffect(() => {
    if (terminal) termInput.current?.focus();
    else if (wasTerminal.current) input.current?.focus();
    wasTerminal.current = terminal;
  }, [terminal]);
  const run = async () => {
    const typed = command.trim();
    if (!onRun || !typed || running || disabled) return;
    setRunning(true);
    try {
      if (await onRun(typed)) setText("");
    } finally {
      setRunning(false);
    }
  };
  useSeed(seed, (s) => {
    dictation.cancel();
    setText((t) => (s.mode === "append" && t.trim() ? `${t}\n${s.text}` : s.text));
    input.current?.focus();
  });
  const insets = useSafeAreaInsets();
  // With the keyboard up it sits right under the box: the home-indicator space would be a gap.
  const keyboard = useKeyboardUp();
  const ready = (text.trim().length > 0 || attach.images.length > 0) && !disabled && !attach.busy;
  const problem = dictation.problem ?? attach.problem;
  // Return after "1. item" starts "2. ", after "- item" starts "- ".
  const list = useListInput(text, setText);
  const query = slashQuery(text);
  const matches = query === null || commands.length === 0 ? [] : matchCommands(commands, query);
  return (
    <View style={{ paddingTop: 8, paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 12), backgroundColor: glass ? "transparent" : colors.paper }}>
      <SlashPicker
        matches={matches}
        onPick={(c) => {
          setText(`/${c.name} `);
          input.current?.focus();
        }}
      />
      <View style={{ paddingHorizontal: 12 }}>
      {terminal ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 22, borderWidth: 1, borderColor: term.line, backgroundColor: term.bg, paddingLeft: 16, paddingRight: 6, paddingVertical: 6 }}>
            <Text accessibilityElementsHidden style={{ color: term.bright, fontFamily: fonts.mono, fontSize: 16 }}>
              ›
            </Text>
            <TextInput
              ref={termInput}
              accessibilityLabel="Shell command"
              value={command}
              // The "!" stays in what is kept (it is what says this is a terminal) but is not shown, and the keyboard's smart
              // punctuation is undone: a shell reads "--" and straight quotes.
              onChangeText={(v) => setText(`!${plainTyped(v.replace(/\n/g, ""))}`)}
              onKeyPress={(e) => {
                // Backspace in an empty terminal leaves it, taking the "!" away.
                if (e.nativeEvent.key === "Backspace" && command === "") setText("");
              }}
              onSubmitEditing={() => void run()}
              returnKeyType="go"
              blurOnSubmit={false}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              keyboardType="ascii-capable"
              placeholder="command"
              placeholderTextColor={term.dim}
              editable={!disabled && !running}
              style={{ flex: 1, minHeight: 36, color: term.hi, fontFamily: fonts.mono, fontSize: 15, paddingVertical: 8 }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Run"
              accessibilityState={{ disabled: !command.trim() || running || !!disabled }}
              disabled={!command.trim() || running || !!disabled}
              onPress={() => void run()}
              style={{ height: 36, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: command.trim() && !running && !disabled ? term.bright : term.field, justifyContent: "center" }}
            >
              <Text style={{ color: command.trim() && !running && !disabled ? term.bg : term.dim, fontFamily: fonts.mono, fontSize: 13, fontWeight: "700" }}>{running ? "…" : "Run"}</Text>
            </Pressable>
          </View>
          <Txt variant="tiny" tone="ink3" style={{ marginTop: 6, marginLeft: 8, fontFamily: fonts.mono }}>
            Runs on your Mac, outside Claude · backspace to leave
          </Txt>
        </>
      ) : (
      <>
      {problem && (
        <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6, marginHorizontal: 8 }}>
          <Txt variant="tiny" tone="stop" style={{ flex: 1 }}>
            {problem.words}
          </Txt>
          {problem.settings && (
            <PressScale accessibilityRole="button" accessibilityLabel="Open Settings" onPress={() => void Linking.openSettings()} hitSlop={8} haptic="select" scaleTo={0.94}>
              <Txt variant="small" tone="cobalt" style={{ fontWeight: "700" }}>
                Open Settings
              </Txt>
            </PressScale>
          )}
          <PressScale
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={() => {
              dictation.dismiss();
              attach.dismiss();
            }}
            hitSlop={8}
            haptic="none"
            scaleTo={0.9}
          >
            <Txt variant="small" tone="ink3">
              ×
            </Txt>
          </PressScale>
        </View>
      )}
      {attach.images.length > 0 && <Thumbnails images={attach.images} onRemove={attach.remove} onMarkUp={setMarking} />}
      <Glass lift={0.12} fill={COMPOSER_FILL} style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, borderRadius: 26, paddingLeft: canAttach ? 4 : 16, paddingRight: 6, paddingVertical: 6 }}>
        {canAttach && <PlusButton busy={attach.busy} full={attach.full} onPress={() => setChoosing(true)} />}
        <TextInput
          ref={input}
          accessibilityLabel="Message"
          value={text}
          {...list}
          // Typing by hand takes over from the microphone.
          onChangeText={(v) => {
            dictation.edited();
            list.onChangeText(v);
          }}
          placeholder={dictation.listening ? "Listening…" : placeholder}
          placeholderTextColor={colors.ink3}
          multiline
          editable={!disabled}
          style={{ flex: 1, maxHeight: 120, minHeight: 36, fontSize: 15, color: colors.ink, paddingTop: 8, paddingBottom: 8 }}
        />
        {dictation.available && !disabled && <MicButton listening={dictation.listening} onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())} />}
        <SendButton
          ready={ready}
          onPress={() => {
            dictation.cancel();
            onSend(text.trim(), attach.images.length > 0 ? attach.images : undefined);
            attach.clear();
            setText("");
          }}
        />
      </Glass>
      {marking && <MarkupSheet image={marking} onDone={(marked) => attach.replace(marking.id, marked)} onClose={() => setMarking(null)} />}
      {choosing && (
        <AttachSheet
          onClose={() => setChoosing(false)}
          onPick={(source) => {
            chosen.current = source;
          }}
        />
      )}
      </>
      )}
      </View>
    </View>
  );
}

/**
 * The send button: grey until there is something to send, then it takes its colour with a little spring; pressing it
 * sends the arrow up and out, and a fresh one rises into place.
 */
function SendButton({ ready, onPress }: { ready: boolean; onPress: () => void }) {
  const colors = useColors();
  const accent = useAccent();
  const tint = useRef(new Animated.Value(ready ? 1 : 0)).current;
  const spring = useRef(new Animated.Value(1)).current;
  const fly = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (skips()) tint.setValue(ready ? 1 : 0);
    else Animated.timing(tint, { toValue: ready ? 1 : 0, duration: 180, useNativeDriver: false }).start();
    // Becoming ready is a small event: the button pops.
    if (!first.current && ready) {
      spring.setValue(0.8);
      bounce(spring, 1, { bounciness: 18 });
    }
    first.current = false;
  }, [ready, tint, spring]);
  const send = () => {
    buzz("light");
    if (!skips()) {
      Animated.sequence([
        Animated.timing(fly, { toValue: 1, duration: 130, useNativeDriver: true }),
        Animated.timing(fly, { toValue: -1, duration: 0, useNativeDriver: true }),
        Animated.timing(fly, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    onPress();
  };
  return (
    <Animated.View style={{ transform: [{ scale: spring }] }}>
      <PressScale accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !ready }} disabled={!ready} onPress={send} haptic="none" scaleTo={0.88} style={{ width: 40, height: 40, borderRadius: 20, overflow: "hidden" }}>
        <Animated.View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: tint.interpolate({ inputRange: [0, 1], outputRange: [colors.rule, accent] }) }}>
          <Animated.View style={{ opacity: fly.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0] }), transform: [{ translateY: fly.interpolate({ inputRange: [-1, 0, 1], outputRange: [22, 0, -22] }) }] }}>
            <Txt variant="heading" tone={colors.isDark ? "on-ink" : "white"}>
              ↑
            </Txt>
          </Animated.View>
        </Animated.View>
      </PressScale>
    </Animated.View>
  );
}

/**
 * The microphone button, beside Send: a drawn microphone; while it listens it is red with a stop square and a halo that
 * breathes (not for someone who has asked for less motion).
 */
function MicButton({ listening, onPress }: { listening: boolean; onPress: () => void }) {
  const colors = useColors();
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!listening || skips()) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, breath]);
  const ink = colors.ink2;
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={listening ? "Stop dictating" : "Dictate"} accessibilityState={{ selected: listening }} onPress={onPress} haptic="light" scaleTo={0.88} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
      {listening && <Animated.View pointerEvents="none" style={{ position: "absolute", width: 40, height: 40, borderRadius: 20, backgroundColor: colors.stop, opacity: breath.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.32] }) }} />}
      <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: listening ? colors.stop : "transparent" }}>
        {listening ? (
          <View accessibilityElementsHidden style={{ width: 11, height: 11, borderRadius: 3, backgroundColor: colors.white }} />
        ) : (
          <View accessibilityElementsHidden style={{ alignItems: "center" }}>
            <View style={{ width: 9, height: 14, borderRadius: 5, borderWidth: 2, borderColor: ink }} />
            <View style={{ width: 15, height: 8, marginTop: -6, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, borderWidth: 2, borderTopWidth: 0, borderColor: ink }} />
            <View style={{ width: 2, height: 3, backgroundColor: ink }} />
          </View>
        )}
      </View>
    </PressScale>
  );
}

/** The + beside the message box: it offers pictures to attach, and is dimmed while one is being fetched or when no more fit. */
function PlusButton({ busy, full, onPress }: { busy: boolean; full: boolean; onPress: () => void }) {
  const colors = useColors();
  const off = busy || full;
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel="Attach photos"
      accessibilityHint={full ? `A message holds ${MAX_IMAGES} photos at most` : undefined}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      haptic="light"
      scaleTo={0.88}
      opacity={off ? 0.4 : 1}
      style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
    >
      <View accessibilityElementsHidden style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: colors.ink2, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: 12, height: 2, borderRadius: 1, backgroundColor: colors.ink2 }} />
        <View style={{ position: "absolute", width: 2, height: 12, borderRadius: 1, backgroundColor: colors.ink2 }} />
      </View>
    </PressScale>
  );
}

/** The pictures attached so far, as small squares above the box, each with a × that takes it off. */
function Thumbnails({ images, onRemove, onMarkUp }: { images: PickedImage[]; onRemove: (id: string) => void; /** Opens the photo to draw on. */ onMarkUp: (image: PickedImage) => void }) {
  const colors = useColors();
  return (
    <ScrollView horizontal accessibilityLabel="Attached photos" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 10 }} style={{ flexGrow: 0 }}>
      {images.map((image, i) => (
        <View key={image.id} style={{ width: 64, height: 64 }}>
          <Image accessibilityLabel={`Photo ${i + 1}`} source={{ uri: image.uri }} style={{ width: 64, height: 64, borderRadius: 12, backgroundColor: colors.rule }} />
          <PressScale accessibilityRole="button" accessibilityLabel={`Mark up photo ${i + 1}`} accessibilityHint="Draw on it before it is sent" onPress={() => onMarkUp(image)} hitSlop={6} haptic="select" scaleTo={0.9} style={{ position: "absolute", left: 4, bottom: 4, height: 22, paddingHorizontal: 7, borderRadius: 11, backgroundColor: colors.ink, justifyContent: "center" }}>
            <Txt variant="tiny" tone="on-ink" style={{ fontWeight: "800" }}>
              ✎
            </Txt>
          </PressScale>
          <PressScale accessibilityRole="button" accessibilityLabel={`Remove photo ${i + 1}`} onPress={() => onRemove(image.id)} hitSlop={8} haptic="light" scaleTo={0.9} style={{ position: "absolute", top: -7, right: -7, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" }}>
            <Txt variant="small" tone="on-ink" style={{ fontWeight: "800", lineHeight: 16 }}>
              ×
            </Txt>
          </PressScale>
        </View>
      ))}
    </ScrollView>
  );
}

/** Where to get the pictures from. Choosing closes the sheet; the Composer then opens the picker (see its `choosing`). */
function AttachSheet({ onClose, onPick }: { onClose: () => void; onPick: (source: ImageSource) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.lg, paddingBottom: insets.bottom + space.lg, gap: 10 }}>
          <Txt variant="heading">Add photos</Txt>
          <Txt variant="small" tone="ink2">
            They go to Claude with your message, up to {MAX_IMAGES}.
          </Txt>
          <Button
            label="Photo library"
            onPress={() => {
              onPick("library");
              close();
            }}
          />
          <Button
            label="Take a photo"
            onPress={() => {
              onPick("camera");
              close();
            }}
          />
          <Button label="Cancel" kind="ghost" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}

/** A file's diff, as a sheet: pick one of the files an edit chip stands for, and read its lines. */
export function DiffSheet({ files, load, onClose }: { files: string[]; load: (path: string) => Promise<string>; onClose: () => void }) {
  const colors = useColors();
  const [path, setPath] = useState(files[0]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    load(path).then(
      (t) => live && setText(t),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [path, load]);
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ flexShrink: 1, backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: insets.bottom + 8 }}>
          <View style={{ padding: space.lg, gap: 8 }}>
            <Txt variant="heading">What changed</Txt>
            {files.length > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {files.map((f) => (
                  <Chip key={f} tone={f === path ? "ok" : "plain"} onPress={() => setPath(f)}>
                    {f.split("/").pop() ?? f}
                  </Chip>
                ))}
              </ScrollView>
            )}
            <Txt variant="small" tone="ink2" numberOfLines={1}>
              {path}
            </Txt>
          </View>
          <ScrollView style={{ flexShrink: 1, paddingHorizontal: space.lg }}>
            {text === null && !error && <DiffSkeleton />}
            {error && <Txt tone="stop">{error}</Txt>}
            {text !== null &&
              text.split("\n").map((line, i) => (
                <Txt key={i} variant="mono" style={{ fontFamily: fonts.mono, color: line.startsWith("+") && !line.startsWith("+++") ? colors.go : line.startsWith("-") && !line.startsWith("---") ? colors.stop : colors.ink2 }}>
                  {line || " "}
                </Txt>
              ))}
          </ScrollView>
          <View style={{ padding: space.lg }}>
            <Button label="Close" kind="ghost" onPress={close} />
          </View>
        </View>
      )}
    </Sheet>
  );
}
