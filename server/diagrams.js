// Diagrammes : index en base (nom, chemin, verrou) + contenu et historique dans Git.
import { emptyDiagram } from './templates.js';

export function slugify(name) {
  const s = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return s || 'diagramme';
}

const unslug = file => {
  const base = file.split('/').pop().replace(/\.bpmn$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : 'Diagramme';
};

const authorOf = user => ({ name: user.name, email: user.email });

export function createDiagrams({ db, git }) {
  function freePath(name, except) {
    const base = `${git.subdir}/${slugify(name)}`;
    const taken = db.allPaths();
    let p = `${base}.bpmn`;
    for (let i = 2; taken.has(p) && p !== except; i++) p = `${base}-${i}.bpmn`;
    return p;
  }

  return {
    list: () => db.listDiagrams(),

    async get(id) {
      const d = db.getDiagram(id);
      if (!d) return null;
      const [xml, history] = await Promise.all([git.read(d.path), git.history(d.path)]);
      return { ...d, xml, rev: history[0]?.sha || null, version: history.length };
    },

    async create({ name, xml, user }) {
      const path = freePath(name);
      const content = xml || emptyDiagram(name);
      const sha = await git.write(path, content, { author: authorOf(user), message: xml ? `Import : ${name}` : `Création : ${name}` });
      const d = db.insertDiagram({ name, path, updatedBy: user.name });
      return { ...d, rev: sha, version: 1 };
    },

    /**
     * Enregistre une version. Exige le verrou (holder) et la révision de départ (baseRev) :
     * 423 si quelqu'un d'autre modifie, 409 si le fichier a changé entre-temps.
     */
    async save(id, { xml, baseRev, holder, user, message }) {
      const d = db.getDiagram(id);
      if (!d) return { status: 404 };
      if (!d.lock || d.lock.holder !== holder) return { status: 423, lock: d.lock };
      const head = await git.head(d.path);
      if (head !== baseRev) {
        const h = (await git.history(d.path))[0];
        return { status: 409, current: { rev: head, version: h?.version, updatedBy: h?.author, updatedAt: h?.createdAt } };
      }
      const sha = await git.write(d.path, xml, { author: authorOf(user), message: message || `Modification de ${d.name}` });
      db.touchDiagram(id, { updatedBy: user.name });
      return { status: 200, diagram: await this.get(id), changed: !!sha };
    },

    async rename(id, name, user) {
      const d = db.getDiagram(id);
      if (!d) return null;
      const path = freePath(name, d.path);
      if (path !== d.path) await git.move(d.path, path, { author: authorOf(user), message: `Renommage : ${d.name} → ${name}` });
      db.renameDiagram(id, name, path);
      return db.getDiagram(id);
    },

    async remove(id, user) {
      const d = db.getDiagram(id);
      if (!d) return false;
      await git.remove(d.path, { author: authorOf(user), message: `Suppression : ${d.name}` });
      return db.deleteDiagram(id);
    },

    history: async id => { const d = db.getDiagram(id); return d ? git.history(d.path) : null; },
    version: async (id, sha) => { const d = db.getDiagram(id); return d ? git.show(sha, d.path) : null; },

    /** Aligne l'index sur les fichiers du dépôt (après un clone ou un pull). */
    async reindex() {
      const files = await git.files();
      const known = db.allPaths();
      let added = 0, removed = 0;
      for (const f of files) {
        if (known.has(f)) continue;
        const last = await git.lastChange(f);
        db.insertDiagram({ name: unslug(f), path: f, createdAt: last?.at, updatedAt: last?.at, updatedBy: last?.author });
        added++;
      }
      const present = new Set(files);
      for (const p of known) if (!present.has(p)) { db.deleteByPath(p); removed++; }
      for (const d of db.listDiagrams()) {
        const last = await git.lastChange(d.path);
        if (last && last.at > d.updatedAt) db.touchDiagram(d.id, { updatedAt: last.at, updatedBy: last.author });
      }
      return { added, removed };
    },

    /** Reprend les diagrammes et versions de l'ancien stockage SQLite sous forme de commits. */
    async migrateLegacy(log = console) {
      const legacy = db.legacy();
      if (!legacy) return 0;
      for (const ld of legacy.diagrams) {
        const path = freePath(ld.name);
        const versions = legacy.versions.filter(v => v.diagram_id === ld.id);
        let last = null;
        for (const v of versions) {
          await git.write(path, v.xml, {
            author: { name: v.author || 'Inconnu', email: 'inconnu@localhost', date: v.created_at },
            message: v.message || `Version ${v.version}`
          });
          last = v;
        }
        if (last) db.insertDiagram({ id: ld.id, name: ld.name, path, createdAt: ld.created_at, updatedAt: last.created_at, updatedBy: last.author });
      }
      db.dropLegacy();
      log.info?.(`[migration] ${legacy.diagrams.length} diagramme(s) repris dans Git.`);
      return legacy.diagrams.length;
    }
  };
}
