import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAi } from '../ai.js';
import { emptyDiagram } from '../templates.js';

test('fournisseur compatible OpenAI (LiteLLM, Scaleway…)', async () => {
  const xml = emptyDiagram('X');
  let received;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: `<explanation>- rien</explanation>\n<bpmn>\n\`\`\`xml\n${xml}\n\`\`\`\n</bpmn>` } }] }));
    });
  });
  await new Promise(r => srv.listen(0, r));
  const ai = createAi({ provider: 'openai', apiKey: 'sk', model: 'mistral-large', baseUrl: `http://127.0.0.1:${srv.address().port}/v1/` });
  const r = await ai.propose({ xml, turns: [{ request: 'Ne change rien' }] });
  srv.close();
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer sk');
  assert.equal(received.body.model, 'mistral-large');
  assert.equal(received.body.messages[0].role, 'system');
  assert.match(r.xml, /^<\?xml/, 'les clôtures markdown sont retirées');
  assert.deepEqual(r.warnings, []);
});

test('validation : XML illisible signalé', async () => {
  const ai = createAi({});
  const problems = await ai.validate('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="P"><bpmn:task id="T"');
  assert.ok(problems.length > 0);
});
