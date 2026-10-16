import { useEffect, useState } from "react";
import { pausedLine, type PlanPause } from "../lib/planPause";

/** How often the time left until the plan resets is redrawn. */
const TICK_MS = 15_000;

/**
 * The card at the top of the window while the teams' work is paused because the plan reached the user's limit: what
 * happened, when the plan resets, and Resume, which is the only thing that starts the agents again.
 */
export function PlanPaused({ pause, onResume }: { pause: PlanPause; onResume: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const n = pause.slots.length;
  return (
    <div className="banner banner-info plan-paused" role="status">
      <span>
        <strong>{pausedLine(pause, now)}.</strong> {n === 1 ? "1 agent was stopped" : `${n} agents were stopped`}, none ended. Nothing starts again until you press Resume.
      </span>
      <button className="primary" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
