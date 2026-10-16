import { useEffect, useState } from "react";
import { api } from "../api";
import type { MergeTestsReport } from "../types";

/** Whether a proposed merge's tests run by themselves (Settings → General). Off until the user turns it on. */
const KEY = "lantern.autoMergeTests";
const CHANGED = "lantern-auto-merge-tests";

export function autoMergeTests(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

/** Tells the backend the setting, which is where a proposed merge checks it. Done when the window starts and on every change. */
export function pushAutoMergeTests(): Promise<void> {
  return api.setAutoMergeTests(autoMergeTests()).catch(() => {});
}

export function setAutoMergeTests(on: boolean): void {
  try {
    localStorage.setItem(KEY, String(on));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
  void api.setAutoMergeTests(on).catch(() => {});
}

/** The setting, kept in step with every place that changes it. */
export function useAutoMergeTests(): boolean {
  const [on, setOn] = useState(autoMergeTests);
  useEffect(() => {
    const sync = () => setOn(autoMergeTests());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return on;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The result in plain words: "Tests passed: 214", "3 tests failed", "Tests timed out". */
export function testsHeadline(r: Pick<MergeTestsReport, "result" | "passed" | "failed">): string {
  if (r.result === "timed_out") return "Tests timed out";
  if (r.result === "passed") return r.passed ? `Tests passed: ${r.passed}` : "Tests passed";
  return r.failed ? `${plural(r.failed, "test")} failed` : "Tests failed";
}

/** "42s", "3m 05s": how long a run has gone (or took), to the second. */
export function testsClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A command's words as one line to read (a word with spaces in it is quoted, so it is clear where each one ends). */
export function commandLine(words: string[]): string {
  return words.map((w) => (w === "" || /[\s"'\\]/.test(w) ? JSON.stringify(w) : w)).join(" ");
}
