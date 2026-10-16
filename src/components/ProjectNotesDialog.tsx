import { useEffect, useId, useRef, useState } from "react";
import { PROJECT_NOTES_MAX } from "../lib/projectNotes";

interface Props {
  /** The project's name, for the title. */
  project: string;
  /** What the project's notes say now ("" when it has none). */
  notes: string;
  /** Saves the notes (an empty text takes them away). The dialog closes itself after. */
  onSave: (text: string) => void;
  onClose: () => void;
}

/**
 * The short text the user keeps for a project, which every chat started in it afterwards starts knowing. Clear empties the
 * box; nothing changes until Save, and Cancel (or Escape) leaves the notes as they were.
 */
export function ProjectNotesDialog({ project, notes, onSave, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const [text, setText] = useState(notes);
  const left = PROJECT_NOTES_MAX - text.length;
  const changed = text.trim() !== notes.trim();

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
    field.current?.focus();
    field.current?.setSelectionRange(notes.length, notes.length);
  }, []);

  const save = () => {
    if (!changed) return onClose();
    onSave(text);
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="revert-dialog"
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
          save();
        }}
      >
        <div className="revert-title" id={titleId}>
          Project notes: {project}
        </div>
        <p className="revert-text">Every new chat in this project starts knowing this. It isn't saved in your files.</p>
        <textarea
          ref={field}
          className="notes-field"
          aria-label="Project notes"
          placeholder={'For example: "Always use pnpm." or "The API is in /server. Never touch /legacy."'}
          rows={8}
          maxLength={PROJECT_NOTES_MAX}
          spellCheck
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ⌘↩ saves, as in the message box.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
        <div className="notes-foot">
          <span className="notes-hint">Applies to chats started after saving.</span>
          <span className={`notes-count${left <= 100 ? " near" : ""}`} aria-live="polite">
            {text.length} / {PROJECT_NOTES_MAX}
          </span>
        </div>
        <div className="revert-actions">
          <button type="button" className="notes-clear" disabled={text === ""} onClick={() => {
            setText("");
            field.current?.focus();
          }}>
            Clear
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!changed}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
