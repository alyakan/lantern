import { useEffect, useState } from "react";

/** "4.2s", "38s", "2m 05s". */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

interface Props {
  /** Tokens in the conversation so far; null before the first reply. */
  used: number | null;
  /** The model's context window: reported at the end of a turn, or the last one seen for this model until then. */
  window: number;
  running: boolean;
  lastTurnMs: number | null;
}

// Beside the send button: how full the context is, and while Claude works, how long it has been at it.
export function ContextMeter({ used, window, running, lastTurnMs }: Props) {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
  const details = [
    used !== null && `${used.toLocaleString()} of ${window.toLocaleString()} tokens of context used`,
    lastTurnMs !== null && `Last turn took ${formatDuration(lastTurnMs)}`,
  ].filter(Boolean).join("\n");

  return (
    <span className="context-meter" title={details || undefined}>
      {running && started !== null && <span className="elapsed">{formatDuration(Math.max(0, now - started))}</span>}
      {percent !== null && (
        <span className="context-used" aria-label={`${percent}% of context used`}>
          {percent}%
        </span>
      )}
    </span>
  );
}

