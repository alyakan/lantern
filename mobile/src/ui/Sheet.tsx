import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { LockCover } from "../shell/LockCover";
import { useLockState } from "../shell/lockContext";
import { SHEET_MAX } from "../view/layout";
import { useAccent } from "./accent";
import { BAR_TEXT_SCALE, Txt } from "./components";
import { Glass } from "./Glass";
import { PressScale } from "./motion";
import { MIN_TARGET, radius, space, useColors } from "./theme";

/** How much of the screen's height a sheet may take. */
const MOST = 0.88;
/** How wide a `wide` sheet may be on a screen `width` wide: as a floated pane is (layout.ts floatFrame), never narrower than any sheet. */
export const wideSheet = (width: number) => Math.max(SHEET_MAX, Math.round(Math.min(width * 0.8, 1100)));

/** The room what is in a sheet keeps at its bottom: the sheet itself stays clear of the home indicator. */
export const SHEET_INSET = 8;

/**
 * The ref for the one list a sheet's content scrolls (a ScrollView): given to the native sheet, so dragging the sheet and
 * scrolling the list work together and the sheet's height fits the list. `any`, as a ref for any list it may be.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SheetScroll = RefObject<any>;

/**
 * A bottom sheet: iOS's own (UISheetPresentationController, through True Sheet), sized to what is in it up to most of the
 * screen, with its grabber; a swipe down or a tap on the dimmed screen around it puts it away. On a tablet it is no wider than
 * SHEET_MAX, or (`wide`, for what reads across, like a diff) most of the screen's width. `children` is given `close`, which slides it away and then calls `onClose` (as a swipe does: once, however it
 * goes), and `scroll`, the ref for the list in it that scrolls.
 *
 * A sheet sized to its content can't hide the screen around it, so when the app lock covers the app (it locked, or the app is
 * leaving the screen) the sheet is put away at once, with the lock's cover drawn over what is in it meanwhile (iOS takes the
 * app switcher's picture as the app leaves: no animation is left running for it to catch). One asked for while the app is
 * covered (a handoff as it locks, a sheet at launch) is never shown: it says it closed.
 */
export function Sheet({ onClose, children, size = "content", wide = false }: { onClose: () => void; children: (close: () => void, scroll: SheetScroll) => ReactNode; size?: "content" | "large"; wide?: boolean }) {
  const sheet = useRef<TrueSheet>(null);
  const scroll: SheetScroll = useRef(null);
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const gone = useRef(false);
  const done = () => {
    if (gone.current) return;
    gone.current = true;
    onClose();
  };
  const close = () => void sheet.current?.dismiss();
  const lock = useLockState();
  const covered = lock.ready && (lock.locked || lock.covered);
  // Covered when it was asked for: never presented. Covered while it was still coming up: put away once it is up.
  const blocked = useRef(covered).current;
  const coveredNow = useRef(covered);
  coveredNow.current = covered;
  useEffect(() => {
    if (blocked) return done();
    if (covered) void sheet.current?.dismiss(false);
  }, [covered]);
  if (blocked) return null;
  return (
    <TrueSheet ref={sheet} style={size === "large" ? { flex: 1 } : undefined} detents={[size === "large" ? MOST : "auto"]} initialDetentIndex={0} maxContentHeight={height * MOST} maxContentWidth={wide ? wideSheet(width) : SHEET_MAX} grabber scrollableRef={scroll as never} onDidPresent={() => coveredNow.current && void sheet.current?.dismiss(false)} onDidDismiss={done}>
      {/* The sheet already sits above the home indicator: what is in it keeps only a little room at its bottom. */}
      {/* VoiceOver's two-finger scrub puts any sheet away: a menu (a message's actions) has no Cancel of its own. */}
      <View style={size === "large" ? { flex: 1 } : { flexShrink: 1 }} accessibilityActions={[{ name: "escape" }]} onAccessibilityAction={(e) => e.nativeEvent.actionName === "escape" && close()}>
        <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: SHEET_INSET }}>{children(close, scroll)}</SafeAreaInsetsContext.Provider>
      </View>
      {covered && (
        <View style={StyleSheet.absoluteFill}>
          <LockCover />
        </View>
      )}
    </TrueSheet>
  );
}

/**
 * A sheet's own bar, as iOS's sheets have it: its title in the middle, and what closes it (Close, Cancel) in a capsule of glass
 * at its left, in words (never a ✕); a swipe down does the same. A sheet with nothing to lose has no button at all, only the
 * grabber, and is put away with the swipe. `right` is a sheet's one action, when it has one there.
 */
export function SheetBar({ title, close, right, inset = space.lg }: { title?: string; close?: { label: string; onPress: () => void; disabled?: boolean }; right?: ReactNode; /** Its side margins: none inside content that keeps its own. */ inset?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: MIN_TARGET, paddingHorizontal: inset, paddingTop: inset ? 10 : 0, paddingBottom: 4 }}>
      {!!title && (
        // Centred on the same line as the pills beside it: the row's own padding above and below, whatever its inset.
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", paddingTop: inset ? 10 : 0, paddingBottom: 4, paddingHorizontal: 110 }]}>
          <Txt variant="body" accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={BAR_TEXT_SCALE} style={{ fontWeight: "700" }}>
            {title}
          </Txt>
        </View>
      )}
      {close ? <SheetPill label={close.label} onPress={close.onPress} disabled={close.disabled} /> : <View />}
      {right ?? <View />}
    </View>
  );
}

/** A word in a capsule of glass at a sheet's top (Close, Cancel, Done): a finger's worth of a target. */
export function SheetPill({ label, onPress, disabled = false, tone = "ink" }: { label: string; onPress: () => void; disabled?: boolean; tone?: "ink" | "accent" }) {
  const accent = useAccent();
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} opacity={disabled ? 0.45 : 1} onPress={onPress} haptic="select" scaleTo={0.94}>
      <Glass lift={0.1} style={{ minHeight: MIN_TARGET, paddingHorizontal: 16, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" }}>
        <Txt variant="body" maxFontSizeMultiplier={BAR_TEXT_SCALE} style={{ fontWeight: "600", color: tone === "accent" ? accent : colors.ink }}>
          {label}
        </Txt>
      </Glass>
    </PressScale>
  );
}
