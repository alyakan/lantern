import { useEffect, useRef, useState } from "react";
import type { Capabilities } from "../types";
import { useMenuShift } from "../lib/menuShift";
import { useMenuKeys } from "./useMenuKeys";

/** A provider to choose among, as the picker lists it. */
export interface ProviderOption {
  id: string;
  name: string;
  capabilities: Capabilities;
}

/** What a provider lacks that Claude Code has, in a few words ("No auto mode, advisor or skills"); empty when it has it all. */
export function lacks(c: Capabilities): string {
  const missing = [!c.supports_auto_mode && "auto mode", !c.supports_advisor && "advisor", !c.supports_skills && "skills", !c.reports_cost_usd && "dollar cost"].filter(Boolean) as string[];
  if (missing.length === 0) return "";
  return `No ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]}` : missing[0]}`;
}

/** Two stacked layers: where the agent comes from. */
function ProviderIcon() {
  return (
    <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 1 11.5 3.6 6.5 6.2 1.5 3.6z" />
      <path d="M1.5 6.4 6.5 9 11.5 6.4" />
    </svg>
  );
}

interface Props {
  options: ProviderOption[];
  chosen: string;
  onChoose: (id: string) => void;
  disabled?: boolean;
}

// In the chat box of a new chat, only when there is more than one provider: which agent CLI the chat runs on. It sits before the
// model chip, whose list is that provider's. Changing it starts the empty chat again on the other provider.
export function ProviderPicker({ options, chosen, onChoose, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { ref: menu, style: menuStyle } = useMenuShift(open);
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

  const current = options.find((o) => o.id === chosen) ?? options[0];
  return (
    <div className="model-picker provider-picker" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className="composer-item model-button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={`Runs on ${current.name}`} onClick={() => setOpen(!open)}>
        <ProviderIcon />
        {current.name}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu" ref={menu} style={menuStyle} role="menu" aria-label="Provider" onKeyDown={keys.onKeyDown}>
          <div className="menu-heading">Which agent runs this chat</div>
          {options.map((o) => (
            <button
              key={o.id}
              role="menuitemradio"
              aria-checked={o.id === current.id}
              className={`menu-row${o.id === current.id ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (o.id !== current.id) onChoose(o.id);
              }}
            >
              <span className="menu-row-title">{o.name}</span>
              <span className="menu-row-meta">{lacks(o.capabilities)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
