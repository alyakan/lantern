import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectionState } from "../net/connection";
import { ageText, loadLastKnown, type LastKnown } from "../lastKnown";
import { useAppLock, useLockState } from "../shell/lockContext";
import { EMBER, useRegular } from "../ui/accent";
import { Button, Txt } from "../ui/components";
import { AboveKeyboard } from "../ui/keyboard";
import { DarkLantern } from "../ui/lanterns";
import { FadeSlideIn, skips } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { Dots } from "../ui/skeleton";
import { radius, space, useColors } from "../ui/theme";

/** A lantern being lit: its glow swells and settles, over and over, while the phone finds the Mac. */
function LitLantern() {
  const colors = useColors();
  // The flame is Ember for a regular.
  const regular = useRegular();
  const flame = regular ? EMBER : colors.hi;
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

/**
 * The Mac's address typed in, behind a button: for a phone that can't find its Mac on its own, such as one away from home
 * that never learned the Mac's Tailscale address. `onAddress` resolves to why one was refused, or null.
 */
function AddressField({ onAddress }: { onAddress: (text: string) => Promise<string | null> }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <Button label="Enter your Mac's address" kind="ghost" onPress={() => setOpen(true)} style={{ alignSelf: "stretch", marginTop: 10, backgroundColor: "transparent" }} />;
  const connect = async () => {
    setBusy(true);
    try {
      setProblem(await onAddress(text));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ alignSelf: "stretch", marginTop: 16, gap: 8 }}>
      <Txt variant="small" tone="ink2">
        Away from home, use the Mac's Tailscale address: the Tailscale app on the Mac shows it, and it starts with 100.
      </Txt>
      <TextInput
        accessibilityLabel="Your Mac's address"
        value={text}
        onChangeText={setText}
        placeholder="100.x.y.z"
        placeholderTextColor={colors.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        keyboardType="numbers-and-punctuation"
        // Done closes the keyboard (a one-line field does that on its own); Connect is the button under it.
        returnKeyType="done"
        style={{ backgroundColor: colors.card, borderRadius: radius.inner, padding: 12, color: colors.ink, fontSize: 16 }}
      />
      {problem && (
        <Txt variant="small" tone="stop" accessibilityRole="alert">
          {problem}
        </Txt>
      )}
      <Button label="Connect" disabled={busy || !text.trim()} onPress={() => void connect()} />
    </View>
  );
}

/** What the Mac listed last time, greyed and not to be pressed: so "can't reach" still says what is waiting there, and since when. */
export function LastKnownList() {
  const colors = useColors();
  const [known, setKnown] = useState<LastKnown | null>(null);
  useEffect(() => {
    let live = true;
    void loadLastKnown().then((k) => live && setKnown(k));
    return () => {
      live = false;
    };
  }, []);
  if (!known) return null;
  const shown = known.chats.slice(0, 5);
  const more = known.chats.length - shown.length;
  return (
    <View testID="last-known" accessible accessibilityLabel={`Last time your Mac was here, ${ageText(known.at, Date.now())}: ${shown.map((c) => c.title).join(", ")}. Read only.`} style={{ alignSelf: "stretch", marginTop: 22, padding: 14, borderRadius: radius.inner, backgroundColor: colors.card, gap: 8, opacity: 0.65 }}>
      <Txt variant="small" tone="ink3" style={{ fontWeight: "700" }}>
        {`${known.mac ?? "Your Mac"} · ${ageText(known.at, Date.now())}`}
      </Txt>
      {shown.map((c, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Txt variant="small" numberOfLines={1} style={{ flex: 1 }}>
            {c.title}
          </Txt>
          {!!c.project && (
            <Txt variant="tiny" tone="ink3" numberOfLines={1} style={{ maxWidth: 110 }}>
              {c.project}
            </Txt>
          )}
        </View>
      ))}
      {more > 0 && (
        <Txt variant="tiny" tone="ink3">
          and {more} more
        </Txt>
      )}
    </View>
  );
}

/**
 * Not connected yet: connecting (a moment), or why not and what to check. Once a try has failed it stays on why, through
 * the tries that follow on their own, so the address being typed in isn't swept away by each one.
 */
export function OfflineScreen({ state, onRetry, onUnpair, onAddress }: { state: ConnectionState; onRetry: () => void; onUnpair: () => void; /** Dials an address typed in; resolves to why it was refused, or null. */ onAddress?: (text: string) => Promise<string | null> }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const connecting = state.kind === "connecting";
  const [lastReason, setLastReason] = useState<string | null>(state.kind === "offline" ? state.reason : null);
  if (state.kind === "offline" && state.reason !== lastReason) setLastReason(state.reason);
  return (
    <AboveKeyboard dismissOnTap style={{ backgroundColor: colors.paper, alignItems: "center", justifyContent: "center", padding: 30, paddingTop: insets.top }}>
      {connecting && lastReason === null ? (
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
            {lastReason ?? "It may be asleep or offline. Away from home, check that Tailscale is on here and on the Mac, and that Remote control is on in Lantern."}
          </Txt>
          {connecting && (
            <Txt variant="small" tone="ink3" accessibilityLiveRegion="polite" style={{ marginTop: -14, marginBottom: 14 }}>
              Trying again…
            </Txt>
          )}
          <Button label="Try again" onPress={onRetry} style={{ alignSelf: "stretch" }} />
          {onAddress && <AddressField onAddress={onAddress} />}
          <LastKnownList />
          <Button label="Unpair this phone" kind="ghost" onPress={onUnpair} style={{ alignSelf: "stretch", marginTop: 10, backgroundColor: "transparent" }} />
        </>
      )}
    </AboveKeyboard>
  );
}

/** How long a lost connection goes unremarked: waking the phone reconnects in a moment, and a pill for that would only flash. */
export const PILL_DELAY_MS = 700;

/**
 * The Mac not being there while there are chats to look at: a small pill at the top with a blinking dot, over whatever is
 * showing, instead of a screen of its own. It lets touches through to what is under it.
 */
export function ReconnectPill({ state }: { state: ConnectionState }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const regular = useRegular();
  const blink = useRef(new Animated.Value(1)).current;
  const [due, setDue] = useState(false);
  const waiting = state.kind === "connecting" || state.kind === "offline";
  useEffect(() => {
    if (!waiting) return setDue(false);
    const t = setTimeout(() => setDue(true), PILL_DELAY_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  useEffect(() => {
    if (!due || skips()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [due, blink]);
  if (!waiting || !due) return null;
  // A run that gave up for good (the Mac is too new or too old for this phone) says why; the rest are still trying.
  const text = state.kind === "offline" && state.retryInMs === null ? state.reason : "Reconnecting to your Mac…";
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: insets.top + 6, left: 0, right: 0, alignItems: "center" }}>
      <FadeSlideIn from={-8} ms={200}>
        <View accessibilityRole="alert" accessibilityLabel={text} accessible style={{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 320, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 }}>
          <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: regular ? EMBER : colors.hi, opacity: blink }} />
          <Txt variant="small" tone="ink2" numberOfLines={2}>
            {text}
          </Txt>
        </View>
      </FadeSlideIn>
    </View>
  );
}

/** The lock's switch: Face ID (or the phone's passcode) before Lantern shows anything. It asks first, to turn it on or off. */
function LockRow() {
  const colors = useColors();
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
export function MacSheet({ state, onClose, onUnpair, onSupport, onPairDevice, onStorage, onTodos, onWhatsNew }: { state: ConnectionState; onClose: () => void; onUnpair: () => void; /** Opens the optional tips. */ onSupport?: () => void; /** Shows a pairing code for another device (Face ID first). Offered only to a Mac that lists "pair". */ onPairDevice?: () => void; /** Opens the Mac's storage (its disk, and what is safe to clear). Offered only to a Mac that lists "storage". */ onStorage?: () => void; /** Opens your to-do lists (kept on the Mac). Offered only to a Mac that lists "todos". */ onTodos?: () => void; /** Opens what changed in this build; given only when there is something to say. */ onWhatsNew?: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const canPair = state.kind === "connected" && state.welcome.features?.includes("pair") === true && !!onPairDevice;
  const canStorage = state.kind === "connected" && state.welcome.features?.includes("storage") === true && !!onStorage;
  const canTodos = state.kind === "connected" && state.welcome.features?.includes("todos") === true && !!onTodos;
  const where = state.kind === "connected" ? `Connected through ${state.host}` : state.kind === "offline" ? "Not connected" : state.kind === "connecting" ? "Connecting…" : "Not paired";
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ padding: space.xl, paddingBottom: insets.bottom + space.xl, gap: 8 }}>
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
          {canPair && <Button label="Pair another device" kind="ghost" onPress={() => onPairDevice?.()} accessibilityHint="Shows a code for your iPad or another phone to scan. Asks for Face ID first." />}
          {canTodos && <Button label="Your to-dos" kind="ghost" onPress={() => onTodos?.()} accessibilityHint="Shows the to-do list of each project on your Mac." />}
          {canStorage && <Button label="Mac storage" kind="ghost" onPress={() => onStorage?.()} accessibilityHint="Shows how much room your Mac has, and what is safe to clear." />}
          {onWhatsNew && <Button label="What's new" kind="ghost" onPress={onWhatsNew} />}
          {onSupport &&<Button label="Support development" kind="ghost" onPress={onSupport} style={{ marginTop: 6 }} />}
          <Button label="Unpair this phone" kind="ghost" onPress={onUnpair} style={{ marginTop: onSupport ? 0 : 6 }} />
          <Button label="Close" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
