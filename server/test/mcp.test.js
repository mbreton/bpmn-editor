import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../app.js';

const tmp = mkdtempSync(join(tmpdir(), 'bpmn-mcp-'));
const onboarding = readFileSync(new URL('./fixtures/onboarding.bpmn', import.meta.url), 'utf8');
let app, base, cookie, diagramId, tokens, client, browser;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const http = (method, path, { body, headers = {}, form } = {}) => fetch(base + path, {
  method, redirect: 'manual',
  headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined
});

before(async () => {
  app = await buildApp({ dbFile: join(tmp, 'db.sqlite'), gitDir: join(tmp, 'repo'), admin: { email: 'mathieu@test.fr', password: 'motdepasse', name: 'Mathieu' }, secureCookies: 'auto' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const r = await http('POST', '/api/login', { body: { email: 'mathieu@test.fr', password: 'motdepasse' } });
  cookie = r.headers.get('set-cookie').split(';')[0];
  diagramId = (await (await http('POST', '/api/diagrams', { body: { name: 'Onboarding', xml: onboarding } })).json()).id;
});
after(async () => { await client?.close(); browser?.close(); await app.close(); rmSync(tmp, { recursive: true, force: true }); });

test('OAuth : découverte, enregistrement, consentement, PKCE, rotation', async () => {
  const unauth = await http('POST', '/mcp', { body: {}, headers: { cookie: '' } });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  const prm = await (await http('GET', '/.well-known/oauth-protected-resource')).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const asm = await (await http('GET', '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);

  const reg = await (await http('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' } })).json();
  assert.ok(reg.client_id);
  assert.equal((await http('POST', '/oauth/register', { body: { redirect_uris: ['http://evil.example/cb'] } })).status, 400, 'pas de redirection HTTP non locale');

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const qs = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'diagrams', resource: `${base}/mcp` });

  // sans session : renvoi vers la connexion de l'application
  const noSession = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: 'manual' });
  assert.equal(noSession.status, 302);
  assert.match(noSession.headers.get('location'), /^\/\?next=%2Foauth%2Fauthorize/);

  const consent = await http('GET', `/oauth/authorize?${qs}`);
  const html = await consent.text();
  assert.match(html, /Claude.*demande à accéder/s);
  const tx = /name="tx" value="([^"]+)"/.exec(html)[1];
  const allow = await http('POST', '/oauth/authorize', { form: { tx, decision: 'allow' } });
  assert.equal(allow.status, 302);
  const loc = new URL(allow.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');

  const bad = await http('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: 'mauvais' } });
  assert.equal(bad.status, 400, 'PKCE vérifié');
  // le code est à usage unique : il a été consommé par la tentative ratée → on recommence
  const allow2 = await http('POST', '/oauth/authorize', { form: { tx, decision: 'allow' } });
  const code2 = new URL(allow2.headers.get('location')).searchParams.get('code');
  tokens = await (await http('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier } })).json();
  assert.ok(tokens.access_token && tokens.refresh_token);

  const refreshed = await (await http('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id } })).json();
  assert.ok(refreshed.access_token);
  const reuse = await http('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id } });
  assert.equal(reuse.status, 400, 'rotation : un jeton de rafraîchissement ne sert qu\'une fois');
  tokens = refreshed;

  const conns = await (await http('GET', '/api/me/connections')).json();
  assert.equal(conns.mcpUrl, `${base}/mcp`);
  assert.equal(conns.grants[0].name, 'Claude');
});

/** Navigateur simulé : reçoit les demandes du serveur et y répond comme le ferait l'éditeur. */
function fakeBrowser() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws`, { headers: { cookie } });
  const received = [];
  ws.on('message', async raw => {
    const m = JSON.parse(raw);
    received.push(m);
    if (m.type === 'apply') {
      await http('POST', `/api/diagrams/${diagramId}/lock`, { body: { holder: 'tab1' } });
      const cur = await (await http('GET', `/api/diagrams/${diagramId}`)).json();
      // « Casser » simule une modification qui rend un délai illisible
      const xml = m.changes[0].title === 'Casser' ? cur.xml.replace('R3/P1D', '3 fois par jour') : cur.xml.replace('name="Signer le contrat"', 'name="Signer électroniquement"');
      const res = await http('PUT', `/api/diagrams/${diagramId}/draft`, { body: { xml, holder: 'tab1', label: `Claude : ${m.changes.map(c => c.title).join(' ; ')}`, via: 'claude' } });
      const body = await res.json();
      const results = m.changes.map(c => ({ title: c.title, ok: true, added: [] }));
      ws.send(JSON.stringify(res.status === 422 ? { type: 'response', reqId: m.reqId, ok: false, rejected: true, issues: body.issues, results } : { type: 'response', reqId: m.reqId, ok: true, results, check: body.check }));
    }
    if (m.type === 'render') ws.send(JSON.stringify({ type: 'response', reqId: m.reqId, ok: true, png: Buffer.from('png').toString('base64'), caption: 'Vue entière' }));
  });
  return new Promise(resolve => ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', diagramId, holder: 'tab1' }));
    ws.send(JSON.stringify({ type: 'state', editing: true }));
    resolve({ ws, received, close: () => ws.close() });
  }));
}

test('MCP : lire, modifier à l\'écran, annuler, enregistrer, explorer, voir', async () => {
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['apply_changes', 'create_diagram', 'delete_user', 'duplicate_diagram', 'explore', 'get_diagram', 'history', 'invite_user', 'list_diagrams', 'list_users', 'manage_invitation', 'redo', 'relayout', 'restore_version', 'save_version', 'show', 'undo', 'update_user', 'view_diagram'], 'compte administrateur : outils d\'administration présents');
  const call = async (name, args) => (await client.callTool({ name, arguments: args }));
  const txt = r => r.content.map(c => c.text || '').join('\n');

  assert.match(txt(await call('list_diagrams', {})), /Onboarding \[id /);
  const summary = txt(await call('get_diagram', { diagram: 'onboarding' }));
  assert.match(summary, /\[Task_KYC\] Tâche utilisateur « Collecter les pièces KYC »/);
  assert.match(summary, /\[Timer_Relance\].*timeCycle=R3\/P1D.*sur Task_KYC \(non interrompant\)/);
  assert.match(summary, /Cohérence :|Aucun problème/);

  // pas de navigateur ouvert : message clair
  const closed = await call('apply_changes', { diagram: diagramId, changes: [{ title: 'Test', ops: [{ op: 'update', id: 'Task_Signer', name: 'x' }] }] });
  assert.equal(closed.isError, true);
  assert.match(txt(closed), /n'est ouvert dans aucun de vos navigateurs/);

  browser = await fakeBrowser();
  // une modification qui casse le workflow est refusée, avec l'explication ; rien n'est écrit
  const seqBefore = (await (await http('GET', `/api/diagrams/${diagramId}`)).json()).draft.seq;
  const broken = await call('apply_changes', { diagram: diagramId, changes: [{ title: 'Casser', ops: [{ op: 'set_timer', id: 'Timer_Relance', kind: 'timeCycle', value: '3 fois par jour' }] }] });
  assert.equal(broken.isError, true);
  assert.match(txt(broken), /Rien n'a été appliqué.*\n- \[Timer_Relance\].*délai invalide/s);
  assert.equal((await (await http('GET', `/api/diagrams/${diagramId}`)).json()).draft.seq, seqBefore, 'brouillon inchangé');

  const applied = await call('apply_changes', { diagram: diagramId, changes: [{ title: 'Signature électronique', ops: [{ op: 'update', id: 'Task_Signer', name: 'Signer électroniquement' }] }] });
  assert.match(txt(applied), /✓ Signature électronique/);
  const ms = Number(/contrôle : ([\d.]+) ms/.exec(txt(applied))[1]);
  assert.ok(ms < 300, `contrôle rapide (${ms} ms)`);
  let d = await (await http('GET', `/api/diagrams/${diagramId}`)).json();
  assert.match(d.xml, /Signer électroniquement/);
  assert.equal(d.draft.dirty, true);
  assert.match(d.draft.updatedBy, /\(via Claude\)/);

  const undone = await call('undo', { diagram: diagramId });
  assert.match(txt(undone), /Annulé : Claude : Signature électronique/);
  d = await (await http('GET', `/api/diagrams/${diagramId}`)).json();
  assert.doesNotMatch(d.xml, /Signer électroniquement/);
  assert.ok(browser.received.some(m => m.type === 'draft' && /Annulé/.test(m.label)), 'la page reçoit l\'annulation');
  await call('redo', { diagram: diagramId });

  const saved = await call('save_version', { diagram: diagramId, message: 'Signature électronique' });
  assert.match(txt(saved), /Version 2 enregistrée/);
  assert.ok(browser.received.some(m => m.type === 'commit'));

  await call('show', { diagram: diagramId, element_ids: ['Task_KYC'] });
  assert.ok(browser.received.some(m => m.type === 'focus' && m.ids[0] === 'Task_KYC'));

  let ex = txt(await call('explore', { diagram: diagramId, action: 'start' }));
  const startId = /- (start:[^ ]+) :/.exec(ex)[1];
  ex = txt(await call('explore', { diagram: diagramId, action: 'choose', option_id: startId }));
  assert.match(ex, /Valider la demande.*se termine/);
  assert.ok(browser.received.some(m => m.type === 'explore' && m.choices.length === 1));
  ex = txt(await call('explore', { diagram: diagramId, action: 'back' }));
  assert.match(ex, /Démarrer par/);

  const img = await call('view_diagram', { diagram: diagramId });
  assert.equal(img.content[0].type, 'image');
  assert.equal(img.content[0].mimeType, 'image/png');

  assert.match(txt(await call('history', { diagram: diagramId })), /v2 .* Mathieu · Signature électronique/);

  // réorganisation : une étape du brouillon, visible à l'écran, annulable
  const lay = await call('relayout', { diagram: diagramId });
  assert.match(txt(lay), /Disposition recalculée en \d+ ms/);
  assert.ok(browser.received.some(m => m.type === 'draft' && m.label === 'Réorganisation automatique'));
  assert.match(txt(await call('undo', { diagram: diagramId })), /Annulé : Réorganisation automatique/);
});

/** Jeton OAuth pour le compte connecté avec ce cookie (même parcours que Claude). */
async function tokenFor(userCookie) {
  const h = (m, p, o = {}) => http(m, p, { ...o, headers: { ...(o.headers || {}), cookie: userCookie } });
  const reg = await (await h('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' } })).json();
  const verifier = randomBytes(32).toString('base64url');
  const qs = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'diagrams', resource: `${base}/mcp` });
  const tx = /name="tx" value="([^"]+)"/.exec(await (await h('GET', `/oauth/authorize?${qs}`)).text())[1];
  const code = new URL((await h('POST', '/oauth/authorize', { form: { tx, decision: 'allow' } })).headers.get('location')).searchParams.get('code');
  return (await (await h('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier } })).json()).access_token;
}

test('MCP : administration des comptes (invitation, rôle, suppression), réservée aux administrateurs', async () => {
  const c = new Client({ name: 'test-admin', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  const txt = async (name, args) => (await c.callTool({ name, arguments: args })).content.map(x => x.text || '').join('\n');

  assert.match(await txt('list_users', {}), /Mathieu <mathieu@test\.fr> · administrateur · actif · vous/);
  assert.match(await txt('invite_user', { email: 'pas-un-mail' }), /invalide/);
  const inv = await txt('invite_user', { email: 'zoe@test.fr', name: 'Zoé' });
  const link = /(http\S+\/invite\/[\w-]+)/.exec(inv)?.[1];
  assert.ok(link?.startsWith(base), 'lien d\'invitation complet : ' + inv);
  assert.match(await txt('list_users', {}), /zoe@test\.fr \(Zoé\) · valable jusqu'au/);
  // la personne accepte avec le lien donné par le connecteur
  const token = link.split('/invite/')[1];
  const acc = await http('POST', `/api/invite/${token}`, { body: { name: 'Zoé Martin', password: 'motdepasse-zoe' }, headers: { cookie: '' } });
  assert.equal(acc.status, 201);
  const zoeCookie = acc.headers.get('set-cookie').split(';')[0];

  assert.match(await txt('update_user', { user: 'mathieu@test.fr', role: 'user' }), /propres droits/, 'pas de retrait de ses propres droits');
  assert.match(await txt('update_user', { user: 'Zoé Martin', role: 'admin' }), /Zoé Martin <zoe@test\.fr> : administrateur, actif/);
  assert.match(await txt('update_user', { user: 'zoe@test.fr', role: 'user' }), /utilisateur, actif/);
  assert.match(await txt('update_user', { user: 'inconnu@test.fr', status: 'disabled' }), /introuvable/);

  // un compte non administrateur ne voit pas ces outils
  const zt = await tokenFor(zoeCookie);
  const zc = new Client({ name: 'test-zoe', version: '1.0.0' });
  await zc.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${zt}` } } }));
  const zNames = (await zc.listTools()).tools.map(t => t.name);
  assert.ok(zNames.includes('list_diagrams') && !zNames.some(n => ['list_users', 'invite_user', 'update_user', 'delete_user', 'manage_invitation'].includes(n)), 'utilisateur : pas d\'outils d\'administration');
  await zc.close();

  // suppression : rien sans confirmation explicite
  assert.match(await txt('delete_user', { user: 'zoe@test.fr', confirm: false }), /Rien n'a été supprimé/);
  assert.match(await txt('list_users', {}), /zoe@test\.fr/);
  assert.match(await txt('delete_user', { user: 'zoe@test.fr', confirm: true }), /supprimé/);
  assert.doesNotMatch(await txt('list_users', {}), /zoe@test\.fr/);
  // invitation renouvelée puis annulée
  await txt('invite_user', { email: 'yann@test.fr' });
  const renewed = await txt('manage_invitation', { invitation: 'yann@test.fr', action: 'renew' });
  assert.match(renewed, /Nouveau lien pour yann@test\.fr/);
  assert.match(await txt('manage_invitation', { invitation: 'yann@test.fr', action: 'cancel' }), /annulée/);
  assert.equal((await http('GET', `/api/invite/${/\/invite\/([\w-]+)/.exec(renewed)[1]}`)).status, 404);
  await c.close();
});

test('MCP : accès révoqué', async () => {
  const conns = await (await http('GET', '/api/me/connections')).json();
  await http('DELETE', `/api/me/connections/${conns.grants[0].clientId}`);
  const r = await http('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { cookie: '', authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' } });
  assert.equal(r.status, 401);
});
