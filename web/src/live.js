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
      if (closed || ev.code === 4401) return;
      timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** retry++));
    };
  }
  const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  const state = () => send({ type: 'state', ...getState() });
  const onFocus = () => state();
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onFocus);
  open();

  return {
    state,
    reply(req, body) { send({ type: 'response', reqId: req.reqId, ...body }); },
    close() { closed = true; clearTimeout(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onFocus); ws?.close(); }
  };
}
