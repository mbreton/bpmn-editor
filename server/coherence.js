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
const RULE_FIXES = {
  'no-duplicate-sequence-flows': 'Supprimez l\'une des deux flèches identiques.',
  'single-event-definition': 'Gardez un seul déclencheur ; pour attendre plusieurs choses, utilisez une passerelle basée sur les événements.',
  'event-sub-process-typed-start-event': 'Donnez un déclencheur à son début (clé à molette → délai, message, erreur…).',
  'sub-process-blank-start-event': 'Remplacez le début du sous-processus par un début simple (clé à molette → Début).',
  'link-event': 'Donnez le même nom à l\'événement de lien d\'envoi et à celui d\'arrivée.',
  'ad-hoc-sub-process': 'Retirez les événements de début et de fin du sous-processus ad hoc.',
  'end-event-required': 'Ajoutez un événement de fin (cercle épais) là où le parcours se termine.',
  'empty-subprocess': 'Double-cliquez dessus pour décrire ses étapes (avec un début et une fin), ou, s\'il n\'a pas besoin d\'être détaillé, transformez-le en simple tâche (clé à molette → Tâche).',
  'fake-join': 'Ajoutez juste avant une passerelle qui regroupe les arrivées : exclusive (×) si une seule arrive à la fois, parallèle (+) s\'il faut attendre toutes les arrivées.',
  'superfluous-gateway': 'Supprimez la passerelle et reliez directement l\'étape d\'avant à celle d\'après.',
  'no-gateway-join-fork': 'Utilisez deux passerelles : une qui regroupe les arrivées, puis une qui répartit les sorties.',
  'superfluous-termination': 'Remplacez-la par une fin simple (clé à molette → Fin).',
  'no-multi-instance-termination': 'Utilisez une fin simple si seule l\'itération doit s\'arrêter.',
  'single-blank-start-event': 'Gardez un seul début simple, ou donnez un déclencheur aux autres (message, délai…).',
  'no-overlapping-elements': 'Déplacez-le à la souris (ou demandez à Claude de le déplacer).',
  'global': 'Supprimez la définition inutilisée, ou renommez-la si le nom est en double.',
  'label-required': 'Double-cliquez dessus pour le nommer.',
  parse: 'Supprimez l\'élément concerné et recréez-le, ou restaurez une version précédente depuis l\'historique.'
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
    issues.push({ level: 'error', id, name: id ? nameOf(byId[id]) || id : 'Fichier', text: /unresolved reference/.test(w.message) ? `référence vers un élément inexistant (${/<([^>]+)>/.exec(w.message)?.[1] || '?'}).` : `contenu non reconnu : ${w.message}`, rule: 'parse', fix: RULE_FIXES.parse });
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
        const emptySub = rule === 'end-event-required' && is(byId[r.id], 'bpmn:SubProcess') && !(byId[r.id].flowElements || []).length;
        const item = emptySub
          ? { level: 'warn', id: r.id, name: nameOf(byId[r.id]) || r.id, text: 'sous-processus vide : ses étapes ne sont pas décrites.', rule: 'empty-subprocess', fix: RULE_FIXES['empty-subprocess'] }
          : { level, id: r.id, name: nameOf(byId[r.id]) || r.id, text: fr(r.message), rule, fix: RULE_FIXES[rule] || '' };
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
