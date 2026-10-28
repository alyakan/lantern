import { useEffect, useRef, useState } from "react";
import { usePopover } from "../lib/usePopover";
import { useChatState, useNodeActions } from "../lib/canvasContext";
import { modelChoicesFor } from "../lib/models";
import { providerChoicesForAgents, providerIdOf, providerName, useProviders } from "../lib/provider";
import { useRoleStore } from "../lib/roleStore";
import { agentName, allRoles, BUILTIN_ROLES, briefFor, roleId, TASK_MARK, type Role } from "../lib/roles";
import type { NewWorker } from "../types";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

const EMPTY: Form = { roleId: "", task: "", name: "", brief: null, isolation: "worktree", model: null, readOnly: false, provider: null };
interface Form {
  /** The role chosen ("": none, a blank brief). */
  roleId: string;
  /** With a role: what it should work on, which goes into the role's brief. With none: the whole brief. */
  task: string;
  name: string;
  /** The brief as the user rewrote it; null while it is still the role's, with the task in it. */
  brief: string | null;
  isolation: NewWorker["isolation"];
  /** Null: the provider's default, which is also what "Default" in the list means. */
  model: string | null;
  /** With a role: its editing tools are switched off. */
  readOnly: boolean;
  /** Null: the main agent's own provider, as the backend defaults. */
  provider: string | null;
}

/** What a role fills the form with. */
const fromRole = (role: Role | undefined): Partial<Form> =>
  role ? { roleId: role.id, brief: null, isolation: role.isolation, model: role.model, readOnly: role.readOnly || role.isolation === "shared" } : { roleId: "", brief: null, isolation: "worktree", model: null, readOnly: false };

/**
 * "+ Agent": the user starts a worker themselves, without asking the main agent to. A small form opens over the canvas
 * (a role, the task, an optional name, where it works, and which model); the worker is started exactly as the main agent's would
 * be, so whatever stops that (the limit on workers, no git for a worktree) is said here, in the form.
 * A role (a Reviewer, a Builder…) fills in the brief, model, place and access, all still editable; the user can save the form as a
 * role of their own for the project, update it and delete it.
 * `shown`: another control (the canvas's "⋯" menu) opens the form, so there is no button here and that decides when it is open.
 */
export function NewAgent({ main, shown }: { main: string; shown?: { open: boolean; setOpen: (open: boolean) => void } }) {
  const actions = useNodeActions();
  const store = useRoleStore();
  const folder = useChatState(main)?.folder ?? null;
  const custom = store.roles(folder);
  const roles = allRoles(custom);
  const [openOwn, setOpenOwn] = useState(false);
  const open = shown ? shown.open : openOwn;
  const setOpen = shown ? shown.setOpen : setOpenOwn;
  const [form, setForm] = useState<Form>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Saving the form as a role: the name being typed. */
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // With more than one provider the worker can run on another one than its main agent: the provider comes first, and the
  // models listed are that provider's. Its own (the main agent's) is what it runs on if nothing is chosen.
  // (Not an endpoint the user set up: an agent running on one comes with mixed teams.)
  const all = useProviders();
  const agentProviders = providerChoicesForAgents(all.list);
  const providers = { list: agentProviders, multi: agentProviders.length > 1 };
  const own = providerIdOf(useChatState(main)?.provider);
  const provider = form.provider ?? own;
  const choices = modelChoicesFor(provider, providers.list.find((p) => p.id === provider)?.models ?? [], providerName(provider));
  const task = useRef<HTMLTextAreaElement>(null);
  const { box, button, id } = usePopover(open, () => !busy && setOpen(false), false);
  useEffect(() => {
    if (open) task.current?.focus();
  }, [open]);

  const role = roles.find((r) => r.id === form.roleId);
  const ownRole = custom.find((r) => r.id === form.roleId);
  const shared = form.isolation === "shared";
  /** What the agent is told: the role's brief with the task in it, unless the user rewrote it. */
  const brief = role ? (form.brief ?? briefFor(role, form.task.trim() || "(your task)")) : form.task;
  const set = (change: Partial<Form>) => setForm((f) => ({ ...f, ...change }));
  const pick = (roleId: string) => {
    setSaving(null);
    setDeleting(false);
    set(fromRole(roles.find((r) => r.id === roleId)));
  };
  const submit = () => {
    if (busy) return;
    if (!form.task.trim()) {
      setProblem("Say what the agent should do.");
      task.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    const named = form.name.trim() || (role ? agentName(role, form.task) : null);
    actions
      .spawn(main, { task: brief.trim(), name: named, isolation: form.isolation, model: form.model, ...(provider !== own ? { provider } : {}), ...(role ? { role: { id: role.id, label: role.label, read_only: form.readOnly || shared } } : {}) })
      .then(
        () => {
          setOpen(false);
          setForm(EMPTY);
          setSaving(null);
        },
        (e) => setProblem(errText(e)),
      )
      .finally(() => setBusy(false));
  };

  // The form as a role: its brief with the task's place marked. A role the user rewrote the brief of keeps their words (the
  // task they typed goes back to being its place); with no role, what they wrote as the task is the brief.
  const template = (): string => {
    const typed = form.task.trim();
    if (!role) return typed;
    if (form.brief === null) return role.brief;
    return typed && form.brief.includes(typed) ? form.brief.replace(typed, TASK_MARK) : form.brief;
  };
  const saveRole = () => {
    const label = (saving ?? "").trim();
    if (!folder) return;
    if (!label) return setProblem("Give the role a name.");
    if (!template().trim()) return setProblem("Write the brief first: it is what the role tells an agent.");
    const updating = ownRole && ownRole.label === label ? ownRole : undefined;
    const saved: Role = {
      id: updating?.id ?? roleId(label, roles.map((r) => r.id)),
      label,
      description: updating?.description ?? "",
      brief: template(),
      model: form.model ?? "sonnet",
      isolation: form.isolation,
      readOnly: role ? form.readOnly || shared : shared,
    };
    store.saveRole(folder, saved);
    setProblem(null);
    setSaving(null);
    // The saved role is what the form is now; with no role before, the task was the whole brief, which is now the role's.
    set({ ...fromRole(saved), ...(role ? {} : { task: "" }) });
  };
  const deleteRole = () => {
    if (!folder || !ownRole) return;
    store.deleteRole(folder, ownRole.id);
    setDeleting(false);
    pick("");
  };

  return (
    <div className="canvas-team" ref={box}>
      {!shown && (
        <button ref={button} className="canvas-fit" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} title="Start an agent yourself" onClick={() => setOpen(!open)}>
          + Agent
        </button>
      )}
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
            Role
            <select value={form.roleId} onChange={(e) => pick(e.target.value)}>
              <option value="">No role · a blank brief</option>
              <optgroup label="Built in">
                {BUILTIN_ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </optgroup>
              {custom.length > 0 && (
                <optgroup label="Your roles">
                  {custom.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {role && <p className="new-agent-hint">{role.description || "One of your roles."}</p>}
          <label>
            Task
            <textarea
              ref={task}
              rows={role ? 2 : 4}
              value={form.task}
              placeholder={role ? "What should it work on? For example: the login form." : "What should it do? This is the brief it starts from."}
              aria-required
              aria-invalid={!!problem && !form.task.trim()}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => set({ task: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          {role && (
            <label>
              Brief <span className="new-agent-optional">what it is told; you can change it</span>
              <textarea className="new-agent-brief" rows={7} value={brief} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => set({ brief: e.target.value })} />
            </label>
          )}
          <label>
            Name <span className="new-agent-optional">optional</span>
            <input value={form.name} maxLength={60} placeholder={role ? agentName(role, form.task) : "Named from the task"} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <fieldset>
            <legend>Where it works</legend>
            <label className="new-agent-choice">
              <input type="radio" name="isolation" checked={form.isolation === "worktree"} onChange={() => set({ isolation: "worktree", readOnly: role?.readOnly ?? false })} />
              Own worktree
            </label>
            <label className="new-agent-choice">
              <input type="radio" name="isolation" checked={form.isolation === "shared"} onChange={() => set({ isolation: "shared", readOnly: true })} />
              Shared folder
            </label>
            <p className="new-agent-hint">Shared is for work that writes nothing: it reads your folder as it is.</p>
          </fieldset>
          {role && (
            <fieldset>
              <legend>What it may do</legend>
              <label className="new-agent-choice">
                <input type="radio" name="access" checked={!form.readOnly && !shared} disabled={shared} onChange={() => set({ readOnly: false })} />
                Can edit
              </label>
              <label className="new-agent-choice">
                <input type="radio" name="access" checked={form.readOnly || shared} onChange={() => set({ readOnly: true })} />
                Read only
              </label>
              <p className="new-agent-hint">Read only gives it just the tools that read files, plus read-only git: it can look and report but not change files or run other commands.</p>
            </fieldset>
          )}
          {providers.multi && (
            <label>
              Runs on
              <select value={provider} onChange={(e) => set({ provider: e.target.value, model: null })}>
                {providers.list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {providerName(p.id)}
                    {p.id === own ? " · the Lead's" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Model
            <select value={form.model ?? ""} onChange={(e) => set({ model: e.target.value || null })}>
              {choices.map((m) => (
                <option key={m.value ?? "default"} value={m.value ?? ""}>
                  {m.label} · {m.hint}
                </option>
              ))}
            </select>
          </label>
          {folder && saving === null && !deleting && (
            <div className="new-agent-roles">
              <button type="button" className="link-button" onClick={() => setSaving(ownRole?.label ?? "")}>
                Save as a role…
              </button>
              {ownRole && (
                <button type="button" className="link-button" onClick={() => setDeleting(true)}>
                  Delete this role
                </button>
              )}
            </div>
          )}
          {saving !== null && (
            <div className="new-agent-save" role="group" aria-label="Save as a role">
              <input
                autoFocus
                value={saving}
                maxLength={60}
                aria-label="Role name"
                placeholder="Name this role, such as API reviewer"
                onChange={(e) => setSaving(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveRole();
                  } else if (e.key === "Escape") {
                    // The popover would close the whole form: this only closes the name.
                    e.stopPropagation();
                    setSaving(null);
                  }
                }}
              />
              <button type="button" onClick={saveRole}>
                Save role
              </button>
              <button type="button" onClick={() => setSaving(null)}>
                Cancel
              </button>
              {ownRole && <p className="new-agent-hint">With the same name it replaces “{ownRole.label}”; with another it is a new role.</p>}
            </div>
          )}
          {deleting && ownRole && (
            <div className="new-agent-save" role="group" aria-label="Delete this role">
              <p className="new-agent-hint">Delete “{ownRole.label}”? Agents already started in it keep going; a team template that names it skips it.</p>
              <button type="button" className="danger" onClick={deleteRole}>
                Delete role
              </button>
              <button type="button" onClick={() => setDeleting(false)}>
                Keep it
              </button>
            </div>
          )}
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
