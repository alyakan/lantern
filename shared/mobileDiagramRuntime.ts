/** Trusted viewer code only: diagram text is escaped markup, never JavaScript. Runs in the map's isolated WebView. */
export const diagramRuntime = String.raw`
(() => {
  const surface = document.getElementById('surface');
  const svg = document.querySelector('svg');
  const world = document.getElementById('world');
  const clear = document.getElementById('clear');
  const detail = document.getElementById('detail');
  const nodes = [...document.querySelectorAll('[data-node]')];
  const edges = [...document.querySelectorAll('[data-edge]')];
  const labels = [...document.querySelectorAll('[data-label]')];
  let selected = JSON.parse(document.getElementById('selection').textContent);
  let scale = 1, x = 0, y = 0, moved = false;
  let size = { width: 0, height: 0 };
  const pointers = new Map();
  let gesture = null;
  const W = Number(svg.dataset.width), H = Number(svg.dataset.height);
  const min = () => Math.min(0.25, (size.width - 24) / W, (size.height - 24) / H);
  const clamp = s => Math.max(Math.max(0.01, min()), Math.min(4, s));
  const draw = () => world.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + scale + ')');
  const fit = () => {
    scale = clamp(Math.min((size.width - 24) / W, (size.height - 24) / H, 1));
    x = (size.width - W * scale) / 2; y = (size.height - H * scale) / 2;
    draw();
  };
  const zoom = (next, at = { x: size.width / 2, y: size.height / 2 }) => {
    next = clamp(next);
    x = at.x - (at.x - x) * next / scale;
    y = at.y - (at.y - y) * next / scale;
    scale = next; draw();
  };
  const post = () => window.ReactNativeWebView?.postMessage(JSON.stringify({ selection: selected }));
  const highlight = () => {
    const related = selected ? edges.filter(e => selected.kind === 'edge' ? e.dataset.edge === selected.id : e.dataset.from === selected.id || e.dataset.to === selected.id) : edges;
    const lit = new Set(related.flatMap(e => [e.dataset.from, e.dataset.to]));
    if (selected?.kind === 'node') lit.add(selected.id);
    nodes.forEach(n => {
      n.style.opacity = !selected || lit.has(n.dataset.node) ? '1' : '.25';
      n.setAttribute('aria-pressed', String(selected?.kind === 'node' && selected.id === n.dataset.node));
      n.classList.toggle('selected', selected?.kind === 'node' && selected.id === n.dataset.node);
    });
    edges.forEach(e => {
      e.style.opacity = related.includes(e) ? '1' : '.22';
      e.setAttribute('aria-pressed', String(selected?.kind === 'edge' && selected.id === e.dataset.edge));
      e.classList.toggle('selected', !!selected && related.includes(e));
    });
    labels.forEach(l => l.style.opacity = !selected || related.some(e => e.dataset.edge === l.dataset.label) ? '1' : '.22');
    clear.hidden = !selected;
    const target = selected && (selected.kind === 'node' ? nodes : edges).find(n => (n.dataset.node || n.dataset.edge) === selected.id);
    detail.textContent = target?.dataset.detail || '';
    detail.hidden = !target;
  };
  const choose = target => {
    const n = target.closest('[data-node], [data-edge], [data-label]');
    if (!n) return;
    const next = n.dataset.node ? { kind: 'node', id: n.dataset.node } : { kind: 'edge', id: n.dataset.edge || n.dataset.label };
    selected = selected?.kind === next.kind && selected.id === next.id ? null : next;
    highlight(); post();
  };
  clear.onclick = () => { selected = null; highlight(); post(); };
  document.getElementById('fit').onclick = fit;
  document.getElementById('plus').onclick = () => zoom(scale * 1.4);
  document.getElementById('minus').onclick = () => zoom(scale / 1.4);
  const point = e => { const r = surface.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const begin = () => {
    const p = [...pointers.values()];
    gesture = p.length === 1 ? { start: p[0], x, y } : p.length > 1 ? {
      mid: { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 },
      distance: Math.max(1, Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)), scale, x, y
    } : null;
  };
  surface.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    if (!pointers.size) moved = false;
    pointers.set(e.pointerId, point(e));
    if (pointers.size > 1) moved = true;
    surface.setPointerCapture?.(e.pointerId); begin();
  });
  surface.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, point(e));
    const p = [...pointers.values()];
    if (p.length === 1 && gesture.start) {
      const dx = p[0].x - gesture.start.x, dy = p[0].y - gesture.start.y;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true; x = gesture.x + dx; y = gesture.y + dy;
    } else if (p.length > 1 && gesture.mid) {
      scale = clamp(gesture.scale * Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / gesture.distance);
      x = (p[0].x + p[1].x) / 2 - (gesture.mid.x - gesture.x) * scale / gesture.scale;
      y = (p[0].y + p[1].y) / 2 - (gesture.mid.y - gesture.y) * scale / gesture.scale;
    }
    draw();
  });
  const end = e => {
    if (!pointers.has(e.pointerId)) return;
    if (!moved && e.type === 'pointerup') {
      // Pointer capture targets the surface: hit-test where the finger actually ended.
      choose(document.elementFromPoint?.(e.clientX, e.clientY) || e.target);
    }
    pointers.delete(e.pointerId); begin();
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', e => { moved = true; end(e); });
  surface.addEventListener('lostpointercapture', e => { moved = true; pointers.delete(e.pointerId); begin(); });
  surface.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(e.target); }
  });
  // VoiceOver/keyboard activation may be a click without any pointer events.
  surface.addEventListener('click', e => { if (e.detail === 0) choose(e.target); });
  surface.addEventListener('wheel', e => { e.preventDefault(); zoom(scale * Math.exp(-e.deltaY * .002), point(e)); }, { passive: false });
  window.addEventListener('blur', () => { pointers.clear(); gesture = null; moved = true; });
  const resize = () => {
    const before = size;
    size = { width: surface.clientWidth, height: surface.clientHeight };
    svg.setAttribute('viewBox', '0 0 ' + size.width + ' ' + size.height);
    // Rotation keeps the zoom and the point at the centre; Fit is an explicit action.
    if (!before.width) fit();
    else { x += (size.width - before.width) / 2; y += (size.height - before.height) / 2; draw(); }
  };
  new ResizeObserver(resize).observe(surface);
  highlight(); resize();
})();
`;
