import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";
import { HudCheckIcon, HudFailIcon, HudStopIcon, WaitIcon } from "./icons";
import { whenFocused } from "../lib/windowFocus";
import { chimeOn, playChime, setChime } from "../lib/chime";

export type HudKind = "finished" | "stopped" | "failed" | "waiting";
/** `key` changes for every turn that ends, so the same kind twice in a row still shows. */
export interface HudEvent {
  key: number;
  kind: HudKind;
  /** Dimmer, after the label: e.g. how long the turn took. */
  detail?: string | null;
  /** What happened, on a second line: the first line of Claude's reply, or what it's waiting for. */
  body?: string | null;
  /** About a chat that isn't on screen: which one, so clicking the toast switches to it. */
  chat?: { slot: string; title: string; project: string | null };
}

const LOOK: Record<HudKind, { label: string; icon: ReactElement }> = {
  finished: { label: "Finished", icon: <HudCheckIcon /> },
  stopped: { label: "Stopped", icon: <HudStopIcon /> },
  failed: { label: "Failed", icon: <HudFailIcon /> },
  waiting: { label: "Needs you", icon: <WaitIcon /> },
};

/**
 * A toast at the top middle, under the title bar, when a turn ends: it slides down with a glowing border in its
 * status colour, says what happened, and slides back up after a few seconds (paused while hovered, with a line that
 * runs out meanwhile). "Needs you" stays until it's clicked or answered: Claude is blocked until then. If the window
 * isn't focused it waits until you're back. About another chat it names the chat and opens it when clicked.
 */
export function Hud({ event, onOpenChat }: { event: HudEvent | null; onOpenChat?: (slot: string) => void }) {
  const [shown, setShown] = useState<HudEvent | null>(null);
  const [sound, setSound] = useState(chimeOn);
  useEffect(() => {
    // Taken back (e.g. the chat waiting for you was answered).
    if (!event) return setShown(null);
    return whenFocused(() => {
      setShown(event);
      // A sound only for another chat: the one on screen you're already watching.
      if (event.chat) playChime(event.kind === "finished" ? "good" : "attention");
    });
  }, [event?.key, event === null]);
  // Esc dismisses it, unless you're typing or a menu is open (Esc is theirs then).
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || document.querySelector(".menu, [role='dialog']")) return;
      setShown(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);
  if (!shown) return null;

  const look = LOOK[shown.kind];
  const sticky = shown.kind === "waiting";
  const slot = shown.chat?.slot;
  const open = () => {
    setShown(null);
    if (slot) onOpenChat?.(slot);
  };
  const onKey = (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open());
  return (
    <div
      key={shown.key}
      className={`hud ${shown.kind}${shown.chat ? " other" : ""}${sticky ? " sticky" : ""}`}
      role="status"
      tabIndex={0}
      title={shown.chat ? "Open this chat" : "Dismiss"}
      // Its time running out is the end of its own "toast" animation; the glow and the line end on their own.
      onAnimationEnd={(e) => e.target === e.currentTarget && !sticky && /^toast/.test(e.animationName) && setShown(null)}
      onClick={open}
      onKeyDown={onKey}
    >
      <span className="hud-icon">{look.icon}</span>
      <span className="hud-text">
        <span className="hud-head">
          <span className="hud-label">{look.label}</span>
          {shown.chat ? (
            <span className="hud-chat">
              <span className="hud-chat-title">{shown.chat.title}</span>
              {shown.chat.project && <span className="hud-detail">{shown.chat.project}</span>}
            </span>
          ) : (
            shown.detail && <span className="hud-detail">{shown.detail}</span>
          )}
        </span>
        {shown.body && <span className="hud-body">{shown.body}</span>}
      </span>
      <button
        className="hud-sound"
        aria-label={sound ? "Turn toast sounds off" : "Turn toast sounds on"}
        aria-pressed={sound}
        title={sound ? "Sound on: click to mute" : "Play a sound with these toasts"}
        onClick={(e) => {
          e.stopPropagation();
          setChime(!sound);
          setSound(!sound);
        }}
      >
        <SpeakerIcon on={sound} />
      </button>
      <button
        className="hud-close"
        aria-label="Dismiss"
        title="Dismiss (Esc)"
        onClick={(e) => {
          e.stopPropagation();
          setShown(null);
        }}
      >
        ×
      </button>
      {!sticky && <span className="hud-timer" aria-hidden />}
    </div>
  );
}

const SpeakerIcon = ({ on }: { on: boolean }) => (
  <svg width="13" height="12" viewBox="0 0 13 12" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M1.5 4.3h2.2L6.6 2v8L3.7 7.7H1.5z" />
    {on ? <path d="M8.6 4.1a2.7 2.7 0 0 1 0 3.8M10.3 2.6a4.8 4.8 0 0 1 0 6.8" /> : <path d="M8.6 4.4l3 3.2M11.6 4.4l-3 3.2" />}
  </svg>
);
