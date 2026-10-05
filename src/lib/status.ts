import type { State } from "../store";

/** What the title bar's activity viewer says, like Xcode's "Build Succeeded | Today at 10:22". */
export interface ActivityStatus {
  text: string;
  /** After the text, dimmer: when the last turn ended. */
  detail: string | null;
  /** Claude is busy: the viewer's progress bar runs. */
  working: boolean;
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** `finishedAt`: when this chat's last turn ended, if it ended while the app was open. */
export function activityStatus(s: State, finishedAt: Date | null, now = new Date()): ActivityStatus {
  if (!s.folder) return { text: "No folder open", detail: null, working: false };
  if (s.status === "starting") return { text: "Starting Claude…", detail: null, working: true };
  if (s.status === "ended") return { text: "Claude stopped", detail: null, working: false };
  if (s.items.some((it) => it.type === "permission" && it.decision === null)) return { text: "Waiting for you", detail: null, working: false };
  if (s.status === "running") return { text: "Claude is working", detail: null, working: true };
  const last = [...s.items].reverse().find((it) => it.type === "turn");
  if (!last || last.type !== "turn") return { text: "Ready", detail: null, working: false };
  const text = last.stopped ? "Stopped" : last.isError ? "Failed" : "Finished";
  if (!finishedAt) return { text, detail: null, working: false };
  const sameDay = finishedAt.toDateString() === now.toDateString();
  return { text, detail: sameDay ? `Today at ${clock(finishedAt)}` : finishedAt.toLocaleDateString([], { month: "short", day: "numeric" }), working: false };
}
