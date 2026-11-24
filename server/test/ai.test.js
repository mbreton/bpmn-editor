import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAi, stripDi } from '../ai.js';
import { emptyDiagram } from '../templates.js';

test('fournisseur compatible OpenAI en streaming (LiteLLM, Scaleway…)', async () => {
  let received;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['Bon', 'jour']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => srv.listen(0, r));
  const ai = createAi({ provider: 'openai', apiKey: 'sk', model: 'mistral-large', baseUrl: `http://127.0.0.1:${srv.address().port}/v1/` });
  let text = '';
  for await (const t of ai.chat({ xml: emptyDiagram(), history: [{ role: 'user', content: 'Salut' }], mode: 'propose' })) text += t;
  srv.close();
  assert.equal(text, 'Bonjour');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer sk');
  assert.equal(received.body.stream, true);
  assert.equal(received.body.messages[0].role, 'system');
  assert.match(received.body.messages[1].content, /MODE PROPOSITION/);
});

test('stripDi retire les coordonnées', () => {
  const x = stripDi(emptyDiagram());
  assert.doesNotMatch(x, /BPMNShape|dc:Bounds/);
  assert.match(x, /StartEvent_1/);
});
