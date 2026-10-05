import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../types";
import { HistoryMenu, type OpenChat } from "./HistoryMenu";
import { ClockIcon } from "./icons";

interface Props {
  loadSessions: () => Promise<SessionSummary[]>;
  currentId: string | null;
  onOpen: (id: string) => void;
  disabled?: boolean;
  openChats?: OpenChat[];
  onSwitch?: (slot: string) => void;
}

// The capsule next to the folder picker above the composer: pick a past session to continue, like VS Code's project menu.
export function SessionPill({ loadSessions, currentId, onOpen, disabled, openChats, onSwitch }: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    setSessions(null);
    setOpen(true);
    loadSessions().then(setSessions, () => setSessions([]));
  };

  return (
    <div className="pill-anchor" ref={root}>
      <button className="pill" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title="Continue a past session" onClick={toggle}>
        <ClockIcon />
        <span>New session</span>
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <HistoryMenu
          sessions={sessions}
          currentId={currentId}
          onClose={() => setOpen(false)}
          onOpen={(id) => {
            setOpen(false);
            onOpen(id);
          }}
          open={openChats}
          onSwitch={(slot) => {
            setOpen(false);
            onSwitch?.(slot);
          }}
        />
      )}
    </div>
  );
}
