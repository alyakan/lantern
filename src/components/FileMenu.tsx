import { useEffect, useRef, useState } from "react";
import { useMenuInside } from "../lib/useMenuInside";
import { useMenuKeys } from "./useMenuKeys";

export interface FileAction {
  label: string;
  title: string;
  onClick: () => void;
  /** Shown but not usable now: the title says why. */
  disabled?: boolean;
}

/** The ⋯ on the file bar: what can be done with the file shown (edit it, put it back, how its diff is laid out), in one quiet menu rather than a row of buttons. */
export function FileMenu({ actions }: { actions: FileAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
  const inside = useMenuInside(open);
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
  if (actions.length === 0) return null;
  return (
    <div className="pane-menu-anchor file-actions" ref={root}>
      <button className={`icon file-more${open ? " pressed" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label="File actions" title="Edit this file, put it back, or change how its diff is laid out" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu pane-menu" ref={inside.ref} style={inside.style} role="menu" aria-label="File actions" onKeyDown={keys.onKeyDown}>
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className="menu-row"
              aria-disabled={a.disabled}
              title={a.title}
              onClick={() => {
                if (a.disabled) return;
                a.onClick();
                setOpen(false);
              }}
            >
              <span className="menu-row-title">{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
