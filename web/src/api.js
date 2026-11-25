// Client HTTP de l'API (session par cookie).
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Erreur ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

let onUnauthorized = null;
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (res.status === 401 && onUnauthorized && !url.startsWith('/api/login')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  config: () => request('GET', '/api/config'),
  register: (name, email, password) => request('POST', '/api/register', { name, email, password }),
  login: (email, password) => request('POST', '/api/login', { email, password }),
  logout: () => request('POST', '/api/logout', {}),
  updateMe: fields => request('PATCH', '/api/me', fields),
  users: () => request('GET', '/api/users'),
  updateUser: (id, fields) => request('PATCH', `/api/users/${id}`, fields),
  deleteUser: id => request('DELETE', `/api/users/${id}`),
  gitStatus: () => request('GET', '/api/admin/git'),
  gitSync: () => request('POST', '/api/admin/git/sync', {}),
  list: () => request('GET', '/api/diagrams'),
  create: (name, xml) => request('POST', '/api/diagrams', { name, xml }),
  get: id => request('GET', `/api/diagrams/${id}`),
  rename: (id, name) => request('PATCH', `/api/diagrams/${id}`, { name }),
  duplicate: (id, name) => request('POST', `/api/diagrams/${id}/duplicate`, { name }),
  remove: id => request('DELETE', `/api/diagrams/${id}`),
  draft: (id, body) => request('PUT', `/api/diagrams/${id}/draft`, body),
  undo: (id, holder) => request('POST', `/api/diagrams/${id}/undo`, { holder }),
  redo: (id, holder) => request('POST', `/api/diagrams/${id}/redo`, { holder }),
  layout: (id, holder) => request('POST', `/api/diagrams/${id}/layout`, { holder }),
  commit: (id, message) => request('POST', `/api/diagrams/${id}/commit`, { message }),
  restore: (id, sha, holder) => request('POST', `/api/diagrams/${id}/restore`, { sha, holder }),
  connections: () => request('GET', '/api/me/connections'),
  revokeConnection: clientId => request('DELETE', `/api/me/connections/${clientId}`),
  lock: (id, holder) => request('POST', `/api/diagrams/${id}/lock`, { holder }),
  unlock: (id, holder) => request('POST', `/api/diagrams/${id}/unlock`, { holder }),
  forceUnlock: id => request('POST', `/api/diagrams/${id}/unlock`, { force: true }),
  unlockBeacon(id, holder) {
    const blob = new Blob([JSON.stringify({ holder })], { type: 'application/json' });
    navigator.sendBeacon?.(`/api/diagrams/${id}/unlock`, blob);
  },
  versions: id => request('GET', `/api/diagrams/${id}/versions`),
  version: (id, sha) => request('GET', `/api/diagrams/${id}/versions/${sha}`)
};
