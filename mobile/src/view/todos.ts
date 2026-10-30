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

/** A project as a reminder's push names it: a token the Mac maps back (no path goes through Apple or Expo). */
export const isProjectToken = (s: string) => /^[0-9a-f]{16}$/.test(s);

/** What a reminder's push says it is about: the project whose list a tap opens (its token), and the item (when it was one). */
export function todoOfNotification(data: unknown): { project: string; todo: string | null } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { kind?: unknown; project?: unknown; todo?: unknown };
  if (d.kind !== "todo" || typeof d.project !== "string" || !isProjectToken(d.project)) return null;
  const todo = typeof d.todo === "string" && /^[0-9a-f]{1,32}$/.test(d.todo) ? d.todo : null;
  return { project: d.project, todo };
}

/** A day as the Mac keeps it: "2026-11-03", this phone's local time. */
export function dayOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type TodoSection = { key: "overdue" | "today" | "upcoming" | "none"; title: string; items: RemoteUserTodo[] };

/**
 * The open items in the Mac's sections, empty ones left out: Overdue (as the Mac says), Today, Upcoming (soonest first) and
 * No date (in the Mac's order).
 */
export function todoSections(items: RemoteUserTodo[], now: number): TodoSection[] {
  const today = dayOf(new Date(now));
  const open = items.filter((t) => !t.done);
  const overdue = open.filter((t) => t.overdue);
  const rest = open.filter((t) => !t.overdue);
  const when = (t: RemoteUserTodo) => `${t.due_date} ${t.due_time ?? "99:99"}`;
  const all: TodoSection[] = [
    { key: "overdue", title: "Overdue", items: overdue },
    { key: "today", title: "Today", items: rest.filter((t) => t.due_date !== null && t.due_date <= today) },
    { key: "upcoming", title: "Upcoming", items: rest.filter((t) => t.due_date !== null && t.due_date > today).sort((a, b) => when(a).localeCompare(when(b))) },
    { key: "none", title: "No date", items: rest.filter((t) => t.due_date === null) },
  ];
  return all.filter((s) => s.items.length > 0);
}

/** The days a new to-do can be given with one tap, as on the Mac: Today, Tomorrow, Next week (a week from today). */
export function quickDays(now: number): { label: string; date: string }[] {
  const d = new Date(now);
  const plus = (n: number) => dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  return [
    { label: "Today", date: plus(0) },
    { label: "Tomorrow", date: plus(1) },
    { label: "Next week", date: plus(7) },
  ];
}

/** A month for picking a day: its weeks, Monday first, each day as "YYYY-MM-DD" or null where the month hasn't begun or has ended. */
export function monthWeeks(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => dayOf(new Date(year, month, i + 1)))];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}
