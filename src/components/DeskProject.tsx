import { useEffect, useState } from "react";
import { api } from "../api";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { elapsed } from "../lib/time";
import type { Todo } from "../lib/todos";
import type { RepoStatus, StorageItem } from "../types";
import { ExternalLink } from "./ExternalLink";

export interface DeskProjectProps {
  row: ProjectRow;
  /** This project's chats. */
  chats: InboxRow[];
  /** Its repository as the Mac last said; undefined while it hasn't, null when it isn't in one. */
  repo: RepoStatus | null | undefined;
  now: number;
  onBack: () => void;
  onOpen: (slot: string) => void;
  onNewChat: (folder: string) => void;
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

/** A worktree's line: its branch and where it is, what Storage says of it, and Remove when Storage found it safe. */
function Worktree({ wt, item, scanned }: { wt: RepoStatus["worktrees"][number]; item: StorageItem | undefined; scanned: boolean }) {
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
  const verdict = wt.agent
    ? "An agent's: its team cleans it up"
    : wt.locked
      ? "Locked"
      : !scanned
        ? null
        : !item
          ? "Not in the last Storage scan"
          : item.risk === "safe"
            ? `Safe to remove · ${GB(item.bytes)}`
            : (item.warning ?? (item.risk === "review" ? "Needs a look" : "Can't be removed"));
  return (
    <li className="desk-wt">
      <span className="desk-wt-what">
        <span className="desk-branch" title={wt.branch ?? "detached"}>
          {wt.branch ?? "detached"}
        </span>
        <span className="desk-wt-path" title={wt.path}>
          {name}
        </span>
      </span>
      {verdict && <span className={`desk-wt-verdict${wt.agent || wt.locked || !item ? "" : ` ${item.risk}`}`}>{verdict}</span>}
      {state?.kind === "failed" && <span className="desk-bad">{state.why}</span>}
      {item?.risk === "safe" && !wt.agent && !wt.locked && (
        <span className="desk-wt-actions">
          {asking ? (
            <>
              <span className="muted">Remove it? Its branch stays.</span>
              <button className="danger" aria-label={`Remove the worktree ${name}`} disabled={state?.kind === "removing"} onClick={remove}>
                {state?.kind === "removing" ? "Removing…" : "Remove"}
              </button>
              <button onClick={() => setAsking(false)}>Cancel</button>
            </>
          ) : (
            <button aria-label={`Remove ${name}…`} onClick={() => setAsking(true)}>
              Remove…
            </button>
          )}
        </span>
      )}
    </li>
  );
}

/**
 * One project on the Desk, on its own: its chats, its open pull requests and their checks, its worktrees (with what the Storage
 * scan says of each, and Remove when that found it safe), and its open to-dos. Everything is what Lantern, git, gh and the
 * Storage scan said; nothing is guessed. The right pane's Ask asks about this project only while it is open.
 */
export function DeskProject({ row, chats, repo, now, onBack, onOpen, onNewChat }: DeskProjectProps) {
  const here = repo?.folders.find((f) => f.folder === row.folder);
  const worktrees = repo?.worktrees ?? [];
  const storage = useStorage(worktrees.some((w) => !w.agent));
  const todos = useTodos(row.folder);
  const itemOf = (path: string) => storage.items?.find((i) => i.kind === "worktree" && i.path === path);
  return (
    <section className="desk-project-page" aria-label={`Project ${row.label}`}>
      <header className="desk-page-head">
        <button className="desk-back" onClick={onBack}>
          ‹ All projects
        </button>
        <h2 className="desk-page-title" title={row.folder}>
          {row.label}
        </h2>
        {here?.branch && (
          <span className="desk-branch-line">
            <span className="desk-branch">{here.branch}</span>
            {!!here.changed && <span className="desk-changed"> · {here.changed} changed</span>}
          </span>
        )}
      </header>

      <section aria-label="Chats">
        <h3 className="desk-h">
          Chats <span className="muted">{chats.length || ""}</span>
        </h3>
        {chats.length === 0 ? (
          <p className="muted">No chat open here.</p>
        ) : (
          <ul className="desk-page-list">
            {chats.map((c) => (
              <li key={c.slot}>
                <button className={`desk-msg${c.unread ? " unread" : ""}`} aria-label={`${c.title}${c.unread ? ", unread" : ""}`} onClick={() => onOpen(c.slot)}>
                  <span className="desk-msg-top">
                    {c.unread && <span className="desk-unread-dot" aria-hidden />}
                    <span className="desk-msg-title">{c.title}</span>
                    <span className="desk-msg-meta">{c.workflow}</span>
                    {STATE[c.state] && <span className={`desk-state ${c.state}`}>{STATE[c.state]}</span>}
                    <time className="desk-time">{ago(now, c.at)}</time>
                  </span>
                  {c.line && <span className="desk-msg-line">{c.line}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="desk-more" onClick={() => onNewChat(row.folder)}>
          + New chat here
        </button>
      </section>

      {repo && (
        <section aria-label="Pull requests">
          <h3 className="desk-h">
            Pull requests <span className="muted">{repo.prs.length || ""}</span>
          </h3>
          {repo.gh !== "ready" ? (
            <p className="muted">{repo.gh === "not_github" ? "Not a GitHub repository." : repo.gh === "missing" ? "The GitHub CLI (gh) isn't installed." : repo.gh === "logged_out" ? "gh isn't logged in to GitHub." : (repo.error ?? "GitHub didn't answer.")}</p>
          ) : repo.prs.length === 0 ? (
            <p className="muted">No open pull requests.</p>
          ) : (
            <ul className="desk-page-list">
              {repo.prs.map((p) => (
                <li key={p.number} className={`desk-pr ${p.checks}`}>
                  <span className="desk-pr-what">
                    <ExternalLink href={repo.github ? `https://github.com/${repo.github}/pull/${p.number}` : undefined} className="desk-pr-link">
                      <span className="desk-repo-num">#{p.number}</span> {p.title}
                    </ExternalLink>
                    <span className="muted">
                      {p.author} · <span className="desk-branch">{p.branch}</span>
                      {p.draft && " · draft"}
                    </span>
                  </span>
                  <span className={`desk-pr-checks ${p.checks}`}>{CHECKS[p.checks]}</span>
                  {p.review && REVIEW[p.review] && <span className="muted">{REVIEW[p.review]}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {worktrees.length > 0 && (
        <section aria-label="Worktrees">
          <h3 className="desk-h">
            Worktrees <span className="muted">{worktrees.length}</span>
          </h3>
          {storage.items === null && worktrees.some((w) => !w.agent) && (
            <p className="muted">
              {storage.scanning ? "Storage is scanning…" : "Scan in Storage to see which are safe to remove."}{" "}
              {!storage.scanning && (
                <button className="desk-more" onClick={() => void api.storageScan().catch(() => {})}>
                  Scan now
                </button>
              )}
            </p>
          )}
          <ul className="desk-page-list">
            {worktrees.map((w) => (
              <Worktree key={w.path} wt={w} item={itemOf(w.path)} scanned={storage.items !== null} />
            ))}
          </ul>
        </section>
      )}

      <section aria-label="To-dos">
        <h3 className="desk-h">
          To-dos <span className="muted">{todos?.length || ""}</span>
        </h3>
        {todos === null ? (
          <p className="muted">…</p>
        ) : todos.length === 0 ? (
          <p className="muted">Nothing to do here.</p>
        ) : (
          <ul className="desk-page-list">
            {todos.slice(0, 8).map((t) => (
              <li key={t.id} className="desk-todo">
                <span className="desk-todo-title">{t.title}</span>
                {t.due && <span className="muted">due {t.due.date}{t.due.time ? ` ${t.due.time}` : ""}</span>}
              </li>
            ))}
            {todos.length > 8 && <li className="muted">and {todos.length - 8} more in the Todos tab</li>}
          </ul>
        )}
      </section>
    </section>
  );
}
