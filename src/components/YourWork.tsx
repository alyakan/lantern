import { useState } from "react";
import type { InboxRow } from "../lib/deskBoard";
import { byFeature, nextSteps, STAGES, targetFor, toneCounts, TONE_WORD, unknownViewer, type FeatureGroup, type Target, type WorkItem } from "../lib/yourWork";
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

/** The rows of "Where things stand" shown before "Show N more": all of it in one list, or each feature's. */
const SHOWN = 8;
const SHOWN_IN_FEATURE = 4;

/** Steps sent, by item, with the state the item was in: marked as sent until it moves on (kept while the window is open, so
 * leaving the Desk and coming back doesn't offer the same step again). */
const sent = new Map<string, { sig: string; to: string }>();

/** Forgets every step sent (for tests: each starts with none). */
export const forgetSent = () => sent.clear();

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
        <li key={s.stage} className={`yw-node${mark(s.stage, i)}`} aria-current={i === at ? "step" : undefined} title={s.stage === "issue" && i < at && !item.issue ? "No Linear issue" : undefined}>
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
  const was = sent.get(item.key);
  if (was && was.sig === item.sig) return <span className="yw-sent">Sent to {was.to}</span>;
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
        sent.set(item.key, { sig: item.sig, to: target.kind === "chat" ? `"${target.title}"` : "a new chat" });
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

/** A feature's work: its name, a dot and a count for each state, how many issues are in work and to start, then its rows. */
function Feature({ group, issues }: { group: FeatureGroup; issues: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? group.items : group.items.slice(0, SHOWN_IN_FEATURE);
  const more = group.items.length - shown.length;
  const name = group.feature ?? "No feature";
  const counts = toneCounts(group.items.map((i) => ({ ...i, repo: "" })), "");
  return (
    <section className="yw-feature" aria-label={name}>
      <header className="yw-feature-head">
        <h3>{name}</h3>
        <WorkDots counts={counts} />
        {(group.doing > 0 || group.todo > 0) && (
          <span className="yw-feature-sum">{[group.doing > 0 && `${group.doing} doing`, group.todo > 0 && `${group.todo} to start`].filter(Boolean).join(" · ")}</span>
        )}
      </header>
      <ul className="dp-list">
        {shown.map((i) => (
          <StandRow key={i.key} item={i} issues={issues} feature={group.feature} />
        ))}
      </ul>
      {more > 0 && (
        <button className="desk-more dp-foot" onClick={() => setAll(true)}>
          Show {more} more
        </button>
      )}
    </section>
  );
}

/**
 * Your work in the Desk's repositories, as two cards: Next, what to do now (yours to decide first, then what is blocked, then
 * branches to push and issues to start), set apart; and Where things stand, each piece from its issue or branch to its release
 * as a row of nodes, a group per feature (its Linear project) when Linear is connected. Every state is what git, gh and Linear
 * said; a step goes to a chat only when you click it.
 */
export function YourWork({ repos, items, issues, chats, onStep, onRefresh }: YourWorkProps) {
  const [all, setAll] = useState(false);
  if (!repos || repos.length === 0) return null;
  const next = nextSteps(items);
  const groups = byFeature(items);
  const flat = groups.length === 1 && groups[0].feature === null;
  const stand = flat ? groups[0].items : [];
  const shown = all ? stand : stand.slice(0, SHOWN);
  const more = stand.length - shown.length;
  const blind = unknownViewer(repos);
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
          <ul className="dp-list">
            {next.map((i) => (
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
        )}
      </Card>
      {items.length > 0 && (
        <Card title="Where things stand" count={items.filter((i) => !i.stepOnly).length} heading="h2" className="yw-card yw-stand">
          {flat ? (
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
            groups.map((g) => <Feature key={g.feature ?? ""} group={g} issues={issues} />)
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
