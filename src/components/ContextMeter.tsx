import { useEffect, useState } from "react";

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

interface Props {
  /** Tokens in the conversation so far; null before the first reply. */
  used: number | null;
  /** The model's context window: reported at the end of a turn, or the last one seen for this model until then. */
  window: number;
  running: boolean;
  lastTurnMs: number | null;
  /** Compact and Clear, shown when the meter warns or is clicked, and only while Claude isn't working. */
  actions?: { onCompact: () => void; onClear: () => void };
}

// Beside the send button: how full the context is, and while Claude works, how long it has been at it.
export function ContextMeter({ used, window, running, lastTurnMs, actions }: Props) {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!running) return setStarted(null);
    const start = Date.now();
    setStarted(start);
    setNow(start);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  if (used === null && !running) return null;
  const percent = used !== null ? Math.round(Math.min(used / window, 1) * 100) : null;
  // The warning is said in words as well as colour: the label is what a screen reader and a colour-blind reader get.
  const level = percent === null ? null : percent >= FULL_AT ? "full" : percent >= WARN_AT ? "warn" : null;
  const note = level === "full" ? "Nearly full" : level === "warn" ? "Getting full" : null;
  const details = [
    used !== null && `${used.toLocaleString()} of ${window.toLocaleString()} tokens of context used`,
    lastTurnMs !== null && `Last turn took ${formatDuration(lastTurnMs)}`,
  ].filter(Boolean).join("\n");
  const label = `${percent}% of context used${note ? `, ${note.toLowerCase()}` : ""}`;
  const showActions = !!actions && !running && (level !== null || open);

  return (
    <span className={`context-meter${level ? ` ${level}` : ""}`} title={details || undefined}>
      {running && started !== null && <span className="elapsed">{formatDuration(Math.max(0, now - started))}</span>}
      {percent !== null &&
        (actions && !running ? (
          <button type="button" className="context-used" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
            <span>{percent}%</span>
            {note && <span className="context-note">{note}</span>}
          </button>
        ) : (
          <span className="context-used" aria-label={label}>
            <span>{percent}%</span>
            {note && <span className="context-note">{note}</span>}
          </span>
        ))}
      {showActions && (
        <span className="context-actions">
          <button type="button" className="ghost context-compact" title="Summarises the conversation so far to free up context (sends /compact)" onClick={actions.onCompact}>
            Compact
          </button>
          <button type="button" className="ghost context-clear" title="Starts a new conversation in this folder (sends /clear). The files stay as they are." onClick={actions.onClear}>
            Clear
          </button>
        </span>
      )}
    </span>
  );
}
