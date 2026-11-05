import { useEffect, useRef, useState } from "react";
import { usageLine } from "../lib/cost";
import { shortTokens } from "../lib/contextShare";
import { useMenuShift } from "../lib/menuShift";
import { useMenuKeys } from "./useMenuKeys";

/** "4.2s", "38s", "2m 05s". */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

/** The share of the context used from which the meter warns (amber), and from which it's nearly full (red). */
export const WARN_AT = 75;
export const FULL_AT = 90;
/** From this many tokens a chat is long whatever its window: every message sends all of it, so Continue fresh is offered. */
export const LONG_AT = 150_000;

interface Props {
  /** Tokens in the conversation so far; null before the first reply. */
  used: number | null;
  /** The model's context window: reported at the end of a turn, or the last one seen for this model until then. Null when nothing says (then only the tokens used are shown, no percent). */
  window: number | null;
  running: boolean;
  lastTurnMs: number | null;
  /** Compact, Clear and Continue fresh, in a menu that opens from the meter (never shown unasked); only while Claude isn't working. */
  actions?: { onCompact: () => void; onClear: () => void; onFresh?: () => void };
  /** What the session has cost and used so far, for the tooltip (each known or not, see lib/cost.ts). */
  session?: { cost: number | null; tokens: number };
}

// Beside the send button: how full the context is, and while Claude works, how long it has been at it.
export function ContextMeter({ used, window, running, lastTurnMs, actions, session }: Props) {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const { ref: menu, style: menuStyle } = useMenuShift(open);
  const keys = useMenuKeys(open, root);

  // The menu closes on a press outside it, on Escape, and once a choice is made.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!running) return setStarted(null);
    const start = Date.now();
    setStarted(start);
    setNow(start);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  if (used === null && !running) return null;
  const percent = used !== null && window !== null ? Math.round(Math.min(used / window, 1) * 100) : null;
  // The warning is said in words as well as colour: the label is what a screen reader and a colour-blind reader get.
  const level = percent === null ? null : percent >= FULL_AT ? "full" : percent >= WARN_AT ? "warn" : null;
  // Said only where it can be acted on: a chat that can Continue fresh.
  const long = !!actions?.onFresh && used !== null && used >= LONG_AT;
  const note = level === "full" ? "Nearly full" : level === "warn" ? "Getting full" : long ? "Long chat" : null;
  const details = [
    used !== null && (window !== null ? `${used.toLocaleString()} of ${window.toLocaleString()} tokens of context used` : `${used.toLocaleString()} tokens of context used (the window isn't known until a turn ends)`),
    lastTurnMs !== null && `Last turn took ${formatDuration(lastTurnMs)}`,
    session && usageLine(session.cost, session.tokens) && `This chat so far: ${usageLine(session.cost, session.tokens)}`,
  ].filter(Boolean).join("\n");
  const shown = percent !== null ? `${percent}%` : used !== null ? shortTokens(used) : "";
  const label = percent !== null ? `${percent}% of context used${note ? `, ${note.toLowerCase()}` : ""}` : used !== null ? `${used.toLocaleString()} tokens of context used, window not known yet` : "";
  const showMenu = !!actions && !running && open;
  const choose = (act: () => void) => () => {
    setOpen(false);
    act();
  };

  return (
    <span className={`context-meter${level ? ` ${level}` : ""}`} title={details || undefined} ref={root}>
      {running && started !== null && <span className="elapsed">{formatDuration(Math.max(0, now - started))}</span>}
      {shown !== "" &&
        (actions && !running ? (
          <button type="button" className="context-used" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
            <span>{shown}</span>
            {note && <span className="context-note">{note}</span>}
          </button>
        ) : (
          <span className="context-used" aria-label={label}>
            <span>{shown}</span>
            {note && <span className="context-note">{note}</span>}
          </span>
        ))}
      {showMenu && actions && (
        <div className="menu context-menu" ref={menu} style={menuStyle} role="menu" aria-label="Context" onKeyDown={keys.onKeyDown}>
          <button type="button" role="menuitem" className="menu-row" onClick={choose(actions.onCompact)}>
            <span className="mode-text">
              <span className="menu-row-title">Compact</span>
              <span className="mode-hint">Summarises the conversation so far to free up context (sends /compact)</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="menu-row" onClick={choose(actions.onClear)}>
            <span className="mode-text">
              <span className="menu-row-title">Clear</span>
              <span className="mode-hint">Starts a new conversation in this folder (sends /clear). The files stay as they are.</span>
            </span>
          </button>
          {actions.onFresh && (
            <button type="button" role="menuitem" className="menu-row" onClick={choose(actions.onFresh)}>
              <span className="mode-text">
                <span className="menu-row-title">Continue fresh</span>
                <span className="mode-hint">Goes on in a fresh session with only the words of this conversation carried over (no tool output), so each message sends far less. The messages stay on screen.</span>
              </span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}
