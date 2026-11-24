// Client HTTP de l'API. Le jeton de partage, s'il existe, est envoyé dans un en-tête.
let shareToken = null;
export const setShareToken = t => { shareToken = t; };
export const getShareToken = () => shareToken;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Erreur ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (shareToken) headers['x-share-token'] = shareToken;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  config: () => request('GET', '/api/config'),
  login: password => request('POST', '/api/login', { password }),
  logout: () => request('POST', '/api/logout', {}),
  list: () => request('GET', '/api/diagrams'),
  create: (name, xml) => request('POST', '/api/diagrams', { name, xml }),
  get: id => request('GET', `/api/diagrams/${id}`),
  rename: (id, name) => request('PATCH', `/api/diagrams/${id}`, { name }),
  remove: id => request('DELETE', `/api/diagrams/${id}`),
  save: (id, body) => request('PUT', `/api/diagrams/${id}`, body),
  lock: (id, holder, author) => request('POST', `/api/diagrams/${id}/lock`, { holder, author }),
  unlock: (id, holder) => request('POST', `/api/diagrams/${id}/unlock`, { holder }),
  forceUnlock: id => request('POST', `/api/diagrams/${id}/unlock`, { force: true }),
  unlockBeacon(id, holder) {
    const blob = new Blob([JSON.stringify({ holder, shareToken })], { type: 'application/json' });
    navigator.sendBeacon?.(`/api/diagrams/${id}/unlock`, blob);
  },
  versions: id => request('GET', `/api/diagrams/${id}/versions`),
  version: (id, v) => request('GET', `/api/diagrams/${id}/versions/${v}`),
  shares: id => request('GET', `/api/diagrams/${id}/shares`),
  share: (id, role, label) => request('POST', `/api/diagrams/${id}/shares`, { role, label }),
  revoke: (id, token) => request('DELETE', `/api/diagrams/${id}/shares/${token}`),
  resolveShare: token => request('GET', `/api/shares/${token}`),
  ai: (id, xml, turns) => request('POST', `/api/diagrams/${id}/ai`, { xml, turns })
};
