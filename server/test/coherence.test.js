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
