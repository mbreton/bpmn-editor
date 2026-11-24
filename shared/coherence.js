// Contrôles de cohérence du workflow, sur le modèle bpmn-moddle (navigateur et serveur).
// Niveaux : error = cassé ou ambigu (une modification de Claude qui en ajoute est refusée),
// warn = incomplet ou douteux (signalé, accepté : un diagramme en construction en a forcément),
// info = remarque.
import { TYPE_LABELS, explainIso } from './i18n.js';

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
  const add = (bo, level, text, rule) => out.push({ id: bo?.id, name: nameOf(bo), level, text, rule });
  const processes = (definitions.rootElements || []).filter(r => is(r, 'bpmn:Process'));

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
      if (e.flowElements) walk(e);
    }
    return nodes;
  };

  for (const p of processes) {
    const nodes = walk(p);
    if (nodes.length && !nodes.some(n => is(n, 'bpmn:StartEvent'))) add(p, 'warn', 'aucun événement de début.', 'start');
  }
  return sortIssues(out);
}

export const sortIssues = list => list.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

/** Problèmes bloquants ajoutés par une modification (ceux qui existaient déjà ne bloquent pas). */
export function newErrors(before, after) {
  const key = i => `${i.rule}|${i.id}|${i.text}`;
  const had = new Set(before.filter(i => i.level === 'error').map(key));
  return after.filter(i => i.level === 'error' && !had.has(key(i)));
}

export const formatIssue = i => `[${i.id}] ${i.name} : ${i.text}`;
