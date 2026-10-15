import { useState } from "react";
import { ExternalLink } from "./ExternalLink";

/** Where Claude Code is installed from. */
export const INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code";

/** First launch when claude can't be found: what's wrong in plain words, and how to fix it. */
export function SetupScreen({ error, onCheck }: { error: string | null; onCheck: (pathOverride: string | null) => void }) {
  const [path, setPath] = useState("");
  return (
    <div className="setup">
      <h1>Claude CLI not found</h1>
      <p className="welcome-lead">Lantern runs the Claude Code you already have, and couldn't find it on this Mac.</p>
      {error && <p className="muted setup-error">{error}</p>}
      <ol>
        <li>
          Install Claude Code: <ExternalLink href={INSTALL_URL}>how to install it</ExternalLink>.
        </li>
        <li>
          Run <code>claude</code> once in a terminal and log in.
        </li>
        <li>
          Click “Check again”, or enter the full path to <code>claude</code>.
        </li>
      </ol>
      <div className="setup-row">
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/.local/bin/claude" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button className="primary" onClick={() => onCheck(path.trim() || null)}>
          Check again
        </button>
      </div>
    </div>
  );
}
