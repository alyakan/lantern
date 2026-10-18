/**
 * Life journal (Today page) data shared by the main process and the renderer.
 */

export type JournalDay = {
  /** YYYY-MM-DD, local time. */
  date: string;
  intention?: string;
  wins?: string;
  drains?: string;
  tomorrow?: string;
};

export type JournalState = {
  day: JournalDay;
  /** Yesterday's "one thing for tomorrow", shown as today's starting point. */
  carried?: string;
  streak: number;
  /** Absolute path of the Life project folder. */
  dir: string;
};
