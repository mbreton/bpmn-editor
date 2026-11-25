import './styles.css';
import { api, ApiError, setUnauthorizedHandler } from './api.js';
import { $, h, esc, fmtDate, toast, dialog } from './dom.js';
import { openEditor } from './editor.js';

const app = $('#app');
let cfg = null;
let closeCurrent = null;

function navigate(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
window.addEventListener('popstate', () => route());
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});
setUnauthorizedHandler(() => { if (cfg?.user) { cfg.user = null; toast('Session expirée : reconnectez-vous.', 'error'); route(); } });

async function route() {
  if (closeCurrent) { const c = closeCurrent; closeCurrent = null; await c(); }
  cfg = await api.config().catch(() => ({ user: null, ai: null, git: {} }));
  const path = location.pathname;
  // retour vers l'autorisation OAuth (connecteur Claude) après connexion
  const oauthNext = new URLSearchParams(location.search).get('next');
  const safeNext = oauthNext && /^\/oauth\/authorize\?/.test(oauthNext) ? oauthNext : null;
  if (!cfg.user) return renderAuth(safeNext || path);
  if (safeNext) { location.href = safeNext; return; }
  let m;
  if ((m = /^\/d\/([\w-]+)\/?$/.exec(path))) {
    closeCurrent = await openEditor(app, { id: m[1], user: cfg.user, cfg, onBack: () => navigate('/') });
    return;
  }
  if (path === '/admin' && cfg.user.role === 'admin') return renderAdmin();
  if (path !== '/') history.replaceState(null, '', '/');
  return renderLibrary();
}

// ---------- connexion / inscription ----------
function renderAuth(nextPath) {
  document.title = 'Connexion · Éditeur BPMN';
  const next = nextPath || '/';
  app.innerHTML = `<main class="center-page"><div class="card narrow auth">
    <div class="brand-mark" aria-hidden="true"></div>
    <h1>Éditeur BPMN</h1>
    <div class="seg" role="tablist">
      <button type="button" role="tab" aria-checked="true" data-m="login">Se connecter</button>
      <button type="button" role="tab" aria-checked="false" data-m="register">Créer un compte</button>
    </div>
    <form id="authForm" novalidate>
      <div class="fld reg-only"><label class="lbl" for="aName">Nom affiché</label><input class="field" id="aName" autocomplete="name" placeholder="Prénom Nom"></div>
      <div class="fld"><label class="lbl" for="aEmail">E-mail</label><input class="field" id="aEmail" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false"></div>
      <div class="fld"><label class="lbl" for="aPw">Mot de passe</label><input class="field" id="aPw" type="password" autocomplete="current-password"></div>
      <p class="muted small reg-only">8 caractères minimum. Un administrateur validera votre compte avant votre première connexion.</p>
      <button class="btn primary block" type="submit">Se connecter</button>
      <p class="error" id="err" role="alert"></p>
      <p class="ok-msg" id="okMsg" role="status"></p>
    </form>
  </div></main>`;
  const form = $('#authForm');
  let mode = 'login';
  const setMode = m => {
    mode = m;
    app.querySelectorAll('[data-m]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.m === m)));
    form.classList.toggle('register', m === 'register');
    form.querySelector('[type=submit]').textContent = m === 'login' ? 'Se connecter' : 'Créer mon compte';
    $('#aPw').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#err').textContent = '';
    (m === 'register' ? $('#aName') : $('#aEmail')).focus();
  };
  app.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { $('#okMsg').textContent = ''; setMode(b.dataset.m); }));
  setMode('login');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    $('#err').textContent = '';
    const email = $('#aEmail').value.trim(), pw = $('#aPw').value;
    try {
      if (mode === 'register') {
        await api.register($('#aName').value.trim(), email, pw);
        setMode('login');
        $('#okMsg').textContent = 'Compte créé. Vous pourrez vous connecter dès qu\'un administrateur l\'aura validé.';
        $('#aPw').value = '';
        return;
      }
      await api.login(email, pw);
      const after = await api.config();
      if (!after.user) { $('#err').textContent = 'Connexion acceptée, mais le navigateur n\'a pas conservé la session. Vérifiez que COOKIE_SECURE n\'est pas forcé à true alors que le site est en HTTP.'; return; }
      if (next.startsWith('/oauth/')) { location.href = next; return; }
      navigate(next, true);
    } catch (err) {
      $('#err').textContent = err.status === 429 ? 'Trop de tentatives, réessayez dans quelques minutes.' : err.message;
    }
  });
}

// ---------- en-tête commun ----------
function header(title, subtitle) {
  const u = cfg.user;
  const pending = cfg.pendingUsers ? ` <span class="badge">${cfg.pendingUsers}</span>` : '';
  return `<header class="lib-head">
    <div><h1>${esc(title)}</h1>${subtitle ? `<p class="muted">${subtitle}</p>` : ''}</div>
    <nav class="row user-nav">
      ${location.pathname !== '/' ? '<a class="btn ghost" data-link href="/">Diagrammes</a>' : ''}
      ${u.role === 'admin' && location.pathname !== '/admin' ? `<a class="btn ghost" data-link href="/admin">Administration${pending}</a>` : ''}
      <button class="btn ghost" id="me" title="${esc(u.email)}">${esc(u.name)}</button>
      <button class="btn ghost" id="logout">Se déconnecter</button>
    </nav>
  </header>`;
}

function bindHeader() {
  $('#logout').onclick = async () => { await api.logout(); cfg.user = null; navigate('/'); };
  $('#me').onclick = accountDialog;
}

async function accountDialog() {
  const body = h(`<div class="form-grid">
    <div class="fld"><label class="lbl" for="meName">Nom affiché (utilisé dans l'historique)</label><input class="field" id="meName"></div>
    <div class="fld"><label class="lbl" for="meCur">Mot de passe actuel</label><input class="field" id="meCur" type="password" autocomplete="current-password" placeholder="Seulement pour changer de mot de passe"></div>
    <div class="fld"><label class="lbl" for="meNew">Nouveau mot de passe</label><input class="field" id="meNew" type="password" autocomplete="new-password"></div>
  </div>`);
  body.querySelector('#meName').value = cfg.user.name;
  const conn = h(`<section class="connect-box">
    <h3>Connecter Claude</h3>
    <p class="muted small">Ajoutez cet éditeur comme connecteur dans Claude (Paramètres → Connecteurs → Ajouter un connecteur personnalisé) : Claude pourra lire vos diagrammes, les modifier en direct sous vos yeux, zoomer sur ce dont il parle et enregistrer des versions à votre demande.</p>
    <div class="row"><input class="field mono" id="mcpUrl" readonly><button class="btn" id="mcpCopy" type="button">Copier</button></div>
    <p class="muted small" id="mcpWarn" hidden>⚠ Le site est servi en HTTP : Claude exige une adresse HTTPS pour les connecteurs.</p>
    <h4>Applications connectées</h4><ul class="grants"><li class="muted small">Chargement…</li></ul>
  </section>`);
  body.append(conn);
  const loadConnections = async () => {
    try {
      const c = await api.connections();
      conn.querySelector('#mcpUrl').value = c.mcpUrl;
      conn.querySelector('#mcpWarn').hidden = c.mcpUrl.startsWith('https:');
      const ul = conn.querySelector('.grants');
      ul.innerHTML = c.grants.map(g => `<li><span><b>${esc(g.name)}</b> <span class="muted small">autorisée le ${esc(fmtDate(g.since))}${g.lastUsed ? ` · utilisé ${esc(fmtDate(g.lastUsed))}` : ''}</span></span> <button class="btn small danger" type="button" data-c="${esc(g.clientId)}">Révoquer</button></li>`).join('') || '<li class="muted small">Aucune.</li>';
    } catch (e) { conn.querySelector('.grants').innerHTML = `<li class="error small">${esc(e.message)}</li>`; }
  };
  conn.addEventListener('click', async e => {
    if (e.target.id === 'mcpCopy') { conn.querySelector('#mcpUrl').select(); try { await navigator.clipboard.writeText(conn.querySelector('#mcpUrl').value); toast('Adresse copiée.'); } catch { document.execCommand('copy'); } }
    const c = e.target.dataset.c;
    if (c) { await api.revokeConnection(c); toast('Accès révoqué.'); loadConnections(); }
  });
  loadConnections();
  const ok = await dialog({ title: 'Mon compte', body, buttons: [{ label: 'Annuler', value: false }, { label: 'Enregistrer', value: true, primary: true }] });
  if (!ok) return;
  const fields = {};
  const name = body.querySelector('#meName').value.trim();
  if (name && name !== cfg.user.name) fields.name = name;
  if (body.querySelector('#meNew').value) { fields.password = body.querySelector('#meNew').value; fields.currentPassword = body.querySelector('#meCur').value; }
  if (!Object.keys(fields).length) return;
  try { await api.updateMe(fields); toast('Compte mis à jour.'); route(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- bibliothèque ----------
async function renderLibrary() {
  document.title = 'Diagrammes · Éditeur BPMN';
  app.innerHTML = `<div class="lib">
    ${header('Diagrammes', `Les modifications sont sauvegardées en continu ; « Enregistrer une version » crée un commit Git signé par son auteur${cfg.git?.remote ? ', poussé vers le dépôt distant' : ''}. Pour partager un diagramme, copiez simplement l'adresse de sa page.`)}
    <div class="row lib-actions">
      <button class="btn primary" id="new">Nouveau diagramme</button>
      <label class="btn" for="imp">Importer un .bpmn</label><input type="file" id="imp" accept=".bpmn,.xml" hidden>
      <input class="field search" id="q" type="search" placeholder="Rechercher…" aria-label="Rechercher un diagramme">
    </div>
    <div id="list" class="lib-list"><p class="muted">Chargement…</p></div>
  </div>`;
  bindHeader();

  $('#new').onclick = async () => {
    const name = await dialog({ title: 'Nouveau diagramme', input: { placeholder: 'Ex. Onboarding client' }, buttons: [{ label: 'Annuler', value: null }, { label: 'Créer', value: '$input', primary: true }] });
    if (!name?.trim()) return;
    try { const d = await api.create(name.trim()); navigate(`/d/${d.id}`); } catch (e) { toast(e.message, 'error'); }
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = (await f.text()).replace(/^﻿/, '');
      const d = await api.create(f.name.replace(/\.(bpmn|xml)$/i, ''), text);
      navigate(`/d/${d.id}`);
    } catch (err) { toast(err.message, 'error'); }
  };

  let items;
  try { items = await api.list(); } catch (e) { $('#list').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const isAdmin = cfg.user.role === 'admin';
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const shown = items.filter(d => !q || d.name.toLowerCase().includes(q));
    const list = $('#list');
    if (!items.length) { list.innerHTML = `<div class="empty-lib"><h2>Aucun diagramme pour l'instant</h2><p class="muted">Créez un diagramme vide ou importez un fichier .bpmn existant.</p></div>`; return; }
    if (!shown.length) { list.innerHTML = '<p class="muted">Aucun diagramme ne correspond.</p>'; return; }
    list.innerHTML = shown.map(d => `<article class="lib-item">
      <a class="lib-link" data-link href="/d/${esc(d.id)}"><b>${esc(d.name)}</b>
        <span class="muted small">${esc(fmtDate(d.updatedAt))}${d.updatedBy ? ' · ' + esc(d.updatedBy) : ''} · <span class="mono">${esc(d.path)}</span></span></a>
      ${d.lock ? `<span class="pill warn">${esc(d.lock.author || 'Quelqu\'un')} modifie</span>` : ''}
      <button class="btn small ghost" data-act="rename" data-id="${esc(d.id)}">Renommer</button>
      <button class="btn small ghost" data-act="dup" data-id="${esc(d.id)}">Dupliquer</button>
      ${isAdmin ? `<button class="btn small ghost danger" data-act="del" data-id="${esc(d.id)}">Supprimer</button>` : ''}
    </article>`).join('');
  };
  $('#q').addEventListener('input', draw);
  draw();
  $('#list').onclick = async e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const d = items.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'rename') {
      const name = await dialog({ title: 'Renommer', input: { value: d.name }, buttons: [{ label: 'Annuler', value: null }, { label: 'Renommer', value: '$input', primary: true }] });
      if (name?.trim() && name.trim() !== d.name) { try { await api.rename(d.id, name.trim()); renderLibrary(); } catch (err) { toast(err.message, 'error'); } }
    } else if (b.dataset.act === 'dup') {
      const name = await dialog({ title: 'Dupliquer', body: 'La copie reprend l\'état actuel du diagramme (brouillon compris). Elle a son propre historique.', input: { value: `${d.name} (copie)` }, buttons: [{ label: 'Annuler', value: null }, { label: 'Dupliquer', value: '$input', primary: true }] });
      if (name?.trim()) { try { const c = await api.duplicate(d.id, name.trim()); toast(`Copie créée : ${c.name}`); navigate(`/d/${c.id}`); } catch (err) { toast(err.message, 'error'); } }
    } else {
      const ok = await dialog({ title: 'Supprimer ce diagramme ?', body: `« ${d.name} » disparaît de la liste. Son historique reste dans le dépôt Git (commit de suppression).`, buttons: [{ label: 'Annuler', value: false }, { label: 'Supprimer', value: true, danger: true, primary: true }] });
      if (ok) { try { await api.remove(d.id); toast('Diagramme supprimé.'); renderLibrary(); } catch (err) { toast(err.message, 'error'); } }
    }
  };
}

// ---------- administration ----------
async function renderAdmin() {
  document.title = 'Administration · Éditeur BPMN';
  app.innerHTML = `<div class="lib">
    ${header('Administration')}
    <section class="admin-sec"><h2>Comptes</h2><p class="muted">Les nouveaux comptes attendent votre validation. Un compte actif voit et peut modifier tous les diagrammes.</p><div id="users" class="lib-list"><p class="muted">Chargement…</p></div></section>
    <section class="admin-sec"><h2>Dépôt Git</h2><div id="git"><p class="muted">Chargement…</p></div></section>
  </div>`;
  bindHeader();

  const STATUS = { pending: ['En attente', 'warn'], active: ['Actif', 'ok'], disabled: ['Désactivé', ''] };
  async function loadUsers() {
    const users = await api.users();
    $('#users').innerHTML = users.map(u => `<article class="lib-item">
      <div class="lib-link"><b>${esc(u.name)}${u.role === 'admin' ? ' <span class="tag soft">admin</span>' : ''}</b><span class="muted small">${esc(u.email)} · inscrit le ${esc(fmtDate(u.createdAt))}</span></div>
      <span class="pill ${STATUS[u.status][1]}">${STATUS[u.status][0]}</span>
      ${u.id === cfg.user.id ? '<span class="muted small">vous</span>' : `
        ${u.status !== 'active' ? `<button class="btn small primary" data-a="approve" data-id="${esc(u.id)}">${u.status === 'pending' ? 'Valider' : 'Réactiver'}</button>` : `<button class="btn small ghost" data-a="disable" data-id="${esc(u.id)}">Désactiver</button>`}
        <button class="btn small ghost" data-a="role" data-id="${esc(u.id)}">${u.role === 'admin' ? 'Retirer admin' : 'Rendre admin'}</button>
        <button class="btn small ghost danger" data-a="del" data-id="${esc(u.id)}">Supprimer</button>`}
    </article>`).join('');
    $('#users').onclick = async e => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const u = users.find(x => x.id === b.dataset.id);
      try {
        if (b.dataset.a === 'approve') await api.updateUser(u.id, { status: 'active' });
        if (b.dataset.a === 'disable') await api.updateUser(u.id, { status: 'disabled' });
        if (b.dataset.a === 'role') await api.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
        if (b.dataset.a === 'del') {
          const ok = await dialog({ title: 'Supprimer ce compte ?', body: `${u.name} (${u.email}) ne pourra plus se connecter. Ses contributions restent dans l'historique Git.`, buttons: [{ label: 'Annuler', value: false }, { label: 'Supprimer', value: true, danger: true, primary: true }] });
          if (!ok) return;
          await api.deleteUser(u.id);
        }
        cfg = await api.config();
        loadUsers();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  async function loadGit() {
    const s = await api.gitStatus();
    $('#git').innerHTML = `<div class="git-box">
      <p>Branche <b>${esc(s.branch)}</b> · ${s.remote ? 'dépôt distant configuré' : 'dépôt local uniquement (définissez GIT_REMOTE_URL pour pousser vers GitHub, GitLab…)'}</p>
      ${s.remote ? `<p class="muted small">Dernier push : ${esc(s.lastPushAt ? fmtDate(s.lastPushAt) : 'jamais')}${s.pending ? ' (en attente)' : ''} · dernière récupération : ${esc(s.lastPullAt ? fmtDate(s.lastPullAt) : 'jamais')}</p>` : ''}
      ${s.lastError ? `<p class="error small">${esc(s.lastError)}</p>` : ''}
      ${s.remote ? '<button class="btn" id="sync">Synchroniser maintenant</button>' : ''}
    </div>`;
    $('#sync')?.addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const r = await api.gitSync();
        toast(r.ok ? `Synchronisé${r.added ? ` · ${r.added} diagramme(s) ajouté(s)` : ''}${r.removed ? ` · ${r.removed} retiré(s)` : ''}` : r.error, r.ok ? 'info' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      loadGit();
    });
  }

  loadUsers().catch(e => { $('#users').innerHTML = `<p class="error">${esc(e.message)}</p>`; });
  loadGit().catch(e => { $('#git').innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

window.addEventListener('unhandledrejection', e => {
  if (e.reason instanceof ApiError) { toast(e.reason.message, 'error'); e.preventDefault(); }
});

route();
