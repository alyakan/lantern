import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectionState } from "../net/connection";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { colors, radius, space } from "../ui/theme";

/** A lantern gone dark: the empty state's picture, drawn from a few boxes. */
function DarkLantern() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: "center", marginBottom: 22 }}>
      <View style={{ width: 16, height: 10, borderWidth: 2, borderBottomWidth: 0, borderColor: colors.ink3, borderTopLeftRadius: 8, borderTopRightRadius: 8 }} />
      <View style={{ width: 44, height: 64, borderWidth: 2, borderColor: colors.ink3, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 }} />
    </View>
  );
}

/** Not connected yet: connecting (a moment), or why not and what to check. */
export function OfflineScreen({ state, onRetry, onUnpair }: { state: ConnectionState; onRetry: () => void; onUnpair: () => void }) {
  const insets = useSafeAreaInsets();
  const connecting = state.kind === "connecting";
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center", padding: 30, paddingTop: insets.top }}>
      {connecting ? (
        <>
          <ActivityIndicator size="large" />
          <Txt variant="heading" style={{ marginTop: 18 }}>
            Connecting to your Mac…
          </Txt>
        </>
      ) : (
        <>
          <DarkLantern />
          <Txt variant="title" style={{ textAlign: "center" }} accessibilityRole="header">
            Can't reach your Mac
          </Txt>
          <Txt variant="body" tone="ink2" style={{ textAlign: "center", marginTop: 8, marginBottom: 22 }}>
            {state.kind === "offline" ? state.reason : "Check that it's awake, on the same Wi-Fi as this phone, and that Remote control is on in Lantern."}
          </Txt>
          <Button label="Try again" onPress={onRetry} style={{ alignSelf: "stretch" }} />
          <Button label="Unpair this phone" kind="ghost" onPress={onUnpair} style={{ alignSelf: "stretch", marginTop: 10, backgroundColor: "transparent" }} />
        </>
      )}
    </View>
  );
}

/** The Mac, as a sheet: its name, where the connection stands, and unpairing this phone. */
export function MacSheet({ state, onClose, onUnpair }: { state: ConnectionState; onClose: () => void; onUnpair: () => void }) {
  const insets = useSafeAreaInsets();
  const where = state.kind === "connected" ? `Connected through ${state.host}` : state.kind === "offline" ? "Not connected" : state.kind === "connecting" ? "Connecting…" : "Not paired";
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: insets.bottom + space.xl, gap: 8 }}>
          <Txt variant="heading">{state.kind === "connected" ? state.welcome.mac_name : "Your Mac"}</Txt>
          <Txt variant="body" tone="ink2">
            {where}
          </Txt>
          {state.kind === "connected" && (
            <Txt variant="small" tone="ink3">
              Lantern {state.welcome.app_version}
            </Txt>
          )}
          <Txt variant="small" tone="ink2" style={{ marginTop: 6 }}>
            Unpairing forgets this Mac on this phone. To stop it for good, also remove this phone in Lantern's Settings, under Remote control.
          </Txt>
          <Button label="Unpair this phone" kind="ghost" onPress={onUnpair} style={{ marginTop: 6 }} />
          <Button label="Close" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
