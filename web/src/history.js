// Historique Git du diagramme : consultation d'une version sur le canevas, restauration.
import { api } from './api.js';
import { h, esc, fmtDate, toast } from './dom.js';

export function createHistory(ctx, host) {
  let viewing = null;   // sha affiché
  let savedXml = null;  // état du canevas avant consultation
  let items = [];

  const el = h(`<div class="props">
    <p class="muted small">Chaque enregistrement est un commit Git signé par son auteur. Cliquez sur une version pour l'afficher sur le diagramme, puis restaurez-la si besoin.</p>
    <ol class="versions"><li class="muted">Chargement…</li></ol>
  </div>`);
  host.append(el);
  const list = el.querySelector('.versions');

  async function load() {
    try {
      items = await api.versions(ctx.id);
      list.innerHTML = items.map(v => `<li><button class="ver ${v.sha === ctx.rev ? 'cur' : ''} ${v.sha === viewing ? 'on' : ''}" data-sha="${esc(v.sha)}">
        <span class="ver-head"><b>v${v.version}</b>${v.sha === ctx.rev ? '<span class="tag soft">actuelle</span>' : ''}<span class="mono muted small">${esc(v.sha.slice(0, 7))}</span></span>
        <span class="muted small">${esc(fmtDate(v.createdAt))} · ${esc(v.author)}</span>
        ${v.message ? `<span class="small">${esc(v.message)}</span>` : ''}
      </button></li>`).join('') || '<li class="muted">Aucune version.</li>';
    } catch (e) { list.innerHTML = `<li class="error">${esc(e.message)}</li>`; }
  }

  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-sha]');
    if (!b) return;
    const sha = b.dataset.sha;
    if (ctx.previewing && viewing === null) { toast('Terminez d\'abord la revue de l\'assistant en cours.', 'error'); return; }
    if (sha === ctx.rev && viewing === null) return;
    if (sha === ctx.rev) return close();
    await show(sha);
  });

  async function show(sha) {
    const v = items.find(x => x.sha === sha);
    const { xml } = await api.version(ctx.id, sha);
    if (viewing === null) savedXml = await ctx.getXml();
    viewing = sha;
    ctx.previewing = true;
    await ctx.importXml(xml, { fit: false });
    ctx.emit('mode', 'history');
    const banner = h(`<div class="banner-in">
      <div><b>Version ${v.version}</b> <span class="muted small">${esc(fmtDate(v.createdAt))} · ${esc(v.author)}${v.message ? ' · ' + esc(v.message) : ''}</span></div>
      <div class="row">
        <button class="btn" data-a="close">Revenir à la version de travail</button>
        <button class="btn primary" data-a="restore" ${ctx.editing ? '' : 'disabled title="Passez en mode édition pour restaurer"'}>Restaurer cette version</button>
      </div></div>`);
    banner.querySelector('[data-a=close]').addEventListener('click', close);
    banner.querySelector('[data-a=restore]').addEventListener('click', () => {
      ctx.hideBanner();
      ctx.previewing = false;
      viewing = null; savedXml = null;
      ctx.applyLock();
      ctx.markDirty(`Restauration de la version ${v.version} (${sha.slice(0, 7)})`);
      ctx.emit('mode', 'edit');
      toast(`Version ${v.version} restaurée : enregistrez pour la publier.`);
      load();
    });
    ctx.showBanner(banner);
    load();
  }

  async function close() {
    ctx.hideBanner();
    ctx.previewing = false;
    if (savedXml) await ctx.importXml(savedXml, { fit: false });
    viewing = null; savedXml = null;
    ctx.emit('mode', 'edit');
    load();
  }

  ctx.on('tab', t => { if (t === 'history') load(); });
  ctx.on('saved', load);
  ctx.on('editing', async on => { if (!on && viewing !== null) await close(); else load(); });
  load();
  return { destroy() {} };
}
