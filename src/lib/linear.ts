/**
 * Linear on the Desk (linear.rs): your issues that aren't Done, Closed or Canceled, asked while the Desk is on screen, and which Linear team each
 * Desk project's work is in. A team is the one Settings → Linear says, else the one whose issue identifiers ("ENG-142") the
 * repository's branches and pull requests carry most.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LinearWork, RepoStatus } from "../types";

/** How often the Desk asks again while it is on screen (the Mac keeps what Linear said for 90 s besides). */
const POLL_MS = 120_000;
const TEAMS_KEY = "linear.teams";
const HIDE_READY_KEY = "linear.hideReady";

/** An issue identifier, as Linear makes them: a team key, a dash, a number. */
export const ISSUE_ID = /\b([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})\b/g;
export const safeIssueId = (s: string) => /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(s);
export const safeIssueUrl = (s: string) => /^https:\/\/linear\.app\/[A-Za-z0-9._~/-]+$/.test(s);

/** Settings → Linear's choice of team for each Desk project (by folder); "" is "none". */
export type TeamChoice = Record<string, string>;

export function loadTeams(): TeamChoice {
  try {
    const v = JSON.parse(localStorage.getItem(TEAMS_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as TeamChoice) : {};
  } catch {
    return {};
  }
}

export function saveTeams(t: TeamChoice) {
  localStorage.setItem(TEAMS_KEY, JSON.stringify(t));
}

/** Settings → Linear: leave out the work of Ready issues (merged, waiting for a release) from Your work, on the Desk and the phone. */
export function loadHideReady(): boolean {
  try {
    return localStorage.getItem(HIDE_READY_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHideReady(on: boolean) {
  try {
    localStorage.setItem(HIDE_READY_KEY, on ? "1" : "0");
  } catch {
    /* kept for this run only */
  }
}

/** The team keys your branches and pull requests in a repository name, most named first (only the workspace's own teams count,
 * and only your own work: someone else's pull request can't move a project to another team). */
export function teamsSeen(r: RepoStatus, teams: string[]): string[] {
  const known = new Set(teams.map((t) => t.toUpperCase()));
  const n = new Map<string, number>();
  const mine = (author: string) => !!r.viewer && author.toLowerCase() === r.viewer.toLowerCase();
  const texts = [...r.prs.filter((p) => mine(p.author)).flatMap((p) => [p.branch, p.title]), ...r.merged.filter((m) => mine(m.author)).flatMap((m) => [m.branch, m.title]), ...(r.branches ?? []).map((b) => b.name)];
  for (const t of texts) for (const m of t.matchAll(ISSUE_ID)) {
    const key = m[1].toUpperCase();
    if (known.has(key)) n.set(key, (n.get(key) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** The Linear team of each repository (by its main checkout): chosen in Settings for one of its folders, else the most seen. */
export function teamOfRepo(repos: RepoStatus[] | null, work: LinearWork | null, chosen: TeamChoice): Record<string, string> {
  const out: Record<string, string> = {};
  const teams = work?.teams.map((t) => t.key) ?? [];
  for (const r of repos ?? []) {
    const pick = r.folders.map((f) => chosen[f.folder]).find((t) => t !== undefined);
    const team = pick !== undefined ? pick : teamsSeen(r, teams)[0];
    if (team) out[r.repo] = team;
  }
  return out;
}

/** What Linear says, asked while `on` and on `refresh`; null until it has said. */
export function useLinearWork(on: boolean): { work: LinearWork | null; refresh: () => void; set: (w: LinearWork | null) => void } {
  const [work, setWork] = useState<LinearWork | null>(null);
  const [tick, setTick] = useState(0);
  const again = useRef(false);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = (fresh: boolean) =>
      api.linearWork(fresh).then(
        (w) => live && setWork(w),
        () => {},
      );
    void load(again.current);
    again.current = false;
    const t = setInterval(() => void load(false), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [on, tick]);
  const refresh = useCallback(() => {
    again.current = true;
    setTick((n) => n + 1);
  }, []);
  return { work, refresh, set: setWork };
}
