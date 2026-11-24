// Simulation pas à pas, construite sur bpmn-js-token-simulation.
// En mode « pas à pas », la simulation se met en pause à chaque élément atteint ; « Étape suivante » relance.
import { is } from 'bpmn-js/lib/util/ModelUtil';
import { h } from './dom.js';
import { TYPE_LABELS } from './i18n.js';

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
  const canvas = modeler.get('canvas');
  const registry = modeler.get('elementRegistry');

  let stepMode = true;
  let paused = false;
  let holding = false; // en pas à pas : on maintient la pause jusqu'au clic sur « Étape suivante »
  let steps = 0;
  let currentMark = null;

  bar.innerHTML = '';
  const ui = h(`<div class="sim-in">
    <div class="sim-row">
      <b>Simulation</b>
      <label class="sw-lbl"><input type="checkbox" checked> Pas à pas</label>
      <button class="btn small primary" data-a="next" disabled>Étape suivante ▸</button>
      <button class="btn small" data-a="reset">Recommencer</button>
      <button class="btn small ghost" data-a="close">Quitter</button>
    </div>
    <p class="sim-help muted small">Cliquez sur ▶ à côté d'un événement de début pour lancer un jeton. Aux passerelles, cliquez sur le flux à suivre. Les timers et messages en attente se déclenchent en cliquant sur leur bouton.</p>
    <ul class="sim-log"></ul>
  </div>`);
  bar.append(ui);
  const next = ui.querySelector('[data-a=next]');
  const logEl = ui.querySelector('.sim-log');
  const stepBox = ui.querySelector('input');

  function mark(element) {
    if (currentMark) { try { canvas.removeMarker(currentMark, 'sim-current'); } catch { /* supprimé */ } }
    currentMark = element?.id || null;
    if (currentMark && registry.get(currentMark)) canvas.addMarker(currentMark, 'sim-current');
  }

  function log(text, kind = '') {
    const li = document.createElement('li');
    li.textContent = text;
    if (kind) li.className = kind;
    logEl.append(li);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function label(element) {
    const bo = element.businessObject;
    const type = TYPE_LABELS[element.type] || element.type.replace('bpmn:', '');
    return bo.name ? `« ${bo.name} » (${type.toLowerCase()})` : type;
  }

  function setPaused(p) {
    paused = p;
    next.disabled = !(stepMode && paused);
  }

  button.addEventListener('click', () => toggleMode.toggleMode());
  next.addEventListener('click', () => { holding = false; pauseSim.unpause(); });
  ui.querySelector('[data-a=reset]').addEventListener('click', () => eventBus.fire(RESET));
  ui.querySelector('[data-a=close]').addEventListener('click', () => toggleMode.toggleMode(false));
  stepBox.addEventListener('change', () => {
    stepMode = stepBox.checked;
    if (!stepMode) { holding = false; if (paused) pauseSim.unpause(); }
    setPaused(paused);
  });

  eventBus.on(TOGGLE, ({ active }) => {
    ctx.simulating = active;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
    bar.hidden = !active;
    logEl.replaceChildren();
    steps = 0;
    holding = false;
    mark(null);
    setPaused(false);
    ctx.applyLock();
    ctx.emit('mode', active ? 'simulate' : 'edit');
  });

  eventBus.on(RESET, () => { holding = false; logEl.replaceChildren(); steps = 0; mark(null); setPaused(false); });
  // Une nouvelle animation de jeton démarre toujours d'elle-même : en pas à pas, on la retient
  // tant que l'utilisateur n'a pas demandé l'étape suivante.
  eventBus.on(ANIMATION_CREATED, ({ animation }) => {
    const play = animation.play;
    animation.play = function (...args) {
      if (holding && stepMode) { this._paused = true; return; }
      return play.apply(this, args);
    };
  });

  eventBus.on(PAUSE, () => setPaused(true));
  eventBus.on(PLAY, () => setPaused(false));

  // Priorité basse : passe après le module de pause qui relance la lecture à chaque trace.
  eventBus.on(TRACE, 500, ({ action, element }) => {
    // Toute trace relance la lecture (module de pause) : on la remet en pause tant qu'on attend l'utilisateur.
    if (holding && stepMode) pauseSim.pause();
    if (!element || is(element, 'bpmn:SequenceFlow') || is(element, 'bpmn:MessageFlow') || is(element, 'bpmn:Process') || is(element, 'bpmn:Participant')) return;
    if (action === 'signal' && is(element, 'bpmn:StartEvent')) {
      steps++;
      log(`${steps}. Démarrage : ${label(element)}`);
      mark(element);
      if (stepMode) { holding = true; pauseSim.pause(); }
      return;
    }
    if (action === 'enter') {
      steps++;
      log(`${steps}. ${label(element)}`);
      mark(element);
      if (is(element, 'bpmn:EndEvent')) log('Fin atteinte.', 'end');
      if (stepMode && !is(element, 'bpmn:EndEvent')) { holding = true; pauseSim.pause(); }
    }
    if (action === 'exit' && is(element, 'bpmn:BoundaryEvent')) {
      log(`↳ Déclenché : ${label(element)}${element.businessObject.cancelActivity === false ? ' — l\'activité continue' : ' — l\'activité est interrompue'}`, 'evt');
    }
  });

  ctx.on('editing', () => { if (ctx.simulating) toggleMode.toggleMode(false); });

  return { destroy() {} };
}
