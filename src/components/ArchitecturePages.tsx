import type { ArchitecturePart } from "../lib/architecture";
import type { Verdict } from "../lib/review";
import { HudCheckIcon } from "./icons";
import { Md } from "./Md";
import { FindingCard } from "./ReviewPages";

/** One piece of the architecture: what it's for, what it connects to, what changes in it, and the concerns about it. */
export function ArchitecturePartView({ part, verdicts, onVerdict, onShowNode }: { part: ArchitecturePart; verdicts: Record<number, Verdict> | undefined; onVerdict?: (index: number, v: Verdict | null) => void; onShowNode?: (id: string) => void }) {
  const section = (title: string, body: string, className: string) =>
    body && (
      <section className="review-section">
        <div className="review-section-title">{title}</div>
        <div className={className}>
          <Md>{body}</Md>
        </div>
      </section>
    );
  return (
    <div className="review-file arch-part">
      {part.covers.length > 0 && (
        <div className="arch-covers" aria-label="Covers">
          <span className="arch-covers-label">On the map</span>
          {part.covers.map((id) =>
            onShowNode ? (
              <button key={id} className="arch-node" title="Show it on the map" onClick={() => onShowNode(id)}>
                {id}
              </button>
            ) : (
              <span key={id} className="arch-node">
                {id}
              </span>
            ),
          )}
        </div>
      )}
      {part.preface && (
        <div className="review-preface">
          <Md>{part.preface}</Md>
        </div>
      )}
      {section("Role", part.role, "review-changed")}
      {section("Connects to", part.connects, "review-changed")}
      {section("Changes", part.changes, "review-changed")}
      <section className="review-section">
        <div className="review-section-title">
          Concerns{part.concerns.length > 0 && <span className="tab-count">{part.concerns.length}</span>}
        </div>
        {part.clean || part.concerns.length === 0 ? (
          <div className="review-clean">
            <HudCheckIcon />
            No concerns
          </div>
        ) : (
          part.concerns.map((c) => <FindingCard key={c.index} path={null} finding={c} verdict={verdicts?.[c.index]} onVerdict={onVerdict && ((v) => onVerdict(c.index, v))} />)
        )}
      </section>
      {part.notes && section("Notes", part.notes, "review-notes")}
    </div>
  );
}
