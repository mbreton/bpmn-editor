import BpmnModeler from 'bpmn-js/lib/Modeler';
import CanvasLockModule from '@bpmn-io/diagram-js-canvas-lock';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
import '@bpmn-io/diagram-js-canvas-lock/assets/canvas-lock.css';
import 'bpmn-js-color-picker/colors/color-picker.css';
import BpmnColorPickerModule from 'bpmn-js-color-picker';
import AnnotationFillModule from './annotationfill.js';
import { COLOR_PRESETS } from './colors.js';

import { api } from './api.js';
import { $, $$, esc, fmtTime, toast, dialog, download, safeFilename } from './dom.js';
import { TranslateModule } from '../../shared/i18n.js';
import { createProperties } from './properties.js';
import { createHelp } from './help.js';
import { createExplorer } from './explorer.js';
import { createHistory } from './history.js';
import { createChecks } from './checks.js';
import { createApplier } from './aiops.js';
import { createFocus } from './focus.js';
import { connectLive } from './live.js';
import { labelOverflow } from '../../shared/labelfit.js';

const RENEW_MS = 30_000;
const POLL_MS = 60_000;
const AUTOSAVE_MS = 700;
const SIDE_MIN = 300, SIDE_MAX = 900;

// crypto.randomUUID n'existe qu'en contexte sécurisé (HTTPS ou localhost) : getRandomValues marche partout.
function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Identifiant de l'onglet : le verrou appartient à un onglet, pas seulement à une personne. */
function holderId() {
  let id = sessionStorage.getItem('bpmn.holder');
  if (!id) { id = randomId(); sessionStorage.setItem('bpmn.holder', id); }
  return id;
}

export async function openEditor(root, { id, user, cfg, onBack }) {
  let diagram;
  try { diagram = await api.get(id); }
  catch (e) {
    root.innerHTML = `<main class="center-page"><div class="card narrow"><h1>Diagramme introuvable</h1><p class="muted">${esc(e.message)}</p><button class="btn" id="back">Retour à la liste</button></div></main>`;
    $('#back', root).addEventListener('click', onBack);
    return () => {};
  }

  const isAdmin = user.role === 'admin';
  const holder = holderId();
  const sideW = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Number(localStorage.getItem('bpmn.sideWidth')) || 380));

  root.innerHTML = `<div class="ed" style="--side-w:${sideW}px">
    <header class="ed-top">
      <button class="btn icon ghost" id="back" title="Retour à la liste" aria-label="Retour à la liste">←</button>
      <div class="ed-titlebox"><h1 class="ed-title" id="title"></h1><span id="status" class="pill"></span><button id="checkBadge" class="check-badge" hidden></button><span id="presence" class="presence"></span></div>
      <div class="ed-actions">
        <span class="grp edit-only">
          <button class="btn icon ghost" id="undo" title="Annuler la dernière modification, y compris celles de Claude" aria-label="Annuler">↶</button>
          <button class="btn icon ghost" id="redo" title="Rétablir" aria-label="Rétablir">↷</button>
          <button class="btn ghost" id="layout" title="Réorganiser : recalculer automatiquement la disposition (annulable avec ↶)" aria-label="Réorganiser"><span class="ic">⊞</span><span class="bl">Réorganiser</span></button>
        </span>
        <button class="btn primary" id="edit">Modifier</button>
        <button class="btn primary" id="save" title="Enregistrer une version : commit Git à partir du brouillon (Ctrl+S)"><span class="bl-long">Enregistrer une version</span><span class="bl-short">Enregistrer</span></button>
        <button class="btn edit-only" id="done">Terminer</button>
        <button class="btn" id="sim" aria-pressed="false" aria-label="Explorer les parcours" title="Explorer les parcours : le processus étape par étape, avec toutes les suites possibles"><span class="ic">▶</span><span class="bl">Explorer les parcours</span></button>
        <div class="menu-wrap"><button class="btn" id="exp" aria-haspopup="true" aria-label="Exporter" title="Exporter ou copier le lien"><span class="ic">⇩</span><span class="bl">Exporter</span></button>
          <div class="menu" id="expMenu" hidden>
            <button data-x="link">Copier le lien de la page</button>
            <button data-x="bpmn">Fichier .bpmn</button><button data-x="svg">Image SVG</button><button data-x="png">Image PNG</button>
          </div></div>
        <button class="btn icon ghost side-toggle" id="sideToggle" title="Panneau latéral" aria-label="Afficher ou masquer le panneau">☰</button>
      </div>
    </header>
    <div class="ed-body">
      <div class="ed-canvas-wrap">
        <div class="ed-canvas" id="canvas"></div>
        <div class="ed-banner" id="banner" hidden></div>
        <div class="ex-bar" id="simBar" hidden></div>
      </div>
      <div class="side-resize" id="resize" role="separator" aria-orientation="vertical" aria-label="Largeur du panneau" tabindex="0"></div>
      <aside class="ed-side" id="side">
        <nav class="tabs" role="tablist">
          <button role="tab" data-tab="props" aria-selected="true">Propriétés</button>
          <button role="tab" data-tab="checks">Contrôles</button>
          <button role="tab" data-tab="help">Aide</button>
          <button role="tab" data-tab="history">Historique</button>
        </nav>
        <section class="tab-body" data-panel="props"></section>
        <section class="tab-body" data-panel="checks" hidden></section>
        <section class="tab-body" data-panel="help" hidden></section>
        <section class="tab-body" data-panel="history" hidden></section>
      </aside>
    </div>
  </div>`;

  const edEl = $('.ed', root);
  const modeler = new BpmnModeler({
    container: $('#canvas', root),
    additionalModules: [TranslateModule, CanvasLockModule, BpmnColorPickerModule, AnnotationFillModule],
    // palette de couleurs du menu contextuel (icône pinceau à côté d'un élément sélectionné)
    colorPicker: { colors: COLOR_PRESETS.map(c => ({ label: c.label, fill: c.fill, stroke: c.stroke })) }
  });
  const canvasLock = modeler.get('canvasLock');
  window.__bpmnModeler = modeler; // utile pour le débogage depuis la console

  // ---------- état partagé avec les panneaux ----------
  const listeners = {};
  const ctx = {
    modeler, id, user, cfg, isAdmin, canEdit: true, holder,
    editing: false,
    previewing: false,
    simulating: false,
    version: diagram.version,
    rev: diagram.rev,
    name: diagram.name,
    pendingMessage: null,
    on(evt, fn) { (listeners[evt] ||= []).push(fn); },
    emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); },
    async getXml() { return (await modeler.saveXML({ format: true })).xml; },
    async importXml(xml, { fit = true } = {}) {
      const viewbox = fit ? null : modeler.get('canvas').viewbox();
      const r = await modeler.importXML(xml);
      if (viewbox) modeler.get('canvas').viewbox(viewbox); else fitView();
      applyLock();
      return r;
    },
    /** Une modification faite hors de la pile de commandes (ex. remise d'une ancienne version) : sauvegarde du brouillon. */
    markDirty(label) { scheduleSave(label); },
    check: diagram.check || null,
    setCheck(c) { if (!c) return; ctx.check = c; refreshCheck(); ctx.emit('check', c); },
    /** Affiche un brouillon venu du serveur (annulation, restauration, autre page, Claude). */
    async loadDraft(xml, info, check) {
      clearTimeout(saveTimer); pendingLabel = null;
      importing = true;
      try { await ctx.importXml(xml, { fit: false }); } finally { importing = false; }
      if (info) draft = info;
      ctx.setCheck(check);
      refreshUi();
    },
    applyLock: () => applyLock(),
    showBanner, hideBanner, selectTab
  };

  let draft = diagram.draft;          // { seq, canUndo, canRedo, dirty, updatedAt, updatedBy, label }
  let importing = false;               // import d'un brouillon distant : pas de sauvegarde en retour
  let saveTimer = null, pendingLabel = null, saving = Promise.resolve();
  let lock = diagram.lock;
  let renewTimer = null, pollTimer = null;

  function fitView() {
    const canvas = modeler.get('canvas');
    canvas.zoom('fit-viewport', 'auto');
    if (canvas.zoom() > 1.2) canvas.zoom(1.2, 'auto');
  }

  function applyLock() {
    const editable = ctx.editing && !ctx.previewing && !ctx.simulating;
    if (editable) canvasLock.unlock(); else canvasLock.lock();
    edEl.classList.toggle('readonly', !editable);
  }

  // ---------- bandeau sur le canevas ----------
  function showBanner(contentEl) { const b = $('#banner', root); b.replaceChildren(contentEl); b.hidden = false; }
  function hideBanner() { const b = $('#banner', root); b.hidden = true; b.replaceChildren(); }

  // ---------- onglets et panneau redimensionnable ----------
  function selectTab(name) {
    $$('.tabs [role=tab]', root).forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.tab-body', root).forEach(p => { p.hidden = p.dataset.panel !== name; });
    edEl.classList.add('side-open');
    ctx.emit('tab', name);
  }
  $('.tabs', root).addEventListener('click', e => { const t = e.target.closest('[role=tab]'); if (t) selectTab(t.dataset.tab); });
  $('#sideToggle', root).addEventListener('click', () => edEl.classList.toggle('side-open'));

  const resizer = $('#resize', root);
  const setSide = w => {
    const v = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w, 0)));
    edEl.style.setProperty('--side-w', `${v}px`);
    localStorage.setItem('bpmn.sideWidth', String(v));
  };
  resizer.addEventListener('pointerdown', e => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    edEl.classList.add('resizing');
    const move = ev => setSide(edEl.getBoundingClientRect().right - ev.clientX);
    const up = () => { resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', up); edEl.classList.remove('resizing'); modeler.get('canvas').resized(); };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
  resizer.addEventListener('keydown', e => {
    const cur = parseInt(getComputedStyle(edEl).getPropertyValue('--side-w'), 10) || sideW;
    if (e.key === 'ArrowLeft') { setSide(cur + 20); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setSide(cur - 20); e.preventDefault(); }
  });
  resizer.addEventListener('dblclick', () => setSide(380));

  // ---------- titre, statut ----------
  function refreshUi() {
    $('#title', root).textContent = ctx.name;
    document.title = `${ctx.name} · Éditeur BPMN`;
    const st = $('#status', root);
    const otherHolder = lock && lock.holder !== holder;
    const setPill = (main, extra) => { st.innerHTML = ''; st.append(main); if (extra) { const x = document.createElement('span'); x.className = 'pill-extra'; x.textContent = `\u00a0· ${extra}`; st.append(x); } st.title = `${main}${extra ? ` · ${extra}` : ''}${st.dataset.note ? `\n${st.dataset.note}` : ''}`; };
    const draftNote = draft?.dirty ? `brouillon · ${draft.updatedBy ? `${draft.updatedBy}, ` : ''}${fmtTime(draft.updatedAt)}` : `v${ctx.version}`;
    st.dataset.note = draft?.dirty ? `Modifié depuis la version ${ctx.version}. Tout est sauvegardé ; « Enregistrer une version » crée un commit Git.` : `Identique à la version ${ctx.version}`;
    if (ctx.editing) {
      st.className = 'pill ok';
      setPill('Vous modifiez', draftNote);
    } else if (otherHolder) {
      st.className = 'pill warn';
      if (lock.userId === user.id) setPill('Autre onglet', 'vous modifiez dans un autre onglet');
      else setPill(`${lock.author || 'Quelqu\'un'} modifie`, `depuis ${fmtTime(lock.since)}`);
    } else {
      st.className = 'pill';
      setPill('Lecture', draftNote);
    }
    edEl.classList.toggle('editing', ctx.editing);
    edEl.classList.toggle('dirty', !!draft?.dirty);
    $('#edit', root).disabled = !!(otherHolder && !isAdmin && lock.userId !== user.id);
    $('#undo', root).disabled = !draft?.canUndo || ctx.previewing;
    $('#redo', root).disabled = !draft?.canRedo || ctx.previewing;
    $('#layout', root).disabled = ctx.previewing;
    $('#save', root).disabled = ctx.previewing || !draft?.dirty || !!(otherHolder && lock.userId !== user.id);
  }

  // ---------- contrôle de cohérence (fait par le serveur à chaque sauvegarde) ----------
  function refreshCheck() {
    const b = $('#checkBadge', root);
    const list = ctx.check?.issues || [];
    const err = list.filter(i => i.level === 'error').length, warn = list.filter(i => i.level === 'warn').length;
    b.hidden = !ctx.check;
    b.className = `check-badge ${err ? 'err' : warn ? 'warn' : 'ok'}`;
    b.innerHTML = '';
    const sym = err ? `✕ ${err}` : warn ? `⚠ ${warn}` : '✓';
    const word = err ? ` bloquant${err > 1 ? 's' : ''}${warn ? ` · ${warn} à vérifier` : ''}` : warn ? ' à vérifier' : ' cohérent';
    const w = document.createElement('span'); w.className = 'pill-extra'; w.textContent = word.replace(/^ /, '\u00a0');
    b.append(sym, w);
    b.title = `Contrôle de cohérence du workflow (${ctx.check?.ms ?? '?'} ms). Cliquez pour le détail.`;
  }
  $('#checkBadge', root).addEventListener('click', () => selectTab('checks'));

  // ---------- texte trop long pour sa boîte (saisie à l'écran) ----------
  modeler.on('commandStack.element.updateLabel.postExecuted', ({ context }) => {
    if (importing || ctx.previewing) return;
    const el = context.element?.labelTarget || context.element;
    if (!el || el.waypoints) return;
    const o = labelOverflow(el.type, context.newLabel, { width: el.width, height: el.height, expanded: el.type.endsWith('SubProcess') && el.collapsed === false, boundary: !!el.attachers?.length });
    if (o) toast(`Texte trop long pour la boîte (${o.lines} lignes pour ${o.maxLines}) : visez ${o.suggest} caractères environ et mettez le détail dans la documentation (panneau Propriétés).`, 'error');
  });

  // ---------- brouillon : sauvegarde continue ----------
  modeler.on('commandStack.changed', e => {
    if (importing || e?.trigger === 'clear') return;
    if (ctx.editing && !ctx.previewing && !ctx.simulating) scheduleSave();
  });
  function scheduleSave(label) {
    if (label) pendingLabel = label;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(), AUTOSAVE_MS);
  }
  /** Envoie le brouillon tout de suite (les envois sont mis en file). */
  function flushSave({ label, via } = {}) {
    clearTimeout(saveTimer); saveTimer = null;
    const l = label || pendingLabel || 'Modification à l\'écran';
    pendingLabel = null;
    saving = saving.then(async () => {
      if (!ctx.editing) return { ok: false };
      try {
        const res = await api.draft(id, { xml: await ctx.getXml(), holder, label: l, via });
        const { check, ...info } = res;
        draft = info;
        ctx.setCheck(check);
        refreshUi();
        return { ok: true, check };
      } catch (e) {
        if (e.status === 422 && via === 'claude') return { ok: false, rejected: true, issues: e.body.issues || [], error: e.message };
        if (e.status === 422) { toast(e.message, 'error'); return { ok: false }; }
        if (e.status === 423) { lock = e.body.lock; stopEditingLocal(); dialog({ title: 'Verrou perdu', body: `${e.message} Votre dernière modification n'a pas pu être sauvegardée : exportez le diagramme en .bpmn si besoin.`, buttons: [{ label: 'Compris', value: true, primary: true }] }); }
        else toast(`Sauvegarde impossible : ${e.message}`, 'error');
        return { ok: false, error: e.message };
      }
    });
    return saving;
  }
  async function serverStep(delta) {
    if (ctx.previewing) return;
    await flushPending();
    try {
      const r = await (delta < 0 ? api.undo(id, holder) : api.redo(id, holder));
      await ctx.loadDraft(r.xml, r.draft, r.check);
      toast(r.label);
    } catch (e) { toast(e.message, 'error'); }
  }
  const flushPending = () => saveTimer ? flushSave() : saving;
  ctx.on('mode', refreshUi);

  // ---------- édition : verrou ----------
  async function startEditing() {
    let r = await api.lock(id, holder);
    if (!r.acquired && (isAdmin || r.lock.userId === user.id)) {
      const mine = r.lock.userId === user.id;
      const force = await dialog({
        title: mine ? 'Déjà ouvert dans un autre onglet' : 'Diagramme verrouillé',
        body: mine ? 'Vous modifiez déjà ce diagramme dans un autre onglet ou navigateur. Reprendre la main ici fera perdre les modifications non enregistrées de l\'autre onglet.'
          : `${r.lock.author || 'Quelqu\'un'} modifie ce diagramme depuis ${fmtTime(r.lock.since)}. En tant qu'administrateur, vous pouvez reprendre la main : ses modifications non enregistrées seront perdues.`,
        buttons: [{ label: 'Annuler', value: false }, { label: 'Reprendre la main', value: true, danger: true, primary: true }]
      });
      if (!force) return;
      if (mine) await api.unlock(id, r.lock.holder).catch(() => {});
      else await api.forceUnlock(id).catch(() => {});
      r = await api.lock(id, holder);
    }
    if (!r.acquired) { lock = r.lock; refreshUi(); toast(`${r.lock.author || 'Quelqu\'un'} modifie déjà ce diagramme.`, 'error'); return; }
    const fresh = await api.get(id);
    ctx.rev = fresh.rev; ctx.version = fresh.version;
    if (fresh.draft.seq !== draft?.seq) await ctx.loadDraft(fresh.xml, fresh.draft, fresh.check);
    lock = r.lock;
    ctx.editing = true;
    modeler.get('commandStack').clear();
    live.state();
    applyLock();
    refreshUi();
    ctx.emit('editing', true);
    clearInterval(renewTimer);
    renewTimer = setInterval(renewLock, RENEW_MS);
  }

  async function renewLock() {
    try {
      const r = await api.lock(id, holder);
      if (!r.acquired) {
        lock = r.lock;
        stopEditingLocal();
        toast(`${r.lock.author || 'Quelqu\'un'} a repris la main sur ce diagramme.`, 'error');
      }
    } catch { /* réseau : nouvel essai au prochain tour */ }
  }

  function stopEditingLocal() {
    clearInterval(renewTimer);
    ctx.editing = false;
    applyLock();
    refreshUi();
    ctx.emit('editing', false);
    live.state();
  }

  async function stopEditing() {
    if (ctx.previewing) ctx.emit('editing', false); // termine la consultation d'une ancienne version
    await flushPending();
    stopEditingLocal();
    await api.unlock(id, holder).catch(() => {});
    lock = null;
    refreshUi();
    return true;
  }

  /** Version Git à la demande, avec un message. */
  async function saveVersion() {
    if (ctx.previewing) return false;
    await flushPending();
    const message = await dialog({
      title: 'Enregistrer une version',
      body: 'Le brouillon est déjà sauvegardé en continu. Une version crée un commit Git, signé à votre nom, que l\'on retrouve dans l\'historique.',
      input: { placeholder: 'Ce qui a changé (ex. : relance automatique à J+3)', value: draft?.label && draft.label !== 'Modification à l\'écran' ? draft.label.replace(/^Claude : /, '').slice(0, 200) : '' },
      buttons: [{ label: 'Annuler', value: null }, { label: 'Enregistrer', value: '$input', primary: true }]
    });
    if (message === null) return false;
    try {
      const d = await api.commit(id, message.trim() || null);
      const already = ctx.rev === d.rev;
      ctx.rev = d.rev; ctx.version = d.version; draft = d.draft;
      refreshUi();
      if (!already) ctx.emit('saved', d);
      toast(`Version ${d.version} enregistrée.`);
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  // ---------- rafraîchissement en lecture ----------
  async function poll() {
    if (ctx.editing || ctx.previewing || document.hidden) return;
    try {
      const d = await api.get(id);
      lock = d.lock;
      ctx.name = d.name;
      if ((d.rev !== ctx.rev || d.draft.seq !== draft?.seq) && !ctx.simulating) {
        ctx.rev = d.rev; ctx.version = d.version;
        await ctx.loadDraft(d.xml, d.draft, d.check);
        ctx.emit('saved', d);
      }
      refreshUi();
    } catch { /* hors ligne */ }
  }
  pollTimer = setInterval(poll, POLL_MS);

  // ---------- boutons ----------
  $('#back', root).addEventListener('click', async () => { if (await leave()) onBack(); });
  $('#edit', root).addEventListener('click', startEditing);
  $('#done', root).addEventListener('click', stopEditing);
  $('#save', root).addEventListener('click', saveVersion);
  $('#undo', root).addEventListener('click', () => serverStep(-1));
  $('#redo', root).addEventListener('click', () => serverStep(1));
  $('#layout', root).addEventListener('click', async e => {
    if (ctx.previewing) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await flushPending();
      const r = await api.layout(id, holder);
      await ctx.loadDraft(r.xml, r.draft, r.check);
      fitView();
      toast(`Disposition recalculée (${r.ms} ms). ↶ pour revenir à la précédente.`);
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  });

  const expMenu = $('#expMenu', root);
  $('#exp', root).addEventListener('click', () => { expMenu.hidden = !expMenu.hidden; });
  const closeMenu = e => { if (!e.target.closest('.menu-wrap')) expMenu.hidden = true; };
  document.addEventListener('click', closeMenu);
  expMenu.addEventListener('click', async e => {
    const kind = e.target.dataset.x;
    if (!kind) return;
    expMenu.hidden = true;
    const base = safeFilename(ctx.name);
    if (kind === 'link') copyText(location.href);
    if (kind === 'bpmn') download(`${base}.bpmn`, await ctx.getXml(), 'application/xml');
    if (kind === 'svg') download(`${base}.svg`, (await modeler.saveSVG()).svg, 'image/svg+xml');
    if (kind === 'png') download(`${base}.png`, await svgToPng((await modeler.saveSVG()).svg), 'image/png');
  });

  const onKey = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveVersion(); } };
  document.addEventListener('keydown', onKey);
  const onBeforeUnload = e => {
    if (saveTimer) flushSave();
    if (ctx.editing) api.unlockBeacon(id, holder);
    if (saveTimer) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  async function leave() {
    if (ctx.editing && !(await stopEditing())) return false;
    return true;
  }

  // ---------- chargement ----------
  try {
    const { warnings } = await modeler.importXML(diagram.xml);
    fitView();
    if (warnings.length) toast(`${warnings.length} avertissement(s) à l'ouverture : certains éléments peuvent manquer.`, 'error');
  } catch (e) {
    toast(`Impossible d'afficher ce diagramme : ${e.message}`, 'error');
  }
  applyLock();

  const explorer = createExplorer(ctx, { button: $('#sim', root), bar: $('#simBar', root) });
  const panels = [
    createProperties(ctx, $('[data-panel=props]', root)),
    createChecks(ctx, $('[data-panel=checks]', root), { tabButton: $('[data-tab=checks]', root) }),
    createHelp(ctx, $('[data-panel=help]', root)),
    createHistory(ctx, $('[data-panel=history]', root)),
    explorer
  ];
  refreshUi();
  refreshCheck();

  // ---------- temps réel : autres pages et Claude (connecteur MCP) ----------
  const focus = createFocus(modeler);
  async function onLive(m) {
    if (m.type === 'welcome') {
      // l'éditeur a été mis à jour depuis l'ouverture de la page : on recharge (le brouillon est sauvegardé)
      if (m.build && cfg.build && m.build !== cfg.build && cfg.build !== 'dev') {
        toast('Nouvelle version de l\'éditeur : rechargement…');
        await flushPending();
        setTimeout(() => location.reload(), 800);
      }
      return;
    }
    if (m.type === 'presence') {
      const others = m.people.filter(p => p.id !== user.id).map(p => p.name);
      const pr = $('#presence', root);
      pr.textContent = others.length ? `👁 ${others.length > 1 ? others.length : others[0]}` : '';
      pr.title = others.length ? `Ont aussi ouvert ce diagramme : ${others.join(', ')}` : '';
      return;
    }
    if (m.type === 'draft') {
      if (ctx.previewing) return; // consultation d'une version en cours : on recharge à la sortie
      await saving;
      await ctx.loadDraft(m.xml, m.draft, m.check); // le serveur fait foi (annulation, réorganisation, autre page)
      if (m.label) toast(m.source === 'mcp' ? m.label.replace(/^(Annulé|Rétabli)/, 'Claude · $1') : `${m.by} · ${m.label}`);
      return;
    }
    if (m.type === 'commit') {
      if (m.rev === ctx.rev) return; // notre propre enregistrement
      ctx.rev = m.rev; ctx.version = m.version;
      if (draft) draft = { ...draft, dirty: false };
      refreshUi(); ctx.emit('saved', m);
      toast(`Version ${m.version} enregistrée par ${m.by}${m.message ? ` : ${m.message}` : ''}`);
      return;
    }
    if (m.type === 'focus' && m.userId === user.id) { focus.show(m.ids, { highlight: true }); return; }
    if (m.type === 'explore' && m.userId === user.id) { explorer.replay(m.choices); return; }
    if (m.type === 'apply') return live.reply(m, await applyFromClaude(m.changes));
    if (m.type === 'render') return live.reply(m, await renderPng(m.area, m.ids || []));
  }

  /** Modifications demandées par Claude via le connecteur : appliquées, montrées, sauvegardées. */
  async function applyFromClaude(changes) {
    if (ctx.previewing) return { ok: false, error: 'L\'utilisateur consulte une ancienne version : réessayez quand il est revenu au brouillon.' };
    if (ctx.simulating) $('#sim', root).click();
    if (!ctx.editing) {
      const r = await api.lock(id, holder).catch(e => ({ acquired: false, lock: e.body?.lock }));
      if (!r.acquired) return { ok: false, error: `${r.lock?.author || 'Quelqu\'un'} modifie ce diagramme en ce moment.` };
      lock = r.lock; ctx.editing = true; modeler.get('commandStack').clear();
      applyLock(); refreshUi(); ctx.emit('editing', true);
      clearInterval(renewTimer); renewTimer = setInterval(renewLock, RENEW_MS);
      live.state();
    }
    await flushPending();
    const applier = createApplier(modeler);
    const results = [], shown = [];
    const mark0 = modeler.get('commandStack')._stackIdx;
    importing = true; // pas de sauvegarde intermédiaire : une seule étape annulable pour l'ensemble
    try {
      for (const c of changes) {
        const r = applier.apply(c);
        results.push({ title: c.title, ok: r.ok, error: r.error, added: r.addedInfo || r.added || [], overlaps: r.overlaps || [], notes: r.notes || [] });
        if (r.ok) shown.push(...(c.focus || []).map(applier.resolve), ...r.added, ...r.changed);
      }
    } finally { importing = false; }
    const okTitles = results.filter(r => r.ok).map(r => r.title);
    if (!okTitles.length) return { ok: true, results, check: ctx.check };
    const saved = await flushSave({ label: `Claude : ${okTitles.join(' ; ')}`.slice(0, 300), via: 'claude' });
    if (!saved.ok) {
      // refusé par le contrôle de cohérence (ou non sauvegardé) : on revient exactement à l'état précédent
      importing = true;
      try { applier.undoTo(mark0); } finally { importing = false; }
      if (saved.rejected) {
        const ids = saved.issues.map(i => i.id).filter(id => modeler.get('elementRegistry').get(id));
        if (ids.length) focus.show(ids, { highlight: true });
        toast(`Claude : modification refusée (${saved.issues.length} problème${saved.issues.length > 1 ? 's' : ''} de cohérence), il corrige…`, 'error');
        return { ok: false, rejected: true, issues: saved.issues, results };
      }
      return { ok: false, error: saved.error || 'Sauvegarde impossible.', results };
    }
    if (shown.length) focus.show([...new Set(shown)], { highlight: true });
    toast(`Claude : ${okTitles.join(' ; ')}`);
    return { ok: true, results, check: saved.check };
  }

  async function renderPng(area, ids = []) {
    try {
      let { svg } = await modeler.saveSVG();
      let caption = 'Diagramme entier';
      const crop = (x, y, w, h, outW, outH) => svg.replace(/<svg([^>]*)>/, (all, attrs) => `<svg${attrs.replace(/\s(width|height|viewBox)="[^"]*"/g, '')} width="${Math.round(outW)}" height="${Math.round(outH)}" viewBox="${x} ${y} ${w} ${h}">`);
      if (ids.length) {
        // zone autour des éléments demandés (libellés compris), sans toucher à l'écran de l'utilisateur
        const reg = modeler.get('elementRegistry');
        const els = ids.map(i => reg.get(i)).filter(Boolean);
        if (!els.length) return { ok: false, error: `Éléments introuvables : ${ids.join(', ')}` };
        const boxes = els.flatMap(e => [e, ...(e.labels || []).filter(l => l.width)]).flatMap(e => e.waypoints ? e.waypoints.map(p => ({ x: p.x, y: p.y, width: 0, height: 0 })) : [e]);
        const x1 = Math.min(...boxes.map(b => b.x)) - 120, y1 = Math.min(...boxes.map(b => b.y)) - 100;
        const x2 = Math.max(...boxes.map(b => b.x + b.width)) + 120, y2 = Math.max(...boxes.map(b => b.y + b.height)) + 100;
        svg = crop(x1, y1, x2 - x1, y2 - y1, x2 - x1, y2 - y1);
        caption = `Zone autour de ${els.map(e => e.id).join(', ')} (x ${Math.round(x1)}→${Math.round(x2)}, y ${Math.round(y1)}→${Math.round(y2)})`;
      } else if (area === 'screen') {
        const vb = modeler.get('canvas').viewbox();
        svg = crop(vb.x, vb.y, vb.width, vb.height, vb.outer.width, vb.outer.height);
        caption = `Partie visible à l'écran (x ${Math.round(vb.x)}→${Math.round(vb.x + vb.width)}, y ${Math.round(vb.y)}→${Math.round(vb.y + vb.height)})`;
      }
      const blob = await svgToPng(svg, { maxSide: 2000 });
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      const sel = modeler.get('selection').get().map(e => e.id);
      return { ok: true, png: b64, caption: `${caption}${sel.length ? ` · sélection : ${sel.join(', ')}` : ''}` };
    } catch (e) { return { ok: false, error: `Rendu impossible : ${e.message}` }; }
  }

  let liveQueue = Promise.resolve();
  const live = connectLive({ diagramId: id, holder, onMessage: m => { liveQueue = liveQueue.then(() => onLive(m)).catch(e => console.error(e)); }, getState: () => ({ editing: ctx.editing, focused: document.hasFocus() }) });

  return async () => {
    await leave();
    clearInterval(renewTimer); clearInterval(pollTimer);
    live.close();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', closeMenu);
    window.removeEventListener('beforeunload', onBeforeUnload);
    panels.forEach(p => p?.destroy?.());
    modeler.destroy();
    delete window.__bpmnModeler;
  };
}

async function copyText(text) {
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else {
      const t = Object.assign(document.createElement('textarea'), { value: text });
      t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select();
      const ok = document.execCommand('copy');
      t.remove();
      if (!ok) throw new Error('copy');
    }
    toast('Lien copié : toute personne connectée pourra ouvrir ce diagramme.');
  } catch { toast('Copie impossible : copiez l\'adresse depuis la barre du navigateur.', 'error'); }
}

function svgToPng(svg, { maxSide = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const scale = Math.min(2, maxSide / Math.max(img.width, img.height, 1));
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
