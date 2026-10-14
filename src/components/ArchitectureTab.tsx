import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fitScale, issuesOf, layoutArchitecture, nearest, parseArchitecture, routePath, type ArchLayout, type Change, type MapIssue, type PlacedNode, type Status } from "../lib/archGraph";
import type { ArchitectureMap } from "../lib/architecture";
import { MapDiagram, useDiagram } from "./Diagram";
import { svgSize } from "../lib/mermaid";
import { useArchitecturePane } from "../lib/architecturePane";
import { PanZoom } from "./PanZoom";

export const CHANGE_LABEL: Record<Change, string> = { new: "New", changed: "Changed", removed: "Removed" };
export const STATUS_LABEL: Record<Status, string> = { done: "Done", "in-progress": "In progress", planned: "Planned" };
/** A box's caption under its label: how far it's built. */
const CAPTION: Record<Status, string> = { done: "Done ✓", "in-progress": "In progress", planned: "Planned" };
/** An arrow label's pill: as wide as its words at the label's size. */
const tagWidth = (e: { label: string; issue: string; skips: string[] }) => (e.label.length + (e.issue || e.skips.length ? 2 : 0)) * 5.9 + 14;
const ARROWS: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

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
  /** An issue picked from the list: its box or arrow is lit. */
  picked?: MapIssue | null;
}

/**
 * The map, drawn in the app's own style: each layer a band with its name, each box a button that opens its part's page
 * (its colour how far it's built, a ⚠ when Claude found a problem with it), and each arrow marked where it crosses from
 * one layer into the next. An arrow that goes around a layer is drawn in amber; one Claude found a problem with, in red.
 */
export function ArchGraphSvg({ layout, current, opens, onOpen, shown = null, onShow, picked = null }: GraphProps) {
  const svg = useRef<SVGSVGElement>(null);
  const focused = layout.nodes.some((n) => current.includes(n.id)) || picked !== null;
  const lit = (id: string) => current.includes(id) || picked?.node === id;
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
      {layout.bands.map((b, i) => (
        <g key={b.id} className={`arch-band${i % 2 ? " odd" : ""}`} aria-label={`Layer: ${b.label}`}>
          <rect x={0} y={b.y} width={layout.width} height={b.h} />
          {i > 0 && <line x1={0} x2={layout.width} y1={b.y} y2={b.y} className="arch-band-line" />}
          <text x={16} y={b.y + b.h / 2 + 4} className="arch-band-label">
            {b.label}
          </text>
        </g>
      ))}
      {layout.edges.map((e) => {
        const on = current.includes(e.from) || current.includes(e.to) || picked?.edge === e.key;
        const kind = e.issue ? " issue" : e.skips.length ? " skip" : "";
        const why = [e.issue, e.skips.length ? `Goes around ${e.skips.join(" and ")}` : ""].filter(Boolean).join(". ");
        return (
          <g key={e.key} className={`arch-edge${on ? " lit" : ""}${kind}`}>
            {why && <title>{why}</title>}
            <path d={e.path ?? routePath(e.points)} markerEnd="url(#arch-arrow)" />
            {e.crossings.map((c, i) => (
              <circle key={i} cx={c.x} cy={c.y} r={3.2} className="arch-crossing" />
            ))}
            {/* Labels on the arrows that matter right now: the lit part's, a hovered box's, and the flagged ones. */}
            {e.labelAt && (on || shown === e.from || shown === e.to || kind) && (
              <g className="arch-edge-tag">
                {/* A small pill behind the words, so a label that lands on a box still reads. */}
                <rect x={e.labelAt.x - tagWidth(e) / 2} y={e.labelAt.y - 8} width={tagWidth(e)} height={16} rx={8} />
                <text x={e.labelAt.x} y={e.labelAt.y + 4} className="arch-edge-label">
                  {e.issue || e.skips.length > 0 ? "⚠ " : null}
                  {e.label}
                </text>
              </g>
            )}
          </g>
        );
      })}
      {layout.nodes.map((n) => {
        const page = opens[n.id];
        const said = [n.change ? CHANGE_LABEL[n.change].toLowerCase() : "", n.status ? STATUS_LABEL[n.status].toLowerCase() : "", n.issue ? "has an issue" : "", page ? "" : "no page of its own"].filter(Boolean);
        const text = n.h / 2 - ((n.lines.length - 1) * 16) / 2 - (n.status ? 7 : 0) + 4.5;
        return (
          <g
            key={n.id}
            data-node={n.id}
            className={`arch-box${n.change ? ` ${n.change}` : ""}${n.status ? ` st-${n.status}` : ""}${n.issue ? " has-issue" : ""}${lit(n.id) ? " covered" : ""}${page ? " opens" : ""}${shown === n.id ? " shown" : ""}`}
            transform={`translate(${n.x - n.w / 2}, ${n.y - n.h / 2})`}
            tabIndex={0}
            role="button"
            aria-label={`${n.label}${said.length ? `, ${said.join(", ")}` : ""}`}
            onMouseEnter={() => onShow?.(n.id)}
            onMouseLeave={() => onShow?.(null)}
            onFocus={() => onShow?.(n.id)}
            onBlur={() => onShow?.(null)}
            onClick={() => page && onOpen?.(page)}
            onKeyDown={(e) => onKey(e, n)}
          >
            <title>{[n.label, n.note, n.issue ? `⚠ ${n.issue}` : ""].filter(Boolean).join(": ")}</title>
            <rect className="arch-ring" x={-5} y={-5} width={n.w + 10} height={n.h + 10} rx={14} />
            <rect className="arch-rect" width={n.w} height={n.h} rx={10} />
            {n.change && <rect className="arch-stripe" width={4} height={n.h - 16} x={6} y={8} rx={2} />}
            <text className="arch-label" x={n.w / 2 + (n.change ? 3 : 0)} y={text}>
              {n.lines.map((l, i) => (
                <tspan key={i} x={n.w / 2 + (n.change ? 3 : 0)} dy={i === 0 ? 0 : 16}>
                  {l}
                </tspan>
              ))}
            </text>
            {n.status && (
              <text className="arch-caption" x={n.w / 2 + (n.change ? 3 : 0)} y={n.h - 10}>
                {CAPTION[n.status]}
              </text>
            )}
            {n.issue && (
              <g className="arch-issue-badge" transform={`translate(${n.w - 4}, 4)`}>
                <circle r={9} />
                <text y={4}>!</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** What the box being looked at is, does, and which page covers it; when none is, every issue on the map. */
function NodePanel({ node, page, layer, issues, picked, onPick, onOpen }: { node: PlacedNode | null; page: { key: string; name: string } | null; layer: string | null; issues: MapIssue[]; picked: MapIssue | null; onPick: (i: MapIssue | null) => void; onOpen: (key: string) => void }) {
  if (!node) {
    if (issues.length === 0) return <div className="graph-panel arch-panel"><div className="graph-panel-hint">Hover a box to see what it does; click it to open its page. Drag to move, pinch or ⌘-scroll to zoom.</div></div>;
    return (
      <div className="graph-panel arch-panel arch-issues" aria-label="Issues">
        <div className="graph-panel-title">
          <strong className="arch-panel-name">{issues.length === 1 ? "1 issue" : `${issues.length} issues`}</strong>
          <span className="arch-panel-hint">hover one to find it on the map</span>
        </div>
        <ul>
          {issues.map((i) => (
            <li key={i.key} className={`${i.found ? "found" : "marked"}${picked?.key === i.key ? " picked" : ""}`} onMouseEnter={() => onPick(i)} onMouseLeave={() => onPick(null)}>
              <span className="arch-issue-mark" aria-hidden>
                ⚠
              </span>
              {i.text}
              {i.found && <span className="arch-issue-by"> (found by Lantern from the layers)</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="graph-panel arch-panel" aria-live="polite">
      <div className="graph-panel-title">
        <strong className="arch-panel-name">{node.label}</strong>
        {node.status && <span className={`arch-badge st-${node.status}`}>{STATUS_LABEL[node.status]}</span>}
        {node.change && <span className={`arch-badge ${node.change}`}>{CHANGE_LABEL[node.change]}</span>}
        {layer && <span className="arch-panel-layer">{layer}</span>}
        {page && (
          <button className="link-button arch-panel-open" onClick={() => onOpen(page.key)}>
            {page.name} →
          </button>
        )}
      </div>
      <div className="arch-panel-note">{node.note || "No description."}</div>
      {node.issue && <div className="arch-panel-issue">⚠ {node.issue}</div>}
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

/** What the map's legend lists: only what it uses. */
function Legend({ layout }: { layout: ArchLayout }) {
  const statuses = (["done", "in-progress", "planned"] as const).filter((s) => layout.nodes.some((n) => n.status === s));
  const changes = (["new", "changed", "removed"] as const).filter((c) => layout.nodes.some((n) => n.change === c));
  const crossings = layout.edges.reduce((s, e) => s + e.crossings.length, 0);
  return (
    <span className="arch-legend" aria-label="Legend">
      {statuses.map((s) => (
        <span key={s} className={`arch-badge st-${s}`}>
          {STATUS_LABEL[s]}
        </span>
      ))}
      {changes.map((c) => (
        <span key={c} className={`arch-badge ${c}`}>
          {CHANGE_LABEL[c]}
        </span>
      ))}
      {layout.bands.length > 0 && (
        <span className="arch-badge crossings" title="Where an arrow crosses from one layer into another">
          {crossings === 1 ? "1 crossing" : `${crossings} crossings`}
        </span>
      )}
    </span>
  );
}

/** The right pane's Architecture tab: the latest Overview's map, on a surface you can move around. */
export function ArchitectureTab({ map, current, pageNames, onOpenPage }: TabProps) {
  // Laid out both ways; the one that shows bigger in the pane is drawn (a pane is usually taller than it is wide). A map
  // with layers has one way: its bands, top to bottom.
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
  const issues = useMemo(() => (layout ? issuesOf(layout) : []), [layout]);
  const [shown, setShown] = useState<string | null>(null);
  const [picked, setPicked] = useState<MapIssue | null>(null);
  const node = layout?.nodes.find((n) => n.id === shown) ?? null;
  const page = node && map.nodes[node.id] ? { key: map.nodes[node.id], name: pageNames[map.nodes[node.id]] ?? "Its page" } : null;
  const layer = node?.layer && map.kind === "native" ? (map.spec.layers.find((l) => l.id === node.layer)?.label ?? null) : null;
  return (
    <div className="arch-tab">
      <div className="arch-tab-head">
        <span className="arch-tab-title" title={map.title}>
          {map.title || "Architecture"}
        </span>
        {layout && <Legend layout={layout} />}
      </div>
      {layout ? (
        <>
          <div ref={body} className="arch-tab-body">
            <PanZoom width={layout.width} height={layout.height} label="Architecture map" fitKey={direction + map.page + JSON.stringify(map.kind === "native" ? map.spec : "")}>
              <ArchGraphSvg layout={layout} current={current} opens={map.nodes} onOpen={onOpenPage} shown={shown} onShow={setShown} picked={picked} />
            </PanZoom>
          </div>
          <NodePanel node={node} page={page} layer={layer} issues={issues} picked={picked} onPick={setPicked} onOpen={onOpenPage} />
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
  const issues = issuesOf(layout).length;
  return (
    <div className="code-block arch-block">
      <div className="code-block-head">
        <span className="code-block-lang">Architecture map{issues ? ` · ${issues === 1 ? "1 issue" : `${issues} issues`}` : ""}</span>
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
