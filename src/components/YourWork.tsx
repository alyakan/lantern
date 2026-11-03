import { useState } from "react";
import type { InboxRow } from "../lib/deskBoard";
import { usePersistentState } from "../lib/layout";
import { filterWork, FILTER_TONES, groupWork, nextSteps, STAGES, stateCounts, targetFor, toneCounts, TONE_WORD, unknownViewer, type GroupBy, type Target, type Tone, type WorkGroup, type WorkItem } from "../lib/yourWork";
import type { RepoStatus } from "../types";
import { Card, Row } from "./DeskCard";
import { ExternalLink } from "./ExternalLink";

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
}

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

function Num({ item }: { item: WorkItem }) {
  if (item.number === null) return null;
  const n = <span className="yw-num">#{item.number}</span>;
  return item.github ? (
    <ExternalLink className="desk-pr-link" href={`https://github.com/${item.github}/pull/${item.number}`}>
      {n}
    </ExternalLink>
  ) : (
    n
  );
}

/** Its number (a link to GitHub) and its title, or only its title; an issue not started links to Linear. */
function Named({ item }: { item: WorkItem }) {
  if (item.tone === "todo" && item.issue)
    return (
      <ExternalLink className="desk-pr-link" href={item.issue.url}>
        {item.title}
      </ExternalLink>
    );
  return item.number === null ? (
    <>{item.title}</>
  ) : (
    <>
      <Num item={item} /> {item.title}
    </>
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
      className={step.yours ? "yw-yours" : "primary"}
      title={step.yours ? `Asks ${to} to get it ready; it asks you on an approval card before anything happens` : `Sends this to ${to}`}
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

/** One item where it stands: its name and state, a quiet line, and its path as nodes. */
function StandRow({ item, issues, feature = null }: { item: WorkItem; issues: boolean; feature?: string | null }) {
  // Under its feature's heading, the feature isn't said again.
  const meta = feature === null ? item.meta : item.meta.split(" · ").filter((part) => part !== feature).join(" · ");
  return (
    <li className={`dp-row yw-tone-${item.tone}`}>
      <Row title={<Named item={item} />} aside={<span className="yw-word">{item.word}</span>} meta={meta} />
      <Nodes item={item} issues={issues} />
    </li>
  );
}

/** A group of work (a feature, or a project): its name, a dot and a count for each state, how many issues are in work and to start,
 * then its rows. Its name folds it. */
function Group({ group, issues, folded, onFold }: { group: WorkGroup; issues: boolean; folded: boolean; onFold: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? group.items : group.items.slice(0, SHOWN_IN_GROUP);
  const more = group.items.length - shown.length;
  const counts = toneCounts(group.items.map((i) => ({ ...i, repo: "" })), "");
  return (
    <section className="yw-feature" aria-label={group.label}>
      <header className="yw-feature-head">
        <button className="yw-fold" aria-expanded={!folded} onClick={onFold} title={folded ? "Show its work" : "Fold it away"}>
          <span className="yw-chev" aria-hidden>
            {folded ? "▸" : "▾"}
          </span>
          <h3>{group.label}</h3>
        </button>
        <WorkDots counts={counts} />
        {(group.doing > 0 || group.todo > 0) && (
          <span className="yw-feature-sum">{[group.doing > 0 && `${group.doing} doing`, group.todo > 0 && `${group.todo} to start`].filter(Boolean).join(" · ")}</span>
        )}
      </header>
      {!folded && (
        <>
          <ul className="dp-list">
            {shown.map((i) => (
              <StandRow key={i.key} item={i} issues={issues} feature={group.plain ? null : group.label} />
            ))}
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

const GROUPS: { by: GroupBy; label: string }[] = [
  { by: "feature", label: "Feature" },
  { by: "project", label: "Project" },
  { by: "none", label: "None" },
];

/** What groups the list, and which states it shows: a switch for the grouping, a chip for each state in the list. */
function Bar({ by, issues, onBy, counts, only, onOnly }: { by: GroupBy; issues: boolean; onBy: (b: GroupBy) => void; counts: Partial<Record<Tone, number>>; only: Tone[]; onOnly: (t: Tone[]) => void }) {
  const tones = FILTER_TONES.filter((t) => counts[t]);
  return (
    <div className="yw-bar">
      <div className="yw-group" role="radiogroup" aria-label="Group by">
        <span className="yw-bar-label">Group by</span>
        {GROUPS.map((g) => {
          const off = g.by === "feature" && !issues;
          return (
            <button key={g.by} role="radio" aria-checked={by === g.by} disabled={off} className={by === g.by ? "on" : ""} onClick={() => onBy(g.by)} title={off ? "Connect Linear in Settings to group by feature" : g.by === "feature" ? "A feature is the Linear project an issue is in; a pull request joins it by its issue's link or its branch name" : undefined}>
              {g.label}
            </button>
          );
        })}
      </div>
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
export function YourWork({ repos, items, issues, chats, onStep, onRefresh }: YourWorkProps) {
  const [all, setAll] = useState(false);
  const [allNext, setAllNext] = useState(false);
  const [chosen, setChosen] = usePersistentState<GroupBy | "auto">("desk.work.groupBy", "auto");
  const [only, setOnly] = useState<Tone[]>([]);
  const [folded, setFolded] = useState<string[]>([]);
  if (!repos || repos.length === 0) return null;
  const next = nextSteps(items);
  const nextShown = allNext ? next : next.slice(0, SHOWN_NEXT);
  // Without Linear there are no features: the default is the projects, the next best way to tell the work apart.
  const by: GroupBy = chosen === "auto" ? (issues ? "feature" : "project") : chosen === "feature" && !issues ? "project" : chosen;
  const listed = items.filter((i) => !i.stepOnly);
  const groups = groupWork(filterWork(items, only), by);
  // One group, or the work in no feature, needs no heading: it is a list.
  const flat = by === "none" || (groups.length === 1 && (by === "project" || groups[0].plain));
  const stand = flat ? (groups[0]?.items ?? []) : [];
  const shown = all ? stand : stand.slice(0, SHOWN);
  const more = stand.length - shown.length;
  const blind = unknownViewer(repos);
  const toggle = (key: string) => setFolded((f) => (f.includes(key) ? f.filter((k) => k !== key) : [...f, key]));
  return (
    <>
      <Card
        title="Next"
        count={next.length}
        heading="h2"
        className="yw-card yw-next"
        action={
          <button className="desk-more" onClick={onRefresh} title={issues ? "Ask git, GitHub and Linear again" : "Ask git and GitHub again"}>
            Refresh
          </button>
        }
      >
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
                <li key={i.key} className={`dp-row yw-tone-${i.tone}`}>
                  <Row
                    title={
                      <>
                        <span className="yw-dot" aria-hidden />
                        {i.next!.what} <Named item={i} />
                      </>
                    }
                    aside={
                      <>
                        {i.next!.yours && <span className="yw-word">Your call</span>}
                        <StepButton item={i} chats={chats} repos={repos} onStep={onStep} />
                      </>
                    }
                    meta={`${i.word} · ${i.meta}`}
                  />
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
      </Card>
      {items.length > 0 && (
        <Card title="Where things stand" count={listed.length} heading="h2" className="yw-card yw-stand">
          <Bar by={by} issues={issues} onBy={setChosen} counts={stateCounts(items)} only={only} onOnly={setOnly} />
          {groups.length === 0 ? (
            <p className="dp-note">Nothing is {only.map((t) => TONE_WORD[t]).join(" or ")}.</p>
          ) : flat ? (
            <>
              <ul className="dp-list">
                {shown.map((i) => (
                  <StandRow key={i.key} item={i} issues={issues} />
                ))}
              </ul>
              {more > 0 && (
                <button className="desk-more dp-foot" onClick={() => setAll(true)}>
                  Show {more} more
                </button>
              )}
            </>
          ) : (
            groups.map((g) => <Group key={`${by}:${g.key}`} group={g} issues={issues} folded={folded.includes(`${by}:${g.key}`)} onFold={() => toggle(`${by}:${g.key}`)} />)
          )}
        </Card>
      )}
    </>
  );
}

/** A project's work in a line on its tile: a coloured dot and a count for each state, blocked first. */
export function WorkDots({ counts }: { counts: Partial<Record<WorkItem["tone"], number>> }) {
  const order: WorkItem["tone"][] = ["bad", "you", "wait", "local", "todo"];
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
