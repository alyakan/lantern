import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Chip, Txt } from "../ui/components";
import { Markdown } from "../ui/Markdown";
import { PressScale } from "../ui/motion";
import { Sheet, SheetBar } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";
import { type ActivityEntry, type ActivityGroup } from "../view/timeline";

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

/** After a sheet is put away, what a row opens (a diff, what a command printed) comes up in its place. */
const HANDOFF_MS = 400;

/**
 * What a run of steps did and said, as a sheet: every step and message in the order they happened, with filters when there
 * are enough kinds. A message opens to its words here; an edit opens its diff and a command what it printed (the sheets the
 * chips used to open), once this one is put away.
 */
export function ActivitySheet({ entries, took, mark, files, onFile, onFiles, onOutput, onClose, initial = "all" }: { entries: ActivityEntry[]; took?: string | null; mark?: string; files?: string[]; onFile?: (path: string) => void; onFiles: (files: string[]) => void; onOutput?: (step: { id: string; text: string }) => void; onClose: () => void; initial?: Filter }) {
  const colors = useColors();
  const [filter, setFilter] = useState<Filter>(initial);
  const [note, setNote] = useState<string | null>(null);
  const filters = filtersFor(entries);
  const shown = filtered(entries, filter);
  return (
    <Sheet onClose={onClose} size="large">
      {(close, scroll) => {
        const handoff = (open: () => void) => {
          close();
          setTimeout(open, HANDOFF_MS);
        };
        return (
          <View style={{ flex: 1 }}>
            <SheetBar title={note === null ? "Activity" : "Message"} close={note === null ? { label: "Close", onPress: close } : { label: "Activity", onPress: () => setNote(null) }} />
            {note === null && filters.length > 2 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: space.lg, paddingVertical: 6 }}>
                {filters.map((f) => (
                  <Chip key={f.key} tone={f.key === filter ? "ok" : "plain"} onPress={() => setFilter(f.key)}>
                    {f.key === "all" ? f.label : `${f.label} ${f.count}`}
                  </Chip>
                ))}
              </ScrollView>
            )}
            <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 6, paddingBottom: space.lg }}>
              {note !== null ? (
                <Markdown text={note} mark={mark} files={files} onFile={onFile} />
              ) : (
                <View accessibilityLabel="Activity" style={{ backgroundColor: colors.card, borderRadius: radius.inner, overflow: "hidden" }}>
                  {shown.map((e, i) => {
                    const first = i === 0;
                    const border = first ? {} : { borderTopWidth: 1, borderTopColor: colors.rule };
                    if (e.kind === "note") {
                      return (
                        <PressScale key={e.key} accessibilityRole="button" accessibilityLabel={`Message: ${e.text}`} onPress={() => setNote(e.text)} haptic="select" scaleTo={0.99} style={[{ flexDirection: "row", gap: 12, padding: 14, alignItems: "center" }, border]}>
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
                    const open = e.group === "edit" && e.files.length ? () => handoff(() => onFiles(e.files)) : onOutput && (e.group === "run" || e.group === "test") ? () => handoff(() => onOutput({ id: e.id, text: e.text })) : undefined;
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
                    const style = [{ flexDirection: "row" as const, gap: 12, padding: 14, alignItems: "center" as const }, border];
                    return open ? (
                      <PressScale key={e.key} accessibilityRole="button" accessibilityLabel={e.text} onPress={open} haptic="select" scaleTo={0.99} style={style}>
                        {row}
                      </PressScale>
                    ) : (
                      <View key={e.key} style={style}>
                        {row}
                      </View>
                    );
                  })}
                </View>
              )}
              {note === null && !!took && (
                <Txt variant="small" tone="ink3" style={{ textAlign: "center", paddingTop: space.lg }}>
                  Took {took}
                </Txt>
              )}
            </ScrollView>
          </View>
        );
      }}
    </Sheet>
  );
}
