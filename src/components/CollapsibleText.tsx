import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * What you sent, shown to at most `lines` lines (three), with Show more when it's longer. Whether it is longer is
 * measured on screen, so a long line that wraps counts as several. The message itself is whole either way. The text and
 * its button are one wrapper: in the terminal themes the message is a row (a > mark, then this), and two siblings would
 * be two columns, with Show more squeezed to a letter's width.
 */
export function CollapsibleText({ children, lines = 3 }: { children: ReactNode; lines?: number }) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [open, children]);
  return (
    <div className="collapsible-wrap">
      <div ref={body} className={`collapsible${open ? "" : " clamped"}`} style={{ "--clamp-lines": lines } as CSSProperties}>
        {children}
      </div>
      {(long || open) && (
        <button className="link-button collapsible-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
