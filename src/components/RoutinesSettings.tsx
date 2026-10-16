import { useEffect, useState } from "react";
import { MODEL_CHOICES } from "../lib/models";
import {
  DAY_NAMES,
  DEFAULT_MODEL,
  DEFAULT_SCHEDULE,
  MAX_PROMPT,
  MAX_ROUTINES,
  MIN_EVERY_MINUTES,
  describeSchedule,
  inProgress,
  outcomeText,
  when,
  type Routine,
  type Run,
  type Schedule,
} from "../lib/routines";
import type { Draft, Routines } from "../lib/useRoutines";
import { basename } from "../lib/diff";

export interface RoutinesSettingsProps extends Pick<Routines, "routines" | "add" | "edit" | "remove" | "enable" | "pause" | "runNow"> {
  /** The projects a routine can run in (the sidebar's), read when the page opens. */
  loadProjects: () => Promise<{ folder: string; label: string }[]>;
  /** Keep the Mac awake while Claude works: the same setting as General's. */
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
  /** Opens the chat of a run (the sidebar's chat if it is open, else the past chat). */
  onOpenChat: (sessionId: string, folder: string) => void;
}

/** The form's fields; the schedule is made from the ones its kind uses. */
interface Fields {
  name: string;
  folder: string;
  prompt: string;
  kind: Schedule["kind"];
  every: number;
  unit: "minutes" | "hours";
  at: string;
  day: number;
  permissions: Draft["permissions"];
  model: string | null;
}

const scheduleOf = (f: Fields): Schedule =>
  f.kind === "every" ? { kind: "every", every: f.every, unit: f.unit } : f.kind === "weekly" ? { kind: "weekly", day: f.day, at: f.at } : { kind: f.kind, at: f.at };

function fieldsOf(r: Routine | null, folder: string): Fields {
  const s: Schedule = r?.schedule ?? DEFAULT_SCHEDULE;
  return {
    name: r?.name ?? "",
    folder: r?.folder ?? folder,
    prompt: r?.prompt ?? "",
    kind: s.kind,
    every: s.kind === "every" ? s.every : 1,
    unit: s.kind === "every" ? s.unit : "hours",
    at: s.kind === "every" ? "09:00" : s.at,
    day: s.kind === "weekly" ? s.day : 1,
    permissions: r?.permissions ?? "ask",
    model: r ? r.model : DEFAULT_MODEL,
  };
}

const KINDS: [Schedule["kind"], string][] = [
  ["every", "Every few minutes or hours"],
  ["daily", "Every day"],
  ["weekdays", "Every weekday (Monday to Friday)"],
  ["weekly", "Every week"],
];

/** Settings → Routines: prompts Lantern sends by itself, at set times, while it is open. */
export function RoutinesSettings({ routines, add, edit, remove, enable, pause, runNow, loadProjects, keepAwake, onKeepAwake, onOpenChat }: RoutinesSettingsProps) {
  const [projects, setProjects] = useState<{ folder: string; label: string }[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});
  // The page's own clock: what is "Next: 9:00 AM" or "Paused until" changes as time goes by.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let live = true;
    loadProjects().then(
      (list) => live && setProjects(list),
      () => live && setProjects([]),
    );
    return () => {
      live = false;
    };
  }, []);

  const full = routines.length >= MAX_ROUTINES;
  const start = (id: string) => {
    setNow(Date.now());
    const problem = runNow(id);
    setSaid((all) => ({ ...all, [id]: problem ?? "" }));
  };

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Routines</h2>
          <p className="mode-guide-summary">
            A prompt Lantern sends by itself, at times you pick, in a new chat of a project: for example “every weekday at 9, check the open TODOs and tell me what changed since yesterday”. Each run is a normal chat. It shows in the sidebar,
            and anything Claude needs to ask waits in your inbox.
          </p>
        </div>
        <button className="primary" onClick={() => setEditing("new")} disabled={full || editing === "new"} title={full ? `There can be ${MAX_ROUTINES} routines at most.` : undefined}>
          New routine
        </button>
      </div>
      <div className="settings-notice routine-limit">
        <span>Routines run only while Lantern is open and your Mac is awake. A run that was due while Lantern was closed or the Mac was asleep is not made up: it shows as missed, and you can run it yourself.</span>
      </div>
      <label className="general-option">
        <input type="checkbox" checked={keepAwake} onChange={(e) => onKeepAwake(e.target.checked)} />
        <span>Keep my Mac awake while Claude works</span>
      </label>
      <span className="settings-muted">This only holds while a routine (or any chat) is working. Between runs the Mac can still go to sleep, and a run due then is missed. The sidebar chats and your inbox show what a routine did.</span>
      {editing === "new" && (
        <RoutineForm
          key="new"
          initial={null}
          projects={projects ?? []}
          onSave={(draft) => {
            const problem = add(draft);
            if (!problem) setEditing(null);
            return problem;
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {routines.length === 0 && editing !== "new" && (
        <div className="settings-empty">
          <p className="mode-guide-summary">No routines yet. Choose New routine to set one up.</p>
        </div>
      )}
      <ul className="settings-list" aria-label="Routines">
        {routines.map((r) => {
          const expanded = open === r.id;
          const paused = r.pausedUntil !== null && r.pausedUntil > now;
          const last = r.runs[0];
          return (
            <li key={r.id} className="settings-row routine-row">
              <div className="routine-head">
                <button className="settings-row-main" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                  <span className="settings-row-text">
                    <span className="settings-row-name">{r.name}</span>
                    <span className="settings-row-sub">
                      {describeSchedule(r.schedule)} · {basename(r.folder)}
                    </span>
                    <span className="settings-row-sub">{nextLine(r, paused, now)}</span>
                  </span>
                  {last && <RunStatus run={last} now={now} />}
                </button>
                <button className="routine-run" onClick={() => start(r.id)} aria-label={`Run ${r.name} now`}>
                  Run now
                </button>
                <label className="routine-switch">
                  <input type="checkbox" role="switch" aria-label={`${r.name} is on`} checked={r.enabled} onChange={(e) => enable(r.id, e.target.checked)} />
                  <span>{r.enabled ? "On" : "Off"}</span>
                </label>
              </div>
              {said[r.id] && (
                <div className="routine-said settings-muted" role="status">
                  {said[r.id]}
                </div>
              )}
              {expanded &&
                (editing === r.id ? (
                  <RoutineForm
                    key={r.id}
                    initial={r}
                    projects={projects ?? []}
                    onSave={(draft) => {
                      const problem = edit(r.id, draft);
                      if (!problem) setEditing(null);
                      return problem;
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <RoutineDetails routine={r} paused={paused} now={now} onEdit={() => setEditing(r.id)} onPause={(on) => pause(r.id, on)} onRemove={() => remove(r.id)} onOpenChat={onOpenChat} />
                ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** When a routine runs next, or why it won't. */
function nextLine(r: Routine, paused: boolean, now: number): string {
  if (!r.enabled) return "Off";
  if (paused) return `Paused until ${when(r.pausedUntil!, now)}`;
  return r.nextAt === null ? "Starting soon" : `Next: ${when(r.nextAt, now)}`;
}

/** How a run went, as a dot and a few words ("Finished", "Missed 9:00 AM"). */
function RunStatus({ run, now }: { run: Run; now: number }) {
  const tone = run.outcome === "done" ? "ok" : run.outcome === "failed" ? "bad" : run.outcome === "stopped" ? "" : "warn";
  return (
    <span className={`mcp-status routine-status ${tone}`}>
      <span className="mcp-dot" />
      {outcomeText(run, now)}
    </span>
  );
}

function RoutineDetails({ routine, paused, now, onEdit, onPause, onRemove, onOpenChat }: { routine: Routine; paused: boolean; now: number; onEdit: () => void; onPause: (on: boolean) => void; onRemove: () => void; onOpenChat: RoutinesSettingsProps["onOpenChat"] }) {
  const [sure, setSure] = useState(false);
  const model = MODEL_CHOICES.find((m) => m.value === routine.model)?.label ?? routine.model;
  return (
    <div className="routine-details">
      <p className="routine-prompt">{routine.prompt}</p>
      <span className="settings-muted">
        {routine.permissions === "auto" ? "Auto: acts without asking" : "Ask: asks before acting"} · {model ?? "Default"} · {routine.folder}
      </span>
      <div className="mcp-detail-actions">
        <button onClick={onEdit}>Edit</button>
        <button onClick={() => onPause(!paused)} disabled={!routine.enabled}>
          {paused ? "Resume" : "Pause for 1 hour"}
        </button>
        {sure ? (
          <>
            <button className="danger" onClick={onRemove}>
              Delete for good
            </button>
            <button onClick={() => setSure(false)}>Keep it</button>
          </>
        ) : (
          <button className="danger" onClick={() => setSure(true)}>
            Delete routine
          </button>
        )}
      </div>
      <h3 className="general-title">Last runs</h3>
      {routine.runs.length === 0 ? (
        <span className="settings-muted">Not run yet.</span>
      ) : (
        <ul className="routine-runs" aria-label={`Last runs of ${routine.name}`}>
          {routine.runs.map((run) => (
            <li key={`${run.at}-${run.outcome}`} className="routine-run-row">
              <span className="routine-run-time">{run.outcome === "missed" ? "" : when(run.at, now)}</span>
              <RunStatus run={run} now={now} />
              {run.manual && <span className="settings-muted">run by you</span>}
              {run.sessionId && (
                <button className="ghost" onClick={() => onOpenChat(run.sessionId!, routine.folder)} aria-label={`Open the chat of the ${inProgress(run) ? "running" : when(run.at, now)} run`}>
                  Open chat
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutineForm({ initial, projects, onSave, onCancel }: { initial: Routine | null; projects: { folder: string; label: string }[]; onSave: (draft: Draft) => string | null; onCancel: () => void }) {
  const [f, setF] = useState<Fields>(() => fieldsOf(initial, projects[0]?.folder ?? ""));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<Fields>) => setF((all) => ({ ...all, ...patch }));
  // The projects arrive after the page opens: a new routine starts on the first of them.
  useEffect(() => {
    if (!f.folder && projects[0]) set({ folder: projects[0].folder });
  }, [projects]);
  const folders = projects.some((p) => p.folder === f.folder) || !f.folder ? projects : [{ folder: f.folder, label: basename(f.folder) }, ...projects];
  const submit = () => setProblem(onSave({ name: f.name, folder: f.folder, prompt: f.prompt, schedule: scheduleOf(f), permissions: f.permissions, model: f.model }));
  const timed = f.kind !== "every";
  return (
    <form
      className="harness-editor routine-editor"
      aria-label={initial ? `Edit ${initial.name}` : "New routine"}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="wide">
        Name
        <input value={f.name} maxLength={60} placeholder="Morning TODOs" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="wide">
        Project
        <select value={f.folder} onChange={(e) => set({ folder: e.target.value })}>
          {folders.length === 0 && <option value="">No projects yet: open one first</option>}
          {folders.map((p) => (
            <option key={p.folder} value={p.folder}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        What should Claude do?
        <textarea value={f.prompt} rows={4} maxLength={MAX_PROMPT} placeholder="Check the open TODOs and summarise what changed since yesterday" onChange={(e) => set({ prompt: e.target.value })} />
      </label>
      <label className="wide">
        How often
        <select value={f.kind} onChange={(e) => set({ kind: e.target.value as Schedule["kind"] })}>
          {KINDS.map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {f.kind === "every" && (
        <>
          <label>
            Every
            <input type="number" min={1} max={999} value={f.every} onChange={(e) => set({ every: Math.floor(Number(e.target.value)) })} />
          </label>
          <label>
            Minutes or hours
            <select value={f.unit} onChange={(e) => set({ unit: e.target.value as "minutes" | "hours" })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </label>
          <p className="settings-muted wide">The shortest gap is {MIN_EVERY_MINUTES} minutes: every run is a whole chat on your plan.</p>
        </>
      )}
      {f.kind === "weekly" && (
        <label>
          On
          <select value={f.day} onChange={(e) => set({ day: Number(e.target.value) })}>
            {DAY_NAMES.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}
      {timed && (
        <label>
          At
          <input type="time" value={f.at} onChange={(e) => set({ at: e.target.value })} />
        </label>
      )}
      <label>
        Permissions
        <select value={f.permissions} onChange={(e) => set({ permissions: e.target.value === "auto" ? "auto" : "ask" })}>
          <option value="ask">Ask (recommended)</option>
          <option value="auto">Auto</option>
        </select>
      </label>
      <label>
        Model
        <select value={f.model ?? ""} onChange={(e) => set({ model: e.target.value || null })}>
          {MODEL_CHOICES.map((m) => (
            <option key={m.label} value={m.value ?? ""}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {f.permissions === "auto" ? (
        <p className="settings-error wide" role="note">
          Auto means Claude will do whatever it decides to, such as change files and run commands, without asking you first, and a routine runs while you may be away. Only choose it for a prompt you trust in a project you have backed up.
        </p>
      ) : (
        <p className="settings-muted wide">With Ask, Claude stops and asks before each change or command. The question waits in your inbox until you are back.</p>
      )}
      {problem && (
        <p className="settings-error wide" role="alert">
          {problem}
        </p>
      )}
      <div className="wide mcp-detail-actions">
        <button type="submit" className="primary">
          {initial ? "Save" : "Add routine"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
