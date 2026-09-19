import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { createApi } from './api.mjs';
import { createHttpServer } from './http.mjs';
import { AdminAuth } from './adminAuth.mjs';
import { AccountAuth } from './accountAuth.mjs';
import { Commerce } from './commerce.mjs';
import { createPasswordRecoveryFromEnv } from './recovery.mjs';
import { createAiServiceFromEnv } from './ai.mjs';
import { AfkUsageService } from './afkUsage.mjs';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT inválido');
const adminToken = process.env.COSMETICS_ADMIN_TOKEN;
if (!adminToken || adminToken.length < 32) throw new Error('Configura COSMETICS_ADMIN_TOKEN (32 caracteres o más). No existe una clave predeterminada.');
const dbPath = process.env.COSMETICS_DATA_PATH || fileURLToPath(new URL('cosmetics.sqlite', new URL('../data/', import.meta.url)));
const dataDir = process.env.COSMETICS_DATA_PATH ? join(process.env.COSMETICS_DATA_PATH, '..') : fileURLToPath(new URL('../data/', import.meta.url));
if (!process.env.COSMETICS_DATA_PATH) { mkdirSync(new URL('../data/', import.meta.url), { recursive: true }); }
const resourceDir = process.env.COSMETICS_RESOURCE_DIR || join(dataDir, 'resources');
mkdirSync(resourceDir, { recursive: true });
const store = new Store(dbPath);
const origin = process.env.COSMETICS_ORIGIN || `http://127.0.0.1:${port}`;
const adminAuth = new AdminAuth({ store, bootstrapToken: adminToken });
const accountAuth = new AccountAuth({ store, recovery: createPasswordRecoveryFromEnv() });
const commerce = new Commerce(store);
const ai = createAiServiceFromEnv({ store });
const afkUsage = new AfkUsageService({ store });
const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
// Premium is secure-by-default. Setting the flag to false can temporarily stop
// premium login during an incident, but never enables an offline UUID bypass.
const premiumEnabled = process.env.COSMETICS_ENABLE_PREMIUM !== 'false';
const api = createApi({ store, adminToken, adminAuth, accountAuth, commerce, ai, afkUsage, resourceDir, origin, premiumEnabled,
  playtimeBackendUrl: (process.env.PLAYTIME_BACKEND_URL || 'https://minelatino-production.up.railway.app').replace(/\/$/, '') });
const trustedProxyAddresses = (process.env.COSMETICS_TRUSTED_PROXY_ADDRESSES || '').split(',').map(value => value.trim()).filter(Boolean);
const server = createHttpServer(api, origin, publicDir, {
  trustRailwayProxy: !!process.env.RAILWAY_ENVIRONMENT_ID,
  trustedProxyAddresses,
});
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`MineLatino Cosmetics API: http://${host}:${port}`));
let closing = false;
function close() { if (closing) return; closing = true; server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', close); process.on('SIGTERM', close);
