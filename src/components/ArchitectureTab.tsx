import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fitScale, labelFits, layoutArchitecture, nearest, parseArchitecture, routePath, type ArchLayout, type Change, type PlacedNode } from "../lib/archGraph";
import type { ArchitectureMap } from "../lib/architecture";
import { MapDiagram, useDiagram } from "./Diagram";
import { svgSize } from "../lib/mermaid";
import { useArchitecturePane } from "../lib/architecturePane";
import { PanZoom } from "./PanZoom";

export const CHANGE_LABEL: Record<Change, string> = { new: "New", changed: "Changed", removed: "Removed" };
const ARROWS: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s);

interface GraphProps {
  layout: ArchLayout;
  /** The boxes the page on screen is about: lit, and everything else steps back. */
  current: string[];
  /** Box id → the page that covers it (a click opens it). */
  opens: Record<string, string>;
  onOpen?: (pageKey: string) => void;
  /** The box being looked at (hovered, focused or chosen with the keys). */
  shown?: string | null;
  onShow?: (id: string | null) => void;
}

/** The boxes and arrows, drawn in the app's own style: each box a button that opens its part's page. */
export function ArchGraphSvg({ layout, current, opens, onOpen, shown = null, onShow }: GraphProps) {
  const svg = useRef<SVGSVGElement>(null);
  const focused = layout.nodes.some((n) => current.includes(n.id));
  const onKey = (e: KeyboardEvent, n: PlacedNode) => {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const to = nearest(layout.nodes, n.id, dir);
      if (to) svg.current?.querySelector<SVGGElement>(`[data-node=${JSON.stringify(to)}]`)?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && opens[n.id]) {
      e.preventDefault();
      onOpen?.(opens[n.id]);
    }
  };
  return (
    <svg ref={svg} className={`arch-graph${focused ? " focused" : ""}`} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Architecture map">
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" className="arch-arrowhead" />
        </marker>
      </defs>
      {layout.edges.map((e) => {
        const lit = current.includes(e.from) || current.includes(e.to);
        return (
          <g key={e.key} className={`arch-edge${lit ? " lit" : ""}`}>
            <path d={routePath(e.points)} markerEnd="url(#arch-arrow)" />
            {e.labelAt && (
              <text x={e.labelAt.x} y={e.labelAt.y + 4} className="arch-edge-label">
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {layout.nodes.map((n) => {
        const page = opens[n.id];
        return (
          <g
            key={n.id}
            data-node={n.id}
            className={`arch-box${n.change ? ` ${n.change}` : ""}${current.includes(n.id) ? " covered" : ""}${page ? " opens" : ""}${shown === n.id ? " shown" : ""}`}
            transform={`translate(${n.x - n.w / 2}, ${n.y - n.h / 2})`}
            tabIndex={0}
            role="button"
            aria-label={`${n.label}${n.change ? `, ${CHANGE_LABEL[n.change].toLowerCase()}` : ""}${page ? "" : ", no page of its own"}`}
            onMouseEnter={() => onShow?.(n.id)}
            onMouseLeave={() => onShow?.(null)}
            onFocus={() => onShow?.(n.id)}
            onBlur={() => onShow?.(null)}
            onClick={() => page && onOpen?.(page)}
            onKeyDown={(e) => onKey(e, n)}
          >
            <title>{n.note ? `${n.label}: ${n.note}` : n.label}</title>
            <rect className="arch-ring" x={-5} y={-5} width={n.w + 10} height={n.h + 10} rx={14} />
            <rect className="arch-rect" width={n.w} height={n.h} rx={10} />
            {n.change && <rect className="arch-stripe" width={4} height={n.h - 16} x={6} y={8} rx={2} />}
            <text className="arch-label" x={n.w / 2 + (n.change ? 3 : 0)} y={n.h / 2 + 4.5}>
              {fit(n.label, labelFits(n.w))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** What the box being looked at is, does, and which page covers it. */
function NodePanel({ node, page, onOpen }: { node: PlacedNode | null; page: { key: string; name: string } | null; onOpen: (key: string) => void }) {
  if (!node) return <div className="graph-panel arch-panel"><div className="graph-panel-hint">Hover a box to see what it does; click it to open its page. Drag to move, pinch or ⌘-scroll to zoom.</div></div>;
  return (
    <div className="graph-panel arch-panel" aria-live="polite">
      <div className="graph-panel-title">
        <strong className="arch-panel-name">{node.label}</strong>
        {node.change && <span className={`arch-badge ${node.change}`}>{CHANGE_LABEL[node.change]}</span>}
        {page && (
          <button className="link-button arch-panel-open" onClick={() => onOpen(page.key)}>
            {page.name} →
          </button>
        )}
      </div>
      <div className="arch-panel-note">{node.note || "No description."}</div>
    </div>
  );
}

interface TabProps {
  map: ArchitectureMap;
  current: string[];
  /** Each page's name ("Part 2 of 3 — Retry policy"), for the panel's link. */
  pageNames: Record<string, string>;
  onOpenPage: (pageKey: string) => void;
}

/** The right pane's Architecture tab: the latest Overview's map, on a surface you can move around. */
export function ArchitectureTab({ map, current, pageNames, onOpenPage }: TabProps) {
  // Laid out both ways; the one that shows bigger in the pane is drawn (a pane is usually taller than it is wide).
  const both = useMemo(() => (map.kind === "native" ? { LR: layoutArchitecture(map.spec, "LR"), TB: layoutArchitecture(map.spec, "TB") } : null), [map]);
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [both !== null]);
  const direction = both && room.w > 0 && fitScale(both.TB, room) > fitScale(both.LR, room) * 1.08 ? "TB" : "LR";
  const layout = both ? both[direction] : null;
  const [shown, setShown] = useState<string | null>(null);
  const node = layout?.nodes.find((n) => n.id === shown) ?? null;
  const page = node && map.nodes[node.id] ? { key: map.nodes[node.id], name: pageNames[map.nodes[node.id]] ?? "Its page" } : null;
  return (
    <div className="arch-tab">
      <div className="arch-tab-head">
        <span className="arch-tab-title" title={map.title}>
          {map.title || "Architecture"}
        </span>
        {map.kind === "native" && (
          <span className="arch-legend" aria-label="Legend">
            {(["new", "changed", "removed"] as const)
              .filter((c) => map.spec.nodes.some((n) => n.change === c))
              .map((c) => (
                <span key={c} className={`arch-badge ${c}`}>
                  {CHANGE_LABEL[c]}
                </span>
              ))}
          </span>
        )}
      </div>
      {layout ? (
        <>
          <div ref={body} className="arch-tab-body">
            <PanZoom width={layout.width} height={layout.height} label="Architecture map" fitKey={direction + map.page + JSON.stringify(map.kind === "native" ? map.spec : "")}>
              <ArchGraphSvg layout={layout} current={current} opens={map.nodes} onOpen={onOpenPage} shown={shown} onShow={setShown} />
            </PanZoom>
          </div>
          <NodePanel node={node} page={page} onOpen={onOpenPage} />
        </>
      ) : map.kind === "mermaid" ? (
        <MermaidMap map={map} current={current} onOpenPage={onOpenPage} />
      ) : (
        <div className="arch-broken">
          <p>The Overview's map couldn't be read: {map.kind === "broken" ? map.error : ""} Ask Claude to write the Overview again.</p>
          <pre className="permission-detail">{map.kind === "broken" ? map.text : ""}</pre>
        </div>
      )}
    </div>
  );
}

/** An Overview drawn in Mermaid (before Lantern drew maps itself): the same surface, Mermaid's picture on it. */
function MermaidMap({ map, current, onOpenPage }: { map: Extract<ArchitectureMap, { kind: "mermaid" }>; current: string[]; onOpenPage: (key: string) => void }) {
  const { svg } = useDiagram(map.source);
  const size = svg ? svgSize(svg) : null;
  if (!size) return <MapDiagram map={map} current={current} onOpen={onOpenPage} />;
  return (
    <PanZoom width={size.w} height={size.h} label="Architecture map" fitKey={map.page + map.source}>
      <MapDiagram map={map} current={current} onOpen={onOpenPage} />
    </PanZoom>
  );
}

/**
 * An ```architecture block in a message (the Overview page's): the same map, drawn to the message's width, with a way to
 * the pane where it can be explored. A block that doesn't read is shown as the text it is, with what's wrong.
 */
export function ArchitectureBlock({ text }: { text: string }) {
  const read = useMemo(() => parseArchitecture(text), [text]);
  const layout = useMemo(() => ("spec" in read ? layoutArchitecture(read.spec) : null), [read]);
  const openPane = useArchitecturePane();
  if (!layout) {
    return (
      <div className="code-block">
        <div className="code-block-head">
          <span className="code-block-lang">Architecture</span>
          <span className="code-block-note">{"error" in read ? `Couldn't draw this map: ${read.error}` : ""}</span>
        </div>
        <pre>{text}</pre>
      </div>
    );
  }
  return (
    <div className="code-block arch-block">
      <div className="code-block-head">
        <span className="code-block-lang">Architecture map</span>
        {openPane && (
          <button className="code-block-copy arch-block-open" onClick={openPane}>
            Open in the pane
          </button>
        )}
      </div>
      <div className="arch-block-body" onClick={openPane ?? undefined}>
        <ArchGraphSvg layout={layout} current={[]} opens={{}} />
      </div>
    </div>
  );
}
