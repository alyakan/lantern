import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Chip, Txt } from "../ui/components";
import { Markdown } from "../ui/Markdown";
import { PressScale } from "../ui/motion";
import { Sheet, SheetBar, type SheetScroll } from "../ui/Sheet";
import { Dots, DiffSkeleton } from "../ui/skeleton";
import { fonts, radius, space, useColors } from "../ui/theme";
import { type ActivityEntry, type ActivityGroup } from "../view/timeline";
import { DiffView } from "./DiffView";

type Filter = "all" | "edits" | "commands" | "messages" | "problems";

const FILTERS: { key: Filter; label: string; has: (e: ActivityEntry) => boolean }[] = [
  { key: "all", label: "All", has: () => true },
  { key: "edits", label: "Edits", has: (e) => e.kind === "step" && e.group === "edit" },
  { key: "commands", label: "Commands", has: (e) => e.kind === "step" && (e.group === "run" || e.group === "test") },
  { key: "messages", label: "Messages", has: (e) => e.kind === "note" },
  { key: "problems", label: "Problems", has: (e) => e.kind === "step" && e.bad },
];

const GLYPH: Record<ActivityGroup, string> = { read: "▤", search: "⌕", edit: "✎", run: "›_", test: "›_", other: "•" };

/** How many of `entries` each filter holds: a filter with none is not offered. */
export function filtersFor(entries: ActivityEntry[]) {
  return FILTERS.filter((f) => f.key === "all" || entries.some(f.has)).map((f) => ({ key: f.key, label: f.label, count: entries.filter(f.has).length }));
}

/** The entries a filter keeps, in the order they happened. */
export function filtered(entries: ActivityEntry[], filter: Filter): ActivityEntry[] {
  const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0];
  return entries.filter(f.has);
}

/** What a row opened to: a message's words, the diffs of the files an edit changed, or what a step printed. */
type Detail = { kind: "note"; text: string } | { kind: "diff"; files: string[]; title: string } | { kind: "output"; id: string; title: string };

/**
 * What a run of steps did and said, as a sheet: every step and message in the order they happened, with filters when there
 * are enough kinds. Each row that has more to it opens a page of its own in the sheet (a message's words, an edit's diff, what a
 * command printed), with a pill back to the list.
 */
export function ActivitySheet({ entries, took, mark, files, onFile, loadDiff, loadOutput, onClose, initial = "all" }: { entries: ActivityEntry[]; took?: string | null; mark?: string; files?: string[]; onFile?: (path: string) => void; /** The Mac's diff of a file the chat changed. */ loadDiff: (path: string) => Promise<string>; /** What a step printed: only where the Mac can say. */ loadOutput?: (id: string) => Promise<string>; onClose: () => void; initial?: Filter }) {
  const colors = useColors();
  const [filter, setFilter] = useState<Filter>(initial);
  const [detail, setDetail] = useState<Detail | null>(null);
  const filters = filtersFor(entries);
  const shown = filtered(entries, filter);
  return (
    <Sheet onClose={onClose} size="large">
      {(close, scroll) => (
        <View style={{ flex: 1 }}>
          <SheetBar title={!detail ? "Activity" : detail.kind === "note" ? "Message" : detail.kind === "diff" ? "What changed" : "What it printed"} close={!detail ? { label: "Close", onPress: close } : { label: "Activity", onPress: () => setDetail(null) }} />
          {detail ? (
            <DetailPage detail={detail} scroll={scroll} mark={mark} files={files} onFile={onFile} loadDiff={loadDiff} loadOutput={loadOutput} />
          ) : (
            <>
              {filters.length > 2 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: space.lg, paddingVertical: 6 }}>
                  {filters.map((f) => (
                    <Chip key={f.key} tone={f.key === filter ? "ok" : "plain"} onPress={() => setFilter(f.key)}>
                      {f.key === "all" ? f.label : `${f.label} ${f.count}`}
                    </Chip>
                  ))}
                </ScrollView>
              )}
              <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 6, paddingBottom: space.lg }}>
                <View accessibilityLabel="Activity" style={{ backgroundColor: colors.card, borderRadius: radius.inner, overflow: "hidden" }}>
                  {shown.map((e, i) => {
                    const border = i === 0 ? {} : { borderTopWidth: 1, borderTopColor: colors.rule };
                    const style = [{ flexDirection: "row" as const, gap: 12, padding: 14, alignItems: "center" as const }, border];
                    if (e.kind === "note") {
                      return (
                        <PressScale key={e.key} accessibilityRole="button" accessibilityLabel={`Message: ${e.text}`} onPress={() => setDetail({ kind: "note", text: e.text })} haptic="select" scaleTo={0.99} style={style}>
                          <Txt tone="ink3" style={{ width: 20, textAlign: "center" }}>
                            💬
                          </Txt>
                          <Txt tone="ink2" numberOfLines={2} style={{ flex: 1 }}>
                            {e.text}
                          </Txt>
                          <Txt tone="ink3">›</Txt>
                        </PressScale>
                      );
                    }
                    const open: Detail | null = e.group === "edit" && e.files.length ? { kind: "diff", files: e.files, title: e.text } : loadOutput && e.outputs ? { kind: "output", id: e.id, title: e.text } : null;
                    const row = (
                      <>
                        <Txt tone={e.bad ? "stop" : "ink3"} style={{ width: 20, textAlign: "center" }}>
                          {GLYPH[e.group]}
                        </Txt>
                        <Txt tone={e.bad ? "stop" : "ink"} numberOfLines={2} style={{ flex: 1 }}>
                          {e.text}
                        </Txt>
                        {e.group === "edit" && (e.added > 0 || e.removed > 0) && (
                          <Txt variant="tiny" tone="ink3">
                            +{e.added} −{e.removed}
                          </Txt>
                        )}
                        {e.running && (
                          <Txt variant="tiny" tone="ink3">
                            …
                          </Txt>
                        )}
                        {open && <Txt tone="ink3">›</Txt>}
                      </>
                    );
                    return open ? (
                      <PressScale key={e.key} accessibilityRole="button" accessibilityLabel={e.text} onPress={() => setDetail(open)} haptic="select" scaleTo={0.99} style={style}>
                        {row}
                      </PressScale>
                    ) : (
                      <View key={e.key} style={style}>
                        {row}
                      </View>
                    );
                  })}
                </View>
                {!!took && (
                  <Txt variant="small" tone="ink3" style={{ textAlign: "center", paddingTop: space.lg }}>
                    Took {took}
                  </Txt>
                )}
              </ScrollView>
            </>
          )}
        </View>
      )}
    </Sheet>
  );
}

function DetailPage({ detail, scroll, mark, files, onFile, loadDiff, loadOutput }: { detail: Detail; scroll: SheetScroll; mark?: string; files?: string[]; onFile?: (path: string) => void; loadDiff: (path: string) => Promise<string>; loadOutput?: (id: string) => Promise<string> }) {
  if (detail.kind === "note")
    return (
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 6, paddingBottom: space.lg }}>
        <Markdown text={detail.text} mark={mark} files={files} onFile={onFile} />
      </ScrollView>
    );
  if (detail.kind === "diff") return <DiffPage files={detail.files} scroll={scroll} load={loadDiff} />;
  return <OutputPage id={detail.id} title={detail.title} scroll={scroll} load={loadOutput} />;
}

/** The diffs of the files an edit changed, one at a time. */
function DiffPage({ files, scroll, load }: { files: string[]; scroll: SheetScroll; load: (path: string) => Promise<string> }) {
  const [path, setPath] = useState(files[0]);
  const [state, setState] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    load(path).then(
      (text) => live && setState({ text }),
      (e: Error) => live && setState({ error: e.message || "That didn't come through." }),
    );
    return () => {
      live = false;
    };
  }, [path, load]);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: 4, paddingBottom: space.md, gap: 8 }}>
        {files.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {files.map((f) => (
              <Chip key={f} tone={f === path ? "ok" : "plain"} onPress={() => setPath(f)}>
                {f.split("/").pop() ?? f}
              </Chip>
            ))}
          </ScrollView>
        )}
        <Txt variant="small" tone="ink2" numberOfLines={1} ellipsizeMode="head">
          {path}
        </Txt>
      </View>
      <ScrollView ref={scroll} style={{ flex: 1 }}>
        {state === null && (
          <View style={{ paddingHorizontal: space.lg }}>
            <DiffSkeleton />
          </View>
        )}
        {state && "error" in state && (
          <Txt tone="stop" style={{ paddingHorizontal: space.lg }}>
            {state.error}
          </Txt>
        )}
        {state && "text" in state && <DiffView path={path} text={state.text} />}
      </ScrollView>
    </View>
  );
}

/** What a step printed, as the Mac sends it. */
function OutputPage({ id, title, scroll, load }: { id: string; title: string; scroll: SheetScroll; load?: (id: string) => Promise<string> }) {
  const colors = useColors();
  const [state, setState] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    load?.(id).then(
      (text) => live && setState({ text }),
      (e: Error) => live && setState({ error: e.message || "That didn't come through." }),
    );
    return () => {
      live = false;
    };
  }, [id, load]);
  return (
    <View style={{ flex: 1, paddingHorizontal: space.lg, gap: 10 }}>
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
        <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.lg }}>
          <Text selectable accessibilityLabel="What it printed" style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: colors.ink }}>
            {state.text.trim() === "" ? "It printed nothing." : state.text}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
