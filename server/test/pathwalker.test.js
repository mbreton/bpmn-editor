import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BpmnModdle } from 'bpmn-moddle';
import { createWalker } from '../../web/src/pathwalker.js';

const xml = readFileSync(new URL('./fixtures/onboarding.bpmn', import.meta.url), 'utf8');
const load = async () => createWalker((await new BpmnModdle().fromXML(xml)).rootElement);
const pick = (state, re) => {
  const o = state.options.find(x => re.test(`${x.group} | ${x.label} | ${x.detail}`));
  assert.ok(o, `option ${re} absente parmi :\n${state.options.map(x => `${x.group} | ${x.label} | ${x.detail}`).join('\n')}`);
  return o.id;
};

test('parcours nominal : toutes les suites possibles, puis passerelle événementielle', async () => {
  const w = await load();
  let c = w.current();
  assert.equal(c.options.length, 1);
  c = w.choose(pick(c, /Démarrer/));
  c = w.choose(pick(c, /Valider la demande.*se termine/));
  c = w.choose(pick(c, /Calculer l'échéance.*se termine/));
  // Dans le sous-processus : terminer la collecte, la relance (bordure), l'échéance (sous-processus événementiel)
  assert.ok(c.options.some(o => /Collecter les pièces KYC.*se termine/.test(o.label)));
  assert.ok(c.options.some(o => /délai « Toutes les 24h \(x3\) » s'écoule/.test(o.label) && /continue en parallèle/.test(o.detail)));
  assert.ok(c.options.some(o => /À tout moment dans « Constitution du dossier »/.test(o.group) && /interrompt/.test(o.detail)));
  assert.ok(!c.options.some(o => /erreur/i.test(o.label)), 'pas de déclenchement manuel de l\'erreur du sous-processus');

  c = w.choose(pick(c, /Collecter les pièces KYC.*se termine/));
  c = w.choose(pick(c, /Signer le contrat.*se termine/));
  c = w.choose(pick(c, /Réserver le contrat.*se termine/));
  assert.ok(c.log.some(l => /Constitution du dossier » est terminé/.test(l.text)));
  const evgw = c.options.filter(o => /En attente à « Attendre le 1er versement »/.test(o.group));
  assert.equal(evgw.length, 2, 'deux suites possibles : versement ou délai');
  c = w.choose(pick(c, /délai « 15 jours écoulés » s'écoule \(15 jours\) en premier/));
  c = w.choose(pick(c, /Clôturer sans versement.*se termine/));
  assert.equal(c.finished, true);
  assert.ok(c.log.some(l => /Fin : « Compte clôturé »/.test(l.text)));
});

test('échéance : interruption, compensation des étapes faites, erreur capturée par le parent', async () => {
  const w = await load();
  let c = w.current();
  for (const re of [/Démarrer/, /Valider la demande.*se termine/, /Calculer.*se termine/, /Collecter.*se termine/, /Signer.*se termine/]) c = w.choose(pick(c, re));
  // relance non interrompante : deux branches actives
  c = w.choose(pick(c, /Réserver.*se termine/));
  // le sous-processus est fini : on revient en arrière pour tester l'échéance pendant la réservation
  c = w.undo();
  assert.ok(c.options.some(o => /Réserver.*se termine/.test(o.label)), 'retour en arrière');
  c = w.choose(pick(c, /Réserver.*se termine/));
  c = w.undo();
  // Réserver pas encore terminé → pas de compensation ; on termine d'abord une autre étape pour tester
  c = w.undo(); // avant « Signer »
  c = w.undo(); // avant « Collecter »
  c = w.choose(pick(c, /Toutes les 24h.*s'écoule/));
  assert.equal(c.tokens.filter(t => t.kind === 'active').length, 2, 'la collecte continue pendant la relance');
  c = w.choose(pick(c, /À tout moment dans « Constitution du dossier »/));
  assert.ok(c.log.some(l => /interrompt/.test(l.text)));
  assert.ok(c.log.some(l => /Erreur « Dossier expiré » capturée sur le bord de « Constitution du dossier »/.test(l.text)), c.log.map(l => l.text).join('\n'));
  assert.deepEqual(c.tokens.map(t => t.label), ['« Notifier l\'expiration au client »']);
});

test('compensation listée quand une étape compensable est terminée', async () => {
  const w = await load();
  let d = w.current();
  for (const re of [/Démarrer/, /Valider.*se termine/, /Calculer.*se termine/]) d = w.choose(pick(d, re));
  d = w.choose(pick(d, /Toutes les 24h.*s'écoule/)); // branche parallèle de relance, encore en cours
  d = w.choose(pick(d, /Collecter.*se termine/));
  d = w.choose(pick(d, /Signer.*se termine/));
  d = w.choose(pick(d, /Réserver.*se termine/));
  // la relance n'est pas finie : le sous-processus continue et l'échéance peut tomber
  d = w.choose(pick(d, /À tout moment dans « Constitution du dossier »/));
  assert.ok(d.log.some(l => /Compensation : « Annuler la réservation assureur »/.test(l.text)), d.log.map(l => l.text).join('\n'));
  assert.ok(w.describe().includes('Suites possibles selon le diagramme'));
});
