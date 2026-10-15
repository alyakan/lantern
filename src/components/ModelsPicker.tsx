import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "../types";
import { choiceName, MODEL_CHOICES, modelLabel } from "../lib/models";
import { EFFORT_HINT, EFFORT_LEVELS, effortLabel } from "../lib/effort";
import { CUSTOM_HARNESS, DEFAULT_HARNESS, summary, type Harness } from "../lib/harness";
import { useMenuInside } from "../lib/useMenuInside";
import { SparkIcon } from "./icons";
import { useMenuKeys } from "./useMenuKeys";

/** claude lists its recommended picks first; everything after these is an older version. */
const PRIMARY = 5;

interface Row {
  /** null = Default (no --model). */
  value: string | null;
  name: string;
  hint: string;
}

/** Bars that fill with the level: none for Default, all five for Max. */
function EffortBars({ level }: { level: string | null }) {
  const filled = level ? EFFORT_LEVELS.indexOf(level as (typeof EFFORT_LEVELS)[number]) + 1 : 0;
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden className="effort-bars">
      {EFFORT_LEVELS.map((_, i) => (
        <rect key={i} x={i * 2.6} y={9 - i * 2} width="1.6" height={2 + i * 2} rx="0.6" fill="currentColor" opacity={i < filled ? 1 : 0.28} />
      ))}
    </svg>
  );
}

interface Props {
  /** The model claude says it is running, from its init message. */
  running: string | null;
  /** The model: what the chat chose (null = Claude Code's default), and how to change it. */
  chosen: string | null;
  onChoose: (model: string | null) => void;
  /** The model claude ran with when nothing was chosen, if seen; names what "Default" means. */
  defaultModel?: string | null;
  /** Model ids claude reported for each alias, so rows can show versions. */
  ids?: Record<string, string>;
  /** The models claude offers (from its initialize reply); until they arrive, a built-in short list. */
  options?: ModelOption[];
  /** Thinking effort: the chosen level (null = default), what the model takes (none hides it) and how to change it. */
  effort?: { chosen: string | null; levels: string[]; onChoose: (level: string | null) => void };
  /** The harness presets (which models do what) and the chat's: without them the menu is just the model and effort choices. */
  presets?: Harness[];
  preset?: string;
  onPreset?: (id: string) => void;
  /** Opens Settings → Harness, to edit presets or make one. */
  onEdit?: () => void;
  disabled?: boolean;
}

// The one chip under the box for who does the work: the harness preset and the main model ("Balanced · Sonnet 5.5").
// Its menu lists the presets; Customize… opens the model and effort choices. A change applies from the next message
// (effort and presets restart the chat's claude on the same session). On a preset, picking a model or effort makes the
// chat Custom, which the chip and the note in that view say.
export function ModelsPicker({ running, chosen, onChoose, defaultModel = null, ids = {}, options = [], effort, presets, preset, onPreset, onEdit, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"presets" | "customize">("presets");
  const [showOlder, setShowOlder] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { ref: menu, style: menuStyle } = useMenuInside(open, [view, showOlder]);
  const keys = useMenuKeys(open, root);
  const withPresets = !!presets && !!onPreset;
  const shownView = withPresets ? view : "customize";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Moving to the other view puts focus on its checked (or first) item, like opening the menu does.
  useEffect(() => {
    if (!open) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])];
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [view]);
  const toggle = () => {
    setView("presets");
    setOpen(!open);
  };

  const current = presets?.find((h) => h.id === preset) ?? presets?.[0];
  const resolvedDefault = (chosen === null && running) || options.find((o) => o.value === "default")?.resolved_model || defaultModel;
  const rows: Row[] = options.length
    ? options.map((o) =>
        o.value === "default"
          ? { value: null, name: choiceName(null, resolvedDefault), hint: "Claude Code's setting" }
          : { value: o.value, name: o.display_name || modelLabel(o.value), hint: o.description },
      )
    : MODEL_CHOICES.map((c) => ({ value: c.value, name: choiceName(c.value, resolvedDefault, ids), hint: c.hint }));

  // Until the next turn's init confirms a switch, show what was chosen rather than the model still running.
  const confirmed = running && chosen !== null && running.includes(chosen);
  const model = confirmed ? modelLabel(running) : (rows.find((r) => r.value === chosen)?.name ?? choiceName(chosen, resolvedDefault, ids));
  // "Default (Opus 5.5)" is just "Opus 5.5" on a chip; the menu keeps saying what Default means.
  const chipModel = /^Default \((.*)\)$/.exec(model)?.[1] ?? model;

  // Older versions stay folded away, unless the one in use is among them.
  const older = rows.slice(PRIMARY);
  const olderOpen = showOlder || older.some((r) => r.value === chosen);

  const modelRow = (r: Row) => (
    <button
      key={r.value ?? "default"}
      role="menuitemradio"
      aria-checked={r.value === chosen}
      className={`menu-row${r.value === chosen ? " current" : ""}`}
      onClick={() => {
        setOpen(false);
        if (r.value !== chosen) onChoose(r.value);
      }}
    >
      <span className="menu-row-title">{r.name}</span>
      <span className="menu-row-meta">{r.hint}</span>
    </button>
  );
  const effortRows: (string | null)[] = effort ? [null, ...EFFORT_LEVELS.filter((l) => effort.levels.includes(l))] : [];

  const custom = current?.id === CUSTOM_HARNESS;
  const label = current ? `${current.name} · ${chipModel}` : chipModel;
  const title = current
    ? `Models: ${custom && current.from ? `Custom (${current.from}, changed)` : current.name} · ${summary(current)}${effort ? ` · Effort ${effortLabel(effort.chosen)}` : ""}`
    : `Model: ${model}${effort ? ` · Effort ${effortLabel(effort.chosen)}` : ""}`;
  // On a preset, a pick here turns the chat Custom: say so, and what it was made from.
  const onPresetOn = !!current && current.id !== DEFAULT_HARNESS;

  return (
    <div className="model-picker" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className={`composer-item model-button${onPresetOn ? " harness-on" : ""}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={title} onClick={toggle}>
        <SparkIcon />
        {label}
        <span className="chev down" aria-hidden />
      </button>
      {open && shownView === "presets" && withPresets && (
        <div className="menu model-menu harness-menu" ref={menu} style={menuStyle} role="menu" aria-label="Models" onKeyDown={keys.onKeyDown}>
          <div className="menu-heading">Models: who does what</div>
          {presets.map((h) => (
            <button
              key={h.id}
              role="menuitemradio"
              aria-checked={h.id === preset}
              className={`menu-row${h.id === preset ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (h.id !== preset) onPreset(h.id);
              }}
            >
              <span className="menu-row-title">{h.name}</span>
              <span className="menu-row-meta">{h.id === CUSTOM_HARNESS && h.from ? `${h.from}, changed · ${summary(h)}` : summary(h)}</span>
            </button>
          ))}
          <button role="menuitem" className="menu-row harness-edit" onClick={() => setView("customize")}>
            <span className="menu-row-title">Customize…</span>
            <span className="menu-row-meta">Pick the model and thinking effort</span>
          </button>
          {onEdit && (
            <button
              role="menuitem"
              className="menu-row"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              <span className="menu-row-title">Edit presets…</span>
            </button>
          )}
        </div>
      )}
      {open && shownView === "customize" && (
        <div className="menu model-menu customize-menu" ref={menu} style={menuStyle} role="menu" aria-label="Customize models" onKeyDown={keys.onKeyDown}>
          {withPresets && (
            <button role="menuitem" className="menu-heading menu-toggle" onClick={() => setView("presets")}>
              <span className="chev back" aria-hidden />
              Presets
            </button>
          )}
          {onPresetOn && current && (
            <div className="menu-note">
              {custom ? `Custom${current.from ? ` (${current.from}, changed)` : ""}: ` : `${current.name} becomes Custom: `}changes you make here apply to this chat only.
            </div>
          )}
          <div className="menu-heading">Model</div>
          {rows.slice(0, PRIMARY).map(modelRow)}
          {older.length > 0 && (
            <>
              <button role="menuitem" className="menu-heading menu-toggle" aria-expanded={olderOpen} onClick={() => setShowOlder(!olderOpen)}>
                <span className="chev" aria-hidden />
                Older models
              </button>
              {olderOpen && older.map(modelRow)}
            </>
          )}
          {effort && effortRows.length > 1 && (
            <>
              <div className="menu-heading">Thinking effort</div>
              {effortRows.map((level) => (
                <button
                  key={level ?? "default"}
                  role="menuitemradio"
                  aria-checked={level === effort.chosen}
                  className={`menu-row effort-row${level === effort.chosen ? " current" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    if (level !== effort.chosen) effort.onChoose(level);
                  }}
                >
                  <EffortBars level={level} />
                  <span className="menu-row-title">{effortLabel(level)}</span>
                  <span className="menu-row-meta">{level ? EFFORT_HINT[level] : "Claude Code's setting"}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
