import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, TextInput, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteDeskCard } from "../protocol/generated/RemoteDeskCard";
import type { RemoteDeskInfo } from "../protocol/generated/RemoteDeskInfo";
import type { RemoteDeskRoute } from "../protocol/generated/RemoteDeskRoute";
import { loadDeskLog, saveDeskLog } from "../deskLog";
import { useController, useSyncState } from "../shell/hooks";
import { Chip, Txt } from "../ui/components";
import { AboveKeyboard, barRoom } from "../ui/keyboard";
import { FadeSlideIn, PressScale } from "../ui/motion";
import { Dots } from "../ui/skeleton";
import { Markdown } from "../ui/Markdown";
import { radius, space, useColors } from "../ui/theme";
import { ago, cards } from "../view/home";
import { answerShape, cantSend, chatName, clip, deskHistory, deskShown, finished, firstSentence, LOG_MAX, replyCheck, waitingBy, type AnswerPart, type DeskEntry, type DeskOutcome, type DeskReply } from "../view/desk";
import { Deck } from "./NeedsDeck";

export interface DeskProps {
  /** Above the Desk: Home's top on a phone (the Mac's name, the Desk or Chats switch), the Desk's own header on a tablet. */
  top: ReactNode;
  onOpenChat: (slot: string) => void;
  onReview: (slot: string, requestId: string) => void;
  /**
   * A tablet's main area: the conversation in the middle, and what needs you and what just finished in a panel at the right. A
   * phone has them over the conversation, what needs you pinned at the top.
   */
  wide?: boolean;
}

const newId = () => `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** How many finished answers show before "Show more". */
const FINISHED_SHOWN = 3;
/** The widest the conversation reads on a tablet, and the panel beside it. */
const TALK_MAX = 640;
const PANEL_WIDTH = 360;

/** The answers that finished on this Desk, one quiet line each, newest first: a few, the rest on asking. A line opens its chat. */
function JustFinished({ list, onOpen }: { list: RemoteDeskCard[]; onOpen: (slot: string) => void }) {
  const colors = useColors();
  const [all, setAll] = useState(false);
  if (list.length === 0) return null;
  const shown = all ? list : list.slice(0, FINISHED_SHOWN);
  const now = Date.now();
  return (
    <View accessibilityLabel="Just finished" style={{ gap: 2 }}>
      <Txt variant="small" tone="ink3" style={{ fontWeight: "700", marginBottom: 4 }}>
        Just finished
      </Txt>
      {shown.map((c) => {
        const bad = c.outcome !== "done";
        const line = c.said ? firstSentence(c.said) : c.outcome === "failed" ? "Failed" : c.outcome === "stopped" ? "Stopped" : "";
        return (
          <PressScale key={c.key} accessibilityRole="button" accessibilityLabel={`${c.title}: ${c.said || c.asked}`} accessibilityHint="Opens the chat" onPress={() => onOpen(c.slot)} scaleTo={0.98} style={{ flexDirection: "row", alignItems: "baseline", gap: 10, paddingVertical: 7 }}>
            <Txt variant="small" style={{ fontWeight: "700", color: bad ? colors.stop : colors.go, width: 14 }}>
              {c.outcome === "done" ? "✓" : c.outcome === "failed" ? "✕" : "■"}
            </Txt>
            <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flex: 1 }}>
              <Txt variant="small" style={{ fontWeight: "700" }}>
                {c.title}
              </Txt>
              {line ? <Txt variant="small" tone={bad ? "stop" : "ink2"}>{`: ${line}`}</Txt> : null}
            </Txt>
            {c.at !== null && (
              <Txt variant="tiny" tone="ink3">
                {ago(c.at, now)}
              </Txt>
            )}
          </PressScale>
        );
      })}
      {list.length > FINISHED_SHOWN && (
        <PressScale accessibilityRole="button" onPress={() => setAll(!all)} hitSlop={8} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
          <Txt variant="small" tone="cobalt" style={{ fontWeight: "600" }}>
            {all ? "Show fewer" : `Show ${list.length - FINISHED_SHOWN} more`}
          </Txt>
        </PressScale>
      )}
    </View>
  );
}

/** What came back from the chat a message went to: a sentence or two, the whole answer on asking (until the app closes), the chat. */
function Reply({ reply, slot, onOpen }: { reply: DeskReply; slot: string; onOpen: (slot: string) => void }) {
  const colors = useColors();
  const [full, setFull] = useState(false);
  if (reply.status === "waiting") {
    return (
      <View accessibilityLabel="Working on it" accessible style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingLeft: 12 }}>
        <Dots />
        <Txt variant="small" tone="ink2">
          Working on it
        </Txt>
      </View>
    );
  }
  const bad = (reply.status === "done" && reply.failed) || reply.status === "failed";
  const text =
    reply.status === "done"
      ? `${reply.failed ? "Failed: " : ""}${reply.summary}`
      : reply.status === "failed"
        ? `Finished. ${reply.why}`
        : reply.status === "off"
          ? "Finished. It runs on another provider, so the Desk doesn't read it: open the chat to see what it said."
          : "Your Mac restarted before it came back: open the chat to see it.";
  const whole = reply.status === "done" || reply.status === "failed" ? reply.full : undefined;
  return (
    <View accessibilityLabel="What came back" style={{ alignSelf: "stretch", backgroundColor: colors.card, borderRadius: radius.inner, borderLeftWidth: 3, borderLeftColor: bad ? colors.stop : colors.go, padding: 12, gap: 8, marginRight: 24 }}>
      <Txt variant="body" tone={reply.status === "done" ? "ink" : "ink2"}>
        {text}
      </Txt>
      {full && !!whole && <Markdown text={whole} />}
      <View style={{ flexDirection: "row", gap: 6 }}>
        {!!whole && <Chip onPress={() => setFull(!full)}>{full ? "Hide full answer" : "Show full answer"}</Chip>}
        <Chip onPress={() => onOpen(slot)}>Open chat</Chip>
      </View>
    </View>
  );
}

const PART_NAME: Record<AnswerPart, string> = { done: "Done", open: "Open", blocked: "Blocked" };

/** The Desk's own answer to how something stands: the sentence that answers, then Done / Open / Blocked, then the chats it read. */
function Answered({ outcome, onOpen }: { outcome: Extract<DeskOutcome, { kind: "answer" }>; onOpen: (slot: string) => void }) {
  const colors = useColors();
  if (outcome.sources.length === 0 && !outcome.error) {
    return (
      <Txt variant="small" tone="ink2" style={{ alignSelf: "flex-start" }}>
        No chat on this Desk talks about "{outcome.terms}".
      </Txt>
    );
  }
  const shape = outcome.text ? answerShape(outcome.text) : null;
  const tint: Record<AnswerPart, string> = { done: colors.go, open: colors.ink2, blocked: colors.stop };
  return (
    <View style={{ alignSelf: "stretch", backgroundColor: colors.card, borderRadius: radius.inner, padding: 14, gap: 10, marginRight: 24 }}>
      {shape ? (
        <>
          <Txt variant="heading">{shape.lead}</Txt>
          {shape.parts.map(({ part, points }) => (
            <View key={part} style={{ flexDirection: "row", gap: 10 }}>
              <Txt variant="small" style={{ fontWeight: "700", color: tint[part], width: 64 }}>
                {PART_NAME[part]}
              </Txt>
              <View style={{ flex: 1, gap: 3 }}>
                {points.map((pt, i) => (
                  <Txt key={i} variant="small">
                    {pt}
                  </Txt>
                ))}
              </View>
            </View>
          ))}
        </>
      ) : outcome.text ? (
        <Markdown text={outcome.text} />
      ) : (
        <Txt variant="small" tone="stop">
          {outcome.error ?? "No answer came."}
        </Txt>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {outcome.sources.map((h, i) => (
          <Chip key={i} onPress={h.slot ? () => onOpen(h.slot!) : undefined}>
            {`${i + 1} ${clip(h.title || "A chat", 32)}${h.slot ? "" : " · on your Mac"}`}
          </Chip>
        ))}
      </View>
    </View>
  );
}

function Found({ outcome, onOpen }: { outcome: Extract<DeskOutcome, { kind: "search" }>; onOpen: (slot: string) => void }) {
  const colors = useColors();
  if (outcome.failed) {
    return (
      <Txt variant="small" tone="stop">
        Couldn't search your chats for "{outcome.terms}".
      </Txt>
    );
  }
  return (
    <View style={{ alignSelf: "stretch", backgroundColor: colors.card, borderRadius: radius.inner, padding: 12, gap: 10, marginRight: 24 }}>
      <Txt variant="small" tone="ink2">
        {outcome.hits.length === 0 ? `No chat on this Desk says "${outcome.terms}".` : `Chats that say "${outcome.terms}"`}
      </Txt>
      {outcome.hits.map((h, i) => (
        <PressScale key={i} disabled={!h.slot} accessibilityRole={h.slot ? "button" : undefined} accessibilityHint={h.slot ? "Opens the chat" : undefined} onPress={() => h.slot && onOpen(h.slot)} scaleTo={0.98} style={{ gap: 2 }}>
          <Txt variant="small" style={{ fontWeight: "700" }} numberOfLines={1}>
            {h.title || "A chat"}
          </Txt>
          <Txt variant="tiny" tone="ink3">
            {h.project} · {ago(h.updated_ms, Date.now())}
            {h.slot ? " · open" : " · on your Mac"}
          </Txt>
          {!!h.snippet && (
            <Txt variant="small" tone="ink2" numberOfLines={2}>
              {h.snippet}
            </Txt>
          )}
        </PressScale>
      ))}
    </View>
  );
}

/** A message typed on the Desk: your words, what the Desk said back, where they went (or its question, or what it found), and what came back. */
function Entry({ entry, desk, onOpen, onSendTo, onStartIn }: { entry: DeskEntry; desk: RemoteDeskInfo | null; onOpen: (slot: string) => void; onSendTo: (slot: string) => void; onStartIn: (folder: string) => void }) {
  const colors = useColors();
  const { chats } = useSyncState();
  const o = entry.outcome;
  return (
    <View accessibilityLabel={`You on the Desk: ${entry.text}`} style={{ gap: 6, alignItems: "flex-end" }}>
      <View style={{ backgroundColor: colors.ink, borderRadius: radius.inner, paddingHorizontal: 14, paddingVertical: 10, marginLeft: 48 }}>
        <Txt variant="body" tone="on-ink" numberOfLines={8}>
          {entry.text}
        </Txt>
      </View>
      {!!entry.say && (
        <View style={{ alignSelf: "flex-start", backgroundColor: colors.card, borderRadius: radius.inner, paddingHorizontal: 14, paddingVertical: 10, marginRight: 48 }}>
          <Txt variant="body">{entry.say}</Txt>
        </View>
      )}
      {o.kind === "routing" && (
        <View accessibilityLabel="Thinking" accessible style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start" }}>
          <Dots />
          <Txt variant="small" tone="ink2">
            Thinking
          </Txt>
        </View>
      )}
      {o.kind === "sent" && (
        <PressScale accessibilityRole="button" accessibilityHint="Opens the chat" onPress={() => onOpen(o.slot)} hitSlop={8} haptic="select">
          <Txt variant="small" tone="ink2">
            {o.started ? "Started " : o.queued ? "Queued in " : "Sent to "}
            <Txt variant="small" style={{ fontWeight: "700" }}>
              {o.title}
            </Txt>
          </Txt>
        </PressScale>
      )}
      {o.kind === "failed" && (
        <Txt variant="small" tone="stop" style={{ textAlign: "right" }}>
          {o.why}
        </Txt>
      )}
      {o.kind === "ask" && <Ask outcome={o} desk={desk} chats={chats} said={!!entry.say} onSendTo={onSendTo} onStartIn={onStartIn} />}
      {o.kind === "search" && <Found outcome={o} onOpen={onOpen} />}
      {o.kind === "answer" && <Answered outcome={o} onOpen={onOpen} />}
      {o.kind === "sent" && entry.reply && <Reply reply={entry.reply} slot={o.slot} onOpen={onOpen} />}
    </View>
  );
}

function Ask({ outcome, desk, chats, said, onSendTo, onStartIn }: { outcome: Extract<DeskOutcome, { kind: "ask" }>; desk: RemoteDeskInfo | null; chats: ReturnType<typeof useSyncState>["chats"]; said: boolean; onSendTo: (slot: string) => void; onStartIn: (folder: string) => void }) {
  const offerNew = outcome.unsure || outcome.slots.length === 0;
  return (
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      {/* What the Desk said already asks, when it said something. */}
      {!said && (
        <Txt variant="small" tone="ink2">
          {outcome.slots.length > 0 ? "Which chat is it for?" : "Start a chat for it?"}
        </Txt>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
        {outcome.slots.map((slot) => (
          <Chip key={slot} onPress={() => onSendTo(slot)}>
            {clip(chatName(chats, slot), 40)}
          </Chip>
        ))}
        {offerNew &&
          (desk?.projects ?? []).slice(0, 4).map((p) => (
            <Chip key={p.id} onPress={() => onStartIn(p.id)}>
              {`+ New in ${p.name}`}
            </Chip>
          ))}
      </View>
    </View>
  );
}

/**
 * The Desk, calm. What waits on you is first, one thing at a time (pinned at the top on a phone, in the panel at the right on a
 * tablet); the answers that just finished are one quiet line each; then the conversation with the Desk: what you said, what it said
 * back (a Mac whose Desk talks), where it went, and what came back from that chat, summed up. The chats themselves are on Home's list.
 */
export function DeskScreen({ top, onOpenChat, onReview, wide = false }: DeskProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  const { chats, desk, waiting, epoch, single } = useSyncState();
  // The Mac's One project: what needs you, what just finished and the Desks' counts are only its chats' (a finished card of a chat
  // closed since is its project's by name). The conversation is the user's own, and stays.
  const ofSingle = (slot: string, project?: string) => !single || chats.some((c) => c.slot === slot && c.project === single.name) || project === single.name;
  const [chosen, setChosen] = useState<string | null>(null);
  const [entries, setEntries] = useState<DeskEntry[]>([]);
  const [text, setText] = useState("");
  const read = useRef(false);
  useEffect(() => {
    let live = true;
    void loadDeskLog().then((kept) => {
      if (!live) return;
      read.current = true;
      setEntries((now) => [...kept.filter((k) => !now.some((n) => n.id === k.id)), ...now].slice(-LOG_MAX));
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (read.current) void saveDeskLog(entries);
  }, [entries]);
  // The chats as they are when the Mac answers, not as they were when the message was typed.
  const chatsNow = useRef(chats);
  chatsNow.current = chats;
  const talks = sync.deskTalks();

  const shown = deskShown(desk, chosen);
  const mine = shown ? entries.filter((e) => e.desk === shown.id).sort((a, b) => a.at - b.at) : [];
  const done = shown ? finished(desk, shown.id, entries).filter((c) => ofSingle(c.slot, c.project)) : [];
  const needs = shown ? cards(waiting, chats).filter((c) => shown.slots.includes(c.waiting.slot) && ofSingle(c.waiting.slot)) : [];
  const waits = waitingBy(desk, single ? chats.filter((c) => c.project === single.name) : chats);

  const edit = (id: string, change: (e: DeskEntry) => DeskEntry) => setEntries((all) => all.map((e) => (e.id === id ? change(e) : e)));
  const outcome = (id: string, o: DeskOutcome) => edit(id, (e) => ({ ...e, outcome: o }));
  // What the Desk said it would do didn't happen: it goes, so it never claims what didn't happen.
  const failed = (id: string, why: string) => edit(id, (e) => ({ ...e, say: undefined, outcome: { kind: "failed", why } }));
  const sendTo = (entry: DeskEntry, slot: string) => {
    const chat = chatsNow.current.find((c) => c.slot === slot);
    const why = cantSend(chat);
    if (why || !chat) return failed(entry.id, why ?? "That chat is closed.");
    void sync.send(slot, entry.text);
    edit(entry.id, (e) => ({ ...e, outcome: { kind: "sent", slot, title: chat.title ?? "A chat", started: false, queued: chat.status === "working" || chat.status === "needs_you" }, ...(talks ? { reply: { status: "waiting", after: chat.last_seq, ...(epoch !== null ? { epoch } : {}) } } : {}) }));
  };
  const startIn = (entry: DeskEntry, folder: string, workflow: "chat" | "steps" = "chat") => {
    outcome(entry.id, { kind: "routing" });
    sync.newChat(folder, entry.text, workflow === "steps" ? { workflow: "steps" } : {}).then(
      (slot) => edit(entry.id, (e) => ({ ...e, outcome: { kind: "sent", slot, title: clip(entry.text, 60), started: true, queued: false }, ...(talks ? { reply: { status: "waiting", after: 0, ...(epoch !== null ? { epoch } : {}) } } : {}) })),
      (e: Error) => failed(entry.id, e.message || "The chat didn't start."),
    );
  };
  const act = (entry: DeskEntry, r: RemoteDeskRoute) => {
    if (r.kind === "chat") sendTo(entry, r.slot);
    else if (r.kind === "start") startIn(entry, r.project, r.workflow === "steps" ? "steps" : "chat");
    else if (r.kind === "ask") edit(entry.id, (e) => ({ ...e, ...(r.unsure ? { say: undefined } : {}), outcome: { kind: "ask", slots: r.slots, unsure: r.unsure } }));
    else if (r.kind === "answer") outcome(entry.id, { kind: "answer", terms: r.terms, text: r.text, sources: r.sources, error: r.error });
    else if (r.kind === "search") outcome(entry.id, { kind: "search", terms: r.terms, hits: r.hits, failed: r.failed });
    // A newer Mac's kind of answer this app can't show.
    else failed(entry.id, "Update Lantern on this phone to see this.");
  };
  const send = () => {
    const said = text.trim();
    if (!said || !shown) return;
    const entry: DeskEntry = { id: newId(), desk: shown.id, at: Date.now(), text: said, outcome: { kind: "routing" } };
    const history = deskHistory(entries, shown.id, chats);
    setEntries((all) => [...all, entry].slice(-LOG_MAX));
    setText("");
    const why = (e: Error) => failed(entry.id, e.message || "Your Mac didn't answer.");
    if (talks) {
      sync.deskTalk(shown.id, said, history).then((t) => {
        if (t.say) edit(entry.id, (e) => ({ ...e, say: t.say }));
        if (t.route === null) outcome(entry.id, { kind: "talk" });
        else act(entry, t.route);
      }, why);
    } else sync.deskRoute(shown.id, said).then((r) => act(entry, r), why);
  };

  // What came back: once the chat a message went to has moved on past it and stopped working, the Mac is asked for it. One
  // question at a time for the whole Desk (the Mac takes only a few slow ones at once, and a message typed now must get through),
  // and once for each step the chat takes.
  const asked = useRef(new Map<string, number>());
  const busy = useRef(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (busy.current) return;
    for (const e of entries) {
      if (e.outcome.kind !== "sent" || e.reply?.status !== "waiting") continue;
      const { slot } = e.outcome;
      const chat = chats.find((c) => c.slot === slot);
      const check = replyCheck(e.reply, chat, epoch);
      if (check === "lost") {
        edit(e.id, (x) => ({ ...x, reply: { status: "lost" } }));
        continue;
      }
      if (check !== "ask" || !chat || asked.current.get(e.id) === chat.last_seq) continue;
      asked.current.set(e.id, chat.last_seq);
      busy.current = true;
      sync
        .deskReply(e.desk, slot, e.text, e.reply.after)
        .then(
          (r) => {
            if (!r.done) return;
            edit(e.id, (x) => ({ ...x, reply: r.off ? { status: "off" } : r.summary !== null ? { status: "done", failed: r.failed, summary: r.summary, full: r.full || undefined } : { status: "failed", why: r.error ?? "It couldn't be summed up.", full: r.full || undefined } }));
          },
          // Asked again when the chat next moves.
          () => asked.current.delete(e.id),
        )
        .finally(() => {
          busy.current = false;
          // The next one waiting, if any, is asked now.
          setTick((t) => t + 1);
        });
      return;
    }
  }, [chats, entries, epoch, tick]);

  // The conversation keeps to its end as things come, unless it was scrolled up to read.
  const scroller = useRef<ScrollViewInstance>(null);
  const atEnd = useRef(true);

  const tabs = desk && desk.desks.length > 1 && (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.xl, gap: 6, paddingTop: 10 }} style={{ flexGrow: 0 }}>
      {desk.desks.map((d) => {
        const on = d.id === shown?.id;
        const n = waits[d.id] ?? 0;
        return (
          <PressScale key={d.id} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={n > 0 && !on ? `${d.name}, ${n} waiting` : d.name} onPress={() => setChosen(d.id)} haptic="select" scaleTo={0.94} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: on ? colors.ink : colors.card }}>
            <Txt variant="small" tone={on ? "on-ink" : "ink"} style={{ fontWeight: "700" }}>
              {d.name}
            </Txt>
            {n > 0 && !on && (
              <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: colors.hi }}>
                <Txt variant="tiny" tone="on-hi" style={{ fontWeight: "700" }}>
                  {n}
                </Txt>
              </View>
            )}
          </PressScale>
        );
      })}
    </ScrollView>
  );

  // What needs you: one at a time, the rest a word away; or that nothing does, once there is something on the Desk.
  const empty = mine.length === 0 && done.length === 0;
  const needsArea =
    needs.length > 0 ? (
      <View accessibilityLabel="Needs you" style={{ paddingTop: 6 }}>
        <Deck list={needs} onOpenChat={onOpenChat} onReview={onReview} />
        {needs.length > 1 && (
          <Txt variant="small" tone="ink2" style={{ paddingHorizontal: space.xl }}>
            {needs.length - 1} more after this one
          </Txt>
        )}
      </View>
    ) : !empty && shown ? (
      <View style={{ marginHorizontal: space.lg, marginTop: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.inner, backgroundColor: colors.card }}>
        <Txt variant="small" tone="go" style={{ fontWeight: "700" }}>
          ✓ Nothing needs you
        </Txt>
      </View>
    ) : null;

  const conversation = !shown ? (
    <View accessibilityLabel="Loading the Desk" accessible style={{ alignItems: "center", paddingVertical: 40 }}>
      <Dots />
    </View>
  ) : mine.length === 0 ? (
    empty ? (
      <View style={{ paddingHorizontal: space.md, paddingVertical: 32, gap: 6 }}>
        <Txt variant="heading">Your Desk</Txt>
        <Txt variant="body" tone="ink2">
          {talks ? "Tell the Desk what you want: it answers, sends it to the right chat, or starts one, and tells you what came back." : "Say what you want below and it goes to the right chat, or starts one."}
        </Txt>
      </View>
    ) : null
  ) : (
    mine.map((e) => (
      <FadeSlideIn key={e.id} from={8}>
        <Entry entry={e} desk={shown} onOpen={onOpenChat} onSendTo={(slot) => sendTo(e, slot)} onStartIn={(folder) => startIn(e, folder)} />
      </FadeSlideIn>
    ))
  );

  const box = (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: space.lg, paddingTop: 8, paddingBottom: barRoom(insets.bottom) }}>
      <TextInput
        accessibilityLabel={shown && shown.name !== "Desk" ? `Message the ${shown.name} Desk` : "Message the Desk"}
        value={text}
        onChangeText={setText}
        placeholder="Tell the Desk…"
        placeholderTextColor={colors.ink3}
        multiline
        editable={!!shown}
        style={{ flex: 1, backgroundColor: colors.card, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, minHeight: 42, maxHeight: 140, color: colors.ink, fontSize: 16, borderWidth: 1, borderColor: colors.rule }}
      />
      <PressScale accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !text.trim() || !shown }} disabled={!text.trim() || !shown} onPress={send} scaleTo={0.9} style={{ width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: text.trim() && shown ? colors.ink : colors.rule }}>
        <Txt variant="body" tone="on-ink" style={{ fontWeight: "700" }}>
          ↑
        </Txt>
      </PressScale>
    </View>
  );

  const talk = (
    <ScrollView
      ref={scroller}
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      scrollEventThrottle={64}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
      }}
      onContentSizeChange={() => atEnd.current && scroller.current?.scrollToEnd({ animated: false })}
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 14, paddingBottom: 12, gap: 14, flexGrow: 1, justifyContent: "flex-end" }}
    >
      {!wide && done.length > 0 && (
        <View style={{ paddingHorizontal: space.xs, paddingBottom: 6 }}>
          <JustFinished list={done} onOpen={onOpenChat} />
        </View>
      )}
      {conversation}
    </ScrollView>
  );

  if (wide) {
    return (
      <AboveKeyboard style={{ backgroundColor: colors.paper }}>
        <View style={{ paddingTop: insets.top + 8 }}>{top}</View>
        {tabs}
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ flex: 1, alignItems: "center" }}>
            <View style={{ flex: 1, width: "100%", maxWidth: TALK_MAX }}>
              {talk}
              {box}
            </View>
          </View>
          <ScrollView accessibilityLabel="What needs you, and what just finished" style={{ width: PANEL_WIDTH, flexGrow: 0, borderLeftWidth: 1, borderLeftColor: colors.rule }} contentContainerStyle={{ paddingVertical: 14, gap: 18, paddingBottom: insets.bottom + 20 }}>
            {needsArea ?? (
              <Txt variant="small" tone="ink3" style={{ paddingHorizontal: space.xl }}>
                Nothing needs you.
              </Txt>
            )}
            <View style={{ paddingHorizontal: space.xl }}>
              <JustFinished list={done} onOpen={onOpenChat} />
            </View>
          </ScrollView>
        </View>
      </AboveKeyboard>
    );
  }

  return (
    <AboveKeyboard style={{ backgroundColor: colors.paper }}>
      <View style={{ paddingTop: insets.top + 8 }}>{top}</View>
      {tabs}
      {needsArea}
      {talk}
      {box}
    </AboveKeyboard>
  );
}
