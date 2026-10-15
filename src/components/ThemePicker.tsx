import { useState, type CSSProperties } from "react";
import { usePrefersDark } from "../lib/theme";
import { DARK_PICKS, LIGHT_PICKS, THEMES, startingPoint, textContrast, type CustomTheme, type Picks, type ThemeId } from "../lib/themes";

/** The six colours the custom editor offers, in the order it shows them. */
const COLOURS: { key: keyof Picks; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "panel", label: "Panels (chat card, sidebar)" },
  { key: "text", label: "Text" },
  { key: "text2", label: "Secondary text" },
  { key: "accent", label: "Accent" },
  { key: "line", label: "Lines" },
];

/** A theme's six colours as a small swatch: the background with the panel, text and accent on it. "Follow macOS" is half light, half dark. */
function Swatch({ picks }: { picks: Picks | null }) {
  const style: CSSProperties = picks
    ? { background: picks.bg, borderColor: picks.line }
    : { background: `linear-gradient(90deg, ${LIGHT_PICKS.bg} 50%, ${DARK_PICKS.bg} 50%)`, borderColor: LIGHT_PICKS.line };
  return (
    <span className="theme-swatch" style={style} aria-hidden="true">
      {picks && (
        <>
          <i style={{ background: picks.panel }} />
          <i style={{ background: picks.text }} />
          <i style={{ background: picks.accent }} />
        </>
      )}
    </span>
  );
}

interface Props {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  custom: CustomTheme;
  onCustom: (custom: CustomTheme) => void;
}

/** Settings' Theme: the presets as a row of swatches, and "Customize…", which opens the editor for your own colours. */
export function ThemePicker({ theme, onTheme, custom, onCustom }: Props) {
  const macDark = usePrefersDark();
  // What to go back to if the editor is cancelled: the theme and custom colours it was opened over.
  const [editing, setEditing] = useState<{ theme: ThemeId; custom: CustomTheme } | null>(null);

  const open = () => {
    setEditing({ theme, custom });
    // It starts from the theme that's on now, and what's picked shows in the app as it's picked.
    onCustom(startingPoint(theme, macDark, custom));
    onTheme("custom");
  };
  const cancel = () => {
    if (editing) {
      onCustom(editing.custom);
      onTheme(editing.theme);
    }
    setEditing(null);
  };

  return (
    <>
      <fieldset className="general-choices">
        <legend>Theme</legend>
        <div className="general-choice-row">
          {THEMES.map(({ id, label, picks }) => (
            <label key={id} className="general-choice">
              <input type="radio" name="theme" checked={theme === id} onChange={() => onTheme(id)} />
              <Swatch picks={id === "custom" ? custom : picks} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {!editing && (
          <div className="general-row">
            <button onClick={open}>Customize…</button>
          </div>
        )}
      </fieldset>
      {editing && <CustomEditor custom={custom} onChange={onCustom} onDone={() => setEditing(null)} onCancel={cancel} />}
    </>
  );
}

/** The custom theme's colours, monospace and corners, with a warning when its text doesn't read on its background. */
function CustomEditor({ custom, onChange, onDone, onCancel }: { custom: CustomTheme; onChange: (c: CustomTheme) => void; onDone: () => void; onCancel: () => void }) {
  const { ratio, ok } = textContrast(custom);
  return (
    <fieldset className="theme-editor" aria-label="Custom theme">
      <legend>Custom theme</legend>
      <div className="theme-colours">
        {COLOURS.map(({ key, label }) => (
          <label key={key} className="theme-colour">
            <input type="color" value={custom[key]} aria-label={label} onChange={(e) => onChange({ ...custom, [key]: e.target.value })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {!ok && (
        <span className="theme-warning" role="status">
          Text on the background is {ratio.toFixed(1)}:1. Body text is easier to read at 4.5:1 or more.
        </span>
      )}
      <label className="general-option">
        <input type="checkbox" checked={custom.mono} onChange={(e) => onChange({ ...custom, mono: e.target.checked })} />
        <span>Monospace everywhere</span>
      </label>
      <div className="general-choice-row">
        <span className="settings-muted">Corners</span>
        <label className="general-choice">
          <input type="radio" name="corners" checked={!custom.square} onChange={() => onChange({ ...custom, square: false })} />
          <span>Rounded</span>
        </label>
        <label className="general-choice">
          <input type="radio" name="corners" checked={custom.square} onChange={() => onChange({ ...custom, square: true })} />
          <span>Square</span>
        </label>
      </div>
      <div className="general-row">
        <button className="primary" onClick={onDone}>
          Done
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </fieldset>
  );
}
