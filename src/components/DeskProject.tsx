import { useEffect, useState } from "react";
import { api } from "../api";
import type { InboxRow, ProjectRow, RowState } from "../lib/deskBoard";
import { elapsed } from "../lib/time";
import type { Todo } from "../lib/todos";
import type { RepoStatus, StorageItem } from "../types";
import { Card, Row } from "./DeskCard";
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

/**
 * One project on the Desk, on its own: its chats, its open pull requests and their checks, its worktrees (with what the Storage
 * scan says of each, and Remove when that found it safe), and its open to-dos, each a card. Everything is what Lantern, git, gh
 * and the Storage scan said; nothing is guessed. The right pane's Ask asks about this project only while it is open.
 */
export function DeskProject({ row, chats, repo, now, onBack, onOpen, onNewChat }: DeskProjectProps) {
  const here = repo?.folders.find((f) => f.folder === row.folder);
  const worktrees = repo?.worktrees ?? [];
  const storage = useStorage(worktrees.some((w) => !w.agent));
  const todos = useTodos(row.folder);
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
          <span className="dp-meta">
            <span className="dp-mono desk-branch">{here.branch}</span>
            {!!here.changed && ` · ${here.changed} changed`}
          </span>
        )}
      </header>

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
