// Base SQLite (module natif node:sqlite) : utilisateurs, index des diagrammes, verrous d'édition.
// Le contenu des diagrammes et leur historique vivent dans le dépôt Git (voir git.js).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOCK_TTL_MS = 90_000;

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);

  // Schéma v1 (diagrammes stockés en base) : on le met de côté pour migration vers Git.
  const cols = db.prepare(`SELECT name FROM pragma_table_info('diagrams')`).all().map(c => c.name);
  if (cols.includes('xml')) {
    db.exec(`ALTER TABLE diagrams RENAME TO legacy_diagrams;`);
    const hasVersions = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'versions'`).get();
    if (hasVersions) db.exec(`ALTER TABLE versions RENAME TO legacy_versions;`);
    db.exec(`DROP TABLE IF EXISTS shares;`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
      role          TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      created_at    INTEGER NOT NULL,
      approved_at   INTEGER,
      approved_by   TEXT
    );

    CREATE TABLE IF NOT EXISTS diagrams (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      path          TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      updated_by    TEXT,
      lock_holder   TEXT,
      lock_user     TEXT,
      lock_author   TEXT,
      lock_since    INTEGER,
      lock_expires  INTEGER
    );

    -- Brouillon de travail : chaque modification (navigateur ou MCP) est une étape ;
    -- cur_seq pointe l'étape courante (annuler / rétablir). Git ne reçoit que les versions enregistrées.
    CREATE TABLE IF NOT EXISTS drafts (
      diagram_id  TEXT PRIMARY KEY REFERENCES diagrams(id) ON DELETE CASCADE,
      cur_seq     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS draft_steps (
      diagram_id  TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
      seq         INTEGER NOT NULL,
      xml         TEXT NOT NULL,
      author      TEXT,
      label       TEXT,
      source      TEXT,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (diagram_id, seq)
    );

    -- OAuth 2.1 (connecteur MCP pour Claude) : clients enregistrés dynamiquement, codes, jetons.
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id            TEXT PRIMARY KEY,
      secret_hash   TEXT,
      name          TEXT,
      redirect_uris TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash     TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      redirect_uri  TEXT NOT NULL,
      challenge     TEXT NOT NULL,
      scope         TEXT,
      resource      TEXT,
      expires_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash    TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      client_id     TEXT NOT NULL,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope         TEXT,
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      revoked       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens(user_id);
    CREATE TABLE IF NOT EXISTS activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT,
      user_name     TEXT,
      diagram_id    TEXT,
      diagram_name  TEXT,
      kind          TEXT NOT NULL,
      via           TEXT NOT NULL DEFAULT 'web',
      at            INTEGER NOT NULL,
      last_at       INTEGER NOT NULL,
      count         INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS activity_at ON activity(last_at);
    CREATE INDEX IF NOT EXISTS activity_key ON activity(user_id, diagram_id, kind, via, last_at);
    CREATE TABLE IF NOT EXISTS invitations (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL COLLATE NOCASE,
      name          TEXT,
      created_by    TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      used_at       INTEGER
    );
  `);
  return wrap(db);
}

function wrap(db) {
  const q = sql => db.prepare(sql);
  const now = () => Date.now();

  const lockOf = row => (!row?.lock_holder || row.lock_expires < now()) ? null
    : { holder: row.lock_holder, userId: row.lock_user, author: row.lock_author, since: row.lock_since, expires: row.lock_expires };

  const diagramOf = row => row && ({
    id: row.id, name: row.name, path: row.path,
    createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by,
    lock: lockOf(row)
  });

  const userOf = row => row && ({
    id: row.id, email: row.email, name: row.name, status: row.status, role: row.role,
    createdAt: row.created_at, approvedAt: row.approved_at
  });

  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return {
    raw: db,
    tx,

    getSetting: key => q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null,
    setSetting: (key, value) => q('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),

    // ---------- utilisateurs ----------
    userById: id => userOf(q('SELECT * FROM users WHERE id = ?').get(id)),
    userAuthByEmail: email => q('SELECT * FROM users WHERE email = ?').get(email) ?? null,
    listUsers: () => q(`SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, created_at DESC`).all().map(userOf),
    countPending: () => q(`SELECT count(*) AS n FROM users WHERE status = 'pending'`).get().n,
    countAdmins: () => q(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`).get().n,
    createUser({ email, name, passwordHash, status = 'pending', role = 'user' }) {
      const id = newId();
      q('INSERT INTO users(id, email, name, password_hash, status, role, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(id, email, name, passwordHash, status, role, now());
      return userOf(q('SELECT * FROM users WHERE id = ?').get(id));
    },
    updateUser(id, fields) {
      const map = { name: 'name', status: 'status', role: 'role', passwordHash: 'password_hash', email: 'email' };
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(map)) if (fields[k] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[k]); }
      if (fields.approvedBy) { sets.push('approved_at = ?', 'approved_by = ?'); vals.push(now(), fields.approvedBy); }
      if (!sets.length) return this.userById(id);
      q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      return this.userById(id);
    },
    deleteUser: id => q('DELETE FROM users WHERE id = ?').run(id).changes > 0,

    // ---------- journal d'activité (statistiques d'administration) ----------
    /**
     * Note une action. Consultations et modifications répétées par la même personne sur le même
     * diagramme sont regroupées en une « session » tant qu'il s'écoule moins de 30 min entre deux actions.
     */
    logActivity({ userId, userName, diagramId = null, diagramName = null, kind, via = 'web' }) {
      const t = now();
      if (['view', 'edit'].includes(kind)) {
        const last = q('SELECT id FROM activity WHERE user_id = ? AND diagram_id IS ? AND kind = ? AND via = ? AND last_at > ? ORDER BY last_at DESC LIMIT 1')
          .get(userId, diagramId, kind, via, t - 30 * 60e3);
        if (last) { q('UPDATE activity SET last_at = ?, count = count + 1 WHERE id = ?').run(t, last.id); return; }
      }
      q('INSERT INTO activity(user_id, user_name, diagram_id, diagram_name, kind, via, at, last_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(userId, userName, diagramId, diagramName, kind, via, t, t);
    },
    purgeActivity: (olderThanMs) => q('DELETE FROM activity WHERE last_at < ?').run(now() - olderThanMs).changes,
    activitySince: since => q('SELECT * FROM activity WHERE last_at >= ? ORDER BY last_at DESC').all(since),
    lastLogins: () => q(`SELECT user_id, max(at) AS at FROM activity WHERE kind = 'login' GROUP BY user_id`).all(),
    lastSeen: () => q('SELECT user_id, max(last_at) AS at FROM activity GROUP BY user_id').all(),

    // ---------- invitations (lien à usage unique ; seul le haché du jeton est stocké) ----------
    createInvitation({ email, name, tokenHash, createdBy, expiresAt }) {
      const id = newId();
      q('DELETE FROM invitations WHERE email = ? AND used_at IS NULL').run(email);   // une seule invitation en cours par adresse
      q('INSERT INTO invitations(id, token_hash, email, name, created_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(id, tokenHash, email, name || null, createdBy, now(), expiresAt);
      return id;
    },
    renewInvitation: (id, tokenHash, expiresAt) => q('UPDATE invitations SET token_hash = ?, expires_at = ? WHERE id = ? AND used_at IS NULL').run(tokenHash, expiresAt, id).changes > 0,
    listInvitations: () => q('SELECT i.*, u.name AS by_name FROM invitations i LEFT JOIN users u ON u.id = i.created_by WHERE i.used_at IS NULL ORDER BY i.created_at DESC').all()
      .map(r => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at, expiresAt: r.expires_at, expired: r.expires_at < now(), createdBy: r.by_name })),
    invitationByToken: tokenHash => q('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash) ?? null,
    invitationById: id => q('SELECT * FROM invitations WHERE id = ?').get(id) ?? null,
    useInvitation: id => q('UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), id).changes > 0,
    deleteInvitation: id => q('DELETE FROM invitations WHERE id = ?').run(id).changes > 0,

    // ---------- index des diagrammes ----------
    listDiagrams: () => q('SELECT * FROM diagrams ORDER BY updated_at DESC').all().map(diagramOf),
    getDiagram: id => diagramOf(q('SELECT * FROM diagrams WHERE id = ?').get(id)),
    diagramByPath: path => diagramOf(q('SELECT * FROM diagrams WHERE path = ?').get(path)),
    allPaths: () => new Set(q('SELECT path FROM diagrams').all().map(r => r.path)),
    insertDiagram({ id = newId(), name, path, createdAt = now(), updatedAt = now(), updatedBy = null }) {
      q('INSERT INTO diagrams(id, name, path, created_at, updated_at, updated_by) VALUES(?, ?, ?, ?, ?, ?)')
        .run(id, name, path, createdAt, updatedAt, updatedBy);
      return this.getDiagram(id);
    },
    touchDiagram: (id, { updatedAt = now(), updatedBy }) => q('UPDATE diagrams SET updated_at = ?, updated_by = ? WHERE id = ?').run(updatedAt, updatedBy ?? null, id),
    renameDiagram: (id, name, path) => q('UPDATE diagrams SET name = ?, path = ? WHERE id = ?').run(name, path, id).changes > 0,
    deleteDiagram: id => q('DELETE FROM diagrams WHERE id = ?').run(id).changes > 0,
    deleteByPath: path => q('DELETE FROM diagrams WHERE path = ?').run(path),

    // ---------- verrou d'édition (bail de LOCK_TTL_MS) ----------
    lockOf: id => lockOf(q('SELECT * FROM diagrams WHERE id = ?').get(id)),
    acquireLock(id, { holder, user }) {
      return tx(() => {
        const row = q('SELECT * FROM diagrams WHERE id = ?').get(id);
        if (!row) return { status: 404 };
        const lock = lockOf(row);
        if (lock && lock.holder !== holder) return { status: 200, acquired: false, lock };
        const t = now();
        const since = lock ? lock.since : t;
        q('UPDATE diagrams SET lock_holder = ?, lock_user = ?, lock_author = ?, lock_since = ?, lock_expires = ? WHERE id = ?')
          .run(holder, user.id, user.name, since, t + LOCK_TTL_MS, id);
        return { status: 200, acquired: true, lock: { holder, userId: user.id, author: user.name, since, expires: t + LOCK_TTL_MS } };
      });
    },
    /** Libère le verrou si la personne le détient (un onglet peut libérer celui d'un autre onglet de la même personne). */
    releaseLock: (id, holder, userId) => q('UPDATE diagrams SET lock_holder = NULL, lock_user = NULL, lock_author = NULL, lock_since = NULL, lock_expires = NULL WHERE id = ? AND lock_holder = ? AND lock_user = ?').run(id, holder, userId),
    forceUnlock: id => q('UPDATE diagrams SET lock_holder = NULL, lock_user = NULL, lock_author = NULL, lock_since = NULL, lock_expires = NULL WHERE id = ?').run(id),

    // ---------- brouillon ----------
    MAX_STEPS: 200,
    draftInfo(id) {
      const d = q('SELECT cur_seq FROM drafts WHERE diagram_id = ?').get(id);
      if (!d) return null;
      const cur = q('SELECT seq, author, label, source, created_at FROM draft_steps WHERE diagram_id = ? AND seq = ?').get(id, d.cur_seq);
      const range = q('SELECT min(seq) AS lo, max(seq) AS hi FROM draft_steps WHERE diagram_id = ?').get(id);
      return { seq: d.cur_seq, canUndo: d.cur_seq > range.lo, canRedo: d.cur_seq < range.hi,
        updatedAt: cur?.created_at, updatedBy: cur?.author, label: cur?.label, source: cur?.source };
    },
    draftXml(id) {
      const r = q('SELECT s.xml FROM drafts d JOIN draft_steps s ON s.diagram_id = d.diagram_id AND s.seq = d.cur_seq WHERE d.diagram_id = ?').get(id);
      return r ? r.xml : null;
    },
    /** Ajoute une étape (et la première, = la version enregistrée, si le brouillon n'existe pas). */
    pushStep(id, { xml, author, label, source, baseXml }) {
      return tx(() => {
        let d = q('SELECT cur_seq FROM drafts WHERE diagram_id = ?').get(id);
        const t = now();
        if (!d) {
          q('INSERT INTO draft_steps(diagram_id, seq, xml, author, label, source, created_at) VALUES(?, 0, ?, NULL, ?, ?, ?)').run(id, baseXml, 'Version enregistrée', 'git', t);
          q('INSERT INTO drafts(diagram_id, cur_seq) VALUES(?, 0)').run(id);
          d = { cur_seq: 0 };
        }
        const cur = q('SELECT xml FROM draft_steps WHERE diagram_id = ? AND seq = ?').get(id, d.cur_seq);
        if (cur && cur.xml === xml) return { changed: false };
        q('DELETE FROM draft_steps WHERE diagram_id = ? AND seq > ?').run(id, d.cur_seq); // on abandonne le « rétablir »
        const seq = d.cur_seq + 1;
        q('INSERT INTO draft_steps(diagram_id, seq, xml, author, label, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(id, seq, xml, author ?? null, label ?? null, source ?? null, t);
        q('UPDATE drafts SET cur_seq = ? WHERE diagram_id = ?').run(seq, id);
        q('DELETE FROM draft_steps WHERE diagram_id = ? AND seq <= ?').run(id, seq - this.MAX_STEPS);
        return { changed: true, seq };
      });
    },
    /** Déplace l'étape courante (-1 annuler, +1 rétablir). */
    moveStep(id, delta) {
      return tx(() => {
        const d = q('SELECT cur_seq FROM drafts WHERE diagram_id = ?').get(id);
        if (!d) return null;
        const target = q(delta < 0
          ? 'SELECT seq FROM draft_steps WHERE diagram_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1'
          : 'SELECT seq FROM draft_steps WHERE diagram_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1').get(id, d.cur_seq);
        if (!target) return null;
        const undone = q('SELECT label, author FROM draft_steps WHERE diagram_id = ? AND seq = ?').get(id, delta < 0 ? d.cur_seq : target.seq);
        q('UPDATE drafts SET cur_seq = ? WHERE diagram_id = ?').run(target.seq, id);
        return { seq: target.seq, step: undone };
      });
    },
    recentSteps(id, limit = 20) {
      return q('SELECT seq, author, label, source, created_at AS createdAt FROM draft_steps WHERE diagram_id = ? ORDER BY seq DESC LIMIT ?').all(id, limit);
    },

    // ---------- OAuth ----------
    oauthClient: id => { const r = q('SELECT * FROM oauth_clients WHERE id = ?').get(id); return r ? { ...r, redirect_uris: JSON.parse(r.redirect_uris) } : null; },
    createOauthClient: ({ id, secretHash, name, redirectUris }) => q('INSERT INTO oauth_clients(id, secret_hash, name, redirect_uris, created_at) VALUES(?, ?, ?, ?, ?)').run(id, secretHash ?? null, name ?? null, JSON.stringify(redirectUris), now()),
    saveCode: c => q('INSERT INTO oauth_codes(code_hash, client_id, user_id, redirect_uri, challenge, scope, resource, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(c.codeHash, c.clientId, c.userId, c.redirectUri, c.challenge, c.scope ?? null, c.resource ?? null, c.expiresAt),
    takeCode(hash) {
      return tx(() => {
        const r = q('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash);
        q('DELETE FROM oauth_codes WHERE code_hash = ? OR expires_at < ?').run(hash, now());
        return r ?? null;
      });
    },
    saveToken: t => q('INSERT INTO oauth_tokens(token_hash, kind, client_id, user_id, scope, expires_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(t.hash, t.kind, t.clientId, t.userId, t.scope ?? null, t.expiresAt, now()),
    token(hash) {
      const r = q('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hash);
      if (!r || r.revoked || r.expires_at < now()) return null;
      return r;
    },
    touchToken: hash => q('UPDATE oauth_tokens SET last_used_at = ? WHERE token_hash = ?').run(now(), hash),
    revokeToken: hash => q('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(hash),
    /** Connexions actives d'une personne (une par client, d'après les jetons de rafraîchissement). */
    grants: userId => q(`SELECT t.client_id AS clientId, c.name, max(t.created_at) AS since, max(t.last_used_at) AS lastUsed
      FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.id = t.client_id
      WHERE t.user_id = ? AND t.revoked = 0 AND t.expires_at > ? GROUP BY t.client_id ORDER BY since DESC`).all(userId, now()),
    revokeGrant: (userId, clientId) => q('UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?').run(userId, clientId).changes > 0,

    // ---------- migration depuis le schéma v1 ----------
    legacy() {
      const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'legacy_diagrams'`).get();
      if (!has) return null;
      const diagrams = q('SELECT id, name, created_at FROM legacy_diagrams ORDER BY created_at').all();
      const hasVersions = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'legacy_versions'`).get();
      const versions = hasVersions ? q('SELECT diagram_id, version, xml, author, message, created_at FROM legacy_versions ORDER BY diagram_id, version').all() : [];
      return { diagrams, versions };
    },
    dropLegacy() { db.exec('DROP TABLE IF EXISTS legacy_versions; DROP TABLE IF EXISTS legacy_diagrams;'); }
  };
}
