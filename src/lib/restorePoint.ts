import { useEffect, useState } from "react";
import { api, type RestoreResult } from "../api";
import type { ChatItem, Status } from "../store";
import { latestTurnOf } from "./revert";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many of a restore's files Claude is told about: a long list says the rest in a line. */
const NOTED = 50;

/** One line for the chat after a restore: what went back, what went to the Trash, what was left alone and why. */
export function restoreSummary(result: RestoreResult, since: string): string {
  const parts: string[] = [];
  const back = result.put_back.length;
  const gone = result.removed.length;
  if (back > 0) parts.push(`${count(back, "file is", "files are")} back to how ${back === 1 ? "it" : "they"} stood before ${since}.`);
  if (gone > 0) parts.push(`${count(gone, "file Claude created was", "files Claude created were")} moved to the Trash.`);
  if (result.skipped.length > 0) {
    const why = [...new Set(result.skipped.map((s) => s.reason))];
    parts.push(`${count(result.skipped.length, "file was", "files were")} left alone: ${why.join(" ")}`);
  }
  return parts.join(" ") || "Nothing needed changing.";
}

/** One line after an Undo of a restore. */
export function undoRestoreSummary(result: RestoreResult): string {
  const kept = result.kept.length;
  if (kept === 0) return "The restore is undone.";
  return `The restore is undone, except ${kept === 1 ? "one file" : `${kept} files`} you edited since: ${kept === 1 ? "it was" : "they were"} left as ${kept === 1 ? "it is" : "they are"}.`;
}

/** The files Claude is told were changed under it, for the note that goes with the next message. */
export function restoredFiles(result: RestoreResult): { path: string; trashed: boolean }[] {
  return [...result.put_back.map((path) => ({ path, trashed: false })), ...result.removed.map((path) => ({ path, trashed: true }))].slice(0, NOTED);
}

const NO_POINTS: ReadonlySet<number> = new Set();

/**
 * The messages of the chat that have a restore point (by turn number), asked of the backend again when a message is
 * numbered and when a turn starts or ends. Empty when `enabled` is off, or for a folder that isn't a git repository.
 */
export function useRestorePoints(slot: string, enabled: boolean, items: ChatItem[], status: Status): ReadonlySet<number> {
  const [points, setPoints] = useState<ReadonlySet<number>>(NO_POINTS);
  const latest = latestTurnOf(items);
  const running = status === "running";
  useEffect(() => {
    if (!enabled) {
      setPoints(NO_POINTS);
      return;
    }
    let live = true;
    api.restorePoints(slot).then(
      (turns) => live && setPoints(new Set(Array.isArray(turns) ? turns : [])),
      () => live && setPoints(NO_POINTS),
    );
    return () => {
      live = false;
    };
  }, [slot, enabled, latest, running]);
  return enabled ? points : NO_POINTS;
}
