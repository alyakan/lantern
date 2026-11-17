import { useEffect, useRef, useState } from "react";
import type { Account } from "../types";
import { useMenuShift } from "../lib/menuShift";
import { useMenuKeys } from "./useMenuKeys";

interface Props {
  accounts: Account[];
  /** The account's id; "" is the default login. */
  chosen: string;
  onChoose: (id: string) => void;
  disabled?: boolean;
}

/** One person's outline: whose login the chat runs on. */
function AccountIcon() {
  return (
    <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6.5" cy="3.6" r="2.1" />
      <path d="M2 10.8c.5-2.2 2.2-3.3 4.5-3.3s4 1.1 4.5 3.3" />
    </svg>
  );
}

// In the chat box of a new Claude chat, only when accounts have been added: whose login the chat runs on (the default one, or one
// from Settings → Accounts). Changing it starts the empty chat again on the other account.
export function AccountPicker({ accounts, chosen, onChoose, disabled }: Props) {
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

  const options = [{ id: "", name: "Default login" }, ...accounts.map((a) => ({ id: a.id, name: a.name }))];
  const current = options.find((o) => o.id === chosen) ?? options[0];
  return (
    <div className="model-picker provider-picker" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className="composer-item model-button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={`Signed in as ${current.name}`} onClick={() => setOpen(!open)}>
        <AccountIcon />
        {current.name}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu" ref={menu} style={menuStyle} role="menu" aria-label="Claude account" onKeyDown={keys.onKeyDown}>
          <div className="menu-heading">Which Claude account runs this chat</div>
          {options.map((o) => (
            <button
              key={o.id || "default"}
              role="menuitemradio"
              aria-checked={o.id === current.id}
              className={`menu-row${o.id === current.id ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (o.id !== current.id) onChoose(o.id);
              }}
            >
              <span className="menu-row-title">{o.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
