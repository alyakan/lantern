import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { basename } from "../lib/diff";
import { middleTruncate, tildePath } from "../lib/paths";
import { linesOf, problemWith, type ProjectSetup } from "../lib/projectSetup";

interface Props {
  folder: string;
  /** What is saved for the project now. */
  saved: ProjectSetup | undefined;
  onSave: (setup: ProjectSetup) => void;
  onClose: () => void;
}

/**
 * A project's setup: the lines run once in each new agent's worktree before it starts (the worktree has none of the project's
 * installed packages or local files), and the command its Run button starts. What the project's files suggest is only offered:
 * nothing is saved until Save.
 */
export function ProjectSetupDialog({ folder, saved, onSave, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [commands, setCommands] = useState((saved?.commands ?? []).join("\n"));
  const [run, setRun] = useState(saved?.run ?? "");
  const [suggestion, setSuggestion] = useState<{ commands: string[]; run: string | null } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  // What the project's files suggest, looked for once. Shown only when it would change what is typed.
  useEffect(() => {
    let live = true;
    api.suggestSetup(folder).then(
      (found) => live && setSuggestion(found),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [folder]);

  const lines = linesOf(commands);
  const problem = problemWith(lines, run.trim());
  const offered = suggestion && (suggestion.commands.length > 0 || suggestion.run) && (suggestion.commands.join("\n") !== lines.join("\n") || (suggestion.run ?? "") !== run.trim()) ? suggestion : null;

  const fillIn = () => {
    if (!offered) return;
    if (offered.commands.length > 0) setCommands(offered.commands.join("\n"));
    if (offered.run) setRun(offered.run);
  };

  return (
    <dialog
      ref={ref}
      className="revert-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        className="revert-body setup-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (problem) return;
          onSave({ commands: lines, run: run.trim() });
          onClose();
        }}
      >
        <div className="revert-title" id={titleId}>
          Project setup for {basename(folder)}
        </div>
        <span className="menu-row-path" title={folder}>
          {middleTruncate(tildePath(folder))}
        </span>

        {offered && (
          <div className="setup-suggest" role="status">
            <span>
              Found in the project: {offered.commands.length > 0 && <code>{offered.commands.join(", ")}</code>}
              {offered.commands.length > 0 && offered.run && " · to run: "}
              {offered.commands.length === 0 && offered.run && "to run: "}
              {offered.run && <code>{offered.run}</code>}
            </span>
            <button type="button" onClick={fillIn}>
              Fill in
            </button>
          </div>
        )}

        <label className="setup-label">
          <span className="setup-name">Run in each new agent's worktree</span>
          <span className="setup-hint">One command per line, in order. A new agent works in a fresh copy of your project that has none of its installed packages or local files, so this is where to set that up (for example npm ci). It runs before the agent starts; if a line fails, the agent waits for you.</span>
          <textarea
            className="setup-field"
            rows={4}
            value={commands}
            onChange={(e) => setCommands(e.target.value)}
            placeholder={'npm ci\ncp "$LANTERN_PROJECT_DIR/.env" .env'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={problem ? true : undefined}
          />
          <span className="setup-hint">
            <code>$LANTERN_PROJECT_DIR</code> is your own project folder, to copy files from. Only lines written here run: Lantern never reads them from a file in your project.
          </span>
        </label>

        <label className="setup-label">
          <span className="setup-name">Run command</span>
          <span className="setup-hint">Started by an agent's Run button, in that agent's folder, for example to try out its changes.</span>
          <input className="setup-field" value={run} onChange={(e) => setRun(e.target.value)} placeholder="npm run dev" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        </label>

        {problem && (
          <div className="revert-error" role="alert">
            {problem}
          </div>
        )}
        <div className="revert-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!!problem}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
