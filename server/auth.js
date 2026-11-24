// Comptes et sessions : inscription libre, validation par un administrateur, session signée en cookie.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'bpmn_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

// Hachage factice pour garder un temps de réponse constant quand l'e-mail est inconnu.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

export function createAuth({ db, sessionSecret, secureCookies }) {
  let secret = sessionSecret || db.getSetting('session_secret');
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    db.setSetting('session_secret', secret);
  }
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');

  /** Crée ou met à jour le compte administrateur défini par les variables d'environnement. */
  function bootstrapAdmin({ email, password, name }) {
    if (!password) return null;
    const existing = db.userAuthByEmail(email);
    if (existing) {
      const fields = { status: 'active', role: 'admin' };
      if (!verifyPassword(password, existing.password_hash)) fields.passwordHash = hashPassword(password);
      return db.updateUser(existing.id, fields);
    }
    return db.createUser({ email, name, passwordHash: hashPassword(password), status: 'active', role: 'admin' });
  }

  /** Vérifie les identifiants. Renvoie { user } ou { error, status }. */
  function login(email, password) {
    const row = typeof email === 'string' ? db.userAuthByEmail(email.trim()) : null;
    const ok = verifyPassword(String(password ?? ''), row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) return { status: 401, error: 'E-mail ou mot de passe incorrect.' };
    if (row.status === 'pending') return { status: 403, error: 'Votre compte attend la validation d\'un administrateur.' };
    if (row.status === 'disabled') return { status: 403, error: 'Ce compte est désactivé.' };
    return { user: db.userById(row.id) };
  }

  function issueSession(reply, req, user) {
    const exp = Date.now() + SESSION_TTL_MS;
    const payload = `${user.id}.${exp}`;
    const secure = secureCookies === 'auto' ? req.protocol === 'https' : !!secureCookies;
    reply.setCookie(SESSION_COOKIE, `${payload}.${sign(payload)}`, {
      path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS / 1000
    });
  }

  const clearSession = reply => reply.clearCookie(SESSION_COOKIE, { path: '/' });

  /** Utilisateur actif associé à la requête, ou null. */
  function currentUser(req) {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (!raw) return null;
    const i = raw.lastIndexOf('.');
    if (i < 0) return null;
    const payload = raw.slice(0, i);
    const sig = Buffer.from(raw.slice(i + 1));
    const expected = Buffer.from(sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const [uid, exp] = payload.split('.');
    if (!(Number(exp) > Date.now())) return null;
    const user = db.userById(uid);
    return user && user.status === 'active' ? user : null;
  }

  return { bootstrapAdmin, login, issueSession, clearSession, currentUser, hashPassword, verifyPassword, secret };
}
