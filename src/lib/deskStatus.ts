/**
 * How the Desk's projects stand on git and GitHub (status.rs): a project row's branch, pull requests and release, and the Desk's
 * "Repos today" (what merged, released or failed). Every figure is what git and gh said; nothing here is guessed.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import type { RepoStatus } from "../types";

/** How often the Desk asks again while it is on screen (the Mac keeps what GitHub said for 90 s besides). */
const POLL_MS = 120_000;

export interface ProjectStatus {
  branch: string | null;
  changed: number | null;
  gh: RepoStatus["gh"];
  error: string | null;
  open: number;
  failing: number;
  running: number;
  release: { tag: string; at: number | null } | null;
  drafts: number;
}

const time = (iso: string | null): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The project at `folder`, from the repository it is in: undefined while the Mac hasn't said, null when it isn't in one. */
export function statusFor(folder: string, repos: RepoStatus[] | null): ProjectStatus | null | undefined {
  if (!repos) return undefined;
  const repo = repos.find((r) => r.folders.some((f) => f.folder === folder));
  if (!repo) return null;
  const here = repo.folders.find((f) => f.folder === folder)!;
  return {
    branch: here.branch,
    changed: here.changed,
    gh: repo.gh,
    error: repo.error,
    open: repo.prs.length,
    failing: repo.prs.filter((p) => p.checks === "fail").length,
    running: repo.prs.filter((p) => p.checks === "pending").length,
    release: repo.release && { tag: repo.release.tag, at: time(repo.release.published_at) },
    drafts: repo.drafts.length,
  };
}

export type RepoEventKind = "failing" | "draft" | "merged" | "released";

export interface RepoEvent {
  key: string;
  kind: RepoEventKind;
  /** The repository's short name. */
  repo: string;
  /** "owner/name", for a link to GitHub. */
  github: string | null;
  number: number | null;
  text: string;
  /** null: no time to it (a failing check, a draft waiting). */
  at: number | null;
}

const short = (r: RepoStatus) => r.github?.split("/")[1] ?? r.repo.split("/").filter(Boolean).pop() ?? r.repo;

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * What happened in the repositories today, and what is left hanging: pull requests whose checks failed and releases waiting as
 * drafts first (they want something of you), then today's merges and releases, newest first. Each repository once.
 */
export function reposToday(repos: RepoStatus[] | null, now: number): RepoEvent[] {
  const hanging: RepoEvent[] = [];
  const today: RepoEvent[] = [];
  for (const r of repos ?? []) {
    const repo = short(r);
    const base = { repo, github: r.github };
    for (const p of r.prs) if (p.checks === "fail") hanging.push({ ...base, key: `${r.repo}:fail:${p.number}`, kind: "failing", number: p.number, text: p.title, at: null });
    for (const tag of r.drafts) hanging.push({ ...base, key: `${r.repo}:draft:${tag}`, kind: "draft", number: null, text: tag, at: null });
    for (const m of r.merged) {
      const at = time(m.merged_at);
      if (at !== null && sameDay(at, now)) today.push({ ...base, key: `${r.repo}:merged:${m.number}`, kind: "merged", number: m.number, text: m.title, at });
    }
    const at = time(r.release?.published_at ?? null);
    if (r.release && at !== null && sameDay(at, now)) today.push({ ...base, key: `${r.repo}:release:${r.release.tag}`, kind: "released", number: null, text: r.release.tag, at });
  }
  today.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return [...hanging, ...today];
}

/** What the Mac says of the repositories with a chat open, asked while `on` (the Desk is on screen); null until it has said. */
export function useDeskStatus(on: boolean): RepoStatus[] | null {
  const [repos, setRepos] = useState<RepoStatus[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () => api.deskStatus().then((r) => live && setRepos(r), () => {});
    load();
    const tick = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [on]);
  return repos;
}
