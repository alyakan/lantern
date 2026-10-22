/** What a phone may choose for a chat (Ask or Auto, and which preset of models), in words. */
import type { Controls } from "../protocol/generated/Controls";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";

export const MODES: { value: RemotePermissions; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Edits apply; commands and other actions ask you first" },
  { value: "auto", label: "Auto", hint: "A classifier approves most actions; you're rarely asked" },
];

export const modeLabel = (m: RemotePermissions) => MODES.find((x) => x.value === m)?.label ?? m;

/** Why Auto can't be chosen, or null: the Mac's setting (Settings › Remote control) is the Mac's to turn on. */
export const AUTO_OFF_NOTE = "Turn on “Let paired phones use Auto” in Lantern's Settings, under Remote control.";

export function autoNote(controls: Controls | null): string | null {
  return controls && !controls.allow_auto ? AUTO_OFF_NOTE : null;
}

/** A preset's name by its id; the id itself when the Mac no longer lists it (a preset deleted since). */
export function presetName(controls: Controls | null, id: string): string {
  return controls?.presets.find((p) => p.id === id)?.name ?? id;
}

/** Why a chat can't be switched now, or null: switching restarts its claude, so only a chat doing nothing may be. */
export function whyNotNow(chat: RemoteChat | undefined): string | null {
  switch (chat?.status) {
    case "idle":
      return null;
    case "working":
    case "needs_you":
      return "Claude is busy in this chat. Change it once it has finished.";
    case "asleep":
      return "This chat is asleep. Wake it first.";
    case "ended":
      return "This chat has stopped.";
    default:
      return "This chat isn't open on your Mac.";
  }
}
