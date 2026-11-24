import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEcho, speakable } from '../../web/src/voice.js';

test('écho : la voix de l\'IA captée par le micro est reconnue, l\'utilisateur non', () => {
  const said = 'Ici, la collecte des pièces est relancée chaque jour. Et là, l\'échéance contractuelle annule le dossier.';
  assert.equal(isEcho('la collecte des pièces est relancée', said), true);
  assert.equal(isEcho('échéance contractuelle annule', said), true);
  assert.equal(isEcho('attends parle-moi plutôt de la signature', said), false);
  assert.equal(isEcho('stop', said), false);
  assert.equal(isEcho('non', said), false);
});

test('texte prononçable sans balises ni identifiants', () => {
  assert.equal(speakable('<focus ids="Task_KYC"/>La **collecte** `Task_KYC` [Task_KYC] est relancée.\n<changes>[]</changes>'), 'La collecte est relancée.');
});
