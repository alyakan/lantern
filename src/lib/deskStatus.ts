/**
 * How the Desk's projects stand on git and GitHub (status.rs): a project row's branch, pull requests and release (Your work, in
 * yourWork.ts, reads the same). Every figure is what git and gh said; nothing here is guessed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * What the Mac says of the repositories with a chat open, asked while `on` (the Desk is on screen) and again whenever the Desk's
 * `folders` change (a project opened between two asks isn't left looking like no repository); null until it has said. A slow
 * answer (git in a big checkout) isn't asked again before it is in. `refresh` asks now, with GitHub asked again too.
 */
export function useDeskStatus(on: boolean, folders: string[]): { repos: RepoStatus[] | null; refresh: () => void } {
  const [repos, setRepos] = useState<RepoStatus[] | null>(null);
  const [fresh, setFresh] = useState(0);
  // Only the ask a Refresh makes goes to GitHub again; the Desk opening later uses what the Mac keeps.
  const again = useRef(false);
  const key = [...folders].sort().join("\n");
  useEffect(() => {
    if (!on) return;
    let live = true;
    let asking = false;
    const load = (again: boolean) => {
      if (asking) return;
      asking = true;
      api.deskStatus(again).then(
        (r) => {
          asking = false;
          if (live) setRepos(r);
        },
        () => void (asking = false),
      );
    };
    load(again.current);
    again.current = false;
    const tick = setInterval(() => load(false), POLL_MS);
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [on, key, fresh]);
  const refresh = useCallback(() => {
    again.current = true;
    setFresh((n) => n + 1);
  }, []);
  return { repos, refresh };
}
