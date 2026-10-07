import { useLayoutEffect, useRef, useState, type UIEvent } from "react";
import type { ShellItem } from "../store";
import { cleanOutput, lastLines } from "../lib/shell";
import { elapsed } from "../lib/time";

/** How many lines a block shows until "Show all". */
export const SHOWN_LINES = 400;

/** A command the user ran from the chat box, as a little terminal: the command, its output as it comes, how it ended. */
export function ShellBlock({ item, onStop }: { item: ShellItem; onStop?: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const clean = cleanOutput(item.output);
  const shown = all ? { text: clean.replace(/\n$/, ""), hidden: 0 } : lastLines(clean, SHOWN_LINES);
  const running = item.status === "running";

  // Follows the output while it comes, unless you scrolled up in it.
  const pre = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    if (atEnd.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown.text]);
  const onScroll = (e: UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className={`shell-block ${item.status}`} role="group" aria-label={`Command: ${item.command}`}>
      <div className="shell-head">
        <span className="shell-prompt" aria-hidden>
          $
        </span>
        <span className="shell-command">{item.command}</span>
        {running ? (
          <>
            <span className="spinner" aria-label="Running" />
            {onStop && (
              <button className="shell-stop" onClick={() => onStop(item.id)} title="Stop this command">
                Stop
              </button>
            )}
          </>
        ) : (
          <span className="shell-status">
            {item.status === "stopped" ? "stopped" : item.code === null ? "" : `exit ${item.code}`}
            {item.endedAt !== undefined && item.endedAt - item.startedAt >= 1000 && <span className="shell-time">{elapsed(item.endedAt - item.startedAt)}</span>}
          </span>
        )}
      </div>
      {shown.hidden > 0 && (
        <button className="shell-more" onClick={() => setAll(true)}>
          Show all {shown.hidden + SHOWN_LINES} lines
        </button>
      )}
      {shown.text && (
        <pre className="shell-output" ref={pre} onScroll={onScroll}>
          {shown.text}
        </pre>
      )}
    </div>
  );
}
