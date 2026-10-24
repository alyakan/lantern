import { choiceOf, HOOK_MAX, withProjectHook, type Hook, type HookChoice, type HookKind, type HookTable } from "../lib/chatHooks";
import { projectLabels } from "../lib/sidebar";

export interface HooksSettingsProps {
  /** Every project Lantern knows (open now or in the recents). */
  folders: string[];
  /** The hooks as they are saved. */
  table: HookTable;
  onChange: (table: HookTable) => void;
}

const KINDS: { kind: HookKind; title: string; when: string; example: string }[] = [
  { kind: "pre", title: "Before", when: "Goes in front of your first message in a chat, and of the first one after the chat is compacted. Claude does it before answering you.", example: "Check the brain's summary about this project." },
  { kind: "post", title: "After", when: "Sent as a turn of its own each time Claude has answered a message. It isn't sent after a turn that failed or was stopped, after a slash command, or in Step by step.", example: "Update the brain if needed." },
];

const CHOICES: { choice: HookChoice; label: string }[] = [
  { choice: "workspace", label: "Same as everywhere" },
  { choice: "custom", label: "Its own" },
  { choice: "off", label: "None" },
];

/** Settings → Hooks: the two prompts Lantern runs around your messages, for every project and for one in particular. */
export function HooksSettings({ folders, table, onChange }: HooksSettingsProps) {
  const labels = projectLabels(folders);
  const setWorkspace = (kind: HookKind, hook: Hook) => onChange({ ...table, [kind]: hook });
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Hooks</h2>
          <p className="mode-guide-summary">Prompts Lantern runs around the messages you send, so you needn't type them each time. They are plain prompts: Claude uses whatever it can already do. Saved on this Mac, not in your files. A team's agents don't get them, only the chat you talk to.</p>
        </div>
      </div>
      <section className="general-section" aria-labelledby="hooks-everywhere">
        <h3 id="hooks-everywhere" className="general-title">
          Everywhere
        </h3>
        {KINDS.map(({ kind, title, when, example }) => (
          <div key={kind} className="hook-field">
            <label className="general-option">
              <input type="checkbox" checked={table[kind].on} onChange={(e) => setWorkspace(kind, { ...table[kind], on: e.target.checked })} />
              <span>{title}: {kind === "pre" ? "before a chat's first message" : "after Claude answers"}</span>
            </label>
            <span className="settings-row-sub">{when}</span>
            <textarea
              className="notes-field"
              aria-label={`${title} hook, everywhere`}
              placeholder={example}
              rows={3}
              maxLength={HOOK_MAX}
              spellCheck
              value={table[kind].text}
              onChange={(e) => setWorkspace(kind, { ...table[kind], text: e.target.value })}
            />
          </div>
        ))}
      </section>
      <section className="general-section" aria-labelledby="hooks-projects">
        <h3 id="hooks-projects" className="general-title">
          Projects
        </h3>
        <p className="settings-row-sub">A project can use its own hook in place of the one above, or none.</p>
        {folders.length === 0 ? (
          <div className="settings-muted">No projects yet.</div>
        ) : (
          <ul className="settings-list">
            {folders.map((folder, i) => (
              <li key={folder} className="settings-row hook-project">
                <span className="settings-row-name" title={folder}>
                  {labels[i]}
                </span>
                {KINDS.map(({ kind, title, example }) => {
                  const { choice, text } = choiceOf(table, folder, kind);
                  return (
                    <div key={kind} className="hook-project-kind">
                      <label className="pr-setting-tries">
                        <span>{title}</span>
                        <select aria-label={`${title} hook in ${labels[i]}`} value={choice} onChange={(e) => onChange(withProjectHook(table, folder, kind, e.target.value as HookChoice, text))}>
                          {CHOICES.map((c) => (
                            <option key={c.choice} value={c.choice}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {choice === "custom" && (
                        <textarea
                          className="notes-field"
                          aria-label={`${title} hook for ${labels[i]}`}
                          placeholder={example}
                          rows={3}
                          maxLength={HOOK_MAX}
                          spellCheck
                          value={text}
                          onChange={(e) => onChange(withProjectHook(table, folder, kind, "custom", e.target.value))}
                        />
                      )}
                    </div>
                  );
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
