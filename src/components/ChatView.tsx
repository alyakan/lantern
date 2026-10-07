import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { AWAY_FROM_END, JumpToLatest } from "./JumpToLatest";
import { useSlot } from "../lib/slot";
import { recallScroll, rememberScroll } from "../lib/scrollMemory";
import type { State } from "../store";
import { workingVerb } from "../lib/verbs";
import { ChatStream, type StreamHandlers } from "./ChatStream";

export function ChatView({ state, ...handlers }: { state: State } & StreamHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  // Back in this chat: where you left it; at the end if you were there (or it's new).
  const slot = useSlot();
  const left = recallScroll(`${slot}:chat`);
  const nearBottom = useRef(left === undefined || left < 0);
  useLayoutEffect(() => {
    if (left !== undefined && left >= 0 && scroller.current) scroller.current.scrollTop = left;
  }, []);
  // Only the chat scrolls: scrollIntoView would scroll the page around it too, and slide the whole app out of the window.
  useEffect(() => {
    const el = scroller.current;
    if (nearBottom.current && el) el.scrollTop = el.scrollHeight;
  }, [state.items, state.thinking]);
  // The chat box grows as you type, which makes this area shorter without scrolling it: stay at the end if you were
  // there, so the box doesn't end up over the last lines.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Scrolled up from the end: the pill to get back.
  const [away, setAway] = useState(false);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = fromEnd < 80;
    setAway(fromEnd > AWAY_FROM_END);
    // -1: at the end, so coming back follows the end even if it grew meanwhile.
    rememberScroll(`${slot}:chat`, nearBottom.current ? -1 : el.scrollTop);
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
      <div className="chat" ref={scroller} onScroll={onScroll}>
        {state.items.length === 0 && !state.thinking && <div className="empty">What should Claude work on?</div>}
        <ChatStream items={state.items} folder={state.folder} sections live={state.status === "running"} {...handlers} />
        {thinkingLine && (
          <div className="activity live thinking-line" aria-label="Claude is thinking">
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
