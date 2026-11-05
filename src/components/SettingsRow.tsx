import { useState, type ReactNode } from "react";

/**
 * A setting's help: one line under the row, and the whole sentence behind **More** when it is long. The text stays in the page
 * (a screen reader reads it all); only the drawing is cut at two lines until it is opened.
 */
export function SettingsHint({ children }: { children: ReactNode }) {
  const long = typeof children === "string" && children.length > 120;
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-hint">
      <span className={`settings-hint-text${long && !open ? " clamped" : ""}`}>{children}</span>
      {long && (
        <button type="button" className="settings-hint-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/**
 * One setting: its words, its control, and the help under it. `lead` puts the control first, as a checkbox is drawn before the
 * sentence it turns on. The control keeps its own accessible name (an input's words, or a select's `aria-label`).
 */
export function SettingsRow({ label, control, hint, lead = false }: { label: ReactNode; control: ReactNode; hint?: ReactNode; lead?: boolean }) {
  return (
    <div className="settings-line">
      <label className="general-option">
        {lead ? (
          <>
            {control}
            <span>{label}</span>
          </>
        ) : (
          <>
            <span>{label}</span>
            {control}
          </>
        )}
      </label>
      {hint !== undefined && <SettingsHint>{hint}</SettingsHint>}
    </div>
  );
}
