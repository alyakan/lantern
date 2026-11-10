import { useEffect, useRef } from "react";
import type { FrameUnit, ReviewFrame } from "../lib/review";
import { Md } from "./Md";

/** A unit's title as a file (a path with no spaces) or a group's title. */
const isPath = (title: string) => !/\s/.test(title) && (title.includes("/") || /\.[A-Za-z]\w*$/.test(title));
/** What a unit is called where room is short: a file's name, or a group's title. */
export const unitName = (title: string) => (isPath(title) ? title.slice(title.lastIndexOf("/") + 1) : title);

/**
 * A Review's Frame, drawn from its sections: what the change is, a line of totals, the risks (each with the units it is
 * in) and the route of units, each opening its page once it is there. Any other section follows as written.
 */
export function ReviewFrameView({ frame, onUnit }: { frame: ReviewFrame; onUnit: (n: number) => (() => void) | null }) {
  const counted = frame.units.filter((u) => u.added !== null);
  const added = counted.reduce((n, u) => n + (u.added ?? 0), 0);
  const removed = counted.reduce((n, u) => n + (u.removed ?? 0), 0);
  const titleOf = (n: number) => frame.units.find((u) => u.n === n)?.title ?? null;
  return (
    <div className="review-frame">
      {frame.preface && (
        <div className="review-preface">
          <Md>{frame.preface}</Md>
        </div>
      )}
      {frame.units.length > 0 && (
        <div className="review-totals" aria-label="This review">
          <span>
            <strong>{frame.units.length}</strong> unit{frame.units.length === 1 ? "" : "s"}
          </span>
          {counted.length > 0 && (
            <span className="counts">
              <span className="added">+{added}</span>
              <span className="removed">−{removed}</span>
            </span>
          )}
          <span>
            <strong>{frame.risks.length}</strong> risk{frame.risks.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {frame.risks.length > 0 && (
        <section className="review-section">
          <div className="review-section-title">Risks</div>
          <div className="review-risks">
            {frame.risks.map((r, i) => (
              <div key={i} className="review-risk">
                <div className="review-risk-title">{r.title}</div>
                {r.text && (
                  <div className="review-risk-text">
                    <Md inline>{r.text}</Md>
                  </div>
                )}
                {r.units.length > 0 && (
                  <div className="review-risk-units" aria-label="In units">
                    {r.units.map((n) => {
                      const go = onUnit(n);
                      const title = titleOf(n);
                      const label = (
                        <>
                          <span className="review-unit-n">{n}</span>
                          {title && <span className="review-chip-name">{unitName(title)}</span>}
                        </>
                      );
                      return go ? (
                        <button key={n} className="review-chip" title={title ? `Open ${title}` : `Open unit ${n}`} onClick={go}>
                          {label}
                        </button>
                      ) : (
                        <span key={n} className="review-chip" title={title ? `${title}: not reached yet` : "Not reached yet"}>
                          {label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {frame.units.length > 0 && (
        <section className="review-section">
          <div className="review-section-title">Route</div>
          <ol className="review-units">
            {frame.units.map((u) => (
              <li key={u.n}>
                <UnitRow unit={u} onOpen={onUnit(u.n)} />
              </li>
            ))}
          </ol>
        </section>
      )}
      {frame.rest && (
        <div className="review-frame-rest">
          <Md>{frame.rest}</Md>
        </div>
      )}
    </div>
  );
}

function UnitRow({ unit, onOpen }: { unit: FrameUnit; onOpen: (() => void) | null }) {
  const path = isPath(unit.title);
  const slash = unit.title.lastIndexOf("/");
  const body = (
    <>
      <span className="review-unit-n">{unit.n}</span>
      <span className="review-unit-main">
        <span className="review-unit-title">
          <span className="review-unit-name">{path ? unit.title.slice(slash + 1) : unit.title}</span>
          {path && slash > 0 && <span className="review-unit-dir">{unit.title.slice(0, slash)}</span>}
          {unit.added !== null && (
            <span className="counts">
              <span className="added">+{unit.added}</span>
              <span className="removed">−{unit.removed}</span>
            </span>
          )}
        </span>
        {unit.note && (
          <span className="review-unit-note">
            <Md inline>{unit.note}</Md>
          </span>
        )}
      </span>
    </>
  );
  return onOpen ? (
    <button className="review-unit" title={`Open ${unit.title}`} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="review-unit pending" title="Not reached yet">
      {body}
    </div>
  );
}

/** A stop on a Review's route: the Frame, a unit, or the Summary, and the page it is (null: not written yet). */
export interface RouteStop {
  key: string;
  kind: "frame" | "unit" | "summary";
  /** The unit's number. */
  n?: number;
  label: string;
  /** What the stop's tooltip says in full (a unit's whole path). */
  title: string;
  page: number | null;
  /** A unit's findings, and how many still wait for your verdict; unknown until its page is written. */
  findings?: number;
  open?: number;
}

/**
 * The route through a Review, in the head of the steps: the Frame, every unit the Frame planned (those not reached yet
 * greyed), and the Summary. The page on screen is marked; a unit that has been read shows its findings, or a tick for none.
 */
export function ReviewRoute({ stops, at, onGo }: { stops: RouteStop[]; at: number; onGo: (page: number) => void }) {
  const list = useRef<HTMLOListElement>(null);
  // The stop on screen stays in view as the route scrolls sideways in a narrow pane.
  useEffect(() => {
    const follow = () => {
      const nav = list.current?.parentElement;
      const el = list.current?.querySelector<HTMLElement>("[aria-current='step']");
      if (!nav || !el) return;
      // Centred in the route, or as far as it scrolls (the last stop sits at the end).
      const from = el.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
      nav.scrollLeft = from - (nav.clientWidth - el.offsetWidth) / 2;
    };
    follow();
    // The stop on screen turns bold, and so wider, after this first look; and the pane may be resized.
    const later = setTimeout(follow, 250);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    if (list.current?.parentElement) observer?.observe(list.current.parentElement);
    return () => {
      clearTimeout(later);
      observer?.disconnect();
    };
  }, [at, stops.length]);
  return (
    <nav className="review-route" aria-label="Review route">
      <ol ref={list}>
        {stops.map((s, i) => {
          const current = s.page !== null && s.page === at;
          const reached = s.page !== null;
          const mark = s.kind === "unit" ? s.n : s.kind === "frame" ? "◆" : "∑";
          return (
            <li key={s.key} className={`review-stop stop-${s.kind}${current ? " current" : ""}${reached ? " reached" : " ahead"}`}>
              {i > 0 && <span className="review-stop-line" aria-hidden />}
              <button aria-current={current ? "step" : undefined} disabled={!reached} title={reached ? s.title : `${s.title}: not reached yet`} onClick={() => s.page !== null && onGo(s.page)}>
                <span className="review-stop-mark" aria-hidden>
                  {mark}
                </span>
                <span className="review-stop-label">{s.label}</span>
                {s.kind === "unit" && reached && !current && s.findings !== undefined && (
                  <span className={`review-stop-count${s.open ? " open" : ""}`} aria-label={s.findings === 0 ? "no findings" : `${s.findings} finding${s.findings === 1 ? "" : "s"}${s.open ? `, ${s.open} without a verdict` : ""}`}>
                    {s.findings === 0 ? "✓" : s.findings}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
