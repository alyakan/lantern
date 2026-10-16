import { useState } from "react";
import type { SetupCard } from "../store";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

/**
 * A new agent's worktree being set up before the agent starts: which line is running ("Setting up: npm ci…") and what it
 * printed last. When a line fails the agent has not started, and the card says which line and why, with the end of what it
 * printed, and the three things the user can do: start it anyway, run the setup again, or close it.
 */
export function SetupNotice({ card, onAnswer, onClose }: { card: SetupCard; onAnswer: (answer: "start" | "again" | "stop") => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = (a: "start" | "again" | "stop") => {
    setBusy(true);
    setProblem(null);
    onAnswer(a).then(
      () => setBusy(false),
      (e) => {
        setBusy(false);
        setProblem(errText(e));
      },
    );
  };
  const step = card.total > 1 ? `${card.index + 1} of ${card.total}` : null;

  if (card.status === "running") {
    return (
      <div className="merge-card setup-card" role="status" aria-label="Setting up">
        <div className="setup-line">
          <span className="spinner" aria-hidden />
          <span className="setup-title">
            Setting up: <code>{card.command}</code>…
          </span>
          {step && <span className="setup-step">{step}</span>}
          <button className="setup-stop" disabled={busy} onClick={() => answer("stop")} title="Stop setting up. The agent doesn't start until you say so.">
            Stop
          </button>
        </div>
        {card.line && <div className="setup-last">{card.line}</div>}
        {problem && <p className="merge-problem">{problem}</p>}
      </div>
    );
  }
  return (
    <div className="merge-card setup-card failed" role="group" aria-label="Setup stopped">
      <div className="merge-title">
        Setup stopped at <code>{card.command}</code>
      </div>
      <p className="merge-note">
        {card.reason ? `${card.reason[0].toUpperCase()}${card.reason.slice(1)}. ` : ""}The agent hasn't started yet{step ? ` (line ${step})` : ""}.
      </p>
      {card.tail && (
        <pre className="setup-tail" role="region" aria-label="What it printed last" tabIndex={0}>
          {card.tail}
        </pre>
      )}
      {problem && <p className="merge-problem">{problem}</p>}
      <div className="merge-actions">
        <button className="merge-approve" disabled={busy} onClick={() => answer("start")} title="Start the agent without the rest of the setup">
          Start anyway
        </button>
        <button disabled={busy} onClick={() => answer("again")} title="Run the setup again from its first line">
          Run setup again
        </button>
        <button disabled={busy} onClick={onClose} title="Stop it and remove its worktree">
          Close agent
        </button>
      </div>
    </div>
  );
}
