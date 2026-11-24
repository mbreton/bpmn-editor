// Assistant IA conversationnel : on discute du diagramme (écrit ou dicté), puis l'IA propose des
// modifications que l'on passe en revue une par une sur le diagramme (zoom, explication, accepter/refuser).
import { h, esc, toast } from './dom.js';
import { createApplier, parseChanges, withoutChanges } from './aiops.js';

const SUGGESTIONS = [
  'Passe en revue tout le diagramme et dis-moi ce qui pourrait poser problème',
  'Explique-moi ce que fait ce processus, étape par étape',
  'Comment gérer un client qui ne répond pas pendant la collecte des pièces ?',
  'Que se passe-t-il si le délai contractuel expire ?'
];

/** Markdown minimal et sûr : paragraphes, listes « - », **gras**, `code`. */
export function renderMd(text) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = []; out.push(list); } list.push(inline(li[1])); continue; }
    list = null;
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.map(x => Array.isArray(x) ? `<ul>${x.map(i => `<li>${i}</li>`).join('')}</ul>` : x).join('');
}

export function createAssistant(ctx, host) {
  const { modeler } = ctx;
  const selection = modeler.get('selection');
  const canvas = modeler.get('canvas');
  const storeKey = `bpmn.chat.${ctx.id}`;

  if (!ctx.cfg.ai) {
    host.append(h(`<div class="props"><h3 class="props-title">Assistant IA</h3><p class="note">L'assistant n'est pas configuré sur ce serveur. L'administrateur doit définir <code>LLM_API_KEY</code> (et éventuellement <code>LLM_PROVIDER</code>, <code>LLM_MODEL</code>, <code>LLM_BASE_URL</code>).</p></div>`));
    return { destroy() {} };
  }

  let history = [];            // [{ role, content, display?, hidden?, reviewed? }]
  try { history = JSON.parse(sessionStorage.getItem(storeKey) || '[]'); } catch { history = []; }
  const persist = () => { try { sessionStorage.setItem(storeKey, JSON.stringify(history.slice(-40))); } catch { /* quota */ } };

  let busy = false;
  let controller = null;
  let review = null;           // revue en cours
  let autoReview = null;       // revue à lancer dès la fin de la réponse

  const el = h(`<div class="ai">
    <div class="ai-head">
      <p class="muted small">Discutez du diagramme comme avec un consultant. Quand vous êtes d'accord, demandez les modifications : vous les examinerez une par une sur le diagramme.</p>
      <button class="btn small ghost" data-a="reset" title="Effacer la conversation">Nouvelle conversation</button>
    </div>
    <div class="ai-log" aria-live="polite"></div>
    <div class="ai-suggest"></div>
    <form class="ai-compose">
      <textarea class="field" rows="3" placeholder="Posez une question ou décrivez ce que vous voulez changer… (Entrée pour envoyer)"></textarea>
      <div class="row">
        <button type="button" class="btn icon mic" title="Dicter" aria-label="Dicter" aria-pressed="false">🎙</button>
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
  const hintSel = form.querySelector('.hint-sel');
  const suggest = el.querySelector('.ai-suggest');

  for (const s of SUGGESTIONS) {
    const c = h('<button type="button" class="chip"></button>');
    c.textContent = s;
    c.addEventListener('click', () => send(s));
    suggest.append(c);
  }

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
  }

  // ---------- échange avec le serveur (flux SSE) ----------
  async function send(text, mode = 'chat') {
    if (busy || review) return;
    const typed = (text || '').trim();
    const content = typed || (mode === 'propose' ? 'Propose les modifications dont nous avons parlé.' : '');
    if (!content) return;
    const sel = selection.get().filter(e => e.type !== 'label').map(e => ({ id: e.id, name: e.businessObject.name || '' }));
    history.push({ role: 'user', content, display: mode === 'propose' && !typed ? 'Propose les modifications.' : content });
    persist();
    bubble('user', history.at(-1).display);
    ta.value = '';
    busy = true;
    refresh();

    const out = h('<div class="msg ai streaming"><div class="md"></div><div class="progress"><span class="spin"></span><span class="st">Préparation…</span><span class="el"></span></div></div>');
    log.append(out);
    log.scrollTop = log.scrollHeight;
    const md = out.querySelector('.md'), st = out.querySelector('.st'), elapsed = out.querySelector('.el');
    const t0 = Date.now();
    const tick = setInterval(() => { elapsed.textContent = ` · ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    let full = '';
    controller = new AbortController();

    try {
      const xml = await ctx.getXml();
      const res = await fetch(`/api/diagrams/${ctx.id}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal, credentials: 'same-origin',
        body: JSON.stringify({ xml, mode, selection: sel, history: history.map(({ role, content }) => ({ role, content })) })
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
            } else st.textContent = 'Le modèle rédige sa réponse…';
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
    } catch (e) {
      out.remove();
      history.pop(); persist();
      if (e.name === 'AbortError') bubble('sys', 'Demande interrompue.');
      else { bubble('err', e.message); ta.value = typed; }
    } finally {
      clearInterval(tick);
      busy = false; controller = null;
      refresh();
    }
    if (autoReview) { const a = autoReview; autoReview = null; startReview(a.changes, a.idx); }
  }

  // ---------- revue des modifications, une par une ----------
  function startReview(changes, historyIdx) {
    if (review || busy) return;
    if (!ctx.editing) { toast('Passez en mode édition (bouton « Modifier ») pour examiner les modifications.', 'error'); return; }
    if (ctx.simulating) { toast('Quittez la simulation pour examiner les modifications.', 'error'); return; }
    ctx.selectTab('ai');
    review = { changes, historyIdx, i: -1, results: [], applier: createApplier(modeler), current: null };
    ctx.previewing = true; // verrouille l'édition manuelle pendant la revue
    ctx.applyLock();
    ctx.emit('mode', 'review');
    refresh();
    next();
  }

  function clearMarks() {
    const res = review?.current?.res;
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
        <span class="legend"><i class="sw add"></i>ajouté <i class="sw chg"></i>modifié</span>
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
    if (res.ok) {
      err.remove();
      btn('Arrêter la revue', 'ghost', () => { refuse(); endReview(true); });
      btn('Refuser', '', () => { refuse(); next(); });
      btn('Accepter', 'primary', () => { review.results.push('accepted'); next(); }).focus();
    } else {
      card.querySelector('.legend').remove();
      err.textContent = `Impossible d'appliquer cette modification : ${res.error}.`;
      btn('Arrêter la revue', 'ghost', () => endReview(true));
      btn(i < n ? 'Passer à la suivante' : 'Terminer', 'primary', () => next()).focus();
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
    // Le résultat de la revue est transmis au modèle avec le prochain message.
    history.push({ role: 'user', hidden: true, content: `[Résultat de la revue] Acceptées : ${acc.map(c => c.title).join(' ; ') || 'aucune'}. Refusées : ${ref.map(c => c.title).join(' ; ') || 'aucune'}.${fail.length ? ` Non applicables : ${fail.map(c => c.title).join(' ; ')}.` : ''}` });
    persist();
    review = null;
    ctx.previewing = false;
    ctx.applyLock();
    if (acc.length) ctx.markDirty(`Assistant IA : ${acc.map(c => c.title).join(' ; ').slice(0, 250)}`);
    ctx.emit('mode', 'edit');
    renderHistory();
    const plural = (k, w) => `${k} ${w}${k > 1 ? 's' : ''}`;
    bubble('sys', acc.length
      ? `${plural(acc.length, 'modification')} appliquée${acc.length > 1 ? 's' : ''}${ref.length ? `, ${plural(ref.length, 'refusée')}` : ''}${fail.length ? `, ${fail.length} non applicable${fail.length > 1 ? 's' : ''}` : ''}. Pensez à enregistrer ; Ctrl+Z annule si besoin.`
      : stopped ? 'Revue arrêtée : aucune modification appliquée.' : 'Aucune modification appliquée.');
    refresh();
  }

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
    history = []; persist(); renderHistory(); refresh();
  });

  // ---------- dictée (navigateur, HTTPS requis) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  if (!SR || !window.isSecureContext) micBtn.hidden = true;
  else {
    micBtn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
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
  return { destroy() { rec?.abort(); controller?.abort(); } };
}
