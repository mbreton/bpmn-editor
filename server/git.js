// Persistance des diagrammes dans un dépôt Git : un fichier .bpmn par diagramme, un commit par
// enregistrement (auteur = la personne connectée). Dépôt distant facultatif : clone au démarrage,
// pull périodique et push après chaque commit.
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const SEP = '\x1f';
const COMMITTER = { name: 'Éditeur BPMN', email: 'bpmn-editor@localhost' };

export class GitError extends Error {}

/** Masque les identifiants d'une URL (https://jeton@hôte → https://***@hôte). */
export const redact = s => String(s || '').replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@');

export function createGitStore({ dir, remote, branch = 'main', subdir = 'diagrams', log = console }) {
  let chain = Promise.resolve();
  /** Sérialise les opérations Git (un seul index.lock à la fois). */
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  const status = { remote: !!remote, branch, lastPullAt: null, lastPushAt: null, lastError: null, pending: false };

  function git(args, { env = {}, allowFail = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', dir, ...args], {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_COMMITTER_NAME: COMMITTER.name, GIT_COMMITTER_EMAIL: COMMITTER.email, ...env }
      }, (err, stdout, stderr) => {
        if (err && !allowFail) return reject(new GitError(redact(`git ${args[0]} : ${stderr || err.message}`.trim())));
        resolve({ ok: !err, stdout, stderr });
      });
    });
  }

  const exists = p => access(p).then(() => true, () => false);

  async function hasCommits() {
    return (await git(['rev-parse', '--verify', 'HEAD'], { allowFail: true })).ok;
  }

  async function init() {
    await mkdir(dir, { recursive: true });
    if (!(await exists(join(dir, '.git')))) {
      if (remote) {
        log.info?.(`[git] clone de ${redact(remote)}`);
        await new Promise((resolve, reject) => execFile('git', ['clone', remote, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
          (err, _o, stderr) => err ? reject(new GitError(redact(`git clone : ${stderr || err.message}`))) : resolve()));
        // Dépôt distant vide : on crée la branche localement.
        if (!(await hasCommits())) await git(['checkout', '-B', branch]);
        else if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() !== branch) {
          const r = await git(['checkout', branch], { allowFail: true });
          if (!r.ok) await git(['checkout', '-b', branch]);
        }
      } else {
        await git(['init', '-b', branch]);
      }
    } else if (remote) {
      await git(['remote', 'set-url', 'origin', remote], { allowFail: true });
    }
    await git(['config', 'core.quotepath', 'false']);
    await mkdir(join(dir, subdir), { recursive: true });
  }

  const authorEnv = a => ({ GIT_AUTHOR_NAME: a?.name || 'Inconnu', GIT_AUTHOR_EMAIL: a?.email || 'inconnu@localhost', ...(a?.date ? { GIT_AUTHOR_DATE: new Date(a.date).toISOString(), GIT_COMMITTER_DATE: new Date(a.date).toISOString() } : {}) });

  async function commit(paths, { author, message }) {
    // Les chemins déplacés ou supprimés sont déjà indexés par git mv / git rm.
    const present = [];
    for (const p of paths) if (await exists(join(dir, p))) present.push(p);
    try {
      if (present.length) await git(['add', '-A', '--', ...present]);
      const staged = await git(['diff', '--cached', '--quiet'], { allowFail: true });
      if (staged.ok) return null; // rien à enregistrer
      await git(['commit', '-q', '-m', message], { env: authorEnv(author) });
    } catch (e) {
      await git(['reset', '-q'], { allowFail: true }); // ne pas laisser l'index sale (bloquerait les pulls)
      throw e;
    }
    schedulePush();
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  // ---------- push différé ----------
  let pushTimer = null;
  function schedulePush() {
    if (!remote) return;
    status.pending = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => serial(push).catch(() => {}), 1500);
  }
  async function push() {
    if (!remote) return;
    let r = await git(['push', '-u', 'origin', branch], { allowFail: true });
    if (!r.ok) {
      // Le distant a avancé : on rebase puis on repousse.
      const pulled = await pullUnsafe();
      if (pulled.ok) r = await git(['push', '-u', 'origin', branch], { allowFail: true });
    }
    if (r.ok) { status.lastPushAt = Date.now(); status.pending = false; status.lastError = null; }
    else { status.lastError = redact(r.stderr.trim()); log.error?.(`[git] push : ${status.lastError}`); }
  }

  async function pullUnsafe() {
    if (!remote) return { ok: true, changed: false };
    const before = (await git(['rev-parse', 'HEAD'], { allowFail: true })).stdout.trim();
    const f = await git(['fetch', 'origin', branch], { allowFail: true });
    if (!f.ok) {
      // Branche absente côté distant (dépôt vide) : ce n'est pas une erreur.
      if (/couldn't find remote ref|could not find remote ref/i.test(f.stderr)) return { ok: true, changed: false };
      status.lastError = redact(f.stderr.trim());
      return { ok: false, error: status.lastError };
    }
    let r;
    if (!before) r = await git(['reset', '--hard', `origin/${branch}`], { allowFail: true });
    else r = await git(['rebase', `origin/${branch}`], { allowFail: true, env: { GIT_EDITOR: 'true' } });
    if (!r.ok) {
      await git(['rebase', '--abort'], { allowFail: true });
      status.lastError = redact(`Synchronisation impossible (conflit) : ${r.stderr.trim()}`);
      return { ok: false, error: status.lastError };
    }
    status.lastPullAt = Date.now();
    const after = (await git(['rev-parse', 'HEAD'], { allowFail: true })).stdout.trim();
    return { ok: true, changed: before !== after };
  }

  return {
    status,
    subdir,
    init: () => serial(init),
    pull: () => serial(pullUnsafe),
    sync: () => serial(async () => { const p = await pullUnsafe(); if (p.ok) await push(); return p; }),

    /** Écrit le fichier et crée un commit. Renvoie le sha (ou null si contenu identique). */
    write: (path, content, meta) => serial(async () => {
      const abs = join(dir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return commit([path], meta);
    }),

    move: (from, to, meta) => serial(async () => {
      await mkdir(dirname(join(dir, to)), { recursive: true });
      await git(['mv', '-k', '--', from, to]);
      return commit([from, to], meta);
    }),

    remove: (path, meta) => serial(async () => {
      await git(['rm', '-q', '--ignore-unmatch', '--', path]);
      return commit([path], meta);
    }),

    read: path => readFile(join(dir, path), 'utf8'),
    has: path => exists(join(dir, path)),

    /** Historique d'un fichier, du plus récent au plus ancien. */
    history: path => serial(async () => {
      if (!(await hasCommits())) return [];
      const r = await git(['log', '--follow', `--format=%H${SEP}%an${SEP}%ae${SEP}%at${SEP}%s`, '--', path], { allowFail: true });
      if (!r.ok) return [];
      const rows = r.stdout.trim().split('\n').filter(Boolean).map(l => {
        const [sha, author, email, at, message] = l.split(SEP);
        return { sha, author, email, createdAt: Number(at) * 1000, message };
      });
      return rows.map((v, i) => ({ ...v, version: rows.length - i }));
    }),

    /** Dernier commit qui touche le fichier. */
    head: path => serial(async () => {
      if (!(await hasCommits())) return null;
      const r = await git(['log', '-1', '--format=%H', '--', path], { allowFail: true });
      return r.stdout.trim() || null;
    }),

    /** Contenu du fichier à une révision donnée (suit les renommages via l'historique). */
    show: (sha, path) => serial(async () => {
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new GitError('Révision invalide.');
      const names = await git(['log', '--follow', '--name-only', '--format=%H', '--', path], { allowFail: true });
      // Retrouve le chemin du fichier tel qu'il était à ce commit.
      let pathAt = path;
      const lines = names.stdout.split('\n');
      for (let i = 0; i < lines.length; i++) if (lines[i].startsWith(sha)) { pathAt = lines.slice(i + 1).find(Boolean) || path; break; }
      const r = await git(['show', `${sha}:${pathAt}`], { allowFail: true });
      if (!r.ok) throw new GitError('Version introuvable.');
      return r.stdout;
    }),

    /** Fichiers .bpmn suivis par Git. */
    files: () => serial(async () => {
      const r = await git(['ls-files', '-z', '--', `${subdir}/*.bpmn`], { allowFail: true });
      return r.stdout.split('\0').filter(Boolean);
    }),

    /** Dernière modification (date, auteur) d'un fichier. */
    lastChange: path => serial(async () => {
      if (!(await hasCommits())) return null;
      const r = await git(['log', '-1', `--format=%at${SEP}%an`, '--', path], { allowFail: true });
      const [at, author] = r.stdout.trim().split(SEP);
      return at ? { at: Number(at) * 1000, author } : null;
    }),

    authorEnv
  };
}
