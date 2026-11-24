// Génère un petit document BPMN (avec DI) à partir d'une description compacte, pour les vignettes du centre d'aide.
const TYPES = {
  start: 'startEvent', end: 'endEvent', catch: 'intermediateCatchEvent', throw: 'intermediateThrowEvent', boundary: 'boundaryEvent',
  task: 'task', user: 'userTask', service: 'serviceTask', script: 'scriptTask', send: 'sendTask', receive: 'receiveTask',
  manual: 'manualTask', rule: 'businessRuleTask', call: 'callActivity', sub: 'subProcess',
  xor: 'exclusiveGateway', and: 'parallelGateway', or: 'inclusiveGateway', evgw: 'eventBasedGateway',
  note: 'textAnnotation', data: 'dataObjectReference', store: 'dataStoreReference'
};
const DEFS = {
  timer: 'timerEventDefinition', message: 'messageEventDefinition', error: 'errorEventDefinition', signal: 'signalEventDefinition',
  escalation: 'escalationEventDefinition', compensate: 'compensateEventDefinition', terminate: 'terminateEventDefinition',
  conditional: 'conditionalEventDefinition', link: 'linkEventDefinition'
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function size(n) {
  if (n.w) return [n.w, n.h];
  if (['start', 'end', 'catch', 'throw', 'boundary'].includes(n.t)) return [36, 36];
  if (['xor', 'and', 'or', 'evgw'].includes(n.t)) return [50, 50];
  if (n.t === 'note') return [140, 50];
  if (n.t === 'data') return [36, 50];
  if (n.t === 'store') return [50, 50];
  return [100, 80];
}

/**
 * spec = { nodes: [{ id, t, x, y, name?, ev?, timer?: [kind, value], on?, nonInt?, parent?, w?, h?, triggered?, nonIntStart?, comp? }], flows: [[from, to, name?]] }
 */
export function buildSnippet(spec) {
  const nodes = new Map(spec.nodes.map(n => [n.id, n]));
  const bounds = id => { const n = nodes.get(id); const [w, h] = size(n); return { x: n.x, y: n.y, w, h, cx: n.x + w / 2, cy: n.y + h / 2 }; };

  const elXml = n => {
    const tag = TYPES[n.t];
    const attrs = [`id="${n.id}"`];
    if (n.name && n.t !== 'note') attrs.push(`name="${esc(n.name)}"`);
    if (n.on) attrs.push(`attachedToRef="${n.on}"`);
    if (n.t === 'data') attrs.push(`dataObjectRef="DO_${n.id}"`);
    if (n.nonInt) attrs.push('cancelActivity="false"');
    if (n.triggered) attrs.push('triggeredByEvent="true"');
    if (n.nonIntStart) attrs.push('isInterrupting="false"');
    if (n.comp) attrs.push('isForCompensation="true"');
    let inner = '';
    if (n.ev) {
      const d = DEFS[n.ev];
      inner = n.timer
        ? `<bpmn:${d}><bpmn:${n.timer[0]} xsi:type="bpmn:tFormalExpression">${esc(n.timer[1])}</bpmn:${n.timer[0]}></bpmn:${d}>`
        : `<bpmn:${d} />`;
    }
    if (n.t === 'note') inner = `<bpmn:text>${esc(n.name)}</bpmn:text>`;
    if (n.t === 'sub') {
      inner += spec.nodes.filter(c => c.parent === n.id).map(elXml).join('');
      inner += flowsIn(n.id);
    }
    return `<bpmn:${tag} ${attrs.join(' ')}>${inner}</bpmn:${tag}>`;
  };
  const flowsIn = parent => spec.flows
    .filter(([a]) => (nodes.get(a).parent || null) === parent)
    .map(([a, b, name], i) => `<bpmn:sequenceFlow id="F_${a}_${b}" sourceRef="${a}" targetRef="${b}"${name ? ` name="${esc(name)}"` : ''} />`).join('');

  const top = spec.nodes.filter(n => !n.parent).map(elXml).join('') + flowsIn(null);
  const dataObjects = spec.nodes.filter(n => n.t === 'data').map(n => `<bpmn:dataObject id="DO_${n.id}" />`).join('');

  const shapes = spec.nodes.map(n => {
    const b = bounds(n.id);
    const exp = n.t === 'sub' ? ' isExpanded="true"' : '';
    return `<bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${exp}><dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" /></bpmndi:BPMNShape>`;
  }).join('');

  const edges = spec.flows.map(([a, b]) => {
    const s = bounds(a), t = bounds(b), src = nodes.get(a);
    let pts;
    if (src.t === 'boundary') pts = [[s.cx, s.y + s.h], [s.cx, t.cy], [t.x, t.cy]];
    else if (Math.abs(s.cy - t.cy) < 4) pts = [[s.x + s.w, s.cy], [t.x, t.cy]];
    else if (['xor', 'and', 'or', 'evgw'].includes(src.t)) pts = [[s.cx, t.cy < s.cy ? s.y : s.y + s.h], [s.cx, t.cy], [t.x, t.cy]];
    else { const mx = (s.x + s.w + t.x) / 2; pts = [[s.x + s.w, s.cy], [mx, s.cy], [mx, t.cy], [t.x, t.cy]]; }
    return `<bpmndi:BPMNEdge id="F_${a}_${b}_di" bpmnElement="F_${a}_${b}">${pts.map(([x, y]) => `<di:waypoint x="${Math.round(x)}" y="${Math.round(y)}" />`).join('')}</bpmndi:BPMNEdge>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
<bpmn:process id="P" isExecutable="false">${dataObjects}${top}</bpmn:process>
<bpmndi:BPMNDiagram id="DG"><bpmndi:BPMNPlane id="PL" bpmnElement="P">${shapes}${edges}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}
