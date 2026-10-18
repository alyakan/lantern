import { useEffect, useState } from "react";
import { pausedLine, type PlanPause } from "../lib/planPause";

/** How often the time left until the plan resets is redrawn. */
const TICK_MS = 15_000;

/**
 * The card at the top of the window while the teams' work is paused because the plan reached the user's limit: what
 * happened, when the plan resets, and Resume, which is the only thing that starts the agents again; Dismiss closes the card
 * and leaves them stopped. It goes by itself when the plan resets.
 */
export function PlanPaused({ pause, onResume, onDismiss }: { pause: PlanPause; onResume: () => void; onDismiss?: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const n = pause.slots.length;
  return (
    <div className="banner banner-info plan-paused" role="status">
      <span>
        <strong>{pausedLine(pause, now)}.</strong> {n === 1 ? "1 agent was stopped" : `${n} agents were stopped`}, none ended. Nothing starts again until you press Resume. Dismiss leaves them stopped.
      </span>
      <span className="banner-actions">
        <button className="primary" onClick={onResume}>
          Resume
        </button>
        {onDismiss && (
          <button onClick={onDismiss} title="Close this without restarting the agents: they stay stopped and can be messaged">
            Dismiss
          </button>
        )}
      </span>
    </div>
  );
}
