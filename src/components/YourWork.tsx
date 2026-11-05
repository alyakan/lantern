import { createContext, useContext, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { InboxRow } from "../lib/deskBoard";
import { usePersistentState } from "../lib/layout";
import { PROJECT_COLORS } from "../lib/projectColors";
import { askOf, bucketOf, BUCKETS, chatsOn, openBucket, searchTerms, filterWork, FILTER_TONES, foldRows, foldWord, groupWork, lineOf, nextSteps, STAGES, stackWord, stateCounts, targetFor, toneCounts, TONE_WORD, unknownViewer, type Bucket, type Fold, type GroupBy, type Target, type Tone, type WorkGroup, type WorkItem, type WorkRow } from "../lib/yourWork";
import type { ChatHit, ChatSearchResults, RepoStatus } from "../types";
import { Card } from "./DeskCard";
import { safeIssueUrl } from "../lib/linear";
import { ExternalLink } from "./ExternalLink";
import { useMenuKeys } from "./useMenuKeys";

export interface YourWorkProps {
  repos: RepoStatus[] | null;
  /** Every piece of your work (yourWork, with Linear's issues when it is connected). */
  items: WorkItem[];
  /** Linear is connected: paths start at the issue. */
  issues: boolean;
  /** Every chat on the Desk: a step goes to the one on its branch. */
  chats: InboxRow[];
  /** Sends a step: to a chat, or to a new chat in a folder; false when it couldn't (no agent CLI ready). */
  onStep: (item: WorkItem, target: Target) => boolean;
  /** Asks git, GitHub and Linear again now. */
  onRefresh: () => void;
  /** The status board first, Next under it: a project's page shows where its work stands before what to do. */
  standFirst?: boolean;
  /** Only Next: the Desk's cross-project actions, while each project's page carries the board (see #desk-v2). */
  nextOnly?: boolean;
  /** Opens a chat on the Desk (an item's details offer the one on its branch). */
  onOpen?: (slot: string) => void;
}

/** History's search over every past chat, and opening one of them: an item's details find the last chat about it with them. */
export const PastChats = createContext<{ find?: (query: string) => Promise<ChatSearchResults>; open?: (id: string, folder: string) => void }>({});

/** The newest past chat about `item`, by its branch, then its issue, then its pull request (undefined while it looks; null: none). */
function useLastChat(item: WorkItem): ChatHit | null | undefined {
  const { find } = useContext(PastChats);
  const [last, setLast] = useState<ChatHit | null | undefined>(find ? undefined : null);
  const terms = searchTerms(item).join("\n");
  useEffect(() => {
    if (!find) return;
    let live = true;
    void (async () => {
      for (const term of terms.split("\n").filter(Boolean)) {
        const found = await find(term).catch(() => null);
        if (!live) return;
        const hit = found && !found.cancelled ? found.chats[0] : undefined;
        if (hit) return setLast(hit);
      }
      setLast(null);
    })();
    return () => {
      live = false;
    };
  }, [find, terms]);
  return last;
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

/** Each project's colour in the sidebar (folder → index into PROJECT_COLORS): an item's tag says its project in it. */
export const ProjectColors = createContext<Record<string, number>>({});

/** Which project an item is in, as a tag in the project's sidebar colour: only where items of several projects are listed. */
const Tagged = createContext<{ on: boolean; repos: RepoStatus[] | null }>({ on: false, repos: null });

function ProjectTag({ item }: { item: WorkItem }) {
  const colors = useContext(ProjectColors);
  const { on, repos } = useContext(Tagged);
  if (!on) return null;
  const r = repos?.find((x) => x.repo === item.repo);
  const index = [item.repo, ...(r?.folders.map((f) => f.folder) ?? [])].map((f) => colors[f]).find((i) => i !== undefined);
  const color = index !== undefined ? PROJECT_COLORS[index] : undefined;
  return (
    <span className="yw-project-tag" style={color ? ({ "--tag": color } as CSSProperties) : undefined} title={`In ${item.name}`}>
      {item.name}
    </span>
  );
}

/** Opens an item's details: every row and step can. */
const Pick = createContext<(item: WorkItem) => void>(() => {});

/** The rows of "Where things stand" shown before "Show N more": all of it in one list, or each group's; and Next's. */
const SHOWN = 8;
const SHOWN_IN_GROUP = 4;
const SHOWN_NEXT = 5;

/** Steps sent, by item, with the state the item was in: marked as sent until it moves on (kept while the window is open, so
 * leaving the Desk and coming back doesn't offer the same step again). */
const sent = new Map<string, { sig: string; to: string }>();

/** Forgets every step sent (for tests: each starts with none). */
export const forgetSent = () => sent.clear();

/** Where a step was sent, while the item is still in the state it was sent in (a phone's step goes through here too, so a step
 * sent from the phone isn't offered on the Mac again, nor the other way round). */
export const stepSentTo = (key: string, sig: string): string | null => {
  const was = sent.get(key);
  return was && was.sig === sig ? was.to : null;
};
export const markStepSent = (key: string, sig: string, to: string) => void sent.set(key, { sig, to });

/** Its path, a node a stage: green behind it, ringed in its state's colour where it is, grey ahead. With Linear, the path starts
 * at the issue; work with no issue in Linear has that node dashed. */
function Nodes({ item, issues }: { item: WorkItem; issues: boolean }) {
  const stages = issues ? STAGES : STAGES.filter((s) => s.stage !== "issue");
  const at = stages.findIndex((s) => s.stage === item.stage);
  const done = item.tone === "done";
  const mark = (stage: string, i: number) => (stage === "issue" && i < at && !item.issue ? " yw-skip" : i < at || (done && i === at) ? " yw-past" : i === at ? " yw-now" : "");
  return (
    <ol className="yw-nodes" aria-label={`At ${stages[at].label}, ${TONE_WORD[item.tone]}`}>
      {stages.map((s, i) => (
        <li key={s.stage} className={`yw-node${mark(s.stage, i)}`} aria-current={i === at ? "step" : undefined} title={s.stage === "issue" && i < at && !item.issue ? "No Linear issue" : s.label}>
          <i aria-hidden />
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function StepButton({ item, chats, repos, onStep }: { item: WorkItem; chats: InboxRow[]; repos: RepoStatus[] | null; onStep: YourWorkProps["onStep"] }) {
  const [, redraw] = useState(0);
  const step = item.next!;
  const was = stepSentTo(item.key, item.sig);
  if (was) return <span className="yw-sent">Sent to {was}</span>;
  const target = targetFor(item, chats, repos);
  if (!target) return null;
  if (target.kind === "busy") return <span className="yw-sent" title={`"${target.title}" ${target.why}: try again when it's idle`}>Its chat {target.why}</span>;
  const to = target.kind === "chat" ? `"${target.title}"` : "a new chat";
  return (
    <button
      className={step.warn ? "yw-bypass" : step.yours ? "yw-yours" : "primary"}
      title={step.warn ? `Asks ${to} to merge it past the required review; it asks you on an approval card that says so, before anything happens` : step.yours ? `Asks ${to} to get it ready; it asks you on an approval card before anything happens` : `Sends this to ${to}`}
      aria-label={`${step.what} ${item.number !== null ? `#${item.number}` : item.title}`}
      onClick={() => {
        if (!onStep(item, target)) return;
        markStepSent(item.key, item.sig, target.kind === "chat" ? `"${target.title}"` : "a new chat");
        redraw((n) => n + 1);
      }}
    >
      {step.button}
    </button>
  );
}

/** The Linear issue a pull request or branch is the work of, as a chip of its own under its name: what it joins its feature by. */
function IssueChip({ item, feature }: { item: WorkItem; feature: string | null }) {
  const issue = item.issue!;
  const chip = (
    <>
      <b className="yw-issue-id">{issue.identifier}</b>
      {issue.title && <span className="yw-issue-title">{issue.title}</span>}
      {/* Outside a feature's heading, the feature is said here. */}
      {feature === null && issue.project && <span className="yw-issue-in">in {issue.project}</span>}
    </>
  );
  return safeIssueUrl(issue.url) ? (
    <ExternalLink className="yw-issue" href={issue.url}>
      {chip}
    </ExternalLink>
  ) : (
    <span className="yw-issue">{chip}</span>
  );
}

/** The class a stacked pull request's row adds: a rail joins it to the ones above and under it. */
const stackClass = (item: WorkItem) => (item.stack ? ` yw-stacked${item.stack.pos === 1 ? " yw-stack-first" : ""}${item.stack.pos === item.stack.of ? " yw-stack-last" : ""}` : "");

/** One item where it stands, on two lines: a bar in its state's colour, its name and state, then a quiet line (its issue, where it
 * is, its place in a stack). The rest (its path, links, the chat on it, its step) is in its details, which a click opens. */
function StandRow({ item, feature = null }: { item: WorkItem; issues: boolean; feature?: string | null }) {
  const pick = useContext(Pick);
  const tagged = useContext(Tagged).on;
  const line = lineOf(item, feature, tagged);
  return (
    <li className={`dp-row yw-row yw-tone-${item.tone}${item.next?.warn ? " yw-warn" : ""}${stackClass(item)}`}>
      <button className="yw-open" onClick={() => pick(item)} aria-haspopup="dialog" title="Details, links and the chat on it">
        <span className="dp-title yw-name">
          {item.number !== null && <><span className="yw-num">#{item.number}</span> </>}{item.title}
        </span>
        {/* Its tags, on a line of their own: the project (where several are listed), then where it stands. */}
        <span className="yw-tags">
          <ProjectTag item={item} />
          <span className="yw-word">{item.word}</span>
        </span>
        {line && <span className="dp-meta">{line}</span>}
      </button>
    </li>
  );
}

/**
 * An item's details: where it stands and its path, its issue, branch and place in a stack, and what can be done with it: its step,
 * the chat on its branch, and its pages on GitHub and Linear.
 */
function WorkDetail({ item, issues, chats, repos, onStep, onOpen, onClose }: { item: WorkItem; issues: boolean; chats: InboxRow[]; repos: RepoStatus[] | null; onStep: YourWorkProps["onStep"]; onOpen?: (slot: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  const on = chatsOn(item, chats, repos);
  const past = useContext(PastChats);
  const last = useLastChat(item);
  const lastTitle = last ? last.title.map((p) => p.text).join("") || "Untitled chat" : "";
  const pr = item.number !== null && item.github ? `https://github.com/${item.github}/pull/${item.number}` : null;
  const linear = item.issue && safeIssueUrl(item.issue.url) ? item.issue.url : null;
  const facts = [item.name, item.branch, item.stack ? stackWord(item.stack) : null].filter(Boolean).join(" · ");
  return (
    <dialog
      ref={ref}
      className={`revert-dialog yw-detail yw-tone-${item.tone}${item.next?.warn ? " yw-warn" : ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="revert-body">
        <div className="revert-title" id={titleId}>
          {item.number !== null && <><span className="yw-num">#{item.number}</span> </>}{item.title}
        </div>
        <p className="yw-detail-state">
          <ProjectTag item={item} />
          <span className="yw-word">{item.word}</span>
          <span className="dp-meta">{facts}</span>
        </p>
        <Nodes item={item} issues={issues} />
        {item.issue && !item.key.startsWith("linear:") && <IssueChip item={item} feature={null} />}
        {item.key.startsWith("linear:") && item.issue?.project && <p className="dp-meta">In {item.issue.project}</p>}
        {item.next && (
          <div className="yw-detail-step dp-aside">
            <span className="yw-detail-what">{item.next.what}…</span>
            <StepButton item={item} chats={chats} repos={repos} onStep={onStep} />
          </div>
        )}
        <div className="revert-actions yw-detail-actions">
          {onOpen && on[0] && (
            <button
              title={`Open "${on[0].title}", the chat on its branch`}
              onClick={() => {
                onClose();
                onOpen(on[0].slot);
              }}
            >
              Open chat
            </button>
          )}
          {past.open && last === undefined && (
            <button disabled title="Searching your past chats for its branch, issue and pull request">
              Finding its last chat…
            </button>
          )}
          {past.open && last && (
            <button
              title={`"${lastTitle}", ${ago(last.updated_ms)}: the newest chat that mentions it`}
              onClick={() => {
                onClose();
                past.open!(last.id, last.folder);
              }}
            >
              Last chat · {lastTitle.length > 32 ? `${lastTitle.slice(0, 31)}…` : lastTitle}
            </button>
          )}
          {pr && <ExternalLink className="yw-detail-link" href={pr}>GitHub</ExternalLink>}
          {linear && <ExternalLink className="yw-detail-link" href={linear}>Linear</ExternalLink>}
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Several quiet pieces of work in one line (Ready, or done): it opens to a row for each. */
function FoldRow({ fold, items, issues, feature }: { fold: Fold; items: WorkItem[]; issues: boolean; feature: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`dp-row yw-row yw-foldrow yw-tone-${fold}`}>
      <button className="yw-fold" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Fold them away" : "Show them"}>
        <span className="chev" aria-hidden />
        <span className="yw-name">{foldWord(fold, items.length)}</span>
      </button>
      {open && (
        <ul className="dp-list yw-folded">
          {items.map((i) => (
            <StandRow key={i.key} item={i} issues={issues} feature={feature} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A list's rows: each item, and a folded line for several quiet ones. */
function Rows({ rows, issues, feature }: { rows: WorkRow[]; issues: boolean; feature: string | null }) {
  return (
    <>
      {rows.map((r) => (r.kind === "item" ? <StandRow key={r.item.key} item={r.item} issues={issues} feature={feature} /> : <FoldRow key={`fold:${r.fold}`} fold={r.fold} items={r.items} issues={issues} feature={feature} />))}
    </>
  );
}

/** A group of work (a feature, or a project): its name, a dot and a count for each state, how many issues are in work and to start,
 * then its rows. Its name folds it. */
function Group({ group, by, issues, fold, folded, onFold }: { group: WorkGroup; by: GroupBy; issues: boolean; fold: boolean; folded: boolean; onFold: () => void }) {
  const [all, setAll] = useState(false);
  // Ready and done pieces fold into a line each, unless a state was chosen to be looked at.
  const rows: WorkRow[] = fold ? foldRows(group.items) : group.items.map((item) => ({ kind: "item", item }));
  const shown = all ? rows : rows.slice(0, SHOWN_IN_GROUP);
  const more = rows.length - shown.length;
  const counts = toneCounts(group.items.map((i) => ({ ...i, repo: "" })), "");
  return (
    <section className="yw-feature" aria-label={group.label}>
      <header className="yw-feature-head">
        <button className="yw-fold" aria-expanded={!folded} onClick={onFold} title={folded ? "Show its work" : "Fold it away"}>
          <span className="chev" aria-hidden />
          <span className="yw-head-text">
            {/* What a group is, said once on its heading: a Linear project (a feature) or a repository. */}
            {!group.plain && by !== "none" && <span className="yw-kicker" aria-hidden>{by === "feature" ? "Feature · Linear project" : "Project"}</span>}
            <h3>{group.label}</h3>
          </span>
        </button>
        <WorkDots counts={counts} />
        {(group.doing > 0 || group.todo > 0) && (
          <span className="yw-feature-sum">{[group.doing > 0 && `${group.doing} doing`, group.todo > 0 && `${group.todo} to start`].filter(Boolean).join(" · ")}</span>
        )}
      </header>
      {/* Folded away, a feature still says what is in it: its rows' names, and how many are left out. */}
      {folded && (
        <p className="yw-peek">
          {group.items
            .slice(0, 3)
            .map((i) => (i.number !== null ? `#${i.number} ${i.title}` : i.title))
            .join(" · ")}
          {group.items.length > 3 ? " · …" : ""}
        </p>
      )}
      {!folded && (
        <>
          <ul className="dp-list">
            <Rows rows={shown} issues={issues} feature={group.plain ? null : group.label} />
          </ul>
          {more > 0 && (
            <button className="desk-more dp-foot" onClick={() => setAll(true)}>
              Show {more} more
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** How "Where things stand" is drawn: a card for each feature that opens into tabs, or the list of every piece with its filters. */
type Layout = "cards" | "list";

function ViewToggle({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  return (
    <span className="yw-view" role="group" aria-label="Layout">
      {(["cards", "list"] as const).map((l) => (
        <button key={l} aria-pressed={layout === l} className={layout === l ? "on" : ""} onClick={() => onLayout(l)} title={l === "cards" ? "A card for each feature, with its work under tabs" : "Every piece of work in one list, with filters"}>
          {l === "cards" ? "Cards" : "List"}
        </button>
      ))}
    </span>
  );
}

/** A feature as a card: its name, its pieces as dots (colour only on what needs you), and the one thing that does. It opens to the feature's page. */
function FeatureCard({ group, onOpen }: { group: WorkGroup; onOpen: () => void }) {
  const live = group.items.filter((i) => bucketOf(i) !== "shipped");
  const shipped = group.items.length - live.length;
  const ask = askOf(group.items);
  const top = ask[0];
  const sum = [live.length > 0 && `${live.length} open`, shipped > 0 && `${shipped} shipped`].filter(Boolean).join(" · ");
  return (
    <button className="yw-fcard" onClick={onOpen} aria-label={`${group.label}, ${sum || "nothing open"}${top ? `, ${top.word}` : ""}`} title="Open its work">
      <span className="yw-fcard-head">
        <b>{group.label}</b>
        <span className="yw-quiet">{sum}</span>
        <span className="yw-go" aria-hidden>›</span>
      </span>
      {live.length > 0 && (
        <span className="yw-pieces" aria-hidden>
          {live.map((i) => (
            <i key={i.key} className={`yw-pdot yw-b-${bucketOf(i)}${bucketOf(i) === "attn" ? ` yw-tone-${i.tone}${i.next?.warn ? " yw-warn" : ""}` : ""}`} />
          ))}
        </span>
      )}
      {top ? (
        <span className={`yw-ask yw-tone-${top.tone}${top.next?.warn ? " yw-warn" : ""}`}>
          <b>{top.next?.warn ? "Bypasses review" : top.word}</b> {top.next ? `${top.next.what} ` : ""}
          {top.number !== null ? `#${top.number} ` : ""}
          {top.title}
        </span>
      ) : (
        <span className="yw-quiet">Nothing needs you.</span>
      )}
      {ask.length > 1 && <span className="yw-quiet">and {ask.length - 1} more</span>}
    </button>
  );
}

/** One piece of work on a feature's page: its name, a quiet line, and its pipeline (issue to release). Taller than a list row, since it carries the pipeline. */
function FeatureRow({ item, issues, heading, dropName, chats, repos, onStep }: { item: WorkItem; issues: boolean; heading: string | null; dropName: boolean; chats: InboxRow[]; repos: RepoStatus[] | null; onStep: YourWorkProps["onStep"] }) {
  const pick = useContext(Pick);
  const bucket = bucketOf(item);
  const attn = bucket === "attn";
  const line = lineOf(item, heading, dropName);
  return (
    <li className={`yw-frow yw-b-${bucket}${attn ? ` yw-tone-${item.tone}` : ""}${item.next?.warn ? " yw-warn" : ""}`}>
      <i className="yw-pdot" aria-hidden />
      <button className="yw-open yw-fmain" onClick={() => pick(item)} aria-haspopup="dialog" title="Details, links and the chat on it">
        <span className="yw-fname">
          {item.number !== null && <><span className="yw-num">#{item.number}</span> </>}{item.title}
        </span>
        <span className="yw-fline">
          {attn ? <b className="yw-word">{item.word}</b> : item.word}
          {line ? ` · ${line}` : ""}
        </span>
        {bucket !== "shipped" && <Nodes item={item} issues={issues} />}
      </button>
      {attn && item.next && (
        <span className="yw-fstep">
          <StepButton item={item} chats={chats} repos={repos} onStep={onStep} />
        </span>
      )}
    </li>
  );
}

/** A feature's page: its name, its tabs (Needs you, Moving, To start, Shipped), and the rows under the one chosen. */
function FeatureDetail({ group, issues, dropName, tab, onTab, onBack, chats, repos, onStep }: { group: WorkGroup; issues: boolean; dropName: boolean; tab: Bucket | null; onTab: (b: Bucket) => void; onBack: (() => void) | null; chats: InboxRow[]; repos: RepoStatus[] | null; onStep: YourWorkProps["onStep"] }) {
  const on = tab ?? openBucket(group.items);
  const rows = group.items.filter((i) => bucketOf(i) === on);
  const live = group.items.filter((i) => bucketOf(i) !== "shipped").length;
  return (
    <section className="yw-fpage" aria-label={group.label}>
      {onBack && (
        <button className="desk-back" onClick={onBack}>
          ‹ Work
        </button>
      )}
      <h3 className="yw-ftitle">{group.label}</h3>
      <p className="yw-quiet">
        {live} open, {group.items.length - live} shipped
      </p>
      <div className="yw-tabs" role="tablist" aria-label={`${group.label} work`}>
        {BUCKETS.map(({ bucket, label }) => {
          const n = group.items.filter((i) => bucketOf(i) === bucket).length;
          return (
            <button key={bucket} role="tab" aria-selected={bucket === on} className={`yw-tab${bucket === on ? " on" : ""}${n === 0 ? " zero" : ""}`} onClick={() => onTab(bucket)}>
              {label}
              {bucket === "attn" && n > 0 && <i className="yw-tab-n">{n}</i>}
            </button>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <p className="yw-quiet yw-empty">Nothing here.</p>
      ) : (
        <ul className="yw-flist">
          {rows.map((i) => (
            <FeatureRow key={i.key} item={i} issues={issues} heading={group.plain ? null : group.label} dropName={dropName} chats={chats} repos={repos} onStep={onStep} />
          ))}
        </ul>
      )}
    </section>
  );
}

const GROUPS: { by: GroupBy; label: string }[] = [
  { by: "feature", label: "Feature" },
  { by: "project", label: "Project" },
  { by: "none", label: "None" },
];

/** How the list is grouped, as a line of quiet text that opens a menu (a setting that changes the layout, so it isn't drawn as a filter),
 * with Expand all / Collapse all in the same menu. */
function GroupMenu({ by, issues, onBy, grouped, allOpen, onAll }: { by: GroupBy; issues: boolean; onBy: (b: GroupBy) => void; grouped: boolean; allOpen: boolean; onAll: () => void }) {
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
  const label = GROUPS.find((g) => g.by === by)?.label ?? "";
  return (
    <div className="yw-gby" ref={root}>
      <button className="yw-gby-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="How the work is grouped">
        {by === "none" ? "Not grouped" : `Grouped by ${label}`}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu yw-gmenu" role="menu" aria-label="Group by" onKeyDown={keys.onKeyDown}>
          {GROUPS.map((g) => {
            const off = g.by === "feature" && !issues;
            return (
              <button
                key={g.by}
                role="menuitemradio"
                aria-checked={by === g.by}
                disabled={off}
                className={`menu-row${by === g.by ? " current" : ""}`}
                onClick={() => {
                  setOpen(false);
                  onBy(g.by);
                }}
                title={off ? "Connect Linear in Settings to group by feature" : g.by === "feature" ? "A feature is the Linear project an issue is in; a pull request joins it by its issue's link or its branch name" : undefined}
              >
                <span className="menu-row-title">{g.label}</span>
              </button>
            );
          })}
          {/* Every feature open or folded at once. Only when there is something to group. */}
          {grouped && (
            <>
              <div className="menu-sep" />
              <button
                role="menuitem"
                className="menu-row"
                onClick={() => {
                  setOpen(false);
                  onAll();
                }}
              >
                <span className="menu-row-title">{allOpen ? "Collapse all" : "Expand all"}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** How the list is grouped (a quiet menu), and under it a chip for each state in the list, to look at only some. */
function Bar({ by, issues, onBy, counts, only, onOnly, grouped, allOpen, onAll }: { by: GroupBy; issues: boolean; onBy: (b: GroupBy) => void; counts: Partial<Record<Tone, number>>; only: Tone[]; onOnly: (t: Tone[]) => void; grouped: boolean; allOpen: boolean; onAll: () => void }) {
  const tones = FILTER_TONES.filter((t) => counts[t]);
  return (
    <div className="yw-bar">
      <GroupMenu by={by} issues={issues} onBy={onBy} grouped={grouped} allOpen={allOpen} onAll={onAll} />
      <div className="yw-filter" role="group" aria-label="Show only">
        {tones.map((t) => {
          const on = only.includes(t);
          return (
            <button key={t} className={`yw-pill yw-tone-${t}${on ? " on" : ""}`} aria-pressed={on} onClick={() => onOnly(on ? only.filter((x) => x !== t) : [...only, t])}>
              <span className="yw-dot" aria-hidden />
              {TONE_WORD[t]} {counts[t]}
            </button>
          );
        })}
        {only.length > 0 && (
          <button className="desk-more" onClick={() => onOnly([])}>
            Show all
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Your work in the Desk's repositories, as two cards: Next, what to do now (yours to decide first, then what is blocked, then
 * branches to push and issues to start), set apart; and Where things stand, each piece from its issue or branch to its release
 * as a row of nodes, grouped by feature (its Linear project) or by project, and filtered by state. Every state is what git, gh and
 * Linear said; a step goes to a chat only when you click it.
 */
export function YourWork({ repos, items, issues, chats, onStep, onRefresh, standFirst = false, nextOnly = false, onOpen }: YourWorkProps) {
  const [all, setAll] = useState(false);
  // Items of several projects in one list (the Desk's own Next, or grouped by feature or none): each says its project in a tag.
  const tagged = (repos?.length ?? 0) > 1;
  // The item whose details are open, by key: it stays open as the item moves on, and closes if it goes.
  const [picked, setPicked] = useState<string | null>(null);
  const [allNext, setAllNext] = useState(false);
  const [chosen, setChosen] = usePersistentState<GroupBy | "auto">("desk.work.groupBy", "auto");
  const [only, setOnly] = useState<Tone[]>([]);
  // Which features are open, by `${grouping}:${feature}`: all folded until the user opens one, and kept between visits.
  const [open, setOpen] = usePersistentState<string[]>("desk.work.open", []);
  // Next can be folded to its count and the first steps: useful when the board below is what you came for.
  const [nextClosed, setNextClosed] = usePersistentState("desk.work.nextClosed", false);
  // Cards (a card per feature that opens into tabs) or the list; the feature whose page is open, by its group key, and its tab.
  const [layout, setLayout] = usePersistentState<Layout>("desk.work.layout", "cards");
  const [cardPage, setCardPage] = useState<string | null>(null);
  const [cardTab, setCardTab] = useState<Bucket | null>(null);
  if (!repos || repos.length === 0) return null;
  const next = nextSteps(items);
  const nextShown = allNext ? next : next.slice(0, SHOWN_NEXT);
  // Without Linear there are no features: the default is the projects, the next best way to tell the work apart.
  const by: GroupBy = chosen === "auto" ? (issues ? "feature" : "project") : chosen === "feature" && !issues ? "project" : chosen;
  const listed = items.filter((i) => !i.stepOnly);
  const groups = groupWork(filterWork(items, only), by);
  // One group, or the work in no feature, needs no heading: it is a list.
  const flat = by === "none" || (groups.length === 1 && (by === "project" || groups[0].plain));
  const foldThem = only.length === 0;
  const standItems = flat ? (groups[0]?.items ?? []) : [];
  const stand: WorkRow[] = foldThem ? foldRows(standItems) : standItems.map((item) => ({ kind: "item", item }));
  const shown = all ? stand : stand.slice(0, SHOWN);
  const more = stand.length - shown.length;
  const blind = unknownViewer(repos);
  const toggle = (key: string) => setOpen(open.includes(key) ? open.filter((k) => k !== key) : [...open, key]);
  const groupKeys = groups.map((g) => `${by}:${g.key}`);
  const allOpen = groupKeys.length > 0 && groupKeys.every((k) => open.includes(k));
  const toggleAll = () => setOpen(allOpen ? open.filter((k) => !groupKeys.includes(k)) : [...new Set([...open, ...groupKeys])]);
  const nextCard = (
      <Card
        title="Next"
        count={next.length}
        heading="h2"
        className={`yw-card yw-next${layout === "cards" ? " yw-calm" : ""}`}
        action={
          <span className="yw-next-actions">
            <button className="desk-more" aria-expanded={!nextClosed} onClick={() => setNextClosed(!nextClosed)}>
              {nextClosed ? "Expand" : "Collapse"}
            </button>
            <button className="desk-more" onClick={onRefresh} title={issues ? "Ask git, GitHub and Linear again" : "Ask git and GitHub again"}>
              Refresh
            </button>
          </span>
        }
      >
        {nextClosed ? (
          next.length > 0 ? (
            <p className="yw-peek">
              {next
                .slice(0, 2)
                .map((i) => `${i.next!.what} ${i.number !== null ? `#${i.number} ${i.title}` : i.title}`)
                .join(" · ")}
              {next.length > 2 ? " · …" : ""}
            </p>
          ) : (
            <p className="dp-note">Nothing to do right now.</p>
          )
        ) : (
        <>
        {blind.length > 0 && (
          <p className="dp-note">
            Couldn't tell which GitHub account is yours in {blind.join(", ")}, so its pull requests aren't shown. Refresh to try again.
          </p>
        )}
        {items.length === 0 ? (
          <p className="dp-note">Nothing open: no pull requests of yours, nothing waiting to be released, no branches left unpushed{issues ? ", no issues to start" : ""}.</p>
        ) : next.length === 0 ? (
          <p className="dp-note">Nothing to do right now: everything open is on its way.</p>
        ) : (
          <>
            <ul className="dp-list">
              {nextShown.map((i) => (
                <li key={i.key} className={`dp-row yw-row yw-tone-${i.tone}${i.next!.warn ? " yw-warn" : ""}`}>
                  <span className="dp-row-top">
                    <button className="dp-title yw-name yw-open" onClick={() => setPicked(i.key)} aria-haspopup="dialog" title="Details, links and the chat on it">
                      {i.next!.what} {i.number !== null && <><span className="yw-num">#{i.number}</span> </>}{i.title}
                    </button>
                    <span className="dp-aside">
                      <StepButton item={i} chats={chats} repos={repos} onStep={onStep} />
                    </span>
                  </span>
                  {/* Its tags, on a line of their own: the project (where several are listed), then yours to decide said outright (a step that
                      goes around a rule says so), or where it stands, in its state's colour. */}
                  <span className="yw-tags">
                    <ProjectTag item={i} />
                    <span className="yw-word">{i.next!.warn ? "Bypasses review" : i.next!.yours ? "Your call" : i.word}</span>
                  </span>
                  <span className="dp-meta">{i.next!.yours ? `${i.word} · ${lineOf(i, null, tagged)}` : lineOf(i, null, tagged)}</span>
                </li>
              ))}
            </ul>
            {next.length > nextShown.length && (
              <button className="desk-more dp-foot" onClick={() => setAllNext(true)}>
                Show {next.length - nextShown.length} more
              </button>
            )}
          </>
        )}
        </>
        )}
      </Card>
  );
  const viewToggle = <ViewToggle layout={layout} onLayout={setLayout} />;
  // The cards ignore the list's state filter (the tabs are the filter) and its grouping: a card is a feature with Linear, a project without.
  const cardGroups = groupWork(items, issues ? "feature" : "project");
  // One feature (or project) needs no card to open it: its page is the list.
  const alone = cardGroups.length === 1;
  const cardOpen = alone ? cardGroups[0] : cardPage !== null ? cardGroups.find((g) => g.key === cardPage) : undefined;
  const cardsCard = (
    <section className="yw-cards" aria-label="Where things stand">
      <header className="yw-cards-head">
        <h2 className="desk-h">Where things stand</h2>
        {viewToggle}
      </header>
      {cardOpen ? (
        <FeatureDetail group={cardOpen} issues={issues} dropName={!tagged} tab={cardTab} onTab={setCardTab} onBack={alone ? null : () => setCardPage(null)} chats={chats} repos={repos} onStep={onStep} />
      ) : (
        <div className="yw-fgrid">
          {cardGroups.map((g) => (
            <FeatureCard
              key={g.key}
              group={g}
              onOpen={() => {
                setCardPage(g.key);
                setCardTab(null);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
  const standCard = items.length > 0 && layout === "cards" ? cardsCard : items.length > 0 ? (
        <Card title="Where things stand" count={listed.length} heading="h2" className="yw-card yw-stand" action={viewToggle}>
          <Bar by={by} issues={issues} onBy={setChosen} counts={stateCounts(items)} only={only} onOnly={setOnly} grouped={!flat && groups.length > 1} allOpen={allOpen} onAll={toggleAll} />
          {groups.length === 0 ? (
            <p className="dp-note">Nothing is {only.map((t) => TONE_WORD[t]).join(" or ")}.</p>
          ) : flat ? (
            <>
              <ul className="dp-list">
                <Rows rows={shown} issues={issues} feature={null} />
              </ul>
              {more > 0 && (
                <button className="desk-more dp-foot" onClick={() => setAll(true)}>
                  Show {more} more
                </button>
              )}
            </>
          ) : (
            groups.map((g) => <Group key={`${by}:${g.key}`} group={g} by={by} issues={issues} fold={foldThem} folded={!open.includes(`${by}:${g.key}`)} onFold={() => toggle(`${by}:${g.key}`)} />)
          )}
        </Card>
  ) : null;
  const shownItem = picked ? items.find((i) => i.key === picked) : undefined;
  const detail = shownItem && <WorkDetail item={shownItem} issues={issues} chats={chats} repos={repos} onStep={onStep} onOpen={onOpen} onClose={() => setPicked(null)} />;
  return (
    <Tagged.Provider value={{ on: tagged, repos }}>
    <Pick.Provider value={(i) => setPicked(i.key)}>
      {nextOnly ? nextCard : standFirst ? <>{standCard}{nextCard}</> : <>{nextCard}{standCard}</>}
      {detail}
    </Pick.Provider>
    </Tagged.Provider>
  );
}

/** A project's work in a line on its tile: a coloured dot and a count for each state, blocked first. */
export function WorkDots({ counts }: { counts: Partial<Record<WorkItem["tone"], number>> }) {
  const order: WorkItem["tone"][] = ["bad", "you", "move", "wait", "local", "todo"];
  const shown = order.filter((t) => counts[t]);
  if (!shown.length) return <span className="muted">nothing open</span>;
  return (
    <span className="yw-dots" aria-label={shown.map((t) => `${counts[t]} ${TONE_WORD[t]}`).join(", ")}>
      {shown.map((t) => (
        <span key={t} className={`yw-chip yw-tone-${t}`} title={TONE_WORD[t]}>
          <span className="yw-dot" aria-hidden />
          {counts[t]}
        </span>
      ))}
    </span>
  );
}
