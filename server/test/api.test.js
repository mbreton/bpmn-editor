import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../app.js';
import { emptyDiagram } from '../templates.js';

const tmp = mkdtempSync(join(tmpdir(), 'bpmn-test-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const remote = join(tmp, 'remote.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);

// Faux fournisseur LLM (API Anthropic en streaming SSE).
const llmCalls = [];
const llm = createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    llmCalls.push(JSON.parse(b));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const t of ['Bonjour, ', 'je regarde le diagramme.']) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`);
    }
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});

let app;
const ADMIN = { email: 'admin@test', password: 'admin-pass', name: 'Admin' };
const config = (over = {}) => ({
  dbFile: join(tmp, 'db.sqlite'), gitDir: join(tmp, 'repo'), gitRemote: remote, gitSyncSeconds: 0,
  admin: ADMIN, secureCookies: 'auto',
  ai: { provider: 'anthropic', apiKey: 'k', baseUrl: `http://127.0.0.1:${llm.address().port}` }, ...over
});

before(async () => {
  await new Promise(r => llm.listen(0, r));
  app = await buildApp(config());
});
after(async () => { await app.close(); llm.close(); rmSync(tmp, { recursive: true, force: true }); });

const call = (method, url, { body, cookie, headers = {} } = {}) =>
  app.inject({ method, url, payload: body, headers: { ...(cookie ? { cookie } : {}), ...headers } });
const loginAs = async (email, password, target = app) => {
  const r = await target.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  return { r, cookie: r.headers['set-cookie']?.split(';')[0] };
};
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

let adminCookie, aliceCookie;

test('inscription, attente de validation, approbation par l\'administrateur', async () => {
  ({ cookie: adminCookie } = await loginAs(ADMIN.email, ADMIN.password));
  assert.ok(adminCookie);

  assert.equal((await call('POST', '/api/register', { body: { name: 'Alice Martin', email: 'alice@test.fr', password: 'court' } })).statusCode, 400);
  assert.equal((await call('POST', '/api/register', { body: { name: 'Alice Martin', email: 'alice@test.fr', password: 'motdepasse' } })).statusCode, 201);
  assert.equal((await call('POST', '/api/register', { body: { name: 'Doublon', email: 'ALICE@test.fr', password: 'motdepasse' } })).statusCode, 409);

  const pending = await loginAs('alice@test.fr', 'motdepasse');
  assert.equal(pending.r.statusCode, 403);
  assert.match(pending.r.json().error, /validation/);

  const cfg = (await call('GET', '/api/config', { cookie: adminCookie })).json();
  assert.equal(cfg.pendingUsers, 1);
  const users = (await call('GET', '/api/users', { cookie: adminCookie })).json();
  const aliceId = users.find(u => u.email === 'alice@test.fr').id;
  assert.equal((await call('PATCH', `/api/users/${aliceId}`, { cookie: adminCookie, body: { status: 'active' } })).json().status, 'active');

  const ok = await loginAs('alice@test.fr', 'motdepasse');
  assert.equal(ok.r.statusCode, 200);
  aliceCookie = ok.cookie;
  assert.equal((await call('GET', '/api/users', { cookie: aliceCookie })).statusCode, 403, 'pas d\'administration pour un utilisateur');
  assert.equal((await call('GET', '/api/diagrams')).statusCode, 401, 'rien sans session');
});

test('cookie Secure seulement en HTTPS', async () => {
  const http = await call('POST', '/api/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.doesNotMatch(http.headers['set-cookie'], /Secure/i);
  const https = await call('POST', '/api/login', { body: { email: ADMIN.email, password: ADMIN.password }, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers['set-cookie'], /Secure/i);
});

let diagramId;
test('création, verrou, brouillon continu, annuler/rétablir, version Git signée', async () => {
  const d = (await call('POST', '/api/diagrams', { cookie: aliceCookie, body: { name: 'Onboarding Client' } })).json();
  diagramId = d.id;
  assert.equal(d.path, 'diagrams/onboarding-client.bpmn');

  const full = (await call('GET', `/api/diagrams/${d.id}`, { cookie: aliceCookie })).json();
  assert.equal(full.version, 1);
  assert.equal(full.draft.dirty, false);

  // écrire le brouillon sans verrou est refusé
  const xml2 = full.xml.replace('name="Début"', 'name="Départ"');
  const xml3 = xml2.replace('name="Départ"', 'name="Demande reçue"');
  assert.equal((await call('PUT', `/api/diagrams/${d.id}/draft`, { cookie: aliceCookie, body: { xml: xml2, holder: 'A' } })).statusCode, 423);

  assert.equal((await call('POST', `/api/diagrams/${d.id}/lock`, { cookie: aliceCookie, body: { holder: 'A' } })).json().acquired, true);
  const other = (await call('POST', `/api/diagrams/${d.id}/lock`, { cookie: adminCookie, body: { holder: 'B' } })).json();
  assert.equal(other.acquired, false);
  assert.equal(other.lock.author, 'Alice Martin');

  // deux étapes de brouillon : aucun commit Git
  const commitsBefore = git(join(tmp, 'repo'), 'rev-list', '--count', 'HEAD').trim();
  let r = (await call('PUT', `/api/diagrams/${d.id}/draft`, { cookie: aliceCookie, body: { xml: xml2, holder: 'A', label: 'Renommer le début' } })).json();
  assert.equal(r.dirty, true);
  r = (await call('PUT', `/api/diagrams/${d.id}/draft`, { cookie: aliceCookie, body: { xml: xml3, holder: 'A', label: 'Préciser le début' } })).json();
  assert.equal(git(join(tmp, 'repo'), 'rev-list', '--count', 'HEAD').trim(), commitsBefore, 'pas de commit pendant l\'édition');
  assert.match((await call('GET', `/api/diagrams/${d.id}`, { cookie: adminCookie })).json().xml, /Demande reçue/, 'le brouillon est visible des autres');

  // annuler / rétablir
  let u = (await call('POST', `/api/diagrams/${d.id}/undo`, { cookie: aliceCookie, body: { holder: 'A' } })).json();
  assert.match(u.xml, /name="Départ"/);
  assert.match(u.label, /Préciser le début/);
  u = (await call('POST', `/api/diagrams/${d.id}/undo`, { cookie: aliceCookie, body: { holder: 'A' } })).json();
  assert.match(u.xml, /name="Début"/);
  assert.equal(u.draft.dirty, false);
  assert.equal((await call('POST', `/api/diagrams/${d.id}/undo`, { cookie: aliceCookie, body: { holder: 'A' } })).statusCode, 409, 'rien avant la version enregistrée');
  u = (await call('POST', `/api/diagrams/${d.id}/redo`, { cookie: aliceCookie, body: { holder: 'A' } })).json();
  assert.match(u.xml, /name="Départ"/);
  assert.equal((await call('POST', `/api/diagrams/${d.id}/undo`, { cookie: adminCookie, body: {} })).statusCode, 423, 'un autre ne peut pas annuler pendant qu\'Alice modifie');

  // version Git à la demande
  const c = await call('POST', `/api/diagrams/${d.id}/commit`, { cookie: aliceCookie, body: { message: 'Renommage du début' } });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().version, 2);
  assert.equal(c.json().draft.dirty, false);
  assert.equal((await call('POST', `/api/diagrams/${d.id}/commit`, { cookie: aliceCookie, body: { message: 'x' } })).statusCode, 409, 'rien à enregistrer');

  const versions = (await call('GET', `/api/diagrams/${d.id}/versions`, { cookie: aliceCookie })).json();
  assert.deepEqual(versions.map(v => [v.version, v.author, v.email]), [[2, 'Alice Martin', 'alice@test.fr'], [1, 'Alice Martin', 'alice@test.fr']]);
  assert.equal(versions[0].message, 'Renommage du début');
  const v1 = (await call('GET', `/api/diagrams/${d.id}/versions/${versions[1].sha}`, { cookie: aliceCookie })).json();
  assert.match(v1.xml, /name="Début"/);
  assert.match(git(join(tmp, 'repo'), 'log', '-1', '--format=%an <%ae>'), /Alice Martin <alice@test.fr>/);

  // retour à une version : dans le brouillon, annulable
  const back = (await call('POST', `/api/diagrams/${d.id}/restore`, { cookie: aliceCookie, body: { holder: 'A', sha: versions[1].sha.slice(0, 7) } })).json();
  assert.match(back.xml, /name="Début"/);
  assert.equal(back.draft.dirty, true);
  await call('POST', `/api/diagrams/${d.id}/undo`, { cookie: aliceCookie, body: { holder: 'A' } });
  await call('POST', `/api/diagrams/${d.id}/unlock`, { cookie: aliceCookie, body: { holder: 'A' } });
});

test('renommage avec git mv : l\'historique suit', async () => {
  const r = await call('PATCH', `/api/diagrams/${diagramId}`, { cookie: aliceCookie, body: { name: 'Souscription AV' } });
  assert.equal(r.json().path, 'diagrams/souscription-av.bpmn');
  const versions = (await call('GET', `/api/diagrams/${diagramId}/versions`, { cookie: aliceCookie })).json();
  assert.equal(versions.length, 3);
  const old = (await call('GET', `/api/diagrams/${diagramId}/versions/${versions[2].sha}`, { cookie: aliceCookie })).json();
  assert.match(old.xml, /name="Début"/, 'une version d\'avant le renommage reste lisible');
});

test('push vers le dépôt distant, puis clone par une autre instance', async () => {
  assert.ok(await waitFor(() => app.git.status.lastPushAt), 'push effectué');
  assert.match(git(remote, 'log', '--format=%s', 'main'), /Renommage/);

  const other = await buildApp(config({ dbFile: join(tmp, 'db2.sqlite'), gitDir: join(tmp, 'repo2') }));
  const { cookie } = await loginAs(ADMIN.email, ADMIN.password, other);
  const list = (await other.inject({ method: 'GET', url: '/api/diagrams', headers: { cookie } })).json();
  assert.deepEqual(list.map(d => d.path), ['diagrams/souscription-av.bpmn']);
  await other.close();
});

test('synchronisation : un fichier ajouté directement dans le dépôt apparaît', async () => {
  const work = join(tmp, 'work');
  execFileSync('git', ['clone', '-q', remote, work]);
  execFileSync('sh', ['-c', `mkdir -p "${work}/diagrams" && cat > "${work}/diagrams/processus-externe.bpmn"`], { input: emptyDiagram('Externe') });
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Ajout externe');
  git(work, 'push', '-q', 'origin', 'main');

  const r = (await call('POST', '/api/admin/git/sync', { cookie: adminCookie })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.added, 1);
  const list = (await call('GET', '/api/diagrams', { cookie: aliceCookie })).json();
  assert.ok(list.some(d => d.name === 'Processus externe'));
});

test('suppression réservée à l\'administrateur', async () => {
  const d = (await call('POST', '/api/diagrams', { cookie: aliceCookie, body: { name: 'Temporaire' } })).json();
  assert.equal((await call('DELETE', `/api/diagrams/${d.id}`, { cookie: aliceCookie })).statusCode, 403);
  assert.equal((await call('DELETE', `/api/diagrams/${d.id}`, { cookie: adminCookie })).statusCode, 200);
  assert.match(git(join(tmp, 'repo'), 'log', '-1', '--format=%s'), /Suppression : Temporaire/);
});

test('import : XML invalide refusé', async () => {
  const r = await call('POST', '/api/diagrams', { cookie: aliceCookie, body: { name: 'X', xml: '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><oops' } });
  assert.equal(r.statusCode, 400);
});

test('assistant : réponse en flux, diagramme sans DI joint au dernier message', async () => {
  const xml = emptyDiagram('IA');
  const r = await call('POST', `/api/diagrams/${diagramId}/chat`, { cookie: aliceCookie, body: {
    xml, mode: 'chat', selection: [{ id: 'StartEvent_1', name: 'Début' }],
    history: [{ role: 'user', content: 'Que penses-tu du diagramme ?' }, { role: 'assistant', content: 'Il est court.' }, { role: 'user', content: 'Propose une suite' }]
  } });
  assert.equal(r.statusCode, 200);
  const events = r.body.split('\n\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Bonjour, je regarde le diagramme.');
  assert.equal(events.at(-1).type, 'done');
  const sent = llmCalls.at(-1);
  assert.equal(sent.stream, true);
  assert.equal(sent.messages.length, 3);
  assert.match(sent.messages[2].content, /<diagram>/);
  assert.doesNotMatch(sent.messages[2].content, /BPMNDiagram/, 'la DI est retirée');
  assert.match(sent.messages[2].content, /StartEvent_1/);
  assert.doesNotMatch(sent.messages[0].content, /<diagram>/, 'le diagramme n\'est joint qu\'au dernier message');
});

test('migration depuis l\'ancien stockage SQLite vers Git', async () => {
  const file = join(tmp, 'legacy.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE diagrams (id TEXT PRIMARY KEY, name TEXT, version INTEGER, xml TEXT, created_at INTEGER, updated_at INTEGER, updated_by TEXT, lock_holder TEXT, lock_author TEXT, lock_since INTEGER, lock_expires INTEGER);
    CREATE TABLE versions (diagram_id TEXT, version INTEGER, xml TEXT, author TEXT, message TEXT, created_at INTEGER);
    CREATE TABLE shares (token TEXT);`);
  old.prepare('INSERT INTO diagrams VALUES (?, ?, 2, ?, 1, 2, ?, NULL, NULL, NULL, NULL)').run('legacy1', 'Ancien', emptyDiagram('v2'), 'Bob');
  old.prepare('INSERT INTO versions VALUES (?, 1, ?, ?, ?, ?)').run('legacy1', emptyDiagram('v1'), 'Administrateur', 'Création', Date.UTC(2026, 10, 20));
  old.prepare('INSERT INTO versions VALUES (?, 2, ?, ?, ?, ?)').run('legacy1', emptyDiagram('v2'), 'Bob', 'Ajout', Date.UTC(2026, 10, 21));
  old.close();
  const m = await buildApp(config({ dbFile: file, gitDir: join(tmp, 'repo-mig'), gitRemote: null }));
  const { cookie } = await loginAs(ADMIN.email, ADMIN.password, m);
  const versions = (await m.inject({ method: 'GET', url: '/api/diagrams/legacy1/versions', headers: { cookie } })).json();
  assert.deepEqual(versions.map(v => [v.version, v.author, v.message]), [[2, 'Bob', 'Ajout'], [1, 'Administrateur', 'Création']]);
  assert.equal(new Date(versions[1].createdAt).toISOString().slice(0, 10), '2026-11-20', 'dates d\'origine conservées');
  await m.close();
});
