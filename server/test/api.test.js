import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../app.js';
import { emptyDiagram } from '../templates.js';

let app, cookie, llm, llmCalls = [];
const PASSWORD = 'secret-test';

// Faux fournisseur LLM compatible Anthropic.
const VALID = emptyDiagram('IA').replace('name="Début" />', 'name="Début reçu" />');
let llmReply = `<explanation>- Renommé le début</explanation>\n<bpmn>${VALID}</bpmn>`;

before(async () => {
  llm = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      llmCalls.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: llmReply }] }));
    });
  });
  await new Promise(r => llm.listen(0, r));
  app = await buildApp({
    dbFile: ':memory:', adminPassword: PASSWORD, secureCookies: 'auto',
    ai: { provider: 'anthropic', apiKey: 'k', baseUrl: `http://127.0.0.1:${llm.address().port}` }
  });
});
after(async () => { await app.close(); llm.close(); });

const req = (method, url, { body, headers = {}, auth = true } = {}) =>
  app.inject({ method, url, payload: body, headers: { ...(auth && cookie ? { cookie } : {}), ...headers } });

test('connexion administrateur', async () => {
  assert.equal((await req('POST', '/api/login', { body: { password: 'faux' }, auth: false })).statusCode, 401);
  const r = await req('POST', '/api/login', { body: { password: PASSWORD }, auth: false });
  assert.equal(r.statusCode, 200);
  cookie = r.headers['set-cookie'].split(';')[0];
  assert.equal((await req('GET', '/api/config')).json().admin, true);
  assert.equal((await req('GET', '/api/diagrams', { auth: false })).statusCode, 401);
});

test('cookie de session : Secure seulement en HTTPS (mode auto)', async () => {
  const http = await req('POST', '/api/login', { body: { password: PASSWORD }, auth: false });
  assert.doesNotMatch(http.headers['set-cookie'], /Secure/i);
  const https = await req('POST', '/api/login', { body: { password: PASSWORD }, auth: false, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers['set-cookie'], /Secure/i);
});

test('cycle complet : création, verrou, enregistrement, conflit, historique, partage', async () => {
  const created = (await req('POST', '/api/diagrams', { body: { name: 'Onboarding' } })).json();
  const id = created.id;
  assert.equal(created.version, 1);

  const share = (await req('POST', `/api/diagrams/${id}/shares`, { body: { role: 'edit', label: 'Assureur' } })).json();
  const view = (await req('POST', `/api/diagrams/${id}/shares`, { body: { role: 'view' } })).json();
  const asEdit = { 'x-share-token': share.token };
  const asView = { 'x-share-token': view.token };

  // lecture via lien
  const d = (await req('GET', `/api/diagrams/${id}`, { auth: false, headers: asView })).json();
  assert.equal(d.role, 'view');
  assert.match(d.xml, /StartEvent_1/);

  // le lien lecture ne peut ni verrouiller ni enregistrer
  assert.equal((await req('POST', `/api/diagrams/${id}/lock`, { auth: false, headers: asView, body: { holder: 'v' } })).statusCode, 403);

  // verrou par A, B est refusé
  const la = (await req('POST', `/api/diagrams/${id}/lock`, { auth: false, headers: asEdit, body: { holder: 'A', author: 'Alice' } })).json();
  assert.equal(la.acquired, true);
  const lb = (await req('POST', `/api/diagrams/${id}/lock`, { body: { holder: 'B', author: 'Bob' } })).json();
  assert.equal(lb.acquired, false);
  assert.equal(lb.lock.author, 'Alice');

  // B ne peut pas enregistrer pendant le verrou
  const xml2 = d.xml.replace('Début', 'Départ');
  assert.equal((await req('PUT', `/api/diagrams/${id}`, { body: { xml: xml2, baseVersion: 1, holder: 'B' } })).statusCode, 423);

  // A enregistre
  const s1 = await req('PUT', `/api/diagrams/${id}`, { auth: false, headers: asEdit, body: { xml: xml2, baseVersion: 1, holder: 'A', author: 'Alice', message: 'Renommage' } });
  assert.equal(s1.statusCode, 200);
  assert.equal(s1.json().version, 2);

  // conflit de version
  assert.equal((await req('PUT', `/api/diagrams/${id}`, { auth: false, headers: asEdit, body: { xml: xml2, baseVersion: 1, holder: 'A' } })).statusCode, 409);

  // libération, puis B peut prendre la main
  await req('POST', `/api/diagrams/${id}/unlock`, { auth: false, body: { holder: 'A', shareToken: share.token } });
  assert.equal((await req('POST', `/api/diagrams/${id}/lock`, { body: { holder: 'B', author: 'Bob' } })).json().acquired, true);

  // historique
  const versions = (await req('GET', `/api/diagrams/${id}/versions`, { auth: false, headers: asView })).json();
  assert.deepEqual(versions.map(v => v.version), [2, 1]);
  assert.equal(versions[0].author, 'Alice');
  const v1 = (await req('GET', `/api/diagrams/${id}/versions/1`, { auth: false, headers: asView })).json();
  assert.match(v1.xml, /name="Début"/);

  // révocation
  assert.equal((await req('DELETE', `/api/diagrams/${id}/shares/${view.token}`)).statusCode, 200);
  assert.equal((await req('GET', `/api/diagrams/${id}`, { auth: false, headers: asView })).statusCode, 401);

  // un jeton d'un autre diagramme ne donne pas accès
  const other = (await req('POST', '/api/diagrams', { body: { name: 'Autre' } })).json();
  assert.equal((await req('GET', `/api/diagrams/${other.id}`, { auth: false, headers: asEdit })).statusCode, 401);
});

test('import XML invalide refusé', async () => {
  const r = await req('POST', '/api/diagrams', { body: { name: 'X', xml: '<definitions><oops' } });
  assert.equal(r.statusCode, 400);
});

test('assistant IA : proposition, puis précision avec historique des tours', async () => {
  const { id } = (await req('POST', '/api/diagrams', { body: { name: 'IA' } })).json();
  const base = emptyDiagram('IA');
  const r1 = await req('POST', `/api/diagrams/${id}/ai`, { body: { xml: base, turns: [{ request: 'Renomme le début' }] } });
  assert.equal(r1.statusCode, 200, r1.body);
  const p1 = r1.json();
  assert.match(p1.xml, /Début reçu/);
  assert.deepEqual(p1.warnings, []);
  assert.match(llmCalls.at(-1).messages[0].content, /Demande : Renomme le début/);

  const r2 = await req('POST', `/api/diagrams/${id}/ai`, {
    body: { xml: base, turns: [{ request: 'Renomme le début', proposalXml: p1.xml, explanation: p1.explanation }, { request: 'Plutôt « Demande reçue »' }] }
  });
  assert.equal(r2.statusCode, 200);
  const msgs = llmCalls.at(-1).messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.match(msgs[2].content, /Demande reçue/);
});

test('assistant IA : une passe de correction si la DI manque', async () => {
  const { id } = (await req('POST', '/api/diagrams', { body: { name: 'IA2' } })).json();
  const noDi = emptyDiagram('IA').replace('<bpmn:startEvent id="StartEvent_1" name="Début" />', '<bpmn:startEvent id="StartEvent_1" name="Début" /><bpmn:task id="T1" name="Sans DI" />');
  const before = llmCalls.length;
  llmReply = `<explanation>- ajout</explanation><bpmn>${noDi}</bpmn>`;
  const r = await req('POST', `/api/diagrams/${id}/ai`, { body: { xml: emptyDiagram('IA'), turns: [{ request: 'Ajoute une tâche' }] } });
  assert.equal(r.statusCode, 200);
  assert.equal(llmCalls.length - before, 2, 'une relance de correction attendue');
  assert.match(r.json().warnings[0], /T1/);
  llmReply = `<explanation>- Renommé le début</explanation>\n<bpmn>${VALID}</bpmn>`;
});

test('assistant IA interdit en lecture seule', async () => {
  const { id } = (await req('POST', '/api/diagrams', { body: { name: 'IA3' } })).json();
  const view = (await req('POST', `/api/diagrams/${id}/shares`, { body: { role: 'view' } })).json();
  const r = await req('POST', `/api/diagrams/${id}/ai`, { auth: false, headers: { 'x-share-token': view.token }, body: { xml: emptyDiagram(), turns: [{ request: 'x' }] } });
  assert.equal(r.statusCode, 403);
});
