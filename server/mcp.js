// Serveur MCP (Streamable HTTP, sans état) : Claude lit les diagrammes, les modifie dans le
// brouillon de la personne connectée, les montre à l'écran et les explore. Les modifications passent
// par la page ouverte dans le navigateur, où elles s'affichent en direct.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BpmnModdle } from 'bpmn-moddle';
import { OPS_SPEC } from './ai.js';
import { summarize } from '../shared/summary.js';
import { createWalker } from '../shared/pathwalker.js';

const moddle = new BpmnModdle();
const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });
const fmt = t => t ? new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) : '';

export function createMcp({ db, diagrams, hub, version = '1.0.0' }) {
  const explorations = new Map(); // `${userId}:${diagramId}` → [optionId…]

  function build(user, baseUrl) {
    const server = new McpServer({ name: 'editeur-bpmn', version }, {
      instructions: `Éditeur BPMN de ${user.name}. Les modifications vont dans le brouillon du diagramme (sauvegardé en continu, annulable avec undo) et s'affichent en direct dans le navigateur de l'utilisateur ; elles ne deviennent une version Git qu'avec save_version, à faire seulement quand l'utilisateur le demande. Commencez par list_diagrams puis get_diagram. Utilisez show pour zoomer sur ce dont vous parlez, view_diagram pour vérifier le rendu après une modification, explore pour vérifier qu'un parcours se comporte comme l'utilisateur l'attend. Répondez en français.`
    });
    const url = id => `${baseUrl}/d/${id}`;

    const find = idOrName => {
      const all = db.listDiagrams();
      return all.find(d => d.id === idOrName) || all.find(d => d.name.toLowerCase() === String(idOrName).toLowerCase())
        || all.filter(d => d.name.toLowerCase().includes(String(idOrName).toLowerCase())).at(0) || null;
    };
    const guardLock = d => (d.lock && d.lock.userId !== user.id) ? `${d.lock.author} est en train de modifier « ${d.name} » : je ne peux pas y toucher pour l'instant.` : null;
    const notOpen = d => `« ${d.name} » n'est ouvert dans aucun de vos navigateurs. Ouvrez ${url(d.id)} pour que je puisse agir à l'écran.`;

    async function model(xml) { return (await moddle.fromXML(xml, 'bpmn:Definitions')).rootElement; }

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
      description: 'Contenu du brouillon courant d\'un diagramme : éléments avec identifiants, types, noms, événements (délais ISO 8601, erreurs, messages), événements de bordure, flux avec conditions, sous-processus, et problèmes de cohérence détectés. format "xml" renvoie le BPMN brut.',
      inputSchema: { diagram: z.string().describe('Identifiant ou nom du diagramme'), format: z.enum(['summary', 'xml']).optional() }
    }, async ({ diagram, format }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const full = await diagrams.get(d.id);
      if (format === 'xml') return text(full.xml);
      const { text: body, issues } = summarize(await model(full.xml));
      const open = hub.openBy(d.id);
      return text([
        `« ${d.name} » [id ${d.id}] · version enregistrée v${full.version}${full.draft.dirty ? ' · brouillon modifié depuis' : ''}${d.lock ? ` · ${d.lock.author} est en mode édition` : ''}`,
        open.length ? `Ouvert à l'écran par : ${open.join(', ')}` : `Ouvert par personne (${url(d.id)})`,
        '', body, '',
        issues.length ? `Problèmes de cohérence :\n${issues.map(i => `- ${i}`).join('\n')}` : 'Aucun problème de cohérence détecté.'
      ].join('\n'));
    });

    server.registerTool('view_diagram', {
      title: 'Voir le rendu',
      description: 'Image (PNG) du diagramme tel qu\'il s\'affiche dans le navigateur de l\'utilisateur : area "screen" pour ce qu\'il voit actuellement, "all" pour le diagramme entier. Nécessite que le diagramme soit ouvert dans son navigateur.',
      inputSchema: { diagram: z.string(), area: z.enum(['screen', 'all']).optional() }
    }, async ({ diagram, area }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const r = await hub.request(d.id, user.id, { type: 'render', area: area || 'all' });
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
      const r = await hub.request(d.id, user.id, { type: 'apply', changes }, 30000);
      if (!r) return fail(notOpen(d));
      if (!r.ok) return fail(r.error || 'Modification impossible.');
      const lines = r.results.map(x => x.ok ? `✓ ${x.title}${x.added?.length ? ` (ajoutés : ${x.added.join(', ')})` : ''}` : `✗ ${x.title} : ${x.error}`);
      const after = await diagrams.get(d.id);
      const { issues } = summarize(await model(after.xml));
      return text(`${lines.join('\n')}\n\nBrouillon enregistré (annulable avec undo).${issues.length ? `\nProblèmes de cohérence :\n${issues.map(i => `- ${i}`).join('\n')}` : ''}`);
    });

    const stepTool = (name, title, delta, description) => server.registerTool(name, {
      title, description, inputSchema: { diagram: z.string(), steps: z.number().int().min(1).max(20).optional() }
    }, async ({ diagram, steps = 1 }) => {
      const d = find(diagram);
      if (!d) return fail(`Diagramme « ${diagram} » introuvable.`);
      const locked = guardLock(d); if (locked) return fail(locked);
      const done = [];
      let last = null;
      for (let i = 0; i < steps; i++) {
        const r = await diagrams.step(d.id, delta);
        if (!r) break;
        last = r;
        done.push(r.step?.label || 'modification');
      }
      if (!last) return fail(delta < 0 ? 'Rien à annuler.' : 'Rien à rétablir.');
      hub.broadcast(d.id, { type: 'draft', xml: last.xml, draft: last.draft, by: `${user.name} (via Claude)`, label: `${delta < 0 ? 'Annulé' : 'Rétabli'} : ${done.join(' ; ')}`, source: 'mcp' });
      return text(`${delta < 0 ? 'Annulé' : 'Rétabli'} : ${done.join(' ; ')}.`);
    });
    stepTool('undo', 'Annuler', -1, 'Annule la ou les dernières modifications du brouillon (celles de Claude comme celles faites à l\'écran).');
    stepTool('redo', 'Rétablir', 1, 'Rétablit une modification annulée.');

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
      hub.broadcast(d.id, { type: 'draft', xml: r.xml, draft: r.draft, by: `${user.name} (via Claude)`, label: `Retour à la version ${r.version.version}`, source: 'mcp' });
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
