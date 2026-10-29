/**
 * The user's own to-do lists on the phone (the Mac keeps them, see src-tauri/src/todos.rs): how a due date reads, the order
 * they are shown in, and when "Tomorrow" is. Not Claude's plan for a turn (view/plan.ts).
 */
import type { RemoteUserTodo } from "../protocol/generated/RemoteUserTodo";

/** The hour a reminder for a day alone goes off. */
export const DAY_HOUR = 9;

/** Tomorrow at DAY_HOUR, this phone's local time: a reminder's "Tomorrow". */
export function tomorrowMorning(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, DAY_HOUR, 0).getTime();
}

/** How a due date reads: "Today", "Tomorrow 14:00", "Yesterday", "Fri", "3 Nov". */
export function dueText(date: string, time: string | null, now: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = Math.round((new Date(y, m - 1, d).getTime() - startToday) / 86_400_000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : diff > 1 && diff < 7 ? days[new Date(y, m - 1, d).getDay()] : `${d} ${months[m - 1]}${y === today.getFullYear() ? "" : ` ${y}`}`;
  return time ? `${name} ${time}` : name;
}

/** Overdue open items first, then the other open ones as the Mac keeps them, then the done ones. */
export function shownTodos(items: RemoteUserTodo[]): RemoteUserTodo[] {
  const open = items.filter((t) => !t.done);
  return [...open.filter((t) => t.overdue), ...open.filter((t) => !t.overdue), ...items.filter((t) => t.done)];
}

/** A day typed on the phone ("2026-11-03"), checked as the Mac checks it. */
export function validDay(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(y, mo - 1, d);
  return day.getFullYear() === y && day.getMonth() === mo - 1 && day.getDate() === d;
}

/** What a reminder's push says it is about: the project whose list a tap opens, and the item (when it was one). */
export function todoOfNotification(data: unknown): { project: string; todo: string | null } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { kind?: unknown; project?: unknown; todo?: unknown };
  if (d.kind !== "todo" || typeof d.project !== "string" || !d.project.startsWith("/") || d.project.length > 1024 || d.project.includes("\0")) return null;
  const todo = typeof d.todo === "string" && /^[0-9a-f]{1,32}$/.test(d.todo) ? d.todo : null;
  return { project: d.project, todo };
}
