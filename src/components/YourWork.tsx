import { useState } from "react";
import type { InboxRow } from "../lib/deskBoard";
import { nextSteps, STAGES, targetFor, TONE_WORD, unknownViewer, whereThingsStand, yourWork, type Target, type WorkItem } from "../lib/yourWork";
import type { RepoStatus } from "../types";
import { Card, Row } from "./DeskCard";
import { ExternalLink } from "./ExternalLink";

export interface YourWorkProps {
  repos: RepoStatus[] | null;
  /** Every chat on the Desk: a step goes to the one on its branch. */
  chats: InboxRow[];
  now: number;
  /** Sends a step: to a chat, or to a new chat in a folder; false when it couldn't (no agent CLI ready). */
  onStep: (item: WorkItem, target: Target) => boolean;
  /** Asks git and GitHub again now. */
  onRefresh: () => void;
}

/** The rows of "Where things stand" shown before "Show N more". */
const SHOWN = 8;

/** Steps sent, by item, with the state the item was in: marked as sent until it moves on (kept while the window is open, so
 * leaving the Desk and coming back doesn't offer the same step again). */
const sent = new Map<string, { sig: string; to: string }>();

/** Its path, a node a stage: green behind it, ringed in its state's colour where it is, grey ahead. */
function Nodes({ item }: { item: WorkItem }) {
  const at = STAGES.findIndex((s) => s.stage === item.stage);
  const done = item.tone === "done";
  return (
    <ol className="yw-nodes" aria-label={`At ${STAGES[at].label}, ${TONE_WORD[item.tone]}`}>
      {STAGES.map((s, i) => (
        <li key={s.stage} className={`yw-node${i < at || (done && i === at) ? " yw-past" : i === at ? " yw-now" : ""}`} aria-current={i === at ? "step" : undefined}>
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

/** Its number (a link to GitHub) and its title, or only its title. */
function Named({ item }: { item: WorkItem }) {
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

/**
 * Your work in the Desk's repositories: what to do next on top (yours to decide first, then what is blocked, then branches to
 * push), and under it where each piece stands, from a branch never pushed to a release, as a row of nodes. Every state is what git
 * and gh said (status.rs); a step goes to a chat only when you click it.
 */
export function YourWork({ repos, chats, now, onStep, onRefresh }: YourWorkProps) {
  const [all, setAll] = useState(false);
  if (!repos || repos.length === 0) return null;
  const items = yourWork(repos, now);
  const next = nextSteps(items);
  const stand = whereThingsStand(items);
  const shown = all ? stand : stand.slice(0, SHOWN);
  const more = stand.length - shown.length;
  const blind = unknownViewer(repos);
  return (
    <Card
      title="Your work"
      count={next.length}
      heading="h2"
      className="yw-card"
      action={
        <button className="desk-more" onClick={onRefresh} title="Ask git and GitHub again">
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
        <p className="dp-note">Nothing open: no pull requests of yours, nothing waiting to be released, no branches left unpushed.</p>
      ) : (
        <>
          {next.length > 0 && (
            <section aria-label="Next">
              <h3 className="yw-sub">Next</h3>
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
            </section>
          )}
          <section aria-label="Where things stand">
            <h3 className="yw-sub">Where things stand</h3>
            <ul className="dp-list">
              {shown.map((i) => (
                <li key={i.key} className={`dp-row yw-tone-${i.tone}`}>
                  <Row
                    title={
                      <Named item={i} />
                    }
                    aside={<span className="yw-word">{i.word}</span>}
                    meta={i.meta}
                  />
                  <Nodes item={i} />
                </li>
              ))}
            </ul>
          </section>
          {more > 0 && (
            <button className="desk-more dp-foot" onClick={() => setAll(true)}>
              Show {more} more
            </button>
          )}
        </>
      )}
    </Card>
  );
}

/** A project's work in a line on its tile: a coloured dot and a count for each state, blocked first. */
export function WorkDots({ counts }: { counts: Partial<Record<WorkItem["tone"], number>> }) {
  const order: WorkItem["tone"][] = ["bad", "you", "wait", "local"];
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
