import { useState } from "react";
import { useChatState, useNodeActions } from "../lib/canvasContext";
import { usePopover } from "../lib/usePopover";
import { SUBAGENTS_LABEL, type Subagents } from "../lib/workflow";

const ROWS: { value: Subagents; hint: string }[] = [
  { value: "canvas", hint: "The Lead's helpers become agents with a window, a chat and, if they write, a branch of their own" },
  { value: "inline", hint: "They run inside the Lead's chat, shown only in its Agents tab" },
];

/**
 * The team's Subagents setting, in the canvas controls: where the Lead's built-in helpers (its Agent tool) run. On the
 * canvas by default; the Lead is told which, and a plain chat (not a team) always runs its subagents inline.
 */
export function SubagentsMenu({ main }: { main: string }) {
  const [open, setOpen] = useState(false);
  const lead = useChatState(main);
  const actions = useNodeActions();
  const { box, button, list, id } = usePopover(open, () => setOpen(false));
  if (!lead) return null;
  return (
    <div className="canvas-team" ref={box}>
      <button ref={button} className="canvas-fit" aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined} title="Where the Lead's built-in helpers run: as agents on the canvas, or inline in its chat" onClick={() => setOpen(!open)}>
        Subagents: {SUBAGENTS_LABEL[lead.subagents]}
      </button>
      {open && (
        <div id={id} ref={list} className="canvas-team-list subagents-list" role="menu" aria-label="Subagents">
          {ROWS.map((r) => (
            <button
              key={r.value}
              role="menuitemradio"
              aria-checked={r.value === lead.subagents}
              className={r.value === lead.subagents ? "current" : undefined}
              onClick={() => {
                setOpen(false);
                if (r.value !== lead.subagents) actions.setSubagents(main, r.value);
              }}
            >
              <span className="team-text">
                <span className="team-name">{SUBAGENTS_LABEL[r.value]}</span>
                <span className="team-line">{r.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
