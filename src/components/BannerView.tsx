import type { Banner } from "../store";

export function BannerView({ banner, onRestart, onDismiss }: { banner: Banner; onRestart: () => void; onDismiss: () => void }) {
  return (
    <div className={`banner banner-${banner.kind}`} role="status">
      <span>{banner.text}</span>
      {banner.action === "restart" && <button onClick={onRestart}>Restart session</button>}
      <button className="link" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
