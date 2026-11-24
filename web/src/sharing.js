// Liens de partage (administrateur) : lecture ou modification, révocables.
import { api } from './api.js';
import { h, esc, fmtDate, toast } from './dom.js';

export function createSharing(ctx, host) {
  const el = h(`<div class="props">
    <h3 class="props-title">Partager</h3>
    <p class="muted small">Un lien donne accès à ce diagramme uniquement, sans compte. Révoquez-le à tout moment.</p>
    <form class="share-new">
      <div class="fld"><label class="lbl" for="shLabel">Pour qui ?</label><input class="field" id="shLabel" placeholder="Ex. Équipe assureur"></div>
      <div class="fld"><span class="lbl">Accès</span>
        <div class="seg" role="radiogroup">
          <button type="button" role="radio" aria-checked="true" data-r="view">Lecture et simulation</button>
          <button type="button" role="radio" aria-checked="false" data-r="edit">Modification</button>
        </div></div>
      <button class="btn primary block" type="submit">Créer le lien</button>
    </form>
    <h4>Liens actifs</h4>
    <ul class="shares"></ul>
  </div>`);
  host.append(el);
  let role = 'view';
  el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => {
    role = b.dataset.r;
    el.querySelectorAll('[data-r]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  }));

  const linkOf = token => `${location.origin}/s/${token}`;

  async function load() {
    const ul = el.querySelector('.shares');
    try {
      const items = await api.shares(ctx.id);
      if (!items.length) { ul.innerHTML = '<li class="muted">Aucun lien actif.</li>'; return; }
      ul.innerHTML = items.map(s => `<li class="share">
        <div><b>${esc(s.label || 'Sans libellé')}</b> <span class="tag ${s.role === 'edit' ? 'accent' : 'soft'}">${s.role === 'edit' ? 'Modification' : 'Lecture'}</span>
        <span class="muted small">créé le ${esc(fmtDate(s.createdAt))}</span></div>
        <input class="field mono small" readonly value="${esc(linkOf(s.token))}">
        <div class="row"><button class="btn small" data-copy="${esc(s.token)}">Copier</button><button class="btn small ghost danger" data-revoke="${esc(s.token)}">Révoquer</button></div>
      </li>`).join('');
    } catch (e) { ul.innerHTML = `<li class="error">${esc(e.message)}</li>`; }
  }

  el.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const s = await api.share(ctx.id, role, el.querySelector('#shLabel').value.trim());
    el.querySelector('#shLabel').value = '';
    await load();
    copy(s.token);
  });

  el.querySelector('.shares').addEventListener('click', async e => {
    const c = e.target.closest('[data-copy]');
    const r = e.target.closest('[data-revoke]');
    if (c) copy(c.dataset.copy);
    if (r) { await api.revoke(ctx.id, r.dataset.revoke); toast('Lien révoqué.'); load(); }
  });

  async function copy(token) {
    try { await navigator.clipboard.writeText(linkOf(token)); toast('Lien copié dans le presse-papiers.'); }
    catch { toast('Copie impossible : sélectionnez le lien et copiez-le.', 'error'); }
  }

  ctx.on('tab', t => { if (t === 'share') load(); });
  return { destroy() {} };
}
