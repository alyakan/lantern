import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useController, useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { ArtifactPage } from "../ui/ArtifactPage";
import { Button, Txt } from "../ui/components";
import { Markdown } from "../ui/Markdown";
import { PressScale } from "../ui/motion";
import { DiffSkeleton } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";
import { changedFiles } from "../view/changes";
import { ago } from "../view/home";
import { artifactFolder, artifactTitle, KIND_LABEL, MERMAID_NOTE, WEB_NOTE, type Artifact } from "../view/artifacts";
import { FloatIcon } from "./ChangesPane";

/**
 * What the open chat's folder keeps in `.lantern/artifacts/` on the Mac (pages, pictures, notes and diagrams Claude wrote to be
 * looked at), read over the same connection as the chat. Read-only: nothing here writes anything. HTML and SVG are drawn with
 * scripts off (see ArtifactPage), Markdown as the chat's own is, and a diagram as its source.
 */
export function ArtifactsPane({ slot, onHide, hideLabel = "Hide", inSheet = false, title, float }: { slot: string; onHide: () => void; hideLabel?: string; inSheet?: boolean; /** In place of the "Artifacts" heading (a menu of what the sheet can show). */ title?: ReactNode; /** A tablet's pane can float over the chat as a card, and go back. */ float?: { floating: boolean; onToggle: () => void } }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const controller = useController();
  const { views } = useSyncState();
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Claude writing a page is a change to a file of the chat: the list is read again when what the chat changed does.
  const edits = changedFiles((views[slot] ?? emptyView).items)
    .map((f) => `${f.path}:${f.added}:${f.removed}`)
    .join("|");
  useEffect(() => {
    let live = true;
    controller.sync.artifacts(slot).then(
      (list) => {
        if (!live) return;
        setItems(list);
        setListError(null);
      },
      (e: Error) => live && setListError(e.message),
    );
    return () => {
      live = false;
    };
  }, [controller, slot, edits]);
  const current = useMemo(() => items?.find((a) => a.name === picked) ?? items?.[0] ?? null, [items, picked]);
  const stamp = current ? `${current.name}:${current.modified}:${current.size}` : "";
  useEffect(() => {
    if (!current) return;
    let live = true;
    setText(null);
    setError(null);
    controller.sync.artifactRead(slot, current.name).then(
      (t) => live && setText(t),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // A page is read again when its own size or time change (Claude wrote it again).
  }, [controller, slot, stamp]);
  return (
    <View testID="artifacts-pane" style={{ flex: 1, backgroundColor: colors.card, paddingTop: inSheet || float?.floating ? 16 : insets.top + 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingBottom: 8 }}>
        <View style={{ flex: 1 }}>
          {title ?? (
            <Txt variant="heading" accessibilityRole="header">
              Artifacts
            </Txt>
          )}
          {!!items?.length && (
            <Txt variant="small" tone="ink2">
              {items.length === 1 ? "1 artifact" : `${items.length} artifacts`}
            </Txt>
          )}
        </View>
        {float && (
          <PressScale accessibilityRole="button" accessibilityLabel={float.floating ? "Put the artifacts beside the chat" : "Float the artifacts over the chat"} onPress={float.onToggle} haptic="select" hitSlop={8} scaleTo={0.88} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <FloatIcon floating={float.floating} color={colors.ink} />
          </PressScale>
        )}
        <Button label={hideLabel} kind="ghost" onPress={onHide} />
      </View>
      {listError ? (
        <Txt tone="stop" accessibilityRole="alert" style={{ padding: space.lg }}>
          {listError}
        </Txt>
      ) : items === null ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <DiffSkeleton />
        </View>
      ) : items.length === 0 ? (
        <Txt variant="body" tone="ink2" style={{ padding: space.lg }}>
          Nothing here yet. Ask Claude to put a page, a diagram or notes in this folder's .lantern/artifacts/, and it shows up here.
        </Txt>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: 8, gap: 8 }}>
            {items.map((a) => (
              <PressScale key={a.name} accessibilityRole="button" accessibilityLabel={`${artifactFolder(a.name)}${artifactTitle(a.name)}, ${KIND_LABEL[a.kind]}`} accessibilityState={{ selected: a.name === current?.name }} onPress={() => setPicked(a.name)} haptic="select" scaleTo={0.97} style={{ minHeight: 44, justifyContent: "center", paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.inner, backgroundColor: a.name === current?.name ? colors.ink : colors.paper }}>
                <Txt variant="small" numberOfLines={1} style={{ fontWeight: "700", color: a.name === current?.name ? colors.onInk : colors.ink }}>
                  {artifactTitle(a.name)}
                </Txt>
                <Txt variant="tiny" numberOfLines={1} style={{ color: a.name === current?.name ? colors.onInk : colors.ink3 }}>
                  {KIND_LABEL[a.kind]}
                  {a.modified ? ` · ${ago(a.modified, Date.now())}` : ""}
                </Txt>
              </PressScale>
            ))}
          </ScrollView>
          <View style={{ height: 1, backgroundColor: colors.rule }} />
          {current && <Viewer artifact={current} text={text} error={error} bottom={insets.bottom} />}
        </>
      )}
    </View>
  );
}

function Viewer({ artifact, text, error, bottom }: { artifact: Artifact; text: string | null; error: string | null; bottom: number }) {
  if (error) {
    return (
      <Txt tone="stop" accessibilityRole="alert" style={{ padding: space.lg }}>
        {error}
      </Txt>
    );
  }
  if (text === null) {
    return (
      <View style={{ padding: space.lg }}>
        <DiffSkeleton />
      </View>
    );
  }
  if (artifact.kind === "html" || artifact.kind === "svg") {
    return (
      <>
        <Txt variant="tiny" tone="ink3" style={{ paddingHorizontal: space.lg, paddingVertical: 6 }}>
          {WEB_NOTE}
        </Txt>
        <ArtifactPage testID="artifact-page" html={text} />
        <View style={{ height: bottom }} />
      </>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, paddingBottom: bottom + 16, gap: 8 }}>
      {artifact.kind === "mermaid" ? (
        <>
          <Txt variant="small" tone="ink2">
            {MERMAID_NOTE}
          </Txt>
          <Txt variant="mono" selectable>
            {text}
          </Txt>
        </>
      ) : (
        <Markdown text={text} />
      )}
    </ScrollView>
  );
}
