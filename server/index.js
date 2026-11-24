import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from './app.js';
import { redact } from './git.js';

const env = process.env;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = env.DATA_DIR || join(root, 'data');

if (!env.ADMIN_PASSWORD) {
  console.warn('[bpmn-editor] ADMIN_PASSWORD non défini : aucun compte administrateur ne sera créé ou mis à jour au démarrage.');
} else {
  // Diagnostic sans révéler le secret : pièges fréquents des interfaces de variables d'environnement.
  const pw = env.ADMIN_PASSWORD;
  if (pw !== pw.trim()) console.warn('[bpmn-editor] ADMIN_PASSWORD commence ou finit par un espace : il fait partie du mot de passe.');
  if (/^(["']).*\1$/.test(pw)) console.warn('[bpmn-editor] ADMIN_PASSWORD est entouré de guillemets : ils font partie du mot de passe.');
}

const trust = env.TRUST_PROXY;
const app = await buildApp({
  dbFile: env.DATABASE_FILE || join(dataDir, 'bpmn.sqlite'),
  gitDir: env.GIT_DIR || join(dataDir, 'repo'),
  gitRemote: env.GIT_REMOTE_URL || null,
  gitBranch: env.GIT_BRANCH || 'main',
  gitSubdir: env.GIT_SUBDIR || 'diagrams',
  gitSyncSeconds: env.GIT_SYNC_INTERVAL ? Number(env.GIT_SYNC_INTERVAL) : 300,
  webRoot: env.WEB_ROOT || join(root, 'dist'),
  publicUrl: env.PUBLIC_URL || null,
  admin: { email: env.ADMIN_EMAIL || 'admin', password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME || 'Administrateur' },
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.COOKIE_SECURE === 'true' ? true : env.COOKIE_SECURE === 'false' ? false : 'auto',
  trustProxy: trust ? (trust === 'true' ? true : trust === 'false' ? false : trust) : true,
  aiRateLimit: env.AI_RATE_LIMIT_PER_HOUR ? Number(env.AI_RATE_LIMIT_PER_HOUR) : undefined,
  ai: {
    provider: env.LLM_PROVIDER || 'anthropic',
    apiKey: env.LLM_API_KEY || env.ANTHROPIC_API_KEY,
    model: env.LLM_MODEL,
    baseUrl: env.LLM_BASE_URL,
    timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined
  },
  logger: { level: env.LOG_LEVEL || 'warn' }
});

const port = Number(env.PORT || 3000);
await app.listen({ port, host: env.LISTEN_HOST || '0.0.0.0' });
console.log(`[bpmn-editor] en écoute sur le port ${port}`
  + ` · administrateur : ${env.ADMIN_PASSWORD ? `« ${env.ADMIN_EMAIL || 'admin'} » (mot de passe de ${env.ADMIN_PASSWORD.length} caractères)` : 'non configuré'}`
  + ` · dépôt Git : ${env.GIT_REMOTE_URL ? redact(env.GIT_REMOTE_URL) : 'local uniquement'}`
  + (env.LLM_API_KEY || env.ANTHROPIC_API_KEY || env.LLM_BASE_URL ? ' · assistant IA activé' : ''));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
