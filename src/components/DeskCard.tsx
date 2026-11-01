import type { ReactNode } from "react";

/** A section of the Desk: a card with its title, how many, and at most one action, the same on the Desk and a project's page. */
export function Card({ title, count, action, heading: H = "h3", className, children }: { title: string; count?: number; action?: ReactNode; heading?: "h2" | "h3"; className?: string; children: ReactNode }) {
  return (
    <section className={`dp-card${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="dp-card-head">
        <H>{title}</H>
        {!!count && <span className="dp-count">{count}</span>}
        {action && <span className="dp-card-act">{action}</span>}
      </header>
      {children}
    </section>
  );
}

/** Every row in a Desk card has the same shape: a title with one short thing on its right, and one quiet line under it. */
export function Row({ title, aside, meta }: { title: ReactNode; aside?: ReactNode; meta?: ReactNode }) {
  return (
    <>
      <span className="dp-row-top">
        <span className="dp-title">{title}</span>
        {aside && <span className="dp-aside">{aside}</span>}
      </span>
      {meta && <span className="dp-meta">{meta}</span>}
    </>
  );
}
