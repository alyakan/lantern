import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteChangeScope } from "../protocol/generated/RemoteChangeScope";
import { useController, useSyncState } from "../shell/hooks";
import { useMacCan } from "../shell/useControls";
import { emptyView } from "../sync/reducer";
import { Button, Txt } from "../ui/components";
import { SheetPill } from "../ui/Sheet";
import { PressScale } from "../ui/motion";
import { DiffSkeleton } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";
import { changedFileOf, changedFiles, changesLine, EMPTY_SCOPE, fromMac, inEditOrder, SCOPES, withLinked, type ChangedFile } from "../view/changes";
import { DiffView } from "./DiffView";

/**
 * A tablet's right-hand pane: the files changed, and a diff of the one chosen, read from the Mac the way the chat's own "What
 * changed" sheet reads it. Read-only: nothing here writes anything. A Mac that lists "changescopes" shows three views, as its own
 * Changes tab does: what the chat changed, everything uncommitted, and the branch's commits.
 */
export function ChangesPane({ slot, onHide, hideLabel = "Hide", inSheet = false, title, float, focus }: { slot: string; onHide: () => void; /** What the button that puts it away says. */ hideLabel?: string; /** On a phone it is a sheet over the chat, which starts below the clock already. */ inSheet?: boolean; /** In place of the "Changes" heading (the phone's sheet: a menu of what it can show). */ title?: ReactNode; /** A tablet's pane beside the chat can float over it as a big card, and go back (`floating` says where it is). */ float?: { floating: boolean; onToggle: () => void }; /** A file link tapped in the chat: the file to show, listed or not (`n` counts the taps, so the same file tapped again is picked again). */ focus?: { path: string; n: number } }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const controller = useController();
  const { views } = useSyncState();
  const canScopes = useMacCan("changescopes");
  const [scope, setScope] = useState<RemoteChangeScope>("chat");
  const local = changedFiles((views[slot] ?? emptyView).items);
  // The Mac's list of the view: for the chat it also has what changed beside Claude's edits (a script's). Asked again when
  // the chat edits something, which changes the other views too.
  const [listed, setListed] = useState<{ scope: RemoteChangeScope; files: ChangedFile[]; base: string | null } | { scope: RemoteChangeScope; error: string } | null>(null);
  const edits = `${local.length}:${local.reduce((n, f) => n + f.added + f.removed, 0)}`;
  // Try again after a list or a diff that didn't come: asked again by bumping this.
  const [asks, setAsks] = useState(0);
  const again = () => setAsks((n) => n + 1);
  useEffect(() => {
    if (!canScopes) return;
    let live = true;
    controller.sync.changes(slot, scope).then(
      (c) => live && setListed({ scope, files: fromMac(c.files), base: c.base }),
      (e: Error) => live && setListed({ scope, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [canScopes, controller, slot, scope, edits, asks]);
  const mine = listed?.scope === scope ? listed : null;
  // The chat's own edits stand in until the Mac's list comes (and are all there is from an older Mac).
  const known: ChangedFile[] | null = mine && "files" in mine ? (scope === "chat" ? inEditOrder(mine.files, local) : mine.files) : scope === "chat" ? local : null;
  const failed = mine && "error" in mine ? mine.error : null;
  // A file a link named stays on the list, at its top, when it isn't one of it.
  const [linked, setLinked] = useState<string | null>(focus?.path ?? null);
  const [picked, setPicked] = useState<string | null>(focus?.path ?? null);
  useEffect(() => {
    if (!focus) return;
    setLinked(focus.path);
    setPicked(focus.path);
  }, [focus?.n]);
  const files = known ? withLinked(known, linked) : linked ? withLinked([], linked) : [];
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The file shown is the one chosen while it is still in the list, else the first.
  const path = (picked ? changedFileOf(files, picked) : null) ?? files[0]?.path ?? null;
  const shownFile = files.find((f) => f.path === path);
  const load = useCallback((p: string) => controller.sync.diff(slot, p, canScopes ? scope : undefined), [controller, slot, scope, canScopes]);
  useEffect(() => {
    if (!path) return;
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
    // The diff of a file is read again when the file's own counts change (Claude edited it again).
  }, [path, load, shownFile?.added, shownFile?.removed, asks]);
  const pickScope = (s: RemoteChangeScope) => {
    if (s === scope) return;
    setScope(s);
    setPicked(null);
    setLinked(null);
  };
  const line = [changesLine(files.filter((f) => !f.linked)), scope === "branch" && mine && "files" in mine && mine.base ? `against ${mine.base}` : null].filter(Boolean).join(" · ");
  return (
    <View testID="changes-pane" style={{ flex: 1, backgroundColor: colors.card, paddingTop: inSheet || float?.floating ? 16 : insets.top + 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingBottom: 8 }}>
        <View style={{ flex: 1 }}>
          {title ?? (
            <Txt variant="heading" accessibilityRole="header">
              Changes
            </Txt>
          )}
          {!!line && (
            <Txt variant="small" tone="ink2">
              {line}
            </Txt>
          )}
        </View>
        {float && (
          <PressScale accessibilityRole="button" accessibilityLabel={float.floating ? "Put the changes beside the chat" : "Float the changes over the chat"} onPress={float.onToggle} haptic="select" hitSlop={8} scaleTo={0.88} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <FloatIcon floating={float.floating} color={colors.ink} />
          </PressScale>
        )}
        <SheetPill label={hideLabel} onPress={onHide} />
      </View>
      {canScopes && <ScopeSwitch value={scope} onChange={pickScope} />}
      {files.length === 0 ? (
        known || failed ? (
          <View style={{ padding: space.lg, gap: 4, alignItems: "flex-start" }}>
            <Txt variant="body" tone="ink2" accessibilityRole={failed ? "alert" : undefined}>
              {failed ?? EMPTY_SCOPE[scope]}
            </Txt>
            {failed && <Button label="Try again" kind="ghost" onPress={again} />}
          </View>
        ) : (
          <View style={{ padding: space.lg }}>
            <DiffSkeleton />
          </View>
        )
      ) : (
        <>
          <ScrollView style={{ maxHeight: 190, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space.lg - 6, paddingBottom: 6 }}>
            {files.map((f) => (
              <PressScale key={f.path} accessibilityRole="button" accessibilityLabel={f.linked ? `${f.name}, from a link` : `${f.name}, ${f.created ? "new, " : ""}${f.added} added, ${f.removed} removed`} accessibilityState={{ selected: f.path === path }} onPress={() => setPicked(f.path)} haptic="select" scaleTo={0.98} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 8, borderRadius: radius.inner, backgroundColor: f.path === path ? colors.paper : "transparent" }}>
                <View style={{ flex: 1 }}>
                  <Txt variant="small" numberOfLines={1} style={{ fontWeight: "700" }}>
                    {f.name}
                  </Txt>
                  {!!f.folder && (
                    <Txt variant="tiny" tone="ink3" numberOfLines={1}>
                      {f.folder}
                    </Txt>
                  )}
                </View>
                {f.linked ? (
                  <Txt variant="tiny" tone="ink3">
                    linked
                  </Txt>
                ) : (
                  <>
                    {f.created && (
                      <Txt variant="tiny" tone="go" style={{ fontWeight: "700" }}>
                        new
                      </Txt>
                    )}
                    <Txt variant="tiny" tone="go">
                      +{f.added}
                    </Txt>
                    <Txt variant="tiny" tone="stop">
                      −{f.removed}
                    </Txt>
                  </>
                )}
              </PressScale>
            ))}
          </ScrollView>
          <View style={{ height: 1, backgroundColor: colors.rule }} />
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: space.lg, paddingBottom: insets.bottom + 16 }}>
            {path && (
              <Txt variant="tiny" tone="ink3" numberOfLines={1} ellipsizeMode="head" style={{ marginBottom: 6, paddingHorizontal: space.lg }}>
                {path}
              </Txt>
            )}
            {text === null && !error && (
              <View style={{ paddingHorizontal: space.lg }}>
                <DiffSkeleton />
              </View>
            )}
            {!!error && (
              <View style={{ paddingHorizontal: space.lg, gap: 4, alignItems: "flex-start" }}>
                <Txt tone="stop" accessibilityRole="alert">
                  {error}
                </Txt>
                <Button label="Try again" kind="ghost" onPress={again} />
              </View>
            )}
            {text !== null && path && <DiffView path={path} text={text} />}
          </ScrollView>
        </>
      )}
    </View>
  );
}

/** The pane's three views, as the Mac's Changes tab has them. */
function ScopeSwitch({ value, onChange }: { value: RemoteChangeScope; onChange: (s: RemoteChangeScope) => void }) {
  const colors = useColors();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", alignSelf: "flex-start", marginHorizontal: space.lg, marginBottom: 8, backgroundColor: colors.paper, borderRadius: radius.pill, padding: 3, borderWidth: 1, borderColor: colors.rule }}>
      {SCOPES.map((s) => (
        <PressScale key={s.value} accessibilityRole="tab" accessibilityState={{ selected: value === s.value }} onPress={() => onChange(s.value)} haptic="select" scaleTo={0.94} style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: value === s.value ? colors.ink : "transparent" }}>
          <Txt variant="small" tone={value === s.value ? "on-ink" : "ink2"} style={{ fontWeight: "700" }}>
            {s.label}
          </Txt>
        </PressScale>
      ))}
    </View>
  );
}

/** A window with a card in its middle (float it), or with a pane down its right (put it back beside the chat). */
export function FloatIcon({ floating, color }: { floating: boolean; color: string }) {
  return (
    <View accessibilityElementsHidden style={{ width: 22, height: 17, borderRadius: 4, borderWidth: 2, borderColor: color, flexDirection: "row", alignItems: floating ? "stretch" : "center", justifyContent: floating ? "flex-end" : "center", overflow: "hidden" }}>
      {floating ? <View style={{ width: 7, backgroundColor: color }} /> : <View style={{ width: 10, height: 7, borderRadius: 1.5, backgroundColor: color }} />}
    </View>
  );
}
