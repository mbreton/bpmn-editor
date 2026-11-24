// Petits utilitaires DOM. Toute donnée externe passe par esc() ou textContent.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const fmtDate = t => t ? new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
export const fmtTime = t => t ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';

let toastTimer;
export function toast(msg, kind = 'info') {
  let el = $('#toast');
  if (!el) { el = h('<div id="toast" role="status" aria-live="polite"></div>'); document.body.append(el); }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6000 : 3500);
}

/** Boîte de dialogue modale. buttons: [{label, value, primary, danger}] → Promise<value|null> */
export function dialog({ title, body = '', input, buttons }) {
  return new Promise(resolve => {
    const el = h(`<div class="modal" role="dialog" aria-modal="true"><div class="modal-box">
      <h2></h2><div class="modal-body"></div>
      ${input ? `<input class="field" type="${input.type || 'text'}" autocomplete="${input.autocomplete || 'off'}">` : ''}
      <div class="modal-actions"></div></div></div>`);
    $('h2', el).textContent = title;
    const bodyEl = $('.modal-body', el);
    if (body instanceof Node) bodyEl.append(body); else bodyEl.textContent = body;
    const field = $('input', el);
    if (field) { field.value = input.value || ''; field.placeholder = input.placeholder || ''; }
    const actions = $('.modal-actions', el);
    const close = v => { el.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    for (const b of buttons) {
      const btn = h(`<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}"></button>`);
      btn.textContent = b.label;
      btn.addEventListener('click', () => close(b.value === '$input' ? field.value : b.value));
      actions.append(btn);
    }
    const onKey = e => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && field && document.activeElement === field) {
        const p = buttons.find(b => b.primary);
        if (p) close(p.value === '$input' ? field.value : p.value);
      }
    };
    document.addEventListener('keydown', onKey);
    el.addEventListener('click', e => { if (e.target === el) close(null); });
    document.body.append(el);
    (field || actions.querySelector('.primary') || actions.lastChild).focus();
  });
}

export function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h(`<a download></a>`);
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFilename = s => String(s || 'diagramme').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'diagramme';
