// Stockage SQLite (module natif node:sqlite, aucune dépendance compilée).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOCK_TTL_MS = 90_000;
export const MAX_VERSIONS = 200;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagrams (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      xml           TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      updated_by    TEXT,
      lock_holder   TEXT,
      lock_author   TEXT,
      lock_since    INTEGER,
      lock_expires  INTEGER
    );

    CREATE TABLE IF NOT EXISTS versions (
      diagram_id  TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      xml         TEXT NOT NULL,
      author      TEXT,
      message     TEXT,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (diagram_id, version)
    );

    CREATE TABLE IF NOT EXISTS shares (
      token       TEXT PRIMARY KEY,
      diagram_id  TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('view', 'edit')),
      label       TEXT,
      created_at  INTEGER NOT NULL,
      revoked_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS shares_diagram ON shares(diagram_id);
  `);
  return wrap(db);
}

const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');

function wrap(db) {
  const q = sql => db.prepare(sql);
  const now = () => Date.now();

  const lockOf = row => {
    if (!row || !row.lock_holder || row.lock_expires < now()) return null;
    return { holder: row.lock_holder, author: row.lock_author, since: row.lock_since, expires: row.lock_expires };
  };

  const publicDiagram = row => row && ({
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    lock: lockOf(row)
  });

  const api = {
    raw: db,

    getSetting(key) {
      return q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key, value) {
      q('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },

    listDiagrams() {
      return q('SELECT * FROM diagrams ORDER BY updated_at DESC').all().map(publicDiagram);
    },

    getDiagram(id, { withXml = false } = {}) {
      const row = q('SELECT * FROM diagrams WHERE id = ?').get(id);
      if (!row) return null;
      const d = publicDiagram(row);
      if (withXml) d.xml = row.xml;
      return d;
    },

    createDiagram({ name, xml, author }) {
      const id = newId();
      const t = now();
      db.exec('BEGIN');
      try {
        q('INSERT INTO diagrams(id, name, version, xml, created_at, updated_at, updated_by) VALUES(?, ?, 1, ?, ?, ?, ?)')
          .run(id, name, xml, t, t, author ?? null);
        q('INSERT INTO versions(diagram_id, version, xml, author, message, created_at) VALUES(?, 1, ?, ?, ?, ?)')
          .run(id, xml, author ?? null, 'Création', t);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return api.getDiagram(id);
    },

    renameDiagram(id, name) {
      const r = q('UPDATE diagrams SET name = ? WHERE id = ?').run(name, id);
      return r.changes > 0;
    },

    deleteDiagram(id) {
      return q('DELETE FROM diagrams WHERE id = ?').run(id).changes > 0;
    },

    /**
     * Enregistre une nouvelle version.
     * - refuse si un autre détenteur tient le verrou (423)
     * - refuse si baseVersion n'est pas la version courante (409, concurrence optimiste)
     */
    saveDiagram(id, { xml, baseVersion, holder, author, message }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = q('SELECT * FROM diagrams WHERE id = ?').get(id);
        if (!row) { db.exec('ROLLBACK'); return { status: 404 }; }
        const lock = lockOf(row);
        if (lock && lock.holder !== holder) { db.exec('ROLLBACK'); return { status: 423, lock }; }
        if (row.version !== baseVersion) {
          db.exec('ROLLBACK');
          return { status: 409, current: { version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at } };
        }
        const v = row.version + 1;
        const t = now();
        q('UPDATE diagrams SET xml = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?')
          .run(xml, v, t, author ?? null, id);
        q('INSERT INTO versions(diagram_id, version, xml, author, message, created_at) VALUES(?, ?, ?, ?, ?, ?)')
          .run(id, v, xml, author ?? null, message ?? null, t);
        q('DELETE FROM versions WHERE diagram_id = ? AND version <= ?').run(id, v - MAX_VERSIONS);
        db.exec('COMMIT');
        return { status: 200, diagram: api.getDiagram(id) };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    listVersions(id) {
      return q('SELECT version, author, message, created_at AS createdAt, length(xml) AS size FROM versions WHERE diagram_id = ? ORDER BY version DESC').all(id);
    },

    getVersion(id, version) {
      return q('SELECT version, xml, author, message, created_at AS createdAt FROM versions WHERE diagram_id = ? AND version = ?').get(id, version) ?? null;
    },

    /** Prend ou renouvelle le verrou d'édition (bail de LOCK_TTL_MS). */
    acquireLock(id, { holder, author }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = q('SELECT * FROM diagrams WHERE id = ?').get(id);
        if (!row) { db.exec('ROLLBACK'); return { status: 404 }; }
        const lock = lockOf(row);
        if (lock && lock.holder !== holder) { db.exec('ROLLBACK'); return { status: 200, acquired: false, lock }; }
        const t = now();
        const since = lock ? lock.since : t;
        q('UPDATE diagrams SET lock_holder = ?, lock_author = ?, lock_since = ?, lock_expires = ? WHERE id = ?')
          .run(holder, author ?? null, since, t + LOCK_TTL_MS, id);
        db.exec('COMMIT');
        return { status: 200, acquired: true, lock: { holder, author, since, expires: t + LOCK_TTL_MS } };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    releaseLock(id, holder) {
      q('UPDATE diagrams SET lock_holder = NULL, lock_author = NULL, lock_since = NULL, lock_expires = NULL WHERE id = ? AND lock_holder = ?')
        .run(id, holder);
    },

    /** Lève le verrou quel que soit le détenteur (administrateur). */
    forceUnlock(id) {
      q('UPDATE diagrams SET lock_holder = NULL, lock_author = NULL, lock_since = NULL, lock_expires = NULL WHERE id = ?').run(id);
    },

    createShare(diagramId, { role, label }) {
      const token = randomBytes(24).toString('base64url');
      q('INSERT INTO shares(token, diagram_id, role, label, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(token, diagramId, role, label ?? null, now());
      return api.getShare(token);
    },

    getShare(token) {
      const r = q('SELECT token, diagram_id AS diagramId, role, label, created_at AS createdAt, revoked_at AS revokedAt FROM shares WHERE token = ?').get(token);
      return r ?? null;
    },

    listShares(diagramId) {
      return q('SELECT token, role, label, created_at AS createdAt FROM shares WHERE diagram_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(diagramId);
    },

    revokeShare(diagramId, token) {
      return q('UPDATE shares SET revoked_at = ? WHERE token = ? AND diagram_id = ? AND revoked_at IS NULL').run(now(), token, diagramId).changes > 0;
    }
  };
  return api;
}
