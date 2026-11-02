import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteStorage } from "../protocol/generated/RemoteStorage";
import { useController } from "../shell/hooks";
import { useAppLock } from "../shell/lockContext";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { space, useColors } from "../ui/theme";
import { bytesText, clearTotals, diskTone, kindText, scanState, usedShare } from "../view/storage";

/** How often what the Mac says is asked for again while it scans or clears. */
export const POLL_MS = 2000;
/** How long a finished clear is still told of. */
const REPORT_MS = 10 * 60 * 1000;

/**
 * The Mac's storage, from its settings sheet: how full the disk is, and the items of it that are safe to clear (caches, build
 * output, worktrees with nothing unsaved, simulator data), with a button that clears them. The Mac decides what is safe: it
 * clears only those of the listed items it still finds safe when asked, never anything else, whatever this phone sends. Clearing
 * asks Face ID (or Touch ID, never the passcode) first and then shows what it will clear, as for the terminal: unpairing this
 * phone is the kill switch. It is a button here and not a swipe, since a swipe in a sheet (a Modal) is not known to take a drag.
 */
export function StorageSheet({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  const lock = useAppLock();
  const [data, setData] = useState<RemoteStorage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the Mac said it started: it may take fewer than the list showed, so this is what the progress line says.
  const [started, setStarted] = useState<{ started: number; bytes: number } | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await sync.storage();
      if (!live.current) return;
      setData(next);
      setProblem((p) => (p && p.startsWith("Couldn't")) ? null : p);
    } catch (e) {
      if (live.current) setProblem((e as Error).message || "Couldn't reach your Mac.");
    }
  }, [sync]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const working = !!data && (data.scanning || data.deleting);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [working, load]);

  const scan = async () => {
    setProblem(null);
    setBusy(true);
    try {
      await sync.storageScan();
      await load();
    } catch (e) {
      setProblem((e as Error).message || "The scan didn't start.");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const askClear = async () => {
    setProblem(null);
    const proof = await lock.verify("Clear safe items on your Mac");
    if (!live.current || proof === "cancelled") return;
    if (proof === "unavailable") return setProblem("Clearing needs Face ID (or Touch ID) set up on this phone, and it isn't. Turn it on in the phone's Settings.");
    if (proof !== "ok") return setProblem("That didn't work, so nothing was cleared. Try again.");
    setConfirming(true);
  };

  const clear = async () => {
    if (!data || busy) return;
    setBusy(true);
    setConfirming(false);
    try {
      const said = await sync.storageClear(data.items.map((i) => i.id));
      if (live.current) setStarted(said);
      await load();
    } catch (e) {
      if (live.current) setProblem((e as Error).message || "The Mac didn't start clearing.");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const now = Date.now();
  const used = data ? usedShare(data) : null;
  const tone = diskTone(used);
  const fill = tone === "stop" ? colors.stop : tone === "warn" ? colors.hi : colors.go;
  const scanned = data ? scanState(data.scanned_at, now) : null;
  const totals = data ? clearTotals(data.items) : null;
  const report = data?.report && now - data.report.at < REPORT_MS ? data.report : null;
  const canClear = !!data && !working && !busy && !!scanned?.fresh && data.items.length > 0;

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ padding: space.xl, paddingBottom: insets.bottom + space.xl, gap: 10, flexShrink: 1 }}>
          <Txt variant="heading" accessibilityRole="header">
            Your Mac's storage
          </Txt>
          {!data && !problem && (
            <Txt variant="body" tone="ink2">
              Asking your Mac…
            </Txt>
          )}
          {data && (
            <>
              {data.free_bytes !== null && data.total_bytes !== null ? (
                <View accessible accessibilityLabel={`${bytesText(data.free_bytes)} free of ${bytesText(data.total_bytes)}`} style={{ gap: 6 }}>
                  <Txt variant="body" style={{ fontWeight: "700" }}>
                    {bytesText(data.free_bytes)} free of {bytesText(data.total_bytes)}
                  </Txt>
                  <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.rule, overflow: "hidden" }}>
                    <View testID="disk-fill" style={{ width: `${Math.max(2, Math.round((used ?? 0) * 100))}%`, height: 8, backgroundColor: fill }} />
                  </View>
                </View>
              ) : (
                <Txt variant="body" tone="ink2">
                  Your Mac didn't say how much room it has.
                </Txt>
              )}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <Txt variant="small" tone="ink2" accessibilityLiveRegion="polite">
                  {data.scanning ? (data.progress ? `Scanning: ${data.progress}` : "Scanning…") : data.deleting ? (started ? `Clearing ${started.started} item${started.started === 1 ? "" : "s"}, about ${bytesText(started.bytes)}…` : "Clearing…") : scanned?.text}
                </Txt>
                {!working && <Button label={data.scanned_at === null ? "Scan" : "Scan again"} kind="ghost" disabled={busy} onPress={() => void scan()} />}
              </View>
              {report && !working && (
                <Txt variant="small" tone={report.failed > 0 ? "stop" : "ink2"} accessibilityRole="alert">
                  {report.ok > 0 ? `Cleared ${report.ok} item${report.ok === 1 ? "" : "s"}, about ${bytesText(report.freed)}.` : "Nothing was cleared."}
                  {report.failed > 0 ? ` ${report.failed} couldn't be cleared (the Mac checks each one again first; the Storage tab says why).` : ""}
                </Txt>
              )}
              {data.items.length === 0 && !working && scanned?.fresh && (
                <Txt variant="body" tone="ink2">
                  Nothing is safe to clear right now.
                </Txt>
              )}
              {data.items.length > 0 && (
                <>
                  <Txt variant="small" tone="ink2" style={{ fontWeight: "700" }}>
                    Safe to clear: {bytesText(totals?.bytes ?? 0)}
                    {data.more > 0 ? `, and ${data.more} more on your Mac` : ""}
                  </Txt>
                  <ScrollView style={{ maxHeight: 240 }} contentContainerStyle={{ gap: 8 }} testID="storage-items">
                    {data.items.map((i) => (
                      <View key={i.id} accessible accessibilityLabel={`${i.name}, ${kindText(i.kind)}, ${bytesText(i.bytes)}`} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
                        <View style={{ flex: 1 }}>
                          <Txt variant="small" numberOfLines={1} style={{ fontWeight: "600" }}>
                            {i.name}
                          </Txt>
                          <Txt variant="tiny" tone="ink3" numberOfLines={2}>
                            {kindText(i.kind)}. {i.note}
                          </Txt>
                        </View>
                        <Txt variant="small" tone="ink2">
                          {bytesText(i.bytes)}
                        </Txt>
                      </View>
                    ))}
                  </ScrollView>
                </>
              )}
            </>
          )}
          {problem && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {problem}
            </Txt>
          )}
          {confirming && totals ? (
            <View style={{ gap: 8, marginTop: 4 }}>
              <Txt variant="small" tone="ink2">
                {`Clear ${totals.count} item${totals.count === 1 ? "" : "s"} on your Mac, about ${bytesText(totals.bytes)}? ${totals.trashBytes > 0 ? `${bytesText(totals.trashBytes)} of it goes to the Trash, which frees no room until it is emptied. ` : ""}The Mac checks each one again first and skips any that changed. Caches and build output come back by themselves.`}
              </Txt>
              <Button label={`Clear ${bytesText(totals.bytes)}`} kind="ink" onPress={() => void clear()} />
              <Button label="Cancel" kind="ghost" link onPress={() => setConfirming(false)} />
            </View>
          ) : (
            canClear && <Button label={`Clear safe items (${bytesText(totals?.bytes ?? 0)})`} kind="ink" onPress={() => void askClear()} accessibilityHint="Asks for Face ID, then shows what it will clear." />
          )}
          {data && !working && !scanned?.fresh && data.scanned_at !== null && (
            <Txt variant="tiny" tone="ink3">
              The scan is more than an hour old, so scan again before clearing.
            </Txt>
          )}
          {/* While a clear is being confirmed, Cancel is the way out: a second one would sit as loud as Clear. */}
          {!(confirming && totals) && <Button label="Close" kind="ghost" onPress={close} />}
        </View>
      )}
    </Sheet>
  );
}
