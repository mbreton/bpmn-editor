// Explorateur de parcours : à chaque situation, toutes les suites que le diagramme autorise.
// On en choisit une, on peut revenir en arrière pour essayer les autres, et demander à l'IA
// quand le diagramme ne propose pas ce qu'on attendait.
import { h, esc } from './dom.js';
import { createWalker } from '../../shared/pathwalker.js';
import { createFocus } from './focus.js';

export function createExplorer(ctx, { button, bar }) {
  const { modeler } = ctx;
  const canvas = modeler.get('canvas');
  const registry = modeler.get('elementRegistry');
  const focus = createFocus(modeler);

  let walker = null;
  let marked = [];   // [id, classe]
  let hovered = [];

  function mark(id, cls) {
    if (!registry.get(id)) return;
    canvas.addMarker(id, cls);
    marked.push([id, cls]);
  }
  function clearMarks() {
    for (const [id, cls] of marked) { try { canvas.removeMarker(id, cls); } catch { /* supprimé */ } }
    marked = [];
    clearHover();
  }
  function clearHover() {
    for (const id of hovered) { try { canvas.removeMarker(id, 'sim-next'); } catch { /* supprimé */ } }
    hovered = [];
  }
  function hover(ids) {
    clearHover();
    for (const id of new Set(ids || [])) if (registry.get(id)) { canvas.addMarker(id, 'sim-next'); hovered.push(id); }
  }

  function open() {
    walker = createWalker(modeler.getDefinitions());
    ctx.simulating = true;
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    bar.hidden = false;
    ctx.applyLock();
    ctx.emit('mode', 'simulate');
    render(walker.current());
  }

  function close() {
    clearMarks();
    walker = null;
    ctx.simulating = false;
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    bar.hidden = true;
    bar.replaceChildren();
    ctx.applyLock();
    ctx.emit('mode', 'edit');
  }

  function choose(id) {
    const before = new Set(walker.current().tokens.map(t => t.at));
    const state = walker.choose(id);
    render(state);
    const moved = state.tokens.map(t => t.at).filter(a => !before.has(a));
    if (moved.length) keepInView(moved);
  }

  function keepInView(ids) {
    const vb = canvas.viewbox();
    const out = ids.map(id => registry.get(id)).filter(Boolean).some(e => e.x < vb.x || e.y < vb.y || e.x + e.width > vb.x + vb.width || e.y + e.height > vb.y + vb.height);
    if (out) focus.show(ids, { maxZoom: Math.max(vb.scale, 0.6), pad: 220 });
  }

  function render(state) {
    clearMarks();
    const isScope = id => { const e = registry.get(id); return e && (e.businessObject.$type === 'bpmn:SubProcess' || e.businessObject.$type === 'bpmn:Transaction') && !e.collapsed; };
    for (const id of state.visited) mark(id, isScope(id) ? 'sim-scope' : 'sim-visited');
    for (const id of state.flows) mark(id, 'sim-visited');
    for (const t of state.tokens) mark(t.at, t.kind === 'container' ? 'sim-scope-active' : t.kind === 'waiting' ? 'sim-waiting' : 'sim-current');

    const ui = h(`<div class="ex">
      <div class="ex-head">
        <b>Explorer les parcours</b>
        <div class="row">
          <button class="btn small" data-a="undo" title="Revenir à la situation précédente pour essayer une autre suite">← Étape précédente</button>
          <button class="btn small" data-a="reset">Recommencer</button>
          <button class="btn small ghost" data-a="close">Quitter</button>
        </div>
      </div>
      <div class="ex-body">
        <div class="ex-where"></div>
        <div class="ex-warn"></div>
        <div class="ex-opts"></div>
        <details class="ex-log"><summary></summary><ol></ol></details>
      </div>
      <div class="ex-foot"></div>
    </div>`);
    ui.querySelector('[data-a=undo]').disabled = !state.canUndo;
    ui.querySelector('[data-a=undo]').addEventListener('click', () => render(walker.undo()));
    ui.querySelector('[data-a=reset]').addEventListener('click', () => render(walker.reset()));
    ui.querySelector('[data-a=close]').addEventListener('click', close);

    // Où en est-on ?
    const where = ui.querySelector('.ex-where');
    if (!state.started) where.append(h('<p class="muted small">Choisissez par où le processus démarre. À chaque étape, l\'explorateur liste <b>toutes</b> les suites que le diagramme autorise : vérifiez qu\'elles correspondent à ce que vous attendez, et revenez en arrière pour essayer les autres.</p>'));
    else if (state.finished) where.append(h('<p class="ex-done">Parcours terminé. Revenez en arrière pour explorer une autre branche, ou recommencez.</p>'));
    else {
      const p = h('<p class="small"><span class="muted">En cours :</span> </p>');
      state.tokens.filter(t => t.kind !== 'container').forEach((t, i) => {
        const chip = h(`<button class="chip tok ${t.kind}"></button>`);
        chip.textContent = t.kind === 'waiting' ? `${t.label} · attend les autres branches` : t.label;
        chip.addEventListener('click', () => focus.show([t.at], { maxZoom: 1.2 }));
        p.append(i ? ' ' : '', chip);
      });
      const containers = state.tokens.filter(t => t.kind === 'container');
      if (containers.length) p.append(h(`<span class="muted"> dans ${containers.map(c => esc(c.label)).join(', ')}</span>`));
      where.append(p);
    }

    // Alertes de cohérence rencontrées sur ce parcours
    const warnBox = ui.querySelector('.ex-warn');
    for (const w of state.warnings) {
      const p = h('<p class="ex-alert"></p>');
      p.textContent = `⚠ ${w.text}`;
      if (w.ids?.length) p.addEventListener('click', () => focus.show(w.ids, { highlight: true }));
      warnBox.append(p);
    }

    // Suites possibles, regroupées par situation
    const optsBox = ui.querySelector('.ex-opts');
    if (state.options.length) {
      optsBox.append(h(`<p class="ex-title">${state.started ? `Suites possibles (${state.options.length})` : 'Démarrage'}</p>`));
      const groups = new Map();
      for (const o of state.options) groups.set(o.group, [...(groups.get(o.group) || []), o]);
      let n = 0;
      for (const [group, opts] of groups) {
        const g = h('<div class="ex-group"><p class="ex-gname"></p></div>');
        g.firstChild.textContent = group;
        for (const o of opts) {
          n++;
          const b = h(`<button class="ex-opt" type="button"><span class="ex-key">${n <= 9 ? n : ''}</span><span><b></b><small></small></span></button>`);
          b.querySelector('b').textContent = o.label;
          b.querySelector('small').textContent = o.detail || '';
          b.dataset.id = o.id;
          b.addEventListener('mouseenter', () => hover([...(o.targets || []), ...(o.flows || [])]));
          b.addEventListener('focus', () => hover([...(o.targets || []), ...(o.flows || [])]));
          b.addEventListener('mouseleave', clearHover);
          b.addEventListener('click', () => choose(o.id));
          g.append(b);
        }
        optsBox.append(g);
      }
    }

    // Journal
    const logEl = ui.querySelector('.ex-log');
    logEl.querySelector('summary').textContent = `Journal du parcours (${state.log.length})`;
    const ol = logEl.querySelector('ol');
    for (const l of state.log) {
      const li = h(`<li class="${l.kind}"></li>`);
      li.textContent = l.text;
      if (l.ids?.length) li.addEventListener('click', () => focus.show(l.ids, { maxZoom: 1.2 }));
      ol.append(li);
    }
    if (!state.log.length) logEl.hidden = true;

    // Lien avec l'assistant
    const foot = ui.querySelector('.ex-foot');
    if (ctx.cfg.ai && state.started) {
      const b = h('<button class="btn small" type="button">Ce n\'est pas ce que j\'attendais…</button>');
      b.title = 'Ouvre l\'assistant avec ce parcours et les suites possibles, pour discuter de l\'écart et corriger le diagramme';
      b.addEventListener('click', () => ctx.discuss?.({
        prefill: 'À cette étape du parcours, je m\'attendais à ',
        context: walker.describe()
      }));
      foot.append(b);
      const q = h('<button class="btn small ghost" type="button">Expliquer cette situation</button>');
      q.addEventListener('click', () => ctx.discuss?.({ send: 'Explique-moi la situation actuelle de ce parcours et pourquoi le diagramme propose ces suites. Signale ce qui te semble incohérent.', context: walker.describe() }));
      foot.append(q);
    }

    bar.replaceChildren(ui);
  }

  function onKey(e) {
    if (!walker || bar.hidden || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (/^[1-9]$/.test(e.key)) {
      const b = bar.querySelectorAll('.ex-opt')[Number(e.key) - 1];
      if (b) { e.preventDefault(); b.click(); }
    }
    if (e.key === 'Backspace' && walker.current().canUndo) { e.preventDefault(); render(walker.undo()); }
  }
  document.addEventListener('keydown', onKey);

  button.addEventListener('click', () => (walker ? close() : open()));
  ctx.on('editing', () => { if (walker) close(); });
  ctx.on('mode', m => { if (walker && m === 'review') close(); });

  /** Rejoue un parcours (exploration menée par Claude via le connecteur). */
  function replay(choices) {
    if (ctx.previewing) return;
    if (!walker) open();
    let state = walker.reset();
    try { for (const c of choices) state = walker.choose(c); }
    catch { state = walker.current(); }
    render(state);
    const at = state.tokens.map(t => t.at);
    if (at.length) keepInView(at);
  }

  return { replay, destroy() { document.removeEventListener('keydown', onKey); } };
}
