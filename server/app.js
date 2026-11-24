import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createAuth } from './auth.js';
import { createAi, AiError } from './ai.js';
import { createGitStore, GitError } from './git.js';
import { createDiagrams } from './diagrams.js';
import { checkBpmn } from './validate.js';

const MAX_XML = 1_500_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function buildApp(config) {
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 4 * 1024 * 1024, trustProxy: config.trustProxy ?? true });
  const log = config.logger ? app.log : { info() {}, error() {}, warn() {} };
  const db = openDb(config.dbFile);
  const auth = createAuth({ db, sessionSecret: config.sessionSecret, secureCookies: config.secureCookies ?? 'auto' });
  const ai = createAi(config.ai || {});
  const git = createGitStore({ dir: config.gitDir, remote: config.gitRemote, branch: config.gitBranch || 'main', subdir: config.gitSubdir || 'diagrams', log });
  const diagrams = createDiagrams({ db, git });

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
      ai: ai.enabled ? { model: ai.model, provider: ai.provider } : null,
      git: { remote: !!config.gitRemote, branch: git.status.branch }
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
      return d;
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

  app.put('/api/diagrams/:id', async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    const { xml, baseRev, holder, message } = req.body || {};
    if (!isXml(xml)) return fail(reply, 400, 'XML BPMN invalide ou trop volumineux.');
    if (!str(holder, 100)) return fail(reply, 400, 'holder requis.');
    if (baseRev !== null && typeof baseRev !== 'string') return fail(reply, 400, 'baseRev requis.');
    try {
      const r = await diagrams.save(req.params.id, { xml, baseRev, holder, user: u, message: str(message, 300) ? message.trim() : null });
      if (r.status === 404) return fail(reply, 404, 'Diagramme introuvable.');
      if (r.status === 423) return fail(reply, 423, r.lock ? `${r.lock.author} modifie ce diagramme.` : 'Reprenez la main (bouton « Modifier ») avant d\'enregistrer.', { lock: r.lock });
      if (r.status === 409) return fail(reply, 409, 'Le diagramme a été modifié entre-temps.', { current: r.current });
      return r.diagram;
    } catch (e) { return gitFail(reply, e); }
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

  // ---------- assistant IA (réponse en flux) ----------
  app.post('/api/diagrams/:id/chat', { config: { rateLimit: { max: config.aiRateLimit ?? 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = requireUser(req, reply); if (!u) return;
    if (!ai.enabled) return fail(reply, 503, 'Assistant IA non configuré sur ce serveur.');
    const { xml, history, mode, selection, visible, voice } = req.body || {};
    if (!isXml(xml)) return fail(reply, 400, 'XML BPMN invalide ou trop volumineux.');
    if (!Array.isArray(history) || history.length < 1 || history.length > 60) return fail(reply, 400, 'Historique de conversation invalide.');
    for (const m of history) if (!m || !['user', 'assistant'].includes(m.role) || !str(m.content, 40000)) return fail(reply, 400, 'Message invalide.');
    const refs = (list, max) => Array.isArray(list) ? list.slice(0, max).filter(s => s && typeof s.id === 'string').map(s => ({ id: s.id.slice(0, 100), name: String(s.name || '').slice(0, 200) })) : [];
    const sel = refs(selection, 20), vis = refs(visible, 40);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

    const elements = (xml.match(/<(\w+:)?(task|userTask|serviceTask|scriptTask|sendTask|receiveTask|manualTask|businessRuleTask|callActivity|subProcess|startEvent|endEvent|intermediateCatchEvent|intermediateThrowEvent|boundaryEvent|exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway)\b/g) || []).length;
    send({ type: 'status', text: `Diagramme transmis au modèle ${ai.model} (${elements} éléments)…` });
    let chars = 0;
    try {
      for await (const text of ai.chat({ xml, history, mode: mode === 'propose' ? 'propose' : 'chat', selection: sel, visible: vis, voice: voice === true }, ac.signal)) {
        if (chars === 0) send({ type: 'status', text: 'Le modèle rédige sa réponse…' });
        chars += text.length;
        send({ type: 'delta', text });
      }
      send({ type: 'done' });
    } catch (e) {
      if (!ac.signal.aborted || e.name === 'TimeoutError') {
        log.error(e);
        send({ type: 'error', message: e instanceof AiError ? e.message : e.name === 'TimeoutError' ? 'L\'IA a mis trop de temps à répondre.' : 'Erreur lors de l\'appel à l\'IA.' });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
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

  app.addHook('onClose', async () => { clearInterval(syncTimer); db.raw.close(); });
  app.decorate('git', git);
  return app;
}
