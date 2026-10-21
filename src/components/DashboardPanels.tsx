import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { commandLine, formatDuration, initialState, isScalar, isTable, plain, runStatus, summarizeInputs, tableColumns, toValues, type FormPanel as FormSpec, type FormState } from "../lib/dashboard";
import { relativeTime } from "../lib/time";
import type { DashboardField, DashboardPreview, DashboardRun, DashboardRunSummary, DashboardValues } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { Fold } from "./TestsTab";

// Everything here is shown as plain text: titles, labels, options, errors and what a command printed come from a file in the
// folder or from a script, so none of it goes through Markdown or HTML, and nothing in it becomes a link.

/** What each form's controls hold, kept while the tab is away: coming back to a half-filled form finds it as it was. */
const kept = new Map<string, FormState>();

// MARK: - The form

interface FormProps {
  folder: string;
  file: string;
  form: FormSpec;
  /** The backend says a run of this form is going. */
  running: boolean;
  /** Changes when the user presses Reload: options that a command loads are asked for again. */
  reload?: number;
  /** Changes whenever the tab read the dashboards again. */
  stamp?: number;
}

/** Where a field's options come from when a command loads them. */
interface OptionsSource {
  folder: string;
  file: string;
  form: string;
  /** Counts the presses of Reload: the command is run again for each. */
  reload: number;
  /** Changes whenever the tab read the dashboards again, so a list another part just loaded is picked up. */
  stamp: number;
}

type OptionsState =
  /** Looking for the list kept from the last time the command ran. */
  | { status: "checking" }
  /** The command is running, because the user asked. */
  | { status: "loading" }
  | { status: "ready"; options: string[]; loadedAt: number }
  /** The command has never run for this version of the file (and these values of what the list depends on). */
  | { status: "none" }
  /** The list depends on a field that hasn't been chosen yet. */
  | { status: "waiting"; on: string }
  | { status: "error"; message: string };

/** What a command-fed list depends on, as the form stands: the chosen values of those fields, and the name of the first not chosen yet. */
interface Dependencies {
  values: DashboardValues;
  /** The same values as one string, to tell when they change. */
  key: string;
  waitingOn: string | null;
}

function dependenciesOf(field: DashboardField, fields: DashboardField[], values: DashboardValues): Dependencies {
  const picked: DashboardValues = {};
  let waitingOn: string | null = null;
  for (const id of field.optionsFrom?.dependsOn ?? []) {
    const dep = fields.find((f) => f.id === id);
    const value = values[id];
    // A toggle always has a value; a select or number has one once it is chosen (a cleared number is left out of the values).
    if (value === undefined || value === "") waitingOn ??= dep?.label ?? id;
    else picked[id] = value;
  }
  return { values: picked, key: JSON.stringify(picked), waitingOn };
}

/**
 * A select's options: the ones written in the file, or (`optionsFrom`) the list its command printed the last time it was run,
 * which Lantern keeps. Opening a form never runs the command (a script it calls may have changed since the user trusted the
 * file); it runs when the user asks: Load options, Retry, Reload, or trusting the dashboard.
 */
function useOptions(field: DashboardField, source: OptionsSource, deps: Dependencies): { state: OptionsState; load: () => void } {
  const dynamic = !!field.optionsFrom;
  const [state, setState] = useState<OptionsState>({ status: "checking" });
  const { folder, file, form, reload, stamp } = source;
  const waiting = deps.waitingOn !== null;
  // What the list is for now: an answer for values the user has since changed must not land.
  const current = useRef(deps.key);
  current.current = deps.key;
  const load = () => {
    if (waiting) return;
    const mine = deps.key;
    setState({ status: "loading" });
    api.dashboardLoadOptions(folder, file, form, field.id, deps.values).then(
      (list) => current.current === mine && setState({ status: "ready", options: list.options, loadedAt: list.loaded_at }),
      (e) => current.current === mine && setState({ status: "error", message: String(e) }),
    );
  };
  // Another value of what the list depends on is another list: start again from what is kept for it.
  useEffect(() => {
    setState({ status: "checking" });
  }, [deps.key]);
  // The kept list: when the field appears, and again when the tab has read anything new. A slower, older answer never lands over a newer one.
  useEffect(() => {
    if (!dynamic || waiting) return;
    let live = true;
    api.dashboardOptions(folder, file, form, field.id, deps.values).then(
      (list) =>
        live &&
        setState((now) => {
          // A kept list never replaces a newer one that a run of the command just brought, or hides one still on its way.
          if (list) return now.status === "loading" || (now.status === "ready" && now.loadedAt > list.loaded_at) ? now : { status: "ready", options: list.options, loadedAt: list.loaded_at };
          // Nothing kept: first look says so; an error or a run in progress stays as it is.
          return now.status === "checking" || now.status === "ready" ? { status: "none" } : now;
        }),
      (e) => live && setState((now) => (now.status === "checking" ? { status: "error", message: String(e) } : now)),
    );
    return () => {
      live = false;
    };
  }, [dynamic, waiting, deps.key, folder, file, form, field.id, stamp]);
  // Reload runs the command again (not for the first render, which is no press).
  const pressed = useRef(reload);
  useEffect(() => {
    if (!dynamic || pressed.current === reload) return;
    pressed.current = reload;
    load();
  }, [reload]);
  if (!dynamic) return { state: { status: "ready", options: field.options ?? [], loadedAt: 0 }, load };
  return { state: waiting ? { status: "waiting", on: deps.waitingOn ?? "" } : state, load };
}

export function FormPanel({ folder, file, form, running, reload = 0, stamp = 0 }: FormProps) {
  // A form whose fields changed in the file starts over rather than inheriting controls that no longer match.
  const key = `${folder}\n${file}\n${form.id}\n${form.fields.map((f) => `${f.id}:${f.type}`).join(",")}`;
  const [state, setState] = useState<FormState>(() => kept.get(key) ?? initialState(form.fields));
  const change = (next: FormState) => {
    kept.set(key, next);
    setState(next);
  };
  const [ask, setAsk] = useState<DashboardPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = pending || running;
  const values = toValues(form.fields, state);

  const go = () => {
    setPending(true);
    setError(null);
    api
      .dashboardRun(folder, file, form.id, values)
      .catch((e) => setError(String(e)))
      .finally(() => setPending(false));
  };
  // The button asks what it would run first, from the same code that runs it, so a wrong value is said before anything starts.
  const press = () => {
    setError(null);
    api.dashboardPreview(folder, file, form.id, values).then(
      (p) => (p.confirm !== null ? setAsk(p) : go()),
      (e) => setError(String(e)),
    );
  };
  const name = form.title ?? form.id;
  return (
    <section className="dash-panel dash-form" aria-label={name}>
      <h3 className="dash-title">{name}</h3>
      <form
        className="dash-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) press();
        }}
      >
        {form.fields.map((f) => (
          <Field key={f.id} id={`${key}-${f.id}`} field={f} fields={form.fields} values={values} source={{ folder, file, form: form.id, reload, stamp }} value={state[f.id]} disabled={busy} onChange={(v) => change({ ...state, [f.id]: v })} />
        ))}
        <div className="dash-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Running…" : "Run"}
          </button>
          {busy && (
            <button type="button" className="ghost" onClick={() => void api.dashboardStop(folder, file, form.id)}>
              Stop
            </button>
          )}
        </div>
      </form>
      {error && (
        <div className="network-error" role="alert">
          {error}
        </div>
      )}
      {ask && (
        <ConfirmDialog
          title={`Run “${name}”?`}
          confirmLabel="Run"
          busyLabel="Running…"
          busy={false}
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            setAsk(null);
            go();
          }}
        >
          <p>{ask.confirm}</p>
          <pre className="dash-command" aria-label="Command">
            {commandLine(ask.args)}
          </pre>
        </ConfirmDialog>
      )}
    </section>
  );
}

function Field({ id, field, fields, values, source, value, disabled, onChange }: { id: string; field: DashboardField; fields: DashboardField[]; values: DashboardValues; source: OptionsSource; value: string | boolean | string[] | undefined; disabled: boolean; onChange: (v: string | boolean | string[]) => void }) {
  const label = field.label ?? field.id;
  const text = typeof value === "string" ? value : "";
  const { state: loaded, load } = useOptions(field, source, dependenciesOf(field, fields, values));
  const options = loaded.status === "ready" ? loaded.options : [];
  // What stands with the options of a field a command fills in: that they are loading, when they were loaded, or why they aren't.
  const note =
    loaded.status === "checking" || loaded.status === "loading" ? (
      <span className="tests-note">Loading options…</span>
    ) : loaded.status === "waiting" ? (
      <span className="tests-note dash-options-waiting">Choose {loaded.on} first.</span>
    ) : loaded.status === "none" ? (
      <span className="tests-note dash-options-none">
        No options loaded yet{field.optionsFrom?.dependsOn?.length ? " for this choice" : ""}.{" "}
        <button type="button" className="ghost" onClick={load} disabled={disabled}>
          Load options
        </button>
      </span>
    ) : loaded.status === "error" ? (
      <span className="dash-options-error" role="alert">
        Couldn't load the options: {loaded.message}{" "}
        <button type="button" className="ghost" onClick={load}>
          Retry
        </button>
      </span>
    ) : field.optionsFrom ? (
      <span className="tests-note dash-options-age">{loaded.options.length === 0 ? "The command printed no options." : `Loaded ${relativeTime(loaded.loadedAt)} by the dashboard's command. Reload to ask it again.`}</span>
    ) : null;
  if (field.type === "toggle") {
    return (
      <label className="dash-field dash-toggle">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  if (field.type === "multiselect") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="dash-field dash-multi">
        <legend>{label}</legend>
        {options.map((o) => (
          <label key={o} className="dash-option">
            <input type="checkbox" checked={chosen.includes(o)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o))} />
            <span>{o}</span>
          </label>
        ))}
        {/* A choice the loaded list doesn't have (a default, or one made before the list changed) stays visible, so it can be unticked. */}
        {loaded.status === "ready" &&
          field.optionsFrom &&
          chosen
            .filter((c) => !options.includes(c))
            .map((o) => (
              <label key={o} className="dash-option dash-stale">
                <input type="checkbox" checked disabled={disabled} onChange={() => onChange(chosen.filter((c) => c !== o))} />
                <span>
                  {o} <em>not in the list</em>
                </span>
              </label>
            ))}
        {note}
      </fieldset>
    );
  }
  return (
    <div className="dash-field">
      <label htmlFor={id}>
        {label}
        {field.required && <span className="dash-required"> *</span>}
      </label>
      {field.type === "select" ? (
        <>
          <select id={id} value={text} disabled={disabled || loaded.status !== "ready"} onChange={(e) => onChange(e.target.value)}>
            <option value="">{loaded.status === "loading" || loaded.status === "checking" ? "Loading…" : "Choose…"}</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
            {/* The chosen one, if the loaded list doesn't have it: shown as it is, so it can be seen and changed. */}
            {loaded.status === "ready" && field.optionsFrom && text !== "" && !options.includes(text) && <option value={text}>{text} (not in the list)</option>}
          </select>
          {note}
        </>
      ) : (
        <input id={id} type={field.type === "number" ? "number" : "text"} value={text} min={field.min} max={field.max} step={field.type === "number" ? "any" : undefined} disabled={disabled} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

// MARK: - A run's result

/** One kept run's detail, loaded when `id` is known: undefined while it loads, null when it is gone. A kept run never changes. */
function useRunDetail(folder: string, id: string | null): DashboardRun | null | undefined {
  const [detail, setDetail] = useState<{ id: string; run: DashboardRun | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    api.dashboardRunDetail(folder, id).then(
      (run) => live && setDetail({ id, run }),
      () => live && setDetail({ id, run: null }),
    );
    return () => {
      live = false;
    };
  }, [folder, id]);
  if (!id) return null;
  return detail?.id === id ? detail.run : undefined;
}

export function ResultPanel({ folder, file, formId, title, runs, running }: { folder: string; file: string; formId: string; title?: string; runs: DashboardRunSummary[]; running: boolean }) {
  const latest = runs.find((r) => r.file === file && r.form === formId) ?? null;
  const run = useRunDetail(folder, latest?.id ?? null);
  return (
    <section className="dash-panel dash-result" aria-label={title ?? "Result"}>
      <h3 className="dash-title">{title ?? "Result"}</h3>
      {running && <div className="tests-note">Running…</div>}
      {!latest && !running && <div className="tests-note">Nothing has run yet. The result of the last run shows here.</div>}
      {latest && run === undefined && <div className="tests-note">Loading…</div>}
      {latest && run === null && <div className="tests-note">That run is gone.</div>}
      {run && <RunView run={run} />}
    </section>
  );
}

/** A run: how it went, what it printed as a list or table when it was JSON, and the log and command behind it. */
export function RunView({ run }: { run: DashboardRun }) {
  const status = runStatus(run);
  const failed = status.tone !== "ok";
  const stderr = plain(run.stderr).trim();
  return (
    <div className="dash-run">
      <div className="dash-run-head">
        <span className={`dash-status ${status.tone}`}>{status.label}</span>
        <span className="dash-run-meta">
          {relativeTime(run.started_at)} · {formatDuration(run.duration_ms)}
        </span>
      </div>
      {run.output !== null && <OutputView value={run.output} />}
      {failed && stderr && (
        <pre className="dash-log dash-error" aria-label="Errors">
          {stderr}
        </pre>
      )}
      <Fold title="Log" open={run.output === null && !stderr}>
        {run.truncated && <div className="tests-note">Long output: the start is left out.</div>}
        <pre className="dash-log" aria-label="Log">
          {plain(run.stdout + (run.stderr ? `\n${run.stderr}` : "")).trim() || "(nothing printed)"}
        </pre>
      </Fold>
      <Fold title="Command">
        <pre className="dash-command">{commandLine(run.args)}</pre>
      </Fold>
    </div>
  );
}

// MARK: - JSON output as a list or a table

const MAX_DEPTH = 6;
const MAX_ROWS = 200;

export function OutputView({ value }: { value: unknown }) {
  return (
    <div className="dash-output">
      <Output value={value} depth={0} label="value" />
    </div>
  );
}

function Output({ value, depth, label }: { value: unknown; depth: number; label: string }) {
  if (isScalar(value)) return <Scalar value={value} label={label} />;
  if (depth >= MAX_DEPTH) return <span className="dash-text">{JSON.stringify(value)}</span>;
  if (Array.isArray(value)) {
    if (isTable(value)) return <Table rows={value} depth={depth} label={label} />;
    if (value.every(isScalar)) {
      return (
        <ul className="dash-items">
          {value.map((v, i) => (
            <li key={i}>
              <Scalar value={v} label={label} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ol className="dash-items">
        {value.slice(0, MAX_ROWS).map((v, i) => (
          <li key={i}>
            <Output value={v} depth={depth + 1} label={`${label} ${i + 1}`} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <dl className="dash-kv">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            <Output value={v} depth={depth + 1} label={k} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ rows, depth, label }: { rows: Record<string, unknown>[]; depth: number; label: string }) {
  const columns = tableColumns(rows);
  return (
    <div className="dash-table-wrap">
      <table className="dash-table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_ROWS).map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{c in row ? <Output value={row[c]} depth={depth + 1} label={c} /> : null}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && <div className="tests-note">Showing the first {MAX_ROWS} of {rows.length} rows.</div>}
    </div>
  );
}

/** One value, with a button that copies it (a login is read out of here, not retyped). */
function Scalar({ value, label }: { value: string | number | boolean | null; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);
  if (value === null) return <span className="json-null">null</span>;
  const text = String(value);
  return (
    <span className="dash-scalar">
      <span className="dash-text">{text}</span>
      {text !== "" && (
        <button className="ghost dash-copy" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})}>
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </span>
  );
}

// MARK: - The history

export function HistoryPanel({ folder, file, formId, title, runs }: { folder: string; file: string; formId: string; title?: string; runs: DashboardRunSummary[] }) {
  const mine = runs.filter((r) => r.file === file && r.form === formId);
  const [open, setOpen] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const detail = useRunDetail(folder, open);
  return (
    <section className="dash-panel dash-history" aria-label={title ?? "History"}>
      <div className="dash-title-row">
        <h3 className="dash-title">{title ?? "History"}</h3>
        {mine.length > 0 && (
          <button className="ghost dash-clear" onClick={() => setClearing(true)}>
            Clear
          </button>
        )}
      </div>
      {mine.length === 0 && <div className="tests-note">No runs yet.</div>}
      <ul className="dash-runs">
        {mine.map((r) => {
          const status = runStatus(r);
          const summary = summarizeInputs(r.inputs);
          return (
            <li key={r.id} className={open === r.id ? "open" : ""}>
              <div className="dash-run-row">
                <button className="dash-run-open" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <span className="chev" aria-hidden />
                  <span className={`dash-status ${status.tone}`}>{status.label}</span>
                  <span className="dash-run-inputs">{summary || "no input"}</span>
                  <span className="dash-run-meta">{relativeTime(r.started_at)}</span>
                </button>
                <button className="ghost dash-delete" aria-label="Delete this run" title="Delete this run" onClick={() => void api.dashboardDeleteRun(folder, r.id)}>
                  ×
                </button>
              </div>
              {open === r.id && (detail ? <RunView run={detail} /> : <div className="tests-note">{detail === null ? "That run is gone." : "Loading…"}</div>)}
            </li>
          );
        })}
      </ul>
      {clearing && (
        <ConfirmDialog
          title="Clear this history?"
          confirmLabel="Clear"
          busyLabel="Clearing…"
          busy={false}
          onCancel={() => setClearing(false)}
          onConfirm={() => {
            setClearing(false);
            setOpen(null);
            void api.dashboardClearRuns(folder, file, formId);
          }}
        >
          <p>
            {mine.length === 1 ? "The one run" : `All ${mine.length} runs`} kept for this form will be deleted, with what {mine.length === 1 ? "it" : "they"} printed. Logins in them are gone too.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
