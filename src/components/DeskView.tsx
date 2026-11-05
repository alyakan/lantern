import { useEffect, useRef, useState, type RefObject } from "react";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import { requestText, type InboxItem } from "../lib/inbox";
import { elapsed } from "../lib/time";
import type { Todo } from "../lib/todos";
import type { NewRule, RepoStatus } from "../types";
import { DeskProject } from "./DeskProject";
import { DeskProjects } from "./DeskProjects";
import { YourWork } from "./YourWork";
import { withLinear, workOfRepo, yourWork, type Target, type WorkItem } from "../lib/yourWork";
import type { LinearWork } from "../types";
import { AllowButton } from "./Inbox";
import { PermissionCard } from "./PermissionCard";

export interface DeskViewProps {
  /** Every chat on this Desk, for the projects' rows to list. */
  chats: InboxRow[];
  /** Every project on this Desk, as the table lists it. */
  projects: ProjectRow[];
  /** What waits on you on this Desk (the title bar's inbox), one thing at a time. */
  needs: InboxItem[];
  /** How this Desk's repositories stand (git and GitHub); null until the Mac has said. */
  repos: RepoStatus[] | null;
  onOpen: (slot: string) => void;
  /** The project whose own page is open (a folder), or null for all of them; and the way to open or leave one. */
  page: string | null;
  onPage: (folder: string | null) => void;
  /** Starts a chat in a project (from its page). */
  onNewChat: (folder: string) => void;
  /** From a project's landing page: a chat started with a first message, and one started on a to-do. */
  onStartChat?: (folder: string, first: string) => void;
  onStartTodo?: (folder: string, todo: Todo) => void;
  onGo: (item: InboxItem) => void;
  onDecide: (item: InboxItem, allow: boolean) => void;
  /** Sends one of Your work's next steps: to its chat, or to a new chat in its project. */
  onStep: (item: WorkItem, target: Target) => boolean;
  /** Asks git, GitHub and Linear again now (Your work's Refresh). */
  onRefreshRepos: () => void;
  /** Opens the Ask sheet: the message box that asks across projects (or about the page's one). */
  onAsk: () => void;
  /** What Linear says of your issues, and the Linear team each repository's work is in (by its main checkout). */
  linear?: { work: LinearWork | null; teamOf: Record<string, string> };
  /** Answers a request from its own card, opened on the Desk: as the chat's card answers it (a note, a question's answers, a rule). */
  onAnswer?: (slot: string, id: string, allow: boolean, note?: string, answered?: Record<string, unknown>, remember?: NewRule) => void;
}

/** How often the times are redrawn. */
const TICK_MS = 30_000;

/** What waits on you, one thing at a time: the first, big, with what it asks; the rest a click away. */
function NeedsYou({ waiting, now, onGo, onDecide, onAnswer }: { waiting: InboxItem[]; now: number } & Pick<DeskViewProps, "onGo" | "onDecide" | "onAnswer">) {
  const [at, setAt] = useState(0);
  // The request opened in place, by its id: the next one to come into view comes in closed.
  const [open, setOpen] = useState<string | null>(null);
  const i = at < waiting.length ? at : 0;
  const it = waiting[i];
  if (!it) return null;
  const request = it.request && onAnswer ? it.request : null;
  const opened = request !== null && open === request.id;
  const more = waiting.length - 1;
  return (
    <section className="desk-needs" aria-label="Needs you">
      <h2 className="desk-h">Needs you</h2>
      <div className={`desk-focus${more > 0 ? " stacked" : ""}`}>
        <article className="desk-need" aria-label={`${it.title} needs you: ${it.need}`}>
          <div className="desk-who">
            <span className="node-dot waiting" aria-hidden />
            <button className="desk-chat" onClick={() => onGo(it)} title="Go there">
              {it.title}
            </button>
            <span className="desk-where">
              in {it.where}
              {it.since !== null && `, ${elapsed(now - it.since)}`}
            </span>
          </div>
          <p className="desk-ask">{it.need}</p>
          {it.detail !== null && <pre className="desk-detail">{it.detail}</pre>}
          <div className="desk-actions">
            {it.requestId && it.canAllow && <AllowButton key={it.key + (it.requestId ?? "")} title={it.title} onAllow={() => onDecide(it, true)} />}
            {request && !it.canAllow && (
              <button className={opened ? undefined : "primary"} aria-expanded={opened} aria-label={`${opened ? "Hide" : "Review"} ${it.title}`} onClick={() => setOpen(opened ? null : request.id)}>
                {opened ? "Hide" : "Review"}
              </button>
            )}
            {it.requestId && (
              <button aria-label={`Deny ${it.title}`} onClick={() => onDecide(it, false)}>
                Deny
              </button>
            )}
            <button className={it.requestId || request ? undefined : "primary"} aria-label={`Go to ${it.title}`} onClick={() => onGo(it)}>
              Open chat
            </button>
            {more > 0 && (
              <button className="desk-next" onClick={() => setAt((i + 1) % waiting.length)}>
                {more} more waiting
              </button>
            )}
          </div>
          {/* All of it, as the chat shows it, with the chat's own buttons: answered here as it would be there. Under the buttons, so
              opening it moves nothing under the pointer. */}
          {opened && request && (
            <div className="desk-request">
              {/* A plain tool's card names only what it touches: the Desk shows all of it first (a plan, a question or another agent's card shows its own whole). */}
              {it.kind === "permission" && !request.provider && <pre className="desk-detail desk-request-full">{requestText(request.toolName, request.input)}</pre>}
              <PermissionCard item={request} onDecide={(id, allow, note, answered, remember) => onAnswer?.(it.slot, id, allow, note, answered, remember)} />
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

/** The Desk's first tile when nothing waits on you: that nothing does, and the Desk in a few numbers. */
function Pulse({ needs, projects, repos }: { needs: InboxItem[]; projects: ProjectRow[]; repos: RepoStatus[] | null }) {
  const sum = (f: (p: ProjectRow) => number) => projects.reduce((n, p) => n + f(p), 0);
  const waiting = needs.filter((n) => n.needsYou).length;
  const chats = sum((p) => p.chats);
  const working = sum((p) => p.working);
  const unread = sum((p) => p.unread);
  const overdue = sum((p) => p.todos?.overdue ?? 0);
  const prs = (repos ?? []).reduce((n, r) => n + r.prs.length, 0);
  const failing = (repos ?? []).reduce((n, r) => n + r.prs.filter((p) => p.checks === "fail").length, 0);
  const drafts = (repos ?? []).reduce((n, r) => n + r.drafts.length, 0);
  return (
    <div className={`desk-pulse${waiting ? " wait" : ""}`} role="status" aria-label="Where the Desk stands">
      <span className={`pulse-lead${waiting ? " wait" : ""}`}>{waiting ? `● ${waiting} need you` : "✓ Nothing needs you"}</span>
      {chats > 0 && (
        <span>
          <b>{chats}</b> chat{chats === 1 ? "" : "s"} open
        </span>
      )}
      {working > 0 && <span>{working} working</span>}
      {unread > 0 && <span>{unread} unread</span>}
      {prs > 0 && (
        <span>
          <b>{prs}</b> PR{prs === 1 ? "" : "s"} open{failing > 0 && <span className="pulse-bad"> · {failing} failing</span>}
        </span>
      )}
      {drafts > 0 && (
        <span>
          {drafts} draft release{drafts === 1 ? "" : "s"}
        </span>
      )}
      {overdue > 0 && <span className="pulse-bad">{overdue} to-do{overdue === 1 ? "" : "s"} overdue</span>}
    </div>
  );
}

/** How long after its last change of width the pane's scrollbar stays hidden: past the sidebar's own 220 ms animation. */
const QUIET_MS = 450;

/**
 * Hides the pane's scrollbar while its width changes (the sidebar opening or closing beside it) and a moment after: the system
 * flashes a scrollbar whenever the size of what scrolls changes, and the Desk reflows as the pane moves. Done on the element, not
 * in state, so nothing re-renders at every step. The pane's own width is what is compared, not its inner width, which the
 * scrollbar being hidden would change in turn.
 */
function useQuietWhileResized(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.offsetWidth;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      el.classList.add("resizing");
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove("resizing"), QUIET_MS);
    });
    watch.observe(el);
    return () => {
      watch.disconnect();
      clearTimeout(timer);
    };
  }, [ref]);
}

/**
 * The Desk, as a dashboard of tiles in one grid: what waits on you, one thing at a time (or, when nothing does, the Desk in a few
 * numbers), a tile per project with only what Lantern knows for sure (a tile opens to list its chats), and your work in its
 * repositories: what to do next, and where each pull request and branch stands. What happened in the chats, as
 * it happened, is the sidebar's Timeline; asking and telling is the right pane's Ask.
 */
export function DeskView(props: DeskViewProps) {
  const { needs, onOpen, onGo, onDecide } = props;
  const [now, setNow] = useState(Date.now);
  const main = useRef<HTMLDivElement>(null);
  useQuietWhileResized(main);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const waiting = needs.filter((n) => n.needsYou);
  // A project's page, while that project is still on the Desk.
  const pageRow = props.page === null ? undefined : props.projects.find((p) => p.folder === props.page);
  const work = withLinear(yourWork(props.repos, now), props.linear?.work ?? null, props.linear?.teamOf ?? {}, props.repos, now);
  const issues = !!props.linear?.work?.connected;
  // Its page shows only its own work: the whole Desk's list would repeat every other project.
  const pageRepo = pageRow ? (props.repos?.find((r) => r.folders.some((f) => f.folder === pageRow.folder)) ?? null) : null;
  const pageWork = pageRepo ? workOfRepo(work, pageRepo.repo) : [];
  return (
    <section className="chat-pane desk" aria-label="Desk">
      <header className="desk-head">
        <h1 className="desk-title">Desk</h1>
      </header>
      <div className="desk-main" ref={main}>
        {!pageRow && <Pulse needs={props.needs} projects={props.projects} repos={props.repos} />}
        {pageRow ? (
          <>
          {waiting.length > 0 ? <NeedsYou waiting={waiting} now={now} onGo={onGo} onDecide={onDecide} onAnswer={props.onAnswer} /> : <div className="desk-clear">✓ Nothing needs you</div>}
          <DeskProject
            row={pageRow}
            chats={props.chats.filter((c) => c.folder === pageRow.folder)}
            repo={props.repos === null ? undefined : pageRepo}
            work={pageWork}
            issues={issues}
            onStep={props.onStep}
            onRefresh={props.onRefreshRepos}
            now={now}
            onBack={() => props.onPage(null)}
            onOpen={onOpen}
            onNewChat={props.onNewChat}
            onStartChat={props.onStartChat}
            onStartTodo={props.onStartTodo}
          />
          </>
        ) : (
          <div className="desk-bento">
            {waiting.length > 0 && <NeedsYou waiting={waiting} now={now} onGo={onGo} onDecide={onDecide} onAnswer={props.onAnswer} />}
            <DeskProjects rows={props.projects} chats={props.chats} repos={props.repos} items={work} now={now} onOpen={onOpen} onPage={props.onPage} />
            <YourWork repos={props.repos} items={work} issues={issues} chats={props.chats} onStep={props.onStep} onRefresh={props.onRefreshRepos} nextOnly />
          </div>
        )}
      </div>
      <button className="desk-ask-bar" onClick={props.onAsk} aria-label={pageRow ? `Ask about ${pageRow.label}` : "Ask across your projects"}>
        <span>{pageRow ? `Ask about ${pageRow.label}…` : "Ask across your projects…"}</span>
        <span className="desk-ask-key" aria-hidden>
          ⌘J
        </span>
      </button>
    </section>
  );
}
