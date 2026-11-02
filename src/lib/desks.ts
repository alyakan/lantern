/**
 * Desks: the Desk split by the user into named sets of projects ("Work" for their job's project, the first Desk for
 * everything else). Each project is on exactly one Desk. The first Desk is home: every project not given to another one is
 * on it, so a new project shows up without anything to set. What a Desk shows, and where its messages may go, are its
 * projects' chats only.
 */

import type { ProjectOpen } from "./sidebar";

export interface Desk {
  id: string;
  name: string;
  /** Its projects (folders). The home Desk's is ignored: it has every project no other Desk has. */
  projects: string[];
}

export interface Desks {
  /** Home first. */
  list: Desk[];
  /** The one on screen. */
  on: string;
}

export const HOME_ID = "home";
export const NAME_MAX = 40;
export const DESKS_MAX = 8;
export const NO_DESKS: Desks = { list: [{ id: HOME_ID, name: "Desk", projects: [] }], on: HOME_ID };

/** Desks read back from storage, with anything that doesn't fit dropped: home always first, each project on one Desk only. */
export function readDesks(raw: unknown): Desks {
  if (!raw || typeof raw !== "object") return NO_DESKS;
  const r = raw as { list?: unknown; on?: unknown };
  const seen = new Set<string>();
  const ids = new Set<string>();
  const list: Desk[] = [];
  for (const d of Array.isArray(r.list) ? r.list : []) {
    if (!d || typeof d !== "object") continue;
    const { id, name, projects } = d as Record<string, unknown>;
    if (typeof id !== "string" || !id || ids.has(id) || typeof name !== "string" || list.length >= DESKS_MAX) continue;
    const own = id === HOME_ID ? [] : (Array.isArray(projects) ? projects : []).filter((p): p is string => typeof p === "string" && !seen.has(p));
    own.forEach((p) => seen.add(p));
    ids.add(id);
    list.push({ id, name: name.trim().slice(0, NAME_MAX) || "Desk", projects: own });
  }
  const home = list.find((d) => d.id === HOME_ID) ?? NO_DESKS.list[0];
  const rest = list.filter((d) => d.id !== HOME_ID);
  const all = [home, ...rest];
  return { list: all, on: typeof r.on === "string" && all.some((d) => d.id === r.on) ? r.on : HOME_ID };
}

/** The Desk a project is on. */
export function deskOf(desks: Desks, folder: string): string {
  return desks.list.find((d) => d.id !== HOME_ID && d.projects.includes(folder))?.id ?? HOME_ID;
}

/** What is open on one Desk: its projects' entries of `open`. */
export function openOn<T extends ProjectOpen>(desks: Desks, id: string, open: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(open).filter(([folder]) => deskOf(desks, folder) === id));
}

/** How many things wait on you on each Desk. */
export function waitingBy(desks: Desks, open: Record<string, ProjectOpen>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(desks.list.map((d) => [d.id, 0]));
  for (const [folder, p] of Object.entries(open)) out[deskOf(desks, folder)] += p.needs;
  return out;
}

/** A new Desk, empty (its projects are moved onto it one at a time). Null when there are as many as there may be or no name. */
export function addDesk(desks: Desks, name: string, id: string): Desks | null {
  const n = name.trim().slice(0, NAME_MAX);
  if (!n || desks.list.length >= DESKS_MAX || desks.list.some((d) => d.id === id)) return null;
  return { list: [...desks.list, { id, name: n, projects: [] }], on: id };
}

export function renameDesk(desks: Desks, id: string, name: string): Desks {
  const n = name.trim().slice(0, NAME_MAX);
  return n ? { ...desks, list: desks.list.map((d) => (d.id === id ? { ...d, name: n } : d)) } : desks;
}

/** Removes a Desk; its projects go back home. Home can't be removed. */
export function removeDesk(desks: Desks, id: string): Desks {
  if (id === HOME_ID) return desks;
  return { list: desks.list.filter((d) => d.id !== id), on: desks.on === id ? HOME_ID : desks.on };
}

/** Puts a project on a Desk (taking it off the one it was on). */
export function moveProject(desks: Desks, folder: string, to: string): Desks {
  if (!desks.list.some((d) => d.id === to)) return desks;
  return { ...desks, list: desks.list.map((d) => ({ ...d, projects: d.id !== HOME_ID && d.id === to ? [...d.projects.filter((p) => p !== folder), folder] : d.projects.filter((p) => p !== folder) })) };
}
