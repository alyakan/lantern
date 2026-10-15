import { useEffect, useState } from "react";
import { api } from "../api";

type Check = { kind: "checking" } | { kind: "signed_in"; account: string | null } | { kind: "signed_out" } | { kind: "unknown" };

/**
 * First launch: that the claude Lantern found is installed (it was found) and logged in. A claude that isn't logged in
 * says how to fix it, in plain words, with a way to check again. When claude can't say, the check stays quiet: the first
 * chat will tell if it isn't logged in.
 */
export function ClaudeCheck({ path }: { path: string }) {
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setCheck({ kind: "checking" });
    api.claudeLogin(path).then(
      (login) => live && setCheck(login.logged_in ? { kind: "signed_in", account: login.account } : { kind: "signed_out" }),
      () => live && setCheck({ kind: "unknown" }),
    );
    return () => {
      live = false;
    };
  }, [path, attempt]);

  if (check.kind === "signed_out")
    return (
      <div className="claude-check warn" role="alert">
        <div className="claude-check-line">
          <span className="claude-check-mark" aria-hidden>
            !
          </span>
          <strong>Claude Code is installed, but you're not signed in.</strong>
        </div>
        <p>
          Open a terminal, run <code>claude</code> and type <code>/login</code>. Then come back and check again.
        </p>
        <button onClick={() => setAttempt((n) => n + 1)}>Check again</button>
      </div>
    );
  return (
    <div className="claude-check" role="status">
      <span className="claude-check-mark" aria-hidden>
        {check.kind === "checking" ? <span className="spinner" /> : "✓"}
      </span>
      {check.kind === "checking" && "Checking Claude Code…"}
      {check.kind === "signed_in" && (check.account ? `Claude Code is installed and signed in as ${check.account}` : "Claude Code is installed and signed in")}
      {check.kind === "unknown" && "Claude Code is installed"}
    </div>
  );
}
