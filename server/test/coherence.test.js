import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDiagram } from '../coherence.js';
import { relayout } from '../layout.js';
import { newErrors } from '../../shared/coherence.js';

const onboarding = readFileSync(new URL('./fixtures/onboarding.bpmn', import.meta.url), 'utf8');
const errors = r => r.issues.filter(i => i.level === 'error');

test('cohérence : le diagramme d\'exemple ne bloque pas, et le contrôle est rapide', async () => {
  await checkDiagram(onboarding);
  const r = await checkDiagram(onboarding);
  assert.equal(r.ok, true);
  assert.deepEqual(errors(r), []);
  assert.ok(r.ms < 100, `${r.ms} ms`);
});

test('cohérence : références cassées, délais illisibles, passerelle ambiguë, flux en double', async () => {
  const cases = {
    'référence vers un élément inexistant': onboarding.replace('attachedToRef="Task_KYC"', 'attachedToRef="Nulle_Part"'),
    'délai invalide': onboarding.replace('R3/P1D', 'tous les jours'),
    'est une répétition': onboarding.replace(/<bpmn:timeCycle([^>]*)>R3\/P1D<\/bpmn:timeCycle>/, '<bpmn:timeDuration$1>R3/P1D</bpmn:timeDuration>')
  };
  for (const [msg, xml] of Object.entries(cases)) {
    const r = await checkDiagram(xml);
    assert.ok(errors(r).some(i => i.text.includes(msg)), `${msg} : ${JSON.stringify(errors(r))}`);
  }
  const gw = `<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x"><bpmn:process id="P">
    <bpmn:startEvent id="S"/><bpmn:exclusiveGateway id="G" name="Montant ?"/><bpmn:task id="A" name="A"/><bpmn:task id="B" name="B"/><bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="f0" sourceRef="S" targetRef="G"/><bpmn:sequenceFlow id="f1" sourceRef="G" targetRef="A"/><bpmn:sequenceFlow id="f2" sourceRef="G" targetRef="B"/>
    <bpmn:sequenceFlow id="f3" sourceRef="A" targetRef="E"/><bpmn:sequenceFlow id="f4" sourceRef="B" targetRef="E"/><bpmn:sequenceFlow id="f5" sourceRef="B" targetRef="E"/></bpmn:process></bpmn:definitions>`;
  const r = await checkDiagram(gw);
  assert.ok(errors(r).some(i => i.id === 'G' && /sans condition/.test(i.text)));
  assert.ok(errors(r).some(i => /flux en double/.test(i.text)));
  assert.ok(r.issues.some(i => i.level === 'warn' && i.id === 'E' && /fausse jonction/.test(i.text)));
  assert.equal((await checkDiagram('<pas du bpmn')).ok, false);
});

test('cohérence : seuls les nouveaux problèmes bloquent', async () => {
  const before = (await checkDiagram(onboarding.replace('R3/P1D', 'n\'importe quoi'))).issues;
  const after = (await checkDiagram(onboarding.replace('R3/P1D', 'n\'importe quoi').replace('name="Signer le contrat"', 'name="Signer"'))).issues;
  assert.deepEqual(newErrors(before, after), [], 'un problème existant ne bloque pas une autre modification');
  const worse = (await checkDiagram(onboarding.replace('R3/P1D', 'n\'importe quoi').replace('attachedToRef="Task_KYC"', 'attachedToRef="X"'))).issues;
  assert.ok(newErrors(before, worse).length > 0);
});

test('réorganisation : rien de perdu, libellés et compensation retouchés', async () => {
  const r = await relayout(onboarding);
  assert.ok(r.ms < 2000);
  assert.deepEqual(r.warnings, []);
  const c = await checkDiagram(r.xml);
  assert.deepEqual(errors(c), []);
  for (const id of ['Task_KYC', 'Timer_Relance', 'Sub_Dossier', 'Err_Boundary', 'Comp_Reserver', 'Assoc_Comp']) assert.match(r.xml, new RegExp(`bpmnElement="${id}"`), `${id} dessiné`);
  assert.ok(!c.issues.some(i => i.rule === 'no-overlapping-elements'), JSON.stringify(c.issues.filter(i => i.rule === 'no-overlapping-elements')));
});

test('réorganisation : les couleurs sont conservées', async () => {
  const colored = onboarding.replace(/(<bpmndi:BPMNShape id="[^"]*" bpmnElement="Task_KYC")/, '$1 bioc:stroke="#205022" bioc:fill="#c8e6c9" color:background-color="#c8e6c9"')
    .replace('<bpmn:definitions ', '<bpmn:definitions xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0" xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0" ');
  assert.match(colored, /bioc:fill="#c8e6c9"/);
  const r = await relayout(colored);
  assert.match(r.xml, /bpmnElement="Task_KYC"[^>]*bioc:fill="#c8e6c9"|bioc:fill="#c8e6c9"[^>]*bpmnElement="Task_KYC"/);
  assert.match(r.xml, /xmlns:bioc="http:\/\/bpmn.io\/schema\/bpmn\/biocolor\/1.0"/);
  assert.equal(r.styled, 1);
});

test('texte trop long pour la boîte : signalé avec la longueur à viser', async () => {
  const { labelOverflow } = await import('../../shared/labelfit.js');
  assert.equal(labelOverflow('bpmn:Task', "Affichage de l'AV avec faux crédit et simulation des intérêts"), null, '5 lignes : tient');
  const o = labelOverflow('bpmn:Task', 'Questionnaire – Connaissances et expérience financières (profil de risque)');
  assert.deepEqual([o.lines, o.maxLines], [6, 5], 'déborde comme dans bpmn-js (6 lignes)');
  assert.equal(labelOverflow('bpmn:SubProcess', 'x '.repeat(80), { expanded: true }), null, 'sous-processus déplié : titre sur une ligne, pas de limite');
  const long = onboarding.replace('name="Signer le contrat"', 'name="Recueil des informations LCBFT (origine des fonds, profession, revenus et patrimoine)"');
  const r = await checkDiagram(long);
  const i = r.issues.find(x => x.rule === 'label-too-long');
  assert.equal(i?.id, 'Task_Signer');
  assert.match(i.fix, /Raccourcissez le nom à \d+ caractères/);
});

test('réorganisation : espacements resserrés', async () => {
  const r = await relayout(onboarding);
  const b = [...r.xml.matchAll(/Bounds x="([-\d.]+)" y="[-\d.]+" width="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
  const width = Math.max(...b.map(([x, w]) => x + w)) - Math.min(...b.map(([x]) => x));
  assert.ok(width < 1900, `largeur ${width} (bibliothèque par défaut : ~2430)`);
});

test('deux flèches qui se rejoignent vers la même cible ne sont pas « superposées »', async () => {
  const { geometryIssues } = await import('../../shared/coherence.js');
  const T = { id: 'G', $type: 'bpmn:ExclusiveGateway' }, A = { id: 'A', $type: 'bpmn:Task' }, B = { id: 'B', $type: 'bpmn:Task' }, C = { id: 'C', $type: 'bpmn:Task' };
  const f = (id, s, t) => ({ id, $type: 'bpmn:SequenceFlow', sourceRef: s, targetRef: t });
  const pe = (el, pts) => ({ bpmnElement: el, waypoint: pts.map(([x, y]) => ({ x, y })) });
  const sh = (el, x, y, w, h) => ({ bpmnElement: el, bounds: { x, y, width: w, height: h } });
  const is = (o, t) => o.$type === t || (t === 'bpmn:Gateway' && /Gateway$/.test(o.$type)) || (t === 'bpmn:FlowNode');
  const mk = flows => ({ diagrams: [{ plane: { planeElement: [sh(A, 0, 0, 100, 80), sh(B, 0, 200, 100, 80), sh(C, 600, 0, 100, 80), sh(T, 500, 15, 50, 50), ...flows] } }], $instanceOf: () => false });
  const merge = mk([pe(f('F1', A, T), [[100, 40], [500, 40]]), pe(f('F2', B, T), [[100, 240], [300, 240], [300, 40], [500, 40]])]);
  const rules = d => geometryIssues(d).map(i => i.rule);
  assert.ok(!rules(merge).includes('flow-overlap'), 'convergence vers la même passerelle : pas signalée');
  const clash = mk([pe(f('F1', A, T), [[100, 40], [500, 40]]), pe(f('F3', B, C), [[100, 240], [300, 240], [300, 40], [600, 40]])]);
  assert.ok(rules(clash).includes('flow-overlap'), 'cibles différentes : toujours signalée');
});
