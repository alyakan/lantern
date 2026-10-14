import { useRef, useState } from "react";
import { useChatStates } from "../lib/canvasContext";
import { nodeStatus, STATUS_LABEL, type OrchestraNode } from "../lib/orchestraView";
import { useDismiss } from "../lib/useDismiss";

/** The agents the user took off the canvas, each with what it is doing and a way to put it back. Shown only when there are some. */
export function HiddenAgents({ nodes, onShow }: { nodes: OrchestraNode[]; onShow: (slot: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const states = useChatStates(nodes.map((n) => n.slot));
  useDismiss(open, box, () => setOpen(false));
  if (nodes.length === 0) return null;

  return (
    <div className="canvas-team" ref={box}>
      {open && (
        <div className="canvas-team-list" role="dialog" aria-label="Hidden agents">
          <ul>
            {nodes.map((n, i) => {
              const status = states[i] ? nodeStatus(states[i]!) : "ended";
              return (
                <li key={n.slot}>
                  <button
                    aria-label={`Show ${n.name}, ${STATUS_LABEL[status]}`}
                    onClick={() => {
                      if (nodes.length === 1) setOpen(false);
                      onShow(n.slot);
                    }}
                  >
                    <span className={`node-dot ${status}`} aria-hidden />
                    <span className="team-text">
                      <span className="team-name">{n.name}</span>
                      <span className="team-line">{STATUS_LABEL[status]}</span>
                    </span>
                    <span className="team-state">Show</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <button className="canvas-fit" aria-expanded={open} title="Agents you took off the canvas: they keep working" onClick={() => setOpen(!open)}>
        Hidden ({nodes.length})
      </button>
    </div>
  );
}
