import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ArchitectureMap } from "../lib/architecture";
import { MapDiagram } from "./Diagram";

/** How the docked map is kept: open or slimmed down to a bar, and how tall it is. */
export interface DockState {
  open: boolean;
  height: number;
}

export const DEFAULT_DOCK: DockState = { open: true, height: 230 };
const MIN_HEIGHT = 110;
const MAX_HEIGHT = 560;
const clamp = (h: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)));

interface Props {
  map: ArchitectureMap;
  /** The nodes the page on screen covers. */
  current: string[];
  onOpenPage: (pageKey: string) => void;
  state: DockState;
  onState: (state: DockState) => void;
}

/**
 * The architecture map, pinned above the pages so it stays in view while you read them: the Overview's diagram with the
 * page's nodes lit and the nodes that have a page clickable. It sits across the top, not beside the pages, because a
 * diagram is wide and a chat pane isn't. It can be slimmed to a bar, resized, or opened at full size.
 */
export function ArchitectureDock({ map, current, onOpenPage, state, onState }: Props) {
  const [big, setBig] = useState(false);
  // While dragging the height lives here and moves the dock directly; the state is saved once, on release.
  const dock = useRef<HTMLElement>(null);
  const drag = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = () => {
    if (drag.current !== null) onState({ ...state, height: drag.current });
    drag.current = null;
    setDragging(false);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !dock.current) return;
    if (e.buttons === 0) return endDrag();
    const height = clamp(e.clientY - dock.current.getBoundingClientRect().top);
    drag.current = height;
    dock.current.style.height = `${height}px`;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") onState({ ...state, height: clamp(state.height - 24) });
    else if (e.key === "ArrowDown") onState({ ...state, height: clamp(state.height + 24) });
  };

  if (!state.open) {
    return (
      <aside className="arch-dock collapsed" aria-label="Architecture map">
        <button className="arch-dock-tab" title="Show the architecture map" aria-label="Show the architecture map" onClick={() => onState({ ...state, open: true })}>
          <span className="arch-dock-title">Architecture map</span>
          <span className="chev down" aria-hidden />
        </button>
      </aside>
    );
  }
  return (
    <aside ref={dock} className={`arch-dock${dragging ? " dragging" : ""}`} style={{ height: state.height }} aria-label="Architecture map">
      <div className="arch-dock-head">
        <span className="arch-dock-title">Architecture map</span>
        <span className="arch-dock-hint">Click a box to open its page</span>
        <span className="spacer" />
        <button className="arch-dock-btn" title="Open at full size" aria-label="Open the map at full size" onClick={() => setBig(true)}>
          ⤢
        </button>
        <button className="arch-dock-btn" title="Hide the map" aria-label="Hide the map" onClick={() => onState({ ...state, open: false })}>
          ⌃
        </button>
      </div>
      <div className="arch-dock-body">
        <MapDiagram map={map} current={current} onOpen={onOpenPage} />
      </div>
      <div className="arch-dock-handle" role="separator" aria-orientation="horizontal" aria-label="Resize the map" aria-valuenow={state.height} tabIndex={0} title="Drag to resize, double-click to reset" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onDoubleClick={() => onState({ ...state, height: DEFAULT_DOCK.height })} onKeyDown={onKeyDown} />
      {big && <BigMap map={map} current={current} onOpenPage={(key) => (setBig(false), onOpenPage(key))} onClose={() => setBig(false)} />}
    </aside>
  );
}

/** The map at full size: a dialog with zoom, scrolling for a diagram bigger than the window. */
function BigMap({ map, current, onOpenPage, onClose }: { map: ArchitectureMap; current: string[]; onOpenPage: (pageKey: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  return (
    <dialog ref={ref} className="arch-big" aria-label="Architecture map" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="arch-big-head">
        <span className="arch-dock-title">Architecture map</span>
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div className="arch-big-body">
        <MapDiagram map={map} current={current} onOpen={onOpenPage} large />
      </div>
    </dialog>
  );
}
