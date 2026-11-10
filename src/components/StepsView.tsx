import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CollapsibleText } from "./CollapsibleText";
import { Md } from "./Md";
import { AWAY_FROM_END, JumpToLatest } from "./JumpToLatest";
import { useSlot } from "../lib/slot";
import { FLAVOUR_LABEL, FLAVOURS, flavourName, type Flavour } from "../lib/flavour";
import { FlavourBadge } from "./FlavourBadge";
import { FLAVOUR_ICON } from "./ModeGuide";
import { recallScroll, rememberScroll } from "../lib/scrollMemory";
import { messageTime } from "../lib/time";
import { initials, useUserName } from "../lib/userName";
import type { State } from "../store";
import { agentName } from "../lib/provider";
import { COMMIT_NEXT, continuedIn, isApproval, isCommitAnswer, movesOn, pageLabel, pagesOf, pageTitle, promptText, SKIP_COMMIT_NEXT, startedChoice, UPDATE_MAP, startedFlavour, startText, stayedIn, stayText, type StepPage, type StepTurn } from "../lib/steps";
import { mattersToTask } from "../lib/commands";
import type { BackgroundRun, ChatItem, ToolItem } from "../store";
import { workingVerb } from "../lib/verbs";
import { ChatStream, type StreamHandlers } from "./ChatStream";
import { isVerdictNext, parseReviewFile, parseReviewFrame, recallVerdicts, rememberVerdicts, splitFileTitle, verdictMessage, verdictsFromNext, withoutCue, type PageFindings, type ReviewFile, type ReviewFrame, type Verdict } from "../lib/review";
import { ReviewFrameView, ReviewRoute, unitName, type RouteStop } from "./ReviewDesk";
import type { DiffComment } from "../lib/diffComments";
import { unreadReply } from "../lib/pageNote";
import { ReviewFileHeader, ReviewFileView, ReviewGroupHeader, ReviewSummaryTable, type ReviewedFinding, type SummaryNotes } from "./ReviewPages";
import { ArchitecturePartView } from "./ArchitecturePages";
import { parseArchitecturePart, type ArchitecturePart } from "../lib/architecture";
import { PHASES, phasesOf } from "../lib/phases";
import { DoneHandoff, type Handoff } from "./DoneHandoff";

/** What "Update the step with this" sends. */
export const UPDATE_STEP = "Update the step with this: write the whole step again under its heading, in the same format as before, with what we just discussed worked in and everything else kept.";

/** A plain move-on prompt: "Next", a Next carrying review verdicts, an answer to a suggestion; nothing to show as "You asked". */
const justMovesOn = (text: string) => isApproval(text) || isCommitAnswer(text) || isVerdictNext(text) || startedFlavour(text) !== null || stayedIn(text) || continuedIn(text);

/** A Review file page's parts, if its message has the skill's sections. */
function reviewOf(page: StepPage): ReviewFile | null {
  if (page.heading?.kind !== "file") return null;
  const main = page.turns[page.main];
  const msg = main.items.find((it) => it.id === main.messageId);
  return msg?.type === "assistant" ? parseReviewFile(page.heading.title, msg.text, page.heading.files) : null;
}

/** A Review Frame's units and risks, if its message has the sections Lantern reads (an older Frame doesn't). */
function frameOf(page: StepPage): ReviewFrame | null {
  if (page.heading?.kind !== "frame") return null;
  const main = page.turns[page.main];
  const msg = main.items.find((it) => it.id === main.messageId);
  return msg?.type === "assistant" ? parseReviewFrame(msg.text) : null;
}

/** An Architecture part page's parts, if its message has the sections. */
function partOf(page: StepPage): ArchitecturePart | null {
  if (page.heading?.kind !== "part") return null;
  const main = page.turns[page.main];
  const msg = main.items.find((it) => it.id === main.messageId);
  return msg?.type === "assistant" ? parseArchitecturePart(msg.text) : null;
}

interface Props extends StreamHandlers {
  state: State;
  /** Approve the page on screen and move on: sends "Next", or the message given (a Next with review verdicts). */
  onNext: (message?: string) => void;
  /** Sends a message as if typed (the review summary's actions). */
  onSend?: (text: string, switchTo?: Flavour) => void;
  /** The flavour Step by step is in (one picked and not yet sent included); null before one is chosen. */
  flavour: Flavour | null;
  /** Explain as you go is on (Build and Debug). */
  explain?: boolean;
  /** Pick a flavour (and Explain as you go) from the header's badge: Claude is told with the next message. */
  onPickFlavour: (flavour: Flavour, explain?: boolean) => void;
  /** Claude Code's auto mode approves actions instead of the app asking; each step is still reviewed as a page. */
  /** The page on screen changed: the turns whose changes the Changes pane should show (null: not all known). */
  onPage: (range: { from: number; to: number } | null) => void;
  /** The page that's on screen (once a slide has come to rest): the Map tab lights the boxes it covers. */
  onShown?: (pageKey: string) => void;
  /** Review: the files of the page that's on screen (one, or a group's; none on any other page), so the Changes pane can show them. */
  onReviewFile?: (paths: string[]) => void;
  /** The Summary tab asked for this page; `key` changes with every request, so asking again for the same page works. */
  jump?: { page: string; key: number } | null;
  /** What the Done page hands off to (the side panel, the export, a new chat); without it the page has no actions. */
  handoff?: Handoff;
  /** Review: the findings of the page that came to rest, for the Changes pane to draw under their lines (null: none). */
  onFindings?: (findings: PageFindings | null) => void;
  /** Review: the notes the user left on the diff's lines, kept for the summary, and how to take some away once they are sent. */
  reviewNotes?: { items: DiffComment[]; remove: (ids: string[]) => void };
}

const isTyping = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

// Step-by-step mode's view of the conversation: a page per step, side by side, one on screen. Questions about a step
// and changes to it stay on its page; Previous and Next (or ← →) slide between pages, and on the newest page Next
// approves the step and Claude carries on.
export function StepsView({ state, flavour, explain = false, onNext, onSend, onPickFlavour, onPage, onShown, onReviewFile, jump = null, handoff, onFindings, reviewNotes, ...handlers }: Props) {
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
  useEffect(() => {
    if (restingPage) onShown?.(restingPage.key);
  }, [restingPage?.key]);
  const restingHeading = restingPage?.heading;
  const restingFiles = restingHeading?.kind === "file" ? (restingHeading.files ?? [splitFileTitle(restingHeading.title).path]) : [];
  const restingFilesKey = restingFiles.join("\n");
  // Files are reported as pages come to rest, and none only after some were (to show every file again on the Summary):
  // a view that starts on a page with no file says nothing, so it can't clear the file a merge card's Review diff chose.
  const reportedFiles = useRef(false);
  useEffect(() => {
    if (restingFiles.length === 0 && !reportedFiles.current) return;
    reportedFiles.current = restingFiles.length > 0;
    onReviewFile?.(restingFiles);
  }, [restingFilesKey]);

  const go = (i: number) => setIndex(Math.max(0, Math.min(last, i)));
  // A page the Summary tab asked for. Not one asked for before this view was drawn (switching back to this chat).
  const askedFor = useRef(jump?.key);
  useEffect(() => {
    if (!jump || jump.key === askedFor.current) return;
    askedFor.current = jump.key;
    const i = pages.findIndex((p) => p.key === jump.page);
    if (i >= 0) go(i);
  }, [jump?.key]);
  // The dots can be squeezed to three in a narrow pane, so keep the current page's pill in the middle of what shows.
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const follow = () => {
      const dot = el.querySelector<HTMLElement>(".steps-dot.current");
      if (!dot) return;
      const from = dot.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      el.scrollLeft = from - (el.clientWidth - dot.offsetWidth) / 2;
    };
    follow();
    // The pill is still growing and the dot before it still shrinking for a moment, and the pane may be resized.
    const later = setTimeout(follow, 250);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(el);
    return () => {
      clearTimeout(later);
      observer?.disconnect();
    };
  }, [at, pages.length]);
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
      // A dialog or menu that's open takes the arrows for itself.
      if (document.querySelector("dialog[open], .menu, [role='dialog'], [role='menu']")) return;
      if (e.key === "ArrowLeft") go(at - 1);
      if (e.key === "ArrowRight") go(at + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, last]);

  const heading = page?.heading;
  // The flavour's stages, and the one each page is in; a chat with no flavour yet follows Build's.
  const phases = PHASES[flavour ?? "build"];
  const phaseOf = phasesOf(flavour ?? "build", pages);
  const phaseAt = phaseOf[at] ?? 0;
  const review = flavour === "review";
  const arch = flavour === "architecture";
  const newest = at === last;
  const teach = explain;
  // Review: whether a file has come yet, so Next opens the first one or the next.
  const filesSoFar = review && pages.slice(0, at + 1).some((p) => p.heading?.kind === "file");
  // A Build step's Next also answers whether to commit it, so Claude doesn't ask on a page of its own. A map brought up to
  // date in the middle of a step answers for the step before it.
  const mapUpdate = heading?.kind === "overview" && page.turns[0].prompt.text.trim() === UPDATE_MAP;
  const buildStep = (mapUpdate ? pages[at - 1]?.heading : heading)?.kind === "step" && !review && !arch && flavour !== "debug";

  // Review verdicts, per page and finding; the page's Next carries them. Kept outside the view while they're unsent
  // (switching chats or modes draws it again), and once sent they're read back from the Next that carried them.
  const [unsent, setVerdicts] = useState<Record<string, Record<number, Verdict>>>(() => recallVerdicts(slot));
  useEffect(() => {
    rememberVerdicts(slot, unsent);
  }, [slot, unsent]);
  const verdictsOfPage = (i: number): Record<number, Verdict> | undefined => {
    const p = pages[i];
    const findings = reviewOf(p)?.findings ?? partOf(p)?.concerns;
    const sent = findings && pages[i + 1] ? verdictsFromNext(pages[i + 1].turns[0].prompt.text, findings) : undefined;
    return sent ?? unsent[p.key];
  };
  const verdicts = Object.fromEntries(pages.map((p, i) => [p.key, verdictsOfPage(i)]));
  const setVerdict = (pageKey: string, index: number, v: Verdict | null) =>
    setVerdicts((all) => {
      const page = { ...all[pageKey] };
      if (v) page[index] = v;
      else delete page[index];
      return { ...all, [pageKey]: page };
    });
  // The resting page's findings go to the Changes pane's diff, with its verdicts; one set there is set here too.
  const restingIndex = Math.min(settled, last);
  const restingReview = review && restingPage ? reviewOf(restingPage) : null;
  const canVote = restingIndex === last && !running;
  const vote = useRef((index: number, v: Verdict | null) => restingPage && setVerdict(restingPage.key, index, v));
  vote.current = (index, v) => restingPage && setVerdict(restingPage.key, index, v);
  const findingItems = (restingReview?.findings ?? []).flatMap((f) => {
    const path = f.path ?? restingReview?.path ?? (restingReview?.files.length === 1 ? restingReview.files[0] : null);
    return path ? [{ path, finding: f, verdict: verdicts[restingPage!.key]?.[f.index] }] : [];
  });
  const findingsKey = restingPage && findingItems.length ? JSON.stringify([restingPage.key, canVote, findingItems.map((it) => [it.path, it.finding.index, it.finding.line, it.finding.lineEnd, it.finding.text, it.verdict])]) : "";
  const latestFindings = useRef(onFindings);
  latestFindings.current = onFindings;
  useEffect(() => {
    if (!latestFindings.current) return;
    latestFindings.current(findingsKey ? { page: restingPage!.key, items: findingItems, onVerdict: canVote ? (index, v) => vote.current(index, v) : undefined } : null);
  }, [findingsKey]);
  useEffect(() => () => latestFindings.current?.(null), []);
  const currentReview = page ? (reviewOf(page)?.findings ?? partOf(page)?.concerns ?? null) : null;
  // A part's concerns the user has answered (agreed or rejected), of all it has.
  const concernCount = page ? (partOf(page)?.concerns.length ?? 0) : 0;
  const answeredCount = page ? Object.keys(verdicts[page.key] ?? {}).length : 0;
  // Review: the findings on the page on screen, and the notes on the diff kept for the summary.
  const reviewCount = review && page ? (reviewOf(page)?.findings.length ?? 0) : 0;
  const notesCount = reviewNotes?.items.length ?? 0;
  // The latest reply, when it looked like a page but Lantern couldn't read it as one: said under the newest page.
  const unread = !!flavour && unreadReply(state.items) !== null && !running;
  const next = () => {
    const message = currentReview ? verdictMessage(currentReview, verdicts[page.key]) : "Next";
    onNext(message === "Next." ? "Next" : message);
  };
  // Every finding across the reviewed files, for the summary page.
  const reviewed: ReviewedFinding[] = review
    ? pages.flatMap((p, i) => {
        const r = reviewOf(p);
        return r ? r.findings.map((f) => ({ path: f.path ?? r.path ?? r.group, finding: f, verdict: verdicts[p.key]?.[f.index], onRevisit: () => go(i) })) : [];
      })
    : [];

  // Review's route: the Frame, each planned unit (from the Frame's Units, or else the pages' "File N of M"), the Summary.
  const lastOf = (match: (p: StepPage) => boolean) => {
    for (let i = last; i >= 0; i--) if (match(pages[i])) return i;
    return null;
  };
  const framePage = review ? lastOf((p) => p.heading?.kind === "frame") : null;
  const reviewFrame = framePage !== null ? frameOf(pages[framePage]) : null;
  const unitPage = (n: number) => lastOf((p) => p.heading?.kind === "file" && p.heading.n === n);
  const route: RouteStop[] = [];
  if (review) {
    // Every unit there is word of: the Frame's, the pages' own "File N of M" (Claude may add a unit after the Frame), up to the last M.
    const filePages = pages.filter((p) => p.heading?.kind === "file");
    const total = Math.max(0, ...filePages.map((p) => Math.max(p.heading?.total ?? 0, p.heading?.n ?? 0)), ...(reviewFrame?.units.map((u) => u.n) ?? []));
    const framed = new Map((reviewFrame?.units ?? []).map((u) => [u.n, u.title]));
    const planned = Array.from({ length: total }, (_, i) => ({ n: i + 1, title: framed.get(i + 1) ?? "" }));
    route.push({ key: "frame", kind: "frame", label: "Frame", title: "The Frame: what the change is, its risks and the route", page: framePage });
    for (const u of planned) {
      const at = unitPage(u.n);
      const r = at !== null ? reviewOf(pages[at]) : null;
      const shown = r ? (r.group ?? r.path ?? "") : "";
      const title = u.title || shown || `Unit ${u.n}`;
      route.push({ key: `unit-${u.n}`, kind: "unit", n: u.n, label: u.title || shown ? unitName(title) : `Unit ${u.n}`, title, page: at, findings: r?.findings.length, open: r ? r.findings.filter((f) => !verdicts[pages[at!].key]?.[f.index]).length : undefined });
    }
    route.push({ key: "summary", kind: "summary", label: "Summary", title: "The Summary: every finding and your notes", page: lastOf((p) => p.heading?.kind === "summary") });
  }
  const openUnit = (n: number) => {
    const i = unitPage(n);
    return i === null ? null : () => go(i);
  };

  // Architecture: every concern across the parts, for the summary page.
  const concerns: ReviewedFinding[] = arch
    ? pages.flatMap((p) => {
        const part = partOf(p);
        return part ? part.concerns.map((f) => ({ path: pageTitle(p) ?? pageLabel(p.heading), finding: f, verdict: verdicts[p.key]?.[f.index] })) : [];
      })
    : [];


  return (
    <div className="steps-view">
      <div className="steps-head">
        {review ? <ReviewRoute stops={route} at={at} onGo={go} /> : (
        <nav className="steps-phases" aria-label="Progress">
          {phases.map((phase, n) => {
            const where = n === phaseAt ? "current" : n < phaseAt ? "past" : "next";
            const first = phaseOf.indexOf(n);
            return (
              <Fragment key={phase.name}>
                {n > 0 && <span className="steps-phase-sep" aria-hidden />}
                {where === "current" ? (
                  <div className="steps-phase current" aria-current="step">
                    <span className="steps-phase-mark" aria-hidden>
                      {n + 1}
                    </span>
                    <span className="steps-phase-name">{phase.name}</span>
                    {/* The pages of this stage: the dots go between them. */}
                    {phaseOf.filter((x) => x === n).length > 1 && (
                    <div className="steps-rail" ref={rail} role="tablist" aria-label="Pages">
                      {pages.map((p, i) =>
                        phaseOf[i] !== n ? null : (
                          <button key={p.key} role="tab" aria-selected={i === at} aria-label={`${pageLabel(p.heading)}${pageTitle(p) ? `: ${pageTitle(p)}` : ""}`} title={`${pageLabel(p.heading)}${pageTitle(p) ? ` — ${pageTitle(p)}` : ""}`} className={`steps-dot${i === at ? " current" : ""}${p.heading?.kind === "step" || p.heading?.kind === "done" || p.heading?.kind === "file" || p.heading?.kind === "fix" ? " build" : ""}${p.heading?.kind === "switch" ? " switch" : ""}`} onClick={() => go(i)} />
                        ),
                      )}
                    </div>
                    )}
                  </div>
                ) : (
                  <button className={`steps-phase ${where}`} disabled={first < 0} title={first < 0 ? `${phase.name}: not reached yet` : `Go to ${phase.name}`} onClick={() => go(first)}>
                    <span className="steps-phase-mark" aria-hidden>
                      {where === "past" ? "✓" : n + 1}
                    </span>
                    <span className="steps-phase-name">{phase.name}</span>
                    {where === "past" && <span className="sr-only"> (done)</span>}
                  </button>
                )}
              </Fragment>
            );
          })}
        </nav>
        )}
        {state.backgroundTasks.length > 0 && (
          <span className="steps-background" title={`Still running in the background:\n${state.backgroundTasks.map((t) => t.description).join("\n")}`}>
            <span className="spinner" aria-hidden />
            {state.backgroundTasks.length} in background
          </span>
        )}
        <div className="spacer" />
        <FlavourBadge flavour={flavour} explain={explain} onPick={onPickFlavour} disabled={running} />
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
                  frame={review && i === framePage ? reviewFrame : null}
                  onUnit={openUnit}
                  arch={arch}
                  suggestion={p.heading?.kind === "switch" ? { current: flavour, answer: pages[i + 1]?.turns[0].prompt.text ?? null, onAnswer: i === last && !running && onSend ? onSend : undefined, agent: agentName(state.provider) } : null}
                  verdicts={verdicts[p.key]}
                  onVerdict={i === last && !running ? (index, v) => setVerdict(p.key, index, v) : undefined}
                  summary={p.heading?.kind === "summary" && onSend ? { rows: arch ? concerns : reviewed, onAction: onSend, busy: running, architecture: arch, notes: review && reviewNotes ? { ...reviewNotes, folder: state.folder } : undefined } : null}
                  handoff={p.heading?.kind === "done" ? handoff : undefined}
                  onHandoffSend={i === last && !running ? onSend : undefined}
                  folder={state.folder}
                  runs={state.backgroundRuns}
                  latest={latestOf.get(p.key) ?? p.main}
                  onUpdate={i === last && !running && onSend ? () => onSend(UPDATE_STEP) : undefined}
                  unread={i === last && unread}
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
        <span className="sr-only" role="status">
          Page {at + 1} of {pages.length}
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
            <>
            {review && (heading?.kind === "file" || notesCount > 0) && (
              <span className="steps-answered" aria-live="polite">
                {[heading?.kind === "file" && reviewCount > 0 ? `${answeredCount} of ${reviewCount} finding${reviewCount === 1 ? "" : "s"} decided` : heading?.kind === "file" ? "No findings here" : "", notesCount > 0 ? `${notesCount} note${notesCount === 1 ? "" : "s"} for the summary` : ""].filter(Boolean).join(" · ")}
              </span>
            )}
            {arch && heading?.kind === "part" && concernCount > 0 && (
              <span className="steps-answered" aria-live="polite">
                {answeredCount} of {concernCount} concern{concernCount === 1 ? "" : "s"} answered
              </span>
            )}
            {buildStep && (
              <button className="ghost" disabled={waiting} title="Approve this step without committing it, and go on to the next" onClick={() => onNext(SKIP_COMMIT_NEXT)}>
                Next, no commit
              </button>
            )}
            <button className="primary" disabled={waiting || heading?.kind === "done" || heading?.kind === "summary"} title={review ? "Send your verdicts and go on to the next file" : arch ? (heading?.kind === "frame" ? "Go on to the Overview" : heading?.kind === "overview" ? "Go on to the first part" : heading?.kind === "part" && heading.n === heading.total ? "Send your verdicts and go on to the Summary" : "Send your verdicts and go on to the next part") : heading?.kind === "plan-complete" ? "Lock the plan: Claude builds exactly these steps, and asks before changing them" : heading?.kind === "plan-update" ? "Approve this change to the locked plan" : buildStep ? "Approve this step, commit its files, and go on to the next" : "Approve this page and go on to the next"} onClick={buildStep ? () => onNext(COMMIT_NEXT) : next}>
              {heading?.kind === "done" || heading?.kind === "summary" ? "Done" : heading?.kind === "plan-complete" ? "Lock plan →" : heading?.kind === "plan-update" ? "Approve update →" : review ? (heading?.kind === "file" && heading.n === heading.total ? "Summary →" : filesSoFar ? "Next file →" : "First file →") : arch ? (heading?.kind === "frame" ? "Overview →" : heading?.kind === "overview" ? "First part →" : heading?.kind === "part" && heading.n === heading.total ? "Summary →" : "Next part →") : flavour === "debug" ? "Next →" : buildStep ? "Commit & next →" : "Next step →"}
            </button>
            </>
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
  /** The latest reply looked like a page but wasn't one of the flavour's headings: Lantern says so under it. */
  unread?: boolean;
  first: boolean;
  live: boolean;
  teach: boolean;
  review: boolean;
  /** A Review's Frame with the sections Lantern reads, drawn as its risks and route; how to open a unit's page (null: not there yet). */
  frame?: ReviewFrame | null;
  onUnit?: (n: number) => (() => void) | null;
  arch: boolean;
  /**
   * A switch page: the flavour the chat was in, how you answered (the next page's opening prompt), and how to answer
   * (only on the newest page, when idle).
   */
  suggestion?: { current: Flavour | null; answer: string | null; onAnswer?: (text: string) => void; agent?: string } | null;
  /** Review: your verdicts on this page's findings, and how to set one (only on the newest page, when idle). */
  verdicts?: Record<number, Verdict>;
  onVerdict?: (index: number, v: Verdict | null) => void;
  /** Review's summary page: every finding with its verdict, and the actions after the review. */
  summary?: { rows: ReviewedFinding[]; onAction: (text: string, switchTo?: Flavour) => void; busy: boolean; architecture?: boolean; notes?: SummaryNotes } | null;
  /** The Done page: where the work goes from here, and how to message Claude (only on the newest page, when idle). */
  handoff?: Handoff;
  onHandoffSend?: (text: string, switchTo?: Flavour) => void;
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

function Page({ page, unread, first, live, teach, review, frame = null, onUnit, arch, suggestion, verdicts, onVerdict, summary, handoff, onHandoffSend, folder, latest, runs, onKeep, onUpdate, ...handlers }: PageProps) {
  const h = page.heading;
  const opening = page.turns[0];
  const asked = opening.prompt.auto ? null : first ? opening.prompt.text : justMovesOn(opening.prompt.text) ? null : promptText(opening.prompt.text);
  const main = page.turns[page.main];
  const reviewFile = reviewOf(page);
  const part = partOf(page);
  // Review and Architecture pages: the parts are laid out below, and a closing "Say Next…" is dropped (the buttons say it).
  const mainItems = main.items
    .filter((it) => !((reviewFile || part || frame) && it.id === main.messageId))
    .map((it) => ((review || arch) && it.type === "assistant" && it.id === main.messageId ? { ...it, text: withoutCue(it.text) } : it));

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
    <div ref={root} className={`step-page-body${teach ? " teach" : ""}${h?.kind === "step" ? " built-step" : ""}`}>
      <div className="step-eyebrow">{pageLabel(h)}</div>
      <h1 className="step-title">{reviewFile?.group ? <ReviewGroupHeader title={reviewFile.group} added={reviewFile.added} removed={reviewFile.removed} /> : reviewFile?.path ? <ReviewFileHeader path={reviewFile.path} added={reviewFile.added} removed={reviewFile.removed} /> : h?.kind === "switch" && h.flavour ? `${FLAVOUR_LABEL[h.flavour]}?` : pageTitle(page) || (live ? "Working…" : "Untitled step")}</h1>
      {asked && <UserMessage className="step-asked" text={asked} at={opening.prompt.at} tag={first ? "Task" : movesOn(opening.prompt.text) ? "Then moved on" : null} />}
      <div className="step-content">
        <ChatStream items={mainItems} folder={folder} live={live && page.main === page.turns.length - 1} {...handlers} />
        {frame && <ReviewFrameView frame={frame} onUnit={onUnit ?? (() => null)} />}
        {reviewFile && <ReviewFileView file={reviewFile} verdicts={verdicts} onVerdict={onVerdict} />}
        {part && <ArchitecturePartView part={part} verdicts={verdicts} onVerdict={onVerdict} />}
        {h?.kind === "switch" && h.flavour && suggestion && <SuggestionCard flavour={h.flavour} explain={!!h.explain} why={h.title} {...suggestion} />}
        {summary && <ReviewSummaryTable rows={summary.rows} onAction={summary.onAction} busy={summary.busy} architecture={summary.architecture} notes={summary.notes} />}
      </div>
      {handoff && <DoneHandoff handoff={handoff} onSend={onHandoffSend} />}
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
      {unread && (
        <p className="step-unread" role="status">
          Lantern couldn't show this as a page; it will tell Claude with your next message.
        </p>
      )}
    </div>
  );
}

/**
 * Claude's suggestion to work in a flavour: start it, stay in the one you're in, or start another. Once answered, it
 * says how.
 */
function SuggestionCard({ flavour, explain, why, current, answer, onAnswer, agent = "Claude" }: { flavour: Flavour; explain: boolean; why: string; current: Flavour | null; answer: string | null; onAnswer?: (text: string) => void; agent?: string }) {
  const label = FLAVOUR_LABEL[flavour];
  // "Build, explaining as you go" when Claude suggests the option too.
  const named = flavourName(flavour, explain);
  const started = answer === null ? null : startedChoice(answer) ?? (isApproval(answer) ? { flavour, explain } : null);
  const outcome = answer === null ? null : started ? `You started ${flavourName(started.flavour, started.explain)}` : stayedIn(answer) ? "You kept going as before" : "You answered in the chat";
  return (
    <div className={`suggestion${outcome ? " answered" : ""}`} role="group" aria-label={`${agent} suggests ${label}`}>
      <div className="suggestion-head">
        <span className="suggestion-icon">{FLAVOUR_ICON[flavour]}</span>
        <span>
          {`${agent} suggests`} <strong>{named}</strong>
        </span>
      </div>
      {why && <p className="suggestion-why">{why}</p>}
      {outcome ? (
        <div className="suggestion-outcome">{outcome}</div>
      ) : (
        onAnswer && (
          <div className="suggestion-actions">
            <button className="primary" onClick={() => onAnswer(startText(label, explain))}>
              Start {named}
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
        <CollapsibleText>
          <Md>{text}</Md>
        </CollapsibleText>
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
        <span className="step-command-status" role="img" aria-label={status === "error" ? "failed" : status === "running" ? "running" : "done"}>
          {status === "running" ? <span className="spinner" aria-hidden /> : status === "error" ? "✕" : "✓"}
        </span>
        <code className="step-command-text">{command.summary}</code>
        {run && <span className="step-command-note">{run.status === "running" ? "in background" : run.status === "completed" ? "finished in background" : `${run.status} in background`}</span>}
      </button>
      {open && command.output && (
        <pre className="step-output step-command-output" role="region" aria-label="Command output" tabIndex={0}>
          {command.output}
        </pre>
      )}
    </div>
  );
}
