import { useEffect, useRef, useState, type MouseEvent } from "react";
import { nodeIdOf, renderDiagram, withChangeColours } from "../lib/mermaid";
import { usePrefersDark } from "../lib/theme";
import type { ArchitectureMap } from "../lib/architecture";

/**
 * A mermaid source drawn as SVG: `svg` once it has been, `error` if mermaid couldn't read it, neither while it loads.
 * A source that's still streaming in is drawn once it stops changing, so half a diagram isn't an error.
 */
export function useDiagram(source: string): { svg: string | null; error: string | null } {
  const dark = usePrefersDark();
  const [state, setState] = useState<{ source: string; dark: boolean; svg: string | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!source.trim()) return;
    let live = true;
    const wait = setTimeout(() => {
      renderDiagram(withChangeColours(source), dark).then(
        (svg) => live && setState({ source, dark, svg, error: null }),
        (e) => live && setState({ source, dark, svg: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [source, dark]);
  return state && state.source === source && state.dark === dark ? { svg: state.svg, error: state.error } : { svg: null, error: null };
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
  map: ArchitectureMap;
  /** The nodes the page on screen covers, lit up. */
  current: string[];
  /** A node that has a page was clicked. */
  onOpen: (pageKey: string) => void;
  /** Bigger than the dock: zoom buttons, and the diagram at its own size. */
  large?: boolean;
}

/** The architecture map: the Overview's diagram, with the page on screen's nodes lit and the nodes that have a page clickable. */
export function MapDiagram({ map, current, onOpen, large = false }: MapProps) {
  const { svg, error } = useDiagram(map.source);
  const root = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
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
  return (
    <div className={`map-diagram${large ? " large" : ""}`}>
      {large && (
        <div className="map-zoom" role="group" aria-label="Zoom">
          <button onClick={() => setZoom((z) => Math.max(0.4, z / 1.25))} aria-label="Zoom out">
            −
          </button>
          <button onClick={() => setZoom(1)} aria-label="Actual size">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => setZoom((z) => Math.min(4, z * 1.25))} aria-label="Zoom in">
            +
          </button>
        </div>
      )}
      {/* The SVG is mermaid's, drawn in its strict security level (scripts and click handlers off, labels sanitised). */}
      <div ref={root} className="map-svg" style={large ? { zoom } : undefined} onClick={click} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
