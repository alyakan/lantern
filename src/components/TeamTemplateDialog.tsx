import { useEffect, useId, useRef, useState } from "react";
import { useRoleStore } from "../lib/roleStore";
import { accessLabel, allRoles, BUILTIN_TEMPLATES, membersOf, roleId, type TeamTemplate } from "../lib/roles";

interface Props {
  folder: string;
  /** The user chose a template and said what the team is for: a Lead starts with it. */
  onStart: (template: TeamTemplate, task: string) => void;
  onClose: () => void;
}

/** "Builder, Reviewer and QA / tester". */
const names = (labels: string[]) => (labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`);

/**
 * "Team from a template": the built-in teams (Build and review, Build, review and test) and the project's own, to start a
 * team whose Lead is told to start each member in its role. The user's own templates are a named list of roles, which can be
 * saved here and deleted.
 */
export function TeamTemplateDialog({ folder, onStart, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const store = useRoleStore();
  const templates = store.templates(folder);
  const roles = allRoles(store.roles(folder));
  const [chosen, setChosen] = useState(templates[0]?.id ?? "");
  const [task, setTask] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  /** A new template being made: its name and the roles ticked. */
  const [making, setMaking] = useState<{ name: string; members: string[] } | null>(null);
  const taskBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
    taskBox.current?.focus();
  }, []);

  const template = templates.find((t) => t.id === chosen);
  const start = () => {
    if (!template) return setProblem("Choose a template.");
    if (!task.trim()) {
      setProblem("Say what the team should do.");
      taskBox.current?.focus();
      return;
    }
    onStart(template, task.trim());
  };
  const saveTemplate = () => {
    if (!making) return;
    const label = making.name.trim();
    if (!label) return setProblem("Give the template a name.");
    if (making.members.length === 0) return setProblem("Tick at least one role.");
    const saved: TeamTemplate = { id: roleId(label, templates.map((t) => t.id)), label, description: `A Lead and ${names(making.members.flatMap((id) => roles.find((r) => r.id === id)?.label ?? []))}.`, members: making.members };
    store.saveTemplate(folder, saved);
    setChosen(saved.id);
    setMaking(null);
    setProblem(null);
  };
  const isBuiltIn = (id: string) => BUILTIN_TEMPLATES.some((t) => t.id === id);

  return (
    <dialog
      ref={ref}
      className="revert-dialog bring-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        className="revert-body"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="revert-title" id={titleId}>
          Team from a template
        </div>
        <p className="mode-hint">A Lead starts the agents of the template, each in its role, and gives them their work.</p>
        <fieldset className="template-list">
          <legend className="mode-hint">Template</legend>
          {templates.map((t) => (
            <div key={t.id} className="template-row">
              <label className="template-choice">
                <input type="radio" name="template" checked={chosen === t.id} onChange={() => setChosen(t.id)} />
                <span className="mode-text">
                  <span className="menu-row-title">{t.label}</span>
                  <span className="mode-hint">{names(membersOf(t, store.roles(folder)).map((r) => `${r.label}${r.readOnly ? " (read only)" : ""}`)) || "No roles left in it"}</span>
                </span>
              </label>
              {!isBuiltIn(t.id) && (
                <button
                  type="button"
                  className="icon"
                  aria-label={`Delete the template ${t.label}`}
                  title="Delete this template"
                  onClick={() => {
                    store.deleteTemplate(folder, t.id);
                    if (chosen === t.id) setChosen(templates[0].id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </fieldset>
        <label className="template-task">
          <span className="mode-hint">What should the team do?</span>
          <textarea
            ref={taskBox}
            rows={3}
            value={task}
            aria-label="What the team should do"
            aria-required
            aria-invalid={!!problem && !task.trim()}
            placeholder="For example: add a dark mode toggle to the settings page."
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                start();
              }
            }}
          />
        </label>
        {making ? (
          <fieldset className="template-make" aria-label="New template">
            <input
              autoFocus
              value={making.name}
              maxLength={60}
              aria-label="Template name"
              placeholder="Name this template, such as Build and audit"
              onChange={(e) => setMaking({ ...making, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveTemplate();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setMaking(null);
                }
              }}
            />
            <div className="template-roles">
              {roles.map((r) => (
                <label key={r.id} className="template-role">
                  <input
                    type="checkbox"
                    checked={making.members.includes(r.id)}
                    onChange={(e) => setMaking({ ...making, members: e.target.checked ? [...making.members, r.id] : making.members.filter((m) => m !== r.id) })}
                  />
                  {r.label} <span className="mode-hint">{accessLabel(r.readOnly)}</span>
                </label>
              ))}
            </div>
            <div className="template-make-actions">
              <button type="button" onClick={saveTemplate}>
                Save template
              </button>
              <button type="button" onClick={() => setMaking(null)}>
                Cancel
              </button>
            </div>
          </fieldset>
        ) : (
          <button type="button" className="link-button template-new" onClick={() => setMaking({ name: "", members: [] })}>
            Make a template of your own…
          </button>
        )}
        {problem && (
          <div className="revert-error" role="alert">
            {problem}
          </div>
        )}
        <div className="revert-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Start team
          </button>
        </div>
      </form>
    </dialog>
  );
}
