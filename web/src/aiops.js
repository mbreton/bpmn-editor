// Applique les opérations demandées par Claude (connecteur MCP) avec les services bpmn-js : chaque opération est une
// commande annulable, et la mise en page des nouveaux éléments est calculée par l'éditeur
// (placement automatique, insertion sur un flux), pas par Claude.
import { is, getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';
import { createFocus } from './focus.js';
import { labelOverflow, overflowText, overflowFix, lineCount } from '../../shared/labelfit.js';
import { COLOR_PRESETS } from './colors.js';

const EVENT_DEFS = {
  timer: 'bpmn:TimerEventDefinition', message: 'bpmn:MessageEventDefinition', error: 'bpmn:ErrorEventDefinition',
  signal: 'bpmn:SignalEventDefinition', escalation: 'bpmn:EscalationEventDefinition', compensate: 'bpmn:CompensateEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition', terminate: 'bpmn:TerminateEventDefinition', link: 'bpmn:LinkEventDefinition'
};
const REF_DEFS = {
  set_error: ['bpmn:ErrorEventDefinition', 'errorRef', 'bpmn:Error', 'errorCode'],
  set_message: ['bpmn:MessageEventDefinition', 'messageRef', 'bpmn:Message'],
  set_signal: ['bpmn:SignalEventDefinition', 'signalRef', 'bpmn:Signal'],
  set_escalation: ['bpmn:EscalationEventDefinition', 'escalationRef', 'bpmn:Escalation', 'escalationCode']
};
const TIMER_KINDS = ['timeDuration', 'timeDate', 'timeCycle'];
const ID_RE = /^[A-Za-z_][\w.-]{0,80}$/;

export class OpError extends Error {}

export function createApplier(modeler) {
  const modeling = modeler.get('modeling');
  const registry = modeler.get('elementRegistry');
  const elementFactory = modeler.get('elementFactory');
  const bpmnFactory = modeler.get('bpmnFactory');
  const bpmnReplace = modeler.get('bpmnReplace');
  const autoPlace = modeler.get('autoPlace');
  const spaceTool = modeler.get('spaceTool');
  const commandStack = modeler.get('commandStack');
  const docking = modeler.get('connectionDocking');
  const canvas = modeler.get('canvas');
  const LAYOUTS = ['h:v', 'v:h', 'h:h', 'v:v'];
  /**
   * Forme de tracé imposée, calculée ici plutôt que par le « réparateur » de bpmn-js (qui conserve
   * les anciens points d'accroche et peut ne rien changer) : h = horizontal, v = vertical.
   */
  function routeShape(c, route) {
    if (!LAYOUTS.includes(route)) throw new OpError(`tracé « ${route} » inconnu (h:v, v:h, h:h ou v:v)`);
    const s = c.source, t = c.target;
    const sc = { x: s.x + s.width / 2, y: s.y + s.height / 2 }, tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    const via = route === 'h:v' ? [{ x: tc.x, y: sc.y }]
      : route === 'v:h' ? [{ x: sc.x, y: tc.y }]
      : route === 'h:h' ? [{ x: (sc.x + tc.x) / 2, y: sc.y }, { x: (sc.x + tc.x) / 2, y: tc.y }]
      : [{ x: sc.x, y: (sc.y + tc.y) / 2 }, { x: tc.x, y: (sc.y + tc.y) / 2 }];
    routeVia(c, via);
  }
  const sameWaypoints = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1 && Math.abs(p.y - b[i].y) < 1);

  // ---------- flux qui traversent des éléments ----------
  /** Éléments (hors extrémités, conteneurs englobants, notes) que traverse le tracé d'un flux. */
  function crossedBy(c) {
    if (!c.waypoints || c.waypoints.length < 2) return [];
    const ends = new Set([c.source, c.target, c.source?.host, c.target?.host, ...(c.source?.attachers || []), ...(c.target?.attachers || [])].filter(Boolean));
    const inside = (box, p) => p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
    const a = c.waypoints[0], b = c.waypoints[c.waypoints.length - 1];
    const hits = [];
    for (const e of registry.getAll()) {
      if (ends.has(e) || e.waypoints || e.type === 'label' || !e.parent || e.type === 'bpmn:Participant' && false) continue;
      if (is(e, 'bpmn:TextAnnotation') || is(e, 'bpmn:Group') || is(e, 'bpmn:Collaboration') || is(e, 'bpmn:Process')) continue;
      if (!Number.isFinite(e.width)) continue;
      if ((isContainerShape(e)) && inside(e, a) && inside(e, b)) continue; // conteneur du flux
      if (isContainerShape(e) && !is(e, 'bpmn:SubProcess')) continue;     // pool, couloir
      const box = inflate(boxOf(e), -3);
      for (let i = 1; i < c.waypoints.length; i++) if (segmentHits(c.waypoints[i - 1], c.waypoints[i], box)) { hits.push(e.id); break; }
    }
    return hits;
  }

  // ---------- coût d'un tracé : traverser un élément >> même côté de passerelle > chevaucher un flux > le croiser > virages > longueur ----------
  // Les tracés sont évalués sans être appliqués : pending remplace provisoirement le tracé d'autres flux.
  const pending = new Map();
  const wpOf = e => pending.get(e.id) || e.waypoints;
  const as = (c, pts) => ({ id: c.id, type: c.type, businessObject: c.businessObject, source: c.source, target: c.target, parent: c.parent, waypoints: pts });
  const segsOf = c => { const w = c.waypoints; return w.slice(1).map((q, i) => [w[i], q]); };
  const segsOfPts = w => w.slice(1).map((q, i) => [w[i], q]);
  const horiz = ([p, q]) => Math.abs(p.y - q.y) < 1, vert = ([p, q]) => Math.abs(p.x - q.x) < 1;
  /** Longueur commune de deux segments superposés (même ligne), 0 sinon. */
  function overlapLen(a, b) {
    if (horiz(a) && horiz(b) && Math.abs(a[0].y - b[0].y) < 4) {
      const lo = Math.max(Math.min(a[0].x, a[1].x), Math.min(b[0].x, b[1].x)), hi = Math.min(Math.max(a[0].x, a[1].x), Math.max(b[0].x, b[1].x));
      return Math.max(0, hi - lo);
    }
    if (vert(a) && vert(b) && Math.abs(a[0].x - b[0].x) < 4) {
      const lo = Math.max(Math.min(a[0].y, a[1].y), Math.min(b[0].y, b[1].y)), hi = Math.min(Math.max(a[0].y, a[1].y), Math.max(b[0].y, b[1].y));
      return Math.max(0, hi - lo);
    }
    return 0;
  }
  /** Deux segments quelconques qui se coupent franchement (hors de leurs extrémités). */
  function cutSeg(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
  }
  const crosses = (a, b) => cutSeg(a[0], a[1], b[0], b[1]);
  const otherFlows = c => registry.filter(e => e.waypoints && e.id !== c.id && !is(e, 'bpmn:Association') && e.waypoints.length > 1);
  /** Superpositions et croisements avec les autres flux, et les flux concernés (with). */
  function flowConflicts(c) {
    let overlap = 0, cross = 0;
    const withIds = new Set();
    const mine = segsOf(c);
    for (const o of otherFlows(c)) {
      const shared = [c.source, c.target].filter(x => x === o.source || x === o.target);
      // longueur totale superposée, moins une tolérance de convergence de 30 px vers un élément commun
      // (aucune pour un aller-retour entre les deux mêmes éléments)
      let total = 0, n = 0;
      const theirs = segsOfPts(wpOf(o));
      for (const a of mine) for (const b of theirs) {
        const len = overlapLen(a, b);
        if (len) total += len;
        else if (!shared.length && crosses(a, b)) n++;
      }
      const k = settled.has(o.id) ? 2 : 1;
      if (total - (shared.length === 1 ? 30 : 0) > 8) { overlap += k; withIds.add(o.id); }
      if (n) { cross += n * k; withIds.add(o.id); }
    }
    return { overlap, cross, with: withIds };
  }
  /** Autre sortie de la même passerelle qui part du même côté. */
  function sideClashWith(c) {
    if (!is(c.source, 'bpmn:Gateway')) return null;
    const side = exitSide(c, c.waypoints);
    return (c.source.outgoing || []).find(o => o.id !== c.id && wpOf(o)?.length && exitSide(o, wpOf(o)) === side) || null;
  }
  /** Vrais virages : changements de direction (les points alignés ou confondus ne comptent pas). */
  function bendCount(pts) {
    const dirs = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const d = Math.abs(dx) < 1 ? `v${Math.sign(dy)}` : Math.abs(dy) < 1 ? `h${Math.sign(dx)}` : `d${Math.sign(dx)}${Math.sign(dy)}`;
      if (dirs.at(-1) !== d) dirs.push(d);
    }
    return Math.max(0, dirs.length - 1);
  }
  /** Éléments dont le flux longe le bord (trait du flux posé sur le trait de la boîte) : illisible. */
  function bordersHugged(c) {
    const out = [];
    const segs = segsOf(c);
    for (const e of registry.getAll()) {
      if (!e.parent || e.waypoints || e.type === 'label' || !Number.isFinite(e.width) || is(e, 'bpmn:Participant') || is(e, 'bpmn:Lane')) continue;
      if (is(e, 'bpmn:BoundaryEvent') || is(e, 'bpmn:TextAnnotation') || is(e, 'bpmn:Group') || is(e, 'bpmn:Process') || is(e, 'bpmn:Collaboration')) continue;
      const edgesH = [e.y, e.y + e.height], edgesV = [e.x, e.x + e.width];
      const runs = segs.some(([p, q]) => {
        if (Math.abs(p.y - q.y) < 1) return edgesH.some(y => Math.abs(p.y - y) < 4) && Math.min(Math.max(p.x, q.x), e.x + e.width) - Math.max(Math.min(p.x, q.x), e.x) > 12;
        if (Math.abs(p.x - q.x) < 1) return edgesV.some(x => Math.abs(p.x - x) < 4) && Math.min(Math.max(p.y, q.y), e.y + e.height) - Math.max(Math.min(p.y, q.y), e.y) > 12;
        return false;
      });
      if (runs) out.push(e.id);
    }
    return out;
  }
  /** Un flux entre ou sort d'une passerelle par une de ses pointes (pas au milieu d'un côté du losange). */
  function offTips(c) {
    let n = 0;
    const w = c.waypoints;
    for (const [g, p] of [[c.source, w[0]], [c.target, w[w.length - 1]]]) {
      if (!is(g, 'bpmn:Gateway')) continue;
      const cx = g.x + g.width / 2, cy = g.y + g.height / 2;
      if (Math.abs(p.x - cx) > 2 && Math.abs(p.y - cy) > 2) n++;
    }
    return n;
  }
  const lengthOf = pts => segsOfPts(pts).reduce((n, [p, q]) => n + Math.abs(p.x - q.x) + Math.abs(p.y - q.y), 0);
  function routeInfo(c) {
    const { overlap, cross, with: withIds } = flowConflicts(c);
    const clash = sideClashWith(c);
    if (clash) withIds.add(clash.id);
    const hits = crossedBy(c).length;
    const hugs = bordersHugged(c).length, tips = offTips(c);
    const bends = bendCount(c.waypoints);
    const cost = hits * 1000 + hugs * 500 + (clash ? (settled.has(clash.id) ? 1200 : 600) : 0) + overlap * 300 + tips * 150 + cross * 80 + bends * 25 + lengthOf(c.waypoints) / 20;
    return { cost, clean: !hits && !hugs && !tips && !clash && !overlap && !cross, with: withIds, bends };
  }
  const routeCost = c => routeInfo(c).cost;

  /** Tracés candidats (points de passage) pour un flux. */
  function candidates(c) {
    const vias = [];
    const s = c.source, t = c.target;
    const sc = { x: s.x + s.width / 2, y: s.y + s.height / 2 }, tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    // tout droit, quand les deux éléments se font face (le plus direct)
    const yLo = Math.max(s.y, t.y) + 4, yHi = Math.min(s.y + s.height, t.y + t.height) - 4;
    if (yLo <= yHi) { const y = Math.min(Math.max(sc.y, yLo), yHi); const y2 = Math.min(Math.max(tc.y, yLo), yHi); for (const yy of new Set([y, y2])) vias.push([{ x: (sc.x + tc.x) / 2, y: yy }]); }
    const xLo = Math.max(s.x, t.x) + 4, xHi = Math.min(s.x + s.width, t.x + t.width) - 4;
    if (xLo <= xHi) { const x = Math.min(Math.max(sc.x, xLo), xHi); const x2 = Math.min(Math.max(tc.x, xLo), xHi); for (const xx of new Set([x, x2])) vias.push([{ x: xx, y: (sc.y + tc.y) / 2 }]); }
    const backward = t.x + t.width < s.x;
    if (backward) for (const side of ['below', 'above']) for (const extra of [0, 15, 30, 45, 60]) { const v = loopVia(c, side, extra); if (v) vias.push(v); }
    vias.push([{ x: tc.x, y: sc.y }], [{ x: sc.x, y: tc.y }], [{ x: (sc.x + tc.x) / 2, y: sc.y }, { x: (sc.x + tc.x) / 2, y: tc.y }], [{ x: sc.x, y: (sc.y + tc.y) / 2 }, { x: tc.x, y: (sc.y + tc.y) / 2 }]);
    for (const sd of ['right', 'bottom', 'top', 'left']) vias.push(viaFromSide(c, sd));
    // contournements décalés (couloirs libres au-dessus / au-dessous)
    const dir = Math.sign(tc.x - sc.x || 1);
    for (const dy of [-60, -40, 40, 60]) vias.push([{ x: sc.x + dir * (s.width / 2 + 20), y: sc.y }, { x: sc.x + dir * (s.width / 2 + 20), y: tc.y + dy }, { x: tc.x - dir * (t.width / 2 + 20), y: tc.y + dy }, { x: tc.x - dir * (t.width / 2 + 20), y: tc.y }]);
    const out = [], seen = new Set();
    for (const v of vias) {
      let pts; try { pts = computeVia(c, v); } catch { continue; }
      const k = pts.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ');
      if (!seen.has(k)) { seen.add(k); out.push(pts); }
    }
    return out;
  }
  const copyPts = w => w.map(p => ({ x: p.x, y: p.y }));
  /** Flux droits et sans conflit au début d'une retouche : on n'y touche pas, les autres les évitent. */
  let settled = new Set();
  const settle = () => { settled = new Set(registry.filter(e => is(e, 'bpmn:SequenceFlow') && e.waypoints).filter(c => { const i = routeInfo(c); return i.clean && i.bends === 0; }).map(c => c.id)); };
  const straight = c => bendCount(wpOf(c) || []) === 0;

  /**
   * Cherche le meilleur tracé pour un flux : ne traverse aucun élément, ne se superpose à aucun autre
   * flux, en croise le moins possible, avec le moins de virages. Un flux déjà droit et sans conflit
   * n'est pas touché ; un flux qui peut aller tout droit est redressé.
   */
  function improveRoute(c, { force = false } = {}) {
    if (!c.waypoints) return false;
    const keep = copyPts(c.waypoints);
    if (!force && settled.has(c.id)) return false;
    const cur = routeInfo(c);
    if (!force && cur.clean && cur.bends === 0) return false;
    let best = { cost: force ? Infinity : cur.cost, pts: keep };
    for (const pts of candidates(c)) {
      const cost = routeCost(as(c, pts));
      if (cost < best.cost - 3) best = { cost, pts };
    }
    if (best.pts === keep || sameWaypoints(best.pts, keep)) return false;
    modeling.updateWaypoints(c, best.pts);
    return true;
  }
  const untangle = c => improveRoute(c);

  /**
   * Quand un flux en croise un autre, se superpose à lui ou lui prend son côté de passerelle, la
   * meilleure solution est parfois de retracer l'AUTRE flux : on évalue les deux ensemble. Un flux
   * déjà droit n'est jamais déplacé pour ça.
   */
  function untanglePair(c) {
    if (!c.waypoints || settled.has(c.id)) return false;
    const info = routeInfo(c);
    // partenaires : ceux qui gênent le tracé actuel, ou un meilleur tracé (plus direct) de c
    const partners = new Set(info.with);
    const mine = candidates(c);
    for (const pts of mine) {
      if (bendCount(pts) >= info.bends && info.clean) continue;
      const ri = routeInfo(as(c, pts));
      if (!crossedBy(as(c, pts)).length) for (const id of ri.with) partners.add(id);
    }
    let changed = false;
    for (const id of [...partners].slice(0, 4)) {
      const o = registry.get(id);
      if (!o?.waypoints || o === c) continue;
      const cKeep = copyPts(c.waypoints), oKeep = copyPts(o.waypoints);
      const total = (pc, po) => {
        pending.set(o.id, po); const a = routeCost(as(c, pc)); pending.delete(o.id);
        pending.set(c.id, pc); const b = routeCost(as(o, po)); pending.delete(c.id);
        return a + b;
      };
      const base = total(cKeep, oKeep);
      // les meilleurs tracés de c (l'autre flux restant en place), puis toutes les variantes de l'autre
      const cOpts = [cKeep, ...mine.map(pts => [routeCost(as(c, pts)), pts]).sort((a, b) => a[0] - b[0]).slice(0, 8).map(x => x[1])];
      const oOpts = straight(o) || settled.has(o.id) ? [oKeep] : [oKeep, ...candidates(o)];
      let best = { cost: base - 3, pc: null, po: null };
      for (const pc of cOpts) for (const po of oOpts) {
        const t = total(pc, po);
        if (t < best.cost) best = { cost: t, pc, po };
      }
      if (best.pc) {
        if (!sameWaypoints(best.pc, c.waypoints)) modeling.updateWaypoints(c, best.pc);
        if (!sameWaypoints(best.po, o.waypoints)) modeling.updateWaypoints(o, best.po);
        changed = true;
      }
    }
    return changed;
  }


  // ---------- libellés qui se chevauchent ----------
  function labelClashes(lbl) {
    const r = inflate(boxOf(lbl), 1);
    const owner = lbl.labelTarget;
    const shapesHit = registry.getAll().filter(e => e !== lbl && e !== owner && e.parent && Number.isFinite(e.width) && !e.waypoints
      && !isContainerShape(e) && !is(e, 'bpmn:Collaboration') && !is(e, 'bpmn:Process')
      && hit(r, boxOf(e)));
    // un trait qui barre le libellé (sauf le flux qu'il nomme)
    const core = inflate(boxOf(lbl), -1);
    const linesHit = registry.filter(e => e.waypoints && !is(e, 'bpmn:Association')
      && e.waypoints.some((p, i) => i > 0 && segmentHits(e.waypoints[i - 1], p, e === owner ? inflate(core, 1) : core)));
    // un libellé reste dans le sous-processus de son élément (sans mordre sur le bord ni le titre)
    const home = owner?.waypoints ? owner.parent : (owner?.host || owner)?.parent;
    const outside = home?.parent && Number.isFinite(home.width) && is(home, 'bpmn:SubProcess') && home.collapsed === false
      && !(lbl.x >= home.x + 4 && lbl.x + lbl.width <= home.x + home.width - 4 && lbl.y >= home.y + 22 && lbl.y + lbl.height <= home.y + home.height - 4);
    return [...shapesHit, ...linesHit, ...(outside ? [home] : [])];
  }
  /** Déplace un libellé externe qui recouvre un élément ou un autre libellé vers une place libre proche. */
  function freeLabel(lbl) {
    if (!labelClashes(lbl).length) return false;
    const owner = lbl.labelTarget;
    const ox = lbl.x, oy = lbl.y;
    let anchor;
    if (owner.waypoints) {
      // flux : milieu du plus long segment
      let best = null;
      for (let i = 1; i < owner.waypoints.length; i++) { const p = owner.waypoints[i - 1], q = owner.waypoints[i]; const len = Math.hypot(q.x - p.x, q.y - p.y); if (!best || len > best.len) best = { len, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }
      anchor = best;
    } else anchor = { x: owner.x + owner.width / 2, y: owner.y + owner.height / 2 };
    const w = lbl.width, h = lbl.height, ow = owner.waypoints ? 0 : owner.width / 2, oh = owner.waypoints ? 0 : owner.height / 2;
    const cands = [
      { x: anchor.x - w / 2, y: anchor.y + oh + 5 }, { x: anchor.x - w / 2, y: anchor.y - oh - 5 - h },
      { x: anchor.x + ow + 5, y: anchor.y - h / 2 }, { x: anchor.x - ow - 5 - w, y: anchor.y - h / 2 },
      { x: anchor.x + ow + 5, y: anchor.y + oh }, { x: anchor.x - ow - 5 - w, y: anchor.y + oh },
      { x: anchor.x + ow + 5, y: anchor.y - oh - h }, { x: anchor.x - ow - 5 - w, y: anchor.y - oh - h }
    ];
    // puis une recherche plus large autour (pas de 10 px, jusqu'à 70 px), la plus proche d'abord
    const ring = [];
    for (let dx = -70; dx <= 70; dx += 10) for (let dy = -60; dy <= 60; dy += 10) ring.push({ x: anchor.x - w / 2 + dx, y: anchor.y + oh + 5 + dy, d: Math.hypot(dx, dy) });
    ring.sort((a, b) => a.d - b.d);
    cands.push(...ring);
    for (const p of cands) {
      modeling.moveShape(lbl, { x: Math.round(p.x - lbl.x), y: Math.round(p.y - lbl.y) });
      if (!labelClashes(lbl).length) return true;
    }
    modeling.moveShape(lbl, { x: ox - lbl.x, y: oy - lbl.y });
    return false;
  }

  // ---------- libellés à distance fixe ----------
  const LABEL_GAP = 5;
  /**
   * Places normalisées d'un libellé, dans l'ordre de préférence, toutes à la même distance :
   * passerelle juste au-dessus (puis en dessous, à droite, à gauche) ; événement juste en dessous
   * (puis au-dessus…) ; flux collé à son premier segment, côté départ (puis à son deuxième segment).
   */
  function labelSpots(lbl) {
    const o = lbl.labelTarget, w = lbl.width, h = lbl.height;
    if (o.waypoints) {
      const pts = o.waypoints, spots = [];
      for (let i = 1; i < pts.length && i <= 2; i++) {
        const p = pts[i - 1], q = pts[i];
        if (Math.abs(p.y - q.y) < 1) {
          const len = Math.abs(q.x - p.x), dir = Math.sign(q.x - p.x) || 1;
          const x = len < w + 12 ? (p.x + q.x) / 2 - w / 2 : dir > 0 ? p.x + 6 : p.x - 6 - w;
          spots.push({ x, y: p.y - 4 - h }, { x, y: p.y + 4 });
        } else if (Math.abs(p.x - q.x) < 1) {
          const len = Math.abs(q.y - p.y), dir = Math.sign(q.y - p.y) || 1;
          const y = len < h + 12 ? (p.y + q.y) / 2 - h / 2 : dir > 0 ? p.y + 6 : p.y - 6 - h;
          spots.push({ x: p.x + 5, y }, { x: p.x - 5 - w, y });
        } else spots.push({ x: (p.x + q.x) / 2 + 5, y: (p.y + q.y) / 2 - h - 4 });
      }
      return spots;
    }
    const cx = o.x + o.width / 2, cy = o.y + o.height / 2, g = LABEL_GAP;
    const above = { x: cx - w / 2, y: o.y - g - h }, below = { x: cx - w / 2, y: o.y + o.height + g };
    const right = { x: o.x + o.width + g, y: cy - h / 2 }, left = { x: o.x - g - w, y: cy - h / 2 };
    const corners = [{ x: o.x + o.width + g, y: o.y + o.height + g }, { x: o.x - g - w, y: o.y + o.height + g }, { x: o.x + o.width + g, y: o.y - g - h }, { x: o.x - g - w, y: o.y - g - h }];
    if (o.host) return [below, corners[0], corners[1], right, left];   // événement de bordure : jamais dans sa boîte
    return is(o, 'bpmn:Gateway') ? [above, below, right, left, ...corners] : [below, above, right, left, ...corners];
  }
  /** Place un libellé à la première place normalisée libre (recherche plus large en dernier recours). */
  function normalizeLabel(lbl) {
    if (!lbl?.width || !lbl.labelTarget) return false;
    const ox = lbl.x, oy = lbl.y;
    for (const p of labelSpots(lbl)) {
      const dx = Math.round(p.x - lbl.x), dy = Math.round(p.y - lbl.y);
      if (dx || dy) modeling.moveShape(lbl, { x: dx, y: dy });
      if (!labelClashes(lbl).length) return Math.abs(lbl.x - ox) > 1 || Math.abs(lbl.y - oy) > 1;
    }
    modeling.moveShape(lbl, { x: ox - lbl.x, y: oy - lbl.y });
    return freeLabel(lbl);
  }
  const LAYOUT_OPS = new Set(['append', 'insert', 'attach', 'connect', 'delete', 'move', 'reroute', 'replace', 'add', 'space', 'resize']);
  /** Libellé resté loin de ce qu'il nomme (plus de 30 px de son élément ou de son flux). */
  function labelFar(lbl) {
    const o = lbl.labelTarget, b = boxOf(lbl);
    const distPt = p => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.width)), Math.max(b.y - p.y, 0, p.y - (b.y + b.height)));
    if (o.waypoints) {
      let best = Infinity;
      for (const [p, q] of segsOfPts(o.waypoints)) {
        const n = Math.max(1, Math.ceil((Math.abs(q.x - p.x) + Math.abs(q.y - p.y)) / 10));
        for (let i = 0; i <= n; i++) best = Math.min(best, distPt({ x: p.x + (q.x - p.x) * i / n, y: p.y + (q.y - p.y) * i / n }));
      }
      return best > 30;
    }
    const gapX = Math.max(o.x - (b.x + b.width), 0, b.x - (o.x + o.width)), gapY = Math.max(o.y - (b.y + b.height), 0, b.y - (o.y + o.height));
    return Math.hypot(gapX, gapY) > 30;
  }
  /** Tous les libellés : ceux des éléments d'abord, puis ceux des flux ; deux passes. */
  function normalizeLabels(list) {
    const moved = new Set();
    const sorted = list.filter(l => l?.width && l.labelTarget).sort((a, b) => (a.labelTarget.waypoints ? 1 : 0) - (b.labelTarget.waypoints ? 1 : 0));
    for (const l of sorted) if (normalizeLabel(l)) moved.add(l);
    for (const l of sorted) if (labelClashes(l).length && normalizeLabel(l)) moved.add(l);
    return moved.size;
  }

  // ---------- commentaires ----------
  /** Retire les retours à la ligne et espaces en trop autour du texte ; hauteur ajustée au texte. */
  function fitAnnotation(el, { widen = false } = {}) {
    if (!is(el, 'bpmn:TextAnnotation')) return false;
    const bo = getBusinessObject(el);
    const raw = String(bo.text || '');
    const text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    let changed = false;
    if (text !== raw) { modeling.updateProperties(el, { text }); changed = true; }
    // commentaire créé ou réécrit : plutôt large que haut (3 lignes visées, 320 px au plus) ; jamais rétréci
    if (widen) {
      const W = [160, 200, 240, 280, 320].find(w => lineCount(text, w - 10) <= 3) || 320;
      if (el.width < W) { modeling.resizeShape(el, { x: el.x, y: el.y, width: W, height: el.height }); changed = true; }
    }
    const need = Math.max(30, Math.ceil(lineCount(text, el.width - 10) * 14.4 + 12));
    if (Math.abs(el.height - need) > 3) { modeling.resizeShape(el, { x: el.x, y: el.y, width: el.width, height: need }); changed = true; }
    return changed;
  }
  const noteLinks = note => [...(note.incoming || []), ...(note.outgoing || [])].filter(a => is(a, 'bpmn:Association'));
  const noteTarget = note => { const a = noteLinks(note)[0]; return a ? (a.source === note ? a.target : a.source) : null; };
  const boxOfAny = e => e.waypoints ? (() => { let b = null; for (let i = 1; i < e.waypoints.length; i++) { const p = e.waypoints[i - 1], q = e.waypoints[i]; const len = Math.abs(q.x - p.x) + Math.abs(q.y - p.y); if (!b || len > b.len) b = { len, x: (p.x + q.x) / 2 - 1, y: (p.y + q.y) / 2 - 1 }; } return { x: b.x, y: b.y, width: 2, height: 2 }; })() : boxOf(e);
  /** Problèmes d'un commentaire à une place donnée : boîte qui chevauche, pointillé qui traverse. */
  function noteProblems(note, box, target) {
    const tb = boxOfAny(target);
    const skip = new Set([note, target, target.host, ...(target.attachers || [])].filter(Boolean));
    const area = areaOf(note);
    if (area && !(box.x >= area.x && box.y >= area.y && box.x + box.width <= area.x + area.width && box.y + box.height <= area.y + area.height)) return 1;
    let n = 0;
    const a = { x: box.x + box.width / 2, y: box.y + box.height / 2 }, b = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
    for (const e of registry.getAll()) {
      if (skip.has(e) || !e.parent) continue;
      if (e.type === 'label') { if (e.width && e.labelTarget !== note && hit(inflate(box, 4), boxOf(e))) n++; continue; }
      if (e.waypoints) {
        if (noteLinks(note).includes(e)) continue;
        const segs = segsOfPts(e.waypoints);
        if (segs.some(([p, q]) => segmentHits(p, q, inflate(box, 6)))) n++;
        else if (segs.some(([p, q]) => cutSeg(a, b, p, q))) n++;   // une flèche ou le pointillé d'un autre commentaire
        continue;
      }
      if (isContainerShape(e) || is(e, 'bpmn:Process') || is(e, 'bpmn:Collaboration')) continue;
      if (hit(inflate(box, 8), boxOf(e))) n++;
      else if (segmentHits(a, b, inflate(boxOf(e), -2))) n++;
    }
    return n;
  }
  /** Commentaire qui chevauche ou dont le pointillé traverse : place libre proche de son élément. */
  function placeNote(note) {
    const target = noteTarget(note);
    if (!target) return false;
    if (!noteProblems(note, boxOf(note), target)) return false;
    const tb = boxOfAny(target), w = note.width, h = note.height;
    const cx = tb.x + tb.width / 2, cy = tb.y + tb.height / 2;
    const spots = [];
    for (const d of [25, 40, 60, 90]) for (const k of [0, 40, -40, 80, -80]) {
      spots.push({ x: cx - w / 2 + k, y: tb.y - d - h }, { x: cx - w / 2 + k, y: tb.y + tb.height + d },
        { x: tb.x + tb.width + d, y: cy - h / 2 + k }, { x: tb.x - d - w, y: cy - h / 2 + k });
    }
    const dist = p => Math.hypot(p.x + w / 2 - cx, p.y + h / 2 - cy);
    spots.sort((a, b) => dist(a) - dist(b));
    for (const p of spots) {
      const box = { x: p.x, y: p.y, width: w, height: h };
      if (!noteProblems(note, box, target)) { modeling.moveShape(note, { x: Math.round(p.x - note.x), y: Math.round(p.y - note.y) }); return true; }
    }
    return false;
  }
  const noteCrossings = () => registry.filter(e => is(e, 'bpmn:TextAnnotation') && noteTarget(e) && noteProblems(e, boxOf(e), noteTarget(e))).map(e => e.id);

  // ---------- espacement vertical : rapprocher les branches de ce qui est au-dessus ----------
  const ROW_GAP = 40;
  /**
   * Remonte chaque rangée d'éléments (éléments alignés et reliés entre eux) tant qu'il reste plus de
   * ROW_GAP px libres au-dessus : boîtes, libellés et tracés des autres flux comptent comme obstacles.
   */
  function compactRows() {
    const nodes = registry.filter(e => e.parent && e.type !== 'label' && !e.waypoints && is(e, 'bpmn:FlowNode') && !is(e, 'bpmn:BoundaryEvent'));
    const parentOf = new Map(nodes.map(n => [n, n]));
    const find = n => { while (parentOf.get(n) !== n) n = parentOf.get(n); return n; };
    const cyOf = e => e.y + e.height / 2;
    for (const n of nodes) for (const c of n.outgoing || []) {
      const t = c.target;
      if (parentOf.has(t) && t.parent === n.parent && Math.abs(cyOf(t) - cyOf(n)) < 3) parentOf.set(find(t), find(n));
    }
    const groups = new Map();
    for (const n of nodes) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
    const list = [...groups.values()].sort((a, b) => Math.min(...a.map(e => e.y)) - Math.min(...b.map(e => e.y)));
    let moved = 0;
    for (const g of list) {
      const inG = new Set(g.flatMap(m => [m, ...(m.attachers || [])]));
      const flowsOfG = new Set(g.flatMap(m => [m, ...(m.attachers || [])]).flatMap(m => [...(m.incoming || []), ...(m.outgoing || [])]));
      const parent = g[0].parent;
      const lanes = (parent.children || []).filter(e => is(e, 'bpmn:Lane'));
      let lift = Infinity;
      for (const m of g) {
        const top = Math.min(m.y, ...ownLabel(m).map(l => l.y));
        const x0 = m.x - 10, x1 = m.x + m.width + 10;
        let floor = -Infinity;
        for (const e of registry.getAll()) {
          if (!e.parent || inG.has(e) || e === parent) continue;
          if (e.type === 'label') {
            if (!e.width || inG.has(e.labelTarget) || flowsOfG.has(e.labelTarget)) continue;
            const t = e.labelTarget; if (t.parent !== parent && t.host?.parent !== parent && t.source?.parent !== parent) continue;
            if (e.x < x1 && e.x + e.width > x0 && e.y + e.height <= top) floor = Math.max(floor, e.y + e.height + 15);
            continue;
          }
          if (e.waypoints) {
            if (flowsOfG.has(e) || e.parent !== parent) continue;
            for (const [p, q] of segsOfPts(e.waypoints)) if (Math.abs(p.y - q.y) < 1 && p.y <= top && Math.min(p.x, q.x) < x1 && Math.max(p.x, q.x) > x0) floor = Math.max(floor, p.y + 20);
            continue;
          }
          if (e.parent !== parent || is(e, 'bpmn:Lane')) continue;
          if (e.x < x1 && e.x + e.width > x0 && e.y + e.height <= top) floor = Math.max(floor, e.y + e.height + ROW_GAP);
        }
        const lane = lanes.find(l => cyOf(m) > l.y && cyOf(m) < l.y + l.height);
        if (lane) floor = Math.max(floor, lane.y + 15);
        const area = areaOf(m);
        if (area) floor = Math.max(floor, area.y + 5);
        if (floor === -Infinity) { lift = 0; break; }
        lift = Math.min(lift, top - floor);
      }
      if (!(lift > 15) || lift === Infinity) continue;
      const dy = -Math.floor(lift);
      modeling.moveElements(g, { x: 0, y: dy });
      if (g.some(m => !freeAt(m, 0, 0, obstaclesFor(m), areaOf(m)))) modeling.moveElements(g, { x: 0, y: -dy });
      else moved += g.length;
    }
    return moved;
  }

  // ---------- sorties de passerelle : une flèche par côté ----------
  /** Côté par lequel un flux quitte sa source : top, bottom, left, right. */
  function exitSide(c, pts = c.waypoints) {
    const s = c.source, p = pts[0];
    const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
    const dx = p.x - cx, dy = p.y - cy;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) { const q = pts[1] || p; return Math.abs(q.x - cx) > Math.abs(q.y - cy) ? (q.x > cx ? 'right' : 'left') : (q.y > cy ? 'bottom' : 'top'); }
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  }
  /** Tracé partant d'un côté donné de la source. */
  function viaFromSide(c, side) {
    const s = c.source, t = c.target;
    const sc = { x: s.x + s.width / 2, y: s.y + s.height / 2 }, tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    const out = 25;
    if (side === 'right' || side === 'left') {
      const sign = side === 'right' ? 1 : -1;
      const edgeX = sc.x + sign * (s.width / 2 + out);
      if (Math.abs(tc.y - sc.y) < 2) return [{ x: (sc.x + tc.x) / 2, y: sc.y }];
      const turnX = (sign > 0 ? tc.x > edgeX : tc.x < edgeX) ? tc.x : edgeX;
      return turnX === tc.x ? [{ x: tc.x, y: sc.y }] : [{ x: edgeX, y: sc.y }, { x: edgeX, y: tc.y }];
    }
    const sign = side === 'bottom' ? 1 : -1;
    const edgeY = sc.y + sign * (s.height / 2 + out);
    if (Math.abs(tc.x - sc.x) < 2) return [{ x: sc.x, y: (sc.y + tc.y) / 2 }];
    const turnY = (sign > 0 ? tc.y > edgeY : tc.y < edgeY) ? tc.y : edgeY;
    return turnY === tc.y ? [{ x: sc.x, y: tc.y }] : [{ x: sc.x, y: edgeY }, { x: tc.x, y: edgeY }];
  }
  /**
   * Deux sorties d'une passerelle qui partent du même côté semblent partir l'une de l'autre :
   * on redonne à chacune son propre côté (en gardant celui de la sortie la plus « naturelle »).
   */
  function fixGatewayExits(gw) {
    if (!is(gw, 'bpmn:Gateway')) return 0;
    const outs = (gw.outgoing || []).filter(c => c.waypoints?.length);
    if (outs.length < 2) return 0;
    const bySide = new Map();
    for (const c of outs) { const side = exitSide(c); if (!bySide.has(side)) bySide.set(side, []); bySide.get(side).push(c); }
    const used = new Set([...bySide.keys()].filter(k => bySide.get(k).length === 1));
    let fixed = 0;
    for (const [side, list] of bySide) {
      if (list.length < 2) continue;
      // garder sur ce côté le flux dont la cible est la plus alignée avec lui
      const gc = { x: gw.x + gw.width / 2, y: gw.y + gw.height / 2 };
      const score = c => { const t = c.target, tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
        return side === 'right' ? -(tc.x - gc.x) + Math.abs(tc.y - gc.y) * 2 : side === 'left' ? (tc.x - gc.x) + Math.abs(tc.y - gc.y) * 2
          : side === 'bottom' ? -(tc.y - gc.y) + Math.abs(tc.x - gc.x) * 2 : (tc.y - gc.y) + Math.abs(tc.x - gc.x) * 2; };
      list.sort((a, b) => (settled.has(b.id) - settled.has(a.id)) || score(a) - score(b));   // un flux figé garde son côté
      used.add(side);
      for (const c of list.slice(1)) {
        const t = c.target, tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
        const prefs = (tc.y > gc.y + 5 ? ['bottom'] : tc.y < gc.y - 5 ? ['top'] : []).concat(tc.x > gc.x ? ['right', 'bottom', 'top', 'left'] : ['left', 'bottom', 'top', 'right']);
        const free = prefs.find(sd => !used.has(sd));
        if (!free) continue;
        routeVia(c, viaFromSide(c, free));
        used.add(free);
        fixed++;
      }
    }
    return fixed;
  }
  /**
   * Flux qui revient en arrière (cible à gauche de la source) : le tracé automatique part à la
   * verticale et traverse la ligne principale. On le fait passer sous les éléments qu'il enjambe.
   */
  /** Points de passage d'un retour en arrière par-dessous (side below) ou par-dessus, décalé de extra px. */
  function loopVia(c, side, extra = 0) {
    const s = c.source, t = c.target;
    const parent = c.parent;
    const between = registry.filter(e => e.parent === parent && !e.waypoints && e.type !== 'label' && !isContainerShape(e)
      && e !== s && e !== t && e.x < s.x + s.width && e.x + e.width > t.x);
    const labelsNear = registry.filter(e => e.type === 'label' && e.width && (between.includes(e.labelTarget) || between.includes(e.labelTarget?.host)));
    const all = [...between, ...labelsNear];
    const area = parent && isContainerShape(parent) ? parent : null;
    const obstacles = [...between, ...registry.filter(e => e.type === 'label' && e.width && (e.labelTarget?.parent === parent || e.labelTarget?.host?.parent === parent))]
      .filter(e => e !== s && e !== t && e.labelTarget !== s && e.labelTarget !== t);
    let y = side === 'below'
      ? Math.max(s.y + s.height, t.y + t.height, ...all.map(e => e.y + e.height)) + 25 + extra
      : Math.min(s.y, t.y, ...all.map(e => e.y)) - 25 - extra;
    if (area) y = Math.max(area.y + 30, Math.min(y, area.y + area.height - 12));
    const pick = el => {
      const edge = side === 'below' ? el.y + el.height : el.y;
      const onEdge = (el.attachers || []).filter(a => Math.abs(a.y + a.height / 2 - edge) < 4);
      const cands = [];
      for (let f = 0.5, k = 0; k < 17; k++) { cands.push(Math.round(el.x + el.width * f)); f = 0.5 + (k % 2 ? 1 : -1) * Math.ceil((k + 1) / 2) * 0.05; }
      return cands.find(x => x > el.x + 4 && x < el.x + el.width - 4
        && onEdge.every(a => Math.abs(a.x + a.width / 2 - x) > a.width / 2 + 8)
        && !obstacles.some(o => segmentHits({ x, y: edge + (side === 'below' ? 1 : -1) }, { x, y }, inflate(boxOf(o), 4))));
    };
    const sx = pick(s), tx = pick(t);
    if (sx == null || tx == null) return null;
    if (obstacles.some(o => segmentHits({ x: sx, y }, { x: tx, y }, inflate(boxOf(o), 2)))) return null;
    return [{ x: sx, y }, { x: tx, y }];
  }

  /**
   * Flux qui revient en arrière (cible à gauche de la source) : le tracé automatique part à la
   * verticale et longe la ligne principale. On choisit le meilleur contournement (dessous ou dessus).
   */
  function loopBelowIfBackward(c) {
    if (!is(c, 'bpmn:SequenceFlow')) return;
    const s = c.source, t = c.target;
    if (!(t.x + t.width < s.x)) return;
    improveRoute(c, { force: true });
  }


  /** Trace un flux par des points de passage (coudes), extrémités calées sur le bord des éléments. */
  function routeVia(c, via) { modeling.updateWaypoints(c, computeVia(c, via)); }
  /** Points d'un tracé par des points de passage, sans rien modifier. */
  function computeVia(c, via) {
    const pts = via.map(p => {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) throw new OpError('chaque point de passage doit avoir x et y');
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
    const mid = e => ({ x: Math.round(e.x + e.width / 2), y: Math.round(e.y + e.height / 2) });
    // segments orthogonaux : l'extrémité est alignée sur le premier / dernier point de passage
    const s = mid(c.source), t = mid(c.target);
    const first = pts[0], last = pts[pts.length - 1];
    const start = Math.abs(first.x - s.x) < Math.abs(first.y - s.y) ? { x: first.x, y: s.y } : { x: s.x, y: first.y };
    const end = Math.abs(last.x - t.x) < Math.abs(last.y - t.y) ? { x: last.x, y: t.y } : { x: t.x, y: last.y };
    const raw = [start, ...pts, end];
    return docking.getCroppedWaypoints({ ...c, waypoints: raw }, c.source, c.target).map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  }

  const refs = new Map(); // ref proposé par Claude → id réel

  function get(id, what = 'élément') {
    if (typeof id !== 'string') throw new OpError(`${what} manquant`);
    const el = registry.get(refs.get(id) || id);
    if (!el || el.type === 'label') throw new OpError(`${what} « ${id} » introuvable`);
    return el;
  }

  const expr = body => bpmnFactory.create('bpmn:FormalExpression', { body: String(body) });

  function newShape(op) {
    const type = op.type || (op.event ? 'bpmn:IntermediateCatchEvent' : 'bpmn:Task');
    if (!/^bpmn:\w+$/.test(type)) throw new OpError(`type « ${type} » invalide`);
    const attrs = { type };
    const id = op.ref && ID_RE.test(op.ref) && !registry.get(op.ref) ? op.ref : undefined;
    try { attrs.businessObject = bpmnFactory.create(type, id ? { id } : {}); }
    catch { throw new OpError(`type « ${type} » inconnu`); }
    if (op.event && op.event !== 'none') {
      if (!EVENT_DEFS[op.event]) throw new OpError(`événement « ${op.event} » inconnu`);
      attrs.eventDefinitionType = EVENT_DEFS[op.event];
    }
    if (type === 'bpmn:SubProcess') attrs.isExpanded = op.expanded !== false;
    return elementFactory.createShape(attrs);
  }

  /** Refuse un nom qui déborderait de sa boîte (les tâches ont une taille fixe). */
  function checkFits(el, name) {
    if (!name || el.waypoints) return;
    const o = labelOverflow(el.type, name, { width: el.width, height: el.height, expanded: is(el, 'bpmn:SubProcess') && el.collapsed === false, boundary: !!el.attachers?.length });
    if (o) throw new OpError(`« ${name} » : ${overflowText(o)} ${overflowFix(o)}`);
  }

  function finish(shape, op) {
    if (op.ref) refs.set(op.ref, shape.id);
    if (typeof op.name === 'string') op.name = op.name.trim();
    checkFits(shape, op.name);
    if (op.name) modeling.updateLabel(shape, op.name);
    if (op.timer) setTimer(shape, op.timer.kind, op.timer.value);
    if (op.documentation) setDoc(shape, op.documentation);
    return shape;
  }

  function setDoc(el, text) {
    modeling.updateProperties(el, { documentation: text ? [bpmnFactory.create('bpmn:Documentation', { text: String(text) })] : [] });
  }

  function setTimer(el, kind = 'timeDuration', value) {
    const def = (getBusinessObject(el).eventDefinitions || []).find(d => is(d, 'bpmn:TimerEventDefinition'));
    if (!def) throw new OpError(`« ${el.id} » n'est pas un événement timer`);
    if (!TIMER_KINDS.includes(kind)) throw new OpError(`type de délai « ${kind} » invalide`);
    const props = { timeDuration: undefined, timeDate: undefined, timeCycle: undefined };
    if (value) props[kind] = expr(value);
    modeling.updateModdleProperties(el, def, props);
  }

  function flowBetween(a, b) {
    return (a.outgoing || []).find(c => c.target === b);
  }

  /** Décale vers la droite ce qui suit une position, pour faire de la place à un élément inséré. */
  /**
   * Le décalage (spaceTool) déplace les éléments et les tracés, pas les libellés des flux : ceux dont
   * les deux extrémités ont bougé suivent du même décalage, les autres sont replacés près de leur flux.
   */
  function carryFlowLabels(moving, delta, run) {
    const moved = new Set(moving);
    const flows = [...new Set(moving.flatMap(e => [...(e.incoming || []), ...(e.outgoing || [])]))].filter(c => c.label?.width);
    const before = new Map(flows.map(c => [c, { x: c.label.x, y: c.label.y }]));
    run();
    for (const c of flows) {
      const b = before.get(c), l = c.label;
      if (!l || Math.abs(l.x - b.x) > 0.5 || Math.abs(l.y - b.y) > 0.5) continue;   // déjà déplacé
      const both = moved.has(c.source) || moved.has(c.source?.host);
      const both2 = moved.has(c.target) || moved.has(c.target?.host);
      if (both && both2) modeling.moveShape(l, delta);
      else normalizeLabel(l);
    }
  }
  /** Racine (plan) d'un élément : le diagramme principal ou la vue détaillée d'un sous-processus replié. */
  const planeOf = e => { let r = e; while (r.parent) r = r.parent; return r; };
  function makeRoom(x, width, plane = canvas.getRootElement()) {
    // libellés compris : sinon ceux des flux restent en place quand tout le reste se décale
    const elements = registry.filter(e => e.parent && !e.waypoints && planeOf(e) === plane);
    let { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(elements, 'x', width, x);
    // une note suit l'élément qu'elle commente, pas la ligne de décalage
    const moving = new Set(movingShapes);
    const linkedTo = a => [...(a.incoming || []), ...(a.outgoing || [])].map(c => c.source === a ? c.target : c.source).filter(Boolean);
    movingShapes = movingShapes.filter(sh => {
      if (!is(sh, 'bpmn:TextAnnotation')) return true;
      const others = linkedTo(sh);
      return !others.length || others.some(o => moving.has(o) || moving.has(o.host));
    });
    for (const sh of elements) {
      if (!is(sh, 'bpmn:TextAnnotation') || moving.has(sh)) continue;
      if (linkedTo(sh).some(o => moving.has(o))) movingShapes.push(sh);
    }
    if (movingShapes.length || resizingShapes.length) carryFlowLabels(movingShapes, { x: width, y: 0 }, () => modeling.createSpace(movingShapes, resizingShapes, { x: width, y: 0 }, 'e', x));
  }

  // ---------- placement sans chevauchement ----------
  const inflate = (r, m) => ({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m });
  const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const isContainerShape = e => is(e, 'bpmn:SubProcess') && e.collapsed !== true || is(e, 'bpmn:Participant') || is(e, 'bpmn:Lane');
  const boxOf = e => ({ x: e.x, y: e.y, width: e.width, height: e.height });
  const ownLabel = sh => (sh.labels || []).filter(l => l.width);

  /** Ce qu'un élément doit éviter dans son conteneur : éléments, libellés, tracés des flux. */
  function obstaclesFor(shape) {
    const parent = shape.parent;
    const mine = new Set([shape, ...(shape.attachers || []), ...ownLabel(shape)]);
    const linked = new Set([...(shape.incoming || []), ...(shape.outgoing || []), ...(shape.attachers || []).flatMap(a => a.outgoing || [])]);
    const boxes = [], labels = [], segments = [];
    for (const e of registry.getAll()) {
      if (mine.has(e) || !e.parent) continue;
      if (e.type === 'label') {
        if (e.labelTarget && !mine.has(e.labelTarget) && (e.labelTarget.parent === parent || e.labelTarget.host?.parent === parent) && e.width) labels.push(boxOf(e));
        continue;
      }
      if (e.waypoints) {
        if (linked.has(e) || e.parent !== parent && !(is(parent, 'bpmn:Lane') || is(e.parent, 'bpmn:Lane'))) continue;
        for (let i = 1; i < e.waypoints.length; i++) segments.push([e.waypoints[i - 1], e.waypoints[i]]);
        continue;
      }
      if (e === parent || e.host === shape) continue;
      if (e.parent === parent || (e.host && e.host.parent === parent)) boxes.push(boxOf(e));
    }
    return { boxes, labels, segments };
  }

  /** Le segment [p, q] passe-t-il à l'intérieur du rectangle r ? (calcul exact, Liang–Barsky) */
  function segmentHits(p, q, r) {
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dy = q.y - p.y;
    const P = [-dx, dx, -dy, dy], Q = [p.x - r.x, r.x + r.width - p.x, p.y - r.y, r.y + r.height - p.y];
    for (let i = 0; i < 4; i++) {
      if (P[i] === 0) { if (Q[i] <= 0) return false; continue; }
      const t = Q[i] / P[i];
      if (P[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t1 - t0 > 1e-6;
  }

  /** Zone utile du conteneur (sous-processus déplié, pool, couloir) ; null au niveau du processus. */
  function areaOf(shape) {
    const p = shape.parent;
    if (!p || !isContainerShape(p)) return null;
    const left = is(p, 'bpmn:Participant') || is(p, 'bpmn:Lane') ? 30 : 0;
    return { x: p.x + left + 10, y: p.y + (is(p, 'bpmn:SubProcess') ? 25 : 10), width: p.width - left - 20, height: p.height - (is(p, 'bpmn:SubProcess') ? 35 : 20) };
  }

  /** La place (décalage dx, dy) est-elle libre pour l'élément et son libellé ? */
  function freeAt(shape, dx, dy, obs, area) {
    const body = { x: shape.x + dx, y: shape.y + dy, width: shape.width, height: shape.height };
    const rects = [body, ...ownLabel(shape).map(l => ({ x: l.x + dx, y: l.y + dy, width: l.width, height: l.height }))];
    if (area && !(body.x >= area.x && body.y >= area.y && body.x + body.width <= area.x + area.width && body.y + body.height <= area.y + area.height)) return false;
    for (const r of rects) {
      if (obs.boxes.some(b => hit(inflate(r, r === body ? 18 : 6), b))) return false;
      if (obs.labels.some(b => hit(inflate(r, 4), b))) return false;
    }
    const core = inflate(body, 6);
    return !obs.segments.some(([p, q]) => segmentHits(p, q, core));
  }

  /** Tracé probable (orthogonal) des flux de l'élément s'il était décalé de (dx, dy). */
  function linkPaths(shape, dx, dy) {
    const me = { x: shape.x + dx, y: shape.y + dy, width: shape.width, height: shape.height };
    const mid = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    const paths = [];
    for (const c of shape.incoming || []) {
      const s = c.source; if (!s || s === shape) continue;
      const t = { x: me.x, y: me.y + me.height / 2 };
      if (is(s, 'bpmn:BoundaryEvent')) { const a = { x: mid(s).x, y: s.y + s.height }; paths.push({ pts: [a, { x: a.x, y: t.y }, t], ends: [s, s.host] }); }
      else { const a = { x: s.x + s.width, y: mid(s).y }; const mx = (a.x + t.x) / 2; paths.push({ pts: [a, { x: mx, y: a.y }, { x: mx, y: t.y }, t], ends: [s] }); }
    }
    for (const c of shape.outgoing || []) {
      const t = c.target; if (!t || t === shape) continue;
      const a = { x: me.x + me.width, y: me.y + me.height / 2 }, b = { x: t.x, y: mid(t).y };
      const mx = (a.x + b.x) / 2; paths.push({ pts: [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b], ends: [t] });
    }
    return paths;
  }

  /** Nombre d'éléments que traverseraient les flux de l'élément à cette place. */
  function crossings(shape, dx, dy) {
    let n = 0;
    for (const { pts, ends } of linkPaths(shape, dx, dy)) {
      const skip = new Set([shape, ...ends.filter(Boolean)]);
      // éléments voisins, y compris un sous-processus frère (pas les conteneurs de l'élément lui-même)
      const others = registry.filter(e => !skip.has(e) && e.type !== 'label' && !e.waypoints && e.parent && (e.parent === shape.parent || e.host?.parent === shape.parent));
      for (const o of others) {
        const box = inflate(boxOf(o), -2);
        for (let i = 1; i < pts.length; i++) if (segmentHits(pts[i - 1], pts[i], box)) { n++; break; }
      }
    }
    return n;
  }

  /**
   * Cherche, autour de la position actuelle, une place libre (élément et libellé hors de tout autre
   * élément, libellé ou flux, dans le cadre du conteneur) dont les flux traversent le moins
   * d'éléments possible, en restant proche (de préférence à droite, puis en dessous) ; y déplace l'élément.
   */
  function placeFree(shape) {
    if (shape.waypoints || shape.type === 'label' || is(shape, 'bpmn:BoundaryEvent')) return true;
    const obs = obstaclesFor(shape), area = areaOf(shape);
    const here = freeAt(shape, 0, 0, obs, area) ? crossings(shape, 0, 0) : Infinity;
    if (here === 0) return true;
    const stepX = Math.max(60, shape.width + 30), stepY = Math.max(60, shape.height + 40);
    let best = here === Infinity ? null : { dx: 0, dy: 0, cost: here * 400 };
    for (let i = -3; i <= 7; i++) for (let j = -6; j <= 7; j++) {
      if (!i && !j) continue;
      const dx = i * stepX / 2, dy = j * stepY / 2;
      const dist = Math.abs(dx) * (dx < 0 ? 2.5 : 1) + Math.abs(dy) * (dy < 0 ? 1.6 : 1.2);
      if (best && dist >= best.cost) continue;
      if (!freeAt(shape, dx, dy, obs, area)) continue;
      const cost = dist + crossings(shape, dx, dy) * 400;
      if (!best || cost < best.cost) best = { dx, dy, cost };
    }
    if (!best) return false; // rien de libre à proximité : on laisse, la vérification le signalera
    if (best.dx || best.dy) modeling.moveElements([shape], { x: Math.round(best.dx), y: Math.round(best.dy) });
    return true;
  }

  /** Éléments ajoutés ou déplacés qui en chevauchent d'autres (pour le compte rendu). */
  function overlapsOf(shape) {
    if (shape.waypoints || shape.type === 'label' || is(shape, 'bpmn:BoundaryEvent') || !shape.parent) return [];
    const parent = shape.parent;
    const encloses = (c, s) => c.x <= s.x && c.y <= s.y && c.x + c.width >= s.x + s.width && c.y + c.height >= s.y + s.height;
    return registry.filter(e => e !== shape && e !== parent && e.type !== 'label' && !e.waypoints && e.host !== shape && e !== shape.host
      && (e.parent === parent) && !(isContainerShape(e) && encloses(e, shape)) && hit(inflate(boxOf(shape), 2), boxOf(e))).map(e => e.id);
  }

  /** Décale ce qui commence après start (axe x ou y) de delta ; refuse si cela crée un chevauchement. */
  function shiftFrom(axis, start, delta, plane = canvas.getRootElement()) {
    if (!delta) return;
    const elements = registry.filter(e => e.parent && !e.waypoints && planeOf(e) === plane);
    const { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(elements, axis, Math.abs(delta), start);
    if (!movingShapes.length && !resizingShapes.length) return;
    const d = axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta };
    carryFlowLabels(movingShapes, d, () => modeling.createSpace(movingShapes, resizingShapes, d, axis === 'x' ? 'e' : 's', start));
    if (delta < 0) {
      const bad = movingShapes.filter(e => e.type !== 'label').flatMap(e => overlapsOf(e).map(o => `${e.id}/${o}`));
      if (bad.length) throw new OpError(`pas assez de place pour resserrer de ${-delta} px : chevauchement (${bad.slice(0, 4).join(', ')}). Essayez un décalage plus petit.`);
    }
  }
  const MAX_COLUMN_GAP = 130, COLUMN_GAP = 70;
  /**
   * Colonnes vides : là où aucun élément, libellé ni commentaire n'occupe une bande verticale de plus de
   * MAX_COLUMN_GAP px, on resserre à COLUMN_GAP px (ce qui suit est décalé, le pool se resserre).
   */
  function compactColumns() {
    let saved = 0;
    for (let guard = 0; guard < 40; guard++) {
      // éléments du plan affiché (pas ceux des vues détaillées des sous-processus repliés)
      const root = canvas.getRootElement();
      const rootOf = planeOf;
      const items = registry.filter(e => e.parent && !e.waypoints && Number.isFinite(e.width) && e.width > 0
        && !is(e, 'bpmn:Participant') && !is(e, 'bpmn:Lane') && rootOf(e) === root);
      const spans = items.map(e => [e.x, e.x + e.width]).sort((a, b) => a[0] - b[0]);
      let gap = null, end = -Infinity;
      for (const [a, b] of spans) {
        if (end > -Infinity && a - end > MAX_COLUMN_GAP) { gap = { start: end, size: a - end }; break; }
        end = Math.max(end, b);
      }
      if (!gap) break;
      const d = Math.round(gap.size - COLUMN_GAP);
      const mark = commandStack._stackIdx;
      try { shiftFrom('x', gap.start + gap.size - 1, -d); saved += d; }
      catch { undoTo(mark); break; }
    }
    return saved;
  }
  /** Pools : retire le vide à droite et en bas (au-delà de 60 px de marge). */
  function trimPools() {
    let n = 0;
    for (const p of registry.filter(e => is(e, 'bpmn:Participant') && Number.isFinite(e.width))) {
      if ((p.children || []).some(c => is(c, 'bpmn:Lane'))) continue;
      const inside = registry.filter(e => e.parent && !e.waypoints && e.type !== 'label' && e !== p && (() => { for (let q = e.parent; q; q = q.parent) if (q === p) return true; return false; })());
      if (!inside.length) continue;
      const labels = inside.flatMap(e => ownLabel(e));
      const flowsPts = registry.filter(e => e.waypoints && e.parent === p).flatMap(e => e.waypoints);
      const right = Math.max(...inside.map(e => e.x + e.width), ...labels.map(l => l.x + l.width), ...flowsPts.map(q => q.x)) + 60;
      const bottom = Math.max(...inside.map(e => e.y + e.height), ...labels.map(l => l.y + l.height), ...flowsPts.map(q => q.y)) + 60;
      const w = Math.max(right - p.x, 300), h = Math.max(bottom - p.y, 120);
      if (p.width - w > 20 || p.height - h > 20) { modeling.resizeShape(p, { x: p.x, y: p.y, width: Math.min(p.width, w), height: Math.min(p.height, h) }); n++; }
    }
    return n;
  }

  /** Après un déplacement : redresser les flux reliés qui peuvent l'être, replacer libellés et commentaires. */
  function afterMove(el) {
    if (is(el, 'bpmn:TextAnnotation')) { placeNote(el); return; }
    const ends = [el, ...(el.attachers || [])];
    const flows = [...new Set(ends.flatMap(e => [...(e.incoming || []), ...(e.outgoing || [])]).filter(c => is(c, 'bpmn:SequenceFlow')))];
    for (const c of flows) improveRoute(c);
    for (const g of new Set(flows.flatMap(c => [c.source, c.target]).filter(x => is(x, 'bpmn:Gateway')))) fixGatewayExits(g);
    normalizeLabels([...ends.flatMap(e => ownLabel(e)), ...flows.map(c => c.label)]);
    for (const n of ends.flatMap(e => noteLinks(e)).map(a => a.source === el ? a.target : a.source).filter(x => is(x, 'bpmn:TextAnnotation'))) placeNote(n);
  }

  const OPS = {
    update(op) {
      const el = get(op.id);
      if (typeof op.name === 'string') op.name = op.name.trim();
      if (op.name !== undefined) { checkFits(el, op.name); modeling.updateLabel(el, op.name); }
      if (op.documentation !== undefined) setDoc(el, op.documentation);
      if (is(el, 'bpmn:TextAnnotation')) { fitAnnotation(el, { widen: op.name !== undefined }); placeNote(el); }
    },

    /**
     * Couleur d'éléments (ou "all" : tout le diagramme affiché) : preset (orange, yellow, green, blue,
     * red, purple, grey, default = couleur normale) ou fill / stroke en hexadécimal.
     */
    color(op) {
      const preset = op.preset ? COLOR_PRESETS.find(c => c.key === op.preset) : null;
      if (op.preset && !preset) throw new OpError(`couleur « ${op.preset} » inconnue (${COLOR_PRESETS.map(c => c.key).join(', ')})`);
      const hex = v => v === undefined || v === null || /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v);
      if (!hex(op.fill) || !hex(op.stroke)) throw new OpError('fill et stroke : couleur hexadécimale, par ex. #FFE0B2');
      const plane = canvas.getRootElement();
      const els = op.ids === 'all' || op.id === 'all'
        ? registry.filter(e => e.parent && e.type !== 'label' && !is(e, 'bpmn:Participant') && !is(e, 'bpmn:Lane') && planeOf(e) === plane)
        : (Array.isArray(op.ids) ? op.ids : [op.id]).map(id => get(id));
      if (!els.length) throw new OpError('aucun élément à colorer');
      const colors = preset ? { fill: preset.fill, stroke: preset.stroke } : { fill: op.fill || undefined, stroke: op.stroke || undefined };
      modeling.setColor(els, colors);
    },

    /** Redimensionne un élément (commentaire, sous-processus déplié, pool) ; le coin haut gauche reste en place. */
    resize(op) {
      const el = get(op.id);
      if (el.waypoints) throw new OpError(`« ${op.id} » est un flux`);
      const width = Number.isFinite(op.width) ? Math.round(op.width) : el.width, height = Number.isFinite(op.height) ? Math.round(op.height) : el.height;
      if (width < 20 || height < 20) throw new OpError('taille trop petite (20 px au moins)');
      if (/Task$|^bpmn:CallActivity$/.test(el.type) || is(el, 'bpmn:Event') || is(el, 'bpmn:Gateway')) throw new OpError('les tâches, événements et passerelles gardent leur taille standard : raccourcissez plutôt le nom');
      modeling.resizeShape(el, { x: el.x, y: el.y, width, height });
      if (is(el, 'bpmn:TextAnnotation')) fitAnnotation(el);
    },

    /**
     * Décale d'un coup tout ce qui est à droite de x (ou de l'élément after) de dx px (négatif = resserrer),
     * ou tout ce qui est sous y de dy px ; les pools et sous-processus traversés s'élargissent ou se resserrent.
     */
    space(op) {
      const horizontal = Number.isFinite(op.dx);
      if (!horizontal && !Number.isFinite(op.dy)) throw new OpError('indiquez dx (décalage horizontal) ou dy (vertical)');
      const ref = op.after ? get(op.after, 'élément de référence') : null;
      const start = horizontal ? (ref ? ref.x + ref.width + 1 : op.x) : (ref ? ref.y + ref.height + 1 : op.y);
      if (!Number.isFinite(start)) throw new OpError(horizontal ? 'indiquez after (élément) ou x' : 'indiquez after (élément) ou y');
      shiftFrom(horizontal ? 'x' : 'y', start, Math.round(horizontal ? op.dx : op.dy), ref ? planeOf(ref) : canvas.getRootElement());
    },

    append(op) {
      const source = get(op.after, 'élément de départ');
      const shape = autoPlace.append(source, newShape(op));
      finish(shape, op);
      placeFree(shape);
      const flow = flowBetween(source, shape);
      if (flow && op.flowName) modeling.updateLabel(flow, op.flowName);
      if (flow && op.condition) modeling.updateProperties(flow, { conditionExpression: expr(op.condition) });
    },

    insert(op) {
      const flow = get(op.flow, 'flux');
      if (!flow.waypoints) throw new OpError(`« ${op.flow} » n'est pas un flux`);
      const shape = newShape(op);
      const { source, target } = flow;
      const gap = target.x - (source.x + source.width);
      const need = shape.width + 100;
      if (gap < need) makeRoom(source.x + source.width + 1, need - gap, planeOf(source));
      const s = flow.source, t = flow.target;
      const mid = { x: (s.x + s.width + t.x) / 2, y: s.y + s.height / 2 };
      const created = modeling.createShape(shape, mid, flow);
      finish(created, op);
      placeFree(created);
    },

    attach(op) {
      const host = get(op.to, 'activité');
      if (!is(host, 'bpmn:Activity')) throw new OpError(`« ${op.to} » n'est pas une activité`);
      const shape = newShape({ ...op, type: 'bpmn:BoundaryEvent' });
      // première place libre sur le bord bas (puis haut) de l'activité, sans recouvrir un autre événement de bordure
      const taken = (host.attachers || []).map(a => ({ x: a.x + a.width / 2, y: a.y + a.height / 2 }));
      const free = (x, y) => taken.every(t => Math.abs(t.x - x) > shape.width + 4 || Math.abs(t.y - y) > shape.height);
      let pos = null;
      for (const y of [host.y + host.height, host.y]) {
        for (let f = 0.25; f <= 0.86 && !pos; f += 0.05) { const x = host.x + host.width * f; if (free(x, y)) pos = { x, y }; }
        if (pos) break;
      }
      if (!pos) pos = { x: host.x + host.width, y: host.y + host.height / 2 };
      const created = modeling.createShape(shape, pos, host, { attach: true });
      finish(created, op);
      if (op.interrupting === false) modeling.updateProperties(created, { cancelActivity: false });
      // l'événement recouvre le bas de la boîte : son nom doit tenir en 4 lignes
      const hostName = getBusinessObject(host).name;
      const o = hostName && labelOverflow(host.type, hostName, { width: host.width, height: host.height, expanded: is(host, 'bpmn:SubProcess') && host.collapsed === false, boundary: true });
      if (o) notes.push(`« ${hostName} » (${host.id}) porte maintenant un événement de bordure : ${overflowText(o)} ${overflowFix(o)}`);
    },

    connect(op) {
      const a = get(op.from, 'source'), b = get(op.to, 'cible');
      const c = modeling.connect(a, b);
      if (!c) throw new OpError('liaison impossible entre ces éléments');
      if (op.ref) refs.set(op.ref, c.id);
      if (Array.isArray(op.via) && op.via.length) routeVia(c, op.via);
      else if (op.route) routeShape(c, op.route);
      else { loopBelowIfBackward(c); improveRoute(c); untanglePair(c); }
      fixGatewayExits(a);
      if (op.name) modeling.updateLabel(c, op.name);
      if (op.condition) modeling.updateProperties(c, { conditionExpression: expr(op.condition) });
    },

    replace(op) {
      const el = get(op.id);
      const target = { type: op.type || el.type };
      if (op.event && op.event !== 'none') target.eventDefinitionType = EVENT_DEFS[op.event];
      if (op.expanded !== undefined) target.isExpanded = !!op.expanded;   // sous-processus : déplier / replier
      const created = bpmnReplace.replaceElement(el, target);
      refs.set(op.id, created.id);
      if (op.name) modeling.updateLabel(created, op.name);
    },

    delete(op) { modeling.removeElements([get(op.id)]); },

    /**
     * Crée un élément sans le relier, à l'intérieur d'un conteneur (sous-processus déplié, pool,
     * couloir) : c'est ainsi qu'on démarre un sous-processus vide. Position : x, y (centre) ou
     * à gauche au milieu du conteneur.
     */
    add(op) {
      const parent = op.in ? get(op.in, 'conteneur') : registry.filter(e => is(e, 'bpmn:Participant') || is(e, 'bpmn:Process') && !e.parent).at(0) || canvas.getRootElement();
      if (is(parent, 'bpmn:SubProcess') && parent.collapsed !== false) throw new OpError(`« ${op.in} » est replié : dépliez-le d'abord (replace avec "expanded": true) ou travaillez dans sa vue détaillée`);
      const pos = Number.isFinite(op.x) && Number.isFinite(op.y) ? { x: op.x, y: op.y }
        : parent.width ? { x: parent.x + (is(parent, 'bpmn:Participant') ? 90 : 60), y: parent.y + parent.height / 2 } : { x: 200, y: 200 };
      const created = modeling.createShape(newShape(op), pos, parent.waypoints ? parent.parent : parent);
      finish(created, op);
      placeFree(created);
    },

    /**
     * Passe de retouche (après une réorganisation, ou à la demande) : une sortie par côté pour chaque
     * passerelle, retours en arrière par-dessous, flux qui traversent des éléments retracés,
     * libellés qui se chevauchent déplacés. Compte rendu dans notes.
     */
    tidy() {
      let exits = 0, flows = 0, notesFixed = 0;
      const allNotes = registry.filter(e => is(e, 'bpmn:TextAnnotation'));
      for (const n of allNotes) if (fitAnnotation(n)) notesFixed++;
      settle();   // avant de resserrer : ce qui était droit et propre doit le rester
      const cols = compactColumns();
      const rows = compactRows();
      settled = new Set([...settled].filter(id => { const c = registry.get(id); return c?.waypoints && bendCount(c.waypoints) === 0; }));
      const seqFlows = () => registry.filter(e => is(e, 'bpmn:SequenceFlow') && e.waypoints);
      const gateways = () => registry.filter(e => is(e, 'bpmn:Gateway') && e.type !== 'label');
      for (const g of gateways()) exits += fixGatewayExits(g);
      const touched = new Set();
      for (const c of seqFlows()) if (untangle(c)) touched.add(c.id);
      // croisements, superpositions, virages évitables : retracer aussi l'autre flux si c'est mieux
      for (const c of seqFlows()) { const i = routeInfo(c); if ((!i.clean || i.bends) && untanglePair(c)) touched.add(c.id); }
      for (const g of gateways()) exits += fixGatewayExits(g);
      flows = touched.size;
      settled = new Set();
      const labels = normalizeLabels(registry.filter(e => e.type === 'label'));
      for (const n of allNotes) if (placeNote(n)) notesFixed++;
      const pools = trimPools();
      const remaining = seqFlows().map(c => [c.id, crossedBy(c)]).filter(([, h]) => h.length);
      const stacked = seqFlows().filter(c => flowConflicts(c).overlap).map(c => c.id);
      const crossing = seqFlows().filter(c => flowConflicts(c).cross).map(c => c.id);
      const clashes = registry.filter(e => e.type === 'label' && e.width && e.labelTarget && labelClashes(e).length).map(l => l.labelTarget.id);
      const badNotes = noteCrossings();
      const hugging = seqFlows().filter(c => bordersHugged(c).length).map(c => `${c.id} (${bordersHugged(c).join(', ')})`);
      notes.push(`Retouches : ${cols ? `${cols} px de colonnes vides resserrés, ` : ''}${pools ? `${pools} pool(s) ajusté(s), ` : ''}${rows} élément(s) remonté(s), ${exits} sortie(s) de passerelle séparée(s), ${flows} flux retracé(s), ${labels} libellé(s) replacé(s), ${notesFixed} commentaire(s) ajusté(s).`
        + (remaining.length ? ` Flux qui traversent encore un élément : ${remaining.map(([id, h]) => `${id} (${h.join(', ')})`).join(' ; ')}.` : ' Plus aucun flux ne traverse un élément.')
        + (hugging.length ? ` Flux qui longent encore le bord d'un élément : ${hugging.join(' ; ')}.` : '')
        + (stacked.length ? ` Flux encore superposés à un autre : ${stacked.join(', ')}.` : '')
        + (crossing.length ? ` Flux qui en croisent encore un autre : ${crossing.join(', ')} (déplacer une branche peut les supprimer).` : '')
        + (clashes.length ? ` Libellés encore en chevauchement : ${clashes.join(', ')}.` : '')
        + (badNotes.length ? ` Commentaires mal placés : ${badNotes.join(', ')}.` : ''));
    },

    /** Retrace un flux existant : forme du tracé (route) ou points de passage (via). */
    reroute(op) {
      const c = get(op.id);
      if (!c.waypoints) throw new OpError(`« ${op.id} » n'est pas un flux`);
      const before = c.waypoints.map(p => ({ x: p.x, y: p.y }));
      if (Array.isArray(op.via) && op.via.length) routeVia(c, op.via);
      else if (op.route) routeShape(c, op.route);
      else if (op.side) {
        if (!['top', 'bottom', 'left', 'right'].includes(op.side)) throw new OpError(`côté « ${op.side} » inconnu (top, bottom, left, right)`);
        routeVia(c, viaFromSide(c, op.side));
      } else throw new OpError('indiquez route (h:v, v:h, h:h, v:v), side (côté de départ) ou via (points de passage)');
      // une sortie de passerelle ne doit pas partager son côté avec une autre
      if (is(c.source, 'bpmn:Gateway')) {
        const clash = (c.source.outgoing || []).find(o => o !== c && o.waypoints?.length && exitSide(o) === exitSide(c));
        if (clash) throw new OpError(`ce tracé part du même côté (${exitSide(c)}) que ${clash.id} : choisissez un autre côté de la passerelle (side)`);
      }
      if (sameWaypoints(before, c.waypoints)) throw new OpError('le tracé obtenu est identique à l\'actuel : donnez d\'autres points de passage ou un autre côté');
    },

    /**
     * Déplace un élément : à côté d'un autre (next_to + side), à une position (x, y = centre), ou d'un
     * décalage (dx, dy). Les flux suivent ; si la place est prise, l'élément glisse à la place libre la plus proche.
     */
    move(op) {
      const owner = get(op.id);
      if (op.label) {
        // déplacer le libellé d'un élément ou d'un flux (décalage dx/dy uniquement)
        const lbl = owner.label;
        if (!lbl) throw new OpError(`« ${op.id} » n'a pas de libellé à déplacer`);
        if (!Number.isFinite(op.dx) && !Number.isFinite(op.dy)) throw new OpError('pour un libellé, indiquez dx et/ou dy');
        modeling.moveShape(lbl, { x: Math.round(op.dx || 0), y: Math.round(op.dy || 0) });
        return;
      }
      const el = owner;
      if (el.waypoints) throw new OpError(`« ${op.id} » est un flux : utilisez reroute, ou label:true pour déplacer son libellé`);
      if (is(el, 'bpmn:BoundaryEvent')) throw new OpError('un événement de bordure suit son activité : déplacez l\'activité');
      const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
      let tx, ty;
      if (op.next_to) {
        const ref = get(op.next_to, 'élément de référence');
        const gap = Number.isFinite(op.gap) ? op.gap : 50;
        const rcx = ref.x + ref.width / 2, rcy = ref.y + ref.height / 2;
        const side = op.side || 'right';
        if (side === 'right') { tx = ref.x + ref.width + gap + el.width / 2; ty = rcy; }
        else if (side === 'left') { tx = ref.x - gap - el.width / 2; ty = rcy; }
        else if (side === 'below') { tx = rcx; ty = ref.y + ref.height + gap + el.height / 2; }
        else if (side === 'above') { tx = rcx; ty = ref.y - gap - el.height / 2; }
        else throw new OpError(`côté « ${side} » inconnu (right, left, below, above)`);
      } else if (Number.isFinite(op.x) && Number.isFinite(op.y)) { tx = op.x; ty = op.y; }
      else if (Number.isFinite(op.dx) || Number.isFinite(op.dy)) { tx = cx + (op.dx || 0); ty = cy + (op.dy || 0); }
      else throw new OpError('indiquez next_to (+ side), ou x et y, ou dx/dy');
      const delta = { x: Math.round(tx - cx), y: Math.round(ty - cy) };
      if (delta.x || delta.y) modeling.moveElements([el], delta); // moveElements : le libellé suit
      if (op.avoid_overlap !== false) placeFree(el);
      afterMove(el);
    },

    set_timer(op) { setTimer(get(op.id), op.kind, op.value); },

    set_interrupting(op) {
      const el = get(op.id);
      if (is(el, 'bpmn:BoundaryEvent')) modeling.updateProperties(el, { cancelActivity: !!op.value });
      else if (is(el, 'bpmn:StartEvent')) modeling.updateProperties(el, { isInterrupting: !!op.value });
      else throw new OpError(`« ${op.id} » n'est ni un événement de bordure ni un début d'événementiel`);
    },

    set_condition(op) {
      const f = get(op.id, 'flux');
      modeling.updateProperties(f, { conditionExpression: op.expression ? expr(op.expression) : undefined });
    },

    set_default(op) {
      const g = get(op.gateway, 'passerelle'), f = get(op.flow, 'flux');
      if (f.source !== g) throw new OpError('le flux ne part pas de cette passerelle');
      modeling.updateProperties(g, { default: f.businessObject });
    }
  };

  for (const [opName, [defType, prop, rootType, codeProp]] of Object.entries(REF_DEFS)) {
    OPS[opName] = op => {
      const el = get(op.id);
      const def = (getBusinessObject(el).eventDefinitions || []).find(d => is(d, defType));
      if (!def) throw new OpError(`« ${op.id} » n'a pas de définition ${defType.replace('bpmn:', '')}`);
      const definitions = modeler.getDefinitions();
      const roots = definitions.rootElements || [];
      let ref = roots.find(r => is(r, rootType) && r.name === op.name);
      if (!ref) {
        ref = bpmnFactory.create(rootType, { name: op.name });
        if (codeProp && op.code) ref[codeProp] = op.code;
        ref.$parent = definitions;
        modeling.updateModdleProperties(el, definitions, { rootElements: [...roots, ref] });
      }
      modeling.updateModdleProperties(el, def, { [prop]: ref });
    };
  }

  const ids = () => new Set(registry.filter(e => e.type !== 'label').map(e => e.id));

  // Conteneurs (sous-processus dépliés, pools) : s'ils grandissent, on écarte ce qui les entoure.
  const isContainer = e => !e.waypoints && e.type !== 'label' && e.children?.some(c => c.type !== 'label') && (is(e, 'bpmn:SubProcess') || is(e, 'bpmn:Participant'));
  const snapshot = () => new Map(registry.filter(isContainer).map(e => [e.id, { width: e.width, height: e.height }]));
  const isInside = (el, container) => { for (let p = el.parent; p; p = p.parent) if (p === container) return true; return false; };

  /** Un conteneur qui a GRANDI (pas seulement bougé) écarte ce qui l'entoure, depuis son ancien bord. */
  function pushAround(before) {
    for (const [id, b] of before) {
      const c = registry.get(id);
      if (!c || !c.parent) continue;
      const dy = c.height - b.height, dx = c.width - b.width;
      const oldBottom = c.y + b.height, oldRight = c.x + b.width;
      const neighbours = registry.filter(e => e !== c && e.type !== 'label' && !e.waypoints && e.parent && !isInside(e, c) && planeOf(e) === planeOf(c));
      if (dy > 0) {
        const { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(neighbours, 'y', dy, oldBottom - 1);
        const moving = movingShapes.filter(e => !isInside(e, c) && e !== c);
        if (moving.length) carryFlowLabels(moving, { x: 0, y: dy }, () => modeling.createSpace(moving, resizingShapes.filter(e => e !== c), { x: 0, y: dy }, 's', oldBottom - 1));
      }
      if (dx > 0) {
        const { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(neighbours, 'x', dx, oldRight - 1);
        const moving = movingShapes.filter(e => !isInside(e, c) && e !== c);
        if (moving.length) carryFlowLabels(moving, { x: dx, y: 0 }, () => modeling.createSpace(moving, resizingShapes.filter(e => e !== c), { x: dx, y: 0 }, 'e', oldRight - 1));
      }
    }
  }

  /**
   * Applique une modification complète. En cas d'erreur, tout ce qu'elle a fait est annulé.
   * Renvoie { ok, added, changed, error, mark } ; mark permet d'annuler plus tard (refus).
   */
  let notes = [];
  function apply(change) {
    notes = [];
    const mark = commandStack._stackIdx;
    const before = ids();
    const touched = new Set();
    try {
      if (!Array.isArray(change.ops) || !change.ops.length) throw new OpError('aucune opération');
      for (const op of change.ops) {
        const fn = OPS[op?.op];
        if (!fn) throw new OpError(`opération « ${op?.op} » inconnue`);
        for (const k of ['id', 'after', 'to', 'from', 'flow', 'gateway', 'next_to']) if (op[k] && before.has(refs.get(op[k]) || op[k])) touched.add(refs.get(op[k]) || op[k]);
        const containers = snapshot();
        fn(op);
        pushAround(containers);
      }
    } catch (e) {
      undoTo(mark);
      return { ok: false, error: e instanceof OpError ? e.message : `erreur de l'éditeur (${e.message})` };
    }
    const after = ids();
    const added = [...after].filter(id => !before.has(id));
    try {
      const fresh = added.map(id => registry.get(id)).filter(Boolean);
      for (const n of fresh.filter(e => is(e, 'bpmn:TextAnnotation'))) { fitAnnotation(n, { widen: true }); placeNote(n); }
      normalizeLabels(fresh.map(e => e.label).filter(Boolean));
      if (change.ops.some(o => LAYOUT_OPS.has(o.op))) {
        const plane = canvas.getRootElement();
        const drifted = registry.filter(l => l.type === 'label' && l.width && l.labelTarget && planeOf(l) === plane && (labelFar(l) || labelClashes(l).length));
        normalizeLabels(drifted);
      }
    } catch (e) { console.warn('mise en forme des ajouts', e); }
    const changed = [...touched].filter(id => after.has(id) && registry.get(id));
    // compte rendu de placement : un élément ajouté ou déplacé qui en recouvre encore un autre
    const overlaps = [];
    for (const id of [...added, ...changed]) { const el = registry.get(id); const o = el ? overlapsOf(el) : []; if (o.length) overlaps.push(`${id} recouvre ${o.join(', ')}`); }
    // éléments créés, les flux avec leur origine et leur destination (pour les cibler ensuite)
    const addedInfo = added.map(id => {
      const el = registry.get(id);
      return el?.waypoints ? `${id} (${el.source?.id} → ${el.target?.id})` : id;
    });
    return { ok: true, added, addedInfo, changed, mark, overlaps, notes };
  }

  function undoTo(mark) {
    while (commandStack._stackIdx > mark && commandStack.canUndo()) commandStack.undo();
  }

  const focuser = createFocus(modeler);
  const focus = ids => focuser.show(ids.map(id => refs.get(id) || id), { maxZoom: 1.4, pad: 160 });

  // diagnostic (tests) : coût détaillé d'un tracé
  if (typeof window !== 'undefined') window.__aiRoute = id => { const c = registry.get(id); const i = routeInfo(c); return { ...i, with: [...i.with], hits: crossedBy(c), hugs: bordersHugged(c), tips: offTips(c), fc: (({ overlap, cross }) => ({ overlap, cross }))(flowConflicts(c)), pts: c.waypoints.map(p => [p.x, p.y]) }; };
  return { apply, undoTo, focus, resolve: id => refs.get(id) || id, reset: () => refs.clear() };
}

