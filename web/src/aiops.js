// Applique les opérations demandées par Claude (connecteur MCP) avec les services bpmn-js : chaque opération est une
// commande annulable, et la mise en page des nouveaux éléments est calculée par l'éditeur
// (placement automatique, insertion sur un flux), pas par Claude.
import { is, getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';
import { createFocus } from './focus.js';
import { labelOverflow, overflowText, overflowFix } from '../../shared/labelfit.js';

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

  /** Essaie des tracés alternatifs pour un flux qui traverse des éléments ; garde le premier sans traversée. */
  function untangle(c) {
    if (!crossedBy(c).length) return false;
    const keep = c.waypoints.map(p => ({ x: p.x, y: p.y }));
    const tries = [() => loopBelowIfBackward(c), ...LAYOUTS.map(r => () => routeShape(c, r)),
      ...['right', 'bottom', 'top', 'left'].map(sd => () => routeVia(c, viaFromSide(c, sd)))];
    for (const t of tries) {
      try { t(); } catch { continue; }
      const sideClash = is(c.source, 'bpmn:Gateway') && (c.source.outgoing || []).some(o => o !== c && o.waypoints?.length && exitSide(o) === exitSide(c));
      if (!crossedBy(c).length && !sideClash) return true;
    }
    modeling.updateWaypoints(c, keep);
    return false;
  }

  // ---------- libellés qui se chevauchent ----------
  function labelClashes(lbl) {
    const r = inflate(boxOf(lbl), 1);
    const owner = lbl.labelTarget;
    return registry.getAll().filter(e => e !== lbl && e !== owner && e.parent && Number.isFinite(e.width) && !e.waypoints
      && !isContainerShape(e) && !is(e, 'bpmn:Collaboration') && !is(e, 'bpmn:Process') && e !== owner?.host
      && hit(r, boxOf(e)));
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
    for (const p of cands) {
      modeling.moveShape(lbl, { x: Math.round(p.x - lbl.x), y: Math.round(p.y - lbl.y) });
      if (!labelClashes(lbl).length) return true;
    }
    modeling.moveShape(lbl, { x: ox - lbl.x, y: oy - lbl.y });
    return false;
  }

  // ---------- sorties de passerelle : une flèche par côté ----------
  /** Côté par lequel un flux quitte sa source : top, bottom, left, right. */
  function exitSide(c) {
    const s = c.source, p = c.waypoints[0];
    const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
    const dx = p.x - cx, dy = p.y - cy;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) { const q = c.waypoints[1] || p; return Math.abs(q.x - cx) > Math.abs(q.y - cy) ? (q.x > cx ? 'right' : 'left') : (q.y > cy ? 'bottom' : 'top'); }
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
      list.sort((a, b) => score(a) - score(b));
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
  function loopBelowIfBackward(c) {
    if (!is(c, 'bpmn:SequenceFlow')) return;
    const s = c.source, t = c.target;
    if (!(t.x + t.width < s.x)) return;
    const parent = c.parent;
    const between = registry.filter(e => e.parent === parent && !e.waypoints && e.type !== 'label' && !isContainerShape(e)
      && e !== s && e !== t && e.x < s.x + s.width && e.x + e.width > t.x);
    const labelsBelow = registry.filter(e => e.type === 'label' && e.labelTarget && between.includes(e.labelTarget));
    const attLabels = registry.filter(e => e.type === 'label' && e.labelTarget?.host && between.includes(e.labelTarget.host));
    const area = parent && isContainerShape(parent) ? parent : null;
    const all = [...between, ...labelsBelow, ...attLabels];
    const obstacles = [...between, ...registry.filter(e => e.type === 'label' && e.width && (e.labelTarget?.parent === parent || e.labelTarget?.host?.parent === parent))]
      .filter(e => e !== s && e !== t && e.labelTarget !== s && e.labelTarget !== t);
    // sous les éléments enjambés, sinon au-dessus ; sortie et arrivée à l'écart des événements de
    // bordure, sans que la descente (ou la montée) traverse quoi que ce soit
    for (const side of ['below', 'above']) {
      let y = side === 'below'
        ? Math.max(s.y + s.height, t.y + t.height, ...all.map(e => e.y + e.height)) + 25
        : Math.min(s.y, t.y, ...all.map(e => e.y)) - 25;
      if (area) y = Math.max(area.y + 30, Math.min(y, area.y + area.height - 12));
      const pick = el => {
        const edge = side === 'below' ? el.y + el.height : el.y;
        const onEdge = (el.attachers || []).filter(a => Math.abs(a.y + a.height / 2 - edge) < 4);
        const cands = [];
        for (let f = 0.5, k = 0; k < 17; k++) { cands.push(Math.round(el.x + el.width * f)); f = 0.5 + (k % 2 ? 1 : -1) * Math.ceil((k + 1) / 2) * 0.05; }
        const clear = x => x > el.x + 4 && x < el.x + el.width - 4
          && onEdge.every(a => Math.abs(a.x + a.width / 2 - x) > a.width / 2 + 8)
          && !obstacles.some(o => segmentHits({ x, y: edge + (side === 'below' ? 1 : -1) }, { x, y }, inflate(boxOf(o), 4)));
        return cands.find(clear);
      };
      const sx = pick(s), tx = pick(t);
      if (sx == null || tx == null) continue;
      if (obstacles.some(o => segmentHits({ x: sx, y }, { x: tx, y }, inflate(boxOf(o), 2)))) continue;
      routeVia(c, [{ x: sx, y }, { x: tx, y }]);
      return;
    }
    // aucune route libre : on garde le tracé automatique (Claude peut le reprendre avec reroute)
  }

  /** Trace un flux par des points de passage (coudes), extrémités calées sur le bord des éléments. */
  function routeVia(c, via) {
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
    const cropped = docking.getCroppedWaypoints({ ...c, waypoints: raw }, c.source, c.target);
    modeling.updateWaypoints(c, cropped);
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
    const o = labelOverflow(el.type, name, { width: el.width, height: el.height, expanded: is(el, 'bpmn:SubProcess') && el.collapsed === false });
    if (o) throw new OpError(`« ${name} » : ${overflowText(o)} ${overflowFix(o)}`);
  }

  function finish(shape, op) {
    if (op.ref) refs.set(op.ref, shape.id);
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
  function makeRoom(x, width) {
    // libellés compris : sinon ceux des flux restent en place quand tout le reste se décale
    const elements = registry.filter(e => e.parent && !e.waypoints);
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
    if (movingShapes.length || resizingShapes.length) modeling.createSpace(movingShapes, resizingShapes, { x: width, y: 0 }, 'e', x);
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

  function segmentHits(p, q, r) {
    const len = Math.hypot(q.x - p.x, q.y - p.y), n = Math.max(1, Math.ceil(len / 6));
    for (let i = 0; i <= n; i++) {
      const x = p.x + (q.x - p.x) * i / n, y = p.y + (q.y - p.y) * i / n;
      if (x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height) return true;
    }
    return false;
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

  const OPS = {
    update(op) {
      const el = get(op.id);
      if (op.name !== undefined) { checkFits(el, op.name); modeling.updateLabel(el, op.name); }
      if (op.documentation !== undefined) setDoc(el, op.documentation);
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
      if (gap < need) makeRoom(source.x + source.width + 1, need - gap);
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
    },

    connect(op) {
      const a = get(op.from, 'source'), b = get(op.to, 'cible');
      const c = modeling.connect(a, b);
      if (!c) throw new OpError('liaison impossible entre ces éléments');
      if (op.ref) refs.set(op.ref, c.id);
      if (Array.isArray(op.via) && op.via.length) routeVia(c, op.via);
      else if (op.route) routeShape(c, op.route);
      else loopBelowIfBackward(c);
      fixGatewayExits(a);
      if (op.name) modeling.updateLabel(c, op.name);
      if (op.condition) modeling.updateProperties(c, { conditionExpression: expr(op.condition) });
    },

    replace(op) {
      const el = get(op.id);
      const target = { type: op.type || el.type };
      if (op.event && op.event !== 'none') target.eventDefinitionType = EVENT_DEFS[op.event];
      const created = bpmnReplace.replaceElement(el, target);
      refs.set(op.id, created.id);
      if (op.name) modeling.updateLabel(created, op.name);
    },

    delete(op) { modeling.removeElements([get(op.id)]); },

    /**
     * Passe de retouche (après une réorganisation, ou à la demande) : une sortie par côté pour chaque
     * passerelle, retours en arrière par-dessous, flux qui traversent des éléments retracés,
     * libellés qui se chevauchent déplacés. Compte rendu dans notes.
     */
    tidy() {
      let exits = 0, flows = 0, labels = 0;
      for (const g of registry.filter(e => is(e, 'bpmn:Gateway') && e.type !== 'label')) exits += fixGatewayExits(g);
      for (const c of registry.filter(e => is(e, 'bpmn:SequenceFlow'))) if (untangle(c)) flows++;
      for (const g of registry.filter(e => is(e, 'bpmn:Gateway') && e.type !== 'label')) exits += fixGatewayExits(g);
      for (const l of registry.filter(e => e.type === 'label' && e.width && e.labelTarget)) if (freeLabel(l)) labels++;
      const remaining = registry.filter(e => is(e, 'bpmn:SequenceFlow')).map(c => [c.id, crossedBy(c)]).filter(([, h]) => h.length);
      const clashes = registry.filter(e => e.type === 'label' && e.width && e.labelTarget && labelClashes(e).length).map(l => l.labelTarget.id);
      notes.push(`Retouches : ${exits} sortie(s) de passerelle séparée(s), ${flows} flux retracé(s), ${labels} libellé(s) déplacé(s).`
        + (remaining.length ? ` Flux qui traversent encore un élément : ${remaining.map(([id, h]) => `${id} (${h.join(', ')})`).join(' ; ')}.` : ' Plus aucun flux ne traverse un élément.')
        + (clashes.length ? ` Libellés encore en chevauchement : ${clashes.join(', ')}.` : ''));
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
  const snapshot = () => new Map(registry.filter(isContainer).map(e => [e.id, { bottom: e.y + e.height, right: e.x + e.width }]));
  const isInside = (el, container) => { for (let p = el.parent; p; p = p.parent) if (p === container) return true; return false; };

  function pushAround(before) {
    for (const [id, b] of before) {
      const c = registry.get(id);
      if (!c || !c.parent) continue;
      const dy = c.y + c.height - b.bottom, dx = c.x + c.width - b.right;
      const neighbours = registry.filter(e => e !== c && e.type !== 'label' && !e.waypoints && e.parent && !isInside(e, c));
      if (dy > 0) {
        const { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(neighbours, 'y', dy, b.bottom - 1);
        const moving = movingShapes.filter(e => !isInside(e, c) && e !== c);
        if (moving.length) modeling.createSpace(moving, resizingShapes.filter(e => e !== c), { x: 0, y: dy }, 's', b.bottom - 1);
      }
      if (dx > 0) {
        const { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(neighbours, 'x', dx, b.right - 1);
        const moving = movingShapes.filter(e => !isInside(e, c) && e !== c);
        if (moving.length) modeling.createSpace(moving, resizingShapes.filter(e => e !== c), { x: dx, y: 0 }, 'e', b.right - 1);
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

  return { apply, undoTo, focus, resolve: id => refs.get(id) || id, reset: () => refs.clear() };
}

