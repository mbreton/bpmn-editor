import './styles.css';
import { api, setShareToken, ApiError } from './api.js';
import { $, h, esc, fmtDate, toast, dialog } from './dom.js';
import { openEditor } from './editor.js';

const app = $('#app');
let cfg = null;
let closeCurrent = null;

function navigate(path) {
  history.pushState(null, '', path);
  route();
}
window.addEventListener('popstate', () => route());
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});

async function route() {
  if (closeCurrent) { await closeCurrent(); closeCurrent = null; }
  cfg = await api.config().catch(() => ({ admin: false, loginEnabled: false, ai: null }));
  const path = location.pathname;
  let m;
  if ((m = /^\/s\/([\w-]+)\/?$/.exec(path))) return openShared(m[1]);
  if (!cfg.admin) return renderLogin();
  if ((m = /^\/d\/([\w-]+)\/?$/.exec(path))) {
    setShareToken(null);
    closeCurrent = await openEditor(app, { id: m[1], isAdmin: true, cfg, onBack: () => navigate('/') });
    return;
  }
  return renderLibrary();
}

async function openShared(token) {
  setShareToken(token);
  try {
    const s = await api.resolveShare(token);
    closeCurrent = await openEditor(app, { id: s.diagramId, isAdmin: cfg.admin, cfg, shared: true });
  } catch (e) {
    app.innerHTML = `<main class="center-page"><div class="card narrow"><h1>Lien indisponible</h1><p>Ce lien de partage est invalide ou a été révoqué. Demandez un nouveau lien à la personne qui vous l'a envoyé.</p></div></main>`;
  }
}

function renderLogin() {
  document.title = 'Connexion · Éditeur BPMN';
  app.innerHTML = `<main class="center-page"><form class="card narrow" id="login">
    <div class="brand-mark" aria-hidden="true"></div>
    <h1>Éditeur BPMN</h1>
    <p class="muted">${cfg.loginEnabled ? 'Connectez-vous pour gérer vos diagrammes. Les personnes invitées passent par leur lien de partage.' : 'La connexion administrateur n\'est pas configurée sur ce serveur (variable ADMIN_PASSWORD).'}</p>
    ${cfg.loginEnabled ? `<label class="lbl" for="pw">Mot de passe</label>
    <input class="field" id="pw" type="password" autocomplete="current-password" required>
    <button class="btn primary block" type="submit">Se connecter</button>
    <p class="error" id="err" role="alert"></p>` : ''}
  </form></main>`;
  const form = $('#login');
  $('#pw')?.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.login($('#pw').value);
      route();
    } catch (err) {
      $('#err').textContent = err.status === 429 ? 'Trop de tentatives, réessayez dans quelques minutes.' : err.message;
    }
  });
}

async function renderLibrary() {
  document.title = 'Diagrammes · Éditeur BPMN';
  app.innerHTML = `<div class="lib">
    <header class="lib-head">
      <div><h1>Diagrammes</h1><p class="muted">Chaque diagramme a son historique, son verrou d'édition et ses liens de partage.</p></div>
      <div class="row">
        <label class="btn" for="imp">Importer un .bpmn</label><input type="file" id="imp" accept=".bpmn,.xml" hidden>
        <button class="btn primary" id="new">Nouveau diagramme</button>
        <button class="btn ghost" id="logout">Se déconnecter</button>
      </div>
    </header>
    <div id="list" class="lib-list"><p class="muted">Chargement…</p></div>
  </div>`;

  $('#logout').onclick = async () => { await api.logout(); route(); };
  $('#new').onclick = async () => {
    const name = await dialog({ title: 'Nouveau diagramme', input: { placeholder: 'Ex. Onboarding client' }, buttons: [{ label: 'Annuler', value: null }, { label: 'Créer', value: '$input', primary: true }] });
    if (!name?.trim()) return;
    const d = await api.create(name.trim());
    navigate(`/d/${d.id}`);
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const d = await api.create(f.name.replace(/\.(bpmn|xml)$/i, ''), await f.text());
      navigate(`/d/${d.id}`);
    } catch (err) { toast(err.message, 'error'); }
  };

  let items;
  try { items = await api.list(); } catch (e) { $('#list').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const list = $('#list');
  if (!items.length) {
    list.innerHTML = `<div class="empty-lib"><h2>Aucun diagramme pour l'instant</h2><p class="muted">Créez un diagramme vide ou importez un fichier .bpmn existant.</p></div>`;
    return;
  }
  list.innerHTML = items.map(d => `<article class="lib-item">
    <a class="lib-link" data-link href="/d/${esc(d.id)}"><b>${esc(d.name)}</b>
      <span class="muted">v${d.version} · ${esc(fmtDate(d.updatedAt))}${d.updatedBy ? ' · ' + esc(d.updatedBy) : ''}</span></a>
    ${d.lock ? `<span class="pill warn">${esc(d.lock.author || 'Quelqu\'un')} modifie</span>` : ''}
    <button class="btn small ghost" data-act="rename" data-id="${esc(d.id)}">Renommer</button>
    <button class="btn small ghost danger" data-act="del" data-id="${esc(d.id)}">Supprimer</button>
  </article>`).join('');
  list.onclick = async e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const d = items.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'rename') {
      const name = await dialog({ title: 'Renommer', input: { value: d.name }, buttons: [{ label: 'Annuler', value: null }, { label: 'Renommer', value: '$input', primary: true }] });
      if (name?.trim()) { await api.rename(d.id, name.trim()); renderLibrary(); }
    } else {
      const ok = await dialog({ title: 'Supprimer ce diagramme ?', body: `« ${d.name} », son historique et ses liens de partage seront supprimés définitivement.`, buttons: [{ label: 'Annuler', value: false }, { label: 'Supprimer', value: true, danger: true, primary: true }] });
      if (ok) { await api.remove(d.id); toast('Diagramme supprimé.'); renderLibrary(); }
    }
  };
}

window.addEventListener('unhandledrejection', e => {
  if (e.reason instanceof ApiError) { toast(e.reason.message, 'error'); e.preventDefault(); }
});

route();
