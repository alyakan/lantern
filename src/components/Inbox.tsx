import { useEffect, useState, type KeyboardEvent } from "react";
import type { InboxItem } from "../lib/inbox";
import { useAction } from "../lib/actions";
import { elapsed } from "../lib/time";
import { usePopover } from "../lib/usePopover";
import { InboxIcon } from "./icons";

export interface InboxProps {
  items: InboxItem[];
  /** Takes the user to that chat or agent. */
  onGo: (item: InboxItem) => void;
  /** Answers a plain permission request without going there. */
  onDecide: (item: InboxItem, allow: boolean) => void;
}

/** How often the times in the list are redrawn while it is open. */
const TICK_MS = 15_000;

const label = (n: number) => (n > 0 ? `What needs you, ${n} waiting` : "What needs you");

/**
 * The title bar's inbox: everything waiting on you across every project and team, each with its project, what it needs
 * and how long it has waited. Go takes you there; a plain permission request can be answered here. Arrow keys move
 * between the rows (Left and Right between a row's buttons), Escape closes it.
 */
export function Inbox({ items, onGo, onDecide }: InboxProps) {
  const [open, setOpen] = useState(false);
  const { box, button, list, id } = usePopover(open, () => setOpen(false), false);
  const waiting = items.filter((it) => it.needsYou).length;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [open]);
  useAction("show-inbox", () => setOpen(true));
  // It opens on the first row's Go (not on Allow, which a stray Enter would press). Answering the row that has focus
  // removes it: focus goes to a Go again instead of being lost.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>("[data-go]")?.focus();
  }, [open, list]);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (!active || active === document.body || !list.current?.contains(active)) list.current?.querySelector<HTMLElement>("[data-go]")?.focus();
  }, [items.length]);

  const go = (item: InboxItem) => {
    setOpen(false);
    onGo(item);
  };
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("li")];
    const row = (e.target as HTMLElement).closest("li");
    const at = row ? rows.indexOf(row) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      if (!rows.length) return;
      e.preventDefault();
      const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? (at + 1) % rows.length : at <= 0 ? rows.length - 1 : at - 1;
      rows[to].querySelector<HTMLElement>("[data-go]")?.focus();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && row) {
      const buttons = [...row.querySelectorAll<HTMLElement>("button")];
      const i = buttons.indexOf(e.target as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length].focus();
    }
  };

  return (
    <div className="inbox" ref={box}>
      <button ref={button} className={`icon inbox-toggle${open ? " pressed" : ""}`} aria-label={label(waiting)} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} title="What needs you, in every project" onClick={() => setOpen(!open)}>
        <InboxIcon />
        {waiting > 0 && (
          <span className="inbox-badge" aria-hidden>
            {waiting}
          </span>
        )}
        {waiting === 0 && items.length > 0 && <span className="inbox-dot" aria-hidden />}
      </button>
      {open && (
        <div id={id} ref={list} className="menu inbox-menu" role="dialog" aria-label="What needs you" onKeyDown={keys}>
          <div className="menu-heading">Needs you</div>
          {items.length === 0 ? (
            <div className="menu-empty">Nothing is waiting for you.</div>
          ) : (
            <ul className="menu-list">
              {items.map((it) => (
                <li key={it.key} className="inbox-row">
                  <span className={`node-dot ${it.needsYou ? "waiting" : "unread"}`} aria-hidden />
                  <span className="inbox-text">
                    <span className="inbox-head">
                      <span className="inbox-title" title={it.title}>
                        {it.title}
                      </span>
                      {it.since !== null && <span className="inbox-time">{it.needsYou ? `${elapsed(now - it.since)}` : `${elapsed(now - it.since)} ago`}</span>}
                    </span>
                    <span className="inbox-where" title={it.where}>
                      {it.where}
                    </span>
                    <span className="inbox-need" title={it.need}>
                      {it.need}
                    </span>
                  </span>
                  <span className="inbox-actions">
                    {it.requestId && (
                      <>
                        <button className="primary" aria-label={`Allow ${it.title}`} onClick={() => onDecide(it, true)}>
                          Allow
                        </button>
                        <button aria-label={`Deny ${it.title}`} onClick={() => onDecide(it, false)}>
                          Deny
                        </button>
                      </>
                    )}
                    <button data-go aria-label={`Go to ${it.title}`} onClick={() => go(it)}>
                      Go
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
