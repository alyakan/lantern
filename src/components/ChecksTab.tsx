import { useState } from "react";
import { BUCKET_WORD, failureSig, fixLine, overall, summaryLine, totals } from "../lib/prChecks";
import type { PrView } from "../lib/usePrChecks";
import { ExternalLink } from "./ExternalLink";
import { TabEmpty } from "./TabEmpty";

interface Props {
  /** What the checks loop knows about this folder's pull request (absent: nothing looked at yet). */
  view: PrView | undefined;
  /** Claude is in the middle of a turn: sending the failure now would only queue behind it. */
  busy: boolean;
  /** Sends the failed checks' names and logs to Claude, in one message. */
  onSend: () => Promise<void>;
  /** Stops Fix it myself for this pull request. */
  onStop: () => void;
}

/** Whether the tab has a pull request's checks to show (the empty tab says why not). */
export const hasChecks = (view: PrView | undefined): view is PrView & { snap: NonNullable<PrView["snap"]> } => !!view && view.setting.mode !== "off" && !!view.snap;

/** The line that says why there is nothing to show. */
function emptyLine(view: PrView | undefined): string {
  if (view?.setting.mode === "off") return "Checks are off for this project. Turn them on in Settings, under Pull requests.";
  if (view?.access === "no_gh") return "Lantern reads a pull request's checks with the GitHub CLI (gh), which isn't installed.";
  if (view?.access === "logged_out") return "Lantern reads a pull request's checks with the GitHub CLI (gh), which isn't logged in. Run gh auth login.";
  return "The checks of this branch's pull request show here, once it has one.";
}

/**
 * How a pull request's checks stand: a line with the pull request and the counts, every check with a link, and, when one
 * failed, the button that sends the failure to Claude (or what Fix it myself is doing about it, with a Stop).
 */
export function ChecksTab({ view, busy, onSend, onStop }: Props) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!hasChecks(view)) return <TabEmpty title="Checks">{emptyLine(view)}</TabEmpty>;
  const { snap, setting, loop } = view;
  const { pr, checks } = snap;
  if (pr.state !== "OPEN") {
    return (
      <div className="checks-tab">
        <div className="pr-head" role="status">
          <ExternalLink href={pr.url} className="pr-link">
            Pull request #{pr.number}
          </ExternalLink>
          <span className="pr-summary">{` was ${pr.state === "MERGED" ? "merged" : "closed"}.`}</span>
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
    <div className="checks-tab">
      <div className="pr-head">
        <span className={`pr-dot ${state}`} aria-hidden />
        <ExternalLink href={pr.url} className="pr-link">
          Pull request #{pr.number}
        </ExternalLink>
        <span className="pr-summary" role="status">
          {summaryLine(t)}
        </span>
      </div>
      {checks.length > 0 && (
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
      {(fix || (sent && t.failed > 0) || offer) && (
        <div className="pr-foot">
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
      )}
    </div>
  );
}
