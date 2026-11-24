import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from './app.js';

const env = process.env;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!env.ADMIN_PASSWORD) {
  console.warn('[bpmn-editor] ADMIN_PASSWORD non défini : la connexion administrateur est désactivée (seuls les liens de partage existants fonctionnent).');
}

const app = await buildApp({
  dbFile: env.DATABASE_FILE || join(root, 'data', 'bpmn.sqlite'),
  webRoot: env.WEB_ROOT || join(root, 'dist'),
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
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
