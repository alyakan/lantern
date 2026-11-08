import { tabBarRoom } from "../ui/TabBar";
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { useToTop } from "../ui/useToTop";
import { BackButton } from "../ui/BackButton";
import { Host, Image as SwiftImage } from "@expo/ui/swift-ui";
import { Keyboard, Linking, Platform, RefreshControl, ScrollView, TextInput, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { useController, useSyncState } from "../shell/hooks";
import { useAccent } from "../ui/accent";
import { finished } from "../view/desk";
import { JustFinished } from "./JustFinished";
import { AnimatedStack, type StackItem } from "../ui/AnimatedStack";
import { BAR_TEXT_SCALE, ProjectTag, Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Glass } from "../ui/Glass";
import { Sheet, SheetPill } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { Magnifier, RoundButton, SearchContents, SidebarIcon, type BarSearch } from "./SearchBar";
import { TOP_BAR_GAP } from "../ui/TopBar";
import { control, MIN_TARGET, radius, space, useColors, type Palette } from "../ui/theme";
import { askOf, BUCKETS, bucketOf, featureFor, lineUnder, linksOf, metaUnder, nextSteps, openBucket, pathOf, projectColors, stackWord, standing, toneOf, TONE_WORD, workGroups, type Bucket, type Tone, type WorkGroup } from "../view/work";

export interface WorkProps {
  /**
   * A tablet's: the features are listed in its left column (the Work side of its Chats / Work switch), and this is the page
   * beside them — the feature picked there (by its key), or with none picked the one that needs you. No list, no way back: the
   * column is the list.
   */
  beside?: { feature: string | null };
  /** A tablet whose chats are put away: the header's button that brings the column back (none when it is beside it, or slid in). */
  onShowChats?: () => void;
  /** Its tab tapped again while shown (a count): back from a feature's page, or to the top of the list. */
  toTop?: number;
  /** A phone's Work tab: the tab bar floats over its bottom. */
  tabbed?: boolean;
  /** A tablet's main area: the page is held to a column that reads well. */
  wide?: boolean;
  /** Opens a chat on the Mac (an item's details offer the one on its branch). */
  onOpenChat?: (slot: string) => void;
}

const COLUMN_MAX = 640;

/** A state's colour. Only what needs you is loud (red blocked, blue your call, amber a ticket to move); the rest is quiet. */
function toneColor(tone: Tone, c: Palette): string {
  switch (tone) {
    case "bad":
      return c.stop;
    case "you":
      return c.cobalt;
    case "move":
      return c.isDark ? "#e0a43a" : "#a86b00";
    case "wait":
      return c.isDark ? "#8b9bb4" : "#5b6b82";
    case "ready":
      return c.isDark ? "#3fc1c6" : "#0f8a8f";
    case "local":
      return c.isDark ? "#b794f4" : "#7c4fd0";
    case "todo":
      return c.ink3;
    case "done":
      return c.go;
  }
}

/** An item's colour: its state's, or the warning amber when its step goes around a rule (merging a pull request nobody approved). */
export const hueOf =(item: RemoteWorkItem, c: Palette): string => toneColor(item.next?.warn ? "move" : toneOf(item), c);

/** What happened to a step asked for: where it went, or why it didn't. Kept while the item stays in the state it was asked in. */
interface Outcome {
  sig: string;
  text: string;
  bad: boolean;
}

/** Its pipeline, a node a stage (issue, branch, pull request, checks, review, merge, release): green behind it, ringed where it is, grey ahead. */
function Path({ item, issues, named = false, tone }: { item: RemoteWorkItem; issues: boolean; /** Says the stage it is at, after the nodes. */ named?: boolean; tone?: string }) {
  const colors = useColors();
  const ring = tone ?? hueOf(item, colors);
  const nodes = pathOf(item, issues);
  const at = nodes.find((n) => n.state === "now") ?? nodes[nodes.length - 1];
  return (
    <View accessible accessibilityLabel={`At ${at.label}, ${TONE_WORD[toneOf(item)]}`} style={{ flexDirection: "row", alignItems: "center", marginTop: 8, marginRight: 6, gap: named ? 10 : 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
        {nodes.map((n, i) => (
          <View key={n.stage} style={{ flexDirection: "row", alignItems: "center", flex: i === 0 ? 0 : 1 }}>
            {i > 0 && <View style={{ flex: 1, height: 2, backgroundColor: n.state === "past" || n.state === "now" ? colors.go : colors.rule }} />}
            <View
              style={
                n.state === "now"
                  ? { width: 15, height: 15, borderRadius: 8, borderWidth: 3, borderColor: ring, backgroundColor: colors.card }
                  : { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderStyle: n.state === "skip" ? "dashed" : "solid", borderColor: n.state === "past" ? colors.go : colors.rule, backgroundColor: n.state === "past" ? colors.go : colors.card }
              }
            />
          </View>
        ))}
      </View>
      {named && (
        <Txt variant="tiny" tone="ink3" style={{ fontWeight: "600" }}>
          {at.label}
        </Txt>
      )}
    </View>
  );
}

/** One of Next's steps: its dot and name (which opens its details), a quiet line, and under it what the caller adds. */
function Item({ item, meta, lead, onOpen, children }: { item: RemoteWorkItem; meta: string; lead?: string; onOpen: () => void; children?: ReactNode }) {
  const colors = useColors();
  const tone = hueOf(item, colors);
  const name = (
    <Txt variant="body" style={{ fontWeight: "600", flexShrink: 1 }}>
      {lead ? `${lead} ` : ""}
      {item.number !== null && (
        <Txt variant="small" tone="ink3">
          #{item.number}{" "}
        </Txt>
      )}
      {item.title}
    </Txt>
  );
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 11, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone, marginTop: 7 }} />
        <PressScale accessibilityRole="button" accessibilityHint="Opens its details" onPress={onOpen} scaleTo={0.99} style={{ flex: 1 }}>
          {name}
        </PressScale>
      </View>
      <Txt variant="small" tone="ink3" style={{ paddingLeft: 16 }}>
        {meta}
      </Txt>
      {children}
    </View>
  );
}

/** A button on an item's details: a page to open, or a chat. */
const Action = ({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) => {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityHint={hint} onPress={onPress} haptic="select" scaleTo={0.95} style={{ minHeight: MIN_TARGET, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.rule, alignItems: "center", justifyContent: "center" }}>
      <Txt variant="small" style={{ fontWeight: "600" }}>
        {label}
      </Txt>
    </PressScale>
  );
};

const Link = ({ label, onPress, hint }: { label: string; onPress: () => void; hint?: string }) => (
  // Small words, but a finger's worth of a target: the slop takes it to 44 points without moving the row it sits in.
  <PressScale accessibilityRole="button" accessibilityHint={hint} onPress={onPress} hitSlop={{ top: 13, bottom: 13, left: 8, right: 8 }} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
    <Txt variant="small" tone="cobalt" style={{ fontWeight: "600" }}>
      {label}
    </Txt>
  </PressScale>
);

/** Whether a piece of work says what is typed: its name, its number, its issue, its feature, its repo, its state or its branch. */
const says = (i: RemoteWorkItem, typed: string) => {
  const q = typed.trim().toLowerCase();
  return [i.number === null ? "" : `#${i.number}`, i.title, i.issue ?? "", i.feature ?? "", i.repo, i.word, i.branch ?? ""].some((f) => f.toLowerCase().includes(q));
};

/** Refresh as the system's own arrow (a sign elsewhere), for a round button: a word in a bar didn't read as something to tap. */
function RefreshGlyph() {
  const colors = useColors();
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Platform.OS === "ios" ? (
        <Host style={{ width: 20, height: 20 }} alignment="center">
          <SwiftImage systemName="arrow.clockwise" size={16} color={colors.ink} />
        </Host>
      ) : (
        <Txt variant="body" style={{ fontWeight: "700" }}>
          ↻
        </Txt>
      )}
    </View>
  );
}

/** The feature's pieces as dots, one each (shipped work has none): colour only on what needs you, a ring for what isn't started. */
function Pieces({ items }: { items: RemoteWorkItem[] }) {
  const colors = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
      {items.map((i) => {
        const b = bucketOf(i);
        return <View key={i.key} style={b === "start" ? { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: colors.ink3 } : { width: 9, height: 9, borderRadius: 5, backgroundColor: b === "attn" ? hueOf(i, colors) : colors.ink3, opacity: b === "attn" ? 1 : 0.55 }} />;
      })}
    </View>
  );
}

/** Where the user's work stands, and what to do next: the Mac works it out, this shows it, and a step is asked of the Mac. */
export function WorkScreen({ beside, wide = false, onOpenChat, tabbed = false, onShowChats, toTop }: WorkProps) {
  const lister = useRef<ComponentRef<typeof ScrollView>>(null);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const controller = useController();
  const { work, chats, desk, single } = useSyncState();
  // The app's accent (a regular's Ember) for what is chosen or counts.
  const accent = useAccent();
  // What finished on the Mac lately (the Desk's answers, across its desks, newest first): here, beside where things stand,
  // not on the chats.
  const done = desk ? desk.desks.flatMap((d) => finished(desk, d.id, [])).filter((c) => !single || c.project === single.name).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) : [];
  const justFinished = done.length > 0 && onOpenChat ? <JustFinished list={done} onOpen={onOpenChat} /> : null;
  const colorOf = projectColors(chats);
  // The feature (or project) whose page is open, by its group key, and which of its tabs; null opens on the one that needs you.
  const [page, setPage] = useState<string | null>(null);
  useToTop(toTop, () => (page !== null ? setPage(null) : lister.current?.scrollTo({ y: 0, animated: true })));
  const [tab, setTab] = useState<Bucket | null>(null);
  const [nextOpen, setNextOpen] = useState(false);
  // The item whose details are open, by key: they follow it as it moves on, and close if it goes.
  const [detail, setDetail] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // "5 min ago" moves on by itself, a minute at a time, while the tab is open.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Searching your work (a tablet's header): the field is open, and what is typed lists what says it, from every feature.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const findInput = useRef<ComponentRef<typeof TextInput>>(null);
  const items = work?.items ?? [];
  // What is found by what is typed, over every piece of work (shipped included: it is the one way to look one up).
  const found = query.trim() ? items.filter((i) => says(i, query)) : [];
  const barSearch: BarSearch = {
    active: finding,
    query,
    count: found.length,
    position: 0,
    onOpen: () => {},
    onChange: setQuery,
    onStep: () => {},
    onCancel: () => {
      setFinding(false);
      setQuery("");
      Keyboard.dismiss();
    },
    placeholder: "Search your work",
    list: true,
    noun: "item",
  };
  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);
  const issues = work?.issues === true;
  const looked = work?.looked === true;
  const blind = work?.blind ?? [];
  // Features with Linear; the projects without it.
  const next = nextSteps(items);
  const listed = standing(items);
  const groups = workGroups(items, issues);
  const needing = listed.filter((i) => bucketOf(i) === "attn").length;
  // One group needs no card to open: its page is the screen.
  const alone = groups.length === 1;
  const open: WorkGroup | undefined = alone ? groups[0] : page !== null ? groups.find((g) => g.key === page) : undefined;
  // A tablet's page: the feature its column picked, or the one that needs you (the column highlights the same one).
  const shownFeature = beside ? featureFor(groups, beside.feature) : undefined;
  // Another feature opens on its own first tab, not on the tab the last one was left on.
  useEffect(() => {
    if (beside) setTab(null);
  }, [shownFeature?.key]);
  // A feature whose page was open and is gone (all of it shipped) is let go: the list shows, and the page doesn't come back by
  // itself if the feature does.
  useEffect(() => {
    if (page !== null && !groups.some((g) => g.key === page)) setPage(null);
  }, [page, groups.map((g) => g.key).join("\n")]);

  const refresh = () => {
    setRefreshing(true);
    controller.sync.workRefresh().then(
      () => setTimeout(() => setRefreshing(false), 600),
      () => setRefreshing(false),
    );
  };
  // Asks the Mac to do the step as it was shown. The Mac refuses one that moved on; what it did, or why not, is said under the item.
  const run = (item: RemoteWorkItem) => {
    setBusy(item.key);
    setOutcomes((o) => {
      const { [item.key]: _gone, ...rest } = o;
      return rest;
    });
    controller.sync.workStep(item.key, item.sig).then(
      (r) => {
        const where = r.kind === "started" ? `Started a chat in ${r.to}` : `Sent to “${r.to}”`;
        setOutcomes((o) => ({ ...o, [item.key]: { sig: item.sig, text: item.next?.yours ? `${where}. It asks you before anything happens.` : where, bad: false } }));
      },
      (e: Error) => setOutcomes((o) => ({ ...o, [item.key]: { sig: item.sig, text: e.message || "Your Mac didn't do that.", bad: true } })),
    ).finally(() => setBusy((b) => (b === item.key ? null : b)));
  };

  /** What is under an item: the button for its step, or what became of it. */
  const step = (item: RemoteWorkItem) => {
    if (!item.next) return null;
    const out = outcomes[item.key];
    const said = out && out.sig === item.sig ? out : null;
    return (
      <View style={{ paddingLeft: 16, paddingTop: 6, gap: 6 }}>
        {said && (
          <Txt variant="small" tone={said.bad ? "stop" : "go"} accessibilityLiveRegion="polite">
            {said.text}
          </Txt>
        )}
        {!(said && !said.bad) && (
          <PressScale
            accessibilityRole="button"
            accessibilityLabel={`${item.next.what} ${item.number !== null ? `#${item.number}` : item.title}`}
            accessibilityHint={item.next.warn ? "Asks a chat to merge it past the required review; it asks you before anything happens" : item.next.yours ? "Asks a chat to get it ready; it asks you before anything happens" : "Sends this to a chat on your Mac"}
            accessibilityState={{ disabled: busy === item.key }}
            disabled={busy === item.key}
            onPress={() => run(item)}
            haptic="select"
            scaleTo={0.95}
            style={{
              alignSelf: "flex-start",
              minHeight: 36,
              paddingHorizontal: 16,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              // A step that goes around a rule is outlined in amber, not filled: it isn't the way the usual steps look.
              ...(item.next.warn ? { backgroundColor: `${hueOf(item, colors)}22`, borderWidth: 1, borderColor: hueOf(item, colors) } : { backgroundColor: item.next.yours ? colors.hi : colors.ink }),
              opacity: busy === item.key ? 0.5 : 1,
            }}
          >
            <Txt variant="small" tone={item.next.warn ? undefined : item.next.yours ? "on-hi" : "on-ink"} style={{ fontWeight: "700", ...(item.next.warn ? { color: hueOf(item, colors) } : {}) }}>
              {busy === item.key ? "Asking your Mac…" : item.next.button}
            </Txt>
          </PressScale>
        )}
      </View>
    );
  };

  /** One of Next's steps, in the sheet that lists them all (its outcome and busy state are this screen's, so they carry across). */
  const nextRow = (i: RemoteWorkItem, n: number) => (
    <View key={i.key} style={n > 0 ? { borderTopWidth: 1, borderTopColor: colors.rule } : undefined}>
      <Item item={i} lead={i.next?.what} meta={`${i.word} · ${lineUnder(i, now, null)}`} onOpen={() => {
        // One sheet at a time: the details take the place of the list of next steps.
        setNextOpen(false);
        setDetail(i.key);
      }}>
        {step(i)}
      </Item>
    </View>
  );

  /** One feature as a card: its name, its pieces as dots, and the one thing that needs you. It opens to the feature's page. */
  const featureCard = (g: WorkGroup) => {
    const live = g.items.filter((i) => bucketOf(i) !== "shipped");
    const shipped = g.items.length - live.length;
    const ask = askOf(g.items);
    const top = ask[0];
    const sum = [live.length > 0 && `${live.length} open`, shipped > 0 && `${shipped} shipped`].filter(Boolean).join(" · ");
    return (
      <PressScale
        key={g.key}
        accessibilityRole="button"
        accessibilityLabel={`${g.label}, ${sum || "nothing open"}${top ? `, ${top.word}` : ""}`}
        accessibilityHint="Opens its work"
        onPress={() => {
          setPage(g.key);
          setTab(null);
        }}
        scaleTo={0.985}
        style={{ backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.rule, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16, gap: 12 }}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <Txt variant="heading" style={{ flexShrink: 1 }}>
            {g.label}
          </Txt>
          <Txt variant="small" tone="ink3">
            {sum}
          </Txt>
          <Txt variant="body" tone="ink3" style={{ marginLeft: "auto" }}>
            ›
          </Txt>
        </View>
        {live.length > 0 && <Pieces items={live} />}
        {top ? (
          <Txt variant="small" tone="ink2">
            <Txt variant="small" style={{ color: hueOf(top, colors), fontWeight: "700" }}>
              {top.next?.warn ? "Bypasses review" : top.word}
            </Txt>
            {"  "}
            {top.next ? `${top.next.what} ` : ""}
            {top.number !== null ? `#${top.number} ` : ""}
            {top.title}
          </Txt>
        ) : (
          <Txt variant="small" tone="ink3">
            Nothing needs you.
          </Txt>
        )}
        {ask.length > 1 && (
          <Txt variant="small" tone="ink3">
            and {ask.length - 1} more
          </Txt>
        )}
      </PressScale>
    );
  };

  /** The tabs of a feature: what needs you (with how many), what is moving, what isn't started, and what shipped. One with nothing in it is dimmed, not gone, so the row never moves. */
  const tabs = (g: WorkGroup, on: Bucket) => (
    // At the larger text sizes the four don't fit across: they scroll sideways rather than run off the screen.
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.rule, marginTop: 16 }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" contentContainerStyle={{ flexDirection: "row", gap: 16 }}>
      {BUCKETS.map(({ bucket, label }) => {
        const n = g.items.filter((i) => bucketOf(i) === bucket).length;
        const selected = bucket === on;
        return (
          <PressScale key={bucket} accessibilityRole="tab" accessibilityLabel={bucket === "attn" && n > 0 ? `${label}, ${n}` : label} accessibilityState={{ selected }} onPress={() => setTab(bucket)} haptic="select" scaleTo={0.96} style={{ paddingBottom: 10, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: selected ? colors.ink : "transparent", flexDirection: "row", gap: 4 }}>
            <Txt variant="small" tone={selected ? "ink" : "ink3"} style={{ fontWeight: "600", opacity: n === 0 && !selected ? 0.5 : 1 }}>
              {label}
            </Txt>
            {bucket === "attn" && n > 0 && (
              <Txt variant="small" style={{ fontWeight: "700", color: accent }}>
                {n}
              </Txt>
            )}
          </PressScale>
        );
      })}
    </ScrollView>
    </View>
  );

  /** One piece of work on a feature's page: its name, a quiet line, and its pipeline. Taller than a list row, since it carries the pipeline. A tap opens its details. */
  const row = (i: RemoteWorkItem, heading: string | null, n: number) => {
    const attn = bucketOf(i) === "attn";
    const hue = hueOf(i, colors);
    // Its project as the chats' chip, unless the page it is on is that project.
    const chip = !!i.repo && heading !== i.repo;
    const line = lineUnder(i, now, heading, chip);
    const said = lineUnder(i, now, heading);
    return (
      <View key={i.key} style={n > 0 ? { borderTopWidth: 1, borderTopColor: colors.rule } : undefined}>
        <PressScale
          accessibilityRole="button"
          accessibilityLabel={`${i.number !== null ? `#${i.number} ` : ""}${i.title}, ${i.word}${said ? `, ${said}` : ""}`}
          accessibilityHint="Opens its details"
          onPress={() => setDetail(i.key)}
          scaleTo={0.99}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingTop: 16, paddingBottom: attn && i.next ? 6 : 16 }}
        >
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={bucketOf(i) === "start" ? { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: colors.ink3, marginTop: 7 } : { width: 9, height: 9, borderRadius: 5, backgroundColor: attn ? hue : colors.ink3, opacity: attn ? 1 : 0.55, marginTop: 7 }} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt variant="body" numberOfLines={1} style={{ fontWeight: "600" }}>
              {i.number !== null && (
                <Txt variant="small" tone="ink3">
                  #{i.number}{" "}
                </Txt>
              )}
              {i.title}
            </Txt>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {chip && <ProjectTag name={i.repo} color={colorOf.get(i.repo) ?? null} />}
              <Txt variant="small" tone="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>
                {attn ? <Txt variant="small" style={{ color: hue, fontWeight: "700" }}>{i.word}</Txt> : i.word}
                {line ? ` · ${line}` : ""}
              </Txt>
            </View>
            {bucketOf(i) !== "shipped" && <Path item={i} issues={issues} named tone={attn ? hue : colors.ink2} />}
          </View>
        </PressScale>
        {attn && <View style={{ paddingLeft: 9, paddingBottom: 14 }}>{step(i)}</View>}
      </View>
    );
  };

  /** A feature's page: its name (where nothing above it says it), how much is open, its tabs, and the rows under the one chosen. */
  const featurePage = (g: WorkGroup, titled: boolean, /** Beside its count, on a tablet: every step to take, across the features. */ review?: ReactNode) => {
    const on = tab ?? openBucket(g.items);
    const rows = g.items.filter((i) => bucketOf(i) === on);
    const live = g.items.filter((i) => bucketOf(i) !== "shipped").length;
    return (
      <View accessibilityLabel={g.label}>
        {/* With one feature its page is the screen, and the name is its headline. A phone's pushed page has the name in its bar,
            and a tablet's page in its header. */}
        {titled && (
          <Txt variant="title" style={{ marginTop: 0 }}>
            {g.label}
          </Txt>
        )}
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 4 }}>
          <Txt variant="small" tone="ink3">
            {live} open, {g.items.length - live} shipped
          </Txt>
          {review}
        </View>
        {tabs(g, on)}
        {rows.length === 0 ? (
          <Txt variant="body" tone="ink3" style={{ paddingTop: 18 }}>
            Nothing here.
          </Txt>
        ) : (
          rows.map((i, n) => row(i, g.plain ? null : g.label, n))
        )}
      </View>
    );
  };

  /** Where things stand, in a line: nothing looked at yet, nothing open, or how many things need you. */
  const standsLine = !looked
    ? "Your Mac hasn't looked yet: open a project on it to see its work."
    : items.length === 0
      ? `Nothing open: no pull requests of yours, nothing waiting to be released, no branches left unpushed${issues ? ", no issues to start" : ""}.`
      : needing === 0
        ? "Nothing needs you right now."
        : `${needing === 1 ? "1 thing needs" : `${needing} things need`} you.`;
  /** The Mac says when it couldn't tell whose pull requests are yours: they aren't listed, and that isn't "nothing open". */
  const blindNote =
    blind.length > 0 ? (
      <Txt variant="small" tone="ink2">
        Couldn't tell which GitHub account is yours in {blind.join(", ")}, so its pull requests aren't shown. Refresh to try again.
      </Txt>
    ) : null;

  /** The Work screen: how many things need you, and a card for each feature. */
  // A refresh says it is going where its link was (the list's own pull spinner is hidden; a tap on the link showed nothing).
  const refreshLink = refreshing ? (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Refreshing" style={{ minHeight: 22, justifyContent: "center" }}>
      <Dots />
    </View>
  ) : (
    <Link label="Refresh" onPress={refresh} />
  );
  const overview = (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Txt variant="title" accessibilityRole="header">
          Work
        </Txt>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
          <Txt variant="body" tone="ink2" style={{ flexShrink: 1 }}>
            {standsLine}
          </Txt>
          {next.length > 0 && <Link label="Review" hint="Lists every step to take" onPress={() => setNextOpen(true)} />}
          <View style={{ marginLeft: "auto" }}>{refreshLink}</View>
        </View>
        {blindNote}
      </View>
      {justFinished}
      {groups.length > 0 && <View style={{ gap: 14 }}>{groups.map(featureCard)}</View>}
    </View>
  );

  /**
   * With one feature (or one project) there are no cards: the screen opens on its page, under the same line of how many things
   * need you. A tablet's header has Refresh as a button, so its line doesn't repeat it.
   */
  const overviewNote = (withRefresh = true) => (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
      <Txt variant="small" tone="ink3" style={{ flexShrink: 1 }}>
        {needing === 0 ? "Nothing needs you right now." : `${needing === 1 ? "1 thing needs" : `${needing} things need`} you.`}
      </Txt>
      {next.length > 0 && <Link label="Review" hint="Lists every step to take" onPress={() => setNextOpen(true)} />}
      {withRefresh && <View style={{ marginLeft: "auto" }}>{refreshLink}</View>}
    </View>
  );

  /**
   * The way back from a feature's page: the chat's back button, a circle of glass. The page goes away as the stack takes it
   * away (a swipe in from the edge does the same, with the list coming out from under it).
   */
  const backCircle = <BackButton label="Back to Work" hint="Goes back to every feature" onPress={() => setPage(null)} />;

  /**
   * A phone's feature page bar, which is part of the page: it slides in with it and follows a finger going back, as a navigation
   * bar does. The way back leads, and the page's name sits where a chat's title does.
   */
  const pageBar = (g: WorkGroup) => (
    <View testID="work-page-bar" style={{ backgroundColor: colors.paper, paddingTop: insets.top + TOP_BAR_GAP, paddingBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.lg }}>
        {backCircle}
        <View style={{ flex: 1 }}>
          <Glass style={{ minHeight: control, borderRadius: control / 2, paddingHorizontal: 18, paddingVertical: 2, justifyContent: "center" }}>
            <Txt variant="heading" numberOfLines={1} maxFontSizeMultiplier={BAR_TEXT_SCALE} accessibilityRole="header">
              {g.label}
            </Txt>
          </Glass>
        </View>
      </View>
    </View>
  );

  /** The room a screen's list keeps round it. */
  const margins: ViewStyle = { paddingHorizontal: wide ? space.xl : space.lg, paddingBottom: tabbed ? tabBarRoom(insets.bottom) : insets.bottom + 40, gap: 14, ...(wide ? { width: "100%", maxWidth: COLUMN_MAX, alignSelf: "center" } : {}) };

  // The tab is the app's own stack, as a chat's screen is: the list, and the feature's page pushed over it — so going back
  // uncovers the list itself, sliding out from under, rather than a blank screen.
  const listScreen: StackItem = {
    key: "work:list",
    kind: "push",
    element: (
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        <ScrollView
          ref={lister}
          accessibilityLabel="Your work"
          style={{ flex: 1 }}
          contentContainerStyle={{ ...margins, paddingTop: insets.top + 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="transparent" colors={["transparent"]} progressBackgroundColor="transparent" />}
        >
          {work === null ? (
            <View accessibilityLabel="Loading your work" accessible style={{ alignItems: "center", paddingVertical: 40 }}>
              <Dots />
            </View>
          ) : alone && open ? (
            <>
              <View style={{ marginBottom: 4 }}>{overviewNote()}</View>
              {justFinished && <View style={{ marginVertical: 12 }}>{justFinished}</View>}
              {featurePage(open, true)}
            </>
          ) : (
            overview
          )}
        </ScrollView>
        {/* The headline is the list's own, with no bar over it. The status bar's strip is paper, so words don't run under the clock. */}
        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: colors.paper }} />
      </View>
    ),
  };
  const screens: StackItem[] =
    !alone && open
      ? [
          listScreen,
          {
            key: `work:${open.key}`,
            kind: "push",
            element: (
              <View style={{ flex: 1, backgroundColor: colors.paper }}>
                {pageBar(open)}
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ ...margins, paddingTop: 12 }}>
                  {featurePage(open, false)}
                </ScrollView>
              </View>
            ),
          },
        ]
      : [listScreen];

  /**
   * A tablet's page, beside the features in its column. Its header is words and round buttons, with no capsule round them: the
   * feature's name as the page's title, then Search and Refresh (the system's arrow, not a word), and before the name the button
   * that brings the column back while it is put away. Under it how many things need you, then the feature's tabs and rows.
   * Search lists what it finds, from every feature, in place of the page.
   */
  const refreshButton = refreshing ? (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Refreshing" style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
      <Dots />
    </View>
  ) : (
    <RoundButton label="Refresh" onPress={refresh}>
      <RefreshGlyph />
    </RoundButton>
  );
  const header = (
    <View testID="work-header" style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 }}>
      {onShowChats && (
        <RoundButton label="Show chats" onPress={onShowChats}>
          <SidebarIcon />
        </RoundButton>
      )}
      {finding ? (
        <View style={{ flex: 1, minHeight: 40, paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule, justifyContent: "center" }}>
          <SearchContents search={barSearch} input={findInput} onFocused={() => {}} onCancel={barSearch.onCancel} />
        </View>
      ) : (
        <>
          <Txt variant="title" accessibilityRole="header" numberOfLines={2} style={{ flex: 1 }}>
            {shownFeature?.label ?? "Work"}
          </Txt>
          <RoundButton label="Search your work" onPress={() => setFinding(true)}>
            <Magnifier />
          </RoundButton>
          {refreshButton}
        </>
      )}
    </View>
  );
  const besidePage = (
    <ScrollView
      ref={lister}
      accessibilityLabel="Your work"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1 }}
      contentContainerStyle={{ ...margins, paddingTop: insets.top + TOP_BAR_GAP }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="transparent" colors={["transparent"]} progressBackgroundColor="transparent" />}
    >
      {header}
      {finding ? (
        // What says what is typed, wherever it sits: a name, a number, an issue, a feature, a repo, a branch.
        <View accessibilityLabel="Found work">
          {found.length === 0 ? (
            <Txt variant="body" tone="ink3">
              {query.trim() ? `Nothing says “${query.trim()}”.` : "Search your work: a name, a #number, a ticket, a feature or a repo."}
            </Txt>
          ) : (
            found.map((i, n) => row(i, null, n))
          )}
        </View>
      ) : work === null ? (
        <View accessibilityLabel="Loading your work" accessible style={{ alignItems: "center", paddingVertical: 40 }}>
          <Dots />
        </View>
      ) : (
        <>
          {/* The page says its own feature's numbers (its tabs count what needs you in it); how many need you across them all is
              the Work switch's count, and the steps to take across them all are one link beside the page's count. */}
          {!shownFeature && (
            <Txt variant="body" tone="ink2">
              {standsLine}
            </Txt>
          )}
          {blindNote}
          {justFinished}
          {shownFeature && featurePage(shownFeature, false, next.length > 0 ? <Link label={`Review all ${next.length} step${next.length === 1 ? "" : "s"}`} hint="Lists every step to take, in every feature" onPress={() => setNextOpen(true)} /> : undefined)}
        </>
      )}
    </ScrollView>
  );

  const shown = detail ? items.find((i) => i.key === detail) : undefined;
  const metaOfShown = shown ? metaUnder(shown, now, null) : "";
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {beside ? besidePage : <AnimatedStack items={screens} onBack={() => setPage(null)} />}
      {shown && (
        <Sheet onClose={() => setDetail(null)}>
          {(close, scroll) => {
            const { github, linear } = linksOf(shown);
            const facts = [shown.repo, shown.branch, shown.stack ? stackWord(shown.stack) : null].filter(Boolean).join(" · ");
            const openUrl = (url: string) => void Linking.openURL(url).catch(() => {});
            return (
              <ScrollView ref={scroll} accessibilityLabel="Details" contentContainerStyle={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
                  <Txt variant="heading" style={{ flex: 1 }}>
                    {shown.number !== null ? `#${shown.number} ` : ""}
                    {shown.title}
                  </Txt>
                  <SheetPill label="Close" onPress={close} />
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: `${hueOf(shown, colors)}22` }}>
                    <Txt variant="small" style={{ color: hueOf(shown, colors), fontWeight: "700" }}>
                      {shown.word}
                    </Txt>
                  </View>
                  {!!facts && (
                    <Txt variant="small" tone="ink3" style={{ flexShrink: 1 }}>
                      {facts}
                    </Txt>
                  )}
                </View>
                <Path item={shown} issues={issues} named />
                {(shown.issue || shown.feature) && (
                  <Txt variant="small" tone="ink2">
                    {[shown.issue, shown.feature && `in ${shown.feature}`].filter(Boolean).join(" ")}
                  </Txt>
                )}
                {!!metaOfShown && (
                  <Txt variant="small" tone="ink3">
                    {metaOfShown}
                  </Txt>
                )}
                {shown.next && (
                  <View style={{ borderWidth: 1, borderColor: colors.rule, borderRadius: radius.card, paddingVertical: 10, paddingRight: 14 }}>
                    <Txt variant="small" style={{ fontWeight: "600", paddingLeft: 16 }}>
                      {shown.next.what}…
                    </Txt>
                    {step(shown)}
                  </View>
                )}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {onOpenChat && shown.chat && (
                    <Action
                      label="Open chat"
                      hint={`Opens “${shown.chat.title}”, the chat on its branch`}
                      onPress={() => {
                        const slot = shown.chat!.slot;
                        close();
                        onOpenChat(slot);
                      }}
                    />
                  )}
                  {github && <Action label="GitHub" hint="Opens the pull request" onPress={() => openUrl(github)} />}
                  {linear && <Action label="Linear" hint="Opens the issue" onPress={() => openUrl(linear)} />}
                </View>
              </ScrollView>
            );
          }}
        </Sheet>
      )}
      {/* Every step to take, which can be many, in a sheet of their own. A step is asked from it as from a row. */}
      {nextOpen && (
        <Sheet size="large" onClose={() => setNextOpen(false)}>
          {(close, scroll) => (
            <ScrollView ref={scroll} accessibilityLabel="All next steps" contentContainerStyle={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <Txt variant="heading">Next</Txt>
                <Txt variant="small" tone="ink3">
                  {next.length}
                </Txt>
                <View style={{ marginLeft: "auto" }}>
                  <SheetPill label="Close" onPress={close} />
                </View>
              </View>
              <View style={{ backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.rule, overflow: "hidden" }}>{next.map(nextRow)}</View>
            </ScrollView>
          )}
        </Sheet>
      )}
    </View>
  );
}
