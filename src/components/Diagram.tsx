import { useEffect, useRef, useState, type MouseEvent } from "react";
import { PanZoom } from "./PanZoom";
import { nodeIdOf, renderDiagram, withChangeColours } from "../lib/mermaid";
import { usePrefersDark, useThemeVersion } from "../lib/theme";

/**
 * A mermaid source drawn as SVG: `svg` once it has been, `error` if mermaid couldn't read it, neither while it loads.
 * A source that's still streaming in is drawn once it stops changing, so half a diagram isn't an error.
 */
export function useDiagram(source: string): { svg: string | null; error: string | null } {
  const dark = usePrefersDark();
  // The diagram takes the theme's colours, so it's drawn again when the theme changes.
  const look = useThemeVersion();
  const [state, setState] = useState<{ source: string; dark: boolean; look: number; svg: string | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!source.trim()) return;
    let live = true;
    const wait = setTimeout(() => {
      renderDiagram(withChangeColours(source), dark).then(
        (svg) => live && setState({ source, dark, look, svg, error: null }),
        (e) => live && setState({ source, dark, look, svg: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [source, dark, look]);
  return state && state.source === source && state.dark === dark && state.look === look ? { svg: state.svg, error: state.error } : { svg: null, error: null };
}

/** The part of a rendered diagram the map can act on: its flowchart nodes, by the id they were written with. */
function nodeElements(root: HTMLElement): { id: string; el: Element }[] {
  const out: { id: string; el: Element }[] = [];
  for (const el of root.querySelectorAll("g.node")) {
    const id = nodeIdOf(el.id);
    if (id) out.push({ id, el });
  }
  return out;
}

interface MapProps {
  /** A map drawn in Mermaid: its source, and which page each of its nodes opens. */
  map: { source: string; nodes: Record<string, string> };
  /** The nodes the page on screen covers, lit up. */
  current: string[];
  /** A node that has a page was clicked. */
  onOpen: (pageKey: string) => void;
}

/**
 * An architecture map drawn in Mermaid, as Overviews were before Lantern drew them itself: the diagram, with the page on
 * screen's nodes lit and the nodes that have a page clickable. It sits on the Architecture tab's pan and zoom surface.
 */
export function MapDiagram({ map, current, onOpen }: MapProps) {
  const { svg, error } = useDiagram(map.source);
  const root = useRef<HTMLDivElement>(null);
  // Mermaid's markup is set directly; lighting nodes is classes on the elements it made.
  useEffect(() => {
    const el = root.current;
    if (!el || !svg) return;
    const nodes = nodeElements(el);
    for (const { id, el: node } of nodes) {
      node.classList.toggle("covered", current.includes(id));
      node.classList.toggle("opens", id in map.nodes);
    }
    // With a part on screen, everything else steps back, so the map says where you are at a glance.
    el.classList.toggle("focused", nodes.some(({ id }) => current.includes(id)));
  }, [svg, current.join(","), Object.keys(map.nodes).join(",")]);

  const click = (e: MouseEvent<HTMLDivElement>) => {
    const node = (e.target as Element).closest("g.node");
    const id = node ? nodeIdOf(node.id) : null;
    if (id && map.nodes[id]) onOpen(map.nodes[id]);
  };

  if (error) return <div className="map-empty">The map couldn't be drawn: {error.split("\n")[0]}</div>;
  if (!svg) return <div className="map-empty">Drawing the map…</div>;
  // The SVG is mermaid's, drawn in its strict security level (scripts and click handlers off, labels sanitised).
  return <div ref={root} className="map-svg" onClick={click} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A drawn diagram at full size, on a surface you can zoom and move: from a diagram's Expand button in a message. */
export function DiagramLightbox({ svg, size, onClose }: { svg: string; size: { w: number; h: number }; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  return (
    <dialog ref={ref} className="arch-big" aria-label="Diagram" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="arch-big-head">
        <span className="arch-tab-title">Diagram</span>
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div className="arch-big-body">
        <PanZoom width={size.w} height={size.h} label="Diagram">
          {/* Mermaid's markup, as drawn in its strict security level. */}
          <div className="map-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        </PanZoom>
      </div>
    </dialog>
  );
}
