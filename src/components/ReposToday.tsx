import { reposToday, type RepoEventKind } from "../lib/deskStatus";
import { elapsed } from "../lib/time";
import type { RepoStatus } from "../types";

const MARK: Record<RepoEventKind, string> = { failing: "✕", draft: "◷", merged: "✓", released: "↑" };
const WORD: Record<RepoEventKind, string> = { failing: "Checks failing", draft: "Draft release waiting", merged: "Merged", released: "Released" };

/**
 * What happened in the Desk's repositories today, from git and GitHub only: pull requests whose checks failed and releases left
 * as drafts first, then today's merges and releases. A quiet day says so; nothing is shown before the Mac has asked.
 */
export function ReposToday({ repos, now }: { repos: RepoStatus[] | null; now: number }) {
  if (!repos || repos.length === 0) return null;
  const events = reposToday(repos, now);
  const many = new Set(repos.map((r) => r.repo)).size > 1;
  return (
    <section className="desk-repos" aria-label="Repos today">
      <h2 className="desk-h">Repos today</h2>
      {events.length === 0 ? (
        <p className="muted">Nothing merged, released or failing today.</p>
      ) : (
        <ul className="desk-repo-list">
          {events.map((e) => (
            <li key={e.key} className={`desk-repo-event ${e.kind}`}>
              <span className="desk-repo-mark" aria-hidden>
                {MARK[e.kind]}
              </span>
              <span className="desk-repo-what">
                {WORD[e.kind]}: {e.number !== null && <span className="desk-repo-num">#{e.number} </span>}
                {e.text}
              </span>
              {many && <span className="desk-repo-name">{e.repo}</span>}
              {e.at !== null && <time className="desk-time">{now - e.at < 60_000 ? "just now" : `${elapsed(now - e.at)} ago`}</time>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
