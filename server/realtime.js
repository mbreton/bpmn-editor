// Temps réel : les pages ouvertes sur un diagramme reçoivent les changements (brouillon, zoom,
// exploration, version enregistrée) et peuvent être sollicitées par le serveur (appliquer des
// opérations, produire une image du rendu) : c'est ainsi que le MCP agit sur l'écran de l'utilisateur.
import { randomBytes } from 'node:crypto';

export function createHub({ log = console } = {}) {
  const clients = new Set(); // { socket, user, diagramId, holder, editing, lastActive }
  const waiting = new Map(); // reqId → { resolve, timer }

  function send(c, msg) {
    try { if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg)); } catch { /* connexion fermée */ }
  }

  function attach(socket, user) {
    const c = { socket, user, diagramId: null, holder: null, editing: false, lastActive: Date.now() };
    clients.add(c);
    socket.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      c.lastActive = Date.now();
      if (m.type === 'hello') { c.diagramId = String(m.diagramId || ''); c.holder = String(m.holder || ''); presence(c.diagramId); }
      if (m.type === 'state') { c.editing = !!m.editing; c.focused = !!m.focused; }
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

  function presence(diagramId) {
    const people = [...new Map(viewers(diagramId).map(c => [c.user.id, { id: c.user.id, name: c.user.name }])).values()];
    broadcast(diagramId, { type: 'presence', people });
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

  /** Envoie une demande à une page et attend sa réponse. */
  function request(diagramId, userId, payload, timeoutMs = 20000) {
    const c = pick(diagramId, userId);
    if (!c) return Promise.resolve(null);
    const reqId = randomBytes(8).toString('hex');
    return new Promise(resolve => {
      const timer = setTimeout(() => { waiting.delete(reqId); resolve({ ok: false, error: 'La page n\'a pas répondu à temps.' }); }, timeoutMs);
      waiting.set(reqId, { resolve, timer });
      send(c, { ...payload, reqId });
    });
  }

  return {
    attach, broadcast, request,
    isOpen: (diagramId, userId) => !!pick(diagramId, userId),
    openBy: diagramId => [...new Set(viewers(diagramId).map(c => c.user.name))],
    close() { for (const c of clients) try { c.socket.close(); } catch { /* */ } clients.clear(); }
  };
}
