// Le texte tient-il dans la boîte ? Les tâches ont une taille fixe (100 × 80) : au-delà de
// 5 lignes, le texte déborde. Estimation par largeur de caractères (Arial 12 px, marge de 7 px, comme bpmn-js),
// avec le même retour à la ligne par mots ; utilisable côté serveur comme dans le navigateur.

// largeurs Arial (unités pour 1000), comme le rendu de bpmn-js (Arial 12 px)
const ARIAL = {
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  ' ': 278, '.': 278, ',': 278, ':': 278, ';': 278, "'": 191, '’': 222, '(': 333, ')': 333, '[': 278, ']': 278, '-': 333, '–': 556, '—': 1000, '?': 556, '!': 278, '€': 556, '%': 889, '&': 667, '/': 278, '<': 584, '>': 584, '=': 584, '+': 584, '«': 556, '»': 556, '"': 355, '@': 1015, '_': 556
};
const base = ch => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '')[0] || ch;
const charWidth = (ch, size = 12) => ((ARIAL[ch] ?? ARIAL[base(ch)] ?? 556) * size) / 1000;
const width = (s, size) => [...s].reduce((w, ch) => w + charWidth(ch, size), 0);
const LINE_HEIGHT = 14.4;

/** Nombre de lignes du texte coupé par mots dans une largeur donnée. */
export function lineCount(text, maxWidth, size = 12) {
  let lines = 0;
  for (const para of String(text || '').split(/\r?\n/)) {
    let cur = 0;
    lines++;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = width(word, size);
      const add = cur ? width(' ', size) + w : w;
      if (cur && cur + add > maxWidth) { lines++; cur = 0; }
      // mot plus long que la ligne : il se coupe
      while (w > maxWidth) { lines++; w -= maxWidth; }
      cur += cur ? width(' ', size) + w : w;
    }
  }
  return lines;
}

/** Types dont le nom s'affiche dans la boîte. */
const BOXED = /^bpmn:(Task|UserTask|ServiceTask|ScriptTask|SendTask|ReceiveTask|ManualTask|BusinessRuleTask|CallActivity|SubProcess|Transaction|AdHocSubProcess)$/;

/**
 * Vérifie le nom d'un élément dont on connaît le type (et la taille, par défaut 100 × 80).
 * Renvoie null si ça tient, sinon { lines, maxLines, length, suggest } (suggest = longueur visée).
 */
export function labelOverflow(type, name, { width: w = 100, height: h = 80, expanded = false } = {}) {
  if (!name || expanded || !BOXED.test(type)) {
    // libellés externes (événements, passerelles) : 90 px de large, 4 lignes au plus
    if (!name || BOXED.test(type) || !/Event$|Gateway$/.test(type)) return null;
    const lines = lineCount(name, 90, 11), maxLines = 4;
    return lines > maxLines ? { lines, maxLines, length: name.length, suggest: Math.floor(name.length * maxLines / lines) - 3 } : null;
  }
  // bpmn-js : marge intérieure de 7 px à gauche et à droite, texte centré verticalement
  const maxLines = Math.max(1, Math.floor(h / LINE_HEIGHT));
  const lines = lineCount(name, w - 14);
  return lines > maxLines ? { lines, maxLines, length: name.length, suggest: Math.floor(name.length * maxLines / lines) - 3 } : null;
}

export const overflowText = o => `texte trop long pour la boîte : ${o.lines} lignes pour ${o.maxLines} possibles (${o.length} caractères).`;
export const overflowFix = o => `Raccourcissez le nom à ${o.suggest} caractères environ et mettez le détail dans la documentation de l'élément (panneau Propriétés).`;
