// Moteur d'exploration des parcours d'un processus BPMN.
// À chaque situation, il calcule toutes les suites possibles (branches, événements qui peuvent
// survenir, sous-processus événementiels…) ; l'utilisateur en choisit une, et peut revenir en arrière.
// Module pur (pas de DOM) : il travaille sur le modèle bpmn-moddle.
import { TYPE_LABELS, DEF_LABELS, explainIso } from './i18n.js';

const is = (bo, type) => !!bo && (bo.$instanceOf ? bo.$instanceOf(type) : bo.$type === type);
const defOf = bo => (bo?.eventDefinitions || [])[0] || null;
const defKind = bo => defOf(bo)?.$type || null;

export function nameOf(bo) {
  if (!bo) return '?';
  if (bo.name) return `« ${bo.name} »`;
  return (TYPE_LABELS[bo.$type] || bo.$type.replace('bpmn:', '')).toLowerCase();
}

/** Description d'un événement qui survient : « le délai de 15 jours s'écoule », « le message X arrive »… */
export function describeEvent(bo) {
  const d = defOf(bo);
  const n = bo.name ? ` « ${bo.name} »` : '';
  if (!d) return bo.name ? `« ${bo.name} » survient` : 'l\'événement survient';
  if (is(d, 'bpmn:TimerEventDefinition')) {
    const v = d.timeDuration?.body || d.timeDate?.body || d.timeCycle?.body;
    const meaning = v ? (explainIso(v) || v) : '';
    return `le délai${n} s'écoule${meaning ? ` (${meaning})` : ''}`;
  }
  if (is(d, 'bpmn:MessageEventDefinition')) return `le message${n || (d.messageRef?.name ? ` « ${d.messageRef.name} »` : '')} arrive`;
  if (is(d, 'bpmn:ErrorEventDefinition')) return `l'erreur${d.errorRef?.name ? ` « ${d.errorRef.name} »` : n} survient`;
  if (is(d, 'bpmn:SignalEventDefinition')) return `le signal${n} est reçu`;
  if (is(d, 'bpmn:ConditionalEventDefinition')) return `la condition${n} devient vraie${d.condition?.body ? ` (${d.condition.body})` : ''}`;
  if (is(d, 'bpmn:EscalationEventDefinition')) return `l'escalade${n} est signalée`;
  if (is(d, 'bpmn:CompensateEventDefinition')) return 'une compensation est déclenchée';
  return `${(DEF_LABELS[d.$type] || 'événement').toLowerCase()}${n} survient`;
}

function flowLabel(f, gatewayBo) {
  const parts = [];
  if (f.name) parts.push(`« ${f.name} »`);
  if (f.conditionExpression?.body) parts.push(`si ${f.conditionExpression.body}`);
  if (gatewayBo?.default === f) parts.push('par défaut');
  return parts.join(' · ');
}

export function createWalker(definitions) {
  // ---------- index du modèle ----------
  const byId = new Map();
  const boundaries = new Map(); // id de l'activité → [événements de bordure]
  const processes = [];
  const visit = c => {
    for (const el of c.flowElements || []) {
      byId.set(el.id, el);
      if (is(el, 'bpmn:BoundaryEvent') && el.attachedToRef) {
        const k = el.attachedToRef.id;
        boundaries.set(k, [...(boundaries.get(k) || []), el]);
      }
      if (el.flowElements) visit(el);
    }
  };
  for (const r of definitions.rootElements || []) if (is(r, 'bpmn:Process')) { processes.push(r); byId.set(r.id, r); visit(r); }

  const scopeOf = bo => bo.$parent?.id;
  const isEventSub = bo => is(bo, 'bpmn:SubProcess') && bo.triggeredByEvent;
  const isContainer = bo => (is(bo, 'bpmn:SubProcess') || is(bo, 'bpmn:Transaction')) && !bo.triggeredByEvent
    && (bo.flowElements || []).some(e => is(e, 'bpmn:StartEvent'));
  const starts = container => (container.flowElements || []).filter(e => is(e, 'bpmn:StartEvent'));
  const eventSubs = container => (container.flowElements || []).filter(isEventSub);
  /** Vrai si l'élément `id` est (indirectement) dans le conteneur `scopeId`. */
  const within = (id, scopeId) => { for (let b = byId.get(id); b; b = b.$parent) if (b.id === scopeId) return true; return false; };

  // ---------- état ----------
  let s = fresh();
  const past = [];

  function fresh() {
    return { seq: 0, started: false, finished: false, tokens: [], joins: {}, visited: [], flows: [], completed: [], log: [], warnings: [] };
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  const log = (text, kind = 'step', ids = []) => s.log.push({ text, kind, ids });
  const warn = (text, ids = []) => { s.warnings.push({ text, ids }); log(text, 'warn', ids); };
  const newToken = (at, scope, extra = {}) => { const t = { id: `t${++s.seq}`, at, scope, kind: 'active', ...extra }; s.tokens.push(t); return t; };
  const remove = t => { s.tokens = s.tokens.filter(x => x !== t); };
  const markVisited = id => { if (!s.visited.includes(id)) s.visited.push(id); };

  function move(t, flow) {
    if (!s.flows.includes(flow.id)) s.flows.push(flow.id);
    t.at = flow.targetRef.id;
    t.kind = 'active';
    t.via = flow.id;
    delete t.split;
    markVisited(t.at);
    const target = flow.targetRef;
    if (!is(target, 'bpmn:Gateway') && !is(target, 'bpmn:EndEvent')) log(`→ ${nameOf(target)}`, 'step', [target.id]);
  }

  /** Quitte l'élément courant par ses flux sortants (sans choix à faire, sinon marque le jeton). */
  function leave(t) {
    const bo = byId.get(t.at);
    const outs = bo.outgoing || [];
    if (is(bo, 'bpmn:Activity') && !is(bo, 'bpmn:SubProcess')) s.completed.push(bo.id);
    if (!outs.length) {
      if (!is(bo, 'bpmn:EndEvent')) warn(`${nameOf(bo)} n'a aucun flux sortant : le parcours s'arrête ici sans événement de fin.`, [bo.id]);
      return end(t, true);
    }
    const conditional = outs.some(f => f.conditionExpression) || (bo.default && outs.length > 1);
    if (outs.length === 1) return move(t, outs[0]);
    if (conditional || is(bo, 'bpmn:ExclusiveGateway') || is(bo, 'bpmn:InclusiveGateway')) { t.split = true; return; }
    // Plusieurs flux sans condition : tous sont suivis (parallèle implicite).
    outs.slice(1).forEach(f => move(newToken(t.at, t.scope), f));
    move(t, outs[0]);
  }

  function tokensIn(scopeId) { return s.tokens.filter(x => x.kind !== 'done' && within(x.at, scopeId) && x.at !== scopeId); }

  function kill(scopeId, keep) {
    for (const x of tokensIn(scopeId)) if (x !== keep) remove(x);
  }

  function end(t, implicit = false) {
    const bo = byId.get(t.at);
    remove(t);
    const d = defOf(bo);
    if (!implicit && is(bo, 'bpmn:EndEvent')) log(`■ Fin : ${nameOf(bo)}`, 'end', [bo.id]);
    if (d && is(d, 'bpmn:TerminateEventDefinition')) { kill(t.scope); log('Toutes les branches de ce périmètre sont arrêtées (fin immédiate).', 'info'); }
    if (d && is(d, 'bpmn:ErrorEventDefinition')) return throwError(t.scope, d.errorRef, bo);
    checkCompletion(t.scope);
  }

  function throwError(fromScope, errorRef, thrower) {
    const matches = ev => { const d = defOf(ev); return d && is(d, 'bpmn:ErrorEventDefinition') && (!d.errorRef || !errorRef || d.errorRef === errorRef); };
    for (let scope = byId.get(fromScope); scope; scope = scope.$parent) {
      // Sous-processus événementiel d'erreur dans ce périmètre (sauf celui qui a levé l'erreur).
      if (scope.flowElements) {
        for (const es of eventSubs(scope)) {
          if (within(thrower.id, es.id)) continue;
          const st = starts(es).find(matches);
          if (st) { log(`⚡ Erreur${errorRef?.name ? ` « ${errorRef.name} »` : ''} capturée par ${nameOf(es)}`, 'event', [es.id]); return startEventSub(scope.id, es, st); }
        }
      }
      if (is(scope, 'bpmn:Process')) break;
      const b = (boundaries.get(scope.id) || []).find(matches);
      const container = s.tokens.find(x => x.at === scope.id && x.kind === 'container');
      if (b) {
        kill(scope.id);
        if (container) remove(container);
        log(`⚡ Erreur${errorRef?.name ? ` « ${errorRef.name} »` : ''} capturée sur le bord de ${nameOf(scope)}`, 'event', [b.id]);
        const nt = newToken(b.id, scopeOf(b));
        markVisited(b.id);
        leave(nt);
        return;
      }
    }
    warn(`L'erreur${errorRef?.name ? ` « ${errorRef.name} »` : ''} levée par ${nameOf(thrower)} n'est capturée nulle part : le processus s'arrête.`, [thrower.id]);
    s.tokens = [];
  }

  function checkCompletion(scopeId) {
    const scope = byId.get(scopeId);
    if (!scope || tokensIn(scopeId).length) return;
    const container = s.tokens.find(x => x.at === scopeId && x.kind === 'container');
    if (container) {
      remove(container);
      if (isEventSub(scope)) {
        log(`${nameOf(scope)} est terminé.`, 'info', [scope.id]);
        if (container.interrupting) checkCompletion(scopeOf(scope)); // le parent se termine avec lui
        else checkCompletion(scopeOf(scope));
        return;
      }
      log(`${nameOf(scope)} est terminé.`, 'info', [scope.id]);
      const nt = newToken(scope.id, scopeOf(scope));
      leave(nt);
      return;
    }
    if (is(scope, 'bpmn:Process') && !s.tokens.length) { s.finished = true; log('Parcours terminé.', 'end'); }
  }

  function startEventSub(parentScopeId, es, start) {
    const interrupting = start.isInterrupting !== false;
    if (interrupting) kill(parentScopeId);
    const c = newToken(es.id, parentScopeId, { kind: 'container', interrupting });
    markVisited(es.id);
    const t = newToken(start.id, es.id);
    markVisited(start.id);
    log(`${interrupting ? '⚡' : '↳'} ${nameOf(es)} démarre${interrupting ? ' et interrompt le reste' : ' en parallèle'}`, 'event', [es.id]);
    leave(t);
    return c;
  }

  /** Résout tout ce qui ne demande pas de choix. */
  function settle() {
    for (let guard = 0; guard < 500; guard++) {
      const t = s.tokens.find(x => x.kind === 'active' && !x.split && autoStep(x));
      if (!t) return;
    }
    warn('Boucle sans fin détectée : un cycle ne comporte ni attente ni choix.');
  }

  /** Avance le jeton si aucun choix n'est nécessaire ; renvoie true s'il a bougé. */
  function autoStep(t) {
    const bo = byId.get(t.at);
    if (!bo) { remove(t); return true; }
    if (is(bo, 'bpmn:StartEvent')) { leave(t); return true; }
    if (is(bo, 'bpmn:BoundaryEvent')) { leave(t); return true; }
    if (is(bo, 'bpmn:IntermediateThrowEvent')) {
      const d = defOf(bo);
      if (d && is(d, 'bpmn:CompensateEventDefinition')) compensate(t, bo);
      else if (d) log(`${nameOf(bo)} : ${(DEF_LABELS[d.$type] || '').toLowerCase()} émis`, 'info', [bo.id]);
      leave(t); return true;
    }
    if (is(bo, 'bpmn:EndEvent')) { end(t); return true; }
    if (isContainer(bo)) {
      t.kind = 'container';
      log(`${nameOf(bo)} commence`, 'step', [bo.id]);
      for (const st of starts(bo)) { newToken(st.id, bo.id); markVisited(st.id); }
      return true;
    }
    if (is(bo, 'bpmn:ParallelGateway') || is(bo, 'bpmn:InclusiveGateway')) {
      const ins = bo.incoming || [];
      if (ins.length > 1) {
        const key = `${bo.id}@${t.scope}`;
        const here = s.tokens.filter(x => x.at === bo.id && x.scope === t.scope && x.kind !== 'container');
        const ready = is(bo, 'bpmn:ParallelGateway')
          ? here.length >= ins.length
          : !s.tokens.some(x => x.at !== bo.id && x.kind === 'active' && within(x.at, t.scope) && canReach(x.at, bo.id));
        if (!ready) { here.forEach(x => { x.kind = 'waiting'; }); s.joins[key] = here.length; return false; }
        here.filter(x => x !== t).forEach(remove);
        delete s.joins[key];
        if (here.length > 1) log(`⨁ Les branches se rejoignent sur ${nameOf(bo)}`, 'info', [bo.id]);
      }
      const outs = bo.outgoing || [];
      if (is(bo, 'bpmn:InclusiveGateway') && outs.length > 1) { t.kind = 'active'; t.split = true; return true; }
      if (outs.length > 1) log(`⨁ ${outs.length} branches démarrent en parallèle`, 'info', [bo.id]);
      t.kind = 'active';
      outs.slice(1).forEach(f => move(newToken(bo.id, t.scope), f));
      if (outs[0]) move(t, outs[0]); else end(t, true);
      return true;
    }
    if (is(bo, 'bpmn:ExclusiveGateway')) {
      if ((bo.outgoing || []).length <= 1) { leave(t); return true; }
      t.split = true; return true;
    }
    return false; // activité, attente ou passerelle événementielle : choix de l'utilisateur
  }

  function canReach(fromId, toId) {
    const seen = new Set(); const stack = [fromId];
    while (stack.length) {
      const id = stack.pop();
      if (id === toId) return true;
      if (seen.has(id)) continue; seen.add(id);
      for (const f of byId.get(id)?.outgoing || []) stack.push(f.targetRef.id);
    }
    return false;
  }

  function compensate(t, thrower) {
    let scope = byId.get(t.scope);
    if (scope && isEventSub(scope)) scope = scope.$parent;
    const handlers = [];
    for (const id of [...s.completed].reverse()) {
      if (!within(id, scope.id)) continue;
      for (const b of boundaries.get(id) || []) {
        if (!defKind(b)?.includes('Compensate')) continue;
        const assoc = findCompensationHandler(b);
        handlers.push(assoc ? nameOf(assoc) : `la compensation de ${nameOf(byId.get(id))}`);
      }
    }
    log(handlers.length ? `↺ Compensation : ${handlers.join(', ')}` : '↺ Compensation déclenchée, mais aucune étape terminée n\'a d\'activité de compensation.', handlers.length ? 'event' : 'warn', [thrower.id]);
  }

  function findCompensationHandler(boundary) {
    const proc = processes.find(p => within(boundary.id, p.id));
    const all = [];
    const walk = c => { for (const a of c.artifacts || []) all.push(a); for (const e of c.flowElements || []) if (e.flowElements || e.artifacts) walk(e); };
    if (proc) walk(proc);
    const assoc = all.find(a => is(a, 'bpmn:Association') && a.sourceRef === boundary);
    return assoc?.targetRef || null;
  }

  // ---------- options proposées à l'utilisateur ----------
  function options() {
    const opts = [];
    if (!s.started) {
      for (const p of processes) for (const st of starts(p)) {
        opts.push({ id: `start:${st.id}`, group: 'Démarrer', label: `Démarrer par ${nameOf(st)}`, detail: defOf(st) ? `quand ${describeEvent(st)}` : '', targets: [st.id],
          apply: () => { s.started = true; markVisited(st.id); log(`▶ Démarrage : ${nameOf(st)}`, 'step', [st.id]); newToken(st.id, p.id); } });
      }
      return opts;
    }
    for (const t of s.tokens) {
      const bo = byId.get(t.at);
      if (!bo) continue;
      const where = nameOf(bo);
      if (t.kind === 'waiting') continue;

      if (t.kind === 'container') {
        if (!isEventSub(bo)) addBoundaryOptions(opts, t, bo, `Pendant ${where}`);
        continue;
      }
      if (t.split) {
        const outs = bo.outgoing || [];
        const isGw = is(bo, 'bpmn:Gateway');
        for (const f of outs) {
          opts.push({ id: `${t.id}:flow:${f.id}`, group: isGw ? `Choix à ${where}` : `Sortie de ${where}`, label: `Suivre ${flowLabel(f, bo) || 'ce chemin'}`, detail: `vers ${nameOf(f.targetRef)}`,
            targets: [f.targetRef.id], flows: [f.id], apply: () => { log(`◇ ${where} : ${flowLabel(f, bo) || 'chemin'} choisi`, 'choice', [f.id]); move(t, f); } });
        }
        if (is(bo, 'bpmn:InclusiveGateway') && outs.length > 1) {
          opts.push({ id: `${t.id}:all`, group: `Choix à ${where}`, label: 'Suivre toutes les branches', detail: `${outs.length} chemins en parallèle`, targets: outs.map(f => f.targetRef.id), flows: outs.map(f => f.id),
            apply: () => { log(`◇ ${where} : toutes les branches`, 'choice', [bo.id]); outs.slice(1).forEach(f => move(newToken(bo.id, t.scope), f)); move(t, outs[0]); } });
        }
        continue;
      }
      if (is(bo, 'bpmn:EventBasedGateway')) {
        for (const f of bo.outgoing || []) {
          const ev = f.targetRef;
          opts.push({ id: `${t.id}:evgw:${ev.id}`, group: `En attente à ${where}`, label: `${capital(describeEvent(ev))} en premier`, detail: `puis ${nameOf(ev)} déclenche la suite`,
            targets: [ev.id], flows: [f.id], apply: () => { log(`⏱ ${capital(describeEvent(ev))} en premier`, 'event', [ev.id]); move(t, f); leave(t); } });
        }
        continue;
      }
      if (is(bo, 'bpmn:IntermediateCatchEvent')) {
        opts.push({ id: `${t.id}:catch`, group: `En attente à ${where}`, label: capital(describeEvent(bo)), detail: 'le jeton continue', targets: nextTargets(bo),
          apply: () => { log(`⏱ ${capital(describeEvent(bo))}`, 'event', [bo.id]); leave(t); } });
        continue;
      }
      if (is(bo, 'bpmn:Activity')) {
        opts.push({ id: `${t.id}:done`, group: `Pendant ${where}`, label: is(bo, 'bpmn:ReceiveTask') ? `Le message est reçu : ${where} se termine` : `${capital(where)} se termine normalement`,
          detail: describeNext(bo), targets: nextTargets(bo), flows: (bo.outgoing || []).map(f => f.id),
          apply: () => { log(`✓ ${capital(where)} terminé`, 'step', [bo.id]); leave(t); } });
        addBoundaryOptions(opts, t, bo, `Pendant ${where}`);
      }
    }
    // Sous-processus événementiels déclenchables (au niveau du processus et des sous-processus actifs).
    const activeScopes = new Set([...processes.filter(() => s.tokens.length).map(p => p.id), ...s.tokens.filter(x => x.kind === 'container' && !isEventSub(byId.get(x.at))).map(x => x.at)]);
    for (const scopeId of activeScopes) {
      const scope = byId.get(scopeId);
      for (const es of eventSubs(scope)) {
        if (s.tokens.some(x => x.at === es.id && x.kind === 'container' && x.interrupting)) continue;
        for (const st of starts(es)) {
          if (defKind(st) === 'bpmn:ErrorEventDefinition') continue; // déclenché par une erreur, pas à la main
          opts.push({ id: `evsub:${scopeId}:${st.id}`, group: `À tout moment dans ${nameOf(scope)}`, label: capital(describeEvent(st)),
            detail: `${nameOf(es)} démarre${st.isInterrupting !== false ? ' et interrompt les étapes en cours' : ' en parallèle'}`, targets: [st.id, es.id],
            apply: () => startEventSub(scopeId, es, st) });
        }
      }
    }
    return opts;
  }

  function addBoundaryOptions(opts, t, bo, group) {
    for (const b of boundaries.get(bo.id) || []) {
      const kind = defKind(b);
      if (!kind || kind.includes('Compensate')) continue;
      // Sur un sous-processus, une erreur vient de l'intérieur (fin en erreur) : pas de déclenchement manuel.
      if (t.kind === 'container' && kind === 'bpmn:ErrorEventDefinition') continue;
      const interrupting = b.cancelActivity !== false;
      opts.push({
        id: `${t.id}:b:${b.id}`, group, label: capital(describeEvent(b)),
        detail: `${interrupting ? `${nameOf(bo)} est interrompu` : `${nameOf(bo)} continue en parallèle`}, ${describeNext(b)}`,
        targets: [b.id, ...nextTargets(b)], flows: (b.outgoing || []).map(f => f.id),
        apply: () => {
          log(`⚡ ${capital(describeEvent(b))}${interrupting ? ` : ${nameOf(bo)} est interrompu` : ' (en parallèle)'}`, 'event', [b.id]);
          if (interrupting) { if (t.kind === 'container') kill(bo.id); remove(t); }
          markVisited(b.id);
          const nt = newToken(b.id, scopeOf(b));
          leave(nt);
        }
      });
    }
  }

  const nextTargets = bo => (bo.outgoing || []).map(f => f.targetRef.id);
  function describeNext(bo) {
    const outs = bo.outgoing || [];
    if (!outs.length) return 'puis le parcours s\'arrête (aucun flux sortant)';
    return `puis ${outs.map(f => nameOf(f.targetRef)).join(' ou ')}`;
  }
  const capital = x => x.charAt(0).toUpperCase() + x.slice(1);

  // ---------- API ----------
  function current() {
    const opts = options();
    return {
      started: s.started, finished: s.finished || (s.started && !s.tokens.length),
      tokens: s.tokens.map(t => ({ id: t.id, at: t.at, kind: t.kind, label: nameOf(byId.get(t.at)), waitingFor: t.kind === 'waiting' ? (byId.get(t.at).incoming || []).length : 0 })),
      options: opts.map(({ apply, ...o }) => o),
      visited: s.visited.slice(), flows: s.flows.slice(), log: s.log.slice(), warnings: s.warnings.slice(),
      canUndo: past.length > 0
    };
  }

  return {
    current,
    choose(optionId) {
      const opt = options().find(o => o.id === optionId);
      if (!opt) throw new Error('Option introuvable');
      past.push(clone(s));
      opt.apply();
      settle();
      if (s.started && !s.tokens.length && !s.finished) { s.finished = true; log('Parcours terminé.', 'end'); }
      return current();
    },
    undo() { if (past.length) s = past.pop(); return current(); },
    reset() { s = fresh(); past.length = 0; return current(); },
    /** Résumé textuel du parcours (pour Claude, outil explore). */
    describe() {
      const c = current();
      return [
        'Parcours suivi dans l\'explorateur :',
        ...c.log.map(l => `- ${l.text}`),
        c.finished ? 'Situation : parcours terminé.' : `Situation actuelle : ${c.tokens.map(t => `${t.label}${t.kind === 'waiting' ? ' (attend les autres branches)' : ''}`).join(' ; ') || 'aucune étape en cours'}.`,
        c.options.length ? `Suites possibles selon le diagramme :\n${c.options.map(o => `- [${o.group}] ${o.label}${o.detail ? ` (${o.detail})` : ''}`).join('\n')}` : ''
      ].filter(Boolean).join('\n');
    }
  };
}
