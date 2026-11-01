import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { LockCover } from "../shell/LockCover";
import { useLockState } from "../shell/lockContext";
import { SHEET_MAX } from "../view/layout";

/** How much of the screen's height a sheet may take. */
const MOST = 0.88;
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
 * SHEET_MAX. `children` is given `close`, which slides it away and then calls `onClose` (as a swipe does: once, however it
 * goes), and `scroll`, the ref for the list in it that scrolls.
 *
 * A sheet sized to its content can't hide the screen around it, so when the app lock covers the app (it locked, or the app is
 * leaving the screen) the sheet is put away at once, with the lock's cover drawn over what is in it meanwhile (iOS takes the
 * app switcher's picture as the app leaves: no animation is left running for it to catch). One asked for while the app is
 * covered (a handoff as it locks, a sheet at launch) is never shown: it says it closed.
 */
export function Sheet({ onClose, children, size = "content" }: { onClose: () => void; children: (close: () => void, scroll: SheetScroll) => ReactNode; size?: "content" | "large" }) {
  const sheet = useRef<TrueSheet>(null);
  const scroll: SheetScroll = useRef(null);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
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
    <TrueSheet ref={sheet} detents={[size === "large" ? MOST : "auto"]} initialDetentIndex={0} maxContentHeight={height * MOST} maxContentWidth={SHEET_MAX} grabber scrollableRef={scroll as never} onDidPresent={() => coveredNow.current && void sheet.current?.dismiss(false)} onDidDismiss={done}>
      {/* The sheet already sits above the home indicator: what is in it keeps only a little room at its bottom. */}
      <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: SHEET_INSET }}>{children(close, scroll)}</SafeAreaInsetsContext.Provider>
      {covered && (
        <View style={StyleSheet.absoluteFill}>
          <LockCover />
        </View>
      )}
    </TrueSheet>
  );
}
