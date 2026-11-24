// Authentification : une session administrateur (mot de passe unique) et des liens de partage par diagramme.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'bpmn_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function createAuth({ db, adminPassword, sessionSecret, secureCookies }) {
  let secret = sessionSecret || db.getSetting('session_secret');
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    db.setSetting('session_secret', secret);
  }

  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  const sha = s => createHash('sha256').update(String(s)).digest();

  function checkPassword(candidate) {
    if (!adminPassword || typeof candidate !== 'string') return false;
    return timingSafeEqual(sha(candidate), sha(adminPassword));
  }

  // secureCookies : true | false | 'auto' (Secure seulement si la requête arrive en HTTPS,
  // y compris derrière un proxy qui transmet X-Forwarded-Proto).
  function issueSession(reply, req) {
    const exp = Date.now() + SESSION_TTL_MS;
    const payload = `admin.${exp}`;
    const secure = secureCookies === 'auto' ? req.protocol === 'https' : !!secureCookies;
    reply.setCookie(SESSION_COOKIE, `${payload}.${sign(payload)}`, {
      path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: SESSION_TTL_MS / 1000
    });
  }

  function clearSession(reply) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  function isAdmin(req) {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (!raw) return false;
    const i = raw.lastIndexOf('.');
    if (i < 0) return false;
    const payload = raw.slice(0, i);
    const sig = Buffer.from(raw.slice(i + 1));
    const expected = Buffer.from(sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
    const [who, exp] = payload.split('.');
    return who === 'admin' && Number(exp) > Date.now();
  }

  /** Niveau d'accès sur un diagramme : 'admin' > 'edit' > 'view' > null. */
  function accessTo(req, diagramId) {
    if (isAdmin(req)) return 'admin';
    const token = req.headers['x-share-token'];
    if (typeof token !== 'string' || !token) return null;
    const share = db.getShare(token);
    if (!share || share.revokedAt || share.diagramId !== diagramId) return null;
    return share.role;
  }

  const RANK = { view: 1, edit: 2, admin: 3 };
  const atLeast = (level, needed) => (RANK[level] || 0) >= RANK[needed];

  return { checkPassword, issueSession, clearSession, isAdmin, accessTo, atLeast, enabled: !!adminPassword };
}
