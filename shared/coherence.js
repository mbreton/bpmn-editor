// Contrôles de cohérence du workflow, sur le modèle bpmn-moddle (navigateur et serveur).
// Niveaux : error = cassé ou ambigu (une modification de Claude qui en ajoute est refusée),
// warn = incomplet ou douteux (signalé, accepté : un diagramme en construction en a forcément),
// info = remarque.
import { TYPE_LABELS, explainIso } from './i18n.js';
import { labelOverflow, overflowText, overflowFix } from './labelfit.js';

const is = (bo, type) => !!bo && (bo.$instanceOf ? bo.$instanceOf(type) : bo.$type === type);
const typeLabel = bo => TYPE_LABELS[bo?.$type] || String(bo?.$type || '').replace('bpmn:', '');
export const nameOf = bo => bo?.name || typeLabel(bo) || bo?.id || '';

const REF_KINDS = {
  'bpmn:ErrorEventDefinition': { prop: 'errorRef', label: 'erreur' },
  'bpmn:MessageEventDefinition': { prop: 'messageRef', label: 'message' },
  'bpmn:SignalEventDefinition': { prop: 'signalRef', label: 'signal' },
  'bpmn:EscalationEventDefinition': { prop: 'escalationRef', label: 'escalade' }
};
const CRON = /^(\S+\s+){4,6}\S+$/;
const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

/** Comment corriger, par type de problème (affiché sous le problème, et renvoyé à Claude). */
export const FIXES = {
  'flow-ends': 'Supprimez ce flux et retracez-le entre les deux bons éléments.',
  unreachable: 'Tracez une flèche depuis l\'étape qui doit le précéder (survolez-la puis glissez la flèche de sa barre d\'outils), ou supprimez-le s\'il ne sert plus.',
  'implicit-end': 'Indiquez ce qui se passe ensuite : reliez-le à l\'étape suivante, ou ajoutez un événement de fin (cercle épais) pour dire que le parcours se termine là.',
  conditions: 'Cliquez sur chaque flèche qui sort de la passerelle et saisissez sa condition, ou cochez « flux par défaut » sur celle à suivre quand aucune condition n\'est vraie.',
  'default-flow': 'Choisissez à nouveau le flux par défaut parmi les flèches qui sortent de cette passerelle.',
  'event-gateway': 'Après une passerelle basée sur les événements, chaque flèche doit mener à une attente (délai, message, signal…) : remplacez la cible par un événement intermédiaire d\'attente.',
  boundary: 'Posez l\'événement sur le bord d\'une tâche ou d\'un sous-processus et donnez-lui un déclencheur (délai, erreur, message…).',
  timer: 'Dans le champ Délai : une durée (P15D = 15 jours, PT4H = 4 heures), une date (2026-12-01T09:00:00Z) ou un cycle (R3/P1D = 3 fois, tous les jours).',
  refs: 'Facultatif : donnez un nom au message / à l\'erreur dans les propriétés, pour savoir précisément lequel est attendu.',
  conditional: 'Saisissez la condition qui déclenche l\'événement.',
  start: 'Ajoutez un événement de début (cercle fin) au point de départ du processus.',
  'label-too-long': '',
  'flow-crosses': 'Retracez le flux pour qu\'il contourne l\'élément (glissez un de ses coudes), ou déplacez l\'élément. Claude : opération reroute, ou tidy.',
  'gateway-exits': 'Faites partir chaque flèche d\'un côté différent de la passerelle (glissez le départ de la flèche sur un autre coin). Claude : reroute avec side.',
  'flow-overlap': 'Faites passer l\'une des deux flèches par un couloir libre (au-dessus ou au-dessous), quitte à rallonger un peu. Claude : reroute, ou tidy.',
  'flow-cross': 'Déplacez la branche concernée (ou retracez l\'autre flèche) pour que les deux traits ne se coupent plus. Claude : move sur un élément de la branche, reroute, ou tidy.',
  'association-crosses': 'Placez le commentaire près de son élément, à un endroit d\'où son pointillé ne traverse ni boîte ni flèche. Claude : tidy, ou move sur le commentaire.',
  'label-overlap': 'Déplacez le libellé à la souris (cliquez dessus puis glissez). Claude : move avec label:true, ou tidy.'
};

/** Délai lisible ? Renvoie un message d'erreur, ou null si correct. */
export function timerProblem(kind, raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^[$#]\{.+\}$/.test(v)) return null;
  if (kind === 'timeCycle' && CRON.test(v)) return null;
  if (!explainIso(v)) return `« ${v} » n'est pas un ${kind === 'timeDate' ? 'date ISO 8601 (ex. 2026-12-01T09:00:00Z)' : kind === 'timeCycle' ? 'cycle ISO 8601 (ex. R3/P1D) ni une expression cron' : 'durée ISO 8601 (ex. P2D, PT4H)'}.`;
  if (kind === 'timeDuration' && /^R/.test(v)) return `« ${v} » est une répétition : utilisez un cycle (timeCycle), pas une durée.`;
  if (kind === 'timeCycle' && !/^R/.test(v)) return `« ${v} » n'est pas un cycle : ajoutez la répétition (ex. R3/${v}) ou utilisez une durée.`;
  return null;
}

export function checkCoherence(definitions) {
  const out = [];
  const add = (bo, level, text, rule) => out.push({ id: bo?.id, name: nameOf(bo), level, text, rule, fix: FIXES[rule] || '' });
  const processes = (definitions.rootElements || []).filter(r => is(r, 'bpmn:Process'));
  // tailles dessinées (pour savoir si le nom tient dans la boîte)
  const shapes = new Map();
  for (const d of definitions.diagrams || []) for (const pe of d.plane?.planeElement || []) if (pe.bounds && pe.bpmnElement) shapes.set(pe.bpmnElement.id, pe);
  // activités qui portent un événement de bordure (leur texte a une ligne de moins)
  const hosts = new Set([...shapes.values()].map(pe => pe.bpmnElement).filter(e => is(e, 'bpmn:BoundaryEvent') && e.attachedToRef).map(e => e.attachedToRef.id));

  const walk = container => {
    const elements = container.flowElements || [];
    const nodes = elements.filter(e => is(e, 'bpmn:FlowNode'));
    // flux entrants/sortants recalculés depuis les flux (un XML écrit à la main n'a pas toujours <incoming>/<outgoing>)
    const outOf = new Map(), into = new Map();
    for (const f of elements.filter(e => is(e, 'bpmn:SequenceFlow'))) {
      if (!f.sourceRef || !f.targetRef) { add(f, 'error', 'flux sans origine ou sans destination.', 'flow-ends'); continue; }
      (outOf.get(f.sourceRef) || outOf.set(f.sourceRef, []).get(f.sourceRef)).push(f);
      (into.get(f.targetRef) || into.set(f.targetRef, []).get(f.targetRef)).push(f);
    }
    for (const e of nodes) {
      const inEventSub = container.triggeredByEvent;
      const outs = outOf.get(e) || [];
      const incoming = (into.get(e) || []).length;
      const outgoing = outs.length;
      const defs = e.eventDefinitions || [];
      const isComp = e.isForCompensation || (is(e, 'bpmn:BoundaryEvent') && defs.some(d => is(d, 'bpmn:CompensateEventDefinition')));
      const isLink = t => is(e, t) && defs.some(d => is(d, 'bpmn:LinkEventDefinition'));
      if (!incoming && !is(e, 'bpmn:StartEvent') && !is(e, 'bpmn:BoundaryEvent') && !isComp && !e.triggeredByEvent && !isLink('bpmn:IntermediateCatchEvent')) {
        add(e, 'warn', 'aucun flux entrant : il ne sera jamais atteint.', 'unreachable');
      }
      if (!outgoing && !is(e, 'bpmn:EndEvent') && !isComp && !e.triggeredByEvent && !isLink('bpmn:IntermediateThrowEvent')) {
        add(e, 'warn', 'aucun flux sortant : le parcours s\'arrête ici sans fin explicite.', 'implicit-end');
      }
      if ((is(e, 'bpmn:ExclusiveGateway') || is(e, 'bpmn:InclusiveGateway')) && outgoing > 1) {
        const loose = outs.filter(f => !f.conditionExpression?.body?.trim() && e.default !== f);
        if (loose.length) add(e, 'error', `${loose.length} flux sortant(s) sans condition ni flux par défaut : on ne sait pas quel chemin prendre.`, 'conditions');
      }
      if (e.default && !outs.includes(e.default)) add(e, 'error', 'le flux par défaut ne part pas de cet élément.', 'default-flow');
      if (is(e, 'bpmn:EventBasedGateway')) {
        const bad = outs.filter(f => f.targetRef && !is(f.targetRef, 'bpmn:IntermediateCatchEvent') && !is(f.targetRef, 'bpmn:ReceiveTask'));
        if (bad.length) add(e, 'error', 'chaque sortie doit mener à un événement d\'attente (délai, message…) ou une tâche de réception.', 'event-gateway');
        if (outgoing < 2) add(e, 'warn', 'une passerelle événementielle sert à attendre plusieurs événements : il lui faut au moins deux sorties.', 'event-gateway');
      }
      if (is(e, 'bpmn:BoundaryEvent')) {
        if (!e.attachedToRef) add(e, 'error', 'événement de bordure attaché à aucune activité.', 'boundary');
        else if (!is(e.attachedToRef, 'bpmn:Activity')) add(e, 'error', 'un événement de bordure ne peut être attaché qu\'à une tâche ou un sous-processus.', 'boundary');
        if (!defs.length) add(e, 'error', 'événement de bordure sans déclencheur (délai, erreur, message…).', 'boundary');
      }
      for (const d of defs) {
        if (is(d, 'bpmn:TimerEventDefinition')) {
          const kinds = ['timeDuration', 'timeDate', 'timeCycle'].filter(k => d[k]?.body?.trim());
          if (!kinds.length) add(e, 'warn', 'délai sans valeur.', 'timer');
          for (const k of kinds) { const p = timerProblem(k, d[k].body); if (p) add(e, 'error', `délai invalide : ${p}`, 'timer'); }
        }
        const rk = REF_KINDS[d.$type];
        if (rk && !d[rk.prop] && !is(e, 'bpmn:EndEvent') && !(is(e, 'bpmn:StartEvent') && inEventSub && rk.prop === 'errorRef')) add(e, 'info', `${rk.label} non référencé(e).`, 'refs');
        if (is(d, 'bpmn:ErrorEventDefinition') && is(e, 'bpmn:BoundaryEvent') && e.cancelActivity === false) add(e, 'error', 'un événement d\'erreur de bordure est toujours interrompant.', 'boundary');
        if (is(d, 'bpmn:ConditionalEventDefinition') && !d.condition?.body?.trim()) add(e, 'warn', 'événement conditionnel sans condition.', 'conditional');
      }
      if (e.name) {
        const pe = shapes.get(e.id);
        const o = labelOverflow(e.$type, e.name, { width: pe?.bounds?.width, height: pe?.bounds?.height, expanded: !!pe?.isExpanded, boundary: hosts.has(e.id) });
        if (o) out.push({ id: e.id, name: nameOf(e), level: 'warn', text: overflowText(o), rule: 'label-too-long', fix: overflowFix(o) });
      }
      if (e.flowElements) walk(e);
    }
    return nodes;
  };

  for (const p of processes) {
    const nodes = walk(p);
    if (nodes.length && !nodes.some(n => is(n, 'bpmn:StartEvent'))) add(p, 'warn', 'aucun événement de début.', 'start');
  }
  out.push(...geometryIssues(definitions));
  return sortIssues(out);
}

/**
 * Lisibilité du dessin (à partir des coordonnées) : flux qui traversent un élément, sorties de
 * passerelle qui partent du même côté, libellés qui recouvrent un élément ou un autre libellé.
 */
export function geometryIssues(definitions) {
  const out = [];
  const shapes = [], edges = [], labels = [];
  for (const d of definitions.diagrams || []) for (const pe of d.plane?.planeElement || []) {
    const el = pe.bpmnElement; if (!el) continue;
    if (pe.waypoint?.length) edges.push({ el, pts: pe.waypoint.map(p => ({ x: p.x, y: p.y })) });
    else if (pe.bounds) shapes.push({ el, b: pe.bounds, expanded: !!pe.isExpanded });
    if (pe.label?.bounds && el.name) labels.push({ el, b: pe.label.bounds });
  }
  const byId = new Map(shapes.map(s => [s.el.id, s]));
  const hitPt = (b, p, m = 0) => p.x > b.x + m && p.x < b.x + b.width - m && p.y > b.y + m && p.y < b.y + b.height - m;
  const segHits = (p, q, b) => { const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 5)); for (let i = 0; i <= n; i++) if (hitPt(b, { x: p.x + (q.x - p.x) * i / n, y: p.y + (q.y - p.y) * i / n }, 3)) return true; return false; };
  const isContainer = s => is(s.el, 'bpmn:Participant') || is(s.el, 'bpmn:Lane') || (is(s.el, 'bpmn:SubProcess') && s.expanded);
  const contains = (b, p) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  const ignorable = s => is(s.el, 'bpmn:TextAnnotation') || is(s.el, 'bpmn:Group');

  // flux qui traversent un élément
  for (const { el, pts } of edges) {
    if (!is(el, 'bpmn:SequenceFlow') && !is(el, 'bpmn:MessageFlow')) continue;
    const src = el.sourceRef, tgt = el.targetRef;
    const ends = new Set([src, tgt, src?.attachedToRef, tgt?.attachedToRef].filter(Boolean).map(e => e.id));
    for (const s of shapes) {
      if (ends.has(s.el.id) || ignorable(s)) continue;
      if (is(s.el, 'bpmn:BoundaryEvent') && (ends.has(s.el.attachedToRef?.id))) continue;
      if (isContainer(s)) { if (is(s.el, 'bpmn:Participant') || is(s.el, 'bpmn:Lane') || (contains(s.b, pts[0]) && contains(s.b, pts.at(-1))) || el.$type === 'bpmn:MessageFlow') continue; }
      let crossed = false;
      for (let i = 1; i < pts.length && !crossed; i++) crossed = segHits(pts[i - 1], pts[i], s.b);
      if (crossed) out.push({ id: el.id, name: nameOf(el) || `${nameOf(src)} → ${nameOf(tgt)}`, level: 'warn', text: `le flux traverse « ${nameOf(s.el)} » (${s.el.id}).`, rule: 'flow-crosses', fix: FIXES['flow-crosses'] });
    }
  }

  // flux superposés à un autre flux (même ligne) : on ne voit plus lequel va où
  const segs = pts => pts.slice(1).map((q, i) => [pts[i], q]);
  const hz = ([p, q]) => Math.abs(p.y - q.y) < 1, vt = ([p, q]) => Math.abs(p.x - q.x) < 1;
  const olen = (a, b) => {
    if (hz(a) && hz(b) && Math.abs(a[0].y - b[0].y) < 4) return Math.max(0, Math.min(Math.max(a[0].x, a[1].x), Math.max(b[0].x, b[1].x)) - Math.max(Math.min(a[0].x, a[1].x), Math.min(b[0].x, b[1].x)));
    if (vt(a) && vt(b) && Math.abs(a[0].x - b[0].x) < 4) return Math.max(0, Math.min(Math.max(a[0].y, a[1].y), Math.max(b[0].y, b[1].y)) - Math.max(Math.min(a[0].y, a[1].y), Math.min(b[0].y, b[1].y)));
    return 0;
  };
  const seqEdges = edges.filter(e => is(e.el, 'bpmn:SequenceFlow'));
  const reported = new Set();
  for (let i = 0; i < seqEdges.length; i++) for (let j = i + 1; j < seqEdges.length; j++) {
    const A = seqEdges[i], B = seqEdges[j];
    const shared = [A.el.sourceRef, A.el.targetRef].filter(x => x && (x === B.el.sourceRef || x === B.el.targetRef)).map(x => byId.get(x.id)?.b).filter(Boolean);
    let total = 0;
    for (const a of segs(A.pts)) for (const b of segs(B.pts)) total += olen(a, b);
    const worst = total - (shared.length === 1 ? 30 : 0);
    if (worst > 8 && !reported.has(B.el.id)) {
      reported.add(B.el.id);
      out.push({ id: B.el.id, name: nameOf(B.el) || `${nameOf(B.el.sourceRef)} → ${nameOf(B.el.targetRef)}`, level: 'warn', text: `le flux est superposé au flux ${A.el.id} sur ${Math.round(worst)} px.`, rule: 'flow-overlap', fix: FIXES['flow-overlap'] });
    }
  }

  // deux flux qui se coupent (à vérifier : un croisement est parfois inévitable)
  const cut = (p1, p2, p3, p4) => {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
  };
  const cutReported = new Set();
  for (let i = 0; i < seqEdges.length; i++) for (let j = i + 1; j < seqEdges.length; j++) {
    const A = seqEdges[i], B = seqEdges[j];
    if ([A.el.sourceRef, A.el.targetRef].some(x => x && (x === B.el.sourceRef || x === B.el.targetRef))) continue;
    if (!segs(A.pts).some(a => segs(B.pts).some(b => cut(a[0], a[1], b[0], b[1])))) continue;
    if (cutReported.has(B.el.id)) continue;
    cutReported.add(B.el.id);
    out.push({ id: B.el.id, name: nameOf(B.el) || `${nameOf(B.el.sourceRef)} → ${nameOf(B.el.targetRef)}`, level: 'info', text: `le flux croise le flux ${A.el.id}.`, rule: 'flow-cross', fix: FIXES['flow-cross'] });
  }

  // (pointillés des commentaires : pas un problème du diagramme ; la retouche les place au mieux, sans les signaler)

  // sorties de passerelle qui partent du même côté
  const sideOf = (b, pts) => {
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    let p = pts[0];
    if (Math.abs(p.x - c.x) < 2 && Math.abs(p.y - c.y) < 2) p = pts[1] || p;
    const dx = p.x - c.x, dy = p.y - c.y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'droite' : 'gauche') : (dy > 0 ? 'bas' : 'haut');
  };
  const outs = new Map();
  for (const { el, pts } of edges) {
    const src = el.sourceRef;
    if (!is(el, 'bpmn:SequenceFlow') || !src || !/Gateway$/.test(src.$type)) continue;
    const s = byId.get(src.id); if (!s) continue;
    const side = sideOf(s.b, pts);
    const k = `${src.id}|${side}`;
    if (!outs.has(k)) outs.set(k, { src, side, flows: [] });
    outs.get(k).flows.push(el.id);
  }
  for (const { src, side, flows } of outs.values()) if (flows.length > 1) {
    out.push({ id: src.id, name: nameOf(src), level: 'warn', text: `${flows.length} sorties partent du même côté (${side}) : on croirait qu'elles partent l'une de l'autre (${flows.join(', ')}).`, rule: 'gateway-exits', fix: FIXES['gateway-exits'] });
  }

  // libellés qui recouvrent un élément ou un autre libellé
  const overlap = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
  labels.forEach((l, i) => {
    const owner = l.el;
    const onShape = shapes.find(s => s.el !== owner && s.el !== owner.attachedToRef && !isContainer(s) && !ignorable(s) && overlap(l.b, s.b));
    const onLabel = labels.slice(i + 1).find(o => o.el !== owner && overlap(l.b, o.b));
    const core = { x: l.b.x + 1, y: l.b.y + 1, width: l.b.width - 2, height: l.b.height - 2 };
    const onLine = !onShape && !onLabel && edges.find(e => e.el !== owner && !is(e.el, 'bpmn:Association') && e.pts.some((p, k) => k > 0 && segHits(e.pts[k - 1], p, { x: core.x - 3, y: core.y - 3, width: core.width + 6, height: core.height + 6 })));
    if (onShape || onLabel || onLine) out.push({ id: owner.id, name: nameOf(owner), level: 'warn', text: `son libellé ${onShape ? `recouvre « ${nameOf(onShape.el)} »` : onLabel ? `recouvre le libellé de « ${nameOf(onLabel.el)} »` : `est barré par le flux ${onLine.el.id}`}.`, rule: 'label-overlap', fix: FIXES['label-overlap'] });
  });
  return out;
}

export const sortIssues = list => list.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

/** Problèmes bloquants ajoutés par une modification (ceux qui existaient déjà ne bloquent pas). */
export function newErrors(before, after) {
  const key = i => `${i.rule}|${i.id}|${i.text}`;
  const had = new Set(before.filter(i => i.level === 'error').map(key));
  return after.filter(i => i.level === 'error' && !had.has(key(i)));
}

export const formatIssue = i => `[${i.id}] ${i.name} : ${i.text}${i.fix ? ` → ${i.fix}` : ''}`;
