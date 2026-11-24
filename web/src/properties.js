// Panneau de propriétés en français, centré sur ce qui compte pour la modélisation : noms, délais,
// interruption, erreurs/messages, conditions, documentation. Toutes les modifications passent par
// le service "modeling" : elles sont annulables (Ctrl+Z).
import { is, getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';
import { h, esc, dialog } from './dom.js';
import { TYPE_LABELS, DEF_LABELS, explainIso } from '../../shared/i18n.js';
import { entryFor } from './catalog.js';
import { checkCoherence } from '../../shared/coherence.js';

const TIMER_KINDS = [
  ['timeDuration', 'Durée', 'Délai relatif à l\'arrivée du jeton', ['PT1H', 'PT48H', 'P1D', 'P3D', 'P15D', 'P30D']],
  ['timeDate', 'Date', 'Date absolue ou calculée (ex. ${dueDate})', ['${dueDate}', '2026-12-31T23:59:00+01:00']],
  ['timeCycle', 'Cycle', 'Répétition : R<nombre>/<période>', ['R3/P1D', 'R/PT12H', 'R5/PT1H']]
];
const REF_KINDS = {
  'bpmn:ErrorEventDefinition': { prop: 'errorRef', type: 'bpmn:Error', label: 'Erreur', code: 'errorCode' },
  'bpmn:MessageEventDefinition': { prop: 'messageRef', type: 'bpmn:Message', label: 'Message' },
  'bpmn:SignalEventDefinition': { prop: 'signalRef', type: 'bpmn:Signal', label: 'Signal' },
  'bpmn:EscalationEventDefinition': { prop: 'escalationRef', type: 'bpmn:Escalation', label: 'Escalade', code: 'escalationCode' }
};

const typeLabel = el => TYPE_LABELS[el.type] || el.type.replace('bpmn:', '');
const nameOf = bo => bo?.name || bo?.id || '';
const rid = prefix => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export function createProperties(ctx, host) {
  const { modeler } = ctx;
  const modeling = modeler.get('modeling');
  const bpmnFactory = modeler.get('bpmnFactory');
  const selection = modeler.get('selection');
  const canvas = modeler.get('canvas');
  const registry = modeler.get('elementRegistry');

  let current = null;

  const editable = () => ctx.editing && !ctx.previewing && !ctx.simulating;

  function render() {
    const sel = selection.get();
    current = sel.length === 1 ? sel[0] : null;
    if (sel.length > 1) {
      host.replaceChildren(h(`<div class="props"><p class="muted">${sel.length} éléments sélectionnés.</p></div>`));
      return;
    }
    host.replaceChildren(current && current.type !== 'label' ? elementView(current.type === 'label' ? current.labelTarget : current) : rootView());
  }

  // ---------- vue générale : contrôles de cohérence ----------
  function rootView() {
    const root = canvas.getRootElement();
    const bo = getBusinessObject(root);
    const issues = lint();
    const el = h(`<div class="props">
      <h3 class="props-title">${esc(bo?.name || 'Processus')}</h3>
      <p class="muted small">${esc(typeLabel(root))} · cliquez sur un élément pour voir et modifier ses propriétés.</p>
      ${is(root, 'bpmn:Process') ? '<div class="fld"><label class="lbl" for="pname">Nom du processus</label><input class="field" id="pname"></div>' : ''}
      <div class="check-summary"></div>
      <h4>Raccourcis</h4>
      <ul class="tips">
        <li>Double-clic sur un élément : le renommer.</li>
        <li>Clic sur un élément : sa barre d'outils propose la suite (tâche, passerelle, délai…) et la clé à molette change son type.</li>
        <li>Déposer un événement intermédiaire sur le bord d'une tâche : il devient un événement de bordure.</li>
        <li>↶ / ↷ : annuler / rétablir (y compris les modifications de Claude). Ctrl+S : enregistrer une version.</li>
      </ul>
    </div>`);
    const pname = el.querySelector('#pname');
    if (pname) {
      pname.value = bo.name || '';
      pname.disabled = !editable();
      pname.addEventListener('change', () => modeling.updateProperties(root, { name: pname.value.trim() || undefined }));
    }
    const cs = el.querySelector('.check-summary');
    const err = issues.filter(i => i.level === 'err').length, warn = issues.filter(i => i.level === 'warn').length;
    cs.className = `check-summary ${err ? 'err' : warn ? 'warn' : 'ok'}`;
    cs.append(err || warn ? `Contrôles : ${err ? `${err} bloquant${err > 1 ? 's' : ''}` : ''}${err && warn ? ', ' : ''}${warn ? `${warn} à vérifier` : ''}. ` : '✓ Contrôles : le workflow est cohérent. ');
    if (err || warn) { const b = h('<button class="linklike" type="button">Voir le détail</button>'); b.addEventListener('click', () => ctx.selectTab('checks')); cs.append(b); }
    return el;
  }

  function focusElement(id) {
    const el = registry.get(id);
    if (!el) return;
    selection.select(el);
    canvas.scrollToElement(el, { top: 120, bottom: 120, left: 120, right: 120 });
  }

  /** Contrôle de cohérence : celui du serveur (avec bpmnlint) s'il correspond à l'état affiché, sinon le contrôle local immédiat. */
  function lint() {
    const list = ctx.check?.issues || checkCoherence(modeler.getDefinitions());
    return list.map(i => ({ ...i, level: i.level === 'error' ? 'err' : i.level, name: (i.id && registry.get(i.id) && nameOf(registry.get(i.id).businessObject)) || i.name }));
  }

  // ---------- vue d'un élément ----------
  function elementView(element) {
    const bo = element.businessObject;
    const ro = !editable();
    const el = h(`<div class="props">
      <button class="linklike back" type="button">← Vue d'ensemble du diagramme</button>
      <h3 class="props-title"></h3>
      <p class="muted small type-line"></p>
      <div class="tags"></div>
      <div class="explain"></div>
      <div class="sections"></div>
    </div>`);
    el.querySelector('.back').addEventListener('click', () => selection.select(null));
    el.querySelector('.props-title').textContent = nameOf(bo) || typeLabel(element);
    el.querySelector('.type-line').textContent = `${typeLabel(element)} · ${bo.id}`;
    const entry = entryFor(element);
    if (entry) {
      const ex = el.querySelector('.explain');
      ex.append(h('<p class="small"></p>'));
      ex.firstChild.textContent = `${entry.what} ${entry.when ? 'Quand l\'utiliser : ' + entry.when.charAt(0).toLowerCase() + entry.when.slice(1) : ''}`;
      const more = h('<button class="linklike small" type="button">En savoir plus dans l\'aide</button>');
      more.addEventListener('click', () => ctx.showHelp?.(entry.id));
      ex.append(more);
    }
    const mine = lint().filter(i => i.id === bo.id && i.level !== 'info');
    if (mine.length) {
      const box = h('<div class="el-issues"></div>');
      for (const i of mine) {
        const p = h(`<div class="el-issue ${i.level}"><p class="ck-problem"></p></div>`);
        p.querySelector('.ck-problem').textContent = `${i.level === 'err' ? '✕ Bloquant' : '⚠ À vérifier'} : ${i.text}`;
        if (i.fix) { const f = h('<p class="ck-fix"><b>Comment corriger :</b> <span></span></p>'); f.querySelector('span').textContent = i.fix; p.append(f); }
        box.append(p);
      }
      el.querySelector('.type-line').after(box);
    }
    const tags = el.querySelector('.tags');
    const tag = (text, kind = '') => tags.append(Object.assign(h(`<span class="tag ${kind}"></span>`), { textContent: text }));
    const sec = el.querySelector('.sections');

    if (ro) sec.append(h(`<p class="note">${ctx.canEdit ? 'Passez en mode édition (bouton « Modifier ») pour changer ces propriétés.' : 'Lecture seule.'}</p>`));

    // Nom
    if ('name' in bo.$descriptor.propertiesByName || is(element, 'bpmn:FlowElement') || is(element, 'bpmn:Participant') || is(element, 'bpmn:Lane')) {
      sec.append(textField('Nom', bo.name || '', v => modeling.updateProperties(element, { name: v || undefined }), ro));
    }
    if (is(element, 'bpmn:TextAnnotation')) {
      sec.append(textArea('Texte', bo.text || '', v => modeling.updateProperties(element, { text: v }), ro));
    }

    // Comportement des événements
    if (is(element, 'bpmn:BoundaryEvent')) {
      const host = bo.attachedToRef;
      tag(bo.cancelActivity === false ? 'Non interrompant' : 'Interrompant', bo.cancelActivity === false ? 'soft' : 'accent');
      const isError = bo.eventDefinitions?.some(d => is(d, 'bpmn:ErrorEventDefinition') || is(d, 'bpmn:CompensateEventDefinition'));
      sec.append(info('Attaché à', nameOf(host)));
      sec.append(toggle('Interrompant', 'À l\'échéance, l\'activité est annulée et le jeton part sur ce flux. Décoché : un flux parallèle démarre et l\'activité continue (relance, notification).',
        bo.cancelActivity !== false, v => modeling.updateProperties(element, { cancelActivity: v }), ro || isError));
    }
    if (is(element, 'bpmn:StartEvent') && bo.$parent?.triggeredByEvent) {
      tag(bo.isInterrupting === false ? 'Non interrompant' : 'Interrompant', bo.isInterrupting === false ? 'soft' : 'accent');
      sec.append(toggle('Interrompant', 'Coché : déclencher ce sous-processus événementiel arrête le sous-processus parent. Décoché : il s\'exécute en parallèle.',
        bo.isInterrupting !== false, v => modeling.updateProperties(element, { isInterrupting: v }), ro));
    }
    if (bo.triggeredByEvent) tag('Sous-processus événementiel', 'soft');
    if (bo.isForCompensation) tag('Activité de compensation', 'soft');

    for (const def of bo.eventDefinitions || []) {
      tag(DEF_LABELS[def.$type] || def.$type.replace('bpmn:', ''));
      if (is(def, 'bpmn:TimerEventDefinition')) sec.append(timerSection(element, def, ro));
      if (REF_KINDS[def.$type]) sec.append(refSection(element, def, REF_KINDS[def.$type], ro));
      if (is(def, 'bpmn:ConditionalEventDefinition')) {
        sec.append(textField('Condition', def.condition?.body || '', v => modeling.updateModdleProperties(element, def, { condition: v ? bpmnFactory.create('bpmn:FormalExpression', { body: v }) : undefined }), ro, 'ex. ${montant > 1000}'));
      }
      if (is(def, 'bpmn:CompensateEventDefinition') && !is(element, 'bpmn:BoundaryEvent')) {
        sec.append(info('Compense', def.activityRef ? nameOf(def.activityRef) : 'toutes les activités terminées du périmètre'));
      }
    }

    // Passerelles : ce qui se règle vraiment se trouve sur les flux sortants
    if (is(element, 'bpmn:Gateway')) sec.append(gatewaySection(element, ro));

    // Flux de séquence : condition et flux par défaut
    if (is(element, 'bpmn:SequenceFlow')) {
      const src = bo.sourceRef;
      if (is(src, 'bpmn:ExclusiveGateway') || is(src, 'bpmn:InclusiveGateway') || (is(src, 'bpmn:Activity') && (src.outgoing || []).length > 1)) {
        const isDefault = src.default === bo;
        if (isDefault) tag('Flux par défaut', 'soft');
        sec.append(textField('Condition', bo.conditionExpression?.body || '', v => modeling.updateProperties(element, { conditionExpression: v ? bpmnFactory.create('bpmn:FormalExpression', { body: v }) : undefined }), ro || isDefault, 'ex. ${montant > 1000}'));
        if (is(src, 'bpmn:ExclusiveGateway') || is(src, 'bpmn:InclusiveGateway')) {
          sec.append(toggle('Flux par défaut', 'Pris quand aucune autre condition n\'est vraie.', isDefault, v => {
            const source = registry.get(src.id);
            modeling.updateProperties(source, { default: v ? bo : undefined });
          }, ro));
        }
      }
    }

    // Script
    if (is(element, 'bpmn:ScriptTask')) {
      sec.append(textField('Langage', bo.scriptFormat || '', v => modeling.updateProperties(element, { scriptFormat: v || undefined }), ro, 'javascript, groovy…'));
      sec.append(textArea('Script', bo.script || '', v => modeling.updateProperties(element, { script: v || undefined }), ro, true));
    }

    // Documentation
    if (is(element, 'bpmn:BaseElement') && !is(element, 'bpmn:TextAnnotation')) {
      const doc = (bo.documentation || []).map(d => d.text).join('\n');
      sec.append(textArea('Documentation', doc, v => {
        modeling.updateProperties(element, { documentation: v ? [bpmnFactory.create('bpmn:Documentation', { text: v })] : [] });
      }, ro));
    }
    return el;
  }

  // ---------- passerelles ----------
  function gatewaySection(element, ro) {
    const bo = element.businessObject;
    const outs = (bo.outgoing || []);
    const box = h('<div class="fld gw"><span class="lbl">Flux sortants</span><div class="gw-flows"></div><p class="hint"></p></div>');
    const list = box.querySelector('.gw-flows');
    const hint = box.querySelector('.hint');
    const targetName = f => f.targetRef?.name || TYPE_LABELS[f.targetRef?.$type] || f.targetRef?.id || '?';
    const isChoice = is(element, 'bpmn:ExclusiveGateway') || is(element, 'bpmn:InclusiveGateway');
    if (!outs.length) {
      hint.textContent = 'Aucun flux sortant : reliez la passerelle aux étapes suivantes (outil flèche de sa barre d\'outils).';
      return box;
    }
    if (is(element, 'bpmn:ParallelGateway')) hint.textContent = 'Toutes les branches démarrent en même temps. Pour les attendre toutes, réunissez-les sur une seconde passerelle parallèle.';
    else if (is(element, 'bpmn:EventBasedGateway')) hint.textContent = 'Le premier événement qui survient décide du chemin ; les autres attentes sont abandonnées. Chaque sortie doit mener à une attente (timer, message…) ou une tâche de réception.';
    else if (outs.length > 1 && isChoice) hint.textContent = is(element, 'bpmn:ExclusiveGateway')
      ? 'Un seul chemin est suivi : le premier flux dont la condition est vraie, sinon le flux par défaut. Le nom du flux (ex. « oui », « non ») s\'affiche sur le diagramme.'
      : 'Tous les flux dont la condition est vraie sont suivis ; le flux par défaut sert si aucune ne l\'est.';
    else if (isChoice) hint.textContent = 'Un seul flux sortant : la passerelle ne décide de rien ici. Elle sert à réunir des chemins ou vous pouvez ajouter d\'autres sorties.';

    for (const f of outs) {
      const flowEl = registry.get(f.id);
      const row = h(`<div class="gw-flow"><div class="gw-to"><span class="muted small">vers</span> <b></b></div></div>`);
      row.querySelector('b').textContent = targetName(f);
      if (flowEl) {
        const go = h('<button class="linklike small" type="button">sélectionner</button>');
        go.addEventListener('click', () => { selection.select(flowEl); });
        row.querySelector('.gw-to').append(' ', go);
      }
      if (isChoice && flowEl) {
        const isDefault = bo.default === f;
        const grid = h(`<div class="gw-grid">
          <input class="field small-field" placeholder="Nom (ex. oui)" aria-label="Nom du flux">
          <input class="field small-field mono" placeholder="\${condition}" aria-label="Condition">
          <label class="sw-lbl small"><input type="radio" name="def-${bo.id}"> par défaut</label></div>`);
        const [nameIn, condIn] = grid.querySelectorAll('input.field');
        const def = grid.querySelector('input[type=radio]');
        nameIn.value = f.name || ''; condIn.value = f.conditionExpression?.body || ''; def.checked = isDefault;
        nameIn.disabled = condIn.disabled = def.disabled = ro;
        condIn.disabled = ro || isDefault;
        nameIn.addEventListener('change', () => modeling.updateLabel(flowEl, nameIn.value.trim() || null));
        condIn.addEventListener('change', () => modeling.updateProperties(flowEl, { conditionExpression: condIn.value.trim() ? bpmnFactory.create('bpmn:FormalExpression', { body: condIn.value.trim() }) : undefined }));
        def.addEventListener('change', () => { if (def.checked) modeling.updateProperties(element, { default: f }); });
        row.append(grid);
      }
      list.append(row);
    }
    if (isChoice && bo.default && !ro) {
      const clear = h('<button class="linklike small" type="button">Retirer le flux par défaut</button>');
      clear.addEventListener('click', () => modeling.updateProperties(element, { default: undefined }));
      box.append(clear);
    }
    return box;
  }

  // ---------- timer ----------
  function timerSection(element, def, ro) {
    const kind = TIMER_KINDS.find(([k]) => def[k])?.[0] || 'timeDuration';
    const value = def[kind]?.body || '';
    const box = h(`<div class="fld timer">
      <span class="lbl">Délai</span>
      <div class="seg" role="radiogroup"></div>
      <input class="field mono" spellcheck="false">
      <p class="hint"></p>
      <div class="chips"></div>
    </div>`);
    const seg = box.querySelector('.seg');
    const input = box.querySelector('input');
    const hint = box.querySelector('.hint');
    const chips = box.querySelector('.chips');
    let k = kind;

    const commit = (newKind, v) => {
      const props = { timeDuration: undefined, timeDate: undefined, timeCycle: undefined };
      if (v) props[newKind] = bpmnFactory.create('bpmn:FormalExpression', { body: v });
      modeling.updateModdleProperties(element, def, props);
    };
    const describe = () => {
      const v = input.value.trim();
      const meaning = explainIso(v);
      const meta = TIMER_KINDS.find(([x]) => x === k);
      hint.className = 'hint' + (v && !meaning ? ' bad' : '');
      hint.textContent = !v ? meta[2] : meaning ? `= ${meaning}` : 'Format non reconnu (ISO 8601 attendu).';
      chips.replaceChildren(...meta[3].map(p => {
        const c = h('<button class="chip" type="button"></button>');
        c.textContent = p; c.disabled = ro;
        c.addEventListener('click', () => { input.value = p; describe(); commit(k, p); });
        return c;
      }));
    };
    for (const [key, label] of TIMER_KINDS) {
      const b = h(`<button type="button" role="radio"></button>`);
      b.textContent = label;
      b.setAttribute('aria-checked', String(key === k));
      b.disabled = ro;
      b.addEventListener('click', () => {
        k = key;
        seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
        describe();
        commit(k, input.value.trim());
      });
      seg.append(b);
    }
    input.value = value;
    input.disabled = ro;
    input.addEventListener('input', describe);
    input.addEventListener('change', () => commit(k, input.value.trim()));
    describe();
    return box;
  }

  // ---------- erreur / message / signal / escalade ----------
  function refSection(element, def, rk, ro) {
    const definitions = modeler.getDefinitions();
    const roots = definitions.rootElements || [];
    const items = roots.filter(r => is(r, rk.type));
    const box = h(`<div class="fld"><label class="lbl"></label><select class="field"></select><div class="sub"></div></div>`);
    box.querySelector('label').textContent = rk.label;
    const sel = box.querySelector('select');
    sel.append(new Option('— aucun —', ''));
    for (const it of items) sel.append(new Option(it.name || it.id, it.id));
    sel.append(new Option(`+ Nouveau ${rk.label.toLowerCase()}…`, '__new'));
    sel.value = def[rk.prop]?.id || '';
    sel.disabled = ro;
    sel.addEventListener('change', async () => {
      if (sel.value === '__new') {
        const name = (await dialog({ title: `Nouveau : ${rk.label.toLowerCase()}`, input: { placeholder: 'Nom' }, buttons: [{ label: 'Annuler', value: null }, { label: 'Créer', value: '$input', primary: true }] }))?.trim();
        if (!name) { sel.value = def[rk.prop]?.id || ''; return; }
        const attrs = { id: rid(rk.type.replace('bpmn:', '')), name };
        const created = bpmnFactory.create(rk.type, attrs);
        if (rk.code) created[rk.code] = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
        created.$parent = definitions;
        modeling.updateModdleProperties(element, definitions, { rootElements: [...roots, created] });
        modeling.updateModdleProperties(element, def, { [rk.prop]: created });
      } else {
        modeling.updateModdleProperties(element, def, { [rk.prop]: items.find(i => i.id === sel.value) || undefined });
      }
    });
    const ref = def[rk.prop];
    if (ref && rk.code) {
      box.querySelector('.sub').append(textField('Code', ref[rk.code] || '', v => modeling.updateModdleProperties(element, ref, { [rk.code]: v || undefined }), ro));
    }
    return box;
  }

  // ---------- champs génériques ----------
  function textField(label, value, onCommit, ro, placeholder = '') {
    const id = rid('f');
    const box = h(`<div class="fld"><label class="lbl" for="${id}"></label><input class="field" id="${id}"></div>`);
    box.querySelector('label').textContent = label;
    const i = box.querySelector('input');
    i.value = value; i.placeholder = placeholder; i.disabled = ro;
    i.addEventListener('change', () => onCommit(i.value.trim()));
    i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); });
    return box;
  }
  function textArea(label, value, onCommit, ro, mono = false) {
    const id = rid('f');
    const box = h(`<div class="fld"><label class="lbl" for="${id}"></label><textarea class="field ${mono ? 'mono' : ''}" rows="${mono ? 6 : 3}" id="${id}"></textarea></div>`);
    box.querySelector('label').textContent = label;
    const t = box.querySelector('textarea');
    t.value = value; t.disabled = ro;
    t.addEventListener('change', () => onCommit(t.value));
    return box;
  }
  function toggle(label, help, checked, onChange, ro) {
    const id = rid('t');
    const box = h(`<div class="fld toggle"><input type="checkbox" id="${id}"><label for="${id}"></label><p class="hint"></p></div>`);
    box.querySelector('label').textContent = label;
    box.querySelector('.hint').textContent = help;
    const c = box.querySelector('input');
    c.checked = checked; c.disabled = ro;
    c.addEventListener('change', () => onChange(c.checked));
    return box;
  }
  function info(label, value) {
    const box = h('<div class="fld info"><span class="lbl"></span><span></span></div>');
    box.firstChild.textContent = label;
    box.lastChild.textContent = value;
    return box;
  }

  // ---------- abonnements ----------
  const focusedInside = () => host.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  modeler.on('selection.changed', render);
  modeler.on('elements.changed', ({ elements }) => {
    if (focusedInside()) return;
    if (!current || elements.some(e => e === current || e.id === current.id)) render();
  });
  modeler.on('import.done', () => { current = null; render(); });
  ctx.on('editing', render);
  // nouveau contrôle : on rafraîchit, sauf pendant une saisie dans le panneau (pour ne pas perdre le curseur)
  ctx.on('check', () => { if (!host.contains(document.activeElement) || document.activeElement === document.body) render(); });
  ctx.on('mode', render);
  render();

  return { destroy() {}, lint };
}
