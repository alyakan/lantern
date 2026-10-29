import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useController, useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { Button, Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { DiffSkeleton } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";
import { changedFiles, changesLine } from "../view/changes";
import { DiffView } from "./DiffView";

/**
 * A tablet's right-hand pane: the files the open chat has changed, and a diff of the one chosen, read from the Mac the way the
 * chat's own "What changed" sheet reads it. Read-only: nothing here writes anything.
 */
export function ChangesPane({ slot, onHide, hideLabel = "Hide", inSheet = false, title, float }: { slot: string; onHide: () => void; /** What the button that puts it away says. */ hideLabel?: string; /** On a phone it is a sheet over the chat, which starts below the clock already. */ inSheet?: boolean; /** In place of the "Changes" heading (the phone's sheet: a menu of what it can show). */ title?: ReactNode; /** A tablet's pane beside the chat can float over it as a big card, and go back (`floating` says where it is). */ float?: { floating: boolean; onToggle: () => void } }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const controller = useController();
  const { views } = useSyncState();
  const files = changedFiles((views[slot] ?? emptyView).items);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The file shown is the one chosen while it is still in the list, else the newest.
  const path = files.find((f) => f.path === picked)?.path ?? files[0]?.path ?? null;
  const load = useCallback((p: string) => controller.sync.diff(slot, p), [controller, slot]);
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
  }, [path, load, files.find((f) => f.path === path)?.added, files.find((f) => f.path === path)?.removed]);
  const line = changesLine(files);
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
        <Button label={hideLabel} kind="ghost" onPress={onHide} />
      </View>
      {files.length === 0 ? (
        <Txt variant="body" tone="ink2" style={{ padding: space.lg }}>
          Nothing changed in this chat yet.
        </Txt>
      ) : (
        <>
          <ScrollView style={{ maxHeight: 190, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space.lg - 6, paddingBottom: 6 }}>
            {files.map((f) => (
              <PressScale key={f.path} accessibilityRole="button" accessibilityLabel={`${f.name}, ${f.created ? "new, " : ""}${f.added} added, ${f.removed} removed`} accessibilityState={{ selected: f.path === path }} onPress={() => setPicked(f.path)} haptic="select" scaleTo={0.98} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 8, borderRadius: radius.inner, backgroundColor: f.path === path ? colors.paper : "transparent" }}>
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
              <Txt tone="stop" accessibilityRole="alert" style={{ paddingHorizontal: space.lg }}>
                {error}
              </Txt>
            )}
            {text !== null && path && <DiffView path={path} text={text} />}
          </ScrollView>
        </>
      )}
    </View>
  );
}

/** A window with a card in its middle (float it), or with a pane down its right (put it back beside the chat). */
function FloatIcon({ floating, color }: { floating: boolean; color: string }) {
  return (
    <View accessibilityElementsHidden style={{ width: 22, height: 17, borderRadius: 4, borderWidth: 2, borderColor: color, flexDirection: "row", alignItems: floating ? "stretch" : "center", justifyContent: floating ? "flex-end" : "center", overflow: "hidden" }}>
      {floating ? <View style={{ width: 7, backgroundColor: color }} /> : <View style={{ width: 10, height: 7, borderRadius: 1.5, backgroundColor: color }} />}
    </View>
  );
}
