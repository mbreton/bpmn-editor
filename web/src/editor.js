import BpmnModeler from 'bpmn-js/lib/Modeler';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import CanvasLockModule from '@bpmn-io/diagram-js-canvas-lock';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import '@bpmn-io/diagram-js-canvas-lock/assets/canvas-lock.css';

import { api } from './api.js';
import { $, $$, h, esc, fmtTime, fmtDate, toast, dialog, download, safeFilename } from './dom.js';
import { TranslateModule } from './i18n.js';
import { createProperties } from './properties.js';
import { createAssistant } from './assistant.js';
import { createHelp } from './help.js';
import { createSimulation } from './simulation.js';
import { createHistory } from './history.js';
import { createSharing } from './sharing.js';

const RENEW_MS = 30_000;
const POLL_MS = 20_000;

function holderId() {
  let id = sessionStorage.getItem('bpmn.holder');
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('bpmn.holder', id); }
  return id;
}

export async function openEditor(root, { id, isAdmin, cfg, shared = false, onBack }) {
  let diagram;
  try { diagram = await api.get(id); }
  catch (e) {
    root.innerHTML = `<main class="center-page"><div class="card narrow"><h1>Diagramme introuvable</h1><p class="muted">${esc(e.message)}</p>${onBack ? '<button class="btn" id="back">Retour</button>' : ''}</div></main>`;
    $('#back', root)?.addEventListener('click', onBack);
    return () => {};
  }

  const role = diagram.role; // admin | edit | view
  const canEdit = role === 'admin' || role === 'edit';
  const holder = holderId();

  root.innerHTML = `<div class="ed">
    <header class="ed-top">
      ${onBack ? '<button class="btn icon ghost" id="back" title="Retour à la liste" aria-label="Retour à la liste">←</button>' : '<span class="brand-mark sm" aria-hidden="true"></span>'}
      <div class="ed-titlebox"><h1 class="ed-title" id="title"></h1><span id="status" class="pill"></span></div>
      <div class="ed-actions">
        <span class="grp edit-only">
          <button class="btn icon ghost" id="undo" title="Annuler (Ctrl+Z)" aria-label="Annuler">↶</button>
          <button class="btn icon ghost" id="redo" title="Rétablir (Ctrl+Y)" aria-label="Rétablir">↷</button>
        </span>
        ${canEdit ? '<button class="btn primary" id="edit">Modifier</button><button class="btn primary edit-only" id="save">Enregistrer</button><button class="btn edit-only" id="done">Terminer</button>' : ''}
        <button class="btn" id="sim" aria-pressed="false">Simuler</button>
        <div class="menu-wrap"><button class="btn" id="exp" aria-haspopup="true">Exporter</button>
          <div class="menu" id="expMenu" hidden>
            <button data-x="bpmn">Fichier .bpmn</button><button data-x="svg">Image SVG</button><button data-x="png">Image PNG</button>
          </div></div>
        <button class="btn icon ghost side-toggle" id="sideToggle" title="Panneau latéral" aria-label="Afficher ou masquer le panneau">☰</button>
      </div>
    </header>
    <div class="ed-body">
      <div class="ed-canvas-wrap">
        <div class="ed-canvas" id="canvas"></div>
        <div class="ed-banner" id="banner" hidden></div>
        <div class="sim-bar" id="simBar" hidden></div>
      </div>
      <aside class="ed-side" id="side">
        <nav class="tabs" role="tablist">
          <button role="tab" data-tab="props" aria-selected="true">Propriétés</button>
          <button role="tab" data-tab="ai">Assistant</button>
          <button role="tab" data-tab="help">Aide</button>
          <button role="tab" data-tab="history">Historique</button>
          ${isAdmin ? '<button role="tab" data-tab="share">Partage</button>' : ''}
        </nav>
        <section class="tab-body" data-panel="props"></section>
        <section class="tab-body" data-panel="ai" hidden></section>
        <section class="tab-body" data-panel="help" hidden></section>
        <section class="tab-body" data-panel="history" hidden></section>
        ${isAdmin ? '<section class="tab-body" data-panel="share" hidden></section>' : ''}
      </aside>
    </div>
  </div>`;

  const edEl = $('.ed', root);
  const modeler = new BpmnModeler({
    container: $('#canvas', root),
    additionalModules: [TranslateModule, CanvasLockModule, TokenSimulationModule]
  });
  const canvasLock = modeler.get('canvasLock');
  window.__bpmnModeler = modeler; // utile pour le débogage depuis la console

  // ---------- état partagé avec les panneaux ----------
  const listeners = {};
  const ctx = {
    modeler, id, role, canEdit, isAdmin, cfg, shared,
    editing: false,
    previewing: false,
    simulating: false,
    version: diagram.version,
    name: diagram.name,
    pendingMessage: null,
    on(evt, fn) { (listeners[evt] ||= []).push(fn); },
    emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); },
    author: () => localStorage.getItem('bpmn.author') || '',
    async getXml() { return (await modeler.saveXML({ format: true })).xml; },
    async importXml(xml, { fit = true } = {}) {
      const viewbox = fit ? null : modeler.get('canvas').viewbox();
      const r = await modeler.importXML(xml);
      if (viewbox) modeler.get('canvas').viewbox(viewbox); else modeler.get('canvas').zoom('fit-viewport', 'auto');
      applyLock();
      return r;
    },
    markDirty(message) { dirty = true; if (message) ctx.pendingMessage = message; refreshUi(); },
    applyLock: () => applyLock(),
    showBanner, hideBanner,
    selectTab
  };

  let dirty = false;
  let lock = diagram.lock;
  let renewTimer = null, pollTimer = null;

  function applyLock() {
    const editable = ctx.editing && !ctx.previewing && !ctx.simulating;
    if (editable) canvasLock.unlock(); else canvasLock.lock();
    edEl.classList.toggle('readonly', !editable);
  }

  // ---------- bandeau sur le canevas (aperçu IA, version) ----------
  function showBanner(contentEl) {
    const b = $('#banner', root);
    b.replaceChildren(contentEl);
    b.hidden = false;
  }
  function hideBanner() { const b = $('#banner', root); b.hidden = true; b.replaceChildren(); }

  // ---------- onglets ----------
  function selectTab(name) {
    $$('.tabs [role=tab]', root).forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.tab-body', root).forEach(p => { p.hidden = p.dataset.panel !== name; });
    edEl.classList.add('side-open');
    ctx.emit('tab', name);
  }
  $('.tabs', root).addEventListener('click', e => { const t = e.target.closest('[role=tab]'); if (t) selectTab(t.dataset.tab); });
  $('#sideToggle', root).addEventListener('click', () => edEl.classList.toggle('side-open'));

  // ---------- titre, statut ----------
  function refreshUi() {
    $('#title', root).textContent = ctx.name;
    document.title = `${ctx.name} · Éditeur BPMN`;
    const st = $('#status', root);
    if (ctx.editing) {
      st.className = 'pill ok';
      st.textContent = dirty ? 'Modifications non enregistrées' : `Vous modifiez · v${ctx.version}`;
    } else if (lock && lock.holder !== holder) {
      st.className = 'pill warn';
      st.textContent = `${lock.author || 'Quelqu\'un'} modifie depuis ${fmtTime(lock.since)}`;
    } else {
      st.className = 'pill';
      st.textContent = `${canEdit ? 'Lecture' : 'Lecture seule'} · v${ctx.version}`;
    }
    edEl.classList.toggle('editing', ctx.editing);
    edEl.classList.toggle('dirty', dirty);
    const editBtn = $('#edit', root);
    if (editBtn) editBtn.disabled = !!(lock && lock.holder !== holder && !isAdmin);
    const cs = modeler.get('commandStack');
    $('#undo', root).disabled = !cs.canUndo();
    $('#redo', root).disabled = !cs.canRedo();
  }

  modeler.on('commandStack.changed', () => {
    if (ctx.editing && !ctx.previewing) dirty = true;
    refreshUi();
  });

  // ---------- édition : verrou ----------
  async function ensureAuthor() {
    if (ctx.author()) return true;
    const name = await dialog({
      title: 'Votre nom',
      body: 'Il s\'affiche aux autres personnes pendant que vous modifiez, et dans l\'historique des versions.',
      input: { placeholder: 'Prénom Nom', autocomplete: 'name' },
      buttons: [{ label: 'Annuler', value: null }, { label: 'Continuer', value: '$input', primary: true }]
    });
    if (!name?.trim()) return false;
    localStorage.setItem('bpmn.author', name.trim().slice(0, 80));
    return true;
  }

  async function startEditing() {
    if (!(await ensureAuthor())) return;
    let r = await api.lock(id, holder, ctx.author());
    if (!r.acquired && isAdmin) {
      const force = await dialog({ title: 'Diagramme verrouillé', body: `${r.lock.author || 'Quelqu\'un'} modifie ce diagramme depuis ${fmtTime(r.lock.since)}. En tant qu'administrateur, vous pouvez reprendre la main : ses modifications non enregistrées seront perdues.`, buttons: [{ label: 'Annuler', value: false }, { label: 'Reprendre la main', value: true, danger: true, primary: true }] });
      if (!force) return;
      await api.forceUnlock(id);
      r = await api.lock(id, holder, ctx.author());
    }
    if (!r.acquired) { lock = r.lock; refreshUi(); toast(`${r.lock.author || 'Quelqu\'un'} modifie déjà ce diagramme.`, 'error'); return; }
    // Recharger si une version plus récente existe.
    const fresh = await api.get(id);
    if (fresh.version !== ctx.version) { ctx.version = fresh.version; await ctx.importXml(fresh.xml, { fit: false }); toast(`Version ${fresh.version} chargée.`); }
    lock = r.lock;
    ctx.editing = true;
    modeler.get('commandStack').clear();
    dirty = false;
    applyLock();
    refreshUi();
    ctx.emit('editing', true);
    clearInterval(renewTimer);
    renewTimer = setInterval(renewLock, RENEW_MS);
  }

  async function renewLock() {
    try {
      const r = await api.lock(id, holder, ctx.author());
      if (!r.acquired) {
        lock = r.lock;
        stopEditingLocal();
        dialog({ title: 'Verrou perdu', body: `${r.lock.author || 'Quelqu\'un'} a repris la main sur ce diagramme. Vos modifications non enregistrées sont toujours à l'écran : exportez-les en .bpmn si besoin avant de recharger.`, buttons: [{ label: 'Compris', value: true, primary: true }] });
      }
    } catch { /* réseau : on réessaie au prochain tour */ }
  }

  function stopEditingLocal() {
    clearInterval(renewTimer);
    ctx.editing = false;
    applyLock();
    refreshUi();
    ctx.emit('editing', false);
  }

  async function stopEditing() {
    if (dirty) {
      const choice = await dialog({ title: 'Modifications non enregistrées', body: 'Voulez-vous enregistrer avant de quitter le mode édition ?', buttons: [{ label: 'Continuer à modifier', value: null }, { label: 'Abandonner', value: 'discard', danger: true }, { label: 'Enregistrer', value: 'save', primary: true }] });
      if (!choice) return false;
      if (choice === 'save' && !(await save())) return false;
      if (choice === 'discard') { const d = await api.get(id); ctx.version = d.version; await ctx.importXml(d.xml, { fit: false }); dirty = false; }
    }
    stopEditingLocal();
    await api.unlock(id, holder).catch(() => {});
    lock = null;
    refreshUi();
    return true;
  }

  async function save() {
    if (!ctx.editing || ctx.previewing) return false;
    const xml = await ctx.getXml();
    try {
      const d = await api.save(id, { xml, baseVersion: ctx.version, holder, author: ctx.author(), message: ctx.pendingMessage });
      ctx.version = d.version;
      ctx.pendingMessage = null;
      dirty = false;
      refreshUi();
      ctx.emit('saved', d);
      toast(`Enregistré · version ${d.version}`);
      return true;
    } catch (e) {
      if (e.status === 409) {
        const c = e.body.current || {};
        const choice = await dialog({ title: 'Conflit de version', body: `Une version ${c.version} a été enregistrée par ${c.updatedBy || 'quelqu\'un'} à ${fmtTime(c.updatedAt)}. Téléchargez votre version pour ne rien perdre, puis rechargez la version la plus récente.`, buttons: [{ label: 'Télécharger ma version', value: 'dl' }, { label: 'Recharger la plus récente', value: 'reload', primary: true }] });
        if (choice === 'dl') download(`${safeFilename(ctx.name)}-ma-version.bpmn`, xml, 'application/xml');
        if (choice === 'reload') { const d = await api.get(id); ctx.version = d.version; await ctx.importXml(d.xml, { fit: false }); dirty = false; refreshUi(); }
      } else if (e.status === 423) {
        lock = e.body.lock;
        stopEditingLocal();
        toast(e.message, 'error');
      } else toast(e.message, 'error');
      return false;
    }
  }

  // ---------- rafraîchissement en lecture ----------
  async function poll() {
    if (ctx.editing || ctx.previewing || document.hidden) return;
    try {
      const d = await api.get(id);
      lock = d.lock;
      ctx.name = d.name;
      if (d.version !== ctx.version && !ctx.simulating) {
        ctx.version = d.version;
        await ctx.importXml(d.xml, { fit: false });
        toast(`Mis à jour par ${d.updatedBy || 'quelqu\'un'} · v${d.version}`);
        ctx.emit('saved', d);
      }
      refreshUi();
    } catch { /* hors ligne */ }
  }
  pollTimer = setInterval(poll, POLL_MS);

  // ---------- boutons ----------
  $('#back', root)?.addEventListener('click', async () => { if (await leave()) onBack(); });
  $('#edit', root)?.addEventListener('click', startEditing);
  $('#done', root)?.addEventListener('click', stopEditing);
  $('#save', root)?.addEventListener('click', save);
  $('#undo', root).addEventListener('click', () => modeler.get('commandStack').undo());
  $('#redo', root).addEventListener('click', () => modeler.get('commandStack').redo());

  const expBtn = $('#exp', root), expMenu = $('#expMenu', root);
  expBtn.addEventListener('click', () => { expMenu.hidden = !expMenu.hidden; });
  document.addEventListener('click', closeMenu);
  function closeMenu(e) { if (!e.target.closest('.menu-wrap')) expMenu.hidden = true; }
  expMenu.addEventListener('click', async e => {
    const kind = e.target.dataset.x;
    if (!kind) return;
    expMenu.hidden = true;
    const base = safeFilename(ctx.name);
    if (kind === 'bpmn') download(`${base}.bpmn`, await ctx.getXml(), 'application/xml');
    if (kind === 'svg') download(`${base}.svg`, (await modeler.saveSVG()).svg, 'image/svg+xml');
    if (kind === 'png') download(`${base}.png`, await svgToPng((await modeler.saveSVG()).svg), 'image/png');
  });

  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  }
  document.addEventListener('keydown', onKey);

  function onBeforeUnload(e) {
    if (ctx.editing) api.unlockBeacon(id, holder);
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  }
  window.addEventListener('beforeunload', onBeforeUnload);

  async function leave() {
    if (ctx.editing && !(await stopEditing())) return false;
    return true;
  }

  // ---------- chargement ----------
  try {
    const { warnings } = await modeler.importXML(diagram.xml);
    modeler.get('canvas').zoom('fit-viewport', 'auto');
    if (warnings.length) toast(`${warnings.length} avertissement(s) à l'ouverture : certains éléments peuvent manquer.`, 'error');
  } catch (e) {
    toast(`Impossible d'afficher ce diagramme : ${e.message}`, 'error');
  }
  applyLock();

  const panels = [
    createProperties(ctx, $('[data-panel=props]', root)),
    createAssistant(ctx, $('[data-panel=ai]', root)),
    createHelp(ctx, $('[data-panel=help]', root)),
    createHistory(ctx, $('[data-panel=history]', root)),
    createSimulation(ctx, { button: $('#sim', root), bar: $('#simBar', root) }),
    isAdmin ? createSharing(ctx, $('[data-panel=share]', root)) : null
  ].filter(Boolean);
  refreshUi();

  // Fermeture (changement de page dans l'application)
  return async () => {
    await leave();
    clearInterval(renewTimer); clearInterval(pollTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', closeMenu);
    window.removeEventListener('beforeunload', onBeforeUnload);
    panels.forEach(p => p?.destroy?.());
    modeler.destroy();
  };
}

function svgToPng(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = img.width * scale; c.height = img.height * scale;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error('PNG')), 'image/png');
    };
    img.onerror = reject;
    img.src = url;
  });
}
