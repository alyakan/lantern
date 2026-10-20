import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { bestRows, fitScale, issuesOf, layoutArchitecture, nearest, parseArchitecture, pillWidth, routePath, type ArchLayout, type Change, type MapIssue, type PlacedNode, type Status } from "../lib/archGraph";
import { focusOf } from "../lib/archFocus";
import type { ArchitectureMap } from "../lib/architecture";
import { MapDiagram, useDiagram } from "./Diagram";
import { svgSize } from "../lib/mermaid";
import { useArchitecturePane } from "../lib/architecturePane";
import { PanZoom, useReveal } from "./PanZoom";

export const CHANGE_LABEL: Record<Change, string> = { new: "New", changed: "Changed", removed: "Removed" };
export const STATUS_LABEL: Record<Status, string> = { done: "Done", "in-progress": "In progress", planned: "Planned" };
/** A box's caption under its label: how far it's built. */
const CAPTION: Record<Status, string> = { done: "Done ✓", "in-progress": "In progress", planned: "Planned" };
/** Fit never zooms the map out past this: a box's name stays about 9px, and a map that doesn't fit is panned. */
const MIN_FIT = 0.75;
/** The room the legend (top) and the controls and issues chip (bottom) take over the map, which Fit keeps the drawing clear of. */
const OVERLAY_INSET = { top: 34, bottom: 44 };
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
  /** A box a page's chip named: it is lit and brought into view, each time `key` changes. */
  reveal?: { id: string; key: number } | null;
  /** Everything at full strength (the Show all button is held). */
  all?: boolean;
  /** A small drawing (in a message): labels only on the arrows with a problem. */
  compact?: boolean;
}

/**
 * The map, drawn in the app's own style: each layer a band with its name, each box a button that opens its part's page
 * (its colour how far it's built, a ⚠ when Claude found a problem with it), and each arrow marked where it crosses from
 * one layer into the next. An arrow that goes around a layer is drawn in amber; one Claude found a problem with, in red.
 * With a part on screen the boxes and arrows it isn't about are drawn faint (see focusOf).
 */
export function ArchGraphSvg({ layout, current, opens, onOpen, shown = null, onShow, picked = null, reveal = null, all = false, compact = false }: GraphProps) {
  const svg = useRef<SVGSVGElement>(null);
  const panTo = useReveal();
  /** The arrow under the pointer: its label is shown in full. */
  const [hot, setHot] = useState<string | null>(null);
  const rectOf = (n: PlacedNode) => ({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h });
  useEffect(() => {
    const n = reveal && layout.nodes.find((x) => x.id === reveal.id);
    if (n) panTo?.(rectOf(n));
  }, [reveal?.key]);
  // The page on screen changed: its box is brought into view, easing there (not at all when it already is in view).
  const litKey = current.join(",");
  useEffect(() => {
    const n = layout.nodes.find((x) => current.includes(x.id));
    if (n) panTo?.(rectOf(n));
  }, [litKey]);
  const focus = useMemo(() => focusOf(layout, current, picked, all), [layout, litKey, picked, all]);
  const lit = (id: string) => current.includes(id) || picked?.node === id;
  const onKey = (e: KeyboardEvent, n: PlacedNode) => {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const to = nearest(layout.nodes, n.id, dir);
      if (to) {
        // The focus moves (without the browser scrolling the clipped surface), and the map follows it.
        svg.current?.querySelector<SVGGElement>(`[data-node=${JSON.stringify(to)}]`)?.focus({ preventScroll: true });
        const target = layout.nodes.find((x) => x.id === to);
        if (target) panTo?.(rectOf(target));
      }
    } else if ((e.key === "Enter" || e.key === " ") && opens[n.id]) {
      e.preventDefault();
      onOpen?.(opens[n.id]);
    }
  };
  const nameOf = new Map(layout.nodes.map((n) => [n.id, n.label]));
  const kindOf = (e: ArchLayout["edges"][number]) => (e.issue ? " issue" : e.skips.length ? " skip" : "");
  const pills = layout.edges.filter((e) => e.pill && (!compact || kindOf(e)));
  const revealed = (e: ArchLayout["edges"][number]) => hot === e.key || shown === e.from || shown === e.to;
  return (
    <svg ref={svg} className={`arch-graph${focus.active ? " focused" : ""}`} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Architecture map">
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
        const on = current.includes(e.from) || current.includes(e.to) || picked?.edge === e.key || hot === e.key;
        const kind = kindOf(e);
        const why = [e.issue, e.skips.length ? `Goes around ${e.skips.join(" and ")}` : ""].filter(Boolean).join(". ");
        const d = e.path ?? routePath(e.points);
        return (
          <g key={e.key} data-edge={e.key} data-focus={focus.edges.get(e.key)} className={`arch-edge${on ? " lit" : ""}${kind}`} onMouseEnter={() => e.label && setHot(e.key)} onMouseLeave={() => setHot((h) => (h === e.key ? null : h))}>
            <title>{[`${nameOf.get(e.from)} → ${nameOf.get(e.to)}${e.label ? `: ${e.label}` : ""}`, why].filter(Boolean).join(". ")}</title>
            <path className="arch-edge-line" d={d} markerEnd="url(#arch-arrow)" />
            {/* A wider line nobody sees, so the arrow is easy to point at. */}
            <path className="arch-edge-hit" d={d} />
            {e.crossings.map((c, i) => (
              <circle key={i} cx={c.x} cy={c.y} r={3.2} className="arch-crossing" />
            ))}
            {/* A label that didn't fit anywhere: a dot where it would be, and the label shows when the arrow is looked at. */}
            {e.pill && !e.pill.placed && !compact && !revealed(e) && <circle cx={e.pill.x} cy={e.pill.y} r={3.5} className="arch-edge-dot" />}
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
            data-focus={focus.nodes.get(n.id)}
            className={`arch-box${n.change ? ` ${n.change}` : ""}${n.status ? ` st-${n.status}` : ""}${n.issue ? " has-issue" : ""}${lit(n.id) ? " covered" : ""}${page ? " opens" : ""}${shown === n.id ? " shown" : ""}`}
            transform={`translate(${n.x - n.w / 2}, ${n.y - n.h / 2})`}
            tabIndex={0}
            role="button"
            aria-disabled={page ? undefined : true}
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
      {/* The labels, over the boxes: each is where the placement found room, so none sits on a box or another label. One that
          was left off, or cut short, shows whole while its arrow (or either of its boxes) is looked at. */}
      <g className="arch-pills" aria-hidden="true">
        {[...pills].sort((a, b) => Number(revealed(a)) - Number(revealed(b))).map((e) => {
          const p = e.pill!;
          const open = revealed(e);
          if (!p.placed && !open) return null;
          const marked = e.issue || e.skips.length > 0 ? 2 : 0;
          const w = open ? pillWidth(e.label.length + marked) : p.w;
          return (
            <g key={e.key} data-pill={e.key} data-focus={open ? "full" : focus.edges.get(e.key)} className={`arch-edge-tag${open ? " open" : ""}${kindOf(e)}`}>
              <rect x={p.x - w / 2} y={p.y - p.h / 2} width={w} height={p.h} rx={p.h / 2} />
              <text x={p.x} y={p.y + 3.8} className="arch-edge-label">
                {marked ? "⚠ " : null}
                {open ? e.label : p.text}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * Shows everything at full strength for as long as it is held: a press (mouse, touch or pen) or Space or Enter on it, and
 * not a switch. It lets go the moment the press does, when the pointer leaves it, when the window loses focus or is
 * hidden, and when it goes away, so it can't stay on.
 */
export function ShowAll({ onHeld }: { onHeld: (held: boolean) => void }) {
  const [held, setHeld] = useState(false);
  const set = useCallback(
    (v: boolean) => {
      setHeld(v);
      onHeld(v);
    },
    [onHeld],
  );
  useEffect(() => {
    if (!held) return;
    const off = () => set(false);
    // A press that ends away from the button (it isn't captured, so as to leave when the pointer does) is still a release.
    window.addEventListener("pointerup", off);
    window.addEventListener("pointercancel", off);
    window.addEventListener("blur", off);
    document.addEventListener("visibilitychange", off);
    return () => {
      window.removeEventListener("pointerup", off);
      window.removeEventListener("pointercancel", off);
      window.removeEventListener("blur", off);
      document.removeEventListener("visibilitychange", off);
    };
  }, [held, set]);
  useEffect(() => () => onHeld(false), [onHeld]);
  const key = (e: KeyboardEvent) => e.key === " " || e.key === "Enter";
  return (
    <button
      className={`arch-show-all${held ? " held" : ""}`}
      aria-pressed={held}
      aria-label="Show everything while held"
      title="Hold to show everything"
      onPointerDown={(e) => !(e.button > 0) && set(true)}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onPointerLeave={() => set(false)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!key(e)) return;
        e.preventDefault();
        set(true);
      }}
      onKeyUp={(e) => key(e) && set(false)}
      onBlur={() => set(false)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="2" />
      </svg>
      Show all
    </button>
  );
}

/** What the box being looked at is, does, and which page covers it. */
function NodePanel({ node, page, layer, onOpen }: { node: PlacedNode; page: { key: string; name: string } | null; layer: string | null; onOpen: (key: string) => void }) {
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

/** Everything wrong on the map, under a chip that opens it: hovering one finds it on the map. */
function IssueList({ issues, picked, onPick }: { issues: MapIssue[]; picked: MapIssue | null; onPick: (i: MapIssue | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`arch-issues${open ? " open" : ""}`} aria-label="Issues">
      <button className="arch-issues-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="arch-issue-mark" aria-hidden>
          ⚠
        </span>
        <strong>{issues.length === 1 ? "1 issue" : `${issues.length} issues`}</strong>
        <span className="arch-panel-hint">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul onMouseLeave={() => onPick(null)}>
          {issues.map((i) => (
            <li key={i.key} className={`${i.found ? "found" : "marked"}${picked?.key === i.key ? " picked" : ""}`} onMouseEnter={() => onPick(i)}>
              <span className="arch-issue-mark" aria-hidden>
                ⚠
              </span>
              <span>
                {i.text}
                {i.found && <span className="arch-issue-by"> (found by Lantern from the layers)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface TabProps {
  map: ArchitectureMap;
  /** A box to light and bring into view (a part's "On the map" chip), each time `box.key` changes. */
  box?: { id: string; key: number } | null;
  current: string[];
  /** Each page's name ("Part 2 of 3 — Retry policy"), for the panel's link. */
  pageNames: Record<string, string>;
  onOpenPage: (pageKey: string) => void;
  /** Drawn in the larger view: no button for it. */
  large?: boolean;
  /** Ask Claude to bring the map up to date, from any flavour (missing while it's busy). */
  onUpdate?: () => void;
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

/** The map larger: a dialog over the app, the same map in it (from the tab's Expand button). */
function MapLightbox({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  return (
    <dialog ref={ref} className="arch-big arch-map-big" aria-label="Architecture map, larger" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="arch-big-head">
        <span className="arch-tab-title">Architecture map</span>
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div className="arch-map-big-body">{children}</div>
    </dialog>
  );
}

/** The right pane's Architecture tab: the latest Overview's map, filling the pane, on a surface you can move around. */
export function ArchitectureTab({ map, box, current, pageNames, onOpenPage, large = false, onUpdate }: TabProps) {
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  // A map with layers has one way to be laid out (its bands, top to bottom), with as many boxes to a row as shows it
  // biggest in the room; one without is laid out both ways, and the one that shows bigger in the pane is drawn (a pane is
  // usually taller than it is wide).
  const layered = map.kind === "native" && map.spec.layers.length > 0;
  const made = useRef<{ spec: unknown; rows: Map<number, ArchLayout> }>({ spec: null, rows: new Map() });
  const fitted = useMemo(() => {
    if (map.kind !== "native" || !layered) return null;
    if (made.current.spec !== map.spec) made.current = { spec: map.spec, rows: new Map() };
    const rows = made.current.rows;
    return bestRows(
      (r) => {
        if (!rows.has(r)) rows.set(r, layoutArchitecture(map.spec, "LR", r));
        return rows.get(r)!;
      },
      room,
      MIN_FIT,
    );
  }, [map, layered, room.w, room.h]);
  const rowMax = fitted?.rowMax ?? 0;
  const both = useMemo(() => {
    if (map.kind !== "native") return null;
    if (fitted) return { LR: fitted.layout, TB: fitted.layout };
    return { LR: layoutArchitecture(map.spec, "LR"), TB: layoutArchitecture(map.spec, "TB") };
  }, [map, fitted]);
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
  const [all, setAll] = useState(false);
  const [big, setBig] = useState(false);
  // A chip on a page named a box: it is the one looked at now.
  useEffect(() => {
    if (box) setShown(box.id);
  }, [box?.key]);
  const node = layout?.nodes.find((n) => n.id === shown) ?? null;
  const page = node && map.nodes[node.id] ? { key: map.nodes[node.id], name: pageNames[map.nodes[node.id]] ?? "Its page" } : null;
  const layer = node?.layer && map.kind === "native" ? (map.spec.layers.find((l) => l.id === node.layer)?.label ?? null) : null;
  return (
    <div className={`arch-tab${large ? " large" : ""}`}>
      <div className="arch-tab-head">
        <span className="arch-tab-title" title={map.title}>
          {map.title || "Architecture"}
        </span>
        {!large && (
          <button className="arch-update" disabled={!onUpdate} title={onUpdate ? "Ask Claude to bring the map up to date with the work so far, then carry on" : "Wait for Claude to finish"} onClick={onUpdate}>
            Update map
          </button>
        )}
        {layout && !large && (
          <button className="arch-expand" aria-label="Open the map larger" title="Open the map larger" onClick={() => setBig(true)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.5 2h4.5v4.5M6.5 14H2V9.5M14 2L9 7M2 14l5-5" />
            </svg>
          </button>
        )}
      </div>
      {layout ? (
        <div ref={body} className="arch-tab-body">
          <PanZoom
            width={layout.width}
            height={layout.height}
            label="Architecture map"
            fitKey={direction + rowMax + map.page + JSON.stringify(map.kind === "native" ? map.spec : "")}
            minFit={MIN_FIT}
            pad={8}
            inset={OVERLAY_INSET}
            tools={<ShowAll onHeld={setAll} />}
            overlay={
              <>
                <div className="arch-overlay arch-overlay-top">
                  <Legend layout={layout} />
                </div>
                <div className="arch-overlay arch-overlay-bottom">
                  {node && <NodePanel node={node} page={page} layer={layer} onOpen={onOpenPage} />}
                  {issues.length > 0 && <IssueList issues={issues} picked={picked} onPick={setPicked} />}
                </div>
              </>
            }
          >
            <ArchGraphSvg layout={layout} current={current} opens={map.nodes} onOpen={onOpenPage} shown={shown} onShow={setShown} picked={picked} reveal={box} all={all} />
          </PanZoom>
        </div>
      ) : map.kind === "mermaid" ? (
        <MermaidMap map={map} current={current} onOpenPage={onOpenPage} />
      ) : (
        <div className="arch-broken">
          <p>The Overview's map couldn't be read: {map.kind === "broken" ? map.error : ""} Ask Claude to write the Overview again.</p>
          <pre className="permission-detail">{map.kind === "broken" ? map.text : ""}</pre>
        </div>
      )}
      {big && (
        <MapLightbox onClose={() => setBig(false)}>
          <ArchitectureTab
            map={map}
            box={box}
            current={current}
            pageNames={pageNames}
            onOpenPage={(key) => {
              setBig(false);
              onOpenPage(key);
            }}
            large
          />
        </MapLightbox>
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
  const pane = useArchitecturePane();
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
        {pane && (
          <button className="code-block-copy arch-block-open" onClick={() => pane.open()}>
            Open in the pane
          </button>
        )}
      </div>
      {/* A click on the picture is the mouse's way to the same button; the keyboard has the button. */}
      <div className="arch-block-body" onClick={pane ? () => pane.open() : undefined}>
        <ArchGraphSvg layout={layout} current={[]} opens={{}} compact />
      </div>
    </div>
  );
}
