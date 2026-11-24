// Serveur d'autorisation OAuth 2.1 minimal pour le connecteur MCP (Claude.ai, Claude Desktop, Claude Code) :
// découverte (RFC 9728 / RFC 8414), enregistrement dynamique (RFC 7591), code d'autorisation + PKCE S256,
// jetons d'accès courts et jetons de rafraîchissement à rotation. La connexion et le consentement
// réutilisent les comptes de l'application.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ACCESS_TTL = 3600 * 1000;
const REFRESH_TTL = 60 * 24 * 3600 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const sha = s => createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Redirections autorisées : HTTPS, ou boucle locale (Claude Code) quel que soit le port. */
export function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return !u.hash;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch { return false; }
}

function redirectMatches(registered, given) {
  if (registered.includes(given)) return true;
  // RFC 8252 : boucle locale, port libre.
  try {
    const g = new URL(given);
    if (g.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(g.hostname)) return false;
    return registered.some(r => { const x = new URL(r); return x.protocol === 'http:' && x.hostname === g.hostname && x.pathname === g.pathname; });
  } catch { return false; }
}

export function registerOAuth(app, { db, auth, publicUrl, secret }) {
  const base = req => (publicUrl || `${req.protocol}://${req.host}`).replace(/\/$/, '');
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body))); } catch (e) { done(e); }
  });

  // ---------- découverte ----------
  const resourceMeta = req => ({
    resource: `${base(req)}/mcp`,
    authorization_servers: [base(req)],
    scopes_supported: ['diagrams'],
    bearer_methods_supported: ['header'],
    resource_name: 'Éditeur BPMN'
  });
  app.get('/.well-known/oauth-protected-resource', async req => resourceMeta(req));
  app.get('/.well-known/oauth-protected-resource/mcp', async req => resourceMeta(req));
  const asMeta = req => ({
    issuer: base(req),
    authorization_endpoint: `${base(req)}/oauth/authorize`,
    token_endpoint: `${base(req)}/oauth/token`,
    registration_endpoint: `${base(req)}/oauth/register`,
    revocation_endpoint: `${base(req)}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['diagrams', 'offline_access']
  });
  app.get('/.well-known/oauth-authorization-server', async req => asMeta(req));
  app.get('/.well-known/openid-configuration', async req => asMeta(req));

  // ---------- enregistrement dynamique ----------
  app.post('/oauth/register', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || !uris.every(u => typeof u === 'string' && validRedirect(u))) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris doit contenir des URL HTTPS ou de boucle locale.' });
    }
    const method = b.token_endpoint_auth_method || 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return reply.code(400).send({ error: 'invalid_client_metadata' });
    const id = rand(16);
    const clientSecret = method === 'none' ? null : rand(32);
    db.createOauthClient({ id, secretHash: clientSecret ? sha(clientSecret) : null, name: String(b.client_name || 'Client MCP').slice(0, 100), redirectUris: uris });
    return reply.code(201).send({
      client_id: id, ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris, token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: b.client_name
    });
  });

  // ---------- autorisation (connexion + consentement) ----------
  function checkAuthorize(q) {
    const client = db.oauthClient(String(q.client_id || ''));
    if (!client) return { fatal: 'Client inconnu : reconnectez le connecteur depuis Claude.' };
    if (!q.redirect_uri || !redirectMatches(client.redirect_uris, q.redirect_uri)) return { fatal: 'Adresse de retour non autorisée pour ce client.' };
    if (q.response_type !== 'code') return { error: 'unsupported_response_type', client };
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return { error: 'invalid_request', description: 'PKCE S256 requis.', client };
    return { client };
  }
  const back = (q, params) => {
    const u = new URL(q.redirect_uri);
    for (const [k, v] of Object.entries({ ...params, state: q.state })) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };

  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query || {};
    const c = checkAuthorize(q);
    if (c.fatal) return reply.code(400).type('text/html').send(page('Connexion impossible', `<p>${esc(c.fatal)}</p>`));
    if (c.error) return reply.redirect(back(q, { error: c.error, error_description: c.description }));
    const user = auth.currentUser(req);
    if (!user) return reply.redirect(`/?next=${encodeURIComponent(req.url)}`);
    const payload = Buffer.from(JSON.stringify({ q, uid: user.id, exp: Date.now() + 10 * 60 * 1000 })).toString('base64url');
    const host = new URL(q.redirect_uri).host;
    return reply.type('text/html').header('cache-control', 'no-store').send(page('Autoriser l\'accès', `
      <p><b>${esc(c.client.name)}</b> demande à accéder à l'éditeur BPMN <b>en votre nom (${esc(user.name)})</b> :
      lire les diagrammes, les modifier dans votre brouillon, les afficher et les zoomer à l'écran, enregistrer des versions.</p>
      <p class="muted">Vous serez renvoyé vers <b>${esc(host)}</b>. Vous pourrez révoquer cet accès dans « Mon compte ».</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="tx" value="${esc(payload)}.${esc(sign(payload))}">
        <button name="decision" value="deny" class="btn">Refuser</button>
        <button name="decision" value="allow" class="btn primary">Autoriser</button>
      </form>`));
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const [payload, sig] = String(req.body?.tx || '').split('.');
    if (!payload || !sig || sig.length !== sign(payload).length || !timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)))) return reply.code(400).send('Requête invalide.');
    const { q, uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const user = auth.currentUser(req);
    if (!user || user.id !== uid || exp < Date.now()) return reply.code(400).send('Session expirée, recommencez depuis Claude.');
    const c = checkAuthorize(q);
    if (c.fatal || c.error) return reply.code(400).send('Requête invalide.');
    if (req.body.decision !== 'allow') return reply.redirect(back(q, { error: 'access_denied' }));
    const code = rand(32);
    db.saveCode({ codeHash: sha(code), clientId: c.client.id, userId: user.id, redirectUri: q.redirect_uri, challenge: q.code_challenge, scope: q.scope || 'diagrams', resource: q.resource, expiresAt: Date.now() + CODE_TTL });
    return reply.redirect(back(q, { code }));
  });

  // ---------- jetons ----------
  function clientAuth(req) {
    const b = req.body || {};
    let id = b.client_id, secretIn = b.client_secret;
    const h = req.headers.authorization;
    if (h?.startsWith('Basic ')) {
      const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(u); secretIn = decodeURIComponent(p || '');
    }
    const client = db.oauthClient(String(id || ''));
    if (!client) return null;
    if (client.secret_hash && sha(secretIn || '') !== client.secret_hash) return null;
    return client;
  }

  function issue(clientId, userId, scope) {
    const access = rand(32), refresh = rand(32);
    db.saveToken({ hash: sha(access), kind: 'access', clientId, userId, scope, expiresAt: Date.now() + ACCESS_TTL });
    db.saveToken({ hash: sha(refresh), kind: 'refresh', clientId, userId, scope, expiresAt: Date.now() + REFRESH_TTL });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: scope || 'diagrams' };
  }

  app.post('/oauth/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const b = req.body || {};
    const client = clientAuth(req);
    if (!client) return reply.code(401).send({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      const code = db.takeCode(sha(b.code || ''));
      if (!code || code.expires_at < Date.now() || code.client_id !== client.id || code.redirect_uri !== b.redirect_uri) return reply.code(400).send({ error: 'invalid_grant' });
      const challenge = createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
      if (challenge !== code.challenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE invalide.' });
      const u = db.userById(code.user_id);
      if (!u || u.status !== 'active') return reply.code(400).send({ error: 'invalid_grant' });
      return issue(client.id, u.id, code.scope);
    }
    if (b.grant_type === 'refresh_token') {
      const hash = sha(b.refresh_token || '');
      const t = db.token(hash);
      if (!t || t.kind !== 'refresh' || t.client_id !== client.id) return reply.code(400).send({ error: 'invalid_grant' });
      const u = db.userById(t.user_id);
      if (!u || u.status !== 'active') return reply.code(400).send({ error: 'invalid_grant' });
      db.revokeToken(hash); // rotation
      return issue(client.id, u.id, t.scope);
    }
    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  app.post('/oauth/revoke', async (req, reply) => {
    db.revokeToken(sha(req.body?.token || ''));
    return reply.code(200).send({});
  });

  /** Utilisateur porteur d'un jeton d'accès valide (en-tête Authorization), ou null. */
  function bearerUser(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    const hash = sha(h.slice(7).trim());
    const t = db.token(hash);
    if (!t || t.kind !== 'access') return null;
    const u = db.userById(t.user_id);
    if (!u || u.status !== 'active') return null;
    db.touchToken(hash);
    return u;
  }

  const challenge = (req, reply) => reply.code(401)
    .header('www-authenticate', `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"`)
    .send({ error: 'unauthorized', error_description: 'Connexion requise.' });

  return { bearerUser, challenge, base };
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Éditeur BPMN</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4f2;font:16px/1.55 system-ui,sans-serif;color:#141110;padding:16px}
.card{background:#fff;border:1px solid #e6e1de;border-radius:16px;padding:28px;max-width:460px}h1{font-size:24px;margin:0 0 12px}.muted{color:#6b6460;font-size:14px}
form{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}.btn{min-height:40px;padding:0 16px;border-radius:9px;border:1px solid #e6e1de;background:#fff;font:500 15px system-ui;cursor:pointer}
.btn.primary{background:#141110;color:#fff;border-color:#141110}</style></head><body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}
