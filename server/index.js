import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from './app.js';

const env = process.env;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!env.ADMIN_PASSWORD) {
  console.warn('[bpmn-editor] ADMIN_PASSWORD non défini : la connexion administrateur est désactivée (seuls les liens de partage existants fonctionnent).');
} else {
  // Diagnostic sans révéler le secret : pièges fréquents des interfaces de variables d'environnement.
  const pw = env.ADMIN_PASSWORD;
  if (pw !== pw.trim()) console.warn('[bpmn-editor] ADMIN_PASSWORD commence ou finit par un espace : il fait partie du mot de passe.');
  if (/^(["']).*\1$/.test(pw)) console.warn('[bpmn-editor] ADMIN_PASSWORD est entouré de guillemets : ils font partie du mot de passe.');
  console.log(`[bpmn-editor] connexion administrateur activée (mot de passe de ${pw.length} caractères).`);
}

const app = await buildApp({
  dbFile: env.DATABASE_FILE || join(root, 'data', 'bpmn.sqlite'),
  webRoot: env.WEB_ROOT || join(root, 'dist'),
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.COOKIE_SECURE === 'true' ? true : env.COOKIE_SECURE === 'false' ? false : 'auto',
  trustProxy: env.TRUST_PROXY ? (env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY) : true,
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
console.log(`[bpmn-editor] en écoute sur le port ${port}${env.LLM_API_KEY || env.ANTHROPIC_API_KEY || env.LLM_BASE_URL ? ' · assistant IA activé' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
