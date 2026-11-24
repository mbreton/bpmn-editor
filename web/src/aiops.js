// Applique les opérations proposées par l'IA avec les services bpmn-js : chaque opération est une
// commande annulable, et la mise en page des nouveaux éléments est calculée par l'éditeur
// (placement automatique, insertion sur un flux), pas par l'IA.
import { is, getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';
import { createFocus } from './focus.js';

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

  const refs = new Map(); // ref proposé par l'IA → id réel

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

  function finish(shape, op) {
    if (op.ref) refs.set(op.ref, shape.id);
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
    const elements = registry.filter(e => e.parent && e.type !== 'label' && !e.waypoints);
    const { movingShapes, resizingShapes } = spaceTool.calculateAdjustments(elements, 'x', width, x);
    if (movingShapes.length || resizingShapes.length) modeling.createSpace(movingShapes, resizingShapes, { x: width, y: 0 }, 'e', x);
  }

  /** Décale vers le bas un nouvel élément tant qu'il chevauche un élément existant. */
  function ensureFree(shape) {
    const overlap = (a, b, m = 12) => a.x < b.x + b.width + m && a.x + a.width + m > b.x && a.y < b.y + b.height + m && a.y + a.height + m > b.y;
    for (let i = 0; i < 15; i++) {
      const hits = registry.filter(e => e !== shape && e.type !== 'label' && !e.waypoints && e.parent === shape.parent
        && e !== shape.host && e.host !== shape && overlap(shape, e));
      if (!hits.length) return;
      const bottom = Math.max(...hits.map(e => e.y + e.height));
      modeling.moveShape(shape, { x: 0, y: bottom + 40 - shape.y });
    }
  }

  const OPS = {
    update(op) {
      const el = get(op.id);
      if (op.name !== undefined) modeling.updateLabel(el, op.name);
      if (op.documentation !== undefined) setDoc(el, op.documentation);
    },

    append(op) {
      const source = get(op.after, 'élément de départ');
      const shape = autoPlace.append(source, newShape(op));
      ensureFree(shape);
      finish(shape, op);
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
    },

    attach(op) {
      const host = get(op.to, 'activité');
      if (!is(host, 'bpmn:Activity')) throw new OpError(`« ${op.to} » n'est pas une activité`);
      const shape = newShape({ ...op, type: 'bpmn:BoundaryEvent' });
      const n = (host.attachers || []).length;
      const x = host.x + host.width * Math.min(0.85, 0.25 + 0.3 * n);
      const created = modeling.createShape(shape, { x, y: host.y + host.height }, host, { attach: true });
      finish(created, op);
      if (op.interrupting === false) modeling.updateProperties(created, { cancelActivity: false });
    },

    connect(op) {
      const a = get(op.from, 'source'), b = get(op.to, 'cible');
      const c = modeling.connect(a, b);
      if (!c) throw new OpError('liaison impossible entre ces éléments');
      if (op.ref) refs.set(op.ref, c.id);
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
  function apply(change) {
    const mark = commandStack._stackIdx;
    const before = ids();
    const touched = new Set();
    try {
      if (!Array.isArray(change.ops) || !change.ops.length) throw new OpError('aucune opération');
      for (const op of change.ops) {
        const fn = OPS[op?.op];
        if (!fn) throw new OpError(`opération « ${op?.op} » inconnue`);
        for (const k of ['id', 'after', 'to', 'from', 'flow', 'gateway']) if (op[k] && before.has(refs.get(op[k]) || op[k])) touched.add(refs.get(op[k]) || op[k]);
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
    return { ok: true, added, changed, mark };
  }

  function undoTo(mark) {
    while (commandStack._stackIdx > mark && commandStack.canUndo()) commandStack.undo();
  }

  const focuser = createFocus(modeler);
  const focus = ids => focuser.show(ids.map(id => refs.get(id) || id), { maxZoom: 1.4, pad: 160 });

  return { apply, undoTo, focus, resolve: id => refs.get(id) || id, reset: () => refs.clear() };
}

/** Extrait et lit le bloc <changes>…</changes> d'une réponse. */
export function parseChanges(text) {
  const m = /<changes>([\s\S]*?)(<\/changes>|$)/i.exec(text || '');
  if (!m) return null;
  let raw = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(c => c && typeof c === 'object') : null;
  } catch {
    // Virgules finales tolérées.
    try { return JSON.parse(raw.replace(/,\s*([\]}])/g, '$1')); } catch { return { error: 'Les modifications proposées sont illisibles (JSON invalide).' }; }
  }
}

/** Texte affichable : la réponse sans le bloc de modifications. */
export const withoutChanges = text => String(text || '').replace(/<changes>[\s\S]*?(<\/changes>|$)/i, '').trim();
