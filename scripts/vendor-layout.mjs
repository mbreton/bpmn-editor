// Génère server/vendor/auto-layout.js : bpmn-auto-layout (version épinglée) avec des espacements
// plus serrés. La bibliothèque n'expose pas ses espacements en option ; on remplace ses constantes.
// Usage : node scripts/vendor-layout.mjs   (à relancer après une mise à jour de bpmn-auto-layout)
import { readFileSync, writeFileSync } from 'node:fs';

export const SPACING = {
  HORIZONTAL_GAP: 50,        // 100 : écart horizontal entre deux éléments
  VERTICAL_GAP: 40,          // 80 : écart vertical entre deux branches
  OUTER_MARGIN: 40,          // 80 : marge autour du diagramme
  SUB_PROCESS_PADDING: 25,   // 40 : marge intérieure d'un sous-processus déplié
  LANE_CONTENT_PADDING: 25   // 40 : marge intérieure d'un couloir
};

const pkgDir = new URL('../node_modules/bpmn-auto-layout/', import.meta.url).pathname;
const version = JSON.parse(readFileSync(pkgDir + 'package.json', 'utf8')).version;
let src = readFileSync(pkgDir + 'dist/index.js', 'utf8');
for (const [name, value] of Object.entries(SPACING)) {
  const re = new RegExp(`const ${name} = \\d+;`);
  if (!re.test(src)) throw new Error(`constante ${name} introuvable dans bpmn-auto-layout ${version}`);
  src = src.replace(re, `const ${name} = ${value};`);
}
writeFileSync(new URL('../server/vendor/auto-layout.js', import.meta.url),
  `// Généré par scripts/vendor-layout.mjs depuis bpmn-auto-layout ${version} (espacements resserrés). Ne pas modifier à la main.\n` + src);
console.log(`server/vendor/auto-layout.js généré (bpmn-auto-layout ${version})`, SPACING);
