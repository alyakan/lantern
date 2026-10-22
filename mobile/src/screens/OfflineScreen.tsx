import { useEffect, useRef } from "react";
import { Animated, Easing, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectionState } from "../net/connection";
import { useAppLock, useLockState } from "../shell/lockContext";
import { EMBER, useAccent } from "../ui/accent";
import { Button, Txt } from "../ui/components";
import { DarkLantern } from "../ui/lanterns";
import { skips } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { colors, radius, space } from "../ui/theme";

/** A lantern being lit: its glow swells and settles, over and over, while the phone finds the Mac. */
function LitLantern() {
  // The flame is Ember for a regular.
  const accent = useAccent();
  const flame = accent === EMBER ? EMBER : colors.hi;
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (skips()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glow]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: "center", justifyContent: "center", width: 150, height: 150, marginBottom: 8 }}>
      <Animated.View style={{ position: "absolute", width: 130, height: 130, borderRadius: 65, backgroundColor: flame, opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.08, 0.28] }), transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.12] }) }] }} />
      <View style={{ width: 16, height: 10, borderWidth: 2, borderBottomWidth: 0, borderColor: colors.ink2, borderTopLeftRadius: 8, borderTopRightRadius: 8 }} />
      <View style={{ width: 44, height: 64, borderWidth: 2, borderColor: colors.ink2, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, alignItems: "center", justifyContent: "center" }}>
        <Animated.View style={{ width: 16, height: 24, borderRadius: 9, backgroundColor: flame, opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }} />
      </View>
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
        <View accessibilityLabel="Connecting to your Mac" accessibilityRole="progressbar" accessible style={{ alignItems: "center", gap: 10 }}>
          <LitLantern />
          <Txt variant="heading">Connecting to your Mac</Txt>
          <Dots />
        </View>
      ) : (
        <>
          <DarkLantern />
          <Txt variant="title" style={{ textAlign: "center" }} accessibilityRole="header">
            Can't reach your Mac
          </Txt>
          <Txt variant="body" tone="ink2" style={{ textAlign: "center", marginTop: 8, marginBottom: 22 }}>
            {state.kind === "offline" ? state.reason : "It may be asleep or offline. Away from home, check that Tailscale is on here and on the Mac, and that Remote control is on in Lantern."}
          </Txt>
          <Button label="Try again" onPress={onRetry} style={{ alignSelf: "stretch" }} />
          <Button label="Unpair this phone" kind="ghost" onPress={onUnpair} style={{ alignSelf: "stretch", marginTop: 10, backgroundColor: "transparent" }} />
        </>
      )}
    </View>
  );
}

/** The lock's switch: Face ID (or the phone's passcode) before Lantern shows anything. It asks first, to turn it on or off. */
function LockRow() {
  const lock = useAppLock();
  const { enabled, available, authenticating, method, problem } = useLockState();
  return (
    <View style={{ marginTop: 10, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Txt variant="body" style={{ fontWeight: "700", flex: 1 }}>
          Lock with {method}
        </Txt>
        <Switch
          accessibilityLabel={`Lock with ${method}`}
          value={enabled}
          disabled={authenticating || (!available && !enabled)}
          onValueChange={(on) => void (on ? lock.enable() : lock.disable())}
          trackColor={{ true: colors.go, false: colors.rule }}
        />
      </View>
      <Txt variant="small" tone="ink2">
        {available || enabled ? `Asks for ${method} when you come back to Lantern after half a minute away. Your phone's passcode works too.` : "Set a passcode on this phone to use this."}
      </Txt>
      {problem && (
        <Txt variant="small" tone="stop" accessibilityRole="alert">
          {problem}
        </Txt>
      )}
    </View>
  );
}

/** The Mac, as a sheet: its name, where the connection stands, and unpairing this phone. */
export function MacSheet({ state, onClose, onUnpair, onSupport }: { state: ConnectionState; onClose: () => void; onUnpair: () => void; /** Opens the optional tips. */ onSupport?: () => void }) {
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
          <LockRow />
          {onSupport && <Button label="Support development" kind="ghost" onPress={onSupport} style={{ marginTop: 6 }} />}
          <Button label="Unpair this phone" kind="ghost" onPress={onUnpair} style={{ marginTop: onSupport ? 0 : 6 }} />
          <Button label="Close" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
