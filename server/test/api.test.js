import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

let app;
const ADMIN = { email: 'admin@test', password: 'admin-pass', name: 'Admin' };
const config = (over = {}) => ({
  dbFile: join(tmp, 'db.sqlite'), gitDir: join(tmp, 'repo'), gitRemote: remote, gitSyncSeconds: 0,
  admin: ADMIN, secureCookies: 'auto',
  ...over
});

before(async () => {
  app = await buildApp(config());
});
after(async () => { await app.close(); rmSync(tmp, { recursive: true, force: true }); });

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

test('dupliquer : la copie reprend le brouillon courant, nom rendu unique', async () => {
  const d = (await call('POST', '/api/diagrams', { cookie: aliceCookie, body: { name: 'Source copie' } })).json();
  const full = (await call('GET', `/api/diagrams/${d.id}`, { cookie: aliceCookie })).json();
  assert.equal((await call('POST', `/api/diagrams/${d.id}/lock`, { cookie: aliceCookie, body: { holder: 'D' } })).json().acquired, true);
  const draft = full.xml.replace('name="Début"', 'name="Brouillon en cours"');
  await call('PUT', `/api/diagrams/${d.id}/draft`, { cookie: aliceCookie, body: { xml: draft, holder: 'D' } });
  const c1 = await call('POST', `/api/diagrams/${d.id}/duplicate`, { cookie: aliceCookie, body: {} });
  assert.equal(c1.statusCode, 201);
  assert.equal(c1.json().name, 'Source copie (copie)');
  const copy = (await call('GET', `/api/diagrams/${c1.json().id}`, { cookie: aliceCookie })).json();
  assert.match(copy.xml, /Brouillon en cours/, 'le brouillon est copié');
  assert.equal(copy.version, 1);
  assert.equal(copy.draft.dirty, false, 'la copie démarre propre');
  const c2 = (await call('POST', `/api/diagrams/${d.id}/duplicate`, { cookie: aliceCookie, body: {} })).json();
  assert.equal(c2.name, 'Source copie (copie 2)');
  const c3 = (await call('POST', `/api/diagrams/${d.id}/duplicate`, { cookie: aliceCookie, body: { name: 'Variante B' } })).json();
  assert.equal(c3.name, 'Variante B');
  assert.match((await call('GET', `/api/diagrams/${d.id}`, { cookie: aliceCookie })).json().xml, /Brouillon en cours/, 'l\'original est intact');
  assert.equal((await call('POST', '/api/diagrams/inconnu/duplicate', { cookie: aliceCookie, body: {} })).statusCode, 404);
  assert.equal((await call('POST', `/api/diagrams/${d.id}/duplicate`, { body: {} })).statusCode, 401);
  await call('POST', `/api/diagrams/${d.id}/unlock`, { cookie: aliceCookie, body: { holder: 'D' } });
  for (const x of [d, c1.json(), c2, c3]) assert.equal((await call('DELETE', `/api/diagrams/${x.id}`, { cookie: adminCookie })).statusCode, 200);
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

test('invitation : lien à usage unique, mot de passe choisi par la personne, compte actif', async () => {
  // réservé à l'administrateur
  assert.equal((await call('POST', '/api/invitations', { cookie: aliceCookie, body: { email: 'bob@test.fr' } })).statusCode, 403);
  assert.equal((await call('POST', '/api/invitations', { cookie: adminCookie, body: { email: 'pas-un-mail' } })).statusCode, 400);
  assert.equal((await call('POST', '/api/invitations', { cookie: adminCookie, body: { email: 'alice@test.fr' } })).statusCode, 409, 'compte déjà existant');
  const first = (await call('POST', '/api/invitations', { cookie: adminCookie, body: { email: 'bob@test.fr', name: 'Bob' } })).json();
  assert.ok(first.token && first.id);
  // une nouvelle invitation pour la même adresse remplace l'ancienne
  const inv = (await call('POST', '/api/invitations', { cookie: adminCookie, body: { email: 'bob@test.fr' } })).json();
  assert.equal((await call('GET', `/api/invite/${first.token}`)).statusCode, 404, 'l\'ancien lien ne marche plus');
  const list = (await call('GET', '/api/invitations', { cookie: adminCookie })).json();
  assert.equal(list.filter(i => i.email === 'bob@test.fr').length, 1);
  assert.ok(!JSON.stringify(list).includes(inv.token), 'le jeton n\'est jamais relisté');
  // lecture publique du lien, puis acceptation
  const open = await call('GET', `/api/invite/${inv.token}`);
  assert.equal(open.statusCode, 200);
  assert.equal(open.json().email, 'bob@test.fr');
  assert.equal((await call('POST', `/api/invite/${inv.token}`, { body: { name: 'Bob Dupont', password: 'court' } })).statusCode, 400);
  const ok = await call('POST', `/api/invite/${inv.token}`, { body: { name: 'Bob Dupont', password: 'motdepasse-bob' } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().user.status, 'active');
  const cookie = ok.headers['set-cookie']?.split(';')[0];
  assert.equal((await call('GET', '/api/config', { cookie })).json().user.email, 'bob@test.fr', 'connecté directement');
  // usage unique ; connexion ensuite avec e-mail + mot de passe choisi
  assert.equal((await call('POST', `/api/invite/${inv.token}`, { body: { name: 'X', password: 'autre-motdepasse' } })).statusCode, 410);
  assert.equal((await loginAs('bob@test.fr', 'motdepasse-bob')).r.statusCode, 200);
  assert.equal((await call('GET', '/api/invitations', { cookie: adminCookie })).json().filter(i => i.email === 'bob@test.fr').length, 0, 'plus en attente');
  // nouveau lien et annulation
  const c = (await call('POST', '/api/invitations', { cookie: adminCookie, body: { email: 'carol@test.fr' } })).json();
  const r2 = (await call('POST', `/api/invitations/${c.id}/renew`, { cookie: adminCookie })).json();
  assert.notEqual(r2.token, c.token);
  assert.equal((await call('GET', `/api/invite/${c.token}`)).statusCode, 404);
  assert.equal((await call('GET', `/api/invite/${r2.token}`)).statusCode, 200);
  assert.equal((await call('DELETE', `/api/invitations/${c.id}`, { cookie: adminCookie })).statusCode, 200);
  assert.equal((await call('GET', `/api/invite/${r2.token}`)).statusCode, 404, 'annulée : le lien ne marche plus');
});
