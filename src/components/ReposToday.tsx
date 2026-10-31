import { useState } from "react";
import { reposToday, type RepoEventKind } from "../lib/deskStatus";
import { elapsed } from "../lib/time";
import type { RepoStatus } from "../types";
import { Card } from "./DeskCard";

const MARK: Record<RepoEventKind, string> = { failing: "✕", draft: "◷", merged: "✓", released: "↑" };
/** The lines shown before "Show N more": what is left hanging is always shown. */
const SHOWN = 5;
const WORD: Record<RepoEventKind, string> = { failing: "Checks failing", draft: "Draft release waiting", merged: "Merged", released: "Released" };

/**
 * What happened in the Desk's repositories today, from git and GitHub only: pull requests whose checks failed and releases left
 * as drafts first, then today's merges and releases. A quiet day says so; nothing is shown before the Mac has asked.
 */
export function ReposToday({ repos, now }: { repos: RepoStatus[] | null; now: number }) {
  const [all, setAll] = useState(false);
  if (!repos || repos.length === 0) return null;
  const events = reposToday(repos, now);
  const hanging = events.filter((e) => e.at === null).length;
  const shown = all ? events : events.slice(0, Math.max(SHOWN, hanging));
  const more = events.length - shown.length;
  const many = new Set(repos.map((r) => r.repo)).size > 1;
  return (
    <Card title="Repos today" count={events.length} heading="h2" className="desk-repos desk-wide">
      {events.length === 0 ? (
        <p className="dp-note">Nothing merged, released or failing today.</p>
      ) : (
        <ul className="desk-repo-list">
          {shown.map((e) => (
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
      {more > 0 && (
        <button className="desk-more dp-foot" onClick={() => setAll(true)}>
          Show {more} more
        </button>
      )}
    </Card>
  );
}
