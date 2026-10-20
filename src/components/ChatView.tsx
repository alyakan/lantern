import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { AWAY_FROM_END, JumpToLatest } from "./JumpToLatest";
import { useSlot } from "../lib/slot";
import { recallScroll, rememberScroll } from "../lib/scrollMemory";
import { anchorOf, scrollToAnchor, type ChatAnchor } from "../lib/scrollAnchor";
import type { State } from "../store";
import { workingVerb } from "../lib/verbs";
import { ChatStream, type ResendHandlers, type StreamHandlers } from "./ChatStream";
import { RestoreDialog } from "./RestoreDialog";
import { api, type RestoreResult } from "../api";
import { restoredFiles, restoreSummary, undoRestoreSummary, useRestorePoints } from "../lib/restorePoint";
import { sinceLabel } from "../lib/revert";

/** How long after the reader's last wheel, touch or key a scroll still counts as theirs (a trackpad's glide goes on after the fingers lift). */
const READER_WINDOW_MS = 600;

/** What "Restore files to here" tells the app: a restore was done or undone, so it can show it and say it to Claude. */
export interface RestoreEvents {
  onRestored: (since: string, result: RestoreResult, summary: string, files: { path: string; trashed: boolean }[]) => void;
  onUndone: (id: number, text: string) => void;
}

/** Loads the turns before the first one shown ("Show earlier messages"); resolves when they are in the chat. */
export type LoadEarlier = () => Promise<void>;

export function ChatView({ state, resend, restore, loadEarlier, ...handlers }: { state: State; resend?: ResendHandlers; restore?: RestoreEvents; loadEarlier?: LoadEarlier } & StreamHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  // Back in this chat: where you left it; at the end if you were there (or it's new). Kept as a place in the chat, not
  // pixels, since the same chat shows at other widths (its card on the canvas, the chat itself, a resized pane).
  const slot = useSlot();
  // "Restore files to here": the messages it is offered on, the one whose dialog is open, and what Undo failed with.
  const points = useRestorePoints(slot, !!restore && !!state.folder, state.items, state.status);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [undoFailed, setUndoFailed] = useState<string | null>(null);
  const blocked = state.status === "running" ? "Wait for Claude to finish before restoring files." : state.status === "starting" ? "Claude isn't ready yet." : null;
  // The same object while nothing in it changes, so the messages that offer it aren't drawn again for every word streamed.
  const canRestore = !!restore;
  const restoreRows = useMemo(() => (canRestore ? { points, blocked, onRestore: setConfirming } : undefined), [canRestore, points, blocked]);
  const undoRestore = () => {
    const undo = state.restoreUndo;
    if (!undo || !restore) return;
    setUndoFailed(null);
    api.undoRestore(slot, undo.id).then(
      (result) => restore.onUndone(undo.id, undoRestoreSummary(result)),
      (e) => setUndoFailed(String(e)),
    );
  };
  const left = recallScroll<ChatAnchor | -1>(`${slot}:chat`);
  const nearBottom = useRef(left === undefined || left === -1);
  const anchor = useRef<ChatAnchor | null>(left === undefined || left === -1 ? null : left);
  // While it is being put back, the scrolling that does it isn't the user's: it mustn't move the place.
  const restoring = useRef(anchor.current !== null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !anchor.current) return;
    const place = anchor.current;
    scrollToAnchor(el, place);
    // Again once what renders a moment later (code, diagrams) has its height.
    const frame = requestAnimationFrame(() => {
      if (restoring.current) scrollToAnchor(el, place);
      restoring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  // Where the chat is meant to be (at its end, or at a place in it) is the reader's to say, and only the reader's: by the
  // wheel or trackpad, a finger, the keys, the scrollbar, or the pill. The browser scrolls the chat by itself too, whenever
  // the layout changes under it (it grew, it was resized, it was clamped, it came back from another view), and read as the
  // reader's those scrolls said "you scrolled up" and made the middle of the chat the place to come back to. So a scroll
  // with no input of theirs just before it never changes what is meant.
  const lastInput = useRef(-Infinity);
  const dragging = useRef(false);
  const byHand = () => {
    restoring.current = false;
    lastInput.current = performance.now();
  };
  useEffect(() => {
    const release = () => (dragging.current = false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  // Following the end: the chat is put there, and that is what is remembered for coming back (never an older place).
  const toEnd = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    rememberScroll<ChatAnchor | -1>(`${slot}:chat`, -1);
  };
  // Your own message goes to the end, even if you'd scrolled up to read: you're following what you just sent.
  const lastSent = (items: State["items"]) => [...items].reverse().find((it) => it.type === "user" && !it.auto)?.id;
  const sent = useRef(lastSent(state.items));
  // Only the chat scrolls: scrollIntoView would scroll the page around it too, and slide the whole app out of the window.
  // Before the frame is drawn: the height it reads is the layout the frame needs anyway. Read after the frame (an effect),
  // it laid the chat out a second time for every word a streaming agent added.
  useLayoutEffect(() => {
    const el = scroller.current;
    const id = lastSent(state.items);
    if (id !== sent.current) {
      sent.current = id;
      nearBottom.current = true;
    }
    if (nearBottom.current && el) toEnd(el);
  }, [state.items, state.thinking]);
  // Older turns put in above what is on screen: the turn that was at the top stays there (the browser doesn't hold the
  // place by itself when content appears above it).
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierTurns = useRef(state.earlierTurns);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (state.earlierTurns < earlierTurns.current && el && anchor.current) scrollToAnchor(el, anchor.current);
    earlierTurns.current = state.earlierTurns;
  }, [state.earlierTurns]);
  const showEarlier = () => {
    const el = scroller.current;
    if (!loadEarlier || !el || loadingEarlier) return;
    // Where it is now is what is kept, whether or not it was scrolled away from the end.
    nearBottom.current = false;
    anchor.current = anchorOf(el);
    setLoadingEarlier(true);
    loadEarlier().finally(() => setLoadingEarlier(false));
  };
  // The chat box grows as you type, which makes this area shorter without scrolling it: stay at the end if you were
  // there, so the box doesn't end up over the last lines. Resized elsewhere (a wider pane, a card made bigger), it keeps
  // the place you were reading, which the same pixels no longer are.
  // And what is in it grows too, a moment after the chat shows: code gets its colours, a diagram is drawn in place of its
  // text, a picture loads. A chat opened at its end goes to the end once, so without this it would end up somewhere in the
  // middle once those arrive (back from another chat or canvas, that is what happened).
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) toEnd(el);
      else if (anchor.current) scrollToAnchor(el, anchor.current);
    });
    // Border box: any change in a turn's size counts, not only its content's.
    const watch = () => Array.from(el.children).forEach((child) => observer.observe(child, { box: "border-box" }));
    observer.observe(el);
    watch();
    // A turn added later is watched too.
    const added = typeof MutationObserver === "undefined" ? null : new MutationObserver(watch);
    added?.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      added?.disconnect();
    };
  }, []);
  // Scrolled up from the end: the pill to get back.
  const [away, setAway] = useState(false);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAway(fromEnd > AWAY_FROM_END);
    if (restoring.current) return;
    // Not the reader's (see byHand): the pill still tells how far from the end it is, and nothing else changes.
    if (!dragging.current && performance.now() - lastInput.current > READER_WINDOW_MS) return;
    nearBottom.current = fromEnd < 80;
    anchor.current = nearBottom.current ? null : anchorOf(el);
    // -1: at the end, so coming back follows the end even if it grew meanwhile.
    rememberScroll<ChatAnchor | -1>(`${slot}:chat`, anchor.current ?? -1);
  };
  // For the whole turn, until Claude is fully done: a line at the bottom with the turn's word, like Claude Code's
  // spinner under its output.
  const prompt = [...state.items].reverse().find((it) => it.type === "user");
  // A worker whose worktree is being set up hasn't started: nothing is thinking yet.
  const thinkingLine = state.status === "running" && !state.setup;
  const jump = () => {
    nearBottom.current = true;
    anchor.current = null;
    rememberScroll<ChatAnchor | -1>(`${slot}:chat`, -1);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  return (
    <div className="chat-wrap">
      {state.restoreUndo && (
        <div className="restore-undo" role="status">
          <span className="revert-undo-text">{undoFailed ?? state.restoreUndo.summary}</span>
          <span className="revert-undo-note">Undo lasts until your next message or until you quit Lantern.</span>
          <button className="ghost" onClick={undoRestore} disabled={!!blocked}>
            Undo restore
          </button>
        </div>
      )}
      <div
        className="chat"
        ref={scroller}
        onScroll={onScroll}
        onWheel={byHand}
        onPointerDown={() => {
          // The scrollbar is dragged with the pointer down: those scrolls are the reader's however long it takes.
          dragging.current = true;
          byHand();
        }}
        onKeyDown={byHand}
        onTouchStart={byHand}
        onTouchMove={byHand}
      >
        {state.earlierTurns > 0 && loadEarlier && (
          <button className="earlier-bar" onClick={showEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? "Loading…" : "Show earlier messages"}
            <span className="earlier-count">{state.earlierTurns === 1 ? "1 earlier turn" : `${state.earlierTurns} earlier turns`}</span>
          </button>
        )}
        {state.items.length === 0 && !state.thinking && <div className="empty">What should Claude work on?</div>}
        <ChatStream items={state.items} folder={state.folder} sections live={state.status === "running"} resend={resend} restore={restoreRows} {...handlers} />
        {thinkingLine && (
          <div className="activity live thinking-line" role="status" aria-label="Claude is thinking">
            <span className="activity-line">
              <span className="spinner" aria-hidden />
              <span className="activity-text">{workingVerb(prompt?.id ?? "start")}</span>
            </span>
          </div>
        )}
      </div>
      <JumpToLatest show={away} onJump={jump} />
      {confirming !== null && restore && (
        <RestoreDialog
          slot={slot}
          folder={state.folder}
          turn={confirming}
          since={sinceLabel(state.items, "turn", confirming)}
          blocked={blocked}
          onCancel={() => setConfirming(null)}
          onDone={(result) => {
            const since = sinceLabel(state.items, "turn", confirming);
            setConfirming(null);
            setUndoFailed(null);
            restore.onRestored(since, result, restoreSummary(result, since), restoredFiles(result));
          }}
        />
      )}
    </div>
  );
}
