import { useEffect, useState } from "react";
import { api } from "../api";
import { commandLine, testsClock, testsHeadline } from "../lib/mergeTests";
import { usePersistentState } from "../lib/layout";
import type { useMergeTests } from "../lib/useMergeTests";
import { FailIcon, HudCheckIcon } from "./icons";

type Tests = ReturnType<typeof useMergeTests>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The tests on a merge card: nothing runs until the user presses the button (or the setting that does it when a merge is
 * proposed is on). Then the clock and the line it is on, and afterwards how it went, with the end of the output.
 */
export function MergeTestsBar({ tests }: { tests: Tests }) {
  const { info, error, going, run, cancel } = tests;
  // What the user typed for a project is kept for it, the next time (a different project may be tested differently).
  const [saved, setSaved] = usePersistentState<Record<string, string>>("merge.testCommandByFolder", {});
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ words: string[] } | { problem: string } | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const project = info?.project ?? "";
  const remembered = project ? saved[project] : undefined;
  const detected = info?.detected ?? null;
  const detectedLine = detected ? commandLine(detected.command) : null;

  // What the typed command would run as, worked out by the backend (the same splitting the run uses).
  useEffect(() => {
    if (!editing || !text.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    api.splitTestCommand(text).then(
      (words) => live && setPreview({ words }),
      (e) => live && setPreview({ problem: typeof e === "string" ? e : "That command can't be run." }),
    );
    return () => {
      live = false;
    };
  }, [editing, text]);

  if (!info) return null;
  const { running, last } = info;

  const edit = () => {
    setText(remembered ?? detectedLine ?? "");
    setProblem(null);
    setEditing(true);
  };
  const start = () => {
    setProblem(null);
    if (remembered) {
      api.splitTestCommand(remembered).then(run, (e) => {
        setProblem(typeof e === "string" ? e : "That command can't be run.");
        edit();
      });
    } else if (detected) {
      run(detected.command);
    } else {
      edit();
    }
  };
  const runTyped = () => {
    if (!preview || !("words" in preview)) return;
    // The command Lantern would have found itself needs no remembering.
    const next = { ...saved };
    if (text.trim() === detectedLine) delete next[project];
    else next[project] = text.trim();
    setSaved(next);
    setEditing(false);
    run(preview.words);
  };

  if (going) {
    return (
      <div className="merge-tests" role="status" aria-label="Tests">
        <div className="merge-tests-line">
          <span className="spinner" aria-hidden />
          <span className="merge-tests-title">Running tests…</span>
          <span className="merge-tests-clock">{testsClock(running?.elapsed_ms ?? 0)}</span>
          <button className="merge-link" onClick={cancel}>
            Cancel
          </button>
        </div>
        {running && <div className="merge-tests-command" title={commandLine(running.command)}>{commandLine(running.command)}</div>}
        {running?.last_line && <div className="merge-tests-last" aria-hidden>{running.last_line}</div>}
      </div>
    );
  }

  return (
    <div className="merge-tests" aria-label="Tests">
      {last && (
        <div className={`merge-tests-result ${last.result}`} role="status">
          <div className="merge-tests-line">
            {last.result === "passed" ? <HudCheckIcon /> : <FailIcon />}
            <span className="merge-tests-title">{testsHeadline(last)}</span>
            <span className="merge-tests-clock">{testsClock(last.took_ms)}</span>
            {last.stale && (
              <span className="tag merge-tests-stale" title="The branch changed after these tests ran, so they may not describe it any more.">
                Out of date
              </span>
            )}
          </div>
          <div className="merge-tests-command" title={commandLine(last.command)}>
            {commandLine(last.command)}
            {last.passed !== null && last.failed !== null && (last.passed > 0 || last.failed > 0) && (
              <span>
                {" · "}
                {[last.failed > 0 && `${last.failed} failed`, last.passed > 0 && `${last.passed} passed`, last.skipped ? `${last.skipped} skipped` : null].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
          {last.stale && <div className="merge-tests-note">The branch changed after these tests ran. Run them again to be sure.</div>}
          {last.note && <div className="merge-tests-note">{last.note}</div>}
          {last.new_files.length > 0 && (
            <div className="merge-tests-note">
              Running the tests left {plural(last.new_files.length, "new file")} in the worktree ({last.new_files.slice(0, 3).join(", ")}
              {last.new_files.length > 3 ? ", …" : ""}). The merge as proposed won't go through until the Lead proposes it again.
            </div>
          )}
          <button className="merge-link merge-tests-fold" aria-expanded={showOutput} onClick={() => setShowOutput(!showOutput)}>
            {showOutput ? "Hide the output" : "Show the end of the output"}
          </button>
          {showOutput && <pre className="step-output merge-tests-output">{last.tail || "The tests printed nothing."}</pre>}
        </div>
      )}
      {error && <p className="merge-problem" role="alert">{error}</p>}
      {editing ? (
        <form
          className="merge-tests-edit"
          onSubmit={(e) => {
            e.preventDefault();
            runTyped();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        >
          <label className="merge-tests-label" htmlFor={`merge-tests-${info.project}`}>
            {detected || remembered ? "The command that runs the tests:" : "Lantern can't tell how this project is tested. Type the command that runs its tests:"}
          </label>
          <input id={`merge-tests-${info.project}`} className="merge-tests-input" value={text} autoFocus spellCheck={false} placeholder="npm run test:unit" onChange={(e) => setText(e.target.value)} />
          {problem && <p className="merge-problem" role="alert">{problem}</p>}
          {preview && "problem" in preview && <p className="merge-problem" role="alert">{preview.problem}</p>}
          {preview && "words" in preview && (
            <div className="merge-tests-preview">
              Will run <code>{commandLine(preview.words)}</code> in this agent's worktree. Nothing goes through a shell.
            </div>
          )}
          <div className="merge-tests-buttons">
            <button type="submit" disabled={!preview || !("words" in preview)}>
              Run tests
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {detectedLine && text.trim() !== detectedLine && (
              <button type="button" className="merge-link" onClick={() => setText(detectedLine)}>
                Use {detectedLine}
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="merge-tests-buttons">
          <button onClick={start}>{last ? "Run the tests again" : "Run tests"}</button>
          {(remembered || detectedLine) && (
            <span className="merge-tests-command" title={remembered ?? detectedLine ?? ""}>
              {remembered ?? detectedLine}
              {!remembered && detected && <span> · from {detected.source}</span>}
            </span>
          )}
          {(remembered || detectedLine) && (
            <button className="merge-link" onClick={edit}>
              Change
            </button>
          )}
          {!remembered && !detectedLine && <span className="merge-tests-command">Lantern can't tell how to run them: you type the command.</span>}
        </div>
      )}
    </div>
  );
}
