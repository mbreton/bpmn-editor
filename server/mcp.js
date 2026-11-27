// Serveur MCP (Streamable HTTP, sans état) : Claude lit les diagrammes, les modifie dans le
// brouillon de la personne connectée, les montre à l'écran et les explore. Les modifications passent
// par la page ouverte dans le navigateur, où elles s'affichent en direct.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BpmnModdle } from 'bpmn-moddle';
import { OPS_SPEC } from './ops-spec.js';
import { summarize } from '../shared/summary.js';
import { formatIssue } from '../shared/coherence.js';
import { createWalker } from '../shared/pathwalker.js';

const moddle = new BpmnModdle();
const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });
const fmt = t => t ? new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) : '';

export function createMcp({ db, diagrams, hub, checkDiagram, layout, accounts, git, logActivity = () => {}, version = '1.0.0' }) {
  // La suppression n'est offerte à Claude que si un dépôt Git distant est branché : l'historique y est
  // poussé, donc un diagramme supprimé reste récupérable. Sans distant, rien n'existe en dehors du serveur.
  const gitConnected = !!git?.status?.remote;
  const issuesText = (issues, { max = 15, levels = ['error', 'warn'] } = {}) => {
    const shown = issues.filter(i => levels.includes(i.level));
    if (!shown.length) return 'Aucun problème de cohérence.';
    const lbl = { error: 'BLOQUANT', warn: 'à vérifier', info: 'remarque' };
    return `Cohérence :\n${shown.slice(0, max).map(i => `- ${lbl[i.level]} · ${formatIssue(i)}`).join('\n')}${shown.length > max ? `\n… et ${shown.length - max} autre(s)` : ''}`;
  };
  /** Cohérence en différentiel : seulement ce qui apparaît ou disparaît (le reste : get_diagram). */
  const key = i => `${i.rule}|${i.id}|${i.text}`;
  const diffText = (before, after) => {
    const had = new Set(before.map(key)), now = new Set(after.map(key));
    const added = after.filter(i => !had.has(key(i)) && i.level !== 'info');
    const gone = before.filter(i => !now.has(key(i)) && i.level !== 'info');
    const kept = after.filter(i => had.has(key(i)) && i.level !== 'info').length;
    const lbl = { error: 'BLOQUANT', warn: 'à vérifier' };
    const parts = [];
    if (added.length) parts.push(`Nouveaux problèmes :\n${added.map(i => `- ${lbl[i.level]} · ${formatIssue(i)}`).join('\n')}`);
    if (gone.length) parts.push(`Résolus : ${gone.map(i => `[${i.id}] ${i.text}`).join(' ; ')}`);
    if (!added.length && !gone.length) parts.push('Cohérence : aucun changement.');
    if (kept) parts.push(`(${kept} point${kept > 1 ? 's' : ''} déjà présent${kept > 1 ? 's' : ''} avant, non répété${kept > 1 ? 's' : ''} : voir get_diagram.)`);
    return parts.join('\n');
  };
  const checked = async xml => { const r = await checkDiagram(xml); return { ...r, check: { issues: r.issues, ms: r.ms } }; };
  const explorations = new Map(); // `${userId}:${diagramId}` → [optionId…]

  function build(user, baseUrl) {
    const server = new McpServer({ name: 'editeur-bpmn', version }, {
      instructions: `Éditeur BPMN de ${user.name}. Les modifications vont dans le brouillon du diagramme (sauvegardé en continu, annulable avec undo) et s'affichent en direct dans le navigateur de l'utilisateur ; elles ne deviennent une version Git qu'avec save_version, à faire seulement quand l'utilisateur le demande. Commencez par list_diagrams puis get_diagram. Chaque modification passe un contrôle de cohérence : si elle introduit un problème bloquant (condition manquante, référence cassée, délai invalide…), elle est refusée en entier avec l'explication ; corrigez et renvoyez. Les points « à vérifier » sont signalés sans bloquer. Les éléments ajoutés sont placés à une place libre ; si apply_changes signale un chevauchement ou si le rendu est confus, corrigez localement avec l'opération move (positions via get_diagram format "layout") plutôt qu'avec relayout, qui refait toute la disposition et n'est à utiliser que si l'utilisateur le demande. Supprimer un diagramme (delete_diagram) n'est possible que si l'éditeur est branché à un dépôt Git distant, pour un administrateur, et après confirmation explicite de l'utilisateur. Utilisez show pour zoomer sur ce dont vous parlez, view_diagram pour vérifier le rendu après une modification, explore pour vérifier qu'un parcours se comporte comme l'utilisateur l'attend. Répondez en français.`
    });
    const url = id => `${baseUrl}/d/${id}`;

    const find = idOrName => {
      const all = db.listDiagrams();
      const d = all.find(d => d.id === idOrName) || all.find(d => d.name.toLowerCase() === String(idOrName).toLowerCase())
        || all.filter(d => d.name.toLowerCase().includes(String(idOrName).toLowerCase())).at(0) || null;
      if (d) logActivity(user, { diagramId: d.id, kind: 'view', via: 'claude' });   // consultation par Claude (journal d'activité)
      return d;
    };
    const guardLock = d => (d.lock && d.lock.userId !== user.id) ? `${d.lock.author} est en train de modifier « ${d.name} » : je ne peux pas y toucher pour l'instant.` : null;
    const notOpen = d => `« ${d.name} » n'est ouvert dans aucun de vos navigateurs. Appelez open_diagram pour l'ouvrir dans la page de l'éditeur déjà ouverte, sinon demandez à l'utilisateur d'ouvrir ${url(d.id)}.`;

    async function model(xml) { return (await moddle.fromXML(xml, 'bpmn:Definitions')).rootElement; }

    /** Positions : une ligne par élément dessiné, regroupées par conteneur. */
    async function layoutText(xml) {
      const defs = await model(xml);
      const lines = ['Coordonnées en pixels : x, y = coin haut gauche ; l × h = taille ; centre = (x + l/2, y + h/2). L\'axe y descend.'];
      for (const d of defs.diagrams || []) {
        const shapes = (d.plane?.planeElement || []).filter(pe => pe.bounds && pe.bpmnElement);
        if (!shapes.length) continue;
        const byParent = new Map();
        for (const pe of shapes) {
          const el = pe.bpmnElement;
          const parent = el.$type === 'bpmn:BoundaryEvent' ? `la bordure de ${el.attachedToRef?.id}` : el.$parent?.id || '';
          if (!byParent.has(parent)) byParent.set(parent, []);
          const b = pe.bounds, lb = pe.label?.bounds;
          byParent.get(parent).push(`  [${el.id}] ${el.$type.replace('bpmn:', '')}${el.name ? ` « ${el.name.replace(/\s+/g, ' ')} »` : ''} : x=${Math.round(b.x)} y=${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}${lb ? ` · libellé x=${Math.round(lb.x)} y=${Math.round(lb.y)} ${Math.round(lb.width)}×${Math.round(lb.height)}` : ''}`);
        }
        for (const [parent, items] of byParent) lines.push(`Dans ${parent || 'le diagramme'} :`, ...items);
        // libellés des flux (pour les déplacer avec move + label:true)
        const named = (d.plane?.planeElement || []).filter(pe => pe.waypoint?.length && pe.label?.bounds && pe.bpmnElement?.name);
        if (named.length) lines.push('Libellés des flux :', ...named.map(pe => { const lb = pe.label.bounds, w = pe.waypoint; return `  [${pe.bpmnElement.id}] « ${pe.bpmnElement.name} » : libellé x=${Math.round(lb.x)} y=${Math.round(lb.y)} ${Math.round(lb.width)}×${Math.round(lb.height)} · tracé ${w.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ')}`; }));
      }
      return lines.join('\n');
    }

    server.registerTool('list_diagrams', {
      title: 'Lister les diagrammes',
      description: 'Liste les diagrammes BPMN : identifiant, nom, dernière modification, brouillon non enregistré, qui le modifie, qui l\'a ouvert.',
      inputSchema: {}
    }, async () => {
      const items = await Promise.all(db.listDiagrams().map(async d => {
        const st = await diagrams.draftState(d.id);
        const open = hub.openBy(d.id);
        return `- ${d.name} [id ${d.id}] · modifié ${fmt(d.updatedAt)}${d.updatedBy ? ` par ${d.updatedBy}` : ''}${st.dirty ? ' · brouillon non enregistré' : ''}${d.lock ? ` · ${d.lock.author} modifie` : ''}${open.length ? ` · ouvert par ${open.join(', ')}` : ''}\n  ${url(d.id)}`;
      }));
      return text(items.length ? items.join('\n') : 'Aucun diagramme.');
    });

    server.registerTool('get_diagram', {
      title: 'Lire un diagramme',
      description: 'Contenu du brouillon courant d\'un diagramme : éléments avec identifiants, types, noms, événements (délais ISO 8601, erreurs, messages), événements de bordure, flux avec conditions, sous-processus, et problèmes de cohérence détectés. format "layout" donne la position et la taille de chaque élément (pour l\'opération move), "xml" le BPMN brut.',
      inputSchema: { diagram: z.string().describe('Identifiant ou nom du diagramme'), format: z.enum(['summary', 'layout', 'xml']).optional() }
    }, async ({ diagram, format }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const full = await diagrams.get(d.id);
      if (format === 'xml') return text(full.xml);
      if (format === 'layout') return text(await layoutText(full.xml));
      const { text: body } = summarize(await model(full.xml));
      const { issues } = await checkDiagram(full.xml);
      const open = hub.openBy(d.id);
      return text([
        `« ${d.name} » [id ${d.id}] · version enregistrée v${full.version}${full.draft.dirty ? ' · brouillon modifié depuis' : ''}${d.lock ? ` · ${d.lock.author} est en mode édition` : ''}`,
        open.length ? `Ouvert à l'écran par : ${open.join(', ')}` : `Ouvert par personne (${url(d.id)})`,
        '', body, '',
        issuesText(issues, { max: 40, levels: ['error', 'warn', 'info'] })
      ].join('\n'));
    });

    server.registerTool('view_diagram', {
      title: 'Voir le rendu',
      description: 'Image (PNG) du diagramme tel qu\'il s\'affiche dans le navigateur de l\'utilisateur. element_ids : zone autour de ces éléments (le plus utile pour vérifier une modification, sans déplacer la vue de l\'utilisateur) ; sinon area "screen" (ce qu\'il voit) ou "all" (diagramme entier, peu lisible s\'il est grand). La légende donne les coordonnées de la zone. Nécessite que le diagramme soit ouvert dans son navigateur.',
      inputSchema: { diagram: z.string(), area: z.enum(['screen', 'all']).optional(), element_ids: z.array(z.string()).optional() }
    }, async ({ diagram, area, element_ids }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const r = await hub.request(d.id, user.id, { type: 'render', area: area || 'all', ids: element_ids || [] });
      if (!r) return fail(notOpen(d));
      if (!r.ok) return fail(r.error || 'Rendu impossible.');
      return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: r.caption || '' }] };
    });

    server.registerTool('apply_changes', {
      title: 'Modifier le diagramme',
      description: `Applique des modifications au brouillon du diagramme, immédiatement et à l'écran de l'utilisateur (les éléments ajoutés et modifiés sont surlignés). Chaque modification est annulable avec undo. Nécessite que le diagramme soit ouvert dans le navigateur de l'utilisateur.\n\n${OPS_SPEC}`,
      inputSchema: {
        diagram: z.string(),
        changes: z.array(z.object({
          title: z.string().describe('Titre court en français'),
          why: z.string().optional(),
          focus: z.array(z.string()).optional(),
          ops: z.array(z.record(z.string(), z.any())).min(1)
        })).min(1)
      }
    }, async ({ diagram, changes }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const locked = guardLock(d); if (locked) return fail(locked);
      const t0 = Date.now();
      const before = (await checkDiagram((await diagrams.get(d.id)).xml)).issues || [];
      const r = await hub.request(d.id, user.id, { type: 'apply', changes }, 30000);
      if (!r) return fail(notOpen(d));
      const lines = (r.results || []).map(x => x.ok ? `✓ ${x.title}${x.added?.length ? ` (ajoutés : ${x.added.join(', ')})` : ''}${x.overlaps?.length ? `\n  ⚠ chevauchement à corriger (opération move) : ${x.overlaps.join(' ; ')}` : ''}${x.notes?.length ? `\n  ${x.notes.join('\n  ')}` : ''}` : `✗ ${x.title} : ${x.error}`);
      if (r.rejected) {
        return fail(`Rien n'a été appliqué : la modification introduit ${r.issues.length > 1 ? 'des problèmes bloquants' : 'un problème bloquant'}. Corrigez puis renvoyez l'ensemble.\n${r.issues.map(i => `- ${formatIssue(i)}`).join('\n')}${lines.length ? `\n\nDétail des opérations (annulées) :\n${lines.join('\n')}` : ''}`);
      }
      if (!r.ok) return fail(r.error || 'Modification impossible.');
      const issues = r.check?.issues || [];
      return text(`${lines.join('\n')}\n\n${lines.some(l => l.startsWith('✓')) ? 'Brouillon enregistré, visible à l\'écran (annulable avec undo).' : 'Rien n\'a été modifié.'}\n${diffText(before, issues)}\n(contrôle : ${r.check?.ms ?? '?'} ms ; aller-retour : ${Date.now() - t0} ms)`);
    });

    const stepTool = (name, title, delta, description) => server.registerTool(name, {
      title, description, inputSchema: { diagram: z.string(), steps: z.number().int().min(1).max(20).optional() }
    }, async ({ diagram, steps = 1 }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const locked = guardLock(d); if (locked) return fail(locked);
      const beforeXml = (await diagrams.get(d.id)).xml;
      const done = [];
      let last = null;
      for (let i = 0; i < steps; i++) {
        const r = await diagrams.step(d.id, delta);
        if (!r) break;
        last = r;
        done.push(r.step?.label || 'modification');
      }
      if (!last) return fail(delta < 0 ? 'Rien à annuler.' : 'Rien à rétablir.');
      const { check, issues } = await checked(last.xml);
      const before = (await checkDiagram(beforeXml)).issues || [];
      hub.broadcast(d.id, { type: 'draft', xml: last.xml, draft: last.draft, check, by: `${user.name} (via Claude)`, label: `${delta < 0 ? 'Annulé' : 'Rétabli'} : ${done.join(' ; ')}`, source: 'mcp' });
      return text(`${delta < 0 ? 'Annulé' : 'Rétabli'} : ${done.join(' ; ')}.\n${diffText(before, issues)}`);
    });
    stepTool('undo', 'Annuler', -1, 'Annule la ou les dernières modifications du brouillon (celles de Claude comme celles faites à l\'écran).');
    stepTool('redo', 'Rétablir', 1, 'Rétablit une modification annulée.');

    server.registerTool('relayout', {
      title: 'Réorganiser la disposition',
      description: 'Recalcule entièrement la disposition du diagramme (alignement, espacement, tracé des flux), sans rien changer au processus lui-même. Remplace toute la mise en page faite à la main : seulement si l\'utilisateur le demande ; pour un ou deux éléments mal placés, utilisez l\'opération move d\'apply_changes. Vérifiez ensuite avec view_diagram. Annulable avec undo.',
      inputSchema: { diagram: z.string() }
    }, async ({ diagram }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const locked = guardLock(d); if (locked) return fail(locked);
      try {
        const r = await layout(d, { ...user, name: `${user.name} (via Claude)` });
        // passe de retouche dans la page : sorties de passerelle, flux qui traversent, libellés
        let tidy = 'Passe de retouche non faite (diagramme ouvert dans aucun navigateur).';
        const t = await hub.request(d.id, user.id, { type: 'apply', changes: [{ title: 'Retouches après réorganisation', ops: [{ op: 'tidy' }] }] }, 30000);
        if (t?.ok) tidy = t.results?.[0]?.notes?.join(' ') || 'Retouches faites.';
        else if (t) tidy = `Passe de retouche impossible : ${t.error || t.results?.[0]?.error || 'erreur'}.`;
        return text(`Disposition recalculée en ${r.ms} ms${r.warnings.length ? ` (avertissements : ${r.warnings.join(', ')})` : ''}. ${tidy}\nVisible à l'écran ; « undo » annule les retouches, un second « undo » la réorganisation. Vérifiez avec view_diagram (element_ids sur les zones signalées).`);
      } catch (e) { return fail(`Réorganisation impossible : ${e.message}`); }
    });

    server.registerTool('save_version', {
      title: 'Enregistrer une version',
      description: 'Enregistre le brouillon courant comme une version (commit Git signé par l\'utilisateur), avec un message. À n\'utiliser que lorsque l\'utilisateur le demande.',
      inputSchema: { diagram: z.string(), message: z.string().min(3).max(300) }
    }, async ({ diagram, message }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const locked = guardLock(d); if (locked) return fail(locked);
      const r = await diagrams.commit(d.id, { user, message });
      if (r.status === 204) return text('Rien à enregistrer : le brouillon est identique à la dernière version.');
      hub.broadcast(d.id, { type: 'commit', rev: r.diagram.rev, version: r.diagram.version, by: user.name, message });
      return text(`Version ${r.diagram.version} enregistrée (${r.diagram.rev.slice(0, 7)}) : ${message}`);
    });

    server.registerTool('open_diagram', {
      title: 'Ouvrir dans l\'éditeur',
      description: 'Ouvre un diagramme dans l\'éditeur graphique, dans la page de l\'éditeur que l\'utilisateur a déjà ouverte (liste des diagrammes ou un autre diagramme ; ses modifications en cours sont sauvegardées avant). Nécessaire avant apply_changes, show, view_diagram ou explore sur un diagramme qui n\'est pas affiché. À faire quand l\'utilisateur demande à voir un diagramme, ou juste après en avoir créé ou dupliqué un pour y travailler.',
      inputSchema: { diagram: z.string().describe('Identifiant ou nom du diagramme') }
    }, async ({ diagram }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      if (hub.isOpen(d.id, user.id)) return text(`« ${d.name} » est déjà ouvert dans votre navigateur (${url(d.id)}).`);
      const r = await hub.requestUser(user.id, { type: 'navigate', path: `/d/${d.id}` }, 8000);
      if (!r) return fail(`Aucune page de l'éditeur n'est ouverte dans vos navigateurs : ouvrez ${url(d.id)} (ou la liste des diagrammes, ${baseUrl}/), puis réessayez.`);
      if (!r.ok) return fail(r.error || 'La page n\'a pas pu changer de diagramme.');
      // la page charge le diagramme puis se reconnecte : on attend qu'elle soit prête à recevoir des actions
      for (let i = 0; i < 40 && !hub.isOpen(d.id, user.id); i++) await new Promise(res => setTimeout(res, 250));
      return hub.isOpen(d.id, user.id)
        ? text(`« ${d.name} » est ouvert dans l'éditeur (${url(d.id)}).`)
        : text(`Ouverture de « ${d.name} » demandée (${url(d.id)}) ; la page met du temps à charger, réessayez dans quelques secondes.`);
    });

    server.registerTool('show', {
      title: 'Montrer à l\'écran',
      description: 'Zoome et surligne des éléments dans le navigateur de l\'utilisateur, pour lui montrer ce dont vous parlez. À utiliser à chaque fois que vous commentez une partie précise du diagramme.',
      inputSchema: { diagram: z.string(), element_ids: z.array(z.string()).min(1) }
    }, async ({ diagram, element_ids }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      if (!hub.isOpen(d.id, user.id)) return fail(notOpen(d));
      hub.broadcast(d.id, { type: 'focus', ids: element_ids, userId: user.id });
      return text(`Affiché : ${element_ids.join(', ')}.`);
    });

    server.registerTool('explore', {
      title: 'Explorer un parcours',
      description: 'Parcourt le processus étape par étape, comme l\'explorateur de l\'interface (et en même temps à l\'écran) : à chaque situation, toutes les suites que le diagramme autorise. action "start" (re)commence, "choose" suit une option (option_id), "back" revient d\'un pas. Sert à vérifier avec l\'utilisateur que le diagramme se comporte comme il l\'attend.',
      inputSchema: { diagram: z.string(), action: z.enum(['start', 'choose', 'back']), option_id: z.string().optional() }
    }, async ({ diagram, action, option_id }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const key = `${user.id}:${d.id}`;
      let choices = action === 'start' ? [] : [...(explorations.get(key) || [])];
      if (action === 'back') choices.pop();
      const walker = createWalker(await model((await diagrams.get(d.id)).xml));
      try { for (const c of choices) walker.choose(c); } catch { choices = []; walker.reset(); }
      if (action === 'choose') {
        if (!option_id) return fail('option_id requis.');
        try { walker.choose(option_id); choices.push(option_id); }
        catch { return fail(`Option « ${option_id} » indisponible. Options actuelles :\n${walker.current().options.map(o => `- ${o.id} : ${o.label}`).join('\n')}`); }
      }
      explorations.set(key, choices);
      hub.broadcast(d.id, { type: 'explore', choices, userId: user.id });
      const c = walker.current();
      return text(`${walker.describe()}\n\nIdentifiants des options :\n${c.options.map(o => `- ${o.id} : ${o.label}`).join('\n') || '(aucune)'}`);
    });

    server.registerTool('history', {
      title: 'Historique',
      description: 'Versions enregistrées (commits Git) et dernières étapes du brouillon d\'un diagramme.',
      inputSchema: { diagram: z.string() }
    }, async ({ diagram }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const versions = await diagrams.history(d.id);
      const steps = db.recentSteps(d.id, 15);
      return text([
        'Versions enregistrées :', ...versions.slice(0, 20).map(v => `- v${v.version} ${v.sha.slice(0, 7)} · ${fmt(v.createdAt)} · ${v.author} · ${v.message}`),
        '', 'Dernières étapes du brouillon :', ...(steps.length ? steps.map(s => `- ${fmt(s.createdAt)} · ${s.author || '—'} · ${s.label || ''}`) : ['(aucune)'])
      ].join('\n'));
    });

    server.registerTool('restore_version', {
      title: 'Revenir à une version',
      description: 'Remet une version enregistrée dans le brouillon (annulable avec undo).',
      inputSchema: { diagram: z.string(), version: z.string().describe('sha (7 caractères suffisent) de la version') }
    }, async ({ diagram, version: sha }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const locked = guardLock(d); if (locked) return fail(locked);
      const r = await diagrams.restore(d.id, sha, { ...user, name: `${user.name} (via Claude)` });
      if (!r) return fail(`Version « ${sha} » introuvable.`);
      const { check } = await checked(r.xml);
      hub.broadcast(d.id, { type: 'draft', xml: r.xml, draft: r.draft, check, by: `${user.name} (via Claude)`, label: `Retour à la version ${r.version.version}`, source: 'mcp' });
      return text(`Brouillon remis à la version ${r.version.version} (${r.version.message}).`);
    });

    server.registerTool('create_diagram', {
      title: 'Créer un diagramme',
      description: 'Crée un diagramme vide (un événement de début) et renvoie son adresse.',
      inputSchema: { name: z.string().min(1).max(200) }
    }, async ({ name }) => {
      const d = await diagrams.create({ name, user });
      return text(`Diagramme « ${d.name} » créé [id ${d.id}] : ${url(d.id)}`);
    });

    server.registerTool('duplicate_diagram', {
      title: 'Dupliquer un diagramme',
      description: 'Copie un diagramme sous un nouveau nom, avec son propre historique ; renvoie l\'adresse de la copie. Par défaut son état de travail courant (brouillon compris) ; avec version (numéro, voir history), une ancienne version enregistrée, pour la retravailler à part sans la restaurer. À faire seulement quand l\'utilisateur le demande.',
      inputSchema: { diagram: z.string().describe('Identifiant ou nom du diagramme à copier'), name: z.string().max(200).optional().describe('Nom de la copie (par défaut « <nom> (copie) »)'), version: z.union([z.number().int().positive(), z.string()]).optional().describe('Numéro de version à copier (par défaut : l\'état courant)') }
    }, async ({ diagram, name, version }) => {
      const d = find(diagram);
      if (!d) return text(`Diagramme « ${diagram} » introuvable.`);
      const c = await diagrams.duplicate(d.id, { name, user, version });
      if (c?.error) return text(c.error);
      return text(`Copie « ${c.name} » créée [id ${c.id}] : ${url(c.id)}`);
    });

    // ---------- suppression : seulement si un dépôt Git distant est branché (historique récupérable) ----------
    if (gitConnected) {
      server.registerTool('delete_diagram', {
        title: 'Supprimer un diagramme',
        description: 'Supprime un diagramme de l\'éditeur (son fichier est retiré du dépôt Git par un commit « Suppression » ; l\'historique reste dans Git, d\'où le diagramme peut être récupéré). Réservé aux administrateurs, et seulement disponible parce qu\'un dépôt Git distant est branché. Le brouillon non enregistré est perdu. Ne l\'appelez avec confirm: true qu\'après que l\'utilisateur a explicitement confirmé, en lui ayant rappelé le nom du diagramme ; sans confirm, l\'appel ne supprime rien et décrit ce qui serait perdu.',
        inputSchema: { diagram: z.string().describe('Identifiant ou nom du diagramme'), confirm: z.boolean().describe('true seulement après confirmation explicite de l\'utilisateur') }
      }, async ({ diagram, confirm }) => {
        const u = db.userById(user.id);
        if (!(u?.role === 'admin' && u.status === 'active')) return fail('La suppression d\'un diagramme est réservée aux administrateurs.');
        const d = find(diagram);
        if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
        const locked = guardLock(d); if (locked) return fail(locked);
        const st = await diagrams.draftState(d.id);
        const open = hub.openBy(d.id).filter(n => n !== user.name);
        if (confirm !== true) {
          return text([
            `Rien n'a été supprimé. Demandez d'abord confirmation : supprimer « ${d.name} » [id ${d.id}] ?`,
            st.dirty ? '⚠ Le brouillon contient des modifications non enregistrées : elles seraient perdues (save_version d\'abord si elles comptent).' : 'Le brouillon est identique à la dernière version enregistrée.',
            open.length ? `⚠ Actuellement ouvert par : ${open.join(', ')}.` : '',
            'Le fichier serait retiré du dépôt Git mais reste récupérable dans son historique.',
            'Puis rappelez delete_diagram avec confirm: true.'
          ].filter(Boolean).join('\n'));
        }
        try {
          const ok = await diagrams.remove(d.id, user);
          if (!ok) return fail(`Diagramme « ${d.name} » introuvable.`);
        } catch (e) { return fail(`Suppression impossible : ${e.message}`); }
        logActivity(user, { diagramId: d.id, kind: 'delete', via: 'claude', name: d.name });
        return text(`Diagramme « ${d.name} » supprimé${st.dirty ? ' (brouillon non enregistré perdu)' : ''}. Il reste récupérable dans l'historique Git du dépôt (${git.subdir}/).`);
      });
    }

    // ---------- administration des comptes : seulement pour un compte administrateur ----------
    if (accounts && db.userById(user.id)?.role === 'admin') {
      const STATUS = { pending: 'en attente de validation', active: 'actif', disabled: 'désactivé' };
      /** Revérifie le rôle à chaque appel (il a pu être retiré depuis l'ouverture de la session). */
      const admin = () => { const u = db.userById(user.id); return u?.role === 'admin' && u.status === 'active' ? u : null; };
      const notAdmin = () => text('Votre compte n\'a plus les droits d\'administration.');
      const findUser = ref => {
        const all = db.listUsers(), r = String(ref || '').trim().toLowerCase();
        return all.find(u => u.id === ref) || all.find(u => u.email.toLowerCase() === r) || all.find(u => u.name.toLowerCase() === r) || null;
      };
      const findInvite = ref => { const all = db.listInvitations(), r = String(ref || '').trim().toLowerCase(); return all.find(i => i.id === ref) || all.find(i => i.email.toLowerCase() === r) || null; };
      const fmtDay = ms => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      const linkOf = inv => `${baseUrl}/invite/${inv.token}`;

      server.registerTool('list_users', {
        title: 'Lister les comptes',
        description: 'Administration : comptes (nom, e-mail, rôle, statut) et invitations en attente.',
        inputSchema: {}
      }, async () => {
        if (!admin()) return notAdmin();
        const users = accounts.listUsers();
        const invites = accounts.listInvitations();
        return text([
          `Comptes (${users.length}) :`,
          ...users.map(u => `- ${u.name} <${u.email}> · ${u.role === 'admin' ? 'administrateur' : 'utilisateur'} · ${STATUS[u.status]}${u.id === user.id ? ' · vous' : ''} [id ${u.id}]`),
          invites.length ? `Invitations en attente (${invites.length}) :` : 'Aucune invitation en attente.',
          ...invites.map(i => `- ${i.email}${i.name ? ` (${i.name})` : ''} · ${i.expired ? 'lien expiré' : `valable jusqu'au ${fmtDay(i.expiresAt)}`} [id ${i.id}]`)
        ].join('\n'));
      });

      server.registerTool('invite_user', {
        title: 'Inviter quelqu\'un',
        description: `Administration : crée un lien d'invitation à usage unique (${7} jours) pour un e-mail. La personne choisit son mot de passe en l'ouvrant ; son identifiant sera cet e-mail. Donnez le lien à l'utilisateur pour qu'il le transmette lui-même : il n'est affiché qu'une fois. À faire seulement quand l'utilisateur le demande.`,
        inputSchema: { email: z.string().max(200), name: z.string().max(80).optional().describe('Nom affiché proposé (facultatif)') }
      }, async ({ email, name }) => {
        const a = admin(); if (!a) return notAdmin();
        const r = accounts.invite(a, { email, name });
        if (r.error) return text(r.error);
        return text(`Invitation créée pour ${r.invitation.email}, valable jusqu'au ${fmtDay(r.invitation.expiresAt)} :\n${linkOf(r.invitation)}\n(Lien à usage unique, affiché une seule fois ; une nouvelle invitation pour la même adresse annule celle-ci.)`);
      });

      server.registerTool('manage_invitation', {
        title: 'Renouveler ou annuler une invitation',
        description: 'Administration : "renew" crée un nouveau lien (l\'ancien ne marche plus), "cancel" annule l\'invitation. invitation = e-mail ou identifiant.',
        inputSchema: { invitation: z.string(), action: z.enum(['renew', 'cancel']) }
      }, async ({ invitation, action }) => {
        if (!admin()) return notAdmin();
        const inv = findInvite(invitation);
        if (!inv) return text(`Aucune invitation en attente pour « ${invitation} ».`);
        if (action === 'cancel') { const r = accounts.cancelInvitation(inv.id); return text(r.error || `Invitation de ${inv.email} annulée : son lien ne fonctionne plus.`); }
        const r = accounts.renewInvitation(inv.id);
        return text(r.error || `Nouveau lien pour ${inv.email}, valable jusqu'au ${fmtDay(r.invitation.expiresAt)} :\n${linkOf(r.invitation)}`);
      });

      server.registerTool('update_user', {
        title: 'Modifier un compte',
        description: 'Administration : valider (status "active"), désactiver ("disabled") ou réactiver un compte ; rendre administrateur (role "admin") ou retirer ce rôle ("user"). user = e-mail, nom ou identifiant. À faire seulement quand l\'utilisateur le demande.',
        inputSchema: { user: z.string(), status: z.enum(['active', 'disabled']).optional(), role: z.enum(['user', 'admin']).optional() }
      }, async ({ user: ref, status, role }) => {
        const a = admin(); if (!a) return notAdmin();
        if (!status && !role) return text('Indiquez status ou role.');
        const t = findUser(ref);
        if (!t) return text(`Compte « ${ref} » introuvable (voir list_users).`);
        const r = accounts.updateUser(a, t.id, { status, role });
        if (r.error) return text(r.error);
        return text(`${r.user.name} <${r.user.email}> : ${r.user.role === 'admin' ? 'administrateur' : 'utilisateur'}, ${STATUS[r.user.status]}.`);
      });

      server.registerTool('delete_user', {
        title: 'Supprimer un compte',
        description: 'Administration : supprime un compte (ses contributions restent dans l\'historique Git). Irréversible : ne l\'appelez qu\'après que l\'utilisateur a explicitement confirmé, en lui ayant rappelé le nom et l\'e-mail du compte, et passez alors confirm: true.',
        inputSchema: { user: z.string(), confirm: z.boolean().describe('true seulement après confirmation explicite de l\'utilisateur') }
      }, async ({ user: ref, confirm }) => {
        const a = admin(); if (!a) return notAdmin();
        const t = findUser(ref);
        if (!t) return text(`Compte « ${ref} » introuvable (voir list_users).`);
        if (confirm !== true) return text(`Rien n'a été supprimé. Demandez d'abord confirmation : supprimer ${t.name} <${t.email}> ? Puis rappelez delete_user avec confirm: true.`);
        const r = accounts.deleteUser(a, t.id);
        return text(r.error || `Compte de ${t.name} <${t.email}> supprimé. Ses contributions restent dans l'historique Git.`);
      });
    }

    return server;
  }

  /** Traite une requête HTTP MCP (route Fastify, réponse détournée). */
  async function handle(req, reply, user, baseUrl) {
    const server = build(user, baseUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  return { handle };
}
