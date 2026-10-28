/** The plan's five-hour window, in seconds. */
export const SESSION_SECS = 5 * 3600;
export const HOUR_SECS = 3600;
export const DAY_SECS = 24 * 3600;

/** A mark on a usage bar: where an even pace would have it at the end of each hour (or day) of the window. */
export interface Mark {
  /** 0 to 1 along the bar. */
  at: number;
  /** When it is, in unix seconds. */
  when: number;
}

export interface Marks {
  marks: Mark[];
  /** Where an even pace would have the bar now (0 to 1), or null when the reset isn't known. */
  pace: number | null;
}

/**
 * The marks on a bar for a window of `windowSecs` ending at `resetsAt`, one each `stepSecs` (the ends of the window's
 * first hour, second hour, …: not its start or end), and where an even pace would be by `now`.
 */
export function windowMarks(resetsAt: number | null, windowSecs: number, stepSecs: number, now = Date.now()): Marks {
  if (resetsAt === null) return { marks: [], pace: null };
  const start = resetsAt - windowSecs;
  const marks: Mark[] = [];
  for (let t = stepSecs; t < windowSecs; t += stepSecs) marks.push({ at: t / windowSecs, when: start + t });
  const gone = now / 1000 - start;
  return { marks, pace: Math.min(1, Math.max(0, gone / windowSecs)) };
}
