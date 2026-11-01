import { useEffect, useState } from "react";
import { dayOf, type TimelineEvent, type TimelineKind } from "../lib/timeline";

export interface TimelineProps {
  events: TimelineEvent[];
  onOpen: (e: TimelineEvent) => void;
}

const MARK: Record<TimelineKind, string> = { waiting: "needs you", working: "working", done: "finished", failed: "failed", stopped: "stopped" };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * What happened in the open chats, newest first, on a line: what is going on now at the top, then each answer that finished,
 * under the day it finished. An unread one is bold, with a dot. A click opens its chat, which marks it read.
 */
export function Timeline({ events, onOpen }: TimelineProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!events.length) return <div className="sb-note">Nothing yet. What the chats do shows here as it happens.</div>;
  const days: { day: string; events: TimelineEvent[] }[] = [];
  for (const e of events) {
    const day = dayOf(e, now);
    if (days[days.length - 1]?.day !== day) days.push({ day, events: [] });
    days[days.length - 1].events.push(e);
  }
  return (
    <section className="timeline" aria-label="Timeline">
      {days.map((d) => (
        <div key={d.day} className="tl-day" role="group" aria-label={d.day}>
          <h3 className="tl-day-name">{d.day}</h3>
          {d.events.map((e) => (
            <button key={e.key} className={`tl-event ${e.kind}${e.unread ? " unread" : ""}`} aria-label={`${e.title}, ${MARK[e.kind]}${e.unread ? ", unread" : ""}`} title={e.line} onClick={() => onOpen(e)}>
              <span className="tl-dot" aria-hidden />
              <span className="tl-top">
                <span className="tl-title">{e.title}</span>
                <time className="tl-time">{d.day === "Now" ? MARK[e.kind] : clock(e.at)}</time>
              </span>
              <span className="tl-where">
                {e.where}
                {d.day !== "Now" && e.kind !== "done" && <span className="tl-bad"> · {MARK[e.kind]}</span>}
              </span>
              {e.line && <span className="tl-line">{e.line}</span>}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
