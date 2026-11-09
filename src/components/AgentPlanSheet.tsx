import { useId, useRef, useState, type PointerEvent } from "react";
import type { AgentTodo } from "../types";

/** The current chat's progress sheet, tucked behind its composer. */
export function AgentPlanSheet({ todos }: { todos: AgentTodo[] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ pointer: number; y: number; height: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed");
  const limit = Math.min(280, window.innerHeight * 0.35, todos.length * 48 + 12);
  const height = dragHeight ?? (open ? limit : 0);
  if (!todos.length || done === todos.length) return null;

  const finish = (e: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const started = drag.current;
    if (!started || started.pointer !== e.pointerId) return;
    if (started.moved) {
      if (!cancelled) setOpen(height > limit / 2);
      suppressClick.current = true;
    }
    drag.current = null;
    setDragHeight(null);
  };

  return (
    <section className={`agent-plan${dragHeight !== null ? " dragging" : ""}`} aria-label="Agent checklist">
      <button
        type="button"
        className="agent-plan-handle"
        aria-label={`Plan, ${done} of ${todos.length} done${current ? `, now: ${current.status === "in_progress" ? current.active_form || current.content : current.content}` : ""}`}
        aria-expanded={open}
        aria-controls={id}
        title={open ? "Click or drag down to collapse the checklist" : "Click or drag up to show the checklist"}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); e.stopPropagation(); }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary) return;
          suppressClick.current = false;
          drag.current = { pointer: e.pointerId, y: e.clientY, height, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const started = drag.current;
          if (!started || started.pointer !== e.pointerId) return;
          const dy = e.clientY - started.y;
          if (!started.moved && Math.abs(dy) < 5) return;
          started.moved = true;
          setDragHeight(Math.max(0, Math.min(limit, started.height - dy)));
        }}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
        onLostPointerCapture={(e) => finish(e, true)}
      >
        <span className="agent-plan-grabber" aria-hidden="true" />
        <span className="agent-plan-summary">
          <span className="agent-plan-count">{done}/{todos.length}</span>
          <span className="agent-plan-current">{current?.status === "in_progress" ? current.active_form || current.content : current?.content}</span>
          <span aria-hidden="true">{open ? "⌄" : "⌃"}</span>
        </span>
      </button>
      <div id={id} className="agent-plan-details" style={{ height }} aria-hidden={!open} inert={!open}>
        <ol className="agent-plan-steps">
          {todos.map((t, i) => (
            <li key={i} className={`agent-plan-step ${t.status}`} aria-label={`${t.status === "completed" ? "Done" : t.status === "in_progress" ? "Doing" : "To do"}: ${t.content}`}>
              <span className="agent-plan-mark" aria-hidden="true">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}</span>
              <span>{t.status === "in_progress" ? t.active_form || t.content : t.content}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
