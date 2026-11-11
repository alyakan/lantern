import { Component, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Modal, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useLockState } from "../shell/lockContext";
import { LockCover } from "../shell/LockCover";
import { layoutArchitecture, parseArchitecture, type ArchLayout } from "../view/architecture";
import { diagramDocument, diagramSvg, selectionMessage, type DiagramSelection } from "../../../shared/mobileDiagram";
import { isOwnPage } from "../view/artifacts";
import { Txt } from "./components";
import { PressScale } from "./motion";
import { SheetBar } from "./Sheet";
import { radius, useColors } from "./theme";

let Web: ComponentType<Record<string, unknown>> | null = null;
try { Web = require("react-native-webview").WebView ?? null; } catch { /* Older native builds keep showing the source. */ }
let Svg: ComponentType<Record<string, unknown>> | null = null;
try { Svg = require("react-native-svg").SvgXml ?? null; } catch { /* A build without the native module keeps showing source. */ }

class ViewerBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** A map draws when its JSON is complete; streaming/invalid blocks keep their ordinary source fallback. */
export function ArchitectureDiagram({ text, fallback }: { text: string; fallback: ReactNode }) {
  const layout = useMemo(() => {
    try {
      const read = parseArchitecture(text);
      return "spec" in read ? layoutArchitecture(read.spec) : null;
    } catch { return null; }
  }, [text]);
  if (!layout || !Svg) return <>{fallback}</>;
  return <ViewerBoundary fallback={fallback}><MapBlock key={text} layout={layout} fallback={fallback} /></ViewerBoundary>;
}

function MapBlock({ layout, fallback }: { layout: ArchLayout; fallback: ReactNode }) {
  const colors = useColors();
  const { width, height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const selection = useRef<DiagramSelection>(null);
  const lock = useLockState();
  const covered = lock.ready && (lock.locked || lock.covered);
  const preview = useMemo(() => diagramSvg(layout, colors), [layout, colors]);
  // Stable while a finger selects: opening or changing the theme builds a new document.
  const full = useMemo(() => ({ html: open ? diagramDocument(layout, colors, true, selection.current) : "" }), [layout, colors, open, generation]);
  if (!Web || !Svg || failed) return <>{fallback}</>;
  const webProps = {
    originWhitelist: ["*"],
    onShouldStartLoadWithRequest: (r: { url: string }) => isOwnPage(r.url),
    domStorageEnabled: false, incognito: true, cacheEnabled: false,
    allowFileAccess: false, allowsLinkPreview: false, dataDetectorTypes: "none",
    setSupportMultipleWindows: false, mixedContentMode: "never", scrollEnabled: false,
    automaticallyAdjustContentInsets: false, contentInsetAdjustmentBehavior: "never",
    onContentProcessDidTerminate: () => setGeneration(g => g + 1),
    onRenderProcessGone: () => setGeneration(g => g + 1),
    startInLoadingState: true,
    renderLoading: () => <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.paper, alignItems: "center", justifyContent: "center" }]}><Txt tone="ink2">Drawing map…</Txt></View>,
    onError: () => setFailed(true),
    style: { flex: 1, backgroundColor: colors.paper },
  };
  return (
    <View style={{ borderWidth: 1, borderColor: colors.rule, borderRadius: radius.inner, overflow: "hidden" }}>
      <PressScale accessibilityRole="button" accessibilityLabel={`Open architecture map, ${layout.nodes.length} nodes and ${layout.edges.length} connections`} accessibilityHint="Opens full screen. Pinch to zoom and drag to move the map." onPress={() => setOpen(true)} scaleTo={0.99} haptic="select">
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: width > height ? 140 : 200 }}>
          <Svg xml={preview} width="100%" height="100%" />
        </View>
        <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.rule, backgroundColor: colors.card, flexDirection: "row", justifyContent: "space-between" }}>
          <Txt variant="small" style={{ fontWeight: "700" }}>Architecture map</Txt>
          <Txt variant="small" tone="cobalt">Expand ↗</Txt>
        </View>
      </PressScale>
      <Modal testID="architecture-viewer" visible={open} animationType="slide" presentationStyle="fullScreen" supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]} onRequestClose={() => setOpen(false)}>
        <SafeAreaProvider>
          <SafeAreaView edges={["top", "bottom", "left", "right"]} style={{ flex: 1, backgroundColor: colors.paper }}>
            <SheetBar title="Architecture map" close={{ label: "Close", onPress: () => setOpen(false) }} />
            {open && <Web key={generation} {...webProps} source={full} javaScriptEnabled onMessage={(e: { nativeEvent: { data: string } }) => {
              const next = selectionMessage(e.nativeEvent.data, layout);
              if (next !== undefined) selection.current = next;
            }} />}
          </SafeAreaView>
          {covered && <View style={StyleSheet.absoluteFill}><LockCover /></View>}
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}
