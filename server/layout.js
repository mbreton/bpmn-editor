// Réorganisation automatique (bpmn-auto-layout, version 2 épinglée) + deux retouches :
// les libellés d'événements/passerelles restés loin de leur élément sont replacés dessous, et les
// associations (ex. compensation) que la bibliothèque ne dessine pas sont recréées.
import { layoutProcess } from 'bpmn-auto-layout';
import { BpmnModdle } from 'bpmn-moddle';

const moddle = new BpmnModdle();
// propriétés de disposition recalculées par la bibliothèque : on ne recopie pas celles d'origine
const KEEP_LAYOUT = new Set(['id', 'bounds', 'bpmnElement', 'label', 'waypoint', 'isExpanded', 'isHorizontal', 'isMarkerVisible', 'sourceElement', 'targetElement', 'messageVisibleKind']);
const overlaps = (a, b, m = 15) => a.x < b.x + b.width + m && b.x < a.x + a.width + m && a.y < b.y + b.height + m && b.y < a.y + a.height + m;
const inside = (a, c) => a.x >= c.x + 10 && a.y >= c.y + 25 && a.x + a.width <= c.x + c.width - 10 && a.y + a.height <= c.y + c.height - 10;

export async function relayout(xml) {
  const t0 = performance.now();
  const { rootElement: before } = await moddle.fromXML(xml, 'bpmn:Definitions');
  const hadDi = new Set();
  const styles = new Map(); // couleurs (bioc:*, color:*) et autres attributs d'extension, par élément
  for (const d of before.diagrams || []) for (const pe of d.plane?.planeElement || []) {
    if (!pe.bpmnElement) continue;
    hadDi.add(pe.bpmnElement.id);
    // bpmn-moddle connaît bioc:* et color:* (propriétés fill, stroke, background-color…) ; le reste est dans $attrs
    const ext = [
      ...Object.keys(pe).filter(k => !k.startsWith('$') && !KEEP_LAYOUT.has(k)).map(k => ['prop', k, pe.get(k)]),
      ...Object.entries(pe.$attrs || {}).filter(([k]) => !k.startsWith('xmlns')).map(([k, v]) => ['attr', k, v])
    ];
    if (ext.length) styles.set(pe.bpmnElement.id, ext);
  }

  const out = await layoutProcess(xml);
  const { rootElement: defs, elementsById } = await moddle.fromXML(out.xml, 'bpmn:Definitions');
  const planes = (defs.diagrams || []).map(d => d.plane).filter(Boolean);
  const shapes = new Map();
  for (const p of planes) for (const pe of p.planeElement || []) if (pe.bpmnElement && pe.bounds) shapes.set(pe.bpmnElement.id, { pe, plane: p });

  // 1. libellés égarés
  let labelsFixed = 0;
  for (const { pe } of shapes.values()) {
    const lb = pe.label?.bounds, b = pe.bounds;
    const t = pe.bpmnElement.$type;
    if (!lb || !/Event$|Gateway$/.test(t)) continue;
    // écart entre le libellé et l'élément ; libellé sorti du conteneur de l'élément (ex. sous-processus événementiel)
    const gap = Math.max(0, lb.x - (b.x + b.width), b.x - (lb.x + lb.width)) + Math.max(0, lb.y - (b.y + b.height), b.y - (lb.y + lb.height));
    const parent = shapes.get(pe.bpmnElement.$parent?.id)?.pe.bounds;
    const center = { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 };
    const escaped = parent && (center.x < parent.x || center.x > parent.x + parent.width || center.y < parent.y || center.y > parent.y + parent.height);
    if (gap > 40 || escaped) {
      lb.x = Math.round(b.x + b.width / 2 - lb.width / 2);
      lb.y = Math.round(b.y + b.height + 5);
      labelsFixed++;
    }
  }

  // 2. activités de compensation (sans flux, posées n'importe où par la bibliothèque) : près de leur événement
  let moved = 0;
  for (const el of Object.values(elementsById)) {
    if (!el.$instanceOf?.('bpmn:Association')) continue;
    const src = el.sourceRef, tgt = el.targetRef;
    if (!src?.$instanceOf?.('bpmn:BoundaryEvent') || !tgt?.isForCompensation) continue;
    const s = shapes.get(src.id), t = shapes.get(tgt.id);
    if (!s || !t) continue;
    const a = s.pe.bounds, b = t.pe.bounds;
    if (Math.abs((b.x + b.width / 2) - (a.x + a.width / 2)) < 160 && b.y > a.y && b.y - a.y < 200) continue; // déjà bien placée
    const parent = tgt.$parent;
    const siblings = [...shapes.values()].filter(x => x.pe !== t.pe && x.pe.bpmnElement.$parent === parent && !x.pe.bpmnElement.$instanceOf('bpmn:SequenceFlow')).map(x => x.pe.bounds);
    const container = shapes.get(parent?.id)?.pe.bounds;
    // candidats : sous l'événement (trait droit), ou décalés à droite / à gauche avec un trait en baïonnette
    // qui passe juste sous l'activité porteuse ; on garde le premier sans chevauchement ni traversée.
    const fx = a.x + a.width / 2, fy = a.y + a.height, jogY = fy + 14;
    const free = r => !siblings.some(o => overlaps(r, o, 0));
    const vLine = (x, y1, y2) => ({ x: x - 3, y: Math.min(y1, y2), width: 6, height: Math.abs(y2 - y1) });
    const hLine = (y, x1, x2) => ({ x: Math.min(x1, x2), y: y - 3, width: Math.abs(x2 - x1) || 1, height: 6 });
    let placed = null, route = null;
    for (let dy = 40; dy <= 400 && !placed; dy += 20) {
      const y = Math.round(fy + dy);
      for (const x of [fx - b.width / 2, a.x + a.width + 30, a.x - b.width - 30, a.x + a.width + 30 + b.width + 30]) {
        const cand = { x: Math.round(x), y, width: b.width, height: b.height };
        if (siblings.some(o => overlaps(cand, o, 20)) || (container && !inside(cand, container))) continue;
        const cx = cand.x + cand.width / 2;
        const straight = Math.abs(cx - fx) < 1;
        const pts = straight ? [{ x: fx, y: fy }, { x: fx, y: cand.y }] : [{ x: fx, y: fy }, { x: fx, y: jogY }, { x: cx, y: jogY }, { x: cx, y: cand.y }];
        const rects = straight ? [vLine(fx, fy + 2, cand.y)] : [vLine(fx, fy + 2, jogY), hLine(jogY, fx, cx), vLine(cx, jogY, cand.y)];
        if (!rects.every(free)) continue;
        placed = cand; route = pts; break;
      }
    }
    if (placed) {
      const ddx = placed.x - b.x, ddy = placed.y - b.y;
      b.x = placed.x; b.y = placed.y;
      if (t.pe.label?.bounds) { t.pe.label.bounds.x += ddx; t.pe.label.bounds.y += ddy; }
      // l'ancien dessin de l'association (s'il existe) est recalculé plus bas
      for (const p of planes) p.set('planeElement', p.planeElement.filter(pe => pe.bpmnElement !== el));
      s.plane.get('planeElement').push(moddle.create('bpmndi:BPMNEdge', { id: `${el.id}_di`, bpmnElement: el, waypoint: route.map(q => moddle.create('dc:Point', { x: Math.round(q.x), y: Math.round(q.y) })) }));
      moved++;
    }
  }

  // 3. associations sans dessin
  const drawn = new Set([...planes.flatMap(p => (p.planeElement || []).map(pe => pe.bpmnElement?.id))]);
  let edgesAdded = 0;
  for (const el of Object.values(elementsById)) {
    if (!el.$instanceOf?.('bpmn:Association') || drawn.has(el.id) || !hadDi.has(el.id)) continue;
    const s = shapes.get(el.sourceRef?.id), t = shapes.get(el.targetRef?.id);
    if (!s || !t) continue;
    const a = s.pe.bounds, b = t.pe.bounds;
    const from = { x: a.x + a.width / 2, y: a.y + a.height };
    const belowIt = from.x >= b.x && from.x <= b.x + b.width;
    const to = belowIt ? { x: from.x, y: b.y } : b.x > from.x ? { x: b.x, y: b.y + b.height / 2 } : { x: b.x + b.width, y: b.y + b.height / 2 };
    const waypoint = (belowIt ? [from, to] : [from, { x: from.x, y: to.y }, to]).map(p => moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }));
    const edge = moddle.create('bpmndi:BPMNEdge', { id: `${el.id}_di`, bpmnElement: el, waypoint });
    s.plane.get('planeElement').push(edge);
    edgesAdded++;
  }

  // 4. styles d'origine : la bibliothèque recrée la disposition sans les couleurs
  let styled = 0;
  for (const p of planes) for (const pe of p.planeElement || []) {
    const ext = styles.get(pe.bpmnElement?.id);
    if (!ext) continue;
    for (const [kind, k, v] of ext) { if (kind === 'prop') pe.set(k, v); else pe.$attrs[k] = v; }
    styled++;
  }
  for (const [k, v] of Object.entries(before.$attrs || {})) if (k.startsWith('xmlns:') && !(k in defs.$attrs)) defs.$attrs[k] = v;

  const { xml: result } = await moddle.toXML(defs, { format: true });
  const warnings = (out.warnings || []).filter(w => !(w.code === 'DI_NOT_CREATED' && drawn.has(w.elementId)) && !(edgesAdded && w.code === 'DI_NOT_CREATED' && elementsById[w.elementId]?.$instanceOf?.('bpmn:Association')));
  return { xml: result, warnings: warnings.map(w => `${w.code}${w.elementId ? ` (${w.elementId})` : ''}`), labelsFixed, edgesAdded, moved, styled, ms: Math.round(performance.now() - t0) };
}
