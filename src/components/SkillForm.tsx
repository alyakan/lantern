import { useState, type FormEvent } from "react";
import { api } from "../api";

/** A skill's or command's name: lowercase letters and digits, with dashes between them (Rust checks it the same way). */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface Props {
  /** The chat whose folder a project skill goes in; null when no folder is open. */
  slot: string | null;
  kind: "skill" | "command";
  /** Called with the new file's path once it's written. */
  onCreated: (path: string) => void;
  onCancel: () => void;
}

/** A new skill or command: its name, one line about it and where it lives. Writes the file; never overwrites one. */
export function NewSkillForm({ slot, kind, onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const what = kind === "skill" ? "skill" : "command";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!SKILL_NAME.test(name.trim())) {
      setError("The name is lowercase letters, digits and dashes, like daily-notes.");
      return;
    }
    if (!description.trim()) {
      setError(`Say what the ${what} is for, in a line.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.skillCreate(slot, kind, scope, name.trim(), description.trim()));
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="mcp-add" onSubmit={submit} aria-label={`New ${what}`}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="daily-notes" autoFocus required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <label>
        {kind === "skill" ? "What it's for" : "What it does"}
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Keeps my meeting notes tidy" required />
      </label>
      <fieldset className="wide mcp-scope">
        <legend>Where it lives</legend>
        <label className="mcp-scope-option">
          <input type="radio" name="skill-scope" checked={scope === "user"} onChange={() => setScope("user")} />
          <span>
            Just me, every project
            <span className="settings-muted">Saved in your ~/.claude folder</span>
          </span>
        </label>
        <label className="mcp-scope-option">
          <input type="radio" name="skill-scope" checked={scope === "project"} disabled={!slot} onChange={() => setScope("project")} />
          <span>
            Everyone on this project
            <span className="settings-muted">{slot ? "Saved in the project's .claude folder, to commit with the code" : "Open a folder to make one for its project"}</span>
          </span>
        </label>
      </fieldset>
      {error && (
        <div className="settings-error wide" role="alert">
          {error}
        </div>
      )}
      <div className="wide mcp-add-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Making it…" : `Make ${what}`}
        </button>
      </div>
    </form>
  );
}
