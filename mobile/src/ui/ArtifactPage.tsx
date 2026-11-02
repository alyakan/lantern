import { Component, useMemo, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { artifactDocument, isOwnPage } from "../view/artifacts";
import { Txt } from "./components";
import { space, useColors } from "./theme";

/**
 * The web view, if this build has it: a build made before it was added doesn't, and neither does a test. It is read once here, so
 * a missing one is a missing page, not a crash at the app's start.
 */
let WebView: ComponentType<Record<string, unknown>> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  WebView = require("react-native-webview").WebView ?? null;
} catch {
  WebView = null;
}

/** A page that can't be drawn says so instead of taking the screen down (an older build has the module's code but not its view). */
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * An HTML or SVG artifact, drawn in a web view that can do nothing but show it: no scripts, no storage, no request of any kind
 * (the page's own policy blocks them, and nothing but the page itself may load), and no way out through a link. This is weaker
 * than the Mac's frame on purpose: a page there may run scripts, but this web view can't have WebRTC and preconnect switched
 * off, which the Mac's window does for them, so here scripts stay off. The Mac takes out what would reach a server without
 * a request (artifacts.rs `defuse`) before it sends the page.
 */
export function ArtifactPage({ html, testID }: { html: string; testID?: string }) {
  const colors = useColors();
  // Built once per page and palette, not per render: the pane draws again with every event of the chat.
  const source = useMemo(() => ({ html: artifactDocument(html, colors) }), [html, colors]);
  const gone = (
    <Txt variant="body" tone="ink2" style={{ padding: space.lg }}>
      This page can't be shown in this version of the app. It is on your Mac.
    </Txt>
  );
  if (!WebView) return gone;
  const Web = WebView;
  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: colors.card }}>
      <Boundary fallback={gone}>
        <Web
          source={source}
          // Everything is let through to the check below, which allows only the page: an origin the list left out would be handed to
          // Safari by the web view itself (a page's meta refresh opened one on its own, seen in the simulator), which is a way out.
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          domStorageEnabled={false}
          incognito
          cacheEnabled={false}
          allowFileAccess={false}
          allowsLinkPreview={false}
          dataDetectorTypes="none"
          setSupportMultipleWindows={false}
          mixedContentMode="never"
          onShouldStartLoadWithRequest={(r: { url: string }) => isOwnPage(r.url)}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      </Boundary>
    </View>
  );
}
