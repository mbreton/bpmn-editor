// Simulation pas à pas, construite sur bpmn-js-token-simulation.
// « Étape suivante » fait tout : démarrer le jeton, avancer d'un élément, ou déclencher l'événement
// attendu (timer, message…) en demandant lequel s'il y en a plusieurs.
import { is } from 'bpmn-js/lib/util/ModelUtil';
import { h, dialog } from './dom.js';
import { TYPE_LABELS, DEF_LABELS, explainIso } from './i18n.js';

const TOGGLE = 'tokenSimulation.toggleMode';
const TRACE = 'tokenSimulation.simulator.trace';
const RESET = 'tokenSimulation.resetSimulation';
const PAUSE = 'tokenSimulation.pauseSimulation';
const PLAY = 'tokenSimulation.playSimulation';
const ANIMATION_CREATED = 'tokenSimulation.animationCreated';

export function createSimulation(ctx, { button, bar }) {
  const { modeler } = ctx;
  const eventBus = modeler.get('eventBus');
  const toggleMode = modeler.get('toggleMode');
  const pauseSim = modeler.get('pauseSimulation');
  const simulator = modeler.get('simulator');
  const canvas = modeler.get('canvas');
  const registry = modeler.get('elementRegistry');

  let stepMode = true;
  let paused = false;
  let holding = false; // en pas à pas : la pause est maintenue jusqu'au clic sur « Étape suivante »
  let steps = 0;
  let currentMark = null;

  bar.innerHTML = '';
  const ui = h(`<div class="sim-in">
    <div class="sim-row">
      <b>Simulation</b>
      <label class="sw-lbl"><input type="checkbox" checked> Pas à pas</label>
      <button class="btn small ghost" data-a="close">Quitter</button>
    </div>
    <ul class="sim-log" aria-live="polite"></ul>
    <div class="sim-row sim-actions">
      <button class="btn small" data-a="reset">Recommencer</button>
      <span class="sim-hint muted small"></span>
      <button class="btn primary" data-a="next">Démarrer ▸</button>
    </div>
  </div>`);
  bar.append(ui);
  const next = ui.querySelector('[data-a=next]');
  const hint = ui.querySelector('.sim-hint');
  const logEl = ui.querySelector('.sim-log');
  const stepBox = ui.querySelector('input');

  const label = element => {
    const bo = element.businessObject;
    const type = TYPE_LABELS[element.type] || element.type.replace('bpmn:', '');
    return bo.name ? `« ${bo.name} » (${type.toLowerCase()})` : type;
  };

  function mark(element) {
    if (currentMark) { try { canvas.removeMarker(currentMark, 'sim-current'); } catch { /* supprimé */ } }
    currentMark = element?.id || null;
    if (currentMark && registry.get(currentMark)) canvas.addMarker(currentMark, 'sim-current');
  }

  function log(text, kind = '') {
    if (logEl.firstElementChild?.classList.contains('placeholder')) logEl.replaceChildren();
    const li = document.createElement('li');
    li.textContent = text;
    if (kind) li.className = kind;
    logEl.append(li);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function resetLog() {
    logEl.replaceChildren(Object.assign(document.createElement('li'), { className: 'placeholder muted', textContent: 'Cliquez sur « Démarrer » : le jeton avance d\'un élément à chaque clic. Aux passerelles exclusives, le flux suivi se choisit avant le passage du jeton (bouton sur la passerelle).' }));
  }

  // ---------- état : démarré, en attente, terminé ----------
  const topStarts = () => registry.filter(e => is(e, 'bpmn:StartEvent') && !e.businessObject.$parent?.triggeredByEvent && (is(e.parent, 'bpmn:Process') || is(e.parent, 'bpmn:Participant')));
  const liveScopes = () => simulator.findScopes(s => !s.destroyed && !is(s.element, 'bpmn:Process') && !is(s.element, 'bpmn:Participant'));
  const pending = () => {
    const starts = new Set(topStarts());
    return simulator.findSubscriptions({}).filter(s => s.element && !starts.has(s.element));
  };

  function refresh() {
    const started = steps > 0;
    const finished = started && !liveScopes().length && !pending().length;
    next.disabled = false;
    if (!started) { next.textContent = 'Démarrer ▸'; hint.textContent = ''; }
    else if (finished) { next.textContent = 'Recommencer ↺'; hint.textContent = 'Parcours terminé.'; }
    else if (holding && paused) { next.textContent = 'Étape suivante ▸'; hint.textContent = ''; }
    else if (stepMode && !paused && pending().length && !animating()) { next.textContent = 'Déclencher un événement ▸'; hint.textContent = 'Le jeton attend un événement.'; }
    else { next.textContent = 'Étape suivante ▸'; hint.textContent = stepMode ? '' : 'Lecture continue…'; }
  }

  const animation = modeler.get('animation');
  const animating = () => { let n = 0; animation.each(a => { if (!a._paused) n++; }); return n > 0; };

  function describeSub(s) {
    const el = s.element;
    const def = (el.businessObject.eventDefinitions || [])[0];
    let what = def ? (DEF_LABELS[def.$type] || '') : '';
    if (def && is(def, 'bpmn:TimerEventDefinition')) {
      const v = def.timeDuration?.body || def.timeDate?.body || def.timeCycle?.body;
      if (v) what = `Timer ${explainIso(v) || v}`;
    }
    const where = is(el, 'bpmn:BoundaryEvent') ? ` sur « ${el.businessObject.attachedToRef?.name || el.businessObject.attachedToRef?.id} »` : '';
    return `${el.businessObject.name || TYPE_LABELS[el.type] || el.id}${what ? ` · ${what}` : ''}${where}`;
  }

  async function choose(subs, title, body) {
    if (subs.length === 1) return subs[0];
    const buttons = subs.slice(0, 6).map((s, i) => ({ label: describeSub(s), value: i, primary: i === 0 }));
    const i = await dialog({ title, body, buttons: [{ label: 'Annuler', value: null }, ...buttons] });
    return i === null || i === undefined ? null : subs[i];
  }

  async function onNext() {
    const started = steps > 0;
    if (started && !liveScopes().length && !pending().length) { eventBus.fire(RESET); return; }
    if (holding && paused) { holding = false; pauseSim.unpause(); refresh(); return; }
    if (!started) {
      const subs = simulator.findSubscriptions({ elements: topStarts() });
      if (!subs.length) { hint.textContent = 'Aucun événement de début à lancer.'; return; }
      const s = await choose(subs, 'Par quel début commencer ?', 'Ce processus a plusieurs événements de début.');
      if (s) simulator.trigger({ event: s.event, scope: s.scope });
      return;
    }
    const subs = pending();
    if (subs.length) {
      const s = await choose(subs, 'Quel événement se produit ?', 'Le jeton attend. Choisissez ce qui arrive maintenant : c\'est ainsi qu\'on teste ce qui se passe à l\'échéance d\'un délai ou à la réception d\'un message.');
      if (s) { holding = false; simulator.trigger({ event: s.event, scope: s.scope }); }
      return;
    }
    if (paused) pauseSim.unpause();
  }

  // ---------- branchements ----------
  button.addEventListener('click', () => toggleMode.toggleMode());
  next.addEventListener('click', onNext);
  ui.querySelector('[data-a=reset]').addEventListener('click', () => eventBus.fire(RESET));
  ui.querySelector('[data-a=close]').addEventListener('click', () => toggleMode.toggleMode(false));
  stepBox.addEventListener('change', () => {
    stepMode = stepBox.checked;
    if (!stepMode) { holding = false; if (paused) pauseSim.unpause(); }
    refresh();
  });

  eventBus.on(TOGGLE, ({ active }) => {
    ctx.simulating = active;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
    bar.hidden = !active;
    steps = 0; holding = false; paused = false;
    resetLog();
    mark(null);
    ctx.applyLock();
    ctx.emit('mode', active ? 'simulate' : 'edit');
    refresh();
    if (active) next.focus();
  });

  eventBus.on(RESET, () => { holding = false; paused = false; steps = 0; resetLog(); mark(null); refresh(); });
  eventBus.on(PAUSE, () => { paused = true; refresh(); });
  eventBus.on(PLAY, () => { paused = false; refresh(); });

  // Une nouvelle animation de jeton démarre d'elle-même : en pas à pas, on la retient.
  eventBus.on(ANIMATION_CREATED, ({ animation: a }) => {
    const play = a.play;
    a.play = function (...args) {
      if (holding && stepMode) { this._paused = true; return; }
      return play.apply(this, args);
    };
  });

  // Priorité basse : passe après le module de pause, qui relance la lecture à chaque trace.
  eventBus.on(TRACE, 500, ({ action, element }) => {
    if (holding && stepMode) pauseSim.pause();
    if (!element || is(element, 'bpmn:SequenceFlow') || is(element, 'bpmn:MessageFlow') || is(element, 'bpmn:Process') || is(element, 'bpmn:Participant')) { refresh(); return; }
    if (action === 'signal' && is(element, 'bpmn:StartEvent')) {
      steps++;
      log(`${steps}. Démarrage : ${label(element)}`);
      mark(element);
      if (stepMode) { holding = true; pauseSim.pause(); }
    } else if (action === 'enter') {
      steps++;
      log(`${steps}. ${label(element)}`);
      mark(element);
      if (is(element, 'bpmn:EndEvent')) log('Fin atteinte sur ce chemin.', 'end');
      else if (stepMode) { holding = true; pauseSim.pause(); }
    } else if (action === 'exit' && is(element, 'bpmn:BoundaryEvent')) {
      log(`↳ Déclenché : ${label(element)}${element.businessObject.cancelActivity === false ? ' — l\'activité continue' : ' — l\'activité est interrompue'}`, 'evt');
    }
    setTimeout(refresh, 0);
  });

  ctx.on('editing', () => { if (ctx.simulating) toggleMode.toggleMode(false); });
  resetLog();

  return { destroy() {} };
}
