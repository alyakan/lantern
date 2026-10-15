import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { AWAY_FROM_END, JumpToLatest } from "./JumpToLatest";
import { useSlot } from "../lib/slot";
import { recallScroll, rememberScroll } from "../lib/scrollMemory";
import { anchorOf, scrollToAnchor, type ChatAnchor } from "../lib/scrollAnchor";
import type { State } from "../store";
import { workingVerb } from "../lib/verbs";
import { ChatStream, type ResendHandlers, type StreamHandlers } from "./ChatStream";

export function ChatView({ state, resend, ...handlers }: { state: State; resend?: ResendHandlers } & StreamHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  // Back in this chat: where you left it; at the end if you were there (or it's new). Kept as a place in the chat, not
  // pixels, since the same chat shows at other widths (its card on the canvas, the chat itself, a resized pane).
  const slot = useSlot();
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
  const byHand = () => {
    restoring.current = false;
  };
  // Your own message goes to the end, even if you'd scrolled up to read: you're following what you just sent.
  const lastSent = (items: State["items"]) => [...items].reverse().find((it) => it.type === "user" && !it.auto)?.id;
  const sent = useRef(lastSent(state.items));
  // Only the chat scrolls: scrollIntoView would scroll the page around it too, and slide the whole app out of the window.
  useEffect(() => {
    const el = scroller.current;
    const id = lastSent(state.items);
    if (id !== sent.current) {
      sent.current = id;
      nearBottom.current = true;
    }
    if (nearBottom.current && el) el.scrollTop = el.scrollHeight;
  }, [state.items, state.thinking]);
  // The chat box grows as you type, which makes this area shorter without scrolling it: stay at the end if you were
  // there, so the box doesn't end up over the last lines. Resized elsewhere (a wider pane, a card made bigger), it keeps
  // the place you were reading, which the same pixels no longer are.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
      else if (anchor.current) scrollToAnchor(el, anchor.current);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Scrolled up from the end: the pill to get back.
  const [away, setAway] = useState(false);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAway(fromEnd > AWAY_FROM_END);
    if (restoring.current) return;
    nearBottom.current = fromEnd < 80;
    anchor.current = nearBottom.current ? null : anchorOf(el);
    // -1: at the end, so coming back follows the end even if it grew meanwhile.
    rememberScroll<ChatAnchor | -1>(`${slot}:chat`, anchor.current ?? -1);
  };
  // For the whole turn, until Claude is fully done: a line at the bottom with the turn's word, like Claude Code's
  // spinner under its output.
  const prompt = [...state.items].reverse().find((it) => it.type === "user");
  const thinkingLine = state.status === "running";
  const jump = () => {
    nearBottom.current = true;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  return (
    <div className="chat-wrap">
      <div className="chat" ref={scroller} onScroll={onScroll} onWheel={byHand} onPointerDown={byHand} onKeyDown={byHand}>
        {state.items.length === 0 && !state.thinking && <div className="empty">What should Claude work on?</div>}
        <ChatStream items={state.items} folder={state.folder} sections live={state.status === "running"} resend={resend} {...handlers} />
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
    </div>
  );
}
