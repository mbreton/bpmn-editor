// Cadrage de la vue sur un ensemble d'éléments, avec surbrillance facultative.

/** Boîte englobante d'éléments (formes et flux). */
function bbox(els) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const e of els) {
    const pts = e.waypoints || [{ x: e.x, y: e.y }, { x: e.x + e.width, y: e.y + e.height }];
    for (const p of pts) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
  }
  return { x1, y1, x2, y2 };
}

export function createFocus(modeler) {
  const canvas = modeler.get('canvas');
  const registry = modeler.get('elementRegistry');
  let highlighted = [];
  let anim = null;
  let fade = null;
  // le surlignage violet s'efface tout seul après quelques secondes, ou dès que l'utilisateur agit sur le diagramme
  const eventBus = modeler.get('eventBus');
  eventBus.on('element.mousedown', () => { if (highlighted.length) clear(); });

  const resolve = ids => ids.map(id => registry.get(id)).filter(e => e && e.type !== 'label');

  function clear() {
    clearTimeout(fade);
    for (const id of highlighted) { try { canvas.removeMarker(id, 'ai-focus'); } catch { /* supprimé */ } }
    highlighted = [];
  }

  /** Zoome (avec une courte animation) sur les éléments ; renvoie false si aucun n'existe. */
  function show(ids, { highlight = false, maxZoom = 1.4, pad = 140, animate = true } = {}) {
    const els = resolve(ids);
    if (!els.length) return false;
    if (highlight) {
      clear();
      for (const e of els) { canvas.addMarker(e.id, 'ai-focus'); highlighted.push(e.id); }
      fade = setTimeout(clear, 6000);
    }
    const { x1, y1, x2, y2 } = bbox(els);
    const box = { x: x1 - pad, y: y1 - pad, width: x2 - x1 + 2 * pad, height: y2 - y1 + 2 * pad };
    const { outer } = canvas.viewbox();
    const scale = Math.min(maxZoom, outer.width / box.width, outer.height / box.height);
    const target = { width: outer.width / scale, height: outer.height / scale };
    target.x = box.x + box.width / 2 - target.width / 2;
    target.y = box.y + box.height / 2 - target.height / 2;
    cancelAnimationFrame(anim);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) { canvas.viewbox(target); return true; }
    const from = canvas.viewbox();
    const t0 = performance.now(), dur = 450;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      canvas.viewbox({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, width: from.width + (target.width - from.width) * e, height: from.height + (target.height - from.height) * e });
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
    return true;
  }

  /** Éléments actuellement visibles à l'écran (pour décrire à Claude ce qui est à l'écran). */
  function visible() {
    const vb = canvas.viewbox();
    return registry.filter(e => e.type !== 'label' && !e.waypoints && e.parent && e.businessObject?.$type !== 'bpmn:Process'
      && e.x + e.width > vb.x && e.x < vb.x + vb.width && e.y + e.height > vb.y && e.y < vb.y + vb.height)
      .slice(0, 40).map(e => ({ id: e.id, name: e.businessObject.name || '' }));
  }

  return { show, clear, visible };
}
