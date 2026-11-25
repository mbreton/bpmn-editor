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

    /** Diagramme avec son brouillon : `xml` est l'état de travail courant, `committedXml` la dernière version Git. */
    async get(id) {
      const d = db.getDiagram(id);
      if (!d) return null;
      const [committedXml, history] = await Promise.all([git.read(d.path), git.history(d.path)]);
      const draftXml = db.draftXml(id);
      const info = db.draftInfo(id);
      return {
        ...d, xml: draftXml ?? committedXml, committedXml, rev: history[0]?.sha || null, version: history.length,
        draft: { ...(info || { seq: 0, canUndo: false, canRedo: false }), dirty: draftXml !== null && draftXml !== committedXml }
      };
    },

    /** Enregistre une étape du brouillon (sauvegarde continue, sans commit). */
    async writeDraft(id, { xml, user, label, source }) {
      const d = db.getDiagram(id);
      if (!d) return null;
      const baseXml = db.draftXml(id) === null ? await git.read(d.path) : null;
      const r = db.pushStep(id, { xml, author: user.name, label, source, baseXml });
      db.touchDiagram(id, { updatedBy: user.name });
      return { ...r, draft: await this.draftState(id) };
    },

    async draftState(id) {
      const d = db.getDiagram(id);
      const info = db.draftInfo(id) || { seq: 0, canUndo: false, canRedo: false };
      const xml = db.draftXml(id);
      return { ...info, dirty: xml !== null && xml !== await git.read(d.path) };
    },

    /** Annuler (-1) ou rétablir (+1) une étape du brouillon. */
    async step(id, delta) {
      const r = db.moveStep(id, delta);
      if (!r) return null;
      return { ...r, xml: db.draftXml(id), draft: await this.draftState(id) };
    },

    /** Crée une version Git à partir du brouillon courant. */
    async commit(id, { user, message }) {
      const d = db.getDiagram(id);
      if (!d) return { status: 404 };
      const xml = db.draftXml(id);
      if (xml === null || xml === await git.read(d.path)) return { status: 204 };
      await git.write(d.path, xml, { author: authorOf(user), message: message || `Modification de ${d.name}` });
      db.touchDiagram(id, { updatedBy: user.name });
      return { status: 200, diagram: await this.get(id) };
    },

    /** Remet une ancienne version dans le brouillon (annulable). */
    async restore(id, sha, user) {
      const versions = await this.history(id);
      const v = versions?.find(x => x.sha.startsWith(sha));
      if (!v) return null;
      const xml = await this.version(id, v.sha);
      const r = await this.writeDraft(id, { xml, user, label: `Retour à la version ${v.version}`, source: 'restore' });
      return { ...r, xml, version: v };
    },

    async create({ name, xml, user }) {
      const path = freePath(name);
      const content = xml || emptyDiagram(name);
      const sha = await git.write(path, content, { author: authorOf(user), message: xml ? `Import : ${name}` : `Création : ${name}` });
      const d = db.insertDiagram({ name, path, updatedBy: user.name });
      return { ...d, rev: sha, version: 1 };
    },

    /** Copie un diagramme (état de travail courant, brouillon compris) sous un nouveau nom libre. */
    async duplicate(id, { name, user, version }) {
      const src = await this.get(id);
      if (!src) return null;
      // une ancienne version (numéro ou sha) plutôt que l'état courant : « fork » de cette version
      let xml = src.xml, from = '';
      if (version !== undefined && version !== null && version !== '') {
        const history = await git.history(src.path);
        const v = history.find(x => String(x.version) === String(version) || (String(version).length >= 7 && x.sha.startsWith(String(version))));
        if (!v) return { error: `Version « ${version} » introuvable.` };
        xml = await git.show(v.sha, src.path);
        from = ` (version ${v.version})`;
      }
      const taken = new Set(db.listDiagrams().map(d => d.name));
      let n = (name || '').trim() || `${src.name}${from ? ` v${from.match(/\d+/)[0]}` : ''} (copie)`;
      if (taken.has(n)) { const base = n.replace(/ \(copie(?: \d+)?\)$/, ''); for (let k = 2; taken.has(n); k++) n = `${base} (copie ${k})`; }
      const path = freePath(n);
      const sha = await git.write(path, xml, { author: authorOf(user), message: `Copie de ${src.name}${from} : ${n}` });
      const d = db.insertDiagram({ name: n, path, updatedBy: user.name });
      return { ...d, rev: sha, version: 1 };
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
