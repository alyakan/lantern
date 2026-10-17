import { useEffect, useRef, useState } from "react";
import { DEFAULT_PINNED, TABS, type Tab } from "../lib/reviewTabs";
import { useMenuInside } from "../lib/useMenuInside";
import { PinIcon } from "./icons";
import { useMenuKeys } from "./useMenuKeys";

/** What a tab counts: shown on its button, and in its row of the menu. `attention` marks what needs eyes while the tab is hidden. */
export interface TabBadge {
  text: string;
  failed: boolean;
  attention: boolean;
}

const LABEL = Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<Tab, string>;

/** The badge the ⋯ button carries for the unpinned tabs (the open one is in the strip, so not it): the failures if there are any (in red), otherwise the new requests. */
export function hiddenBadge(pinned: Tab[], current: Tab, badges: Partial<Record<Tab, TabBadge>>): { n: number; failed: boolean } | null {
  const hidden = TABS.filter((t) => !pinned.includes(t.id) && t.id !== current).map((t) => badges[t.id]).filter((b): b is TabBadge => !!b?.attention);
  const failed = hidden.filter((b) => b.failed).reduce((n, b) => n + (Number(b.text) || 1), 0);
  if (failed > 0) return { n: failed, failed: true };
  const n = hidden.reduce((sum, b) => sum + (Number(b.text) || 1), 0);
  return n > 0 ? { n, failed: false } : null;
}

/**
 * The ⋯ at the end of the side panel's tab strip: every tab with a pin toggle (a pinned tab sits in the strip, an unpinned one
 * only here), and the pinned ones can be moved up and down. Clicking a name opens that tab, pinned or not.
 */
export function PaneTabsMenu({ pinned, onPinned, current, badges, onOpen }: { pinned: Tab[]; onPinned: (pinned: Tab[]) => void; current: Tab; badges: Partial<Record<Tab, TabBadge>>; onOpen: (tab: Tab) => void }) {
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

  const rest = TABS.map((t) => t.id).filter((id) => !pinned.includes(id));
  const attention = hiddenBadge(pinned, current, badges);
  const move = (id: Tab, by: -1 | 1) => {
    const i = pinned.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= pinned.length) return;
    const next = [...pinned];
    [next[i], next[j]] = [next[j], next[i]];
    onPinned(next);
  };
  const toggle = (id: Tab) => {
    if (!pinned.includes(id)) return onPinned([...pinned, id]);
    if (pinned.length > 1) onPinned(pinned.filter((p) => p !== id));
  };
  const row = (id: Tab) => {
    const isPinned = pinned.includes(id);
    const i = pinned.indexOf(id);
    const badge = badges[id];
    const label = LABEL[id];
    const last = isPinned && pinned.length === 1;
    return (
      <div key={id} className="pane-menu-row" role="none">
        <button
          role="menuitem"
          className={`menu-row${current === id ? " current" : ""}`}
          onClick={() => {
            onOpen(id);
            setOpen(false);
          }}
        >
          <span className="menu-row-title">{label}</span>
          {badge && <span className={`tab-count${badge.failed ? " failed" : ""}`}>{badge.text}</span>}
        </button>
        {isPinned && (
          <>
            <button role="menuitem" className="icon pane-menu-move" aria-label={`Move ${label} up`} aria-disabled={i === 0} title="Move up" onClick={() => move(id, -1)}>
              ↑
            </button>
            <button role="menuitem" className="icon pane-menu-move" aria-label={`Move ${label} down`} aria-disabled={i === pinned.length - 1} title="Move down" onClick={() => move(id, 1)}>
              ↓
            </button>
          </>
        )}
        <button role="menuitemcheckbox" aria-checked={isPinned} aria-label={`Pin ${label}`} aria-disabled={last} className={`icon pane-menu-pin${isPinned ? " on" : ""}`} title={last ? "At least one tab stays pinned" : isPinned ? "Unpin from the tab strip" : "Pin to the tab strip"} onClick={() => toggle(id)}>
          <PinIcon />
        </button>
      </div>
    );
  };

  return (
    <div className="pane-menu-anchor" ref={root}>
      <button
        className={`pane-more${open ? " pressed" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={attention ? `More tabs, ${attention.n} ${attention.failed ? "failed" : "new"}` : "More tabs"}
        title="Pin tabs to the strip, or open one that isn't pinned"
        onClick={() => setOpen(!open)}
      >
        ⋯{attention && <span className={`tab-count${attention.failed ? " failed" : ""}`}>{attention.n}</span>}
      </button>
      {open && (
        <div className="menu pane-menu" ref={inside.ref} style={inside.style} role="menu" aria-label="Side panel tabs" onKeyDown={keys.onKeyDown}>
          <div className="menu-heading" role="presentation">
            Pinned
          </div>
          {pinned.map(row)}
          {rest.length > 0 && (
            <>
              <div className="menu-heading" role="presentation">
                More
              </div>
              {rest.map(row)}
            </>
          )}
          <div className="menu-sep" role="separator" />
          <button
            role="menuitem"
            className="menu-row"
            aria-disabled={pinned.join() === DEFAULT_PINNED.join()}
            onClick={() => onPinned(DEFAULT_PINNED)}
          >
            <span className="menu-row-title">Reset to default</span>
          </button>
        </div>
      )}
    </div>
  );
}
