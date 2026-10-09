import { useState } from "react";
import { BUILT_IN, DEFAULT_HARNESS, FAMILIES, FAMILY_LABEL, advisorsFor, familyOf, summary, usesFable, validAdvisor, type Harness } from "../lib/harness";
import { EFFORT_LEVELS, effortLabel } from "./EffortPicker";

export interface HarnessSettingsProps {
  /** Every preset but Default, as saved (built-ins as edited, then your own). */
  saved: Harness[];
  onSave: (presets: Harness[]) => void;
  /** The folder on screen, and the preset its chats start with. */
  folder: string | null;
  folderDefault: string;
  onFolderDefault: (id: string) => void;
  /** What claude runs when a preset names no main model, for the advisor's pairing. */
  fallbackModel: string | null;
}

const BUILT_IN_IDS = new Set(BUILT_IN.map((h) => h.id));
const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** Settings → Harness: the presets, each with its main model and effort, advisor and subagents' model. */
export function HarnessSettings({ saved, onSave, folder, folderDefault, onFolderDefault, fallbackModel }: HarnessSettingsProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const all = [BUILT_IN[0], ...saved];
  const update = (h: Harness) => onSave(saved.map((x) => (x.id === h.id ? h : x)));
  const add = () => {
    const id = `h${Date.now().toString(36)}`;
    onSave([...saved, { id, name: "My preset", model: "sonnet", effort: "high", advisor: "opus", subagent: "haiku" }]);
    setEditing(id);
  };
  const remove = (id: string) => onSave(saved.filter((h) => h.id !== id));
  const restore = () => onSave([...BUILT_IN.slice(1), ...saved.filter((h) => !BUILT_IN_IDS.has(h.id))]);

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Harness</h2>
          <p className="mode-guide-summary">
            Which model does what. The main model works through the task, the advisor is a stronger model Claude consults before committing to a plan, when an error keeps coming back, and before
            calling it done, and subagents take delegated searches and lookups. Pick a preset from the chip under the chat box.
          </p>
        </div>
        <button className="primary" onClick={add}>
          New preset
        </button>
      </div>
      {folder && (
        <label className="harness-folder">
          New chats in <strong>{basename(folder)}</strong> start with
          <select value={folderDefault} onChange={(e) => onFolderDefault(e.target.value)}>
            {all.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ul className="settings-list" aria-label="Harness presets">
        {all.map((h) => {
          const open = editing === h.id && h.id !== DEFAULT_HARNESS;
          const pairing = validAdvisor(h, fallbackModel);
          return (
            <li key={h.id} className="settings-row harness-row">
              <button className="settings-row-main" aria-expanded={open} disabled={h.id === DEFAULT_HARNESS} onClick={() => setEditing(open ? null : h.id)}>
                <span className="settings-row-text">
                  <span className="settings-row-name">{h.name}</span>
                  <span className="settings-row-sub">{summary(h)}</span>
                </span>
                {!pairing && <span className="mcp-status bad">Advisor too weak for this model</span>}
              </button>
              {open && <HarnessEditor h={h} fallbackModel={fallbackModel} onChange={update} onRemove={BUILT_IN_IDS.has(h.id) ? undefined : () => remove(h.id)} />}
            </li>
          );
        })}
      </ul>
      <button className="harness-restore" onClick={restore}>
        Restore the built-in presets
      </button>
    </>
  );
}

function ModelSelect({ label, value, options, none, onChange }: { label: string; value: string | null; options: string[]; none: string; onChange: (v: string | null) => void }) {
  // A full model id kept as it is, alongside the families.
  const extra = value && !options.includes(value) ? [value] : [];
  return (
    <label>
      {label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{none}</option>
        {[...options, ...extra].map((m) => (
          <option key={m} value={m}>
            {FAMILY_LABEL[m as keyof typeof FAMILY_LABEL] ?? m}
          </option>
        ))}
      </select>
    </label>
  );
}

function HarnessEditor({ h, fallbackModel, onChange, onRemove }: { h: Harness; fallbackModel: string | null; onChange: (h: Harness) => void; onRemove?: () => void }) {
  const set = (patch: Partial<Harness>) => {
    const next = { ...h, ...patch };
    // A new main model may not take the advisor any more: drop it rather than start a chat Claude Code refuses.
    if (patch.model !== undefined && next.advisor && !validAdvisor(next, fallbackModel)) next.advisor = null;
    onChange(next);
  };
  const advisors = advisorsFor(familyOf(h.model ?? fallbackModel));
  return (
    <div className="harness-editor">
      <label className="wide">
        Name
        <input value={h.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <ModelSelect label="Main model" value={h.model} options={FAMILIES} none="Claude Code's default" onChange={(model) => set({ model })} />
      <label>
        Effort
        <select value={h.effort ?? ""} onChange={(e) => set({ effort: e.target.value || null })}>
          <option value="">Claude Code's default</option>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {effortLabel(l)}
            </option>
          ))}
        </select>
      </label>
      <ModelSelect label="Advisor" value={h.advisor} options={advisors} none="No advisor" onChange={(advisor) => set({ advisor })} />
      <ModelSelect label="Subagents" value={h.subagent} options={FAMILIES} none="Each subagent's own" onChange={(subagent) => set({ subagent })} />
      <p className="settings-muted wide">
        An advisor has to be at least as strong as the main model, so only those are offered. Subagents can't take an effort of their own; their model applies to every subagent, unless one asks
        for a specific model itself.
      </p>
      {usesFable(h) && <p className="settings-notice wide">Fable on some plans needs a one-time consent first: run /model fable in Claude Code and choose to continue.</p>}
      {onRemove && (
        <div className="wide mcp-detail-actions">
          <button className="danger" onClick={onRemove}>
            Delete preset
          </button>
        </div>
      )}
    </div>
  );
}
