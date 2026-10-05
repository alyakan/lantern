import { useEffect, useRef, useState } from "react";

/** Every level `--effort` takes, lowest first; a model may support only some. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const HINT: Record<string, string> = {
  low: "Fastest, least thinking",
  medium: "Quicker, lighter thinking",
  high: "Thorough reasoning",
  xhigh: "Deeper than high",
  max: "The most thinking, slowest",
};

export const effortLabel = (level: string | null) => (level ? (LABEL[level] ?? level) : "Default");

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
  /** The chosen level; null = Claude Code's default. */
  chosen: string | null;
  /** What the current model supports. */
  levels: string[];
  onChoose: (level: string | null) => void;
  disabled?: boolean;
}

// Beside the model chip: how hard Claude thinks. Changing it restarts the chat's claude on the same session.
export function EffortPicker({ chosen, levels, onChoose, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  const rows: (string | null)[] = [null, ...EFFORT_LEVELS.filter((l) => levels.includes(l))];

  return (
    <div className="model-picker" ref={root} onClick={(e) => e.stopPropagation()}>
      <button
        className="composer-item model-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={`Thinking effort: ${effortLabel(chosen)}`}
        onClick={() => setOpen(!open)}
      >
        <EffortBars level={chosen} />
        {effortLabel(chosen)}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu effort-menu" role="menu" aria-label="Thinking effort">
          <div className="menu-heading">Thinking effort</div>
          {rows.map((level) => (
            <button
              key={level ?? "default"}
              role="menuitemradio"
              aria-checked={level === chosen}
              className={`menu-row${level === chosen ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (level !== chosen) onChoose(level);
              }}
            >
              <EffortBars level={level} />
              <span className="menu-row-title">{effortLabel(level)}</span>
              <span className="menu-row-meta">{level ? HINT[level] : "Claude Code's setting"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
