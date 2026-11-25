// Canal temps réel avec le serveur (WebSocket) : brouillons des autres pages, actions de Claude
// via le connecteur MCP (modifier, zoomer, explorer, produire une image). Reconnexion automatique.
export function connectLive({ diagramId, holder, onMessage, getState }) {
  let ws = null, closed = false, retry = 0, timer = null;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => { retry = 0; send({ type: 'hello', diagramId, holder }); state(); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = ev => {
      if (closed || paused || ev.code === 4401) return;
      timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** retry++));
    };
  }
  const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  const state = () => send({ type: 'state', ...getState() });
  const onFocus = () => state();
  // page quittée (ou mise en cache par le navigateur) : on part vraiment, pour que la présence soit juste ;
  // retour sur la page depuis le cache : on se reconnecte
  let paused = false;
  const onHide = () => { paused = true; clearTimeout(timer); try { ws?.close(1000, 'page quittée'); } catch { /* */ } };
  const onShow = e => { if (paused && !closed) { paused = false; if (e.persisted || ws?.readyState !== 1) open(); } };
  // signe de vie régulier : le serveur écarte les connexions muettes (onglet tué, réseau coupé)
  const beat = setInterval(() => send({ type: 'ping' }), 25e3);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onFocus);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  open();

  return {
    state,
    reply(req, body) { send({ type: 'response', reqId: req.reqId, ...body }); },
    close() {
      closed = true; clearTimeout(timer); clearInterval(beat);
      for (const [ev, fn] of [['focus', onFocus], ['blur', onFocus], ['pagehide', onHide], ['pageshow', onShow]]) window.removeEventListener(ev, fn);
      ws?.close();
    }
  };
}
