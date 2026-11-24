// Centre d'aide : recherche d'un composant ou d'un motif BPMN, vignette, explication et insertion.
import Viewer from 'bpmn-js/lib/Viewer';
import { is } from 'bpmn-js/lib/util/ModelUtil';
import { CATALOG, CATS } from './catalog.js';
import { buildSnippet } from './snippet.js';
import { h, esc, toast } from './dom.js';

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function createHelp(ctx, host) {
  const { modeler } = ctx;
  const elementFactory = modeler.get('elementFactory');
  const create = modeler.get('create');
  const eventBus = modeler.get('eventBus');
  const selection = modeler.get('selection');
  const modeling = modeler.get('modeling');

  const el = h(`<div class="help">
    <input class="field" type="search" placeholder="Que voulez-vous faire ? ex. relancer, délai, si/sinon, en parallèle…" aria-label="Rechercher un composant">
    <div class="help-list"></div>
  </div>`);
  host.append(el);
  const search = el.querySelector('input');
  const list = el.querySelector('.help-list');
  const viewers = new Map();

  const index = CATALOG.map(e => ({ e, text: norm(`${e.title} ${e.keys} ${e.what} ${e.when} ${CATS[e.cat]}`) }));

  function render() {
    for (const v of viewers.values()) v.destroy();
    viewers.clear();
    const q = norm(search.value.trim());
    const words = q.split(/\s+/).filter(Boolean);
    const hits = index.filter(({ text }) => words.every(w => text.includes(w))).map(x => x.e);
    list.replaceChildren();
    if (!hits.length) {
      list.append(h('<p class="muted">Aucun composant ne correspond. Essayez un autre mot, ou décrivez le besoin à l\'assistant IA.</p>'));
      return;
    }
    for (const cat of Object.keys(CATS)) {
      const items = hits.filter(e => e.cat === cat);
      if (!items.length) continue;
      list.append(Object.assign(h('<h4></h4>'), { textContent: CATS[cat] }));
      for (const e of items) list.append(card(e, !!q && hits.length <= 3));
    }
  }

  function card(entry, open) {
    const d = h(`<details class="hcard"><summary><span class="ht"></span><span class="hw muted small"></span></summary>
      <div class="hbody">
        <div class="thumb" aria-hidden="true"></div>
        <p><b>À quoi ça sert.</b> <span class="w"></span></p>
        <p><b>Quand l'utiliser.</b> <span class="u"></span></p>
        <p class="how small"></p>
        <div class="row actions"></div>
      </div></details>`);
    d.querySelector('.ht').textContent = entry.title;
    d.querySelector('.hw').textContent = entry.what;
    d.querySelector('.w').textContent = entry.what;
    d.querySelector('.u').textContent = entry.when;
    const how = d.querySelector('.how');
    if (entry.how) how.textContent = entry.how; else how.remove();
    const actions = d.querySelector('.actions');

    if (entry.insert) {
      const b = h('<button class="btn small primary" type="button">Ajouter au diagramme</button>');
      b.addEventListener('click', ev => insert(entry, ev));
      actions.append(b);
    }
    if (entry.ask && ctx.cfg.ai && ctx.canEdit) {
      const b = h('<button class="btn small" type="button">Demander à l\'assistant</button>');
      b.addEventListener('click', () => ctx.ask?.(entry.ask));
      actions.append(b);
    }
    d.addEventListener('toggle', () => {
      if (d.open) renderThumb(entry, d.querySelector('.thumb'));
      else { viewers.get(entry.id)?.destroy(); viewers.delete(entry.id); d.querySelector('.thumb').replaceChildren(); }
      refreshButtons(d);
    });
    if (open) d.open = true;
    return d;
  }

  function refreshButtons(scope = list) {
    const ok = ctx.editing && !ctx.previewing && !ctx.simulating;
    scope.querySelectorAll('.actions .btn').forEach(b => {
      b.disabled = !ok;
      b.title = ok ? '' : 'Passez en mode édition pour modifier le diagramme';
    });
  }

  async function renderThumb(entry, box) {
    if (viewers.has(entry.id)) return;
    const v = new Viewer({ container: box });
    viewers.set(entry.id, v);
    try {
      await v.importXML(buildSnippet(entry.spec));
      v.get('canvas').zoom('fit-viewport', 'auto');
      if (v.get('canvas').zoom() > 1) v.get('canvas').zoom(1, 'auto');
    } catch (e) {
      box.textContent = 'Aperçu indisponible.';
    }
  }

  function insert(entry, event) {
    if (!(ctx.editing && !ctx.previewing && !ctx.simulating)) return;
    const { type, boundary, nonInterrupting, ...attrs } = entry.insert;
    const shape = type === 'bpmn:Participant' ? elementFactory.createParticipantShape() : elementFactory.createShape({ type, ...attrs });
    if (boundary) {
      toast('Déposez l\'événement sur le bord d\'une activité (Échap pour annuler).');
      if (nonInterrupting) {
        eventBus.once('create.end', () => setTimeout(() => {
          const created = selection.get()[0];
          if (created && is(created, 'bpmn:BoundaryEvent')) modeling.updateProperties(created, { cancelActivity: false });
        }, 0));
      }
    } else {
      toast('Cliquez sur le diagramme pour placer l\'élément (Échap pour annuler).');
    }
    if (window.matchMedia('(max-width: 900px)').matches) document.querySelector('.ed')?.classList.remove('side-open');
    create.start(event, shape);
  }

  search.addEventListener('input', render);
  ctx.showHelp = entryId => {
    const entry = CATALOG.find(e => e.id === entryId);
    if (!entry) return;
    ctx.selectTab('help');
    search.value = entry.title;
    render();
    const card = [...list.querySelectorAll('.hcard')].find(d => d.querySelector('.ht').textContent === entry.title);
    if (card) { card.open = true; card.scrollIntoView({ block: 'nearest' }); }
  };
  ctx.on('editing', () => refreshButtons());
  ctx.on('mode', () => refreshButtons());
  render();
  refreshButtons();

  return { destroy() { for (const v of viewers.values()) v.destroy(); } };
}
