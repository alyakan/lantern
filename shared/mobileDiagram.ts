import { routePath, type ArchLayout } from "./archGraph";
import { diagramRuntime } from "./mobileDiagramRuntime";

export type DiagramSelection = { kind: "node" | "edge"; id: string } | null;

/** Just the colour tokens the pure document renderer needs; no native UI imports. */
interface DiagramColors {
  paper: string; card: string; wash: string; ink: string; ink2: string; rule: string;
  stop: string; working: string; cobalt: string; go: string; white: string;
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const caption = { done: "Done", "in-progress": "In progress", planned: "Planned" };

/** Only known ids cross back from the isolated viewer. No navigation or other native actions are accepted. */
export function selectionMessage(text: string, layout: ArchLayout): DiagramSelection | undefined {
  try {
    const value = JSON.parse(text)?.selection;
    if (value === null) return null;
    if (value?.kind === "node" && layout.nodes.some(n => n.id === value.id)) return { kind: "node", id: value.id };
    if (value?.kind === "edge" && layout.edges.some(e => e.key === value.id)) return { kind: "edge", id: value.id };
  } catch { /* An invalid message has no effect. */ }
  return undefined;
}

/** Geometry shared with desktop; only the SVG skin and touch controls belong to the phone. No remote resources. */
export function diagramSvg(layout: ArchLayout, colors: DiagramColors, interactive = false): string {
  const names = new Map(layout.nodes.map(n => [n.id, n.label]));
  const bands = layout.bands.map((b, i) => `<g><rect x="0" y="${b.y}" width="${layout.width}" height="${b.h}" fill="${i % 2 ? colors.wash : colors.paper}"/><text x="16" y="${b.y + b.h / 2 + 4}" fill="${colors.ink2}">${escape(b.label)}</text></g>`).join("");
  const edges = layout.edges.map(e => {
    const name = `${names.get(e.from)} → ${names.get(e.to)}${e.label ? `: ${e.label}` : ""}`;
    const detail = [name, e.issue, e.skips.length ? `Goes around ${e.skips.join(", ")}` : ""].filter(Boolean).join(" · ");
    const d = escape(e.path ?? routePath(e.points));
    const color = e.issue ? colors.stop : e.skips.length ? colors.working : colors.ink2;
    return `<g fill="none" class="edge" data-edge="${escape(e.key)}" data-from="${escape(e.from)}" data-to="${escape(e.to)}" data-detail="${escape(detail)}" ${interactive ? `tabindex="0" role="button" aria-label="${escape(name)}" aria-pressed="false"` : ""} ${interactive ? `style="--edge:${color}"` : ""}>
      <title>${escape(detail)}</title><path d="${d}" stroke="${colors.paper}" stroke-width="6" fill="none"/>
      <path class="line" d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow-${e.issue ? "issue" : e.skips.length ? "skip" : "normal"})"/>
      ${interactive ? `<path class="hit" d="${d}"/>` : ""}
      ${e.crossings.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.2" fill="${color}"/>`).join("")}</g>`;
  }).join("");
  const nodes = layout.nodes.map(n => {
    const stroke = n.issue ? colors.stop : n.status === "done" ? colors.go : n.status === "in-progress" ? colors.working : colors.rule;
    const y = n.h / 2 - (n.lines.length - 1) * 8 - (n.status ? 7 : 0) + 4.5;
    const detail = [n.label, n.status ? caption[n.status] : "", n.note, n.issue].filter(Boolean).join(" · ");
    return `<g class="node" data-node="${escape(n.id)}" data-detail="${escape(detail)}" transform="translate(${n.x - n.w / 2} ${n.y - n.h / 2})" ${interactive ? `tabindex="0" role="button" aria-label="${escape(detail)}" aria-pressed="false"` : ""}>
      <title>${escape(detail)}</title><rect class="box" width="${n.w}" height="${n.h}" rx="10" fill="${colors.card}" stroke="${stroke}" stroke-width="2"/>
      ${n.change ? `<rect x="6" y="8" width="4" height="${n.h - 16}" rx="2" fill="${n.change === "new" ? colors.go : n.change === "removed" ? colors.stop : colors.working}"/>` : ""}
      <text x="${n.w / 2}" y="${y}" text-anchor="middle" fill="${colors.ink}">${n.lines.map((line, i) => `<tspan x="${n.w / 2}" dy="${i ? 16 : 0}">${escape(line)}</tspan>`).join("")}</text>
      ${n.status ? `<text font-size="11" class="caption" x="${n.w / 2}" y="${n.h - 10}" text-anchor="middle" fill="${colors.ink2}">${caption[n.status]}</text>` : ""}
      ${n.issue ? `<circle cx="${n.w - 4}" cy="4" r="9" fill="${colors.stop}"/><text x="${n.w - 4}" y="8" fill="${colors.white}" text-anchor="middle">!</text>` : ""}</g>`;
  }).join("");
  const labels = layout.edges.filter(e => e.pill?.placed).map(e => {
    const p = e.pill!;
    return `<g data-label="${e.key}" class="label"><rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="8" fill="${colors.card}" stroke="${colors.rule}"/><text font-size="11" x="${p.x}" y="${p.y + 4}" text-anchor="middle" fill="${colors.ink2}">${escape(p.text)}</text></g>`;
  }).join("");
  // Heads mark only path ends. Native SVG supports "auto", but not "auto-start-reverse".
  return `<svg font-size="13" font-family="system-ui" xmlns="http://www.w3.org/2000/svg" data-width="${layout.width}" data-height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="Architecture map">
    <defs>${[["normal", colors.ink2], ["skip", colors.working], ["issue", colors.stop]].map(([id, color]) => `<marker id="arrow-${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M1 1 L9 5 L1 9 z" fill="${color}"/></marker>`).join("")}</defs>
    <g id="world">${bands}${edges}${nodes}${labels}</g></svg>`;
}

/** The expanded viewer: local SVG, trusted touch controls and no remote resources. */
export function diagramDocument(layout: ArchLayout, colors: DiagramColors, interactive = false, selection: DiagramSelection = null): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-lantern-map'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${colors.paper};color:${colors.ink};font:14px -apple-system,system-ui,sans-serif}
    body{display:flex;flex-direction:column}#surface{flex:1;min-height:0;overflow:hidden;-webkit-user-select:none;user-select:none;${interactive ? "touch-action:none;" : ""}}svg{width:100%;height:100%;display:block}text{font-size:13px}.caption,.label text{font-size:11px}
    .edge{fill:none}.line{stroke:var(--edge);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.hit{stroke:transparent;stroke-width:24;vector-effect:non-scaling-stroke;pointer-events:stroke}.selected .line{stroke-width:3}
    .node,.edge,.label{cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent}.node.selected .box,.node:focus-visible .box{stroke:${colors.cobalt};stroke-width:3}.edge:focus-visible .line{stroke-width:4}.label{pointer-events:all}
    #tools{display:flex;gap:4px;align-items:center;padding:4px 8px;border-bottom:1px solid ${colors.rule};flex-shrink:0}button{min-width:44px;min-height:44px;border:0;border-radius:12px;background:${colors.card};color:${colors.ink};font:600 15px -apple-system,system-ui;display:inline-flex;align-items:center;justify-content:center;padding:0 12px}#plus,#minus{font-size:22px}#clear{margin-left:auto;font-size:13px}[hidden]{display:none!important}#detail{flex-shrink:0;max-height:25%;overflow:auto;border-top:1px solid ${colors.rule};padding:8px 12px;line-height:1.4;overflow-wrap:anywhere}
    </style></head><body>
    ${interactive ? '<nav id="tools" aria-label="Map controls"><button id="minus" aria-label="Zoom out">−</button><button id="plus" aria-label="Zoom in">+</button><button id="fit">Fit</button><button id="clear" hidden>Clear selection</button></nav>' : ""}
    <main id="surface">${diagramSvg(layout, colors, interactive)}</main>
    ${interactive ? `<div id="detail" aria-live="polite" hidden></div><script id="selection" type="application/json">${JSON.stringify(selection).replace(/</g, "\\u003c")}</script><script nonce="lantern-map">${diagramRuntime}</script>` : ""}
    </body></html>`;
}
