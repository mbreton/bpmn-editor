// Assistant IA : demande écrite ou dictée, proposition affichée en surbrillance sur le diagramme,
// puis Accepter / Préciser / Annuler.
import { BpmnModdle } from 'bpmn-moddle';
import { api } from './api.js';
import { h, esc, toast } from './dom.js';
import { TYPE_LABELS } from './i18n.js';

const SUGGESTIONS = [
  'Ajoute une relance non interrompante tous les 3 jours (3 fois) sur la tâche sélectionnée',
  'Ajoute une expiration à 30 jours qui annule le dossier et notifie le client',
  'Après la validation, attends soit la réponse du client soit 15 jours',
  'Vérifie la cohérence du diagramme et corrige les flux manquants'
];

export function createAssistant(ctx, host) {
  const { modeler } = ctx;
  const canvas = modeler.get('canvas');
  const selection = modeler.get('selection');
  const moddle = new BpmnModdle();

  let baseXml = null;      // diagramme avant la proposition
  let turns = [];          // [{ request, proposalXml, explanation }]
  let busy = false;
  let requestSeq = 0;
  let marked = [];
  let lastAccepted = null; // pour « annuler la proposition appliquée »

  if (!ctx.cfg.ai) {
    host.append(h(`<div class="props"><h3 class="props-title">Assistant IA</h3><p class="note">L'assistant n'est pas configuré sur ce serveur. L'administrateur doit définir <code>LLM_API_KEY</code> (et éventuellement <code>LLM_PROVIDER</code>, <code>LLM_MODEL</code>, <code>LLM_BASE_URL</code>).</p></div>`));
    return { destroy() {} };
  }
  if (!ctx.canEdit) {
    host.append(h(`<div class="props"><h3 class="props-title">Assistant IA</h3><p class="note">L'assistant modifie le diagramme : il est réservé aux personnes qui ont un accès en modification.</p></div>`));
    return { destroy() {} };
  }

  const el = h(`<div class="ai">
    <div class="ai-head"><h3 class="props-title">Assistant IA</h3><p class="muted small">Décrivez la modification. La proposition s'affiche sur le diagramme : vous l'acceptez, la précisez ou l'annulez.</p></div>
    <div class="ai-log" aria-live="polite"></div>
    <div class="ai-suggest"></div>
    <form class="ai-compose">
      <p class="note gate">Passez en mode édition pour utiliser l'assistant. <button type="button" class="linklike" data-act="edit">Modifier</button></p>
      <textarea class="field" rows="3" placeholder="Ex. ajoute une relance à J+3 sur la collecte des pièces KYC"></textarea>
      <div class="row">
        <button type="button" class="btn icon mic" title="Dicter la demande" aria-label="Dicter la demande" aria-pressed="false">🎙</button>
        <span class="muted small hint-sel"></span>
        <button type="submit" class="btn primary">Envoyer</button>
      </div>
    </form>
  </div>`);
  host.append(el);

  const log = el.querySelector('.ai-log');
  const form = el.querySelector('form');
  const ta = form.querySelector('textarea');
  const sendBtn = form.querySelector('[type=submit]');
  const micBtn = form.querySelector('.mic');
  const hintSel = form.querySelector('.hint-sel');
  const suggest = el.querySelector('.ai-suggest');

  for (const s of SUGGESTIONS) {
    const c = h('<button type="button" class="chip"></button>');
    c.textContent = s;
    c.addEventListener('click', () => { ta.value = s; ta.focus(); });
    suggest.append(c);
  }
  form.querySelector('[data-act=edit]').addEventListener('click', () => document.getElementById('edit')?.click());

  function refresh() {
    const ok = ctx.editing && !ctx.simulating;
    form.classList.toggle('disabled', !ok);
    ta.disabled = !ok || busy;
    sendBtn.disabled = !ok || busy;
    micBtn.disabled = !ok || busy;
    sendBtn.textContent = ctx.previewing ? 'Préciser' : 'Envoyer';
    ta.placeholder = ctx.previewing ? 'Que faut-il corriger dans la proposition ?' : 'Ex. ajoute une relance à J+3 sur la collecte des pièces KYC';
    suggest.hidden = ctx.previewing || busy || turns.length > 0;
    const sel = selection.get().filter(e => e.type !== 'label');
    hintSel.textContent = sel.length ? `Sélection transmise : ${sel.map(e => e.businessObject.name || e.id).slice(0, 3).join(', ')}` : '';
  }

  function addMsg(kind, text, extra) {
    const m = h(`<div class="msg ${kind}"></div>`);
    if (kind === 'ai') {
      const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
      const ul = h('<ul></ul>');
      for (const l of lines) ul.append(Object.assign(document.createElement('li'), { textContent: l.replace(/^[-•]\s*/, '') }));
      m.append(lines.length ? ul : Object.assign(document.createElement('p'), { textContent: 'Proposition prête.' }));
    } else {
      m.textContent = text;
    }
    if (extra) m.append(extra);
    log.append(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  // ---------- différences entre deux versions ----------
  async function index(xml) {
    const { rootElement } = await moddle.fromXML(xml, 'bpmn:Definitions');
    const map = new Map();
    const sig = e => JSON.stringify([
      e.$type, e.name, e.text, e.attachedToRef?.id, e.cancelActivity, e.isInterrupting, e.triggeredByEvent, e.isForCompensation,
      e.sourceRef?.id, e.targetRef?.id, e.conditionExpression?.body, e.default?.id, e.scriptFormat, e.script,
      (e.documentation || []).map(d => d.text),
      (e.eventDefinitions || []).map(d => [d.$type, d.timeDuration?.body, d.timeDate?.body, d.timeCycle?.body, d.errorRef?.id, d.messageRef?.id, d.signalRef?.id, d.escalationRef?.id])
    ]);
    const visit = c => {
      for (const e of [...(c.flowElements || []), ...(c.artifacts || []), ...(c.participants || []), ...(c.messageFlows || []), ...(c.laneSets || []).flatMap(s => s.lanes || [])]) {
        if (e.$type === 'bpmn:DataObject') continue;
        map.set(e.id, { type: e.$type, name: e.name || e.text || '', sig: sig(e) });
        visit(e);
      }
    };
    for (const r of rootElement.rootElements || []) if (r.$type === 'bpmn:Process' || r.$type === 'bpmn:Collaboration') visit(r);
    return map;
  }

  async function diff(a, b) {
    const [A, B] = await Promise.all([index(a), index(b)]);
    const added = [], changed = [], removed = [];
    for (const [id, v] of B) { if (!A.has(id)) added.push(id); else if (A.get(id).sig !== v.sig) changed.push(id); }
    for (const [id, v] of A) if (!B.has(id)) removed.push(v.name || TYPE_LABELS[v.type] || id);
    return { added, changed, removed };
  }

  function clearMarks() {
    for (const [id, cls] of marked) { try { canvas.removeMarker(id, cls); } catch { /* élément disparu */ } }
    marked = [];
  }

  // ---------- envoi ----------
  async function send(text) {
    if (busy || !ctx.editing) return;
    const request = text.trim();
    if (!request) return;
    const sel = selection.get().filter(e => e.type !== 'label');
    const selNote = sel.length ? `\n(Éléments sélectionnés dans l'éditeur : ${sel.map(e => `${e.businessObject.name || '(sans nom)'} [id=${e.id}]`).join(', ')})` : '';

    if (!ctx.previewing) {
      baseXml = await ctx.getXml();
      turns = [];
    }
    turns.push({ request: request + selNote });
    addMsg('me', request);
    ta.value = '';
    busy = true;
    const seq = ++requestSeq;
    const wait = addMsg('wait', 'L\'IA prépare une proposition… cela peut prendre une à deux minutes.');
    const stop = h('<button type="button" class="linklike">Abandonner</button>');
    stop.addEventListener('click', () => { requestSeq++; wait.remove(); busy = false; turns.pop(); refresh(); });
    wait.append(' ', stop);
    refresh();
    try {
      const res = await api.ai(ctx.id, baseXml, turns.map(t => ({ request: t.request, proposalXml: t.proposalXml, explanation: t.explanation })));
      if (seq !== requestSeq) return; // abandonné
      wait.remove();
      turns.at(-1).proposalXml = res.xml;
      turns.at(-1).explanation = res.explanation;
      await preview(res);
    } catch (e) {
      if (seq !== requestSeq) return;
      wait.remove();
      turns.pop();
      addMsg('err', e.message);
    } finally {
      if (seq === requestSeq) { busy = false; refresh(); }
    }
  }

  async function preview(res) {
    let xml = res.xml;
    const d = await diff(baseXml, xml).catch(() => ({ added: [], changed: [], removed: [] }));
    ctx.previewing = true;
    clearMarks();
    let relaid = false;
    try {
      const r = await ctx.importXml(xml, { fit: false });
      const missingDi = (res.warnings || []).some(w => w.includes('DI')) || r.warnings.length > 0;
      if (missingDi) {
        const { layoutProcess } = await import('bpmn-auto-layout');
        xml = await layoutProcess(xml);
        turns.at(-1).proposalXml = xml;
        await ctx.importXml(xml, { fit: true });
        relaid = true;
      }
    } catch (e) {
      ctx.previewing = false;
      await ctx.importXml(baseXml, { fit: false });
      turns.pop();
      addMsg('err', `La proposition n'a pas pu être affichée (${e.message}). Reformulez ou précisez la demande.`);
      return;
    }
    const registry = modeler.get('elementRegistry');
    for (const id of d.added) if (registry.get(id)) { canvas.addMarker(id, 'ai-added'); marked.push([id, 'ai-added']); }
    for (const id of d.changed) if (registry.get(id)) { canvas.addMarker(id, 'ai-changed'); marked.push([id, 'ai-changed']); }
    const first = registry.get(d.added[0] || d.changed[0]);
    if (first) canvas.scrollToElement(first, { top: 160, bottom: 160, left: 160, right: 160 });

    const note = relaid ? h('<p class="muted small">La mise en page a été recalculée automatiquement car la proposition n\'en contenait pas.</p>') : null;
    addMsg('ai', res.explanation, note);
    ctx.applyLock();
    ctx.emit('mode', 'preview');

    const banner = h(`<div class="banner-in">
      <div><b>Proposition de l'IA</b>
        <span class="legend"><i class="sw add"></i>${d.added.length} ajout(s) <i class="sw chg"></i>${d.changed.length} modification(s) <i class="sw del"></i>${d.removed.length} suppression(s)</span>
        <span class="removed muted small"></span></div>
      <div class="row">
        <button class="btn" data-a="cancel">Annuler</button>
        <button class="btn" data-a="refine">Préciser</button>
        <button class="btn primary" data-a="accept">Accepter</button>
      </div></div>`);
    if (d.removed.length) banner.querySelector('.removed').textContent = 'Supprimé : ' + d.removed.slice(0, 6).join(', ') + (d.removed.length > 6 ? '…' : '');
    banner.querySelector('[data-a=cancel]').addEventListener('click', cancel);
    banner.querySelector('[data-a=accept]').addEventListener('click', accept);
    banner.querySelector('[data-a=refine]').addEventListener('click', () => { ctx.selectTab('ai'); ta.focus(); });
    ctx.showBanner(banner);
    refresh();
  }

  async function accept() {
    clearMarks();
    ctx.hideBanner();
    ctx.previewing = false;
    lastAccepted = baseXml;
    ctx.applyLock();
    ctx.markDirty(`Assistant IA : ${turns[0].request.split('\n')[0].slice(0, 140)}`);
    const undo = h('<button class="linklike">Revenir à l\'état d\'avant</button>');
    undo.addEventListener('click', async () => {
      if (!lastAccepted || !ctx.editing) return;
      await ctx.importXml(lastAccepted, { fit: false });
      ctx.markDirty('Retour avant proposition IA');
      lastAccepted = null;
      undo.remove();
      toast('Diagramme remis dans l\'état d\'avant la proposition.');
    });
    addMsg('sys', 'Proposition appliquée. Pensez à enregistrer. ', undo);
    turns = []; baseXml = null;
    ctx.emit('mode', 'edit');
    refresh();
  }

  async function cancel() {
    requestSeq++;
    busy = false;
    clearMarks();
    ctx.hideBanner();
    ctx.previewing = false;
    if (baseXml) await ctx.importXml(baseXml, { fit: false });
    addMsg('sys', 'Proposition annulée : le diagramme est revenu à son état précédent.');
    turns = []; baseXml = null;
    ctx.emit('mode', 'edit');
    refresh();
  }

  form.addEventListener('submit', e => { e.preventDefault(); send(ta.value); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(ta.value); } });

  // ---------- dictée (Web Speech API : Chrome, Edge, Safari) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  if (!SR || !window.isSecureContext) {
    // Le micro n'est accessible qu'en HTTPS : inutile d'afficher un bouton qui échouerait.
    micBtn.hidden = true;
  } else {
    micBtn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'fr-FR';
      rec.interimResults = true;
      rec.continuous = true;
      const prefix = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      rec.onresult = e => {
        let txt = '';
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        ta.value = prefix + txt;
      };
      rec.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Dictée indisponible (${e.error}).`, 'error'); };
      rec.onend = () => { rec = null; micBtn.setAttribute('aria-pressed', 'false'); micBtn.classList.remove('rec'); };
      rec.start();
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.classList.add('rec');
    });
  }

  ctx.on('editing', async on => {
    if (!on && ctx.previewing) await cancel();
    refresh();
  });
  ctx.on('mode', refresh);
  modeler.on('selection.changed', refresh);
  ctx.ask = text => { ctx.selectTab('ai'); ta.value = text; ta.focus(); refresh(); };
  refresh();

  return { destroy() { rec?.abort(); } };
}
