import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb } from './db.js';
import { createAuth } from './auth.js';
import { createGitStore, GitError } from './git.js';
import { createDiagrams } from './diagrams.js';
import { checkBpmn } from './validate.js';
import { createHub } from './realtime.js';
import { registerOAuth } from './oauth.js';
import { createMcp } from './mcp.js';
import { checkDiagram } from './coherence.js';
import { relayout } from './layout.js';
import { newErrors, formatIssue } from '../shared/coherence.js';

const MAX_XML = 1_500_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function buildApp(config) {
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 4 * 1024 * 1024, trustProxy: config.trustProxy ?? true });
  const log = config.logger ? app.log : { info() {}, error() {}, warn() {} };
  const db = openDb(config.dbFile);
  const auth = createAuth({ db, sessionSecret: config.sessionSecret, secureCookies: config.secureCookies ?? 'auto' });
  const git = createGitStore({ dir: config.gitDir, remote: config.gitRemote, branch: config.gitBranch || 'main', subdir: config.gitSubdir || 'diagrams', log });
  const diagrams = createDiagrams({ db, git });
  // version de l'interface servie : une page ouverte avant un déploiement se recharge d'elle-même
  const indexFile = config.webRoot && join(config.webRoot, 'index.html');
  const build = indexFile && existsSync(indexFile) ? createHash('sha256').update(readFileSync(indexFile)).digest('hex').slice(0, 12) : 'dev';
  const hub = createHub({ log, build });
  const mcp = createMcp({ db, diagrams, hub, checkDiagram, layout: (d, user) => layoutDraft(d, user, { source: 'mcp' }) });

  // ---------- démarrage : dépôt, migration, index, administrateur ----------
  await git.init();
  if (config.gitRemote) {
    const p = await git.pull();
    if (!p.ok) log.error(`[git] ${p.error}`);
  }
  await diagrams.migrateLegacy(log);
  await diagrams.reindex();
  if (config.admin?.password) auth.bootstrapAdmin(config.admin);

  let syncTimer = null;
  if (config.gitRemote && config.gitSyncSeconds > 0) {
    syncTimer = setInterval(async () => {
      const p = await git.pull().catch(e => ({ ok: false, error: e.message }));
      if (p.ok && p.changed) await diagrams.reindex().catch(() => {});
    }, config.gitSyncSeconds * 1000);
    syncTimer.unref();
  }

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(fastifyWebsocket);
  const oauth = registerOAuth(app, { db, auth, publicUrl: config.publicUrl, secret: auth.secret });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  // ---------- helpers ----------
  const fail = (reply, status, error, extra = {}) => reply.code(status).send({ error, ...extra });
  const str = (v, max = 200, min = 1) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
  const isXml = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_XML && v.includes('definitions');

  function requireUser(req, reply) {
    const u = auth.currentUser(req);
    if (!u) { fail(reply, 401, 'Connexion requise.'); return null; }
    req.user = u;
    return u;
  }
  function requireAdmin(req, reply) {
    const u = requireUser(req, reply);
    if (!u) return null;
    if (u.role !== 'admin') { fail(reply, 403, 'Réservé aux administrateurs.'); return null; }
    return u;
  }
  const gitFail = (reply, e) => {
    log.error(e);
    return fail(reply, 500, e instanceof GitError ? `Erreur Git : ${e.message}` : 'Erreur interne.');
  };

  // ---------- santé, configuration ----------
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/config', async req => {
    const u = auth.currentUser(req);
    return {
      user: u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null,
      pendingUsers: u?.role === 'admin' ? db.countPending() : undefined,
      git: { remote: !!config.gitRemote, branch: git.status.branch },
      build
    };
  });

  // ---------- comptes ----------
  app.post('/api/register', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { name, email, password } = req.body || {};
    if (!str(name, 80, 2)) return fail(reply, 400, 'Nom requis (2 à 80 caractères).');
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 200) return fail(reply, 400, 'Adresse e-mail invalide.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return fail(reply, 400, 'Mot de passe : 8 caractères minimum.');
    if (db.userAuthByEmail(email.trim())) return fail(reply, 409, 'Un compte existe déjà avec cette adresse.');
    db.createUser({ email: email.trim(), name: name.trim(), passwordHash: auth.hashPassword(password) });
    return reply.code(201).send({ ok: true, status: 'pending' });
  });

  app.post('/api/login', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const r = auth.login(req.body?.email, req.body?.password);
    if (r.error) return fail(reply, r.status, r.error);
    auth.issueSession(reply, req, r.user);
    return { user: r.user };
  });

  app.post('/api/logout', async (req, reply) => { auth.clearSession(reply); return { ok: true }; });

  app.patch('/api/me', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const { name, password, currentPassword } = req.body || {};
    const fields = {};
    if (name !== undefined) { if (!str(name, 80, 2)) return fail(reply, 400, 'Nom requis (2 à 80 caractères).'); fields.name = name.trim(); }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) return fail(reply, 400, 'Mot de passe : 8 caractères minimum.');
      const row = db.userAuthByEmail(u.email);
      if (!auth.verifyPassword(String(currentPassword ?? ''), row.password_hash)) return fail(reply, 403, 'Mot de passe actuel incorrect.');
      fields.passwordHash = auth.hashPassword(password);
    }
    return db.updateUser(u.id, fields);
  });

  // ---------- administration des comptes ----------
  app.get('/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return db.listUsers();
  });

  app.patch('/api/users/:uid', async (req, reply) => {
    const admin = requireAdmin(req, reply); if (!admin) return;
    const target = db.userById(req.params.uid);
    if (!target) return fail(reply, 404, 'Compte introuvable.');
    const { status, role } = req.body || {};
    if (status !== undefined && !['active', 'disabled', 'pending'].includes(status)) return fail(reply, 400, 'Statut invalide.');
    if (role !== undefined && !['user', 'admin'].includes(role)) return fail(reply, 400, 'Rôle invalide.');
    if (target.id === admin.id && ((status && status !== 'active') || role === 'user')) return fail(reply, 400, 'Vous ne pouvez pas retirer vos propres droits.');
    const fields = { status, role };
    if (status === 'active' && target.status === 'pending') fields.approvedBy = admin.id;
    return db.updateUser(target.id, fields);
  });

  app.delete('/api/users/:uid', async (req, reply) => {
    const admin = requireAdmin(req, reply); if (!admin) return;
    if (req.params.uid === admin.id) return fail(reply, 400, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (!db.deleteUser(req.params.uid)) return fail(reply, 404, 'Compte introuvable.');
    return { ok: true };
  });

  // ---------- dépôt Git ----------
  app.get('/api/admin/git', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ...git.status };
  });

  app.post('/api/admin/git/sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const p = await git.sync();
      const r = await diagrams.reindex();
      return { ...p, ...r, status: git.status };
    } catch (e) { return gitFail(reply, e); }
  });

  // ---------- diagrammes ----------
  app.get('/api/diagrams', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return diagrams.list();
  });

  app.post('/api/diagrams', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const { name, xml } = req.body || {};
    if (!str(name)) return fail(reply, 400, 'Nom requis (200 caractères max).');
    if (xml !== undefined) {
      if (!isXml(xml)) return fail(reply, 400, 'Fichier BPMN invalide ou trop volumineux.');
      const err = await checkBpmn(xml);
      if (err) return fail(reply, 400, err);
    }
    try { return reply.code(201).send(await diagrams.create({ name: name.trim(), xml, user: u })); }
    catch (e) { return gitFail(reply, e); }
  });

  app.get('/api/diagrams/:id', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    try {
      const d = await diagrams.get(req.params.id);
      if (!d) return fail(reply, 404, 'Diagramme introuvable.');
      return { ...d, check: await report(d.xml) };
    } catch (e) { return gitFail(reply, e); }
  });

  app.patch('/api/diagrams/:id', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    if (!str(req.body?.name)) return fail(reply, 400, 'Nom requis.');
    try {
      const d = await diagrams.rename(req.params.id, req.body.name.trim(), u);
      return d || fail(reply, 404, 'Diagramme introuvable.');
    } catch (e) { return gitFail(reply, e); }
  });

  app.delete('/api/diagrams/:id', async (req, reply) => {
    const u = requireAdmin(req, reply); if (!u) return;
    try {
      if (!(await diagrams.remove(req.params.id, u))) return fail(reply, 404, 'Diagramme introuvable.');
      return { ok: true };
    } catch (e) { return gitFail(reply, e); }
  });

  // ---------- brouillon (sauvegarde continue), annuler/rétablir, versions ----------
  const holdsLock = (d, holder) => d.lock && d.lock.holder === holder;
  const report = async xml => { const r = await checkDiagram(xml); return { issues: r.issues, ms: r.ms }; };
  const lockedByOther = (d, u) => d.lock && d.lock.userId !== u.id;

  app.put('/api/diagrams/:id/draft', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const { xml, holder, label, via } = req.body || {};
    if (!isXml(xml)) return fail(reply, 400, 'XML BPMN invalide ou trop volumineux.');
    const d = db.getDiagram(req.params.id);
    if (!d) return fail(reply, 404, 'Diagramme introuvable.');
    if (!holdsLock(d, holder)) return fail(reply, 423, d.lock ? `${d.lock.author} modifie ce diagramme.` : 'Reprenez la main (bouton « Modifier »).', { lock: d.lock });
    // « compilation » de cohérence : une modification de Claude qui ajoute un problème bloquant est refusée
    const after = await checkDiagram(xml);
    if (!after.ok) return fail(reply, 422, after.issues[0].text, { issues: after.issues, ms: after.ms });
    if (via === 'claude') {
      const before = await checkDiagram((await diagrams.get(d.id)).xml);
      const blocking = newErrors(before.ok ? before.issues : [], after.issues);
      if (blocking.length) return fail(reply, 422, `Modification refusée : ${blocking.map(formatIssue).join(' ; ')}`, { issues: blocking, ms: Math.round((before.ms + after.ms) * 10) / 10 });
    }
    const check = { issues: after.issues, ms: after.ms };
    const author = via === 'claude' ? { ...u, name: `${u.name} (via Claude)` } : u;
    const r = await diagrams.writeDraft(d.id, { xml, user: author, label: str(label, 300) ? label : 'Modification', source: via === 'claude' ? 'mcp' : 'web' });
    if (r.changed) hub.broadcast(d.id, { type: 'draft', xml, draft: r.draft, check, by: author.name, label, source: via === 'claude' ? 'mcp' : 'web' }, { exceptHolder: holder });
    return { ...r.draft, check };
  });

  for (const [path, delta] of [['undo', -1], ['redo', 1]]) {
    app.post(`/api/diagrams/:id/${path}`, async (req, reply) => {
      const u = requireUser(req, reply); if (!u) return;
      const d = db.getDiagram(req.params.id);
      if (!d) return fail(reply, 404, 'Diagramme introuvable.');
      if (lockedByOther(d, u)) return fail(reply, 423, `${d.lock.author} modifie ce diagramme.`, { lock: d.lock });
      const r = await diagrams.step(d.id, delta);
      if (!r) return fail(reply, 409, delta < 0 ? 'Rien à annuler.' : 'Rien à rétablir.');
      const label = `${delta < 0 ? 'Annulé' : 'Rétabli'} : ${r.step?.label || 'modification'}`;
      const check = await report(r.xml);
      hub.broadcast(d.id, { type: 'draft', xml: r.xml, draft: r.draft, check, by: u.name, label, source: 'web' }, { exceptHolder: req.body?.holder });
      return { xml: r.xml, draft: r.draft, check, label };
    });
  }

  /** Réorganisation automatique : une étape du brouillon, annulable comme les autres. */
  async function layoutDraft(d, user, { source = 'web', exceptHolder } = {}) {
    const cur = await diagrams.get(d.id);
    const r = await relayout(cur.xml);
    const label = 'Réorganisation automatique';
    const w = await diagrams.writeDraft(d.id, { xml: r.xml, user, label, source });
    const check = await report(r.xml);
    hub.broadcast(d.id, { type: 'draft', xml: r.xml, draft: w.draft, check, by: user.name, label, source }, { exceptHolder });
    return { xml: r.xml, draft: w.draft, check, label, ms: r.ms, warnings: r.warnings };
  }
  app.decorate('layoutDraft', layoutDraft);

  app.post('/api/diagrams/:id/layout', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const d = db.getDiagram(req.params.id);
    if (!d) return fail(reply, 404, 'Diagramme introuvable.');
    if (lockedByOther(d, u)) return fail(reply, 423, `${d.lock.author} modifie ce diagramme.`, { lock: d.lock });
    try { return await layoutDraft(d, u, { exceptHolder: req.body?.holder }); }
    catch (e) { return fail(reply, 422, `Réorganisation impossible : ${e.message}`); }
  });

  app.post('/api/diagrams/:id/commit', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const d = db.getDiagram(req.params.id);
    if (!d) return fail(reply, 404, 'Diagramme introuvable.');
    if (lockedByOther(d, u)) return fail(reply, 423, `${d.lock.author} modifie ce diagramme.`, { lock: d.lock });
    try {
      const r = await diagrams.commit(d.id, { user: u, message: str(req.body?.message, 300) ? req.body.message.trim() : null });
      if (r.status === 204) return fail(reply, 409, 'Rien à enregistrer : le brouillon est identique à la dernière version.');
      hub.broadcast(d.id, { type: 'commit', rev: r.diagram.rev, version: r.diagram.version, by: u.name, message: req.body?.message });
      return r.diagram;
    } catch (e) { return gitFail(reply, e); }
  });

  app.post('/api/diagrams/:id/restore', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const d = db.getDiagram(req.params.id);
    if (!d) return fail(reply, 404, 'Diagramme introuvable.');
    if (!holdsLock(d, req.body?.holder)) return fail(reply, 423, 'Reprenez la main (bouton « Modifier »).', { lock: d.lock });
    const r = await diagrams.restore(d.id, String(req.body?.sha || ''), u);
    if (!r) return fail(reply, 404, 'Version introuvable.');
    const check = await report(r.xml);
    hub.broadcast(d.id, { type: 'draft', xml: r.xml, draft: r.draft, check, by: u.name, label: `Retour à la version ${r.version.version}`, source: 'web' }, { exceptHolder: req.body.holder });
    return { xml: r.xml, draft: r.draft, check, version: r.version };
  });

  // ---------- temps réel ----------
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const u = auth.currentUser(req);
    if (!u) { socket.close(4401, 'Connexion requise'); return; }
    hub.attach(socket, u);
  });

  // ---------- connecteur MCP (Claude) ----------
  app.post('/mcp', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = oauth.bearerUser(req);
    if (!u) return oauth.challenge(req, reply);
    await mcp.handle(req, reply, u, oauth.base(req));
  });
  app.get('/mcp', async (req, reply) => {
    if (!oauth.bearerUser(req)) return oauth.challenge(req, reply);
    return reply.code(405).header('allow', 'POST').send({ error: 'Utilisez POST (transport HTTP sans état).' });
  });
  app.delete('/mcp', async (req, reply) => reply.code(405).header('allow', 'POST').send());

  app.get('/api/me/connections', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    return { mcpUrl: `${oauth.base(req)}/mcp`, grants: db.grants(u.id) };
  });
  app.delete('/api/me/connections/:clientId', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    if (!db.revokeGrant(u.id, req.params.clientId)) return fail(reply, 404, 'Connexion introuvable.');
    return { ok: true };
  });

  // ---------- verrou d'édition ----------
  app.post('/api/diagrams/:id/lock', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    if (!str(req.body?.holder, 100)) return fail(reply, 400, 'holder requis.');
    const r = db.acquireLock(req.params.id, { holder: req.body.holder, user: u });
    if (r.status === 404) return fail(reply, 404, 'Diagramme introuvable.');
    return { acquired: r.acquired, lock: r.lock };
  });

  // POST pour être compatible avec navigator.sendBeacon à la fermeture de l'onglet.
  app.post('/api/diagrams/:id/unlock', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (body?.force) {
      if (u.role !== 'admin') return fail(reply, 403, 'Réservé aux administrateurs.');
      db.forceUnlock(req.params.id);
    } else if (str(body?.holder, 100)) db.releaseLock(req.params.id, body.holder, u.id);
    return { ok: true };
  });

  // ---------- historique (Git) ----------
  app.get('/api/diagrams/:id/versions', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    try {
      const h = await diagrams.history(req.params.id);
      return h || fail(reply, 404, 'Diagramme introuvable.');
    } catch (e) { return gitFail(reply, e); }
  });

  app.get('/api/diagrams/:id/versions/:sha', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    try {
      const xml = await diagrams.version(req.params.id, req.params.sha);
      if (xml === null) return fail(reply, 404, 'Diagramme introuvable.');
      return { sha: req.params.sha, xml };
    } catch (e) {
      if (e instanceof GitError) return fail(reply, 404, e.message);
      return gitFail(reply, e);
    }
  });

  // ---------- application web ----------
  const dist = config.webRoot;
  if (dist && existsSync(join(dist, 'index.html'))) {
    const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
    await app.register(fastifyStatic, { root: dist, index: false, wildcard: false, maxAge: '7d', immutable: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml);
      }
      return fail(reply, 404, 'Introuvable.');
    });
  }

  app.addHook('onClose', async () => { clearInterval(syncTimer); hub.close(); db.raw.close(); });
  app.decorate('git', git);
  app.decorate('hub', hub);
  return app;
}
