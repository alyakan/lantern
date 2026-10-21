import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { commandLine } from "../lib/dashboard";
import type { Dashboard, DashboardCommand, DashboardState } from "../types";
import { FormPanel, HistoryPanel, ResultPanel } from "./DashboardPanels";
import { TabEmpty } from "./TabEmpty";

interface Loaded {
  folder: string;
  list: Dashboard[];
  state: DashboardState;
  /** Counts the reads, so what shows a list kept by the backend knows to look again. */
  stamp: number;
}

/**
 * The folder's dashboards and what is known about them (trusted, running, past runs). Read when the tab opens, whenever the
 * backend says something changed, when the window comes back to the front (the files may have been edited meanwhile) and when
 * `refreshKey` changes (a turn ended, so Claude may have written one).
 */
export function useDashboards(folder: string, refreshKey: number) {
  const [data, setData] = useState<Loaded | null>(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    const mine = ++latest.current;
    // A slower, older read never lands over a newer one.
    Promise.all([api.dashboardsList(folder), api.dashboardsState(folder)]).then(
      ([list, state]) => latest.current === mine && setData({ folder, list, state, stamp: mine }),
      () => {},
    );
  }, [folder]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  useEffect(() => {
    // Outside the app (tests, a browser) there are no events to listen to.
    const unlisten = api.onDashboardsChanged(load).catch(() => null);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      unlisten.then((f) => f?.());
    };
  }, [load]);
  return { data: data?.folder === folder ? data : null, reload: load };
}

export function DashboardTab({ folder, refreshKey }: { folder: string; refreshKey: number }) {
  const { data, reload } = useDashboards(folder, refreshKey);
  const [picked, setPicked] = useState<string | null>(null);
  // Counts the presses of Reload: a form's options that a command loads are asked for again, not only the files read again.
  const [reloads, setReloads] = useState(0);
  if (!data) return <div className="tests-note dash-loading">Loading…</div>;
  if (data.list.length === 0) return <DashboardEmpty />;
  const current = data.list.find((d) => d.file === picked) ?? data.list[0];
  const title = (d: Dashboard) => d.spec?.title ?? d.file;
  return (
    <>
      <div className="review-bar dash-bar">
        {data.list.length > 1 ? (
          <select className="dash-pick" aria-label="Dashboard" value={current.file} onChange={(e) => setPicked(e.target.value)}>
            {data.list.map((d) => (
              <option key={d.file} value={d.file}>
                {title(d)}
              </option>
            ))}
          </select>
        ) : (
          <span className="dash-bar-title">{title(current)}</span>
        )}
        <span className="dash-bar-file">{current.file}</span>
        <div className="spacer" />
        <button
          className="ghost"
          onClick={() => {
            setReloads((n) => n + 1);
            reload();
          }}
          title="Read the dashboard files again, and ask for the options a command loads again"
        >
          Reload
        </button>
      </div>
      <div className="dash-body">
        <Shown key={`${folder}\n${current.file}`} folder={folder} dashboard={current} state={data.state} reloads={reloads} stamp={data.stamp} />
      </div>
    </>
  );
}

function DashboardEmpty() {
  return (
    <TabEmpty title="Dashboard">
      <p>A dashboard is a small admin screen for this project: a form whose button runs a command, the result of the last run, and a history of runs.</p>
      <p>Ask Claude to build one (for example, “make a dashboard that creates a test org on staging with my script”). It is saved in .lantern/dashboards/ in this folder, and shows up here.</p>
    </TabEmpty>
  );
}

/** One dashboard: what is wrong with its file, or the trust card, or its panels. */
function Shown({ folder, dashboard, state, reloads, stamp }: { folder: string; dashboard: Dashboard; state: DashboardState; reloads: number; stamp: number }) {
  if (!dashboard.spec) return <Problems dashboard={dashboard} />;
  if (!state.trusted.includes(dashboard.hash)) return <TrustCard key={dashboard.hash} folder={folder} dashboard={dashboard} />;
  const file = dashboard.file;
  const isRunning = (form: string) => state.running.some((r) => r.file === file && r.form === form);
  return (
    <>
      {dashboard.spec.panels.map((p, i) => {
        if (p.type === "form") return <FormPanel key={`${i}-${p.id}`} folder={folder} file={file} form={p} running={isRunning(p.id)} reload={reloads} stamp={stamp} />;
        if (p.type === "result") return <ResultPanel key={i} folder={folder} file={file} formId={p.of} title={p.title} runs={state.runs} running={isRunning(p.of)} />;
        return <HistoryPanel key={i} folder={folder} file={file} formId={p.of} title={p.title} runs={state.runs} />;
      })}
    </>
  );
}

/** A file that isn't a dashboard (yet): each problem, where it is in the file, in the file's own words. */
function Problems({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="dash-panel dash-problems" aria-label="Problems">
      <h3 className="dash-title">{dashboard.file} has problems</h3>
      <ul>
        {dashboard.issues.map((issue, i) => (
          <li key={i}>
            {issue.path && <code>{issue.path}</code>} {issue.message}
          </li>
        ))}
      </ul>
      <p className="tests-note">Ask Claude to fix it, or edit the file in the Files tab. This page reads it again when you come back.</p>
    </section>
  );
}

/**
 * Before a dashboard's buttons work: what each of its forms would run, as Lantern will run it (the program found on disk, `~`
 * as your home folder). Trusting is for this exact file; any edit asks again. What the commands themselves do is not checked.
 */
function TrustCard({ folder, dashboard }: { folder: string; dashboard: Dashboard }) {
  const [commands, setCommands] = useState<DashboardCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.dashboardCommands(folder, dashboard.file).then(
      (c) => live && setCommands(c),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [folder, dashboard.file, dashboard.hash]);
  const trust = () => {
    setBusy(true);
    setError(null);
    api
      .dashboardTrust(folder, dashboard.file, dashboard.hash)
      .then(() => {
        // The card said these commands run now: fill in the lists the forms offer. A failure is shown by the field, with a Retry.
        // Only the lists that don't depend on a choice: one that does (a staging's addons) has no value to load for until it is chosen.
        for (const c of commands ?? []) if (c.kind === "options" && c.field && !c.depends_on?.length) api.dashboardLoadOptions(folder, dashboard.file, c.form, c.field, {}).catch(() => {});
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="dash-panel dash-trust" aria-label="Trust this dashboard">
      <h3 className="dash-title">Trust this dashboard?</h3>
      <p>
        <code>{dashboard.file}</code> is a file in this folder, and its buttons run the commands below on your Mac, as you. Read them first.
      </p>
      {commands === null && !error && <div className="tests-note">Reading its commands…</div>}
      {commands?.map((c) => (
        <div key={`${c.form}/${c.kind}/${c.field ?? ""}`} className="dash-trust-command">
          <div className="dash-trust-form">{c.kind === "options" ? `Loads the options of “${c.field}” in ${c.title ?? c.form}${c.depends_on?.length ? `, for the ${c.depends_on.join(" and ")} you pick, when you press Load options or Reload` : ", when you trust the dashboard and when you press Reload"}` : c.title ?? c.form}</div>
          <pre className="dash-command" aria-label={c.kind === "options" ? `Options command of ${c.field} in ${c.title ?? c.form}` : `Command of ${c.title ?? c.form}`}>
            {commandLine(c.command)}
          </pre>
          {c.program ? <div className="dash-trust-where">Runs {c.program}</div> : <div className="network-error">{c.error}</div>}
        </div>
      ))}
      {commands?.some((c) => c.kind === "options") && <p className="tests-note">A command that “Loads the options…” runs when you press Trust, and again when you press Reload or Retry on that list (never just because the tab opened), to fill in a list; it should only read.</p>}
      <p className="tests-note">Lantern checks this file, not the files its commands run: if a script they call changes, so does what runs. Any edit to the dashboard file asks you again.</p>
      {error && (
        <div className="network-error" role="alert">
          {error}
        </div>
      )}
      <div className="dash-actions">
        <button className="primary" disabled={busy || commands === null} onClick={trust}>
          {busy ? "Trusting…" : "Trust this dashboard"}
        </button>
      </div>
    </section>
  );
}
