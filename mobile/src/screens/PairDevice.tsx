import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PairOffer } from "../protocol/generated/PairOffer";
import { useController } from "../shell/hooks";
import { useAppLock } from "../shell/lockContext";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";
import { countdown, isGrid, runs, squareSize } from "../view/qr";

/** The code's drawing is this many points across, margin included, before it is cut to a whole number of squares. */
const QR_SIZE = 288;

/** A QR code drawn from the squares the Mac sent: dark on white (a scanner needs that, in dark mode too), with the margin it asks for. */
export function QrCode({ modules, label }: { modules: string[]; label: string }) {
  const n = modules.length;
  const sq = squareSize(QR_SIZE, n);
  const side = sq * (n + 8);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID="pair-qr" style={{ width: side, height: side, backgroundColor: "#ffffff", borderRadius: radius.inner, alignSelf: "center" }}>
      {runs(modules).map((r) => (
        <View key={`${r.row}:${r.x}`} style={{ position: "absolute", left: (r.x + 4) * sq, top: (r.row + 4) * sq, width: r.length * sq, height: sq, backgroundColor: "#000000" }} />
      ))}
    </View>
  );
}

type Shown =
  | { kind: "checking" }
  | { kind: "problem"; text: string }
  /** `copied`: the link was put on the clipboard, so it is taken off again when the code goes. */
  | { kind: "code"; offer: PairOffer; copied: boolean }
  | { kind: "gone"; text: string };

/**
 * Shows this phone's Mac's pairing code to another device, for when the Mac itself is out of reach. It asks Face ID (or Touch
 * ID, never the passcode) first, every time: whoever can pass it can add a device to the Mac, so this phone is the one place
 * that is checked, as for the terminal. The code is secret until it is used or has expired, so it is not kept anywhere: it
 * goes when its time is up and as soon as the app is left (so the app switcher's picture can't show it), and it is never logged.
 */
export function PairDeviceSheet({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  const lock = useAppLock();
  const [shown, setShown] = useState<Shown>({ kind: "checking" });
  const [now, setNow] = useState(Date.now());
  // What was put on the clipboard, to take it off again if it is still there.
  const copied = useRef<string | null>(null);
  const started = useRef(false);
  const live = useRef(true);

  const takeOffClipboard = useCallback(async () => {
    const link = copied.current;
    copied.current = null;
    if (!link) return;
    try {
      if ((await Clipboard.getStringAsync()) === link) await Clipboard.setStringAsync("");
    } catch {
      // Nothing to do: the code expires anyway.
    }
  }, []);

  const start = useCallback(async () => {
    setShown({ kind: "checking" });
    const proof = await lock.verify("Pair another device with your Mac");
    if (!live.current) return;
    if (proof === "cancelled") return onClose();
    if (proof === "unavailable") return setShown({ kind: "problem", text: "Pairing another device needs Face ID (or Touch ID) set up on this phone, and it isn't. Turn it on in the phone's Settings." });
    if (proof !== "ok") return setShown({ kind: "problem", text: "That didn't work, so no code was made. Try again." });
    try {
      const offer = await sync.pairOffer();
      if (!live.current) return;
      // A Mac that sent something that isn't a code is not drawn: a scanner would read it as nothing, or as something else.
      if (!isGrid(offer.modules) || !offer.link.startsWith("lantern://pair?")) throw new Error("The Mac's answer wasn't a pairing code.");
      setNow(Date.now());
      setShown({ kind: "code", offer, copied: false });
    } catch (e) {
      if (live.current) setShown({ kind: "problem", text: (e as Error).message || "Couldn't get a code from your Mac." });
    }
  }, [lock, sync, onClose]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  useEffect(
    () => () => {
      live.current = false;
      void takeOffClipboard();
    },
    [takeOffClipboard],
  );

  // While a code is up: its clock, and letting go of it the moment the app is left (the lock's own cover isn't enough: it is only
  // there when the lock is on).
  const code = shown.kind === "code" ? shown : null;
  useEffect(() => {
    if (!code) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") return;
      void takeOffClipboard();
      setShown({ kind: "gone", text: "The code was hidden when you left the app. Make a new one." });
    });
    return () => {
      clearInterval(tick);
      sub.remove();
    };
  }, [code, takeOffClipboard]);
  useEffect(() => {
    if (code && now >= code.offer.expires_at) {
      void takeOffClipboard();
      setShown({ kind: "gone", text: "The code expired. Make a new one." });
    }
  }, [code, now, takeOffClipboard]);

  const copy = async () => {
    if (!code) return;
    try {
      await Clipboard.setStringAsync(code.offer.link);
      copied.current = code.offer.link;
      setShown({ ...code, copied: true });
    } catch {
      setShown({ kind: "problem", text: "Couldn't copy the link." });
    }
  };

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: insets.bottom + space.xl, gap: 10 }}>
          <Txt variant="heading" accessibilityRole="header">
            Pair another device
          </Txt>
          {shown.kind === "checking" && (
            <Txt variant="body" tone="ink2">
              Checking it's you…
            </Txt>
          )}
          {(shown.kind === "problem" || shown.kind === "gone") && (
            <>
              <Txt variant="body" tone={shown.kind === "problem" ? "stop" : "ink2"} accessibilityRole="alert">
                {shown.text}
              </Txt>
              <Button label={shown.kind === "problem" ? "Try again" : "Make a new code"} onPress={() => void start()} />
            </>
          )}
          {code && (
            <>
              <Txt variant="body" tone="ink2">
                On the other device, open Lantern and point its camera at this code. Or copy the link, and paste it there under "Paste the link instead".
              </Txt>
              <QrCode modules={code.offer.modules} label="Pairing code" />
              <Txt variant="small" tone="ink2" style={{ textAlign: "center" }} accessibilityLiveRegion="polite">
                Works once, for {countdown(code.offer.expires_at, now)} more
              </Txt>
              <Txt variant="small" tone="ink3">
                Whoever scans it before then can see and control your Mac's chats, so keep it to yourself. The other device needs to be on this Mac's Wi-Fi, or have Tailscale on. A code Lantern is showing on the Mac stops working.
              </Txt>
              <Button label={code.copied ? "Link copied" : "Copy the link"} kind="ghost" onPress={() => void copy()} />
            </>
          )}
          <Button label={code ? "Done" : "Close"} kind={code ? "ink" : "ghost"} onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
