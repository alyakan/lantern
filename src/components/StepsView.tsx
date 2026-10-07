import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Md } from "./Md";
import { AWAY_FROM_END, JumpToLatest } from "./JumpToLatest";
import { useSlot } from "../lib/slot";
import { FLAVOUR_LABEL, FLAVOURS, type Flavour } from "../lib/flavour";
import { FlavourBadge } from "./FlavourBadge";
import { FLAVOUR_ICON } from "./ModeGuide";
import { recallScroll, rememberScroll } from "../lib/scrollMemory";
import { messageTime } from "../lib/time";
import { initials, useUserName } from "../lib/userName";
import type { State } from "../store";
import { isApproval, movesOn, pageLabel, pagesOf, pageTitle, promptText, startedFlavour, startText, stayedIn, stayText, type StepPage, type StepTurn } from "../lib/steps";
import { mattersToTask } from "../lib/commands";
import type { BackgroundRun, ChatItem, ToolItem } from "../store";
import { workingVerb } from "../lib/verbs";
import { ChatStream, type StreamHandlers } from "./ChatStream";
import { isVerdictNext, parseReviewFile, splitFileTitle, verdictMessage, withoutCue, type ReviewFile, type Verdict } from "../lib/review";
import { ReviewFileHeader, ReviewFileView, ReviewSummaryTable, type ReviewedFinding } from "./ReviewPages";

/** What "Update the step with this" sends. */
export const UPDATE_STEP = "Update the step with this: write the whole step again under its heading, in the same format as before, with what we just discussed worked in and everything else kept.";

/** A plain move-on prompt: "Next", a Next carrying review verdicts, an answer to a suggestion; nothing to show as "You asked". */
const justMovesOn = (text: string) => isApproval(text) || isVerdictNext(text) || startedFlavour(text) !== null || stayedIn(text);

/** A Review file page's parts, if its message has the skill's sections. */
function reviewOf(page: StepPage): ReviewFile | null {
  if (page.heading?.kind !== "file") return null;
  const main = page.turns[page.main];
  const msg = main.items.find((it) => it.id === main.messageId);
  return msg?.type === "assistant" ? parseReviewFile(page.heading.title, msg.text) : null;
}

interface Props extends StreamHandlers {
  state: State;
  /** Approve the page on screen and move on: sends "Next", or the message given (a Next with review verdicts). */
  onNext: (message?: string) => void;
  /** Sends a message as if typed (the review summary's actions). */
  onSend?: (text: string) => void;
  /** The flavour Step by step is in (one picked and not yet sent included); null before one is chosen. */
  flavour: Flavour | null;
  /** Pick a flavour from the header's badge: Claude is told with the next message. */
  onPickFlavour: (flavour: Flavour) => void;
  /** Claude Code's auto mode approves actions instead of the app asking; each step is still reviewed as a page. */
  autoApprove?: boolean;
  onAutoApprove?: (on: boolean) => void;
  /** The page on screen changed: the turns whose changes the Changes pane should show (null: not all known). */
  onPage: (range: { from: number; to: number } | null) => void;
  /** Review: the file of the page that's on screen, so the Changes pane can show it. */
  onReviewFile?: (path: string) => void;
}

const isTyping = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

// Step-by-step mode's view of the conversation: a page per step, side by side, one on screen. Questions about a step
// and changes to it stay on its page; Previous and Next (or ← →) slide between pages, and on the newest page Next
// approves the step and Claude carries on.
export function StepsView({ state, flavour, onNext, onSend, onPickFlavour, onPage, onReviewFile, autoApprove = false, onAutoApprove, ...handlers }: Props) {
  // A revision you undid: the page shows the version you went back to, until Claude revises the step again.
  const [kept, setKept] = useState<Record<string, { turn: number; over: number }>>({});
  const claudes = pagesOf(state.items);
  const latestOf = new Map(claudes.map((p) => [p.key, p.main]));
  const pages = claudes.map((p) => {
    const k = kept[p.key];
    return k && k.over === p.main ? { ...p, main: k.turn, heading: p.turns[k.turn].heading ?? p.heading } : p;
  });
  const [index, setIndex] = useState(Math.max(pages.length - 1, 0));
  const last = pages.length - 1;
  const at = Math.min(index, last);
  const running = state.status === "running";
  const waiting = state.items.some((it) => it.type === "permission" && it.decision === null);

  // A new page comes into view if you were on the newest one.
  const seen = useRef(pages.length);
  // The chat box grows as you type, which makes the page shorter from the bottom: scroll it by as much, so the lines
  // you were reading at the bottom stay in view instead of ending up under the box.
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const shrunk = height - el.clientHeight;
      height = el.clientHeight;
      const page = el.querySelector<HTMLElement>('.step-page[aria-hidden="false"]');
      if (page && shrunk) page.scrollTop += shrunk;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (pages.length > seen.current && at === seen.current - 1) setIndex(pages.length - 1);
    seen.current = pages.length;
  }, [pages.length]);

  // Where the slide has come to rest. The Changes pane (a fetch, a diff editor mounting) and the next neighbouring
  // page wait for it, so their work doesn't land mid-slide.
  const [settled, setSettled] = useState(at);
  useEffect(() => {
    if (settled === at) return;
    const done = setTimeout(() => setSettled(at), 400);
    return () => clearTimeout(done);
  }, [at]);
  const page = pages[at];
  const restingPage = pages[Math.min(settled, last)];
  const range = restingPage?.range ?? null;
  useEffect(() => onPage(range), [restingPage?.key, range?.from, range?.to]);
  const restingFile = restingPage?.heading?.kind === "file" ? splitFileTitle(restingPage.heading.title).path : null;
  useEffect(() => {
    if (restingFile) onReviewFile?.(restingFile);
  }, [restingFile]);

  const go = (i: number) => setIndex(Math.max(0, Math.min(last, i)));
  // Moving to a page (Next, Previous, arrows, a new step coming in) starts at its top. Not when the view is drawn
  // (switching back to this chat): then each page is where you left it.
  const slot = useSlot();
  // On the page on screen: scrolled into it and away from its end (a long step, a long discussion).
  const [pageAway, setPageAway] = useState(false);
  useEffect(() => setPageAway(false), [at]);
  const jumpToEnd = () => {
    const el = viewport.current?.querySelectorAll<HTMLElement>(".step-page")[at];
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  const shownAt = useRef(at);
  useEffect(() => {
    // Only a change of page counts (an effect can run twice without one, as React does in development).
    if (shownAt.current === at) return;
    shownAt.current = at;
    const target = viewport.current?.querySelectorAll<HTMLElement>(".step-page")[at];
    if (target) target.scrollTop = 0;
  }, [at]);
  useLayoutEffect(() => {
    viewport.current?.querySelectorAll<HTMLElement>(".step-page").forEach((el) => {
      const top = el.dataset.key ? recallScroll(`${slot}:${el.dataset.key}`) : undefined;
      if (top !== undefined) el.scrollTop = top;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement) || document.activeElement?.closest(".monaco-editor")) return;
      if (e.key === "ArrowLeft") go(at - 1);
      if (e.key === "ArrowRight") go(at + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, last]);

  const heading = page?.heading;
  const review = flavour === "review";
  const newest = at === last;
  const teach = flavour === "learn";
  // Review: whether a file has come yet, so Next opens the first one or the next.
  const filesSoFar = review && pages.slice(0, at + 1).some((p) => p.heading?.kind === "file");

  // Review verdicts, per page and finding; the page's Next carries them.
  const [verdicts, setVerdicts] = useState<Record<string, Record<number, Verdict>>>({});
  const setVerdict = (pageKey: string, index: number, v: Verdict | null) =>
    setVerdicts((all) => {
      const page = { ...all[pageKey] };
      if (v) page[index] = v;
      else delete page[index];
      return { ...all, [pageKey]: page };
    });
  const currentReview = page ? reviewOf(page) : null;
  const next = () => {
    const message = currentReview ? verdictMessage(currentReview.findings, verdicts[page.key]) : "Next";
    onNext(message === "Next." ? "Next" : message);
  };
  // Every finding across the reviewed files, for the summary page.
  const reviewed: ReviewedFinding[] = review
    ? pages.flatMap((p) => {
        const r = reviewOf(p);
        return r ? r.findings.map((f) => ({ path: r.path, finding: f, verdict: verdicts[p.key]?.[f.index] })) : [];
      })
    : [];

  return (
    <div className="steps">
      <div className="steps-head">
        <div className="steps-rail" role="tablist" aria-label="Pages">
          {pages.map((p, i) => (
            <button key={p.key} role="tab" aria-selected={i === at} aria-label={`${pageLabel(p.heading)}${pageTitle(p) ? `: ${pageTitle(p)}` : ""}`} title={`${pageLabel(p.heading)}${pageTitle(p) ? ` — ${pageTitle(p)}` : ""}`} className={`steps-dot${i === at ? " current" : ""}${p.heading?.kind === "step" || p.heading?.kind === "done" || p.heading?.kind === "file" || p.heading?.kind === "fix" ? " build" : ""}${p.heading?.kind === "switch" ? " switch" : ""}`} onClick={() => go(i)} />
          ))}
        </div>
        {state.backgroundTasks.length > 0 && (
          <span className="steps-background" title={`Still running in the background:\n${state.backgroundTasks.map((t) => t.description).join("\n")}`}>
            <span className="spinner" aria-hidden />
            {state.backgroundTasks.length} in background
          </span>
        )}
        <div className="spacer" />
        <FlavourBadge flavour={flavour} onPick={onPickFlavour} disabled={running} />
        {onAutoApprove && (
          <button className={`steps-auto${autoApprove ? " on" : ""}`} role="switch" aria-checked={autoApprove} disabled={running} title={autoApprove ? "Auto-approve is on: Claude Code's auto mode approves routine actions and stops risky ones. Click to be asked instead." : "Commands and other actions ask you first. Click to auto-approve them (you still review every step)."} onClick={() => onAutoApprove(!autoApprove)}>
            <span className="steps-auto-knob" aria-hidden />
            Auto-approve
          </button>
        )}
      </div>

      <div className="steps-viewport" ref={viewport}>
        <div className="steps-track" style={{ transform: `translate3d(${-at * 100}%, 0, 0)` }} onTransitionEnd={(e) => e.target === e.currentTarget && setSettled(at)}>
          {pages.map((p, i) => (
            <section
              key={p.key}
              className="step-page"
              data-key={p.key}
              aria-hidden={i !== at}
              inert={i !== at}
              onScroll={(e) => {
                const el = e.currentTarget;
                rememberScroll(`${slot}:${p.key}`, el.scrollTop);
                if (i === at) setPageAway(el.scrollTop > 0 && el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_FROM_END);
              }}
            >
              {/* Only the pages near the one on screen are drawn; the rest keep their place. */}
              {(Math.abs(i - at) <= 1 || Math.abs(i - settled) <= 1) && <Page
                  page={p}
                  first={i === 0}
                  live={i === last && running}
                  teach={teach}
                  review={review}
                  suggestion={p.heading?.kind === "switch" ? { current: flavour, answer: pages[i + 1]?.turns[0].prompt.text ?? null, onAnswer: i === last && !running && onSend ? onSend : undefined } : null}
                  verdicts={verdicts[p.key]}
                  onVerdict={i === last && !running ? (index, v) => setVerdict(p.key, index, v) : undefined}
                  summary={p.heading?.kind === "summary" && onSend ? { rows: reviewed, onAction: onSend } : null}
                  folder={state.folder}
                  runs={state.backgroundRuns}
                  latest={latestOf.get(p.key) ?? p.main}
                  onUpdate={i === last && !running && onSend ? () => onSend(UPDATE_STEP) : undefined}
                  onKeep={(turn, over) => setKept((all) => ({ ...all, [p.key]: { turn, over } }))}
                  {...handlers}
                />}
            </section>
          ))}
        </div>
        <JumpToLatest show={pageAway} onJump={jumpToEnd} label="Bottom" />
      </div>

      <div className="steps-nav">
        <button className="ghost" disabled={at === 0} onClick={() => go(at - 1)}>
          ← Previous
        </button>
        <span className="steps-count">
          {at + 1} / {pages.length}
        </span>
        {newest ? (
          running ? (
            <span className="steps-working activity live">
              <span className="activity-line">
                <span className="spinner" aria-hidden />
                <span className="activity-text">{workingVerb(page?.key ?? "start")}</span>
              </span>
            </span>
          ) : heading?.kind === "switch" ? (
            // The suggestion's card has the answers.
            <span className="steps-hint">Start it, or pick another</span>
          ) : (
            <button className="primary" disabled={waiting || heading?.kind === "done" || heading?.kind === "summary"} title={review ? "Send your verdicts and go on to the next file" : "Approve this page and go on to the next"} onClick={next}>
              {heading?.kind === "done" || heading?.kind === "summary" ? "Done" : review ? (heading?.kind === "file" && heading.n === heading.total ? "Summary →" : filesSoFar ? "Next file →" : "First file →") : flavour === "debug" ? "Next →" : "Next step →"}
            </button>
          )
        ) : (
          <button className="ghost" onClick={() => go(at + 1)}>
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

interface PageProps extends StreamHandlers {
  page: StepPage;
  first: boolean;
  live: boolean;
  teach: boolean;
  review: boolean;
  /**
   * A switch page: the flavour the chat was in, how you answered (the next page's opening prompt), and how to answer
   * (only on the newest page, when idle).
   */
  suggestion?: { current: Flavour | null; answer: string | null; onAnswer?: (text: string) => void } | null;
  /** Review: your verdicts on this page's findings, and how to set one (only on the newest page, when idle). */
  verdicts?: Record<number, Verdict>;
  onVerdict?: (index: number, v: Verdict | null) => void;
  /** Review's summary page: every finding with its verdict, and the actions after the review. */
  summary?: { rows: ReviewedFinding[]; onAction: (text: string) => void } | null;
  folder: string | null;
  /** Which turn holds Claude's latest version of the step, whichever one the page shows. */
  latest: number;
  /** Steps that started background tasks: running, or how they ended. */
  runs: Record<string, BackgroundRun>;
  /** Show `turn`'s version of the step instead of the latest (`over`), or go back to the latest. */
  onKeep: (turn: number, over: number) => void;
  /** Ask Claude to work what was just discussed into the step (only on the newest page, while idle). */
  onUpdate?: () => void;
}

function Page({ page, first, live, teach, review, suggestion, verdicts, onVerdict, summary, folder, latest, runs, onKeep, onUpdate, ...handlers }: PageProps) {
  const h = page.heading;
  const opening = page.turns[0];
  const asked = opening.prompt.auto ? null : first ? opening.prompt.text : justMovesOn(opening.prompt.text) ? null : promptText(opening.prompt.text);
  const main = page.turns[page.main];
  const reviewFile = reviewOf(page);
  // Review pages: the file's parts are laid out below, and a closing "Say Next…" is dropped (the buttons say it).
  const mainItems = main.items
    .filter((it) => !(reviewFile && it.id === main.messageId))
    .map((it) => (review && it.type === "assistant" && it.id === main.messageId ? { ...it, text: withoutCue(it.text) } : it));

  // While Claude answers in the discussion, follow the end of it if you're there; a new step is read from its top.
  const root = useRef<HTMLDivElement>(null);
  const turnCount = page.turns.length;
  // Latches off the moment you scroll up from the end, so reading back through a step doesn't fight the stream pulling
  // you down; scroll back to the end and following resumes.
  const nearEnd = useRef(true);
  const lastTop = useRef(0);
  useEffect(() => {
    const el = root.current?.closest(".step-page");
    if (!el) return;
    const onScroll = () => {
      // Any scroll up, however small, means you're reading back: stop following. Reaching the end turns it on again.
      // (A distance-only check leaves a band near the end where a soft scroll is snapped back before it can get clear;
      // the auto-snap only ever scrolls down, so it never reads as a scroll up.)
      if (el.scrollTop < lastTop.current - 1) nearEnd.current = false;
      else if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) nearEnd.current = true;
      lastTop.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = root.current?.closest(".step-page");
    if (!el || !live || turnCount < 2 || !nearEnd.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  });
  // And once the answer is done, what comes under it (Update the step with this) is followed too.
  const wasLive = useRef(live);
  useEffect(() => {
    const el = root.current?.closest(".step-page");
    if (wasLive.current && !live && el && turnCount > 1 && nearEnd.current && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
    wasLive.current = live;
  }, [live]);
  // Something new sent in the discussion: show it, and follow its reply from here. (Not when the page is first drawn:
  // that starts at the top.)
  const counted = useRef(turnCount);
  useEffect(() => {
    const el = root.current?.closest(".step-page");
    if (el && turnCount > counted.current) {
      nearEnd.current = true;
      el.scrollTop = el.scrollHeight;
    }
    counted.current = turnCount;
  }, [turnCount]);

  return (
    <div ref={root} className={`step-page-body${teach ? " teach" : ""}`}>
      <div className="step-eyebrow">{pageLabel(h)}</div>
      <h1 className="step-title">{reviewFile?.path ? <ReviewFileHeader path={reviewFile.path} added={reviewFile.added} removed={reviewFile.removed} /> : h?.kind === "switch" && h.flavour ? `${FLAVOUR_LABEL[h.flavour]}?` : pageTitle(page) || (live ? "Working…" : "Untitled step")}</h1>
      {asked && <UserMessage className="step-asked" text={asked} at={opening.prompt.at} tag={first ? "Task" : movesOn(opening.prompt.text) ? "Then moved on" : null} />}
      <div className="step-content">
        <ChatStream items={mainItems} folder={folder} live={live && page.main === page.turns.length - 1} {...handlers} />
        {reviewFile && <ReviewFileView file={reviewFile} verdicts={verdicts} onVerdict={onVerdict} />}
        {h?.kind === "switch" && h.flavour && suggestion && <SuggestionCard flavour={h.flavour} why={h.title} {...suggestion} />}
        {summary && <ReviewSummaryTable rows={summary.rows} onAction={summary.onAction} />}
      </div>
      <StepCommands page={page} runs={runs} />
      {page.turns.length > 1 && (
        <div className="step-thread" aria-label="Discussion">
          <div className="step-discussion-divider" role="separator">
            <span>Discussion</span>
          </div>
          {page.turns.slice(1).map((t, j) => {
            const i = j + 1;
            // The version before this one: the latest earlier turn that wrote the step.
            const before = page.turns.slice(0, i).map((x) => !!x.heading).lastIndexOf(true);
            return (
              <ThreadEntry
                key={t.prompt.id}
                turn={t}
                previous={before >= 0 ? page.turns[before] : page.turns[0]}
                role={i === page.main ? "shown" : t.answer ? "answer" : !t.heading ? "reply" : i === latest ? "undone" : i < page.main ? "earlier" : "later"}
                onUndo={() => onKeep(before >= 0 ? before : 0, latest)}
                onRestore={() => onKeep(i, latest)}
                onUpdate={i === page.turns.length - 1 ? onUpdate : undefined}
                live={live && i === page.turns.length - 1}
                folder={folder}
                {...handlers}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Claude's suggestion to work in a flavour: start it, stay in the one you're in, or start another. Once answered, it
 * says how.
 */
function SuggestionCard({ flavour, why, current, answer, onAnswer }: { flavour: Flavour; why: string; current: Flavour | null; answer: string | null; onAnswer?: (text: string) => void }) {
  const label = FLAVOUR_LABEL[flavour];
  const started = answer === null ? null : startedFlavour(answer) ?? (isApproval(answer) ? flavour : null);
  const outcome = answer === null ? null : started ? `You started ${FLAVOUR_LABEL[started]}` : stayedIn(answer) ? "You kept going as before" : "You answered in the chat";
  return (
    <div className={`suggestion${outcome ? " answered" : ""}`} role="group" aria-label={`Claude suggests ${label}`}>
      <div className="suggestion-head">
        <span className="suggestion-icon">{FLAVOUR_ICON[flavour]}</span>
        <span>
          Claude suggests <strong>{label}</strong>
        </span>
      </div>
      {why && <p className="suggestion-why">{why}</p>}
      {outcome ? (
        <div className="suggestion-outcome">{outcome}</div>
      ) : (
        onAnswer && (
          <div className="suggestion-actions">
            <button className="primary" onClick={() => onAnswer(startText(label))}>
              Start {label}
            </button>
            {current && current !== flavour && <button onClick={() => onAnswer(stayText(FLAVOUR_LABEL[current]))}>Stay in {FLAVOUR_LABEL[current]}</button>}
            <span className="suggestion-others">
              or
              {FLAVOURS.filter((f) => f !== flavour && f !== current).map((f) => (
                <button key={f} className="link-button" onClick={() => onAnswer(startText(FLAVOUR_LABEL[f]))}>
                  {FLAVOUR_LABEL[f]}
                </button>
              ))}
            </span>
          </div>
        )
      )}
    </div>
  );
}

/** Something you sent, with your name and when; `tag` says what it was to the page ("Task"). */
function UserMessage({ text, at, tag = null, className }: { text: string; at?: number; tag?: string | null; className: string }) {
  const name = useUserName();
  return (
    <div className={`user-note ${className}`}>
      <div className="user-note-head">
        <span className="user-avatar" aria-hidden>
          {name ? initials(name) : "·"}
        </span>
        <span className="user-note-name">{name ?? "You"}</span>
        {at !== undefined && (
          <time className="user-note-time" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
            {messageTime(at)}
          </time>
        )}
        {tag && <span className="user-note-tag">{tag}</span>}
      </div>
      <div className="user-note-body">
        <Md>{text}</Md>
      </div>
    </div>
  );
}

/**
 * A turn in the discussion under the step: what you sent, then what came back. An answer is shown as it is. A
 * revision of the step went up into the page, so here it's a note, with the version before it and a way back:
 *  - shown: the page shows this revision (Show previous, Undo)
 *  - undone: Claude's latest revision, which you undid (Use this version)
 *  - earlier / later: a revision the page doesn't show, folded
 *  - answer: an answer to a question that repeated the step's heading; shown as a reply, and can become the step
 */
type EntryRole = "reply" | "answer" | "shown" | "undone" | "earlier" | "later";

function ThreadEntry({ turn, previous, role, onUndo, onRestore, onUpdate, live, folder, ...handlers }: { turn: StepTurn; previous: StepTurn; role: EntryRole; onUndo: () => void; onRestore: () => void; onUpdate?: () => void; live: boolean; folder: string | null } & StreamHandlers) {
  const auto = !!turn.prompt.auto;
  const asked = !auto && !justMovesOn(turn.prompt.text) ? promptText(turn.prompt.text) : null;
  const question = asked === UPDATE_STEP ? "Update the step with this" : asked;
  let reply: ReactNode;
  // After Claude's latest answer: work it into the step (Claude rewrites the step in full, the change included).
  const update = onUpdate && !live && (role === "reply" || role === "answer") && (
    <button className="step-update" onClick={onUpdate} title="Ask Claude to write the step again with what you discussed worked in">
      Update the step with this
    </button>
  );
  if (role === "reply")
    reply = (
      <>
        <ChatStream items={turn.items} folder={folder} live={live} {...handlers} />
        {update}
      </>
    );
  else if (role === "answer")
    reply = (
      <>
        <ChatStream items={turn.items} folder={folder} live={live} {...handlers} />
        {!live && (
          <div className="step-thread-note">
            {update}
            <button className="link-button" onClick={onRestore} title="This was a rewrite of the step: show it as the step">
              Use this as the step
            </button>
          </div>
        )}
      </>
    );
  else if (role === "shown")
    reply = (
      <div className="step-revision">
        <div className="step-thread-note">
          Updated the step above
          {!live && (
            <button className="link-button" onClick={onUndo} title="Show the step as it was before this">
              Undo
            </button>
          )}
        </div>
        <Earlier turn={previous} label="Show previous version" folder={folder} {...handlers} />
      </div>
    );
  else
    reply = (
      <div className="step-revision">
        <div className="step-thread-note">
          {role === "undone" ? "An update you undid" : "Another version of the step"}
          <button className="link-button" onClick={onRestore} title="Show this version as the step">
            Use this version
          </button>
        </div>
        <Earlier turn={turn} label="Show it" folder={folder} {...handlers} />
      </div>
    );
  if (!question && !reply && !auto) return null;
  return (
    <div className="step-thread-entry">
      {auto && (
        <div className="auto-turn" role="note">
          <span className="auto-turn-dot" aria-hidden />
          {turn.prompt.text}
          {turn.prompt.at !== undefined && <span className="auto-turn-time">{messageTime(turn.prompt.at)}</span>}
        </div>
      )}
      {question && <UserMessage className="step-thread-question" text={question} at={turn.prompt.at} />}
      {reply}
    </div>
  );
}

function Earlier({ turn, label, folder, ...handlers }: { turn: StepTurn; label: string; folder: string | null } & StreamHandlers) {
  const [open, setOpen] = useState(false);
  return (
    <div className="step-earlier">
      <button className="activity-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden />
        <span className="activity-text">{label}</span>
      </button>
      {open && (
        <div className="step-earlier-body">
          <ChatStream items={turn.items} folder={folder} {...handlers} />
        </div>
      )}
    </div>
  );
}

/** Every Bash step in `items`, subagents' included, in order. */
function bashSteps(items: ChatItem[]): ToolItem[] {
  return items.flatMap((it) => (it.type === "tool" ? [...(it.name === "Bash" ? [it] : []), ...bashSteps(it.children)] : []));
}

// The commands this step ran that change or check the project (installs, builds, tests, migrations…), leaving out
// looking around (cd, ls, cat, git status…). Each opens to its output.
function StepCommands({ page, runs }: { page: StepPage; runs: Record<string, BackgroundRun> }) {
  const commands = page.turns.flatMap((t) => bashSteps(t.items)).filter((c) => mattersToTask(c.summary));
  if (!commands.length) return null;
  return (
    <section className="step-commands" aria-label="Commands">
      <div className="step-commands-heading">Commands</div>
      {commands.map((c) => (
        <StepCommand key={c.id} command={c} run={runs[c.id]} />
      ))}
    </section>
  );
}

/**
 * A command the step ran. One started in the background returns at once, so its own status says nothing about how
 * the work went: it shows as running in the background, then how it ended, from claude's notification.
 */
function StepCommand({ command, run }: { command: ToolItem; run?: BackgroundRun }) {
  const [open, setOpen] = useState(false);
  const status = !run ? command.status : run.status === "running" ? "running" : run.status === "completed" ? "done" : "error";
  return (
    <div className={`step-command ${status}${run ? " background" : ""}`}>
      <button className="step-command-line" aria-expanded={open} disabled={!command.output} onClick={() => setOpen(!open)} title={run?.summary}>
        <span className="step-command-status" aria-label={status === "error" ? "failed" : status === "running" ? "running" : "done"}>
          {status === "running" ? <span className="spinner" aria-hidden /> : status === "error" ? "✕" : "✓"}
        </span>
        <code className="step-command-text">{command.summary}</code>
        {run && <span className="step-command-note">{run.status === "running" ? "in background" : run.status === "completed" ? "finished in background" : `${run.status} in background`}</span>}
      </button>
      {open && command.output && <pre className="step-output step-command-output">{command.output}</pre>}
    </div>
  );
}
