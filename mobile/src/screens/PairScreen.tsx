import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useController } from "../shell/hooks";
import { useLayout } from "../shell/useLayout";
import { Button, Txt } from "../ui/components";
import { AboveKeyboard } from "../ui/keyboard";
import { Dots } from "../ui/skeleton";
import { lightColors, space, useColors } from "../ui/theme";

/** How long a code the camera has seen and refused is ignored, so one bad code isn't refused thirty times a second. */
const IGNORE_MS = 3000;

/** How big the frame to point at the code is: a tablet's camera is bigger than a phone's, so the frame is bigger to match. */
const FRAME_PHONE = 220;
const FRAME_TABLET = 300;
/** How wide the screen is, on a tablet: the camera and the words under it share one narrow column in the middle, not the whole width. */
const PANEL_MAX = 480;

const Corner = ({ style }: { style: object }) => <View style={[{ position: "absolute", width: 38, height: 38, borderColor: lightColors.hi, borderWidth: 4 }, style]} />;

/**
 * Pairing: the camera reads the code the Mac shows, or the link is pasted. The code is the user's own act (they pointed the
 * camera at it), so it pairs at once; a link that arrives by itself (a deep link) is confirmed first (see ConfirmLink).
 */
export function PairScreen({ initialPaste = false }: { initialPaste?: boolean }) {
  const colors = useColors();
  const controller = useController();
  const insets = useSafeAreaInsets();
  const frame = useLayout() === "phone" ? FRAME_PHONE : FRAME_TABLET;
  const [permission, requestPermission] = useCameraPermissions();
  const [paste, setPaste] = useState(initialPaste);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refused = useRef<{ data: string; at: number } | null>(null);
  const working = useRef(false);

  const pair = async (link: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const problem = await controller.pair(link);
    working.current = false;
    setBusy(false);
    if (problem) setError(problem);
  };

  const scanned = ({ data }: { data: string }) => {
    const last = refused.current;
    if (working.current || (last && last.data === data && Date.now() - last.at < IGNORE_MS)) return;
    refused.current = { data, at: Date.now() };
    void pair(data);
  };

  const camera = !paste && permission?.granted;

  return (
    // Above the keyboard, so the field being typed in isn't covered by it, and a tap on the background closes it.
    <AboveKeyboard dismissOnTap style={{ backgroundColor: colors.night }}>
      <StatusBar style="light" />
      {/* One column in the middle: on a tablet the camera is no wider than the words under it. */}
      <View testID="pair-screen" style={{ flex: 1, width: "100%", maxWidth: PANEL_MAX, alignSelf: "center" }}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: insets.top }}>
        {camera ? (
          <CameraView style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned} />
        ) : null}
        {camera && (
          <View testID="pair-frame" accessibilityElementsHidden pointerEvents="none" style={{ width: frame, height: frame }}>
            <Corner style={{ top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 14 }} />
            <Corner style={{ top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 14 }} />
            <Corner style={{ bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 14 }} />
            <Corner style={{ bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 14 }} />
          </View>
        )}
        {!camera && !paste && permission && !permission.granted && (
          <View style={{ padding: space.xl, gap: 12 }}>
            <Txt variant="body" tone="night">
              {permission.canAskAgain ? "Lantern needs the camera to read the code your Mac shows." : "The camera is off for Lantern. Turn it on in Settings, or paste the link instead."}
            </Txt>
            {permission.canAskAgain && <Button label="Allow the camera" kind="night-ghost" onPress={() => void requestPermission()} />}
          </View>
        )}
      </View>

      <View style={{ backgroundColor: colors.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: Math.max(insets.bottom, 24) + 8 }}>
        <View testID="pair-column" style={{ width: "100%", maxWidth: PANEL_MAX, alignSelf: "center", gap: 12 }}>
          <Txt variant="title" accessibilityRole="header">
            Pair with your Mac
          </Txt>
          {paste ? (
            <>
              <Txt variant="body" tone="ink2">
                On your Mac, open Settings, then Remote control, and copy the pairing link. Paste it here.
              </Txt>
              <TextInput accessibilityLabel="Pairing link" value={text} onChangeText={setText} placeholder="lantern://pair?…" placeholderTextColor={colors.ink3} autoCapitalize="none" autoCorrect={false} multiline returnKeyType="done" submitBehavior="blurAndSubmit" style={{ backgroundColor: colors.card, borderRadius: 14, padding: 12, minHeight: 72, color: colors.ink, fontSize: 14 }} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label="Paste" kind="ghost" style={{ flex: 1 }} onPress={() => void Clipboard.getStringAsync().then(setText)} />
                <Button label="Pair" style={{ flex: 1 }} disabled={busy || !text.trim()} onPress={() => void pair(text)} />
              </View>
              <Button label="Use the camera" kind="ghost" onPress={() => setPaste(false)} />
            </>
          ) : (
            <>
              <Txt variant="body" tone="ink2">
                In Lantern on your Mac, open Settings, then Remote control, and turn it on. Then point your camera at the code it shows.
              </Txt>
              <Button label="Paste the link instead" kind="ghost" onPress={() => setPaste(true)} />
            </>
          )}
          {busy && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Dots />
              <Txt variant="small" tone="ink2">
                Pairing…
              </Txt>
            </View>
          )}
          {error && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {error}
            </Txt>
          )}
        </View>
      </View>
      </View>
    </AboveKeyboard>
  );
}

/** A pairing link that arrived by itself (tapped somewhere): it names a Mac, and nothing pairs until it is confirmed. */
export function ConfirmLink({ link, onCancel, onDone }: { link: string; onCancel: () => void; onDone: () => void }) {
  const colors = useColors();
  const controller = useController();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = controller.preview(link);
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, padding: 24, paddingTop: insets.top + 60, gap: 14 }}>
      {"error" in p ? (
        <>
          <Txt variant="title">{p.error}</Txt>
          <Button label="Close" onPress={onCancel} />
        </>
      ) : (
        <>
          <Txt variant="title" accessibilityRole="header">
            Pair with {p.macName}?
          </Txt>
          <Txt variant="body" tone="ink2">
            {p.host ? `This link points to ${p.host}. ` : ""}Only pair if you opened it from Lantern on your own Mac. A paired phone can read your chats and answer what Claude asks.
          </Txt>
          {error && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {error}
            </Txt>
          )}
          <Button
            label={busy ? "Pairing…" : "Pair"}
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              const problem = await controller.pair(link);
              setBusy(false);
              // Paired: the link is spent, and the confirmation going away is what lets the app show Home.
              if (problem) setError(problem);
              else onDone();
            }}
          />
          <Button label="Cancel" kind="ghost" onPress={onCancel} />
        </>
      )}
    </View>
  );
}
