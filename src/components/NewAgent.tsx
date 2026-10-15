import { useEffect, useRef, useState } from "react";
import { usePopover } from "../lib/usePopover";
import { useNodeActions } from "../lib/canvasContext";
import { MODEL_CHOICES } from "../lib/models";
import type { NewWorker } from "../types";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

const EMPTY: Form = { task: "", name: "", isolation: "worktree", model: null };
interface Form {
  task: string;
  name: string;
  isolation: NewWorker["isolation"];
  /** Null: Claude Code's default, which is also what "Default" in the list means. */
  model: string | null;
}

/**
 * "+ Agent": the user starts a worker themselves, without asking the main agent to. A small form opens over the canvas
 * (the task, an optional name, where it works, and which model); the worker is started exactly as the main agent's would
 * be, so whatever stops that (the limit on workers, no git for a worktree) is said here, in the form.
 */
export function NewAgent({ main }: { main: string }) {
  const actions = useNodeActions();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const task = useRef<HTMLTextAreaElement>(null);
  const { box, button, id } = usePopover(open, () => !busy && setOpen(false), false);
  useEffect(() => {
    if (open) task.current?.focus();
  }, [open]);

  const set = (change: Partial<Form>) => setForm((f) => ({ ...f, ...change }));
  const submit = () => {
    if (busy) return;
    if (!form.task.trim()) {
      setProblem("Say what the worker should do.");
      task.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    actions
      .spawn(main, { task: form.task.trim(), name: form.name.trim() || null, isolation: form.isolation, model: form.model })
      .then(
        () => {
          setOpen(false);
          setForm(EMPTY);
        },
        (e) => setProblem(errText(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="canvas-team" ref={box}>
      <button ref={button} className="canvas-fit" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} title="Start a worker yourself" onClick={() => setOpen(!open)}>
        + Agent
      </button>
      {open && (
        <form
          id={id}
          className="new-agent canvas-overlay"
          role="dialog"
          aria-label="New agent"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label>
            Task
            <textarea
              ref={task}
              rows={4}
              value={form.task}
              placeholder="What should it do? This is the brief it starts from."
              aria-required
              aria-invalid={!!problem && !form.task.trim()}
              onChange={(e) => set({ task: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <label>
            Name <span className="new-agent-optional">optional</span>
            <input value={form.name} maxLength={60} placeholder="Named from the task" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <fieldset>
            <legend>Where it works</legend>
            <label className="new-agent-choice">
              <input type="radio" name="isolation" checked={form.isolation === "worktree"} onChange={() => set({ isolation: "worktree" })} />
              Own worktree
            </label>
            <label className="new-agent-choice">
              <input type="radio" name="isolation" checked={form.isolation === "shared"} onChange={() => set({ isolation: "shared" })} />
              Shared folder
            </label>
            <p className="new-agent-hint">Shared is for work that writes nothing: it reads your folder as it is.</p>
          </fieldset>
          <label>
            Model
            <select value={form.model ?? ""} onChange={(e) => set({ model: e.target.value || null })}>
              {MODEL_CHOICES.map((m) => (
                <option key={m.value ?? "default"} value={m.value ?? ""}>
                  {m.label} · {m.hint}
                </option>
              ))}
            </select>
          </label>
          {problem && (
            <p className="new-agent-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="new-agent-actions">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Starting…" : "Start agent"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
