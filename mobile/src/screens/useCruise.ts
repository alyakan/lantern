import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus } from "../protocol/generated/ChatStatus";
import type { Suggestion } from "../protocol/generated/Suggestion";
import type { Sync } from "../sync/sync";
import { draftAt, shouldAsk } from "../view/cruise";

/**
 * Cruise for one chat: per chat and off by default. On, when the chat goes idle it asks the Mac for the next step (from the
 * chat's last few turns) and offers it as a draft; `doIt` sends that draft, and it asks again when the next turn ends. It
 * never sends by itself. The screen only draws what this says (see CruiseBar).
 */
export function useCruise({ slot, available, status, turnKey, disabled, sync, send }: {
  slot: string;
  /** The Mac lists "cruise". */
  available: boolean;
  status: ChatStatus | undefined;
  /** The turn Claude last finished (empty when none): a message just sent is no turn yet. */
  turnKey: string;
  /** Step by step has its own pages to approve, so Cruise leaves it alone. */
  disabled: boolean;
  sync: Pick<Sync, "cruise">;
  send: (text: string) => void;
}) {
  // The chat Cruise was turned on for: another chat is off from its first render, so it can't ask before anything resets.
  const [onFor, setOnFor] = useState<string | null>(null);
  const on = onFor === slot;
  const [asking, setAsking] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The turn Cruise last asked for, so a re-render doesn't ask again for the same end of a turn.
  const asked = useRef<string | null>(null);
  // Which ask's answer still counts: Stop, a newer ask or another chat moves it on, and an answer that comes late is dropped.
  const generation = useRef(0);

  // Starts over, without a render when there is nothing to start over from (this runs when a chat opens).
  const clear = useCallback(() => {
    generation.current += 1;
    setAsking(false);
    setItems((kept) => (kept.length ? [] : kept));
    setAt(0);
    setError(null);
  }, []);

  // Another chat starts with none of this one's drafts (and no ask answered late counts), and coming back to a chat doesn't
  // find Cruise still on.
  useEffect(() => {
    asked.current = null;
    setOnFor(null);
    clear();
  }, [slot, clear]);

  const ask = useCallback(
    (refresh: boolean) => {
      const mine = ++generation.current;
      setAsking(true);
      setError(null);
      // A new turn's step isn't the last turn's: its draft goes while the new one is thought up. ("Another" keeps the one shown.)
      if (!refresh) setItems([]);
      sync.cruise(slot, refresh).then(
        (r) => {
          if (mine !== generation.current) return;
          // Only a next step for this very chat is ever offered, whatever the Mac sent.
          setItems(r.items.filter((i) => i.target.kind === "continue" && i.target.slot === slot));
          setAt(0);
          setAsking(false);
        },
        (e: Error) => {
          if (mine !== generation.current) return;
          setAsking(false);
          setError(e.message);
        },
      );
    },
    [slot, sync],
  );

  // Asks each time a turn ends: on, idle, and not already asked for this turn.
  useEffect(() => {
    if (!available || !on || asking || disabled) return;
    if (!shouldAsk({ status, asked: asked.current, turnKey })) return;
    asked.current = turnKey;
    ask(false);
  }, [available, on, asking, disabled, status, turnKey, ask]);

  const stop = useCallback(() => {
    setOnFor(null);
    clear();
  }, [clear]);

  return {
    on,
    asking,
    error,
    draft: draftAt(items, at),
    toggle: () => {
      if (on) stop();
      else {
        setError(null);
        setOnFor(slot);
      }
    },
    stop,
    /** The "Next step" button, with nothing offered yet: asks for one now. */
    nextStep: () => ask(true),
    /** "Another" goes round the drafts already made before it asks for more (each ask costs usage). One ask at a time. */
    another: () => {
      if (asking) return;
      if (at + 1 < items.length) setAt(at + 1);
      else ask(true);
    },
    // A quick reply does the same: the send is marked, and Cruise asks again when the next turn ends.
    doIt: () => {
      const d = draftAt(items, at);
      if (!d) return;
      send(d.message);
      setItems([]);
      setError(null);
    },
  };
}
