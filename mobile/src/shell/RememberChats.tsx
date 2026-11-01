import { useEffect } from "react";
import { saveLastKnown, snapshotOf } from "../lastKnown";
import { recordUsage } from "../usageHistory";
import { useConnectionState, useSyncState } from "./hooks";

/** How long the chats hold still before the phone keeps them (they move with nearly every event). */
export const REMEMBER_MS = 4000;

/** Draws nothing: while the Mac is connected, keeps what it lists for the offline screen to show next time it can't be reached, and the plan's usage for the usage chart. */
export function RememberChats() {
  const { chats, chatsLoaded, plan, providerUsage } = useSyncState();
  const connection = useConnectionState();
  const mac = connection.kind === "connected" ? connection.welcome.mac_name : null;
  const connected = connection.kind === "connected";
  useEffect(() => {
    if (!connected || !chatsLoaded) return;
    const t = setTimeout(() => {
      const k = snapshotOf(chats, mac, Date.now());
      // An empty list is not kept over a good one: it may only be a Mac with its chats all closed for a moment.
      if (k) void saveLastKnown(k);
    }, REMEMBER_MS);
    return () => clearTimeout(t);
  }, [connected, chatsLoaded, chats, mac]);
  // The usage as the Mac says it, each time it changes.
  const used = plan?.used;
  const weekUsed = plan?.week?.used;
  useEffect(() => {
    if (plan) recordUsage(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [used, weekUsed]);
  useEffect(() => {
    for (const reading of Object.values(providerUsage ?? {})) {
      const first = reading.windows.find(w => w.minutes !== 10080);
      if (first && (first.resets_at === null || first.resets_at * 1000 > Date.now())) recordUsage({ used: first.used, resetsAt: first.resets_at, status: "allowed" }, Date.now(), reading.provider);
    }
  }, [providerUsage]);
  return null;
}
