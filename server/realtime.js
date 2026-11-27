// Temps réel : les pages ouvertes sur un diagramme reçoivent les changements (brouillon, zoom,
// exploration, version enregistrée) et peuvent être sollicitées par le serveur (appliquer des
// opérations, produire une image du rendu) : c'est ainsi que le MCP agit sur l'écran de l'utilisateur.
import { randomBytes } from 'node:crypto';

export function createHub({ log = console, build = 'dev' } = {}) {
  const clients = new Set(); // { socket, user, diagramId, holder, editing, lastActive }
  const waiting = new Map(); // reqId → { resolve, timer }

  function send(c, msg) {
    try { if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg)); } catch { /* connexion fermée */ }
  }

  function attach(socket, user) {
    const c = { socket, user, diagramId: null, holder: null, editing: false, lastActive: Date.now(), since: Date.now(), claudeAt: 0 };
    clients.add(c);
    try { socket.send(JSON.stringify({ type: 'welcome', build })); } catch { /* fermé */ }
    socket.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      c.lastActive = Date.now();
      if (m.type === 'hello') { const prev = c.diagramId; c.diagramId = String(m.diagramId || ''); c.holder = String(m.holder || ''); c.since = Date.now(); if (prev && prev !== c.diagramId) presence(prev); presence(c.diagramId); }
      if (m.type === 'state') {
        const before = `${c.editing}|${c.focused}`;
        c.editing = !!m.editing; c.focused = !!m.focused;
        if (c.diagramId && before !== `${c.editing}|${c.focused}`) presence(c.diagramId);
      }
      if (m.type === 'response' && waiting.has(m.reqId)) {
        const w = waiting.get(m.reqId);
        waiting.delete(m.reqId);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    });
    socket.on('close', () => { clients.delete(c); if (c.diagramId) presence(c.diagramId); });
    socket.on('error', () => {});
  }

  const viewers = diagramId => [...clients].filter(c => c.diagramId === diagramId);

  // connexions muettes depuis plus de 70 s (onglet tué, réseau coupé, page en cache) : écartées
  const sweep = setInterval(() => {
    for (const c of [...clients]) if (Date.now() - c.lastActive > 70e3) {
      clients.delete(c);
      try { c.socket.terminate?.() ?? c.socket.close(); } catch { /* */ }
      if (c.diagramId) presence(c.diagramId);
    }
  }, 15e3);
  sweep.unref?.();

  /**
   * Qui a ce diagramme ouvert, une entrée par personne (plusieurs onglets fusionnés) : en train de
   * modifier, onglet au premier plan, depuis quand, et dernière action de Claude pour elle.
   */
  function peopleOn(diagramId) {
    const byUser = new Map();
    for (const c of viewers(diagramId)) {
      const p = byUser.get(c.user.id) || { id: c.user.id, name: c.user.name, editing: false, focused: false, since: c.since, claudeAt: 0 };
      p.editing ||= c.editing; p.focused ||= c.focused !== false; p.since = Math.min(p.since, c.since); p.claudeAt = Math.max(p.claudeAt, c.claudeAt || 0);
      byUser.set(c.user.id, p);
    }
    return [...byUser.values()];
  }
  function presence(diagramId) {
    broadcast(diagramId, { type: 'presence', people: peopleOn(diagramId) });
  }

  function broadcast(diagramId, msg, { exceptHolder } = {}) {
    for (const c of viewers(diagramId)) if (!exceptHolder || c.holder !== exceptHolder) send(c, msg);
  }

  /** Page la plus pertinente pour agir au nom de `userId` : la sienne, en édition, puis la plus récente. */
  function pick(diagramId, userId) {
    const mine = viewers(diagramId).filter(c => c.user.id === userId);
    mine.sort((a, b) => (b.editing - a.editing) || (b.focused - a.focused) || (b.lastActive - a.lastActive));
    return mine[0] || null;
  }

  /** Page la plus récemment active de `userId`, quelle qu'elle soit (liste des diagrammes ou éditeur). */
  function pickUser(userId) {
    const mine = [...clients].filter(c => c.user.id === userId && c.socket.readyState === 1);
    mine.sort((a, b) => (b.focused !== false) - (a.focused !== false) || (b.lastActive - a.lastActive));
    return mine[0] || null;
  }

  /** Envoie une demande à une page et attend sa réponse. */
  function request(diagramId, userId, payload, timeoutMs = 20000) {
    return ask(pick(diagramId, userId), diagramId, payload, timeoutMs);
  }

  /** Demande à la page la plus active de la personne (ouvrir un diagramme, par exemple). */
  function requestUser(userId, payload, timeoutMs = 10000) {
    const c = pickUser(userId);
    return ask(c, c?.diagramId || '', payload, timeoutMs);
  }

  function ask(c, diagramId, payload, timeoutMs) {
    if (!c) return Promise.resolve(null);
    const reqId = randomBytes(8).toString('hex');
    // Claude agit pour cette personne : les autres le voient dans la présence
    const first = !c.claudeAt || Date.now() - c.claudeAt > 60e3;
    c.claudeAt = Date.now();
    if (first && diagramId) presence(diagramId);
    return new Promise(resolve => {
      const timer = setTimeout(() => { waiting.delete(reqId); resolve({ ok: false, error: 'La page n\'a pas répondu à temps.' }); }, timeoutMs);
      waiting.set(reqId, { resolve, timer });
      send(c, { ...payload, reqId });
    });
  }

  return {
    attach, broadcast, request, requestUser,
    isOpen: (diagramId, userId) => !!pick(diagramId, userId),
    openBy: diagramId => [...new Set(viewers(diagramId).map(c => c.user.name))],
    peopleOn,
    /** Toutes les personnes connectées en temps réel, et le diagramme ouvert. */
    online: () => {
      const seen = new Map();
      for (const c of clients) {
        const k = `${c.user.id}|${c.diagramId || ''}`;
        const o = seen.get(k) || { userId: c.user.id, name: c.user.name, diagramId: c.diagramId || null, editing: false, since: c.since };
        o.editing ||= c.editing; o.since = Math.min(o.since, c.since);
        seen.set(k, o);
      }
      return [...seen.values()];
    },
    close() { clearInterval(sweep); for (const c of clients) try { c.socket.close(); } catch { /* */ } clients.clear(); }
  };
}
