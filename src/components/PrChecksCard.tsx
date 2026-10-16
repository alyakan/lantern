import { useState } from "react";
import { BUCKET_WORD, failureSig, fixLine, overall, summaryLine, totals } from "../lib/prChecks";
import type { PrView } from "../lib/usePrChecks";
import { ExternalLink } from "./ExternalLink";

interface Props {
  view: PrView;
  /** Claude is in the middle of a turn: sending the failure now would only queue behind it. */
  busy: boolean;
  /** Sends the failed checks' names and logs to Claude, in one message. */
  onSend: () => Promise<void>;
  /** Stops Fix it myself for this pull request. */
  onStop: () => void;
}

/**
 * How a pull request's checks stand, above the message box: a line with the counts, each check with a link, and, when one
 * failed, the button that sends the failure to Claude (or what Fix it myself is doing about it, with a Stop).
 */
export function PrChecksCard({ view, busy, onSend, onStop }: Props) {
  const { snap, setting, loop } = view;
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<boolean | null>(null);
  if (!snap || setting.mode === "off") return null;
  const { pr, checks } = snap;
  if (pr.state !== "OPEN") {
    return (
      <div className="pr-card-wrap">
        <div className="pr-card quiet" role="status" aria-label="Pull request checks">
          <ExternalLink href={pr.url} className="pr-link">
            Pull request #{pr.number}
          </ExternalLink>
          <span> was {pr.state === "MERGED" ? "merged" : "closed"}.</span>
        </div>
      </div>
    );
  }
  const t = totals(checks);
  const state = overall(t);
  const fix = fixLine(setting, loop);
  const sent = loop.handled !== null && loop.handled === failureSig(snap);
  // Fix it myself is on it: the user's own button comes back only once it has stopped or given up.
  const offer = t.failed > 0 && !sent && !(setting.mode === "fix" && loop.status === "waiting");
  const open = shown ?? state !== "passed";
  const send = () => {
    setSending(true);
    setProblem(null);
    onSend().then(
      () => setSending(false),
      (e) => {
        setSending(false);
        setProblem(String(e instanceof Error ? e.message : e));
      },
    );
  };
  return (
    <div className="pr-card-wrap">
      <div className={`pr-card ${state}`} role="group" aria-label="Pull request checks">
        <div className="pr-head">
          <span className={`pr-dot ${state}`} aria-hidden />
          <ExternalLink href={pr.url} className="pr-link">
            Pull request #{pr.number}
          </ExternalLink>
          <span className="pr-summary" role="status">
            {summaryLine(t)}
          </span>
          {checks.length > 0 && (
            <button className="pr-toggle" aria-expanded={open} onClick={() => setShown(!open)}>
              {open ? "Hide checks" : "Show checks"}
            </button>
          )}
        </div>
        {open && checks.length > 0 && (
          <ul className="pr-checks" aria-label="Checks">
            {checks.map((c, i) => (
              <li key={`${c.name}:${i}`} className={`pr-check ${c.bucket}`}>
                <span className="pr-check-state">{BUCKET_WORD[c.bucket]}</span>
                <span className="pr-check-name" title={c.workflow ? `${c.workflow} / ${c.name}` : c.name}>
                  {c.name}
                </span>
                {c.link && (
                  <ExternalLink href={c.link} className="pr-link" aria-label={`Open ${c.name} on GitHub`}>
                    Details
                  </ExternalLink>
                )}
              </li>
            ))}
          </ul>
        )}
        {fix && (
          <div className="pr-fix" role="status">
            <span>{fix.text}</span>
            {fix.stoppable && (
              <button onClick={onStop} aria-label="Stop fixing failed checks">
                Stop
              </button>
            )}
          </div>
        )}
        {sent && t.failed > 0 && <div className="pr-fix">Sent the failure to Claude.</div>}
        {offer && (
          <div className="pr-actions">
            <button className="primary" disabled={sending || busy} title={busy ? "Wait for Claude to finish." : "Sends the failed check and the end of its log to Claude, and asks it to fix it"} onClick={send}>
              {sending ? "Sending…" : "Send the failure to Claude"}
            </button>
            {problem && (
              <span className="pr-problem" role="alert">
                {problem}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
