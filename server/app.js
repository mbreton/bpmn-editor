import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createAuth } from './auth.js';
import { createAi, AiError } from './ai.js';
import { emptyDiagram } from './templates.js';

const MAX_XML = 1_500_000;

export async function buildApp(config) {
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 4 * 1024 * 1024, trustProxy: config.trustProxy ?? true });
  const db = openDb(config.dbFile);
  const auth = createAuth({ db, adminPassword: config.adminPassword, sessionSecret: config.sessionSecret, secureCookies: config.secureCookies });
  const ai = createAi(config.ai || {});

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer'); // les liens de partage portent un jeton dans l'URL
    return payload;
  });

  // ---------- helpers ----------
  const fail = (reply, status, error, extra = {}) => reply.code(status).send({ error, ...extra });
  const str = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const isXml = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_XML && v.includes('definitions');

  function guard(req, reply, needed) {
    const level = auth.accessTo(req, req.params.id);
    if (!auth.atLeast(level, needed)) { fail(reply, level ? 403 : 401, level ? 'Droits insuffisants.' : 'Accès refusé.'); return null; }
    return level;
  }
  function adminOnly(req, reply) {
    if (!auth.isAdmin(req)) { fail(reply, 401, 'Connexion administrateur requise.'); return false; }
    return true;
  }

  // ---------- santé, configuration, session ----------
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/config', async req => ({
    admin: auth.isAdmin(req),
    loginEnabled: auth.enabled,
    ai: ai.enabled ? { model: ai.model, provider: ai.provider } : null
  }));

  app.post('/api/login', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!auth.checkPassword(req.body?.password)) return fail(reply, 401, 'Mot de passe incorrect.');
    auth.issueSession(reply, req);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => { auth.clearSession(reply); return { ok: true }; });

  // ---------- diagrammes ----------
  app.get('/api/diagrams', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    return db.listDiagrams();
  });

  app.post('/api/diagrams', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const { name, xml, author } = req.body || {};
    if (!str(name)) return fail(reply, 400, 'Nom requis (200 caractères max).');
    if (xml !== undefined && !isXml(xml)) return fail(reply, 400, 'XML BPMN invalide ou trop volumineux.');
    if (xml) {
      const problems = await ai.validate(xml);
      if (problems.some(p => p.startsWith('XML invalide'))) return fail(reply, 400, problems[0]);
    }
    return reply.code(201).send(db.createDiagram({ name: name.trim(), xml: xml || emptyDiagram(name.trim()), author: str(author, 80) ? author : 'Administrateur' }));
  });

  app.get('/api/diagrams/:id', async (req, reply) => {
    const level = guard(req, reply, 'view');
    if (!level) return;
    const d = db.getDiagram(req.params.id, { withXml: true });
    if (!d) return fail(reply, 404, 'Diagramme introuvable.');
    return { ...d, role: level };
  });

  app.patch('/api/diagrams/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    if (!str(req.body?.name)) return fail(reply, 400, 'Nom requis.');
    if (!db.renameDiagram(req.params.id, req.body.name.trim())) return fail(reply, 404, 'Diagramme introuvable.');
    return db.getDiagram(req.params.id);
  });

  app.delete('/api/diagrams/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    if (!db.deleteDiagram(req.params.id)) return fail(reply, 404, 'Diagramme introuvable.');
    return { ok: true };
  });

  app.put('/api/diagrams/:id', async (req, reply) => {
    if (!guard(req, reply, 'edit')) return;
    const { xml, baseVersion, holder, author, message } = req.body || {};
    if (!isXml(xml)) return fail(reply, 400, 'XML BPMN invalide ou trop volumineux.');
    if (!Number.isInteger(baseVersion)) return fail(reply, 400, 'baseVersion requis.');
    if (!str(holder, 100)) return fail(reply, 400, 'holder requis.');
    const r = db.saveDiagram(req.params.id, {
      xml, baseVersion, holder,
      author: str(author, 80) ? author.trim() : null,
      message: str(message, 300) ? message.trim() : null
    });
    if (r.status === 404) return fail(reply, 404, 'Diagramme introuvable.');
    if (r.status === 423) return fail(reply, 423, `${r.lock.author || 'Quelqu\'un'} modifie ce diagramme.`, { lock: r.lock });
    if (r.status === 409) return fail(reply, 409, 'Le diagramme a été modifié entre-temps.', { current: r.current });
    return r.diagram;
  });

  // ---------- verrou d'édition ----------
  app.post('/api/diagrams/:id/lock', async (req, reply) => {
    if (!guard(req, reply, 'edit')) return;
    const { holder, author } = req.body || {};
    if (!str(holder, 100)) return fail(reply, 400, 'holder requis.');
    const r = db.acquireLock(req.params.id, { holder, author: str(author, 80) ? author.trim() : null });
    if (r.status === 404) return fail(reply, 404, 'Diagramme introuvable.');
    return { acquired: r.acquired, lock: r.lock };
  });

  // POST pour être compatible avec navigator.sendBeacon à la fermeture de l'onglet.
  app.post('/api/diagrams/:id/unlock', async (req, reply) => {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const shareToken = body?.shareToken;
    if (shareToken && !req.headers['x-share-token']) req.headers['x-share-token'] = shareToken;
    const level = auth.accessTo(req, req.params.id);
    if (body?.force) {
      if (level !== 'admin') return fail(reply, 403, 'Réservé à l\'administrateur.');
      db.forceUnlock(req.params.id);
      return { ok: true };
    }
    if (!auth.atLeast(level, 'edit')) return fail(reply, 401, 'Accès refusé.');
    if (str(body?.holder, 100)) db.releaseLock(req.params.id, body.holder);
    return { ok: true };
  });

  // ---------- historique ----------
  app.get('/api/diagrams/:id/versions', async (req, reply) => {
    if (!guard(req, reply, 'view')) return;
    return db.listVersions(req.params.id);
  });

  app.get('/api/diagrams/:id/versions/:version', async (req, reply) => {
    if (!guard(req, reply, 'view')) return;
    const v = db.getVersion(req.params.id, Number(req.params.version));
    if (!v) return fail(reply, 404, 'Version introuvable.');
    return v;
  });

  // ---------- liens de partage ----------
  app.get('/api/diagrams/:id/shares', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    return db.listShares(req.params.id);
  });

  app.post('/api/diagrams/:id/shares', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const { role, label } = req.body || {};
    if (role !== 'view' && role !== 'edit') return fail(reply, 400, 'role doit valoir view ou edit.');
    if (!db.getDiagram(req.params.id)) return fail(reply, 404, 'Diagramme introuvable.');
    return reply.code(201).send(db.createShare(req.params.id, { role, label: str(label, 120) ? label.trim() : null }));
  });

  app.delete('/api/diagrams/:id/shares/:token', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    if (!db.revokeShare(req.params.id, req.params.token)) return fail(reply, 404, 'Lien introuvable.');
    return { ok: true };
  });

  // Résolution d'un lien de partage côté client.
  app.get('/api/shares/:token', async (req, reply) => {
    const s = db.getShare(req.params.token);
    if (!s || s.revokedAt) return fail(reply, 404, 'Lien invalide ou révoqué.');
    return { diagramId: s.diagramId, role: s.role };
  });

  // ---------- assistant IA ----------
  app.post('/api/diagrams/:id/ai', { config: { rateLimit: { max: config.aiRateLimit ?? 40, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!guard(req, reply, 'edit')) return;
    if (!ai.enabled) return fail(reply, 503, 'Assistant IA non configuré sur ce serveur.');
    const { xml, turns } = req.body || {};
    if (!isXml(xml)) return fail(reply, 400, 'XML BPMN invalide ou trop volumineux.');
    if (!Array.isArray(turns) || turns.length < 1 || turns.length > 8) return fail(reply, 400, 'turns invalide.');
    for (const [i, t] of turns.entries()) {
      if (!str(t?.request, 4000)) return fail(reply, 400, 'Demande vide ou trop longue.');
      const last = i === turns.length - 1;
      if (!last && !isXml(t.proposalXml)) return fail(reply, 400, 'Proposition précédente manquante.');
      if (last && t.proposalXml) return fail(reply, 400, 'Le dernier tour ne doit pas contenir de proposition.');
    }
    try {
      return await ai.propose({ xml, turns: turns.map(t => ({ request: t.request.trim(), proposalXml: t.proposalXml, explanation: typeof t.explanation === 'string' ? t.explanation.slice(0, 4000) : '' })) });
    } catch (e) {
      req.log.error(e);
      if (e instanceof AiError) return fail(reply, e.status, e.message);
      if (e.name === 'TimeoutError') return fail(reply, 504, "L'IA a mis trop de temps à répondre. Réessayez avec une demande plus ciblée.");
      return fail(reply, 502, "Erreur lors de l'appel à l'IA.");
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

  app.addHook('onClose', async () => db.raw.close());
  return app;
}
