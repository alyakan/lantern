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
import { FadeSlideIn, PressScale, PulseDot } from "../ui/motion";
import { Dots } from "../ui/skeleton";
import { Markdown } from "../ui/Markdown";
import { radius, space, useColors } from "../ui/theme";
import { ago } from "../view/home";
import { cantSend, chatName, clip, deskFeed, deskLive, deskShown, LOG_MAX, waitingBy, type DeskEntry, type DeskOutcome } from "../view/desk";

export interface DeskProps {
  /** The top of Home (the Mac's name, the Desk or Chats switch), above the Desk. */
  top: ReactNode;
  onOpenChat: (slot: string) => void;
  /** What waits on you in these chats, as Home draws it (its stack of cards). */
  renderNeeds: (slots: string[]) => ReactNode;
}

const newId = () => `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** A finished answer in one of the Desk's chats: which chat, what started it, and the start of what Claude said. */
function Card({ card, onOpen }: { card: RemoteDeskCard; onOpen: () => void }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={`${card.title}, in ${card.project}. ${card.said}`} accessibilityHint="Opens the chat" onPress={onOpen} scaleTo={0.98} style={{ backgroundColor: colors.card, borderRadius: radius.inner, padding: 14, gap: 4, marginRight: 36 }}>
      <Txt variant="tiny" tone="ink3" numberOfLines={1}>
        {card.project} · {card.title}
      </Txt>
      <Txt variant="small" tone="ink2" numberOfLines={2}>
        {card.auto ? "On its own: " : "You: "}
        {card.asked}
      </Txt>
      {card.outcome !== "done" && (
        <Txt variant="small" tone="stop">
          {card.outcome === "failed" ? "It failed." : "It was stopped."}
        </Txt>
      )}
      {!!card.said && (
        <Txt variant="body" numberOfLines={6}>
          {card.said}
        </Txt>
      )}
    </PressScale>
  );
}

/** A message typed on the Desk, and where it went (or the question back, or what a search found). */
function Entry({ entry, desk, onOpen, onSendTo, onStartIn }: { entry: DeskEntry; desk: RemoteDeskInfo | null; onOpen: (slot: string) => void; onSendTo: (slot: string) => void; onStartIn: (folder: string) => void }) {
  const colors = useColors();
  const { chats } = useSyncState();
  const o = entry.outcome;
  return (
    <View style={{ gap: 6, alignItems: "flex-end" }}>
      <View style={{ backgroundColor: colors.ink, borderRadius: radius.inner, paddingHorizontal: 14, paddingVertical: 10, marginLeft: 48 }}>
        <Txt variant="body" tone="on-ink" numberOfLines={8}>
          {entry.text}
        </Txt>
      </View>
      {o.kind === "routing" && (
        <View accessibilityLabel="Working on it" accessible style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Dots />
          <Txt variant="small" tone="ink2">
            Working on it
          </Txt>
        </View>
      )}
      {o.kind === "sent" && (
        <PressScale accessibilityRole="button" accessibilityHint="Opens the chat" onPress={() => onOpen(o.slot)} hitSlop={8} haptic="select">
          <Txt variant="small" tone="ink2">
            {o.started ? "Started " : "→ "}
            <Txt variant="small" style={{ fontWeight: "700" }}>
              {o.title}
            </Txt>
            {o.queued ? ", after its turn" : ""}
          </Txt>
        </PressScale>
      )}
      {o.kind === "failed" && (
        <Txt variant="small" tone="stop" style={{ textAlign: "right" }}>
          {o.why}
        </Txt>
      )}
      {o.kind === "ask" && <Ask outcome={o} desk={desk} chats={chats} onSendTo={onSendTo} onStartIn={onStartIn} />}
      {o.kind === "search" && <Found outcome={o} onOpen={onOpen} />}
      {o.kind === "answer" && <Answered outcome={o} onOpen={onOpen} />}
    </View>
  );
}

function Ask({ outcome, desk, chats, onSendTo, onStartIn }: { outcome: Extract<DeskOutcome, { kind: "ask" }>; desk: RemoteDeskInfo | null; chats: ReturnType<typeof useSyncState>["chats"]; onSendTo: (slot: string) => void; onStartIn: (folder: string) => void }) {
  const offerNew = outcome.unsure || outcome.slots.length === 0;
  return (
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      <Txt variant="small" tone="ink2">
        {outcome.slots.length > 0 ? "Which chat is it for?" : "Start a chat for it?"}
      </Txt>
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

/** The Desk's own answer to how something stands, and the chats it read, numbered as it cites them. */
function Answered({ outcome, onOpen }: { outcome: Extract<DeskOutcome, { kind: "answer" }>; onOpen: (slot: string) => void }) {
  const colors = useColors();
  if (outcome.sources.length === 0 && !outcome.error) {
    return (
      <Txt variant="small" tone="ink2" style={{ textAlign: "right" }}>
        No chat on this Desk talks about "{outcome.terms}".
      </Txt>
    );
  }
  return (
    <View style={{ alignSelf: "stretch", backgroundColor: colors.card, borderRadius: radius.inner, padding: 12, gap: 8, marginRight: 36 }}>
      {outcome.text ? <Markdown text={outcome.text} /> : <Txt variant="small" tone="stop">{outcome.error ?? "No answer came."}</Txt>}
      {outcome.sources.map((h, i) => (
        <PressScale key={i} disabled={!h.slot} accessibilityRole={h.slot ? "button" : undefined} accessibilityHint={h.slot ? "Opens the chat" : undefined} onPress={() => h.slot && onOpen(h.slot)} scaleTo={0.98}>
          <Txt variant="tiny" tone="ink3" numberOfLines={1}>
            [{i + 1}] {h.title || "A chat"} · {h.project}
            {h.slot ? "" : " · on your Mac"}
          </Txt>
        </PressScale>
      ))}
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
    <View style={{ alignSelf: "stretch", backgroundColor: colors.card, borderRadius: radius.inner, padding: 12, gap: 10, marginLeft: 36 }}>
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

/**
 * The Desk: every open chat on it at once (what each is doing, a card for each answer that finished, what waits on you), and a
 * box that sends what you type to the right chat, or starts one. Where it goes is decided on the Mac; it is sent from here, as it
 * would be from the chat, on Ask for a new chat. A Mac with several Desks shows a tab for each.
 */
export function DeskScreen({ top, onOpenChat, renderNeeds }: DeskProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  const { chats, desk } = useSyncState();
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

  const shown = deskShown(desk, chosen);
  const feed = shown ? deskFeed(desk, shown.id, entries) : [];
  const live = shown ? deskLive(chats, shown.slots) : [];
  const waits = waitingBy(desk, chats);

  const edit = (id: string, outcome: DeskOutcome) => setEntries((all) => all.map((e) => (e.id === id ? { ...e, outcome } : e)));
  const sendTo = (entry: DeskEntry, slot: string) => {
    const chat = chatsNow.current.find((c) => c.slot === slot);
    const why = cantSend(chat);
    if (why || !chat) return edit(entry.id, { kind: "failed", why: why ?? "That chat is closed." });
    void sync.send(slot, entry.text);
    edit(entry.id, { kind: "sent", slot, title: chat.title ?? "A chat", started: false, queued: chat.status === "working" || chat.status === "needs_you" });
  };
  const startIn = (entry: DeskEntry, folder: string, workflow: "chat" | "steps" = "chat") => {
    edit(entry.id, { kind: "routing" });
    sync.newChat(folder, entry.text, workflow === "steps" ? { workflow: "steps" } : {}).then(
      (slot) => edit(entry.id, { kind: "sent", slot, title: clip(entry.text, 60), started: true, queued: false }),
      (e: Error) => edit(entry.id, { kind: "failed", why: e.message || "The chat didn't start." }),
    );
  };
  const act = (entry: DeskEntry, r: RemoteDeskRoute) => {
    if (r.kind === "chat") sendTo(entry, r.slot);
    else if (r.kind === "start") startIn(entry, r.project, r.workflow === "steps" ? "steps" : "chat");
    else if (r.kind === "ask") edit(entry.id, { kind: "ask", slots: r.slots, unsure: r.unsure });
    else if (r.kind === "answer") edit(entry.id, { kind: "answer", terms: r.terms, text: r.text, sources: r.sources, error: r.error });
    else edit(entry.id, { kind: "search", terms: r.terms, hits: r.hits, failed: r.failed });
  };
  const send = () => {
    const said = text.trim();
    if (!said || !shown) return;
    const entry: DeskEntry = { id: newId(), desk: shown.id, at: Date.now(), text: said, outcome: { kind: "routing" } };
    setEntries((all) => [...all, entry].slice(-LOG_MAX));
    setText("");
    sync.deskRoute(shown.id, said).then(
      (r) => act(entry, r),
      (e: Error) => edit(entry.id, { kind: "failed", why: e.message || "Your Mac didn't answer." }),
    );
  };

  // The feed keeps to its end as things come, unless it was scrolled up to read.
  const scroller = useRef<ScrollViewInstance>(null);
  const atEnd = useRef(true);

  return (
    <AboveKeyboard style={{ backgroundColor: colors.paper }}>
      <View style={{ paddingTop: insets.top + 8 }}>{top}</View>
      {desk && desk.desks.length > 1 && (
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
      )}
      {live.length > 0 && (
        <View style={{ paddingHorizontal: space.xl, paddingTop: 10, gap: 6 }}>
          {live.slice(0, 4).map((l) => (
            <PressScale key={l.chat.slot} accessibilityRole="button" accessibilityLabel={`${l.chat.title ?? "A chat"}: ${l.line}`} onPress={() => onOpenChat(l.chat.slot)} scaleTo={0.98} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <PulseDot color={l.waiting ? colors.hi : colors.go} size={7} />
              <Txt variant="small" style={{ fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                {l.chat.title ?? "A chat"}
              </Txt>
              <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flex: 1 }}>
                {l.line}
              </Txt>
            </PressScale>
          ))}
          {live.length > 4 && (
            <Txt variant="tiny" tone="ink3">
              and {live.length - 4} more
            </Txt>
          )}
        </View>
      )}
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
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 14, paddingBottom: 12, gap: 12, flexGrow: 1, justifyContent: "flex-end" }}
      >
        {!shown ? (
          <View accessibilityLabel="Loading the Desk" accessible style={{ alignItems: "center", paddingVertical: 40 }}>
            <Dots />
          </View>
        ) : feed.length === 0 ? (
          <View style={{ paddingHorizontal: space.md, paddingVertical: 32, gap: 6 }}>
            <Txt variant="heading">Your Desk</Txt>
            <Txt variant="body" tone="ink2">
              Every chat's answers land here, with the chat they came from. Say what you want below and it goes to the right chat, or starts one.
            </Txt>
          </View>
        ) : (
          feed.map((f) =>
            f.kind === "card" ? (
              <Card key={f.card.key} card={f.card} onOpen={() => onOpenChat(f.card.slot)} />
            ) : (
              <FadeSlideIn key={f.entry.id} from={8}>
                <Entry entry={f.entry} desk={shown} onOpen={onOpenChat} onSendTo={(slot) => sendTo(f.entry, slot)} onStartIn={(folder) => startIn(f.entry, folder)} />
              </FadeSlideIn>
            ),
          )
        )}
        {shown && renderNeeds(shown.slots)}
      </ScrollView>
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
    </AboveKeyboard>
  );
}
