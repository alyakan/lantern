import { useEffect, useState } from "react";

/** A soft two-note chime for toasts, made with Web Audio (no sound files). Off unless the user turns it on. */

const KEY = "toast.sound";
// Its own event, so every switch (the toast's speaker, Settings' General tab) shows the same state at once.
const CHANGED = "lantern:chime";

export const chimeOn = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};

export function setChime(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // storage unavailable: it just won't be remembered
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Whether toast sounds are on, kept in step with every place that turns them on or off. */
export function useChimeOn(): boolean {
  const [on, setOn] = useState(chimeOn);
  useEffect(() => {
    const sync = () => setOn(chimeOn());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return on;
}

let ctx: AudioContext | null = null;

/** Two quick sine notes, rising for good news, falling when Claude needs you or something failed. */
export function playChime(kind: "good" | "attention"): void {
  if (!chimeOn() || typeof AudioContext === "undefined") return;
  try {
    ctx ??= new AudioContext();
    const notes = kind === "good" ? [880, 1318.5] : [987.8, 740];
    notes.forEach((freq, i) => {
      const at = ctx!.currentTime + i * 0.11;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.5);
    });
  } catch {
    // No audio: the toast is enough.
  }
}
