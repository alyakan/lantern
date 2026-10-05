import { useState } from "react";

export function SetupScreen({ error, onCheck }: { error: string | null; onCheck: (pathOverride: string | null) => void }) {
  const [path, setPath] = useState("");
  return (
    <div className="setup">
      <h1>Claude CLI not found</h1>
      {error && <p className="muted">{error}</p>}
      <ol>
        <li>Install Claude Code.</li>
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
