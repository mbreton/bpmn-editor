// Résumé textuel d'un diagramme BPMN (modèle bpmn-moddle) : structure, événements, flux, et
// contrôles de cohérence. C'est ce que lit l'IA via le MCP, plus compact et plus clair que le XML.
import { TYPE_LABELS, DEF_LABELS, explainIso } from './i18n.js';

const is = (bo, type) => !!bo && (bo.$instanceOf ? bo.$instanceOf(type) : bo.$type === type);
const label = bo => (TYPE_LABELS[bo.$type] || bo.$type.replace('bpmn:', ''));

function eventInfo(bo) {
  const d = (bo.eventDefinitions || [])[0];
  if (!d) return '';
  let s = DEF_LABELS[d.$type] || d.$type.replace('bpmn:', '');
  if (is(d, 'bpmn:TimerEventDefinition')) {
    for (const k of ['timeDuration', 'timeDate', 'timeCycle']) if (d[k]?.body) {
      const m = explainIso(d[k].body);
      s += ` ${k}=${d[k].body}${m ? ` (${m})` : ''}`;
    }
  }
  const ref = d.errorRef || d.messageRef || d.signalRef || d.escalationRef;
  if (ref) s += ` « ${ref.name || ref.id} »${ref.errorCode ? ` code=${ref.errorCode}` : ''}`;
  if (is(d, 'bpmn:ConditionalEventDefinition') && d.condition?.body) s += ` si ${d.condition.body}`;
  return s;
}

function flowText(f, src) {
  const parts = [`${f.id} → ${f.targetRef?.id}`];
  if (f.name) parts.push(`« ${f.name} »`);
  if (f.conditionExpression?.body) parts.push(`condition ${f.conditionExpression.body}`);
  if (src?.default === f) parts.push('par défaut');
  return parts.join(' ');
}

export function summarize(definitions) {
  const lines = [];
  const issues = [];
  const walk = (container, depth) => {
    const pad = '  '.repeat(depth);
    const els = (container.flowElements || []).filter(e => !is(e, 'bpmn:SequenceFlow') && !is(e, 'bpmn:DataObject'));
    for (const e of els) {
      let line = `${pad}- [${e.id}] ${label(e)}${e.name ? ` « ${e.name} »` : ''}`;
      const ev = eventInfo(e);
      if (ev) line += ` · ${ev}`;
      if (is(e, 'bpmn:BoundaryEvent')) line += ` · sur ${e.attachedToRef?.id}${e.cancelActivity === false ? ' (non interrompant)' : ' (interrompant)'}`;
      if (is(e, 'bpmn:StartEvent') && container.triggeredByEvent) line += e.isInterrupting === false ? ' (non interrompant)' : ' (interrompant)';
      if (e.triggeredByEvent) line += ' · sous-processus événementiel';
      if (e.isForCompensation) line += ' · activité de compensation';
      if (is(e, 'bpmn:ScriptTask') && e.script) line += ` · script ${e.scriptFormat || ''}: ${String(e.script).slice(0, 120)}`;
      const doc = (e.documentation || []).map(d => d.text).join(' ').trim();
      if (doc) line += ` · doc: ${doc.slice(0, 200)}`;
      lines.push(line);
      for (const f of e.outgoing || []) lines.push(`${pad}    flux ${flowText(f, e)}`);

      // contrôles
      const isComp = e.isForCompensation || (is(e, 'bpmn:BoundaryEvent') && (e.eventDefinitions || []).some(d => is(d, 'bpmn:CompensateEventDefinition')));
      const inc = (e.incoming || []).length, out = (e.outgoing || []).length;
      if (!inc && !is(e, 'bpmn:StartEvent') && !is(e, 'bpmn:BoundaryEvent') && !isComp && !e.triggeredByEvent) issues.push(`[${e.id}] ${e.name || label(e)} n'a aucun flux entrant (jamais atteint).`);
      if (!out && !is(e, 'bpmn:EndEvent') && !isComp && !e.triggeredByEvent) issues.push(`[${e.id}] ${e.name || label(e)} n'a aucun flux sortant (fin implicite).`);
      if ((is(e, 'bpmn:ExclusiveGateway') || is(e, 'bpmn:InclusiveGateway')) && out > 1) {
        const loose = e.outgoing.filter(f => !f.conditionExpression && e.default !== f);
        if (loose.length) issues.push(`[${e.id}] ${e.name || label(e)} : ${loose.length} flux sortant(s) sans condition ni flux par défaut.`);
      }
      if (e.flowElements) walk(e, depth + 1);
    }
    for (const a of container.artifacts || []) if (is(a, 'bpmn:TextAnnotation')) lines.push(`${pad}- [${a.id}] Annotation : ${String(a.text || '').slice(0, 160)}`);
  };
  for (const r of definitions.rootElements || []) {
    if (is(r, 'bpmn:Process')) { lines.push(`Processus [${r.id}]${r.name ? ` « ${r.name} »` : ''}`); walk(r, 1); }
    if (is(r, 'bpmn:Collaboration')) for (const p of r.participants || []) lines.push(`Pool [${p.id}] « ${p.name || ''} » → processus ${p.processRef?.id || '?'}`);
  }
  return { text: lines.join('\n'), issues };
}
