import { useContext, useEffect, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { PROJECT_COLORS } from "../lib/projectColors";
import { initials } from "../lib/sidebar";
import { elapsed } from "../lib/time";
import { todoPrompt, type Todo } from "../lib/todos";
import { projectsOf, type WorkItem, type Target } from "../lib/yourWork";
import type { RepoStatus, StorageItem } from "../types";
import { Card, Row } from "./DeskCard";
import { DeskProjectLanding } from "./DeskProjectLanding";
import { ExternalLink } from "./ExternalLink";
import { ProjectColors, YourWork } from "./YourWork";

export interface DeskProjectProps {
  row: ProjectRow;
  /** This project's chats. */
  chats: InboxRow[];
  /** Its repository as the Mac last said; undefined while it hasn't, null when it isn't in one. */
  repo: RepoStatus | null | undefined;
  /** This project's own work, as Your work lists it (only its repository's), and how to act on it. */
  work?: WorkItem[];
  /** Linear is connected: the work can be grouped by feature. */
  issues?: boolean;
  onStep?: (item: WorkItem, target: Target) => boolean;
  onRefresh?: () => void;
  now: number;
  onBack: () => void;
  onOpen: (slot: string) => void;
  onNewChat: (folder: string) => void;
  /** Starts a chat in the project with this as its first message, and one linked to a to-do (the landing page's). */
  onStartChat?: (folder: string, first: string) => void;
  onStartTodo?: (folder: string, todo: Todo) => void;
}

const ago = (now: number, at: number | null) => (at === null ? "" : now - at < 60_000 ? "just now" : `${elapsed(now - at)} ago`);
const STATE: Record<RowState, string | null> = { working: "working", waiting: "needs you", done: null, asleep: "asleep" };
const CHECKS: Record<RepoStatus["prs"][number]["checks"], string> = { pass: "checks pass", fail: "checks failing", pending: "checks running", none: "no checks" };
const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes asked for", REVIEW_REQUIRED: "needs a review" };
const GB = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** What the Storage scan says of each of the project's worktrees: the same verdict, and the same delete, as the Storage tab. */
function useStorage(on: boolean) {
  const [items, setItems] = useState<StorageItem[] | null>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () =>
      api.storageState().then(
        (v) => {
          if (!live) return;
          setItems(v.scanned_at === null ? null : v.items);
          setScanning(v.scanning);
        },
        () => {},
      );
    load();
    const unlisten = api.onStorageChanged(load).catch(() => null);
    return () => {
      live = false;
      unlisten.then((f) => f?.());
    };
  }, [on]);
  return { items, scanning };
}

/** The open to-dos of the project, nearest due first, then the newest. */
function useTodos(folder: string) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.todosList(folder).then((l) => live && setTodos(l.items.filter((t) => !t.done)), () => {});
    load();
    const unlisten = api.onTodosChanged(load).catch(() => null);
    return () => {
      live = false;
      unlisten.then((f) => f?.());
    };
  }, [folder]);
  const due = (t: Todo) => (t.due ? `${t.due.date} ${t.due.time ?? "99:99"}` : "9999");
  return todos && [...todos].sort((a, b) => due(a).localeCompare(due(b)) || b.created_at - a.created_at);
}

type Wt = RepoStatus["worktrees"][number];

/** Where a worktree stands, in a word or two, and why: what the Storage scan said, or what keeps it off its list. */
type Standing = { kind: "safe" | "review" | "blocked" | "other"; word: string; why: string | null };

function standingOf(wt: Wt, item: StorageItem | undefined, scanned: boolean, chatOpen: boolean): Standing {
  if (chatOpen) return { kind: "other", word: "Chat open", why: "A chat is open in it." };
  if (wt.locked) return { kind: "blocked", word: "Locked", why: "It is locked: `git worktree unlock` it first." };
  if (!scanned) return { kind: "other", word: "Not scanned", why: null };
  if (!item) return { kind: "other", word: "Not scanned", why: "It isn't in the last Storage scan." };
  if (item.risk === "safe") return { kind: "safe", word: "Safe to remove", why: null };
  return { kind: item.risk, word: item.risk === "review" ? "Check first" : "Keep", why: item.warning };
}
const ORDER: Record<Standing["kind"], number> = { safe: 0, review: 1, blocked: 2, other: 3 };
const SHOWN = 8;

/** A worktree: its branch, Remove when the scan found it safe, and under it where it stands, its size and why. */
function WorktreeRow({ wt, item, standing }: { wt: Wt; item: StorageItem | undefined; standing: Standing }) {
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState<{ kind: "removing" } | { kind: "failed"; why: string } | null>(null);
  const name = wt.path.split("/").filter(Boolean).pop() ?? wt.path;
  const remove = () => {
    if (!item) return;
    setState({ kind: "removing" });
    api.storageDelete([item.id]).then(
      ([out]) => setState(out?.ok ? null : { kind: "failed", why: out?.error ?? "It couldn't be removed." }),
      (err) => setState({ kind: "failed", why: String(err) }),
    );
  };
  const failed = state?.kind === "failed";
  const kind = failed ? "blocked" : standing.kind;
  const action =
    standing.kind === "safe" && item ? (
      asking ? (
        <>
          <button className="danger" aria-label={`Remove the worktree ${name}`} disabled={state?.kind === "removing"} onClick={remove}>
            {state?.kind === "removing" ? "Removing…" : "Remove"}
          </button>
          <button onClick={() => setAsking(false)}>Cancel</button>
        </>
      ) : (
        <button aria-label={`Remove ${name}…`} title="Its branch and commits stay in the repository" onClick={() => setAsking(true)}>
          Remove…
        </button>
      )
    ) : null;
  return (
    <li className="dp-row" title={wt.path}>
      <Row
        title={<span className="dp-mono">{wt.branch ?? "detached"}</span>}
        aside={action}
        meta={
          <>
            <span className={`dp-tone dp-tone-${kind}`}>{failed ? "Not removed" : standing.word}</span>
            {item && ` · ${GB(item.bytes)}`}
            {` · ${(failed ? state.why : standing.why) ?? name}`}
          </>
        }
      />
    </li>
  );
}

/** The repository's worktrees (not a team agent's: the team cleans those up), the ones safe to remove first. */
function Worktrees({ worktrees, folders, storage }: { worktrees: Wt[]; folders: string[]; storage: ReturnType<typeof useStorage> }) {
  const [all, setAll] = useState(false);
  const scanned = storage.items !== null;
  const rows = worktrees
    .filter((wt) => !wt.agent)
    .map((wt) => {
      const item = storage.items?.find((i) => i.kind === "worktree" && i.path === wt.path);
      return { wt, item, standing: standingOf(wt, item, scanned, folders.includes(wt.path)) };
    })
    .sort((a, b) => ORDER[a.standing.kind] - ORDER[b.standing.kind]);
  const safe = rows.filter((r) => r.standing.kind === "safe");
  const freed = safe.reduce((n, r) => n + (r.item?.bytes ?? 0), 0);
  const shown = all ? rows : rows.slice(0, SHOWN);
  if (!rows.length) return null;
  return (
    <Card
      title="Worktrees"
      count={rows.length}
      action={
        !storage.scanning && (
          <button className="desk-more" onClick={() => void api.storageScan().catch(() => {})}>
            {scanned ? "Scan again" : "Scan now"}
          </button>
        )
      }
    >
      <p className="dp-note">
        {storage.scanning
          ? "Storage is scanning…"
          : !scanned
            ? "Scan to see which are safe to remove."
            : safe.length
              ? `${safe.length} safe to remove, ${GB(freed)} in all.`
              : "None is safe to remove now."}
      </p>
      <ul className="dp-list">
        {shown.map((r) => (
          <WorktreeRow key={r.wt.path} {...r} />
        ))}
      </ul>
      {rows.length > SHOWN && (
        <button className="desk-more dp-foot" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${rows.length - SHOWN} more`}
        </button>
      )}
    </Card>
  );
}

/** The project's colour in the sidebar, so its page wears the same mark as its tile and its chats. */
function useProjectColor(folders: string[], fallback: string): string {
  const colors = useContext(ProjectColors);
  const index = folders.map((f) => colors[f]).find((i) => i !== undefined);
  return index !== undefined ? (PROJECT_COLORS[index] ?? fallback) : fallback;
}

/**
 * A project's own head, first on its page: its name and mark in the sidebar's colour, where its checkout stands, and the features
 * its work is in, a chip each that opens it. A page plainly a project's, not the Desk's: the way back is here, and the colour.
 */
function ProjectHead({ row, repo, here, chats, work, color, onBack, onFeature }: { row: ProjectRow; repo: RepoStatus | null | undefined; here: RepoStatus["folders"][number] | undefined; chats: InboxRow[]; work: WorkItem[] | undefined; color: string; onBack: () => void; onFeature: (key: string) => void }) {
  const features = repo ? projectsOf(work ?? [], repo.repo) : [];
  const prs = repo?.prs.length ?? 0;
  return (
    <div className="dp-card dp-project" style={{ "--proj": color } as CSSProperties}>
      <div className="dp-project-top">
        <button className="desk-back" onClick={onBack}>
          ‹ All projects
        </button>
        <span className="dp-project-facts">
          <span>
            <b>{chats.length}</b> chat{chats.length === 1 ? "" : "s"}
          </span>
          {prs > 0 && (
            <span>
              <b>{prs}</b> PR{prs === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </div>
      <div className="dp-project-body">
        <span className="dp-project-mark" aria-hidden>
          {initials(row.label, 2)}
        </span>
        <div className="dp-project-id">
          <h2 className="dp-project-name" title={row.folder}>
            {row.label}
          </h2>
          <p className="dp-project-meta">
            {here?.branch ? <span className="dp-mono">{here.branch}</span> : <span className="dp-muted">{repo === null ? "Not a git repository" : repo === undefined ? "Nothing in flight" : "No checkout read yet"}</span>}
            {!!here?.changed && ` · ${here.changed} changed`}
            {repo?.github && ` · ${repo.github}`}
          </p>
        </div>
      </div>
      {features.length > 0 && (
        <div className="dp-project-features" role="group" aria-label="Features">
          <span className="yw-kicker">Features</span>
          {features.map((f) => (
            <button key={f.project} className="dp-feature" aria-label={`Open the feature ${f.project}`} title="Its work, on this page" onClick={() => onFeature(f.project)}>
              <span className="dp-feature-name">{f.project}</span>
              {f.doing > 0 && <span className="dp-feature-n">{f.doing} doing</span>}
              {f.todo > 0 && <span className="dp-feature-n">{f.todo} to start</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One project on the Desk, on its own: its chats, its open pull requests and their checks, its worktrees (with what the Storage
 * scan says of each, and Remove when that found it safe), and its open to-dos, each a card. Everything is what Lantern, git, gh
 * and the Storage scan said; nothing is guessed. The right pane's Ask asks about this project only while it is open.
 */
export function DeskProject({ row, chats, repo, work, issues = false, onStep, onRefresh, now, onBack, onOpen, onNewChat, onStartChat, onStartTodo }: DeskProjectProps) {
  const here = repo?.folders.find((f) => f.folder === row.folder);
  const worktrees = repo?.worktrees ?? [];
  const storage = useStorage(worktrees.some((w) => !w.agent));
  const todos = useTodos(row.folder);
  // With nothing on its board, the page opens on what is next and a way to start a chat (once the repository has been read).
  const landing = repo !== undefined && !(work && work.length > 0);
  const startChat = (first: string) => (first && onStartChat ? onStartChat(row.folder, first) : onNewChat(row.folder));
  const startTodo = (todo: Todo) => (onStartTodo ? onStartTodo(row.folder, todo) : startChat(todoPrompt(todo)));
  // The feature opened from the head card, shown on the work board below.
  const [feature, setFeature] = useState<string | null>(null);
  // The page's own colour: the head card wears it, and so does a feature opened under it.
  const color = useProjectColor([row.folder, ...(repo?.folders.map((f) => f.folder) ?? [])], "var(--accent)");
  return (
    <section className="desk-project-page" aria-label={`Project ${row.label}`} style={{ "--proj": color } as CSSProperties}>
      <ProjectHead row={row} repo={repo} here={here} chats={chats} work={work} color={color} onBack={onBack} onFeature={setFeature} />

      {/* Its own work first: where each pull request, branch and issue of this project stands, grouped by feature when Linear is on. */}
      {work && work.length > 0 && (
        <YourWork repos={repo ? [repo] : null} items={work} issues={issues} chats={chats} onStep={onStep ?? (() => false)} onRefresh={onRefresh ?? (() => {})} onOpen={onOpen} standFirst feature={feature} onFeature={setFeature} />
      )}

      {landing && <DeskProjectLanding label={row.label} repo={repo} here={here} todos={todos} onStartChat={startChat} onStartTodo={startTodo} />}

      <Card
        title="Chats"
        count={chats.length}
        action={
          <button className="desk-more" onClick={() => onNewChat(row.folder)}>
            + New chat here
          </button>
        }
      >
        {chats.length === 0 ? (
          <p className="dp-note">No chat open here.</p>
        ) : (
          <ul className="dp-list">
            {chats.map((c) => (
              <li key={c.slot}>
                <button className={`dp-row dp-click${c.unread ? " unread" : ""}`} aria-label={`${c.title}${c.unread ? ", unread" : ""}`} onClick={() => onOpen(c.slot)}>
                  <Row
                    title={
                      <>
                        {c.unread && <span className="desk-unread-dot" aria-hidden />}
                        {c.title}
                      </>
                    }
                    aside={<time className="desk-time">{ago(now, c.at)}</time>}
                    meta={
                      <>
                        {STATE[c.state] ? <span className={`desk-state ${c.state}`}>{STATE[c.state]}</span> : c.workflow}
                        {c.line && ` · ${c.line}`}
                      </>
                    }
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {repo && (
        <Card title="Pull requests" count={repo.prs.length}>
          {repo.gh !== "ready" ? (
            <p className="dp-note">{repo.gh === "not_github" ? "Not a GitHub repository." : repo.gh === "missing" ? "The GitHub CLI (gh) isn't installed." : repo.gh === "logged_out" ? "gh isn't logged in to GitHub." : (repo.error ?? "GitHub didn't answer.")}</p>
          ) : repo.prs.length === 0 ? (
            <p className="dp-note">No open pull requests.</p>
          ) : (
            <ul className="dp-list">
              {repo.prs.map((p) => (
                <li key={p.number} className="dp-row">
                  <Row
                    title={
                      <ExternalLink href={repo.github ? `https://github.com/${repo.github}/pull/${p.number}` : undefined} className="desk-pr-link">
                        <span className="desk-repo-num">#{p.number}</span> {p.title}
                      </ExternalLink>
                    }
                    aside={<span className={`dp-tone dp-tone-${p.checks === "fail" ? "blocked" : p.checks === "pass" ? "safe" : "other"}`}>{CHECKS[p.checks]}</span>}
                    meta={
                      <>
                        {p.author} · <span className="dp-mono">{p.branch}</span>
                        {p.draft && " · draft"}
                        {p.review && REVIEW[p.review] && ` · ${REVIEW[p.review]}`}
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Worktrees worktrees={worktrees} folders={repo?.folders.map((f) => f.folder) ?? []} storage={storage} />

      <Card title="To-dos" count={todos?.length}>
        {todos === null ? (
          <p className="dp-note">…</p>
        ) : todos.length === 0 ? (
          <p className="dp-note">Nothing to do here.</p>
        ) : (
          <ul className="dp-list">
            {todos.slice(0, SHOWN).map((t) => (
              <li key={t.id} className="dp-row">
                <Row title={t.title} aside={t.due && <span className="desk-time">due {t.due.date}{t.due.time ? ` ${t.due.time}` : ""}</span>} />
              </li>
            ))}
          </ul>
        )}
        {!!todos && todos.length > SHOWN && <p className="dp-note dp-foot">and {todos.length - SHOWN} more in the Todos tab</p>}
      </Card>
    </section>
  );
}
