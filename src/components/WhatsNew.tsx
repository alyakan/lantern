import { useEffect, useRef } from "react";
import { releasePage } from "../lib/whatsNew";
import { ExternalLink } from "./ExternalLink";
import { Md } from "./Md";

interface Props {
  version: string;
  /** The release's changes, as the panel shows them. Null when they can't be had here: then the page on GitHub is linked. */
  notes: string | null;
  onClose: () => void;
}

/**
 * "What's new in Lantern X": shown once after an update, and from Settings ▸ Updates. Pictures in the notes stay off,
 * as the release may carry any.
 */
export function WhatsNew({ version, notes, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal: there, the attribute alone opens it (as in the mode guide).
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  return (
    <dialog ref={ref} className="whats-new" aria-labelledby="whats-new-title" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="whats-new-body">
        <h2 className="mode-guide-title" id="whats-new-title">
          What's new in Lantern {version}
        </h2>
        {notes ? (
          <div className="whats-new-notes msg assistant">
            <Md images={false}>{notes}</Md>
          </div>
        ) : (
          <p className="mode-guide-summary">The changes for this version aren't kept here. They're on its release page.</p>
        )}
        <div className="mode-guide-actions">
          <ExternalLink className="whats-new-link" href={releasePage(version)}>
            Release page
          </ExternalLink>
          <button className="primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </dialog>
  );
}
