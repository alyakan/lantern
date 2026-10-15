import { useEffect, useRef, useState } from "react";
import type { OldLocation, SessionSummary } from "../types";
import { basename } from "../lib/diff";
import { HistoryMenu } from "./HistoryMenu";

interface Props {
  folder: string;
  /** The session ids of the chats that are open: the sidebar has them, so History lists past chats only. */
  exclude: string[];
  load: () => Promise<SessionSummary[]>;
  /** The places the project's chats came from that aren't brought over, read when History opens. */
  loadOld: () => Promise<OldLocation[]>;
  onBring: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}

// One project's History, under the title bar: opened from "Show all…" in the sidebar, or ⌘K for the project on screen.
// It reads the folder's past chats when it opens, and closes on a press outside it.
export function HistoryPopover({ folder, exclude, load, loadOld, onBring, onOpen, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [old, setOld] = useState<OldLocation[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessions(null);
    setOld(null);
    load().then(setSessions, () => setSessions([]));
    loadOld().then(setOld, () => setOld([]));
  }, [folder]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // The old sessions History offers to bring over: those of places not brought over yet.
  const toBring = (old ?? []).filter((p) => !p.already).reduce((n, p) => n + p.sessions, 0);
  return (
    <div className="history-popover" ref={root}>
      <HistoryMenu sessions={sessions} exclude={exclude} project={basename(folder)} onClose={onClose} onOpen={onOpen} oldSessions={toBring > 0 ? { count: toBring, onOpen: onBring } : null} />
    </div>
  );
}
