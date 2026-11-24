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
