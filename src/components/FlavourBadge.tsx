import { useEffect, useRef, useState } from "react";
import { canExplain, EXPLAIN_LABEL, FLAVOUR_LABEL, FLAVOURS, type Flavour } from "../lib/flavour";
import { useModeGuide } from "../lib/modeGuide";
import { InfoIcon, LearnIcon, StepsIcon } from "./icons";
import { FLAVOUR_ICON } from "./ModeGuide";
import { useMenuKeys } from "./useMenuKeys";

const HINT: Record<Flavour, string> = {
  build: "Plan and build one step at a time",
  review: "Review a pull request or branch, a file per page",
  debug: "Find the cause from evidence, then fix it",
  architecture: "Review how a feature, fix or PR fits together, as a map",
};

/**
 * Step by step's header: the flavour it's in, in your face, and a menu to pick another yourself, or to turn Explain as
 * you go on or off for Build and Debug (Claude is told with your next message). It plays a short highlight whenever the
 * flavour changes.
 */
export function FlavourBadge({ flavour, explain = false, onPick, disabled }: { flavour: Flavour | null; explain?: boolean; onPick: (flavour: Flavour, explain?: boolean) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const guide = useModeGuide();
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
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

  return (
    <div className="flavour-anchor" ref={root}>
      {/* Keyed by flavour so a change replays the highlight. */}
      <button key={`${flavour ?? "none"}${explain ? "+" : ""}`} className={`flavour-badge${flavour ? "" : " none"}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={flavour ? `${HINT[flavour]}${explain ? ", explaining the why" : ""}` : "Claude suggests how to work once you say what you're after"} onClick={() => setOpen(!open)}>
        {flavour ? FLAVOUR_ICON[flavour] : <StepsIcon />}
        {flavour ? FLAVOUR_LABEL[flavour] : "Step by step"}
        {flavour && explain && canExplain(flavour) && <span className="flavour-explain">explaining</span>}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu flavour-menu" role="menu" aria-label="Flavour" onKeyDown={keys.onKeyDown}>
          {FLAVOURS.map((f) => (
            <button
              key={f}
              role="menuitemradio"
              aria-checked={f === flavour}
              className={`menu-row${f === flavour ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (f !== flavour) onPick(f);
              }}
            >
              <span className="mode-icon">{FLAVOUR_ICON[f]}</span>
              <span className="mode-text">
                <span className="menu-row-title">{FLAVOUR_LABEL[f]}</span>
                <span className="mode-hint">{HINT[f]}</span>
              </span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            role="menuitemcheckbox"
            aria-checked={explain && canExplain(flavour)}
            disabled={!flavour || !canExplain(flavour)}
            className={`menu-row${explain && canExplain(flavour) ? " current" : ""}`}
            title={flavour && canExplain(flavour) ? "Every page also explains the why" : "For Build and Debug"}
            onClick={() => {
              setOpen(false);
              if (flavour) onPick(flavour, !explain);
            }}
          >
            <span className="mode-icon">
              <LearnIcon />
            </span>
            <span className="mode-text">
              <span className="menu-row-title">{EXPLAIN_LABEL}</span>
              <span className="mode-hint">Build and Debug pages also explain the why</span>
            </span>
          </button>
          {guide && (
            <>
              <button
                role="menuitem"
                className="menu-row mode-menu-more"
                onClick={() => {
                  setOpen(false);
                  guide(flavour ?? "steps");
                }}
              >
                <span className="mode-icon">
                  <InfoIcon />
                </span>
                <span className="menu-row-title">How it works…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
