import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { BranchReview, ChangeScope } from "../api";
import { relativeTime } from "../lib/time";
import type { ChangedFile, TestRunItem } from "../store";
import { parseLocation } from "../lib/testRuns";
import { TestsTab } from "./TestsTab";
import { NetworkEmpty, NetworkTab, useNetworkView } from "./NetworkTab";
import { ChecksTab, hasChecks } from "./ChecksTab";
import { totals } from "../lib/prChecks";
import type { PrView } from "../lib/usePrChecks";
import { StorageTab, suggestedCount, useStorageView } from "./StorageTab";
import type { NetworkItem } from "../types";
import { basename, dirOf, relativeTo } from "../lib/diff";
import { usePersistentState } from "../lib/layout";
import { Counts } from "./EditLine";
import { RevertIcon, DocIcon } from "./icons";
import { moveFocus, useMenuKeys } from "./useMenuKeys";
import { FilesTab } from "./FilesTab";
import { AgentsTab } from "./AgentsTab";
import { TabEmpty } from "./TabEmpty";
import { ArchitectureTab } from "./ArchitectureTab";
import type { ArchitectureMap } from "../lib/architecture";
import { SummaryTab, type ExportDoc } from "./SummaryTab";
import type { StepsSummary } from "../lib/stepsSummary";
import type { AgentTree } from "../lib/agents";
import type { AgentGraph } from "../lib/agentGraph";
import type { ModelCost } from "../types";
import type { DiffLayout, Reveal } from "./FullDiff";
import { RevertDialog } from "./RevertDialog";
import { revertFor, type RevertControls, type RevertRequest } from "../lib/revert";
import { useMenuInside } from "../lib/useMenuInside";
import { commentsMessage, type CommentControls } from "../lib/diffComments";
import { CommentBar } from "./DiffComments";

const FullDiff = lazy(() => import("./FullDiff"));

interface Props {
  folder: string | null;
  /** The session has started, so the backend knows which folder may be browsed. */
  ready: boolean;
  files: ChangedFile[];
  /** Changed to bring the Changes tab up (a merge card asking for a branch's diff). */
  changesKey?: number;
  /** Which changes `files` holds: the whole session's, or the last turn's. */
  scope?: ChangeScope;
  onScope?: (scope: ChangeScope) => void;
  /** On a Step-by-step page: the turns "turn" means (null: not all known, e.g. an earlier page of a reopened session). */
  stepRange?: { from: number; to: number } | null;
  /** How many files each filter would show (null: not known yet). */
  scopeCounts?: Partial<Record<ChangeScope, number | null>>;
  /** Why the Git or PR filter has nothing to show (e.g. not a git repository, gh failed). */
  gitError?: string | null;
  /** The pull request being reviewed: adds a "PR #N" filter, its files against the PR's base. */
  pr?: number | null;
  /** A local branch being reviewed (null while it's read): adds a "Branch" filter, with its commits above the diff. */
  branch?: BranchReview | null;
  /** This chat's test runs; the Tests tab says so until there's one. */
  testRuns?: TestRunItem[];
  /** Open a file: in Changes if it's one of `files`, otherwise the Files preview (at a line); `key` changes each time. */
  openRequest?: { path: string; line: number | null; key: number } | null;
  /** Open the Files tab's search, for names or text; `key` changes for every request. */
  searchKey?: { mode: "files" | "text"; key: number } | null;
  /** A file was saved from the editor in the Files tab: the chat's changes should be looked at again. */
  onSaved?: () => void;
  /** Show this run in the Tests tab (from the chat); `key` changes for every request. */
  focusRun?: { id: string; key: number } | null;
  /** The Activity tab: the latest turn's agent tree, cost per model, and `openKey`, changed to bring the tab up. */
  agents?: { tree: AgentTree; graph: AgentGraph; usage: ModelCost[]; openKey: number };
  /** The Plan tab, in a Step-by-step chat that has a step to show: the plan so far, and how to open a row's page. */
  summary?: { slot: string; data: StepsSummary; changed: ChangedFile[]; running: boolean; onOpenPage: (page: string) => void; doc?: ExportDoc };
  /**
   * The Plan tab's map, once a Step-by-step chat has an Architecture Overview: its map, the boxes the page on screen covers, each
   * page's name, how to open one, and `openKey`, changed to bring the tab up.
   */
  architecture?: { map: ArchitectureMap; current: string[]; pageNames: Record<string, string>; onOpenPage: (page: string) => void; openKey: number; box?: { id: string; key: number } | null };
  /** The Network tab's Summarize: asks Claude in this chat about one request (absent: no chat to ask). */
  onSummarizeRequest?: (item: NetworkItem) => void;
  /** The Storage tab's Ask Claude: asks Claude in this chat to scan and suggest what to delete (absent: no chat to ask). */
  onAskStorage?: () => void;
  /** Claude is in the middle of a turn in this chat. */
  chatBusy?: boolean;
  /** The Checks tab: what the checks loop knows about this folder's pull request, whether Claude is too busy to be sent the failure, and what the buttons do (absent: no chat to ask). */
  prChecks?: { view: PrView | undefined; busy: boolean; onSend: () => Promise<void>; onStop: () => void };
  /** Opens Ship it (commit, push, pull request) from the Changes tab's header (absent: no chat to ask). */
  onShip?: () => void;
  /** Reverting Claude's edits: offered on the Changes views and the Summary's steps; the undo of the last one. */
  revert?: RevertControls;
  /** Review comments on diff lines: this chat's, how to change them and how to send them to the chat (absent: no comments). */
  comments?: CommentControls;
  selected: string | null;
  follow: boolean;
  refreshKey: number;
  onSelect: (path: string) => void;
  onFollow: () => void;
}

const LAYOUT_LABEL: Record<DiffLayout, string> = { inline: "Unified", split: "Split" };
const NEXT_LAYOUT: Record<DiffLayout, DiffLayout> = { inline: "split", split: "inline" };

/** The side panel's tabs, always these and always in this order; one with nothing to show says so. */
export type Tab = "changes" | "files" | "plan" | "activity" | "tests" | "checks" | "network" | "storage";
const TABS: { id: Tab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "plan", label: "Plan" },
  { id: "activity", label: "Activity" },
  { id: "tests", label: "Tests" },
  { id: "checks", label: "Checks" },
  { id: "network", label: "Network" },
  { id: "storage", label: "Storage" },
];
/** Each tab's button, which its panel is labelled by. */
const tabId = (t: Tab) => `review-${t}-tab`;

/** The tab a saved name stands for: Summary and Map became Plan, Agents became Activity; anything unknown is Changes. */
export function migrateTab(saved: string): Tab {
  if (saved === "summary" || saved === "map") return "plan";
  if (saved === "agents") return "activity";
  return TABS.some((t) => t.id === saved) ? (saved as Tab) : "changes";
}

export function ReviewPanel(props: Props) {
  const [savedTab, setTab] = usePersistentState<string>("review.tab", "changes");
  const count = props.files.length;
  const runs = props.testRuns ?? [];
  // The folder's watched requests: the Network tab lists them once there's a watch or a summary, and explains itself until then.
  const network = useNetworkView(props.folder);
  // The pull request's checks: the tab counts them, in red when one failed.
  const checksView = props.prChecks?.view;
  const checkTotals = hasChecks(checksView) && checksView.snap.pr.state === "OPEN" ? totals(checksView.snap.checks) : null;
  const hasNetwork = !!network && (network.watches.length > 0 || network.items.length > 0);
  // The disk scan is the Mac's, not the folder's: one for every chat. Its tab shows how many deletions Claude suggested.
  const storage = useStorageView();
  // Every tab is always there, so the saved tab (shared by every chat) is always valid; one saved under an old name moves to its new one.
  const tab = migrateTab(savedTab);
  useEffect(() => {
    if (savedTab !== tab) setTab(tab);
  }, [savedTab]);
  // With both a map and a plan (a Design chat), Plan shows one at a time: the map first.
  const [planView, setPlanView] = useState<"map" | "plan">("map");
  const [shownRun, setShownRun] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number | null; key: number } | null>(null);
  // A mention of a changed file at a line (a review finding): its diff scrolls there.
  const [diffLine, setDiffLine] = useState<{ path: string; line: number; key: number } | null>(null);
  useEffect(() => {
    if (!props.focusRun) return;
    setShownRun(props.focusRun.id);
    setTab("tests");
  }, [props.focusRun?.key]);
  // A new run comes to the front, unless an older one was picked on purpose.
  const latest = runs[runs.length - 1]?.id ?? null;
  useEffect(() => setShownRun(null), [latest]);
  const latestRun = runs[runs.length - 1]?.run;
  useEffect(() => {
    if (props.searchKey) setTab("files");
  }, [props.searchKey?.key]);
  useEffect(() => {
    if (props.agents?.openKey) setTab("activity");
  }, [props.agents?.openKey]);
  useEffect(() => {
    if (props.architecture?.openKey) {
      setTab("plan");
      setPlanView("map");
    }
  }, [props.architecture?.openKey]);
  useEffect(() => {
    if (props.changesKey) setTab("changes");
  }, [props.changesKey]);
  useEffect(() => {
    const req = props.openRequest;
    if (!req) return;
    if (props.files.some((f) => f.path === req.path)) {
      props.onSelect(req.path);
      setTab("changes");
      if (req.line !== null) setDiffLine({ path: req.path, line: req.line, key: req.key });
    } else {
      setReveal(req);
      setTab("files");
    }
  }, [props.openRequest?.key]);
  const openLocation = (location: string) => {
    const { path, line } = parseLocation(location, props.folder);
    setReveal({ path, line, key: Date.now() });
    setTab("files");
  };
  // A revert waiting on its dialog: the files it would put back, and what it does.
  const [reverting, setReverting] = useState<{ title: string; files: ChangedFile[]; request: RevertRequest } | null>(null);
  const rv = props.revert;
  const scopeRevert = revertFor(props.scope ?? "session", props.stepRange);
  // "Revert all" is for the chat's changes or the last message's, not a step's (which the Summary offers).
  const allRevert = scopeRevert !== null && scopeRevert !== "unknown" && !(scopeRevert.scope === "turn" && scopeRevert.turn !== null) ? scopeRevert : null;
  const revertOff = scopeRevert === "unknown" ? "This step's changes aren't known: the chat was reopened after it." : (rv?.blocked ?? null);
  const fileRevert = rv && scopeRevert !== null ? { off: revertOff, onFile: (file: ChangedFile) => scopeRevert !== "unknown" && setReverting({ title: `Revert ${basename(relativeTo(file.path, props.folder))}?`, files: [file], request: scopeRevert }) } : undefined;
  return (
    <aside className="review">
      <div className="pane-tabs">
        {/* Arrow keys move between the tabs and open the one reached, as the ARIA tabs pattern has it. */}
        <div
          className="pane-tabs-track"
          role="tablist"
          aria-label="Side panel"
          onKeyDown={(e) => {
            const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const to = moveFocus(e, tabs);
            if (to !== null) tabs[to].click();
          }}
        >
          {TABS.map(({ id, label }) => (
            <button key={id} id={tabId(id)} role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} className={tab === id ? "active" : ""} title={TAB_TITLE[id]} onClick={() => setTab(id)}>
              {label}
              {id === "changes" && count > 0 && <span className="tab-count">{count}</span>}
              {id === "activity" && props.agents?.tree.live && <span className="tab-live" aria-label="working" />}
              {id === "tests" && latestRun?.outcome === "failed" && <span className="tab-count failed">{latestRun.failed || "!"}</span>}
              {id === "checks" && checkTotals && checkTotals.total > 0 && <span className={`tab-count${checkTotals.failed > 0 ? " failed" : ""}`}>{checkTotals.failed || checkTotals.total}</span>}
              {id === "network" && hasNetwork && network.items.length > 0 && <span className="tab-count">{network.items.length}</span>}
              {id === "storage" && suggestedCount(storage) > 0 && <span className="tab-count" title="Claude's suggestions">{suggestedCount(storage)}</span>}
            </button>
          ))}
        </div>
        {tab === "changes" && props.onScope && <ScopeMenu {...props} onScope={props.onScope} />}
        {tab === "changes" && props.onShip && count > 0 && (
          <button className="ghost ship-it" onClick={props.onShip} title="Commit, push and open a pull request: you check each step first">
            Ship it…
          </button>
        )}
        {tab === "changes" && allRevert && rv && count > 0 && (
          <button
            className="ghost revert-all"
            aria-label="Revert all"
            disabled={!!revertOff}
            title={revertOff ?? (allRevert.scope === "session" ? "Put every file this chat changed back to how it was before the chat began" : "Put the files your last message changed back to how they were before it")}
            onClick={() => setReverting({ title: allRevert.scope === "session" ? "Revert all of this chat's changes?" : "Revert the last message's changes?", files: props.files, request: allRevert })}
          >
            <RevertIcon />
            <span className="revert-all-label">Revert all</span>
          </button>
        )}
      </div>
      {rv?.undo && (
        <div className="revert-undo" role="status">
          <span className="revert-undo-text">{rv.undo.summary}</span>
          <span className="revert-undo-note">Undo lasts until your next message or until you quit Lantern.</span>
          <button className="ghost" onClick={rv.onUndo}>
            Undo
          </button>
        </div>
      )}
      {reverting && rv && (
        <RevertDialog
          slot={rv.slot}
          folder={props.folder}
          title={reverting.title}
          files={reverting.files}
          request={reverting.request}
          latestTurn={rv.latestTurn}
          onCancel={() => setReverting(null)}
          onDone={(outcomes) => {
            const request = reverting.request;
            setReverting(null);
            rv.onReverted(request, outcomes);
          }}
        />
      )}
      {tab === "changes" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("changes")}>
          <ChangesTab
            {...props}
            diffLine={diffLine}
            fileRevert={fileRevert}
            onEdit={(path) => {
              setReveal({ path, line: null, key: Date.now() });
              setTab("files");
            }}
          />
        </div>
      )}
      {tab === "plan" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("plan")}>
          <PlanTab {...props} view={planView} onView={setPlanView} />
        </div>
      )}
      {tab === "activity" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("activity")}>
          {props.agents ? <AgentsTab tree={props.agents.tree} graph={props.agents.graph} usage={props.agents.usage} /> : <TabEmpty title="Activity">Each turn's subagents and tools show here.</TabEmpty>}
        </div>
      )}
      {tab === "tests" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("tests")}>
          {runs.length > 0 ? <TestsTab runs={runs} selected={shownRun} onSelect={setShownRun} onOpenLocation={openLocation} /> : <TabEmpty title="Tests">Test runs show here when Claude runs your tests.</TabEmpty>}
        </div>
      )}
      {tab === "checks" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("checks")}>
          <ChecksTab view={checksView} busy={props.prChecks?.busy ?? false} onSend={props.prChecks?.onSend ?? (() => Promise.resolve())} onStop={props.prChecks?.onStop ?? (() => {})} />
        </div>
      )}
      {tab === "network" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("network")}>
          {hasNetwork && props.folder ? <NetworkTab folder={props.folder} view={network} onSummarize={props.onSummarizeRequest ?? null} busy={props.chatBusy} /> : <NetworkEmpty link={network?.link ?? null} />}
        </div>
      )}
      {tab === "storage" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("storage")}>
          <StorageTab view={storage} onAsk={props.onAskStorage ?? null} busy={props.chatBusy} />
        </div>
      )}
      {/* Kept mounted while hidden so the tree keeps its expanded folders across tab switches. */}
      <div className="tab-body" role="tabpanel" aria-labelledby={tabId("files")} hidden={tab !== "files"}>
        <FilesTab
          folder={props.folder}
          ready={props.ready}
          changed={props.files}
          refreshKey={props.refreshKey}
          reveal={reveal}
          focusSearch={props.searchKey ?? null}
          onSaved={props.onSaved}
          onOpenChange={(path) => {
            props.onSelect(path);
            setTab("changes");
          }}
        />
      </div>
    </aside>
  );
}

const TAB_TITLE: Record<Tab, string | undefined> = {
  changes: undefined,
  files: undefined,
  plan: "The plan so far, and the architecture map in a Design chat",
  activity: "Each turn's agents, models and tools",
  tests: undefined,
  checks: "How the checks of this branch's pull request stand",
  network: "Requests matching this folder's watches, from Network Monitor",
  storage: "Scan this Mac for what can be cleared to get disk space back",
};

/**
 * Plan: the architecture map in a Design chat (the plan so far under a toggle), the plan and progress in any Step by
 * step chat, and a note about Step by step in a chat with neither.
 */
function PlanTab({ summary, architecture, view, onView, revert }: Props & { view: "map" | "plan"; onView: (v: "map" | "plan") => void }) {
  if (!summary && !architecture) return <TabEmpty title="Plan">Step by step chats show their plan here: the pages Claude has planned and where it is in them. Start one from the Workflow menu under the message box.</TabEmpty>;
  const showMap = !!architecture && (view === "map" || !summary);
  return (
    <>
      {architecture && summary && (
        <div className="review-bar plan-bar" role="group" aria-label="Plan view">
          <button className={`plan-toggle${showMap ? " active" : ""}`} aria-pressed={showMap} onClick={() => onView("map")}>
            Map
          </button>
          <button className={`plan-toggle${showMap ? "" : " active"}`} aria-pressed={!showMap} onClick={() => onView("plan")}>
            Plan
          </button>
        </div>
      )}
      {showMap && architecture ? (
        <ArchitectureTab map={architecture.map} current={architecture.current} pageNames={architecture.pageNames} onOpenPage={architecture.onOpenPage} box={architecture.box} />
      ) : (
        summary && <SummaryTab slot={summary.slot} summary={summary.data} changed={summary.changed} running={summary.running} onOpenPage={summary.onOpenPage} doc={summary.doc} revert={revert} />
      )}
    </>
  );
}

function ChangesTab({ folder, files, scope = "session", stepRange, gitError, pr, branch, selected, follow, refreshKey, onSelect, onFollow, onEdit, diffLine, fileRevert, comments, chatBusy }: Props & { diffLine: { path: string; line: number; key: number } | null; onEdit: (path: string) => void; fileRevert?: { off: string | null; onFile: (file: ChangedFile) => void } }) {
  const [layout, setLayout] = usePersistentState<DiffLayout>("review.diffLayout", "inline");
  const found = files.findIndex((f) => f.path === selected);
  const index = found === -1 ? files.length - 1 : found;
  const current = files[index] ?? null;

  // Every comment the chat has, whichever file it is on: sent as one message, or discarded.
  const sendComments = comments?.send;
  const bar = comments && comments.items.length > 0 && (
    <CommentBar
      count={comments.items.length}
      busy={chatBusy}
      sendOff={sendComments ? null : "Claude can't take a message right now."}
      onSend={() => {
        sendComments?.(commentsMessage(comments.items, folder));
        comments.update(() => []);
      }}
      onDiscard={() => comments.update(() => [])}
    />
  );

  if (!current) {
    const empty =
      scope === "git" ? (gitError ?? "Nothing uncommitted") :
      scope === "pr" ? (gitError ?? `Fetching pull request #${pr}…`) :
      scope === "branch" ? (gitError ?? "Reading the branch…") :
      scope !== "turn" ? "No changes yet" : stepRange === null ? "This step's changes aren't known: the chat was reopened after it" : stepRange !== undefined ? "No changes in this step" : "No changes in the last turn";
    return (
      <>
        {bar}
        <div className="empty">{empty}</div>
      </>
    );
  }

  return (
    <>
      {scope === "branch" && branch && <BranchCommits review={branch} />}
      <div className="review-bar">
        <FilePicker files={files} current={current} folder={folder} onSelect={onSelect} />
        <Counts added={current.added} removed={current.removed} />
        <div className="spacer" />
        {!follow && scope !== "pr" && scope !== "branch" && (
          <button className="ghost" title="Follow Claude's edits again" onClick={onFollow}>
            ↓ Latest
          </button>
        )}
        <span className="position">
          {index + 1} / {files.length}
        </span>
        <button className="icon" aria-label="Previous file" title="Previous file (K)" disabled={index === 0} onClick={() => onSelect(files[index - 1].path)}>
          ‹
        </button>
        <button className="icon" aria-label="Next file" title="Next file (J)" disabled={index === files.length - 1} onClick={() => onSelect(files[index + 1].path)}>
          ›
        </button>
        {!current.deleted && scope !== "pr" && scope !== "branch" && (
          <button className="ghost" title="Edit this file" onClick={() => onEdit(current.path)}>
            Edit
          </button>
        )}
        {fileRevert && (
          <button className="ghost" disabled={!!fileRevert.off} title={fileRevert.off ?? "Put this file back to how it was before these changes"} onClick={() => fileRevert.onFile(current)}>
            Revert
          </button>
        )}
        <button className="ghost layout" title={layout === "inline" ? "Showing removals and additions together. Click for side by side." : "Showing old and new side by side. Click to show them together."} onClick={() => setLayout(NEXT_LAYOUT[layout])}>
          {LAYOUT_LABEL[layout]}
        </button>
      </div>
      {bar}
      <Suspense fallback={<div className="empty">Loading diff…</div>}>
        <FullDiff path={current.path} refreshKey={refreshKey} layout={layout} scope={scope} turn={scope === "turn" ? (stepRange?.from ?? null) : null} toTurn={scope === "turn" ? (stepRange?.to ?? null) : null} pr={scope === "pr" ? (pr ?? null) : null} base={scope === "branch" ? (branch?.base ?? null) : null} comments={comments} reveal={diffLine?.path === current.path ? ({ line: diffLine.line, key: diffLine.key } satisfies Reveal) : null} />
      </Suspense>
    </>
  );
}

const SCOPE_LABEL: Record<Exclude<ChangeScope, "pr" | "turn">, string> = { branch: "This branch", session: "This chat", git: "Uncommitted" };

/** Which changes the Changes tab shows, as a menu: each option with its count and what it means. */
function ScopeMenu({ scope = "session", onScope, pr, branch, stepRange, scopeCounts }: Props & { onScope: (scope: ChangeScope) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
  const inside = useMenuInside(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const step = stepRange !== undefined;
  const label = (s: ChangeScope) => (s === "pr" ? `PR #${pr}` : s === "turn" ? (step ? "This step" : "Last turn") : SCOPE_LABEL[s]);
  const about = (s: ChangeScope): string => {
    switch (s) {
      case "pr":
        return "The pull request's files, against where it left its base branch";
      case "branch":
        return branch ? `Committed on ${branch.branch} since it left ${branch.base}` : "Committed on this branch since it left the default branch";
      case "turn":
        return step ? "What this step changed" : "What changed since your last message";
      case "session":
        return "Everything this chat changed";
      case "git":
        return "Everything not committed yet, whoever changed it (an interrupted command, another editor)";
    }
  };
  const options: ChangeScope[] = [...(pr != null ? (["pr"] as const) : branch !== undefined ? (["branch"] as const) : []), "turn", "session", "git"];
  const count = (s: ChangeScope) => scopeCounts?.[s];
  return (
    <div className="scope-anchor" ref={root}>
      <button className={`scope-button${open ? " pressed" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Show changes from: ${label(scope)}`} title={about(scope)} onClick={() => setOpen(!open)}>
        <span className="scope-label">{label(scope)}</span>
        {count(scope) != null && <span className="tab-count">{count(scope)}</span>}
        <span className="scope-chevron" aria-hidden />
      </button>
      {open && (
        <div className="menu scope-menu" ref={inside.ref} style={inside.style} role="menu" aria-label="Show changes from" onKeyDown={keys.onKeyDown}>
          {options.map((s) => (
            <button
              key={s}
              role="menuitemradio"
              aria-checked={scope === s}
              className={`menu-row scope-option${scope === s ? " current" : ""}`}
              onClick={() => {
                onScope(s);
                setOpen(false);
              }}
            >
              <span className="scope-check" aria-hidden>
                {scope === s ? "✓" : ""}
              </span>
              <span className="scope-option-text">
                <span className="scope-option-title">
                  {label(s)}
                  {count(s) != null && <span className="tab-count">{count(s)}</span>}
                </span>
                <span className="scope-option-about">{about(s)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The branch's commits, newest first: a line that says how many, opening to the list. */
function BranchCommits({ review }: { review: BranchReview }) {
  const [open, setOpen] = usePersistentState("review.commitsOpen", true);
  const n = review.commits.length;
  return (
    <div className="branch-commits">
      <button className="activity-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden />
        <span className="activity-text">
          {n} commit{n === 1 ? "" : "s"} on <span className="branch-commits-name">{review.branch}</span> since {review.base}
        </span>
      </button>
      {review.note && <div className="branch-commits-note">{review.note}</div>}
      {open && (
        <ol className="branch-commits-list">
          {review.commits.map((c) => (
            <li key={c.sha} title={`${c.sha} by ${c.author}`}>
              <code className="branch-commit-sha">{c.sha}</code>
              <span className="branch-commit-subject">{c.subject}</span>
              <span className="branch-commit-time">{relativeTime(c.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function FilePicker({ files, current, folder, onSelect }: { files: ChangedFile[]; current: ChangedFile; folder: string | null; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
  const inside = useMenuInside(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="picker" ref={root}>
      <button className="picker-button" aria-label={relativeTo(current.path, folder)} aria-haspopup="listbox" aria-expanded={open} title={current.path} onClick={() => setOpen(!open)}>
        <JumpBar path={relativeTo(current.path, folder)} folder={folder} />
        {current.created && <span className="tag">new</span>}
        {current.deleted && <span className="tag">deleted</span>}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        // The same dropdown as the folder, session and model menus.
        <div className="menu file-menu" ref={inside.ref} style={inside.style}>
          {/* The options are the buttons themselves: a button can't sit inside an option. */}
          <div className="menu-list" role="listbox" aria-label="Changed files" onKeyDown={keys.onKeyDown}>
            {files.map((f) => {
              const rel = relativeTo(f.path, folder);
              const isCurrent = f.path === current.path;
              return (
                <button
                  key={f.path}
                  role="option"
                  aria-selected={isCurrent}
                  className={`menu-row${isCurrent ? " current" : ""}`}
                  title={f.path}
                  onClick={() => {
                    onSelect(f.path);
                    setOpen(false);
                  }}
                >
                  <span className="menu-row-title">
                    {basename(rel)}
                    <span className="menu-row-path">{dirOf(rel)}</span>
                  </span>
                  {f.created && <span className="tag">new</span>}
                  {f.deleted && <span className="tag">deleted</span>}
                  <Counts added={f.added} removed={f.removed} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Xcode's jump bar: the path as crumbs ("acme-api › src › client › retry.ts"), the file last with its icon.
function JumpBar({ path, folder }: { path: string; folder: string | null }) {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? path;
  const dirs = [...(folder && !path.startsWith("/") && !path.startsWith("~") ? [basename(folder)] : []), ...parts];
  return (
    <span className="jump-bar picker-path">
      {dirs.map((d, i) => (
        <span key={i} className="jump-dir">
          <span className="jump-name">{d}</span>
          <span className="jump-sep" aria-hidden />
        </span>
      ))}
      <span className="jump-file">
        <DocIcon />
        <span className="jump-name">{file}</span>
      </span>
    </span>
  );
}
