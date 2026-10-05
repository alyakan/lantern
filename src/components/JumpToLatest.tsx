/** A small pill above the chat box once you've scrolled up from the end: back to the latest, smoothly. */
export function JumpToLatest({ show, onJump, label = "Latest" }: { show: boolean; onJump: () => void; label?: string }) {
  if (!show) return null;
  return (
    <button className="jump-latest" onClick={onJump} title="Scroll to the bottom">
      <span className="jump-latest-arrow" aria-hidden>
        ↓
      </span>
      {label}
    </button>
  );
}

/** How far from its end a scrolled view must be before the pill shows. */
export const AWAY_FROM_END = 160;
