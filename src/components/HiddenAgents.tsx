import { useEffect, useState } from "react";
import { useChatStates } from "../lib/canvasContext";
import { nodeStatus, statusLabel, type OrchestraNode } from "../lib/orchestraView";
import { usePopover } from "../lib/usePopover";

/** The agents the user took off the canvas, each with what it is doing and a way to put it back. Shown only when there are some. */
export function HiddenAgents({ nodes, onShow }: { nodes: OrchestraNode[]; onShow: (slot: string) => void }) {
  const [open, setOpen] = useState(false);
  const states = useChatStates(nodes.map((n) => n.slot));
  const { box, button, list, id } = usePopover(open, () => setOpen(false));
  // The last one coming back (by itself, say) leaves nothing to list: the next one hidden starts closed.
  useEffect(() => {
    if (nodes.length === 0) setOpen(false);
  }, [nodes.length]);
  if (nodes.length === 0) return null;

  return (
    <div className="canvas-team" ref={box}>
      <button ref={button} className="canvas-fit" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} title="Agents you took off the canvas: they keep working" onClick={() => setOpen(!open)}>
        Hidden ({nodes.length})
      </button>
      {open && (
        <div id={id} ref={list} className="canvas-team-list" role="dialog" aria-label="Hidden agents">
          <ul>
            {nodes.map((n, i) => {
              const status = states[i] ? nodeStatus(states[i]!) : "ended";
              const label = statusLabel(status, n.role);
              return (
                <li key={n.slot}>
                  <button
                    aria-label={`Show ${n.name}, ${label}`}
                    onClick={() => {
                      if (nodes.length === 1) setOpen(false);
                      onShow(n.slot);
                    }}
                  >
                    <span className={`node-dot ${status}`} aria-hidden />
                    <span className="team-text">
                      <span className="team-name">{n.name}</span>
                      <span className="team-line">{label}</span>
                    </span>
                    <span className="team-state">Show</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
