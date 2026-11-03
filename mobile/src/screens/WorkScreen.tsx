import { useEffect, useState, type ReactNode } from "react";
import { Linking, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { loadWorkGrouping, saveWorkGrouping } from "../prefs";
import { useController, useSyncState } from "../shell/hooks";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Dots } from "../ui/skeleton";
import { radius, space, useColors, type Palette } from "../ui/theme";
import { FILTER_TONES, filterItems, groupingFor, groupItems, metaUnder, nextSteps, pathOf, safeLink, standing, stateCounts, toneOf, TONE_WORD, type GroupBy, type Tone, type WorkGroup } from "../view/work";

export interface WorkProps {
  /** Above the page: Home's top on a phone (the Mac's name, the Desk, Work and Chats switch), the page's own header on a tablet. */
  top: ReactNode;
  /** A tablet's main area: the page is held to a column that reads well. */
  wide?: boolean;
}

/** How many of Next's steps show before "Show N more", and how many rows of a group (all of it when there is one list). */
const NEXT_SHOWN = 3;
const GROUP_SHOWN = 4;
const LIST_SHOWN = 8;
const COLUMN_MAX = 640;

/** A state's colour: the Mac's (red blocked, blue your call, amber on its way, purple local only, grey not started, green done). */
function toneColor(tone: Tone, c: Palette): string {
  switch (tone) {
    case "bad":
      return c.stop;
    case "you":
      return c.cobalt;
    case "wait":
      return c.isDark ? "#e0a43a" : "#a86b00";
    case "local":
      return c.isDark ? "#b794f4" : "#7c4fd0";
    case "todo":
      return c.ink3;
    case "done":
      return c.go;
  }
}

/** What happened to a step asked for: where it went, or why it didn't. Kept while the item stays in the state it was asked in. */
interface Outcome {
  sig: string;
  text: string;
  bad: boolean;
}

/** An item's path, a node a stage: green behind it, ringed in its colour where it is, grey ahead. */
function Path({ item, issues }: { item: RemoteWorkItem; issues: boolean }) {
  const colors = useColors();
  const tone = toneColor(toneOf(item), colors);
  const nodes = pathOf(item, issues);
  const at = nodes.find((n) => n.state === "now") ?? nodes[nodes.length - 1];
  return (
    <View accessible accessibilityLabel={`At ${at.label}, ${TONE_WORD[toneOf(item)]}`} style={{ flexDirection: "row", alignItems: "center", marginTop: 8, marginRight: 6 }}>
      {nodes.map((n, i) => (
        <View key={n.stage} style={{ flexDirection: "row", alignItems: "center", flex: i === 0 ? 0 : 1 }}>
          {i > 0 && <View style={{ flex: 1, height: 2, backgroundColor: n.state === "past" || n.state === "now" ? colors.go : colors.rule }} />}
          <View
            style={
              n.state === "now"
                ? { width: 15, height: 15, borderRadius: 8, borderWidth: 3, borderColor: tone, backgroundColor: colors.card }
                : { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderStyle: n.state === "skip" ? "dashed" : "solid", borderColor: n.state === "past" ? colors.go : colors.rule, backgroundColor: n.state === "past" ? colors.go : colors.card }
            }
          />
        </View>
      ))}
    </View>
  );
}

/** One item: its dot and name (a link to its page when it has one), a quiet line, and under it what the caller adds. */
function Item({ item, meta, lead, children }: { item: RemoteWorkItem; meta: string; lead?: string; children?: ReactNode }) {
  const colors = useColors();
  const tone = toneColor(toneOf(item), colors);
  const link = safeLink(item.url) ? item.url : null;
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
        {link ? (
          <PressScale accessibilityRole="link" accessibilityHint="Opens the page" onPress={() => void Linking.openURL(link).catch(() => {})} scaleTo={0.99} style={{ flex: 1 }}>
            {name}
          </PressScale>
        ) : (
          <View style={{ flex: 1 }}>{name}</View>
        )}
      </View>
      <Txt variant="small" tone="ink3" style={{ paddingLeft: 16 }}>
        {meta}
      </Txt>
      {children}
    </View>
  );
}

/** A card with a heading and a count, and what goes in it. */
function Card({ title, count, edge, action, children }: { title: string; count: number; edge?: string; action?: ReactNode; children: ReactNode }) {
  const colors = useColors();
  return (
    <View accessibilityLabel={title} style={{ backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: edge ?? colors.rule, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, backgroundColor: edge ? `${edge}14` : "transparent" }}>
        <Txt variant="heading">{title}</Txt>
        <Txt variant="small" tone="ink3">
          {count}
        </Txt>
        <View style={{ marginLeft: "auto" }}>{action}</View>
      </View>
      {children}
    </View>
  );
}

const Link = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <PressScale accessibilityRole="button" onPress={onPress} hitSlop={8} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
    <Txt variant="small" tone="cobalt" style={{ fontWeight: "600" }}>
      {label}
    </Txt>
  </PressScale>
);

/** A row of dots and counts, one for each state: a group's work at a glance. */
function Dotted({ items }: { items: RemoteWorkItem[] }) {
  const colors = useColors();
  const counts = stateCounts(items);
  const shown = FILTER_TONES.filter((t) => t !== "done" && counts[t]);
  return (
    <View accessible accessibilityLabel={shown.map((t) => `${counts[t]} ${TONE_WORD[t]}`).join(", ")} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      {shown.map((t) => (
        <View key={t} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneColor(t, colors) }} />
          <Txt variant="tiny" tone="ink2">
            {counts[t]}
          </Txt>
        </View>
      ))}
    </View>
  );
}

/** Where the user's work stands, and what to do next: the Mac works it out, this shows it, and a step is asked of the Mac. */
export function WorkScreen({ top, wide = false }: WorkProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const controller = useController();
  const { work } = useSyncState();
  const [chosen, setChosen] = useState<GroupBy | "auto">("auto");
  const [only, setOnly] = useState<Tone[]>([]);
  const [folded, setFolded] = useState<string[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  const [allNext, setAllNext] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    void loadWorkGrouping().then((g) => live && setChosen(g));
    return () => {
      live = false;
    };
  }, []);
  const now = Date.now();
  const items = work?.items ?? [];
  const issues = work?.issues === true;
  const by = groupingFor(chosen, issues);
  const next = nextSteps(items);
  const nextShown = allNext ? next : next.slice(0, NEXT_SHOWN);
  const listed = standing(items);
  const groups = groupItems(filterItems(listed, only), by);
  const flat = by === "none" || (groups.length === 1 && (by === "project" || groups[0].plain));
  const counts = stateCounts(listed);

  const pick = (g: GroupBy) => {
    setChosen(g);
    void saveWorkGrouping(g);
  };
  const toggle = (list: string[], set: (l: string[]) => void, key: string) => set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
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
            accessibilityHint={item.next.yours ? "Asks a chat to get it ready; it asks you before anything happens" : "Sends this to a chat on your Mac"}
            accessibilityState={{ disabled: busy === item.key }}
            disabled={busy === item.key}
            onPress={() => run(item)}
            haptic="select"
            scaleTo={0.95}
            style={{ alignSelf: "flex-start", minHeight: 36, paddingHorizontal: 16, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: item.next.yours ? colors.hi : colors.ink, opacity: busy === item.key ? 0.5 : 1 }}
          >
            <Txt variant="small" tone={item.next.yours ? "on-hi" : "on-ink"} style={{ fontWeight: "700" }}>
              {busy === item.key ? "Asking your Mac…" : item.next.button}
            </Txt>
          </PressScale>
        )}
      </View>
    );
  };

  const nextCard = (
    <Card title="Next" count={next.length} edge={colors.cobalt} action={<Link label="Refresh" onPress={refresh} />}>
      {next.length === 0 ? (
        <Txt variant="small" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          {items.length === 0 ? `Nothing open: no pull requests of yours, nothing waiting to be released, no branches left unpushed${issues ? ", no issues to start" : ""}.` : "Nothing to do right now: everything open is on its way."}
        </Txt>
      ) : (
        <>
          {nextShown.map((i, n) => (
            <View key={i.key} style={n > 0 ? { borderTopWidth: 1, borderTopColor: colors.rule } : undefined}>
              <Item item={i} lead={i.next?.what} meta={`${i.word} · ${metaUnder(i, now, null)}`}>
                {step(i)}
              </Item>
            </View>
          ))}
          {next.length > nextShown.length && (
            <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
              <Link label={`Show ${next.length - nextShown.length} more`} onPress={() => setAllNext(true)} />
            </View>
          )}
        </>
      )}
    </Card>
  );

  const bar = (
    <View style={{ gap: 8, paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.rule }}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Group by" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Txt variant="tiny" tone="ink3">
          Group by
        </Txt>
        {(["feature", "project", "none"] as const).map((g) => {
          const off = g === "feature" && !issues;
          return (
            <PressScale key={g} accessibilityRole="radio" accessibilityLabel={g === "feature" ? "Feature" : g === "project" ? "Project" : "None"} accessibilityHint={off ? "Needs Linear on your Mac" : undefined} accessibilityState={{ checked: by === g, disabled: off }} disabled={off} onPress={() => pick(g)} haptic="select" scaleTo={0.94} style={{ paddingHorizontal: 11, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: by === g ? colors.ink : "transparent", borderWidth: 1, borderColor: by === g ? colors.ink : colors.rule, opacity: off ? 0.4 : 1 }}>
              <Txt variant="small" tone={by === g ? "on-ink" : "ink2"} style={{ fontWeight: "600" }}>
                {g === "feature" ? "Feature" : g === "project" ? "Project" : "None"}
              </Txt>
            </PressScale>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {FILTER_TONES.filter((t) => counts[t]).map((t) => {
          const on = only.includes(t);
          return (
            <PressScale key={t} accessibilityRole="button" accessibilityLabel={`${TONE_WORD[t]} ${counts[t]}`} accessibilityState={{ selected: on }} onPress={() => setOnly(on ? only.filter((x) => x !== t) : [...only, t])} haptic="select" scaleTo={0.94} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: on ? toneColor(t, colors) : colors.rule, backgroundColor: on ? `${toneColor(t, colors)}22` : "transparent" }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneColor(t, colors) }} />
              <Txt variant="small">
                {TONE_WORD[t]} {counts[t]}
              </Txt>
            </PressScale>
          );
        })}
        {only.length > 0 && <Link label="Show all" onPress={() => setOnly([])} />}
      </View>
    </View>
  );

  const row = (i: RemoteWorkItem, heading: string | null, n: number) => (
    <View key={i.key} style={n > 0 ? { borderTopWidth: 1, borderTopColor: colors.rule } : undefined}>
      <Item item={i} meta={metaUnder(i, now, heading)}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 16 }}>
          <Txt variant="tiny" style={{ color: toneColor(toneOf(i), colors), fontWeight: "700" }}>
            {i.word}
          </Txt>
        </View>
        <View style={{ paddingLeft: 16 }}>
          <Path item={i} issues={issues} />
        </View>
      </Item>
    </View>
  );

  const group = (g: WorkGroup) => {
    const key = `${by}:${g.key}`;
    const isFolded = folded.includes(key);
    const all = open.includes(key);
    const shown = all ? g.items : g.items.slice(0, GROUP_SHOWN);
    return (
      <View key={key} style={{ borderTopWidth: 1, borderTopColor: colors.rule }}>
        <PressScale accessibilityRole="button" accessibilityLabel={g.label} accessibilityState={{ expanded: !isFolded }} onPress={() => toggle(folded, setFolded, key)} haptic="select" scaleTo={0.99} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.wash }}>
          <Txt variant="small" tone="ink3" style={{ width: 10 }}>
            {isFolded ? "▸" : "▾"}
          </Txt>
          <Txt variant="small" style={{ fontWeight: "700" }}>
            {g.label}
          </Txt>
          <Dotted items={g.items} />
          {(g.doing > 0 || g.todo > 0) && (
            <Txt variant="tiny" tone="ink3" style={{ marginLeft: "auto" }}>
              {[g.doing > 0 && `${g.doing} doing`, g.todo > 0 && `${g.todo} to start`].filter(Boolean).join(" · ")}
            </Txt>
          )}
        </PressScale>
        {!isFolded && (
          <>
            {shown.map((i, n) => row(i, g.plain ? null : g.label, n))}
            {g.items.length > shown.length && (
              <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
                <Link label={`Show ${g.items.length - shown.length} more`} onPress={() => setOpen([...open, key])} />
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  const flatItems = flat ? (groups[0]?.items ?? []) : [];
  const flatShown = open.includes("all") ? flatItems : flatItems.slice(0, LIST_SHOWN);
  const standCard = (
    <Card title="Where things stand" count={listed.length}>
      {bar}
      {groups.length === 0 ? (
        <Txt variant="small" tone="ink2" style={{ padding: 14 }}>
          Nothing is {only.map((t) => TONE_WORD[t]).join(" or ")}.
        </Txt>
      ) : flat ? (
        <>
          {flatShown.map((i, n) => row(i, null, n))}
          {flatItems.length > flatShown.length && (
            <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
              <Link label={`Show ${flatItems.length - flatShown.length} more`} onPress={() => setOpen([...open, "all"])} />
            </View>
          )}
        </>
      ) : (
        groups.map(group)
      )}
    </Card>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <View style={{ paddingTop: insets.top + 8 }}>{top}</View>
      <ScrollView
        accessibilityLabel="Your work"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: insets.bottom + 40, gap: 14, ...(wide ? { width: "100%", maxWidth: COLUMN_MAX, alignSelf: "center" } : {}) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="transparent" colors={["transparent"]} progressBackgroundColor="transparent" />}
      >
        {work === null ? (
          <View accessibilityLabel="Loading your work" accessible style={{ alignItems: "center", paddingVertical: 40 }}>
            <Dots />
          </View>
        ) : (
          <>
            {nextCard}
            {items.length > 0 && standCard}
          </>
        )}
      </ScrollView>
    </View>
  );
}
