import { useEffect, useRef, useState } from "react";
import { useChatStates } from "../lib/canvasContext";
import { nodeStatus, statusLabel, type OrchestraNode } from "../lib/orchestraView";
import { usePopover } from "../lib/usePopover";
import { useMenuKeys } from "./useMenuKeys";
import { NewAgent } from "./NewAgent";
import { SubagentsRows } from "./SubagentsMenu";
import { ReviewRows } from "./ReviewMenu";

/**
 * The canvas controls that fold away when the canvas is narrow ("⋯"): where the Lead's subagents run, starting an agent, and
 * putting a hidden agent back. It is the same set the toolbar shows beside Team when there is room; which of the two is
 * drawn is the stylesheet's container query, so this stays in the page either way.
 */
export function CanvasOverflow({ main, hidden, onShow }: { main: string; hidden: OrchestraNode[]; onShow: (slot: string) => void }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const states = useChatStates(hidden.map((n) => n.slot));
  const { box, button, id } = usePopover(open, () => setOpen(false), false);
  const keys = useMenuKeys(open, box);
  // The new-agent form closed (Escape, Cancel, started): focus goes back to "⋯", not to the page.
  const wasAdding = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    if (wasAdding.current && !adding && (!active || active === document.body)) button.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  return (
    <div className="canvas-team canvas-ctl-more" ref={box}>
      <button ref={button} className="icon" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label="More canvas controls" title="More: Subagents, review and test, a new agent, hidden agents" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div id={id} className="canvas-team-list subagents-list canvas-more-list" role="menu" aria-label="More canvas controls" onKeyDown={keys.onKeyDown}>
          <div className="canvas-more-head" role="presentation">
            Subagents
          </div>
          <SubagentsRows main={main} onPick={() => setOpen(false)} />
          <div className="canvas-more-head" role="presentation">
            Review and test
          </div>
          <ReviewRows main={main} />
          <div className="canvas-more-head" role="presentation">
            Agents
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
          >
            <span className="team-text">
              <span className="team-name">+ Agent</span>
              <span className="team-line">Start an agent yourself</span>
            </span>
          </button>
          {hidden.map((n, i) => {
            const label = statusLabel(states[i] ? nodeStatus(states[i]!) : "ended", n.role);
            return (
              <button
                key={n.slot}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onShow(n.slot);
                }}
              >
                <span className="team-text">
                  <span className="team-name">Show {n.name}</span>
                  <span className="team-line">Hidden · {label}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <NewAgent main={main} shown={{ open: adding, setOpen: setAdding }} />
    </div>
  );
}
