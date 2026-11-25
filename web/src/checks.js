// Onglet « Contrôles » : problèmes de cohérence du workflow, avec pour chacun ce qui ne va pas
// et comment le corriger. Clic sur un problème : zoom sur l'élément concerné.
import { h } from './dom.js';
import { checkCoherence } from '../../shared/coherence.js';
import { createFocus } from './focus.js';

const LEVELS = [
  ['error', 'Bloquants', 'Le processus est cassé ou ambigu à cet endroit. Claude ne peut pas en ajouter de nouveaux.'],
  ['warn', 'À vérifier', 'Incomplet ou douteux : normal pendant la construction, à régler avant de finaliser.'],
  ['info', 'Remarques', 'Facultatif, pour un diagramme plus précis.']
];

/** Problèmes courants : ceux du serveur (avec bpmnlint) si disponibles, sinon le contrôle local. */
export function currentIssues(ctx) {
  return ctx.check?.issues || checkCoherence(ctx.modeler.getDefinitions());
}

export function createChecks(ctx, host, { tabButton } = {}) {
  const { modeler } = ctx;
  const registry = modeler.get('elementRegistry');
  const selection = modeler.get('selection');
  const canvas = modeler.get('canvas');

  const focus = createFocus(modeler);
  /**
   * Zoom sur la zone où agir : l'élément concerné et ceux que cite le message (flux, élément traversé,
   * autre sortie de passerelle…), surlignés quelques secondes.
   */
  function focusIssue(i) {
    const cited = [...String(i.text || '').matchAll(/[A-Za-z_][\w.-]{3,}/g)].map(m => m[0]).filter(id => id !== i.id && registry.get(id) && registry.get(id).type !== 'label');
    const ids = [i.id, ...new Set(cited)].filter(id => id && registry.get(id));
    if (!ids.length) return;
    // un élément d'une vue détaillée (sous-processus replié) : on ouvre cette vue d'abord
    const el = registry.get(ids[0]);
    let root = el; while (root.parent) root = root.parent;
    if (root !== canvas.getRootElement()) canvas.setRootElement(root);
    focus.show(ids, { highlight: true, maxZoom: 1.2, pad: 120 });
    if (ids.length === 1) selection.select(el);
  }

  function render() {
    const issues = currentIssues(ctx);
    const counts = Object.fromEntries(LEVELS.map(([l]) => [l, issues.filter(i => i.level === l).length]));
    if (tabButton) {
      const n = counts.error + counts.warn;
      tabButton.innerHTML = '';
      tabButton.append('Contrôles');
      if (n) tabButton.append(Object.assign(document.createElement('span'), { className: `tab-count ${counts.error ? 'err' : 'warn'}`, textContent: n }));
    }
    const el = h(`<div class="props checks">
      <h3 class="props-title">Contrôles du diagramme</h3>
      <p class="muted small">Vérifiés à chaque sauvegarde${ctx.check ? ` (en ${ctx.check.ms} ms)` : ''}. Cliquez sur un point pour zoomer sur la zone concernée.</p>
      <div class="groups"></div>
    </div>`);
    const groups = el.querySelector('.groups');
    if (!issues.length) groups.append(h('<p class="check-ok">✓ Aucun problème : le workflow est cohérent.</p>'));
    for (const [level, title, about] of LEVELS) {
      const list = issues.filter(i => i.level === level);
      if (!list.length) continue;
      const g = h(`<section class="check-group ${level}"><h4></h4><p class="muted small"></p><ul></ul></section>`);
      g.querySelector('h4').textContent = `${title} (${list.length})`;
      g.querySelector('p').textContent = about;
      const ul = g.querySelector('ul');
      for (const i of list) {
        const li = h('<li class="ck-item" title="Cliquer pour zoomer sur la zone"><div class="ck-head"><button class="linklike" type="button"></button><span class="ck-text"></span></div></li>');
        const btn = li.querySelector('button');
        const bo = i.id && registry.get(i.id)?.businessObject;
        btn.textContent = (bo && (bo.name || '').replace(/\s+/g, ' ')) || i.name || i.id || 'Diagramme';
        btn.disabled = !(i.id && registry.get(i.id));
        if (!btn.disabled) { li.classList.add('clickable'); li.addEventListener('click', () => focusIssue(i)); }
        li.querySelector('.ck-text').textContent = ` : ${i.text}`;
        if (i.fix) {
          const fix = h('<p class="ck-fix"><b>Comment corriger :</b> <span></span></p>');
          fix.querySelector('span').textContent = i.fix;
          li.append(fix);
        }
        ul.append(li);
      }
      groups.append(g);
    }
    host.replaceChildren(el);
  }

  ctx.on('check', render);
  ctx.on('saved', render);
  render();
  return { render, destroy() {} };
}
