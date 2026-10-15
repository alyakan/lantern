import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { BranchReview, ChangeScope } from "../api";
import { relativeTime } from "../lib/time";
import type { ChangedFile, TestRunItem } from "../store";
import { parseLocation } from "../lib/testRuns";
import { TestsTab } from "./TestsTab";
import { NetworkTab, useNetworkView } from "./NetworkTab";
import type { NetworkItem } from "../types";
import { basename, dirOf, relativeTo } from "../lib/diff";
import { usePersistentState } from "../lib/layout";
import { Counts } from "./EditLine";
import { DocIcon } from "./icons";
import { moveFocus, useMenuKeys } from "./useMenuKeys";
import { FilesTab } from "./FilesTab";
import { AgentsTab } from "./AgentsTab";
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
  /** This chat's test runs; the Tests tab shows once there's one. */
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
  /** The Summary tab, in a Step-by-step chat that has a step to show: the plan so far, and how to open a row's page. */
  summary?: { slot: string; data: StepsSummary; changed: ChangedFile[]; running: boolean; onOpenPage: (page: string) => void; doc?: ExportDoc };
  /**
   * The Map tab, once a Step-by-step chat has an Architecture Overview: its map, the boxes the page on screen covers, each
   * page's name, how to open one, and `openKey`, changed to bring the tab up.
   */
  architecture?: { map: ArchitectureMap; current: string[]; pageNames: Record<string, string>; onOpenPage: (page: string) => void; openKey: number; box?: { id: string; key: number } | null };
  /** The Network tab's Summarize: asks Claude in this chat about one request (absent: no chat to ask). */
  onSummarizeRequest?: (item: NetworkItem) => void;
  /** Claude is in the middle of a turn in this chat. */
  chatBusy?: boolean;
  /** Reverting Claude's edits: offered on the Changes views and the Summary's steps; the undo of the last one. */
  revert?: RevertControls;
  selected: string | null;
  follow: boolean;
  refreshKey: number;
  onSelect: (path: string) => void;
  onFollow: () => void;
}

const LAYOUT_LABEL: Record<DiffLayout, string> = { inline: "Unified", split: "Split" };
const NEXT_LAYOUT: Record<DiffLayout, DiffLayout> = { inline: "split", split: "inline" };

type Tab = "changes" | "files" | "tests" | "agents" | "summary" | "map" | "network";
/** Each tab's button, which its panel is labelled by. */
const tabId = (t: Tab) => `review-${t}-tab`;

export function ReviewPanel(props: Props) {
  const [savedTab, setTab] = usePersistentState<Tab>("review.tab", "changes");
  const count = props.files.length;
  const runs = props.testRuns ?? [];
  // The folder's watched requests: the Network tab shows once there's a watch or a summary.
  const network = useNetworkView(props.folder);
  const hasNetwork = !!network && (network.watches.length > 0 || network.items.length > 0);
  // The saved tab is shared by every chat: one that has no tests, or no steps, opens on Changes instead.
  const tab: Tab = (savedTab === "tests" && runs.length === 0) || (savedTab === "summary" && !props.summary) || (savedTab === "map" && !props.architecture) || (savedTab === "network" && !hasNetwork) ? "changes" : savedTab;
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
    if (props.agents?.openKey) setTab("agents");
  }, [props.agents?.openKey]);
  useEffect(() => {
    if (props.architecture?.openKey) setTab("map");
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
          <button id={tabId("changes")} role="tab" tabIndex={tab === "changes" ? 0 : -1} aria-selected={tab === "changes"} className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
            Changes
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
          <button id={tabId("files")} role="tab" tabIndex={tab === "files" ? 0 : -1} aria-selected={tab === "files"} className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
            Files
          </button>
          {props.summary && (
            <button id={tabId("summary")} role="tab" tabIndex={tab === "summary" ? 0 : -1} aria-selected={tab === "summary"} className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>
              Summary
            </button>
          )}
          {props.architecture && (
            <button id={tabId("map")} role="tab" tabIndex={tab === "map" ? 0 : -1} aria-selected={tab === "map"} className={tab === "map" ? "active" : ""} title="The architecture map" onClick={() => setTab("map")}>
              Map
            </button>
          )}
          {props.agents && (
            <button id={tabId("agents")} role="tab" tabIndex={tab === "agents" ? 0 : -1} aria-selected={tab === "agents"} className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>
              Activity
              {props.agents.tree.live && <span className="tab-live" aria-label="working" />}
            </button>
          )}
          {runs.length > 0 && (
            <button id={tabId("tests")} role="tab" tabIndex={tab === "tests" ? 0 : -1} aria-selected={tab === "tests"} className={tab === "tests" ? "active" : ""} onClick={() => setTab("tests")}>
              Tests
              {latestRun?.outcome === "failed" && <span className="tab-count failed">{latestRun.failed || "!"}</span>}
            </button>
          )}
          {hasNetwork && (
            <button id={tabId("network")} role="tab" tabIndex={tab === "network" ? 0 : -1} aria-selected={tab === "network"} className={tab === "network" ? "active" : ""} title="Requests matching this folder's watches, from Network Monitor" onClick={() => setTab("network")}>
              Network
              {network.items.length > 0 && <span className="tab-count">{network.items.length}</span>}
            </button>
          )}
        </div>
        {tab === "changes" && props.onScope && <ScopeMenu {...props} onScope={props.onScope} />}
        {tab === "changes" && allRevert && rv && count > 0 && (
          <button
            className="ghost revert-all"
            disabled={!!revertOff}
            title={revertOff ?? (allRevert.scope === "session" ? "Put every file this chat changed back to how it was before the chat began" : "Put the files your last message changed back to how they were before it")}
            onClick={() => setReverting({ title: allRevert.scope === "session" ? "Revert all of this chat's changes?" : "Revert the last message's changes?", files: props.files, request: allRevert })}
          >
            Revert all
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
      {tab === "summary" && props.summary && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("summary")}>
          <SummaryTab slot={props.summary.slot} summary={props.summary.data} changed={props.summary.changed} running={props.summary.running} onOpenPage={props.summary.onOpenPage} doc={props.summary.doc} revert={rv} />
        </div>
      )}
      {tab === "map" && props.architecture && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("map")}>
          <ArchitectureTab map={props.architecture.map} current={props.architecture.current} pageNames={props.architecture.pageNames} onOpenPage={props.architecture.onOpenPage} box={props.architecture.box} />
        </div>
      )}
      {tab === "agents" && props.agents && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("agents")}>
          <AgentsTab tree={props.agents.tree} graph={props.agents.graph} usage={props.agents.usage} />
        </div>
      )}
      {tab === "tests" && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("tests")}>
          <TestsTab runs={runs} selected={shownRun} onSelect={setShownRun} onOpenLocation={openLocation} />
        </div>
      )}
      {tab === "network" && network && props.folder && (
        <div className="tab-body" role="tabpanel" aria-labelledby={tabId("network")}>
          <NetworkTab folder={props.folder} view={network} onSummarize={props.onSummarizeRequest ?? null} busy={props.chatBusy} />
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

function ChangesTab({ folder, files, scope = "session", stepRange, gitError, pr, branch, selected, follow, refreshKey, onSelect, onFollow, onEdit, diffLine, fileRevert }: Props & { diffLine: { path: string; line: number; key: number } | null; onEdit: (path: string) => void; fileRevert?: { off: string | null; onFile: (file: ChangedFile) => void } }) {
  const [layout, setLayout] = usePersistentState<DiffLayout>("review.diffLayout", "inline");
  const found = files.findIndex((f) => f.path === selected);
  const index = found === -1 ? files.length - 1 : found;
  const current = files[index] ?? null;

  if (!current) {
    const empty =
      scope === "git" ? (gitError ?? "Nothing uncommitted") :
      scope === "pr" ? (gitError ?? `Fetching pull request #${pr}…`) :
      scope === "branch" ? (gitError ?? "Reading the branch…") :
      scope !== "turn" ? "No changes yet" : stepRange === null ? "This step's changes aren't known: the chat was reopened after it" : stepRange !== undefined ? "No changes in this step" : "No changes in the last turn";
    return <div className="empty">{empty}</div>;
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
      <Suspense fallback={<div className="empty">Loading diff…</div>}>
        <FullDiff path={current.path} refreshKey={refreshKey} layout={layout} scope={scope} turn={scope === "turn" ? (stepRange?.from ?? null) : null} toTurn={scope === "turn" ? (stepRange?.to ?? null) : null} pr={scope === "pr" ? (pr ?? null) : null} base={scope === "branch" ? (branch?.base ?? null) : null} reveal={diffLine?.path === current.path ? ({ line: diffLine.line, key: diffLine.key } satisfies Reveal) : null} />
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
        <div className="menu scope-menu" role="menu" aria-label="Show changes from" onKeyDown={keys.onKeyDown}>
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
        <div className="menu file-menu">
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
