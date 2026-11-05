import { useEffect, useState, type ReactNode } from "react";
import { Linking, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { loadWorkGrouping, saveWorkGrouping } from "../prefs";
import { useController, useSyncState } from "../shell/hooks";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { TOP_BAR_GAP, TOP_BAR_HEIGHT } from "../ui/TopBar";
import { radius, space, useColors, type Palette } from "../ui/theme";
import { FILTER_TONES, filterItems, foldRows, foldWord, groupingFor, groupItems, lineUnder, linksOf, metaUnder, nextSteps, pathOf, stackWord, standing, stateCounts, toneOf, TONE_WORD, type GroupBy, type Tone, type WorkGroup, type WorkRow } from "../view/work";

export interface WorkProps {
  /** Above the page: Home's top on a phone (the Mac's name, the Desk, Work and Chats switch), the page's own header on a tablet. */
  top: ReactNode;
  /** A tablet's main area: the page is held to a column that reads well. */
  wide?: boolean;
  /** Opens a chat on the Mac (an item's details offer the one on its branch). */
  onOpenChat?: (slot: string) => void;
}

/** How many of Next's steps show before "Show N more" (which opens them all in a sheet), and how many rows of a group (all of it when there is one list). */
const NEXT_SHOWN = 3;
const GROUP_SHOWN = 4;
const LIST_SHOWN = 8;
const COLUMN_MAX = 640;

/** A state's colour, the Mac's: only what needs you is loud (red blocked, blue your call, amber a ticket to move); slate on its way,
 * purple local only, grey not started, teal Ready, green done. */
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
const hueOf = (item: RemoteWorkItem, c: Palette): string => toneColor(item.next?.warn ? "move" : toneOf(item), c);

/** What happened to a step asked for: where it went, or why it didn't. Kept while the item stays in the state it was asked in. */
interface Outcome {
  sig: string;
  text: string;
  bad: boolean;
}

/** An item's path, a node a stage: green behind it, ringed in its colour where it is, grey ahead. */
function Path({ item, issues }: { item: RemoteWorkItem; issues: boolean }) {
  const colors = useColors();
  const tone = hueOf(item, colors);
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

/** One item: its dot and name (which opens its details), a quiet line, and under it what the caller adds. */
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

/** The rail down the left of a stack's rows: it joins each to the one under it, and stops at the top and the bottom. */
function StackRail({ pos, of, color }: { pos: number; of: number; color: string }) {
  const colors = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ position: "absolute", left: 13, top: 0, bottom: 0, width: 10, alignItems: "center" }}>
      <View style={{ position: "absolute", top: pos === 1 ? "50%" : 0, bottom: pos === of ? "50%" : 0, width: 2, backgroundColor: colors.rule }} />
      <View style={{ position: "absolute", top: "50%", marginTop: -5, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: color, backgroundColor: colors.card }} />
    </View>
  );
}

/** A button on an item's details: a page to open, or a chat. */
const Action = ({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) => {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityHint={hint} onPress={onPress} haptic="select" scaleTo={0.95} style={{ minHeight: 36, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.rule, alignItems: "center", justifyContent: "center" }}>
      <Txt variant="small" style={{ fontWeight: "600" }}>
        {label}
      </Txt>
    </PressScale>
  );
};

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
export function WorkScreen({ top, wide = false, onOpenChat }: WorkProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const controller = useController();
  const { work } = useSyncState();
  const [chosen, setChosen] = useState<GroupBy | "auto">("auto");
  const [only, setOnly] = useState<Tone[]>([]);
  const [folded, setFolded] = useState<string[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  // The folded lines (Ready, or done) that were opened.
  const [openFolds, setOpenFolds] = useState<string[]>([]);
  const [nextOpen, setNextOpen] = useState(false);
  // The item whose details are open, by key: they follow it as it moves on, and close if it goes.
  const [detail, setDetail] = useState<string | null>(null);
  // How tall the bar over the list is (with the status bar's room above it): the list starts below it.
  const [barHeight, setBarHeight] = useState(0);
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
  const looked = work?.looked === true;
  const blind = work?.blind ?? [];
  const by = groupingFor(chosen, issues);
  const next = nextSteps(items);
  const nextShown = next.slice(0, NEXT_SHOWN);
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

  /** One of Next's steps, in the card and in the sheet that lists them all (its outcome and busy state are this screen's, so they carry across). */
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

  const nextCard = (
    <Card title="Next" count={next.length} edge={colors.cobalt} action={<Link label="Refresh" onPress={refresh} />}>
      {/* The Mac says when it couldn't tell whose pull requests are yours: they aren't listed, and that isn't "nothing open". */}
      {blind.length > 0 && (
        <Txt variant="small" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
          Couldn't tell which GitHub account is yours in {blind.join(", ")}, so its pull requests aren't shown. Refresh to try again.
        </Txt>
      )}
      {next.length === 0 ? (
        <Txt variant="small" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          {!looked
            ? "Your Mac hasn't looked yet: open a project on it to see its work."
            : items.length === 0
              ? `Nothing open: no pull requests of yours, nothing waiting to be released, no branches left unpushed${issues ? ", no issues to start" : ""}.`
              : "Nothing to do right now: everything open is on its way."}
        </Txt>
      ) : (
        <>
          {nextShown.map(nextRow)}
          {next.length > nextShown.length && (
            <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
              <Link label={`Show ${next.length - nextShown.length} more`} onPress={() => setNextOpen(true)} />
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

  /** One piece of work where it stands, in two quiet lines (its name and state, then its issue, where it is and its place in a
   * stack). Its path, pages and step are in its details, which a tap opens. */
  const row = (i: RemoteWorkItem, heading: string | null, n: number) => {
    const hue = hueOf(i, colors);
    const line = lineUnder(i, now, heading);
    return (
      <View key={i.key} style={n > 0 ? { borderTopWidth: 1, borderTopColor: colors.rule } : undefined}>
        <PressScale
          accessibilityRole="button"
          accessibilityLabel={`${i.number !== null ? `#${i.number} ` : ""}${i.title}, ${i.word}${line ? `, ${line}` : ""}`}
          accessibilityHint="Opens its details"
          onPress={() => setDetail(i.key)}
          scaleTo={0.99}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 10, paddingRight: 14, paddingLeft: i.stack ? 32 : 14 }}
        >
          {i.stack && <StackRail pos={i.stack.pos} of={i.stack.of} color={hue} />}
          {!i.stack && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hue, marginTop: 7 }} />}
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Txt variant="body" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
                {i.number !== null && (
                  <Txt variant="small" tone="ink3">
                    #{i.number}{" "}
                  </Txt>
                )}
                {i.title}
              </Txt>
              <Txt variant="tiny" numberOfLines={1} style={{ color: hue, fontWeight: "700", maxWidth: "45%" }}>
                {i.word}
              </Txt>
            </View>
            {!!line && (
              <Txt variant="small" tone="ink3" numberOfLines={1}>
                {line}
              </Txt>
            )}
          </View>
        </PressScale>
      </View>
    );
  };

  /** Several quiet pieces of work (Ready, or done) in one line that opens to a row for each. */
  const foldRow = (r: Extract<WorkRow, { kind: "fold" }>, scope: string, heading: string | null, n: number) => {
    const key = `${scope}|${r.fold}`;
    const isOpen = openFolds.includes(key);
    return (
      <View key={key} style={n > 0 ? { borderTopWidth: 1, borderTopColor: colors.rule } : undefined}>
        <PressScale accessibilityRole="button" accessibilityLabel={foldWord(r.fold, r.items.length)} accessibilityState={{ expanded: isOpen }} onPress={() => toggle(openFolds, setOpenFolds, key)} haptic="select" scaleTo={0.99} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Txt variant="small" tone="ink3" style={{ width: 10 }}>
            {isOpen ? "▾" : "▸"}
          </Txt>
          <Txt variant="small" tone="ink2" style={{ fontWeight: "600" }}>
            {foldWord(r.fold, r.items.length)}
          </Txt>
        </PressScale>
        {isOpen && r.items.map((i, k) => row(i, heading, k + 1))}
      </View>
    );
  };
  /** A list as rows: Ready and done pieces fold into a line each, unless a state was chosen to be looked at. */
  const rowsOf = (items: RemoteWorkItem[]): WorkRow[] => (only.length === 0 ? foldRows(items) : items.map((item) => ({ kind: "item" as const, item })));
  const drawRow = (r: WorkRow, scope: string, heading: string | null, n: number) => (r.kind === "item" ? row(r.item, heading, n) : foldRow(r, scope, heading, n));

  const group = (g: WorkGroup) => {
    const key = `${by}:${g.key}`;
    const isFolded = folded.includes(key);
    const all = open.includes(key);
    const rows = rowsOf(g.items);
    const shown = all ? rows : rows.slice(0, GROUP_SHOWN);
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
            {shown.map((r, n) => drawRow(r, key, g.plain ? null : g.label, n))}
            {rows.length > shown.length && (
              <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
                <Link label={`Show ${rows.length - shown.length} more`} onPress={() => setOpen([...open, key])} />
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  const shown = detail ? items.find((i) => i.key === detail) : undefined;
  const metaOfShown = shown ? metaUnder(shown, now, null) : "";
  const flatRows = flat ? rowsOf(groups[0]?.items ?? []) : [];
  const flatShown = open.includes("all") ? flatRows : flatRows.slice(0, LIST_SHOWN);
  const standCard = (
    <Card title="Where things stand" count={listed.length}>
      {bar}
      {groups.length === 0 ? (
        <Txt variant="small" tone="ink2" style={{ padding: 14 }}>
          Nothing is {only.map((t) => TONE_WORD[t]).join(" or ")}.
        </Txt>
      ) : flat ? (
        <>
          {flatShown.map((r, n) => drawRow(r, "all", null, n))}
          {flatRows.length > flatShown.length && (
            <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
              <Link label={`Show ${flatRows.length - flatShown.length} more`} onPress={() => setOpen([...open, "all"])} />
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
      <ScrollView
        accessibilityLabel="Your work"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: (barHeight || insets.top + TOP_BAR_GAP + TOP_BAR_HEIGHT) + 12, paddingBottom: insets.bottom + 40, gap: 14, ...(wide ? { width: "100%", maxWidth: COLUMN_MAX, alignSelf: "center" } : {}) }}
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
      {/* The bar floats over the list, which scrolls under it. The status bar's own strip is paper, so words don't run under the clock. */}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: colors.paper }} />
      <View testID="work-bar" pointerEvents="box-none" onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: insets.top + TOP_BAR_GAP }}>
        {top}
      </View>
      {shown && (
        <Sheet onClose={() => setDetail(null)}>
          {(close, scroll) => {
            const { github, linear } = linksOf(shown);
            const facts = [shown.repo, shown.branch, shown.stack ? stackWord(shown.stack) : null].filter(Boolean).join(" · ");
            const open = (url: string) => void Linking.openURL(url).catch(() => {});
            return (
              <ScrollView ref={scroll} accessibilityLabel="Details" contentContainerStyle={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
                  <Txt variant="heading" style={{ flex: 1 }}>
                    {shown.number !== null ? `#${shown.number} ` : ""}
                    {shown.title}
                  </Txt>
                  <Link label="Done" onPress={close} />
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
                <Path item={shown} issues={issues} />
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
                  {github && <Action label="GitHub" hint="Opens the pull request" onPress={() => open(github)} />}
                  {linear && <Action label="Linear" hint="Opens the issue" onPress={() => open(linear)} />}
                </View>
              </ScrollView>
            );
          }}
        </Sheet>
      )}
      {/* All of Next's steps, which can be many, in a sheet of their own. A step is asked from it as from the card. */}
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
                  <Link label="Done" onPress={close} />
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
