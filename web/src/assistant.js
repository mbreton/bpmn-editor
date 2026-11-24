// Assistant IA conversationnel, à l'écrit ou à la voix. L'IA montre sur le diagramme ce dont elle
// parle (balises <focus>), puis propose des modifications que l'on passe en revue une par une.
import { h, esc, toast } from './dom.js';
import { createApplier, parseChanges, withoutChanges } from './aiops.js';
import { createFocus } from './focus.js';
import { createVoice, voiceSupport } from './voice.js';

const SUGGESTIONS = [
  'Fais-moi une visite guidée du diagramme, zone par zone',
  'Passe en revue le diagramme et dis-moi ce qui pourrait poser problème',
  'Comment gérer un client qui ne répond pas pendant la collecte des pièces ?',
  'Que se passe-t-il si le délai contractuel expire ?'
];
const FOCUS_RE = /<focus\s+ids="([^"]*)"\s*\/?>/gi;

/** Markdown minimal et sûr : paragraphes, listes, **gras**, `code`, et pastilles « voir » pour les balises focus. */
export function renderMd(text) {
  const chips = [];
  const src = String(text).replace(FOCUS_RE, (_, ids) => { chips.push(ids); return `\u0000${chips.length - 1}\u0000`; }).replace(/<focus[^>]*$/i, '');
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<button type="button" class="focus-chip" data-ids="${esc(chips[i])}" title="Montrer sur le diagramme">◎</button>`);
  const out = [];
  let list = null;
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = []; out.push(list); } list.push(inline(li[1])); continue; }
    list = null;
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.map(x => Array.isArray(x) ? `<ul>${x.map(i => `<li>${i}</li>`).join('')}</ul>` : x).join('');
}

const focusIdsIn = text => { const all = []; String(text).replace(FOCUS_RE, (_, l) => { all.push(l.split(',').map(s => s.trim()).filter(Boolean)); return ''; }); return all; };

export function createAssistant(ctx, host) {
  const { modeler } = ctx;
  const selection = modeler.get('selection');
  const canvas = modeler.get('canvas');
  const focus = createFocus(modeler);
  const storeKey = `bpmn.chat.${ctx.id}`;

  if (!ctx.cfg.ai) {
    host.append(h(`<div class="props"><p class="note">L'assistant n'est pas configuré sur ce serveur. L'administrateur doit définir <code>LLM_API_KEY</code> (et éventuellement <code>LLM_PROVIDER</code>, <code>LLM_MODEL</code>, <code>LLM_BASE_URL</code>).</p></div>`));
    return { destroy() {} };
  }

  let history = [];            // [{ role, content, display?, hidden?, reviewed? }]
  try { history = JSON.parse(sessionStorage.getItem(storeKey) || '[]'); } catch { history = []; }
  const persist = () => { try { sessionStorage.setItem(storeKey, JSON.stringify(history.slice(-40))); } catch { /* quota */ } };

  let busy = false;
  let controller = null;
  let review = null;
  let autoReview = null;
  let pendingContext = null;   // contexte joint au prochain message (parcours de l'explorateur)

  const support = voiceSupport();
  const el = h(`<div class="ai">
    <div class="ai-head">
      <p class="muted small">Discutez du diagramme comme avec un consultant : il vous montre sur le diagramme ce dont il parle. Quand vous êtes d'accord, il propose des modifications que vous examinez une par une.</p>
      <div class="row">
        <button class="btn small" data-a="voice" aria-pressed="false">🎙 Conversation vocale</button>
        <button class="btn small ghost" data-a="reset" title="Effacer la conversation">Nouvelle conversation</button>
      </div>
    </div>
    <div class="voice-panel" hidden>
      <div class="orb" aria-hidden="true"><span></span></div>
      <div class="vp-text"><b class="vp-state">Je vous écoute…</b><span class="vp-heard muted small"></span></div>
      <div class="row"><button class="btn small" data-a="interrupt">Couper la parole</button><button class="btn small ghost" data-a="voice-off">Terminer</button></div>
    </div>
    <div class="ai-log" aria-live="polite"></div>
    <div class="ai-suggest"></div>
    <form class="ai-compose">
      <div class="ctx-note" hidden><span></span><button type="button" class="linklike small">retirer</button></div>
      <textarea class="field" rows="3" placeholder="Posez une question ou décrivez ce que vous voulez changer… (Entrée pour envoyer)"></textarea>
      <div class="row">
        <button type="button" class="btn icon mic" title="Dicter" aria-label="Dicter" aria-pressed="false">🎙</button>
        <label class="sw-lbl small" title="Zoomer sur les éléments dont parle l'IA"><input type="checkbox" class="follow" checked> Suivre sur le diagramme</label>
        <span class="muted small hint-sel"></span>
        <button type="button" class="btn" data-a="propose">Proposer les modifications</button>
        <button type="submit" class="btn primary">Envoyer</button>
      </div>
    </form>
  </div>`);
  host.append(el);

  const log = el.querySelector('.ai-log');
  const form = el.querySelector('form');
  const ta = form.querySelector('textarea');
  const sendBtn = form.querySelector('[type=submit]');
  const proposeBtn = form.querySelector('[data-a=propose]');
  const micBtn = form.querySelector('.mic');
  const follow = form.querySelector('.follow');
  const hintSel = form.querySelector('.hint-sel');
  const suggest = el.querySelector('.ai-suggest');
  const ctxNote = form.querySelector('.ctx-note');
  const voiceBtn = el.querySelector('[data-a=voice]');
  const vp = el.querySelector('.voice-panel');

  for (const s of SUGGESTIONS) {
    const c = h('<button type="button" class="chip"></button>');
    c.textContent = s;
    c.addEventListener('click', () => send(s));
    suggest.append(c);
  }

  // Pastilles « ◎ » : montrer sur le diagramme.
  log.addEventListener('click', e => {
    const b = e.target.closest('.focus-chip');
    if (b) focus.show(b.dataset.ids.split(',').map(s => s.trim()), { highlight: true });
  });

  // ---------- affichage ----------
  function bubble(role, text) {
    const m = h(`<div class="msg ${role === 'user' ? 'me' : role === 'assistant' ? 'ai' : role}"></div>`);
    if (role === 'assistant') m.innerHTML = renderMd(withoutChanges(text)) || '<p class="muted">Modifications proposées.</p>';
    else m.textContent = text;
    log.append(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  function changesSummary(changes, idx) {
    const reviewed = history[idx]?.reviewed;
    const box = h('<div class="chg-sum"><b></b><ol></ol></div>');
    box.querySelector('b').textContent = `${changes.length} modification${changes.length > 1 ? 's' : ''} proposée${changes.length > 1 ? 's' : ''}`;
    const ol = box.querySelector('ol');
    changes.forEach((c, i) => {
      const li = document.createElement('li');
      li.textContent = c.title || `Modification ${i + 1}`;
      const r = reviewed?.[i];
      if (r) {
        const s = h(`<span class="tag ${r === 'accepted' ? 'ok' : r === 'refused' ? 'soft' : 'warn'}"></span>`);
        s.textContent = r === 'accepted' ? 'acceptée' : r === 'refused' ? 'refusée' : 'non applicable';
        li.append(' ', s);
      }
      ol.append(li);
    });
    if (!reviewed) {
      const b = h('<button class="btn small primary" type="button">Examiner les modifications</button>');
      b.addEventListener('click', () => startReview(changes, idx));
      box.append(b);
      if (!ctx.editing) box.append(h('<p class="muted small">Passez d\'abord en mode édition (bouton « Modifier »).</p>'));
    }
    return box;
  }

  function renderHistory() {
    log.replaceChildren();
    history.forEach((m, idx) => {
      if (m.hidden) return;
      const b = bubble(m.role, m.display || m.content);
      if (m.role === 'assistant') {
        const changes = parseChanges(m.content);
        if (changes?.error) b.append(Object.assign(h('<p class="error small"></p>'), { textContent: changes.error }));
        else if (Array.isArray(changes) && changes.length) b.append(changesSummary(changes, idx));
      }
    });
  }

  function refresh() {
    ta.disabled = busy || !!review;
    sendBtn.textContent = busy ? 'Arrêter' : 'Envoyer';
    sendBtn.disabled = !!review;
    proposeBtn.disabled = busy || !!review || !history.some(m => m.role === 'user' && !m.hidden);
    micBtn.disabled = busy || !!review;
    suggest.hidden = history.length > 0 || busy;
    const sel = selection.get().filter(e => e.type !== 'label');
    hintSel.textContent = sel.length ? `Sélection : ${sel.map(e => e.businessObject.name || e.id).slice(0, 3).join(', ')}` : '';
    ctxNote.hidden = !pendingContext;
  }

  // ---------- échange avec le serveur (flux SSE) ----------
  async function send(text, mode = 'chat', { display } = {}) {
    if (busy || review) return;
    const typed = (text || '').trim();
    let content = typed || (mode === 'propose' ? 'Propose les modifications dont nous avons parlé.' : '');
    if (!content) return;
    const shown = display || (mode === 'propose' && !typed ? 'Propose les modifications.' : content);
    if (pendingContext) { content = `${pendingContext}\n\n${content}`; pendingContext = null; }
    const sel = selection.get().filter(e => e.type !== 'label').map(e => ({ id: e.id, name: e.businessObject.name || '' }));
    const visible = focus.visible();
    history.push({ role: 'user', content, display: shown });
    persist();
    bubble('user', shown);
    ta.value = '';
    busy = true;
    refresh();
    const speaking = voice?.active;
    if (speaking) voice.beginResponse();

    const out = h('<div class="msg ai streaming"><div class="md"></div><div class="progress"><span class="spin"></span><span class="st">Préparation…</span><span class="el"></span></div></div>');
    log.append(out);
    log.scrollTop = log.scrollHeight;
    const md = out.querySelector('.md'), st = out.querySelector('.st'), elapsed = out.querySelector('.el');
    const t0 = Date.now();
    const tick = setInterval(() => { elapsed.textContent = ` · ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    let full = '';
    let focusSeen = 0;
    controller = new AbortController();

    try {
      const xml = await ctx.getXml();
      const res = await fetch(`/api/diagrams/${ctx.id}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal, credentials: 'same-origin',
        body: JSON.stringify({ xml, mode, selection: sel, visible, voice: !!speaking, history: history.map(({ role, content: c }) => ({ role, content: c })) })
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Erreur ${res.status}`); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data:')) continue;
          const ev = JSON.parse(chunk.slice(5));
          if (ev.type === 'status') st.textContent = ev.text;
          if (ev.type === 'error') throw new Error(ev.message);
          if (ev.type === 'delta') {
            full += ev.text;
            md.innerHTML = renderMd(withoutChanges(full));
            const block = /<changes>([\s\S]*)$/i.exec(full);
            if (block) {
              const n = (block[1].match(/"title"\s*:/g) || []).length;
              st.textContent = n ? `Rédaction des modifications : ${n} en cours…` : 'Rédaction des modifications…';
            } else st.textContent = speaking ? 'L\'assistant parle…' : 'Le modèle rédige sa réponse…';
            if (speaking) voice.pushResponse(full);
            else if (follow.checked) {
              const tags = focusIdsIn(withoutChanges(full));
              if (tags.length > focusSeen) { focusSeen = tags.length; focus.show(tags.at(-1), { highlight: true }); }
            }
            log.scrollTop = log.scrollHeight;
          }
        }
      }
      if (!full.trim()) throw new Error('Réponse vide du modèle.');
      history.push({ role: 'assistant', content: full });
      persist();
      out.remove();
      const idx = history.length - 1;
      const b = bubble('assistant', full);
      const changes = parseChanges(full);
      if (changes?.error) b.append(Object.assign(h('<p class="error small"></p>'), { textContent: changes.error }));
      else if (Array.isArray(changes) && changes.length) {
        b.append(changesSummary(changes, idx));
        if (ctx.editing) autoReview = { changes, idx };
      }
      if (speaking) {
        // En vocal, la revue commence une fois la réponse entièrement lue.
        const pendingReview = autoReview;
        autoReview = null;
        voice.endResponse(full, pendingReview ? () => setTimeout(() => startReview(pendingReview.changes, pendingReview.idx), 0) : null);
      }
    } catch (e) {
      out.remove();
      history.pop(); persist();
      if (e.name === 'AbortError') bubble('sys', 'Demande interrompue.');
      else { bubble('err', e.message); ta.value = typed; if (speaking) voice.say(`Désolé, une erreur est survenue : ${e.message}`); }
    } finally {
      clearInterval(tick);
      busy = false; controller = null;
      refresh();
    }
    if (autoReview) { const a = autoReview; autoReview = null; startReview(a.changes, a.idx); }
    else if (speaking && !ctx.editing && Array.isArray(parseChanges(full))) voice.say('Pour appliquer ces modifications, passez d\'abord en mode édition avec le bouton Modifier.');
  }

  /** Ouvre la conversation avec un contexte (ex. le parcours de l'explorateur). */
  ctx.discuss = ({ prefill = '', context = '', send: now } = {}) => {
    ctx.selectTab('ai');
    if (context) { pendingContext = context; ctxNote.querySelector('span').textContent = '📎 Parcours de l\'explorateur joint au prochain message'; }
    refresh();
    if (now) { send(now); return; }
    ta.value = prefill;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  ctxNote.querySelector('button').addEventListener('click', () => { pendingContext = null; refresh(); });

  // ---------- revue des modifications, une par une ----------
  function startReview(changes, historyIdx) {
    if (review || busy) return;
    if (!ctx.editing) { toast('Passez en mode édition (bouton « Modifier ») pour examiner les modifications.', 'error'); return; }
    ctx.selectTab('ai');
    review = { changes, historyIdx, i: -1, results: [], applier: createApplier(modeler), current: null, actions: {} };
    ctx.previewing = true; // verrouille l'édition manuelle pendant la revue
    ctx.emit('mode', 'review');
    ctx.applyLock();
    refresh();
    next();
  }

  function clearMarks() {
    const res = review?.current?.res;
    focus.clear();
    if (!res?.ok) return;
    for (const id of res.added) try { canvas.removeMarker(id, 'ai-added'); } catch { /* supprimé */ }
    for (const id of res.changed) try { canvas.removeMarker(id, 'ai-changed'); } catch { /* supprimé */ }
  }

  function next() {
    clearMarks();
    review.current = null;
    review.i++;
    if (review.i >= review.changes.length) return endReview();
    const change = review.changes[review.i];
    const res = review.applier.apply(change);
    review.current = { change, res };
    if (res.ok) {
      for (const id of res.added) canvas.addMarker(id, 'ai-added');
      for (const id of res.changed) canvas.addMarker(id, 'ai-changed');
      review.applier.focus([...(change.focus || []), ...res.added, ...res.changed]);
    } else review.results.push('failed');
    showCard(change, res);
  }

  function showCard(change, res) {
    const n = review.changes.length, i = review.i + 1;
    const card = h(`<div class="banner-in review">
      <div class="rv-text">
        <div class="rv-head"><span class="rv-count"></span><b class="rv-title"></b></div>
        <p class="rv-why"></p><p class="rv-benefit"></p><p class="rv-err"></p>
        <span class="legend"><i class="sw add"></i>ajouté <i class="sw chg"></i>modifié${voice?.active ? ' · dites « accepter », « refuser » ou « arrêter »' : ''}</span>
      </div>
      <div class="row rv-actions"></div></div>`);
    card.querySelector('.rv-count').textContent = `${i}/${n}`;
    card.querySelector('.rv-title').textContent = change.title || `Modification ${i}`;
    card.querySelector('.rv-why').textContent = change.why || '';
    const ben = card.querySelector('.rv-benefit');
    if (change.benefit) ben.textContent = `Apport : ${change.benefit}`; else ben.remove();
    const err = card.querySelector('.rv-err');
    const actions = card.querySelector('.rv-actions');
    const btn = (label, cls, fn) => { const b = h(`<button class="btn ${cls}"></button>`); b.textContent = label; b.addEventListener('click', fn); actions.append(b); return b; };
    const accept = () => { review.results.push('accepted'); next(); };
    const refuseNext = () => { refuse(); next(); };
    const stop = () => { refuse(); endReview(true); };
    if (res.ok) {
      err.remove();
      btn('Arrêter la revue', 'ghost', stop);
      btn('Refuser', '', refuseNext);
      btn('Accepter', 'primary', accept).focus();
      review.actions = { accept, refuse: refuseNext, stop };
      if (voice?.active) voice.say(`Modification ${i} sur ${n} : ${change.title}. ${change.why || ''} ${change.benefit ? `Apport : ${change.benefit}` : ''} Vous l'acceptez ?`);
    } else {
      card.querySelector('.legend').remove();
      err.textContent = `Impossible d'appliquer cette modification : ${res.error}.`;
      btn('Arrêter la revue', 'ghost', () => endReview(true));
      btn(i < n ? 'Passer à la suivante' : 'Terminer', 'primary', () => next()).focus();
      review.actions = { accept: () => next(), refuse: () => next(), stop: () => endReview(true) };
      if (voice?.active) voice.say(`La modification ${i}, ${change.title}, ne peut pas être appliquée. Je passe à la suite ?`);
    }
    ctx.showBanner(card);
  }

  function refuse() {
    const res = review.current?.res;
    clearMarks();
    if (res?.ok) review.applier.undoTo(res.mark);
    review.results.push('refused');
    review.current = null;
  }

  function endReview(stopped = false) {
    clearMarks();
    ctx.hideBanner();
    const { changes, results, historyIdx } = review;
    while (results.length < changes.length) results.push('refused');
    const pick = kind => changes.filter((_, k) => results[k] === kind);
    const acc = pick('accepted'), ref = pick('refused'), fail = pick('failed');
    if (history[historyIdx]) history[historyIdx].reviewed = results.slice();
    history.push({ role: 'user', hidden: true, content: `[Résultat de la revue] Acceptées : ${acc.map(c => c.title).join(' ; ') || 'aucune'}. Refusées : ${ref.map(c => c.title).join(' ; ') || 'aucune'}.${fail.length ? ` Non applicables : ${fail.map(c => c.title).join(' ; ')}.` : ''}` });
    persist();
    review = null;
    ctx.previewing = false;
    ctx.applyLock();
    if (acc.length) ctx.markDirty(`Assistant IA : ${acc.map(c => c.title).join(' ; ').slice(0, 250)}`);
    ctx.emit('mode', 'edit');
    renderHistory();
    const plural = (k, w) => `${k} ${w}${k > 1 ? 's' : ''}`;
    const summary = acc.length
      ? `${plural(acc.length, 'modification')} appliquée${acc.length > 1 ? 's' : ''}${ref.length ? `, ${plural(ref.length, 'refusée')}` : ''}${fail.length ? `, ${fail.length} non applicable${fail.length > 1 ? 's' : ''}` : ''}. Pensez à enregistrer ; Ctrl+Z annule si besoin.`
      : stopped ? 'Revue arrêtée : aucune modification appliquée.' : 'Aucune modification appliquée.';
    bubble('sys', summary);
    if (voice?.active) voice.say(acc.length ? `C'est fait : ${summary.replace(/ ; Ctrl\+Z annule si besoin\./, '.')} On continue ?` : `${summary} On continue ?`);
    refresh();
  }

  // ---------- conversation vocale ----------
  const STATES = { listening: 'Je vous écoute…', thinking: 'Je réfléchis…', speaking: 'Je parle… (vous pouvez me couper)', denied: 'Micro refusé par le navigateur.', off: '' };
  const voice = support.ok ? createVoice({
    onUtterance(text) {
      if (review) return voiceCommand(text);
      send(text);
    },
    onState(s) { vp.dataset.state = s; vp.querySelector('.vp-state').textContent = STATES[s] || ''; if (s === 'denied') setVoice(false); },
    onFocus(ids) { focus.show(ids, { highlight: true }); },
    onTranscript(t) { vp.querySelector('.vp-heard').textContent = t; }
  }) : null;

  function voiceCommand(text) {
    const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const a = review.actions;
    if (/\b(refus|non|rejet|pas celle|annule)/.test(t)) return a.refuse();
    if (/\b(arrete|stop|termine|fini)/.test(t)) return a.stop();
    if (/\b(accept|oui|ok|d'accord|daccord|valide|vas-y|go|parfait)/.test(t)) return a.accept();
    if (/\b(repete|redis|encore)/.test(t)) { const c = review.current?.change; return voice.say(c ? `${c.title}. ${c.why || ''} ${c.benefit || ''} Vous l'acceptez ?` : 'Je passe à la suite.'); }
    voice.say('Dites accepter, refuser, ou arrêter la revue.');
  }

  function setVoice(on) {
    if (!voice) return;
    voiceBtn.setAttribute('aria-pressed', String(on));
    voiceBtn.classList.toggle('active', on);
    vp.hidden = !on;
    el.classList.toggle('voice-on', on);
    if (on) {
      voice.start();
      if (!history.some(m => !m.hidden)) voice.say('Bonjour. Je regarde votre diagramme avec vous. Voulez-vous une visite guidée, ou avez-vous une question précise ?');
    } else voice.stop();
  }
  if (!voice) { voiceBtn.disabled = true; voiceBtn.title = support.reason; }
  voiceBtn.addEventListener('click', () => setVoice(!voice?.active));
  vp.querySelector('[data-a=voice-off]').addEventListener('click', () => setVoice(false));
  vp.querySelector('[data-a=interrupt]').addEventListener('click', () => { voice?.interrupt(); });

  // ---------- saisie ----------
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (busy) { controller?.abort(); return; }
    send(ta.value);
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); } });
  proposeBtn.addEventListener('click', () => send(ta.value, 'propose'));
  el.querySelector('[data-a=reset]').addEventListener('click', () => {
    if (busy || review) return;
    history = []; persist(); renderHistory(); focus.clear(); refresh();
  });

  // Dictée simple dans la zone de texte (sans lecture des réponses).
  let rec = null;
  if (!support.ok) { micBtn.hidden = true; }
  else {
    micBtn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new support.SR();
      rec.lang = 'fr-FR'; rec.interimResults = true; rec.continuous = true;
      const prefix = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      rec.onresult = e => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; ta.value = prefix + t; };
      rec.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Dictée indisponible (${e.error}).`, 'error'); };
      rec.onend = () => { rec = null; micBtn.setAttribute('aria-pressed', 'false'); micBtn.classList.remove('rec'); };
      rec.start();
      micBtn.setAttribute('aria-pressed', 'true'); micBtn.classList.add('rec');
    });
  }

  ctx.on('editing', on => {
    if (!on && review) { refuse(); endReview(true); }
    renderHistory();
    refresh();
  });
  ctx.on('mode', refresh);
  modeler.on('selection.changed', refresh);
  ctx.ask = text => { ctx.selectTab('ai'); ta.value = text; ta.focus(); refresh(); };

  renderHistory();
  refresh();
  return { destroy() { rec?.abort(); controller?.abort(); voice?.stop(); } };
}
