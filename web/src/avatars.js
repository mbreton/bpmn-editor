// Pastilles de présence (comme Google Drive) : initiales sur une couleur propre à chaque personne.
import { esc } from './dom.js';

const hue = id => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
export const initials = name => {
  const parts = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : (parts[0]?.[1] || ''))).toUpperCase();
};
export const colorOf = id => `hsl(${hue(id)} 62% 42%)`;

const CLAUDE_MS = 60e3;
/** Libellé d'état d'une personne. */
export function stateOf(p, now = Date.now()) {
  const claude = p.claudeAt && now - p.claudeAt < CLAUDE_MS;
  return [p.editing ? 'modifie le diagramme' : 'consulte le diagramme', p.focused === false ? 'onglet en arrière-plan' : null, claude ? 'Claude agit pour cette personne' : null].filter(Boolean).join(' · ');
}

/** HTML d'une pile de pastilles ; max pastilles, puis « +N ». */
export function avatarStack(people, { max = 4, size = 28, title = '' } = {}) {
  if (!people?.length) return '';
  const now = Date.now();
  const shown = people.slice(0, max), rest = people.length - shown.length;
  const one = p => {
    const claude = p.claudeAt && now - p.claudeAt < CLAUDE_MS;
    const cls = ['av', p.editing ? 'editing' : '', p.focused === false ? 'away' : '', claude ? 'claude' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" style="--av:${colorOf(p.id)};--sz:${size}px" title="${esc(p.name)} — ${esc(stateOf(p, now))}" aria-label="${esc(p.name)}">${esc(initials(p.name))}${claude ? '<i class="av-claude" aria-hidden="true">✦</i>' : ''}</span>`;
  };
  return `<span class="av-stack" ${title ? `title="${esc(title)}"` : ''}>${shown.map(one).join('')}${rest > 0 ? `<span class="av more" style="--sz:${size}px" title="${esc(people.slice(max).map(p => p.name).join(', '))}">+${rest}</span>` : ''}</span>`;
}
