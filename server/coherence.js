// « Compilation » de cohérence côté serveur : lecture stricte (références cassées), contrôles
// maison (shared/coherence.js) et règles bpmnlint utiles, en français. Quelques millisecondes
// pour un diagramme courant, ~150 ms pour un très gros (≈ 670 éléments).
import { BpmnModdle } from 'bpmn-moddle';
import Linter from 'bpmnlint/lib/linter.js';
import NodeResolver from 'bpmnlint/lib/resolver/node-resolver.js';
import { checkCoherence, sortIssues, nameOf } from '../shared/coherence.js';

const moddle = new BpmnModdle();
const resolver = new NodeResolver();

// règles bpmnlint retenues (les autres sont couvertes, plus finement, par les contrôles maison)
const RULES = {
  'no-duplicate-sequence-flows': ['error', () => 'flux en double (même origine, même destination, même condition).'],
  'single-event-definition': ['error', () => 'plusieurs déclencheurs sur le même événement.'],
  'event-sub-process-typed-start-event': ['error', () => 'le début d\'un sous-processus événementiel doit avoir un déclencheur (délai, message, erreur…).'],
  'sub-process-blank-start-event': ['error', () => 'un sous-processus doit commencer par un événement de début simple, sans déclencheur.'],
  'link-event': ['error', m => /missing link name/.test(m) ? 'événement de lien sans nom.' : /Duplicate/.test(m) ? 'deux événements de lien d\'arrivée portent le même nom.' : 'événement de lien sans partenaire du même nom.'],
  'ad-hoc-sub-process': ['error', () => 'pas d\'événement de début ni de fin dans un sous-processus ad hoc.'],
  'end-event-required': ['warn', () => 'aucun événement de fin.'],
  'fake-join': ['warn', () => 'plusieurs flux arrivent sans passerelle : l\'élément s\'exécute à chaque arrivée (fausse jonction). Ajoutez une passerelle de jonction.'],
  'superfluous-gateway': ['warn', () => 'passerelle inutile : une seule entrée et une seule sortie.'],
  'no-gateway-join-fork': ['warn', () => 'la passerelle joint et divise à la fois : séparez-la en deux pour la lisibilité.'],
  'superfluous-termination': ['warn', () => 'fin « terminer » inutile : une fin simple suffit ici.'],
  'no-multi-instance-termination': ['warn', () => 'cette fin « terminer » n\'arrête que l\'itération en cours, pas les autres instances.'],
  'single-blank-start-event': ['warn', () => 'plusieurs événements de début simples : lequel démarre le processus ?'],
  'no-overlapping-elements': ['warn', m => /outside/.test(m) ? 'dépasse du cadre de son conteneur.' : 'chevauche un autre élément à l\'écran.'],
  'global': ['info', m => /unused/.test(m) ? 'défini mais jamais utilisé.' : /not unique/.test(m) ? 'nom déjà utilisé par un autre élément du même type.' : 'sans nom.'],
  'label-required': ['info', () => 'sans nom.']
};
const config = { rules: Object.fromEntries(Object.keys(RULES).map(r => [r, RULES[r][0] === 'info' ? 'warn' : RULES[r][0]])) };

/** Contrôle complet d'un XML BPMN : { ok, issues, errors, ms } ; ok=false si illisible. */
export async function checkDiagram(xml) {
  const t0 = performance.now();
  let parsed;
  try { parsed = await moddle.fromXML(xml, 'bpmn:Definitions'); }
  catch (e) { return { ok: false, issues: [{ level: 'error', id: null, name: 'Fichier', text: `XML BPMN illisible : ${e.message}`, rule: 'parse' }], ms: performance.now() - t0 }; }
  const defs = parsed.rootElement;
  const byId = parsed.elementsById || {};
  const issues = [];
  for (const w of parsed.warnings || []) {
    const id = w.element?.id || /#(\S+)/.exec(w.message)?.[1] || null;
    issues.push({ level: 'error', id, name: id ? nameOf(byId[id]) || id : 'Fichier', text: /unresolved reference/.test(w.message) ? `référence vers un élément inexistant (${/<([^>]+)>/.exec(w.message)?.[1] || '?'}).` : `contenu non reconnu : ${w.message}`, rule: 'parse' });
  }
  // un XML écrit à la main n'a pas toujours <incoming>/<outgoing> : bpmnlint en a besoin
  for (const el of Object.values(byId)) {
    if (!el.$instanceOf?.('bpmn:SequenceFlow') || !el.sourceRef || !el.targetRef) continue;
    const o = el.sourceRef.get('outgoing'), i = el.targetRef.get('incoming');
    if (!o.includes(el)) o.push(el);
    if (!i.includes(el)) i.push(el);
  }
  issues.push(...checkCoherence(defs));
  try {
    const reports = await new Linter({ config, resolver }).lint(defs); // instance neuve : certaines règles gardent un état
    const seen = new Set(issues.map(i => `${i.id}|${i.text}`));
    for (const [rule, list] of Object.entries(reports)) {
      const [level, fr] = RULES[rule] || ['warn', m => m];
      for (const r of list) {
        if (rule === 'no-duplicate-sequence-flows' && !/is a duplicate/.test(r.message)) continue;
        if (rule === 'label-required' && is(byId[r.id], 'bpmn:SequenceFlow')) continue; // flux sans nom : normal
        if (rule === 'label-required' && (byId[r.id]?.eventDefinitions || []).some(d => is(d, 'bpmn:CompensateEventDefinition'))) continue; // marqueur de compensation
        if (rule === 'label-required' && (is(byId[r.id], 'bpmn:StartEvent') || is(byId[r.id], 'bpmn:Gateway') && (byId[r.id].incoming || []).length > 1)) continue; // débuts de sous-processus, jonctions
        const item = { level, id: r.id, name: nameOf(byId[r.id]) || r.id, text: fr(r.message), rule };
        const k = `${item.id}|${item.text}`;
        if (!seen.has(k)) { seen.add(k); issues.push(item); }
      }
    }
  } catch (e) {
    issues.push({ level: 'info', id: null, name: 'Contrôle', text: `bpmnlint indisponible : ${e.message}`, rule: 'lint' });
  }
  sortIssues(issues);
  return { ok: true, issues, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

function is(bo, type) { return !!bo && bo.$instanceOf?.(type); }
