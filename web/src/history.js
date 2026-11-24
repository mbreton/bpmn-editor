// Historique des versions : consultation sur le canevas, restauration.
import { api } from './api.js';
import { h, esc, fmtDate, toast } from './dom.js';

export function createHistory(ctx, host) {
  let viewing = null;   // numéro de version affichée
  let savedXml = null;  // état du canevas avant consultation

  const el = h(`<div class="props">
    <h3 class="props-title">Historique</h3>
    <p class="muted small">Chaque enregistrement crée une version. Cliquez sur une version pour l'afficher sur le diagramme.</p>
    <ol class="versions"><li class="muted">Chargement…</li></ol>
  </div>`);
  host.append(el);
  const list = el.querySelector('.versions');

  async function load() {
    try {
      const items = await api.versions(ctx.id);
      list.innerHTML = items.map(v => `<li><button class="ver ${v.version === ctx.version ? 'cur' : ''} ${v.version === viewing ? 'on' : ''}" data-v="${v.version}">
        <b>v${v.version}</b>${v.version === ctx.version ? ' <span class="tag soft">actuelle</span>' : ''}
        <span class="muted small">${esc(fmtDate(v.createdAt))}${v.author ? ' · ' + esc(v.author) : ''}</span>
        ${v.message ? `<span class="small">${esc(v.message)}</span>` : ''}
      </button></li>`).join('');
    } catch (e) { list.innerHTML = `<li class="error">${esc(e.message)}</li>`; }
  }

  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const v = Number(b.dataset.v);
    if (ctx.previewing && viewing === null) { toast('Terminez d\'abord la proposition de l\'IA en cours.', 'error'); return; }
    if (v === ctx.version && viewing === null) return;
    await show(v);
  });

  async function show(v) {
    const ver = await api.version(ctx.id, v);
    if (viewing === null) savedXml = await ctx.getXml();
    viewing = v;
    ctx.previewing = true;
    await ctx.importXml(ver.xml, { fit: false });
    ctx.emit('mode', 'history');
    const banner = h(`<div class="banner-in">
      <div><b>Version ${v}</b> <span class="muted small">${esc(fmtDate(ver.createdAt))}${ver.author ? ' · ' + esc(ver.author) : ''}</span></div>
      <div class="row">
        <button class="btn" data-a="close">Revenir à la version de travail</button>
        ${ctx.canEdit ? `<button class="btn primary" data-a="restore" ${ctx.editing ? '' : 'disabled title="Passez en mode édition pour restaurer"'}>Restaurer cette version</button>` : ''}
      </div></div>`);
    banner.querySelector('[data-a=close]').addEventListener('click', close);
    banner.querySelector('[data-a=restore]')?.addEventListener('click', async () => {
      ctx.hideBanner();
      ctx.previewing = false;
      viewing = null; savedXml = null;
      ctx.applyLock();
      ctx.markDirty(`Restauration de la version ${v}`);
      ctx.emit('mode', 'edit');
      toast(`Version ${v} restaurée : enregistrez pour la publier.`);
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
  ctx.on('editing', async on => { if (!on && viewing !== null) await close(); });
  load();
  return { destroy() {} };
}
