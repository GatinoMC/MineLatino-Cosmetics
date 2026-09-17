import { ApiError, requireThat, uuid, cosmeticId } from './store.mjs';
import { PlayerAuth } from './auth.mjs';
import { createHash, randomBytes, pbkdf2Sync } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { convertBbmodel } from './bbmodel.mjs';

const ALLOWED_EXTENSIONS = new Set(['.png', '.json']);
const MAX_RESOURCE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_BBMODEL_SIZE = 16 * 1024 * 1024; // embedded textures make editable projects larger

async function body(request) {
  requireThat(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'Se requiere application/json', 415);
  const reader = request.body?.getReader();
  requireThat(reader, 'Cuerpo requerido');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new ApiError(413, 'Solicitud demasiado grande'); }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 'Objeto JSON requerido');
    return data;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'JSON inválido'); }
}

async function binaryBody(request, maxSize) {
  const reader = request.body?.getReader();
  requireThat(reader, 'Cuerpo requerido');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) { await reader.cancel(); throw new ApiError(413, 'Archivo demasiado grande'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Cuerpo inválido'); }
}

function offset(url) {
  const value = url.searchParams.get('offset') ?? '0';
  requireThat(/^\d{1,7}$/.test(value), 'Paginación inválida'); return Number(value);
}

function validateResourceFile(buffer, filename) {
  const ext = extname(filename).toLowerCase();
  requireThat(ALLOWED_EXTENSIONS.has(ext), 'Solo se permiten archivos PNG o JSON', 415);
  requireThat(buffer.length > 0, 'Archivo vacío');
  requireThat(buffer.length <= MAX_RESOURCE_SIZE, 'Archivo demasiado grande (máx. 2 MB)', 413);
  // Reject path traversal in filename
  const safe = basename(filename);
  requireThat(safe === filename && !safe.includes('..') && !safe.includes('/') && !safe.includes('\\'), 'Nombre de archivo inválido');
  // PNG magic bytes
  if (ext === '.png') {
    requireThat(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47, 'Archivo PNG inválido');
    requireThat(buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR', 'Cabecera PNG inválida');
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    requireThat(width > 0 && height > 0 && width <= 4096 && height <= 4096
      && width * height <= 16_777_216, 'Dimensiones PNG no admitidas');
  }
  // JSON: must parse
  if (ext === '.json') {
    try { JSON.parse(buffer.toString('utf8')); } catch { throw new ApiError(400, 'JSON inválido'); }
  }
  return ext;
}

export function createApi({ store, adminToken, adminAuth, accountAuth, commerce, ai, afkUsage, resourceDir, origin = 'http://127.0.0.1:8787', playerAuth = new PlayerAuth(), premiumEnabled = true, now = Date.now }) {
  requireThat(typeof adminToken === 'string' && adminToken.length >= 32, 'Configura una clave administrativa de al menos 32 caracteres');
  if (resourceDir) mkdirSync(resourceDir, { recursive: true });
  const rates = new Map();
  const accountAuthRates = new Map();
  const json = (data, status = 200) => Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer',
  } });
  const binary = (buffer, contentType, cacheable = false) => new Response(buffer, { status: 200, headers: {
    'Content-Type': contentType,
    ...(cacheable ? { 'Cache-Control': 'public, max-age=3600, immutable' } : { 'Cache-Control': 'no-store' }),
    'X-Content-Type-Options': 'nosniff',
  } });
  /** Resolve admin identity from the Authorization header. */
  function requireAdmin(authorization) {
    const identity = adminAuth?.resolve(authorization, adminToken);
    requireThat(identity, 'Autorización administrativa requerida', 401);
    return identity;
  }
  function resourceVersion(id, resource = store.getResource(id)) {
    const files = store.getResourceFiles(id);
    const petAnimation = store.getPetAnimation(id);
    const transforms = store.getTransforms(id);
    return createHash('sha256').update(JSON.stringify([resource?.sha256, resource?.model_sha256,
      files.map(f => [f.name, f.sha256, f.uploaded_at, f.mcmeta_path, f.mcmeta_size]),
      petAnimation?.sha256, petAnimation?.animation_name, petAnimation?.updated_at,
      Object.entries(transforms).map(([slot, value]) => [slot, value.updatedAt])])).digest('hex').slice(0, 12);
  }
  return async (request, remoteAddress = 'local') => {
    try {
      const time = now();
      for (const [ip, bucket] of rates) if (bucket.until <= time) rates.delete(ip);
      for (const [ip, bucket] of accountAuthRates) if (bucket.until <= time) accountAuthRates.delete(ip);
      requireThat(rates.has(remoteAddress) || rates.size < 5000, 'Servicio ocupado', 429);
      const bucket = rates.get(remoteAddress) ?? { count: 0, until: time + 60_000 };
      bucket.count++; rates.set(remoteAddress, bucket);
      requireThat(bucket.count <= 120, 'Demasiadas solicitudes; espera un minuto', 429);
      const url = new URL(request.url), path = url.pathname, method = request.method;
      // Only published storefront data is cross-origin readable. Admin/auth routes remain same-origin.
      const publicStorefront = method === 'GET' && (path === '/v1/storefront/catalog' || path === '/v1/storefront/payments' || /^\/v1\/resources\/[a-z0-9_-]+$/.test(path));
      requireThat(publicStorefront || !request.headers.get('origin') || request.headers.get('origin') === origin, 'Origen no permitido', 403);
      const authorization = request.headers.get('authorization');

      // ── AFK Farm metered usage (short-lived restricted bearer) ───────
      if (path.startsWith('/v1/afk/')) {
        requireThat(accountAuth && afkUsage, 'Control de AFK Farm no disponible', 503);
        if (method === 'POST' && path === '/v1/afk/token') return json(accountAuth.assistantToken(authorization), 201);
        const capability = accountAuth.authenticateAssistant(authorization, 'afk:assistant');
        if (method === 'GET' && path === '/v1/afk/status') return json(afkUsage.status(capability.accountId));
        if (method === 'POST' && path === '/v1/afk/sessions') return json(afkUsage.start(capability.accountId), 201);
        const afkSessionMatch = path.match(/^\/v1\/afk\/sessions\/([0-9a-f-]{36})\/(heartbeat|stop)$/i);
        if (method === 'POST' && afkSessionMatch) return json(afkSessionMatch[2] === 'heartbeat'
          ? afkUsage.heartbeat(capability.accountId, afkSessionMatch[1])
          : afkUsage.stop(capability.accountId, afkSessionMatch[1]));
      }

      // ── AI assistant (short-lived, restricted bearer only) ────────────
      if (path.startsWith('/v1/ai/')) {
        requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
        requireThat(ai, 'El asistente de IA no está disponible', 503);
        if (method === 'POST' && path === '/v1/ai/token') {
          return json(accountAuth.assistantToken(authorization), 201);
        }
        const assistant = accountAuth.authenticateAssistant(authorization, 'ai:chat');
        if (method === 'GET' && path === '/v1/ai/status') return json(ai.status());
        if (method === 'POST' && path === '/v1/ai/chat') return json(await ai.chat(assistant.accountId, await body(request), request.signal));
        if (method === 'POST' && path === '/v1/ai/logout') {
          accountAuth.revokeAssistant(authorization); return json({ ok: true });
        }
      }

      // ── MineLatino accounts (premium and offline players) ──────────────
      if (method === 'POST' && ['/v1/account/register', '/v1/account/login', '/v1/account/password/forgot', '/v1/account/password/reset'].includes(path)) {
        const authBucket = accountAuthRates.get(remoteAddress) ?? { count: 0, until: time + 60_000 };
        authBucket.count++; accountAuthRates.set(remoteAddress, authBucket);
        requireThat(authBucket.count <= 20, 'Demasiados intentos de acceso; espera un minuto', 429);
      }
      if (method === 'POST' && path === '/v1/account/register') {
        requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
        return json(await accountAuth.register(await body(request)), 201);
      }
      if (method === 'POST' && path === '/v1/account/login') {
        requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
        return json(await accountAuth.login(await body(request)));
      }
      if (method === 'POST' && path === '/v1/account/password/forgot') {
        requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
        return json(await accountAuth.requestPasswordReset(await body(request)), 202);
      }
      if (method === 'POST' && path === '/v1/account/password/reset') {
        requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
        await accountAuth.resetPassword(await body(request));
        return json({ ok: true });
      }
      if (path.startsWith('/v1/account/')) {
        requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
        if (method === 'POST' && path === '/v1/account/logout') {
          accountAuth.logout(authorization); return json({ ok: true });
        }
        const identity = accountAuth.authenticate(authorization, path === '/v1/account/game-token' ? ['account'] : ['account','game']);
        const accountId = identity.account.account_id;
        if (method === 'POST' && path === '/v1/account/logout-all') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          store.deleteAccountSessions(accountId); return json({ ok: true });
        }
        if (method === 'GET' && path === '/v1/account/session') return json({ account: {
          accountId, nick: identity.account.nick, status: identity.account.status,
        } });
        if (method === 'GET' && path === '/v1/account/me') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          return json({ account: store.publicPlayerAccount(identity.account) });
        }
        if (method === 'PATCH' && path === '/v1/account/me') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          const input = await body(request);
          await accountAuth.requirePassword(accountId, input.currentPassword);
          requireThat(input.email === undefined || input.email.trim().toLowerCase() === identity.account.email,
            'El cambio de correo requiere verificación por soporte', 409);
          return json({ account: store.updatePlayerAccount(accountId, { email: input.email, nick: input.nick }) });
        }
        if (method === 'DELETE' && path === '/v1/account/me') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          const input = await body(request);
          await accountAuth.requirePassword(accountId, input.currentPassword);
          return json({ account: store.deletePlayerAccount(accountId, `account:${accountId}`) });
        }
        if (method === 'PUT' && path === '/v1/account/password') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          await accountAuth.updatePassword(accountId, await body(request)); return json({ ok: true });
        }
        if (method === 'POST' && path === '/v1/account/game-token') return json(accountAuth.gameToken(authorization), 201);
        if (method === 'POST' && path === '/v1/account/presence') {
          const input = await body(request);
          requireThat(typeof input.name === 'string' && input.name.toLowerCase() === identity.account.nick.toLowerCase(),
            'El nick del juego no coincide con tu cuenta MineLatino', 409);
          return json(store.updateAccountPresence(accountId, input.uuid, input.name, time));
        }
        if (method === 'GET' && path === '/v1/account/wardrobe') return json(store.accountWardrobe(accountId));
        if (method === 'PUT' && path === '/v1/account/equipment') {
          const input = await body(request);
          return json({ equipped: store.accountEquip(accountId, input.slot, input.cosmeticId) });
        }
        if (method === 'GET' && path === '/v1/account/orders') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          requireThat(commerce, 'Comercio no configurado', 503);
          return json({ items: commerce.listOwner({ accountId }, offset(url)) });
        }
        if (method === 'POST' && path === '/v1/account/orders') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          requireThat(commerce, 'Comercio no configurado', 503);
          const input = await body(request);
          return json({ order: commerce.createOrder({ accountId }, input.cosmeticId, input.provider, input.idempotencyKey) }, 201);
        }
        if (method === 'POST' && path === '/v1/account/free-claims') {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          requireThat(commerce, 'Comercio no configurado', 503);
          const input = await body(request);
          return json({ order: commerce.claimFree({ accountId }, input.cosmeticId, input.idempotencyKey) }, 201);
        }
        const cancelOrderMatch = path.match(/^\/v1\/account\/orders\/([0-9a-f-]{36})\/cancel$/i);
        if (method === 'POST' && cancelOrderMatch) {
          requireThat(identity.session.scope === 'account', 'Permiso de sesión insuficiente', 403);
          requireThat(commerce, 'Comercio no configurado', 503);
          return json({ order: commerce.cancel({ accountId }, cancelOrderMatch[1]) });
        }
      }

      if (publicStorefront && path === '/v1/storefront/payments') {
        const providers = commerce?.providers() ?? [];
        return Response.json({ providers, checkoutEnabled: providers.some(provider => provider.enabled) },
          { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      if (publicStorefront && path === '/v1/storefront/catalog') {
        const start = offset(url);
        const items = store.catalog(false, start).map(item => {
          const resource = store.getResource(item.id);
          const files = store.getResourceFiles(item.id);
          const hasTexture = !!resource?.file_path || files.length > 0;
          const transform = store.getTransforms(item.id)[item.slot.toLowerCase()] ?? null;
          return { ...item, ...store.product(item.id), hasTexture, hasModel: !!resource?.model_path,
            textureCount: files.length, transform,
            resourceVersion: resourceVersion(item.id, resource) };
        });
        return Response.json({ items, nextOffset: items.length === 50 ? start + 50 : null },
          { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      // Checkout is authenticated under /v1/account/orders. Never accept an
      // owner UUID, account ID, or payment approval supplied by the renderer.
      if (method === 'POST' && path === '/v1/storefront/checkout') throw new ApiError(410, 'Usa el checkout autenticado del launcher');

      // ── Resource distribution (public, no auth) ───────────────────────
      const resourceMatch = path.match(/^\/v1\/resources\/([a-z0-9_-]+)$/);
      if (method === 'GET' && resourceMatch) {
        requireThat(resourceDir, 'Recursos no disponibles', 503);
        requireThat(url.searchParams.get('type') !== 'avatar-package', 'Recurso retirado', 410);
        const id = cosmeticId(resourceMatch[1]);
        const res = store.getResource(id);
        requireThat(res, 'Recurso no encontrado', 404);
        const cosmetic = store.cosmetic(id);
        const adminIdentity = authorization ? adminAuth?.resolve(authorization, adminToken) : null;
        requireThat(cosmetic?.status === 'published' || adminIdentity, 'Recurso no publicado', 404);
        const version = resourceVersion(id, res), etag = `"${version}"`;
        const resourceResponse = response => {
          response.headers.set('Access-Control-Allow-Origin', '*');
          response.headers.set('ETag', etag);
          return response;
        };
        if ((request.headers.get('if-none-match') || '').split(',').map(value => value.trim()).includes(etag)) {
          return resourceResponse(new Response(null, { status: 304, headers: { 'Cache-Control': 'no-cache' } }));
        }
        const typeParam = url.searchParams.get('type');
        const fileName = url.searchParams.get('file');
        if (typeParam === 'manifest') {
          const files = store.getResourceFiles(id).map(f => ({ name: f.name, hasMcmeta: !!f.mcmeta_path }));
          return resourceResponse(Response.json({ files, hasLegacy: !!res.file_path, resourceVersion: version }, { headers: { 'Cache-Control': 'no-cache' } }));
        }
        if (typeParam === 'animation-config') {
          const animation = store.getPetAnimation(id);
          return resourceResponse(Response.json({ animation: animation?.animation_name ?? null, hasFile: !!animation?.file_path },
            { headers: { 'Cache-Control': 'no-cache' } }));
        }
        if (typeParam === 'animation') {
          const animation = store.getPetAnimation(id);
          requireThat(animation?.file_path, 'Animación no disponible', 404);
          const animationFile = join(resourceDir, animation.file_path);
          requireThat(existsSync(animationFile), 'Archivo de animación no encontrado', 404);
          const data = readFileSync(animationFile);
          requireThat(createHash('sha256').update(data).digest('hex') === animation.sha256, 'Integridad de animación comprometida', 500);
          const response = binary(data, 'application/json', true);
          return resourceResponse(response);
        }
        // Serve model JSON if requested via query param
        if (typeParam === 'model') {
          requireThat(res.model_path, 'Modelo no disponible', 404);
          const modelFile = join(resourceDir, res.model_path);
          requireThat(existsSync(modelFile), 'Archivo de modelo no encontrado', 404);
          const modelData = readFileSync(modelFile);
          if (res.model_sha256) {
            const hash = createHash('sha256').update(modelData).digest('hex');
            requireThat(hash === res.model_sha256, 'Integridad del modelo comprometida', 500);
          }
          const response = binary(modelData, 'application/json', true);
          return resourceResponse(response);
        }
        // Serve named file (multi-texture support)
        if (fileName) {
          requireThat(/^[a-z0-9_]{1,32}$/.test(fileName), 'Nombre de archivo inválido');
          const file = store.getResourceFile(id, fileName);
          requireThat(file, 'Archivo no encontrado', 404);
          // Serve mcmeta if requested
          if (typeParam === 'mcmeta') {
            requireThat(file.mcmeta_path, 'Mcmeta no disponible', 404);
            const mcmetaFile = join(resourceDir, file.mcmeta_path);
            requireThat(existsSync(mcmetaFile), 'Archivo mcmeta no encontrado', 404);
            const response = binary(readFileSync(mcmetaFile), 'application/json', true);
            return resourceResponse(response);
          }
          // Serve texture file
          const filePath = join(resourceDir, file.file_path);
          requireThat(existsSync(filePath), 'Archivo no encontrado', 404);
          const fileData = readFileSync(filePath);
          const hash = createHash('sha256').update(fileData).digest('hex');
          requireThat(hash === file.sha256, 'Integridad comprometida', 500);
          const response = binary(fileData, 'image/png', true);
          return resourceResponse(response);
        }
        // Default: serve primary texture (backward compatible)
        if (res.file_path) {
          const filePath = join(resourceDir, res.file_path);
          requireThat(existsSync(filePath), 'Archivo no encontrado', 404);
          const fileData = readFileSync(filePath);
          const hash = createHash('sha256').update(fileData).digest('hex');
          requireThat(hash === res.sha256, 'Integridad comprometida', 500);
          const response = binary(fileData, res.content_type, true);
          return resourceResponse(response);
        }
        // Fallback: serve first file from resource_files (multi-texture cosmetics)
        const allFiles = store.getResourceFiles(id);
        const fallback = allFiles.find(f => f.name === 'texture') || allFiles[0];
        requireThat(fallback, 'Textura no disponible', 404);
        const fbPath = join(resourceDir, fallback.file_path);
        requireThat(existsSync(fbPath), 'Archivo no encontrado', 404);
        const fbData = readFileSync(fbPath);
        const fbHash = createHash('sha256').update(fbData).digest('hex');
        requireThat(fbHash === fallback.sha256, 'Integridad comprometida', 500);
        const fbResponse = binary(fbData, 'image/png', true);
        return resourceResponse(fbResponse);
      }

      // ── Admin auth (no prior auth required) ─────────────────────────────
      if (method === 'POST' && path === '/v1/admin/auth/bootstrap') {
        const input = await body(request);
        requireThat(adminAuth, 'Autenticación administrativa no configurada', 503);
        return json(adminAuth.bootstrap(input.username, input.password, authorization?.startsWith('Bearer ') ? authorization.slice(7) : null), 201);
      }
      if (method === 'POST' && path === '/v1/admin/auth/login') {
        const adminRateKey = `admin:${remoteAddress}`;
        const authBucket = accountAuthRates.get(adminRateKey) ?? { count: 0, until: time + 60_000 };
        authBucket.count++; accountAuthRates.set(adminRateKey, authBucket);
        requireThat(authBucket.count <= 10, 'Demasiados intentos administrativos; espera un minuto', 429);
        const input = await body(request);
        requireThat(adminAuth, 'Autenticación administrativa no configurada', 503);
        return json(adminAuth.login(input.username, input.password));
      }
      if (method === 'POST' && path === '/v1/admin/auth/logout') {
        adminAuth?.logout(authorization);
        return json({ ok: true });
      }

      // ── All other /v1/admin/* routes require admin auth ─────────────────
      if (path.startsWith('/v1/admin/')) {
        const admin = requireAdmin(authorization);
        const actor = admin.username;

        // Admin account management
        if (method === 'GET' && path === '/v1/admin/accounts') return json({ items: store.listAdmins() });
        if (method === 'POST' && path === '/v1/admin/accounts') {
          requireThat(admin.role === 'superadmin', 'Permiso requerido', 403);
          const input = await body(request);
          const salt = randomBytes(16).toString('hex');
          const passwordHash = pbkdf2Sync(input.password, salt, 100_000, 32, 'sha256').toString('hex');
          return json(store.createAdmin(input.username, passwordHash, salt, input.role || 'admin'), 201);
        }
        if (method === 'DELETE' && path.startsWith('/v1/admin/accounts/')) {
          requireThat(admin.role === 'superadmin', 'Permiso requerido', 403);
          const username = path.slice('/v1/admin/accounts/'.length);
          return json(store.deleteAdmin(username, actor));
        }

        // Player account administration. Kept separate from /admin/accounts,
        // which manages operator logins for this panel.
        if (method === 'GET' && path === '/v1/admin/player-accounts') {
          const start = offset(url), items = store.listPlayerAccounts(url.searchParams.get('q') ?? '', start);
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }
        const playerAccountMatch = path.match(/^\/v1\/admin\/player-accounts\/([a-f0-9]{32})$/);
        if (playerAccountMatch && method === 'PATCH') {
          const input = await body(request);
          return json({ account: store.updatePlayerAccount(playerAccountMatch[1], {
            email: input.email, nick: input.nick, status: input.status,
          }, actor) });
        }
        if (playerAccountMatch && method === 'DELETE') {
          return json({ account: store.purgePlayerAccount(playerAccountMatch[1], actor), permanentlyDeleted: true });
        }
        const playerPasswordResetMatch = path.match(/^\/v1\/admin\/player-accounts\/([a-f0-9]{32})\/password-reset$/);
        if (playerPasswordResetMatch && method === 'POST') {
          requireThat(accountAuth, 'Cuentas MineLatino no configuradas', 503);
          const account = store.accountById(playerPasswordResetMatch[1], true);
          requireThat(account?.status === 'active', 'La cuenta no está activa', 409);
          return json(accountAuth.issuePasswordReset(playerPasswordResetMatch[1], actor), 201);
        }
        const playerAfkTimeMatch = path.match(/^\/v1\/admin\/player-accounts\/([a-f0-9]{32})\/afk-time$/);
        if (playerAfkTimeMatch && method === 'GET') {
          requireThat(afkUsage, 'Control de AFK Farm no disponible', 503);
          return json(afkUsage.status(playerAfkTimeMatch[1]));
        }
        if (playerAfkTimeMatch && method === 'PUT') {
          requireThat(afkUsage, 'Control de AFK Farm no disponible', 503);
          return json(afkUsage.adminChange(playerAfkTimeMatch[1], await body(request), actor));
        }
        const accountGrantMatch = path.match(/^\/v1\/admin\/player-accounts\/([a-f0-9]{32})\/cosmetics$/);
        if (accountGrantMatch && ['POST','DELETE'].includes(method)) {
          const input = await body(request);
          return json(store.accountEntitlement({ accountId: accountGrantMatch[1], cosmeticId: input.cosmeticId }, method === 'POST', actor));
        }
        const accountOwnersMatch = path.match(/^\/v1\/admin\/account-cosmetics\/owners\/([a-z0-9_-]+)$/);
        if (accountOwnersMatch && method === 'GET') {
          const start = offset(url), items = store.accountOwners(accountOwnersMatch[1], start);
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }

        // Orders and manual fulfillment. The operator must verify the payment
        // outside this panel and record its real, unique reference here.
        if (method === 'GET' && path === '/v1/admin/orders') {
          requireThat(commerce, 'Comercio no configurado', 503);
          const start = offset(url), items = commerce.listAdmin({
            status: url.searchParams.get('status') ?? '', query: url.searchParams.get('q') ?? '', offset: start,
          });
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }
        const fulfillOrderMatch = path.match(/^\/v1\/admin\/orders\/([0-9a-f-]{36})\/fulfill$/i);
        if (method === 'POST' && fulfillOrderMatch) {
          requireThat(commerce, 'Comercio no configurado', 503);
          const input = await body(request);
          const order = store.db.prepare('SELECT * FROM cosmetic_orders WHERE id=?').get(fulfillOrderMatch[1]);
          requireThat(order, 'Orden no encontrada', 404);
          requireThat(order.provider === 'manual', 'Esta orden debe confirmarse mediante el webhook firmado de su proveedor', 409);
          requireThat(typeof input.paymentReference === 'string' && /^[A-Za-z0-9._:@/-]{4,160}$/.test(input.paymentReference), 'Referencia de pago inválida');
          return json(commerce.settleVerified({ orderId: order.id, provider: order.provider,
            paymentId: input.paymentReference, amountMinor: order.amount_minor, currency: order.currency, status: 'approved' }));
        }

        // Player search
        if (method === 'GET' && path === '/v1/admin/players') {
          const query = url.searchParams.get('q') ?? '';
          const start = offset(url), items = store.searchPlayers(query, start);
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }

        // Catalog, grants, revocations, owners, audit, menu
        if (method === 'GET' && path === '/v1/admin/cosmetics/catalog') {
          const start = offset(url), items = store.catalog(true, start).map(item => {
            const petAnimation=store.getPetAnimation(item.id);
            let names=[];
            if (petAnimation?.file_path && resourceDir) {
              try { names=Object.keys(JSON.parse(readFileSync(join(resourceDir,petAnimation.file_path),'utf8')).animations||{}); } catch { names=[]; }
            }
            return { ...item, product: store.product(item.id), resource: store.getResource(item.id) || null,
              files: store.getResourceFiles(item.id), petAnimation: petAnimation ? { ...petAnimation,names } : null };
          });
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }
        // Match the segment first and validate it below. Keeping validation out of
        // the route regexp makes malformed IDs return a useful 400 instead of the
        // misleading generic "Ruta no encontrada" response.
        const itemMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([^/]{1,128})$/);
        if (method === 'PUT' && itemMatch) {
          const id = cosmeticId(itemMatch[1]);
          const input = await body(request);
          if (input.status === 'published') {
            requireThat(store.hasTexture(id), 'Sube al menos una textura antes de publicar el cosmético', 409);
          }
          return json(store.saveCosmetic(id, input, actor));
        }
        if (method === 'DELETE' && itemMatch) {
          const id = cosmeticId(itemMatch[1]);
          const input = await body(request);
          const resource = store.getResource(id);
          const files = store.getResourceFiles(id);
          const animation = store.getPetAnimation(id);
          const paths = new Set([resource?.file_path, resource?.model_path, resource?.avatar_path,
            animation?.file_path, ...files.flatMap(file => [file.file_path, file.mcmeta_path])].filter(Boolean));
          const result = store.deleteCosmetic(id, input.expectedRevision, actor);
          if (resourceDir) {
            for (const filePath of paths) {
              if (basename(filePath) !== filePath) continue;
              const absolute = join(resourceDir, filePath);
              try {
                if (existsSync(absolute)) unlinkSync(absolute);
              } catch (error) {
                console.warn(`[catalog.delete] No se pudo eliminar el archivo huérfano ${filePath}:`, error);
              }
            }
          }
          return json(result);
        }

        // Resource upload (texture PNG)
        const resourceUploadMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/resource$/);
        if (method === 'PUT' && resourceUploadMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(resourceUploadMatch[1]);
          store.cosmetic(id); // verify exists
          const filename = request.headers.get('x-filename') || 'resource.png';
          const buffer = await binaryBody(request, MAX_RESOURCE_SIZE);
          const ext = validateResourceFile(buffer, filename);
          requireThat(ext === '.png', 'La textura debe ser un archivo PNG', 415);
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          const filePath = `${id}${ext}`;
          // Delete old texture file if replacing
          const old = store.getResource(id);
          if (old?.file_path) {
            const oldPath = join(resourceDir, old.file_path);
            if (existsSync(oldPath)) unlinkSync(oldPath);
          }
          writeFileSync(join(resourceDir, filePath), buffer);
          const contentType = 'image/png';
          const resource = store.saveResource(id, filePath, sha256, buffer.length, contentType);
          store.audit(actor, 'resource.upload', { cosmeticId: id, type: 'texture', sha256, fileSize: buffer.length });
          return json(resource);
        }

        // Model upload (Minecraft Java JSON or editable Blockbench project)
        const modelUploadMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/model$/);
        if (method === 'PUT' && modelUploadMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(modelUploadMatch[1]);
          const cosmetic = store.cosmetic(id); // verify exists
          const filename = request.headers.get('x-filename') || 'model.json';
          const safe = basename(filename), sourceExt = extname(filename).toLowerCase();
          requireThat(safe === filename && !safe.includes('..') && !safe.includes('/') && !safe.includes('\\'), 'Nombre de archivo inválido');
          requireThat(sourceExt === '.json' || sourceExt === '.bbmodel', 'El modelo debe ser JSON Java o .bbmodel', 415);
          requireThat(sourceExt !== '.bbmodel' || cosmetic.slot === 'PET', 'Los proyectos .bbmodel se admiten en mascotas', 409);
          const sourceBuffer = await binaryBody(request, sourceExt === '.bbmodel' ? MAX_BBMODEL_SIZE : MAX_RESOURCE_SIZE);
          requireThat(sourceBuffer.length > 0, 'Archivo vacío');
          let modelBuffer = sourceBuffer, converted = null;
          if (sourceExt === '.bbmodel') {
            converted = convertBbmodel(sourceBuffer);
            modelBuffer = Buffer.from(JSON.stringify(converted.model));
            requireThat(modelBuffer.length <= 8 * 1024 * 1024, 'El modelo convertido supera el máximo de 8 MB', 413);
            for (const texture of converted.textures) {
              if (texture.buffer) validateResourceFile(texture.buffer, `${texture.name}.png`);
            }
          } else {
            validateResourceFile(sourceBuffer, filename);
          }
          const modelSha256 = createHash('sha256').update(modelBuffer).digest('hex');
          const modelPath = `${id}_model.json`;
          // Delete old model file if replacing
          const old = store.getResource(id);
          if (old?.model_path) {
            const oldModelPath = join(resourceDir, old.model_path);
            if (existsSync(oldModelPath)) unlinkSync(oldModelPath);
          }
          writeFileSync(join(resourceDir, modelPath), modelBuffer);
          // Ensure resource row exists (create minimal one if not)
          const existing = store.getResource(id);
          if (!existing) {
            store.saveResource(id, '', '', 0, 'image/png');
          }
          const importedTextures = [];
          if (converted) {
            for (const texture of converted.textures) {
              if (!texture.buffer) continue;
              const sha256 = createHash('sha256').update(texture.buffer).digest('hex');
              const filePath = `${id}_${texture.name}.png`;
              const previous = store.getResourceFile(id, texture.name);
              if (previous?.file_path && previous.file_path !== filePath) {
                const previousPath = join(resourceDir, previous.file_path);
                if (existsSync(previousPath)) unlinkSync(previousPath);
              }
              writeFileSync(join(resourceDir, filePath), texture.buffer);
              store.saveResourceFile(id, texture.name, filePath, sha256, texture.buffer.length);
              if (texture.name === 'texture') store.saveResource(id, filePath, sha256, texture.buffer.length, 'image/png');
              importedTextures.push(texture.name);
            }
            if (converted.animation) {
              const animationBuffer = Buffer.from(JSON.stringify(converted.animation.data));
              const animationPath = `${id}_animation.json`;
              const animationSha256 = createHash('sha256').update(animationBuffer).digest('hex');
              writeFileSync(join(resourceDir, animationPath), animationBuffer);
              store.savePetAnimation(id, converted.animation.selected, animationPath, animationSha256, animationBuffer.length, actor);
            }
          }
          const resource = store.saveResourceModel(id, modelPath, modelSha256, modelBuffer.length);
          store.audit(actor, 'resource.upload', { cosmeticId: id, type: 'model', sourceFormat: sourceExt.slice(1),
            sha256: modelSha256, fileSize: modelBuffer.length, importedTextures, importedAnimation: !!converted?.animation });
          return json({ ...resource, converted: sourceExt === '.bbmodel', importedTextures,
            importedAnimation: converted?.animation?.selected || null });
        }

        // Resource delete (texture)
        const resourceDeleteMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/resource$/);
        if (method === 'DELETE' && resourceDeleteMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(resourceDeleteMatch[1]);
          const res = store.getResource(id);
          if (res) {
            const filePath = join(resourceDir, res.file_path);
            if (existsSync(filePath)) unlinkSync(filePath);
            // Only delete texture, keep model
            store.saveResource(id, '', '', 0, 'image/png');
            store.audit(actor, 'resource.delete', { cosmeticId: id, type: 'texture' });
          }
          return json({ deleted: !!res });
        }

        // Model delete
        const modelDeleteMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/model$/);
        if (method === 'DELETE' && modelDeleteMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(modelDeleteMatch[1]);
          const res = store.getResource(id);
          if (res?.model_path) {
            const modelFile = join(resourceDir, res.model_path);
            if (existsSync(modelFile)) unlinkSync(modelFile);
            store.saveResourceModel(id, null, null, null);
            store.audit(actor, 'resource.delete', { cosmeticId: id, type: 'model' });
          }
          return json({ deleted: !!(res?.model_path) });
        }

        const petAnimationMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/animation$/);
        if (method === 'PUT' && petAnimationMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(petAnimationMatch[1]);
          requireThat(store.cosmetic(id).slot === 'PET', 'El cosmético debe ser una mascota');
          const filename = request.headers.get('x-filename') || 'pet.animation.json';
          requireThat(/\.json$/i.test(filename), 'La animación debe ser JSON', 415);
          const buffer = await binaryBody(request, MAX_RESOURCE_SIZE);
          let parsed;
          try { parsed = JSON.parse(buffer.toString('utf8')); } catch { throw new ApiError(400, 'JSON de animación inválido'); }
          const names = Object.keys(parsed?.animations || {});
          requireThat(names.length > 0 && names.length <= 128, 'No se encontraron animaciones de Blockbench');
          const requested = request.headers.get('x-animation-name');
          const selected = requested && names.includes(requested) ? requested : names[0];
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          const filePath = `${id}_animation.json`;
          const old = store.getPetAnimation(id);
          if (old?.file_path && old.file_path !== filePath) {
            const oldPath = join(resourceDir, old.file_path); if (existsSync(oldPath)) unlinkSync(oldPath);
          }
          writeFileSync(join(resourceDir, filePath), buffer);
          return json({ ...store.savePetAnimation(id, selected, filePath, sha256, buffer.length, actor), names });
        }
        if (method === 'PATCH' && petAnimationMatch) {
          const id = cosmeticId(petAnimationMatch[1]);
          const current = store.getPetAnimation(id);
          requireThat(current?.file_path, 'Sube primero un archivo de animación', 404);
          const input = await body(request);
          const data = JSON.parse(readFileSync(join(resourceDir, current.file_path), 'utf8'));
          requireThat(Object.hasOwn(data.animations || {}, input.animation), 'La animación elegida no existe');
          return json(store.savePetAnimation(id, input.animation, null, null, null, actor));
        }
        if (method === 'DELETE' && petAnimationMatch) {
          const id = cosmeticId(petAnimationMatch[1]);
          const old = store.getPetAnimation(id);
          if (old?.file_path) { const file = join(resourceDir, old.file_path); if (existsSync(file)) unlinkSync(file); }
          store.deletePetAnimation(id, actor);
          return json({ deleted: !!old });
        }

        // ── Multi-file resource management ──────────────────────────────
        const filesListMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/files$/);
        const fileMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/files\/([a-z0-9_]{1,32})$/);
        const fileMcmetaMatch = path.match(/^\/v1\/admin\/cosmetics\/catalog\/([a-z0-9_-]+)\/files\/([a-z0-9_]{1,32})\/mcmeta$/);

        // List all files for a cosmetic
        if (method === 'GET' && filesListMatch) {
          const id = cosmeticId(filesListMatch[1]);
          store.cosmetic(id);
          return json({ items: store.getResourceFiles(id) });
        }

        // Upload a texture file
        if (method === 'PUT' && fileMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(fileMatch[1]);
          const name = fileMatch[2];
          store.cosmetic(id);
          const filename = request.headers.get('x-filename') || `${name}.png`;
          const buffer = await binaryBody(request, MAX_RESOURCE_SIZE);
          const ext = validateResourceFile(buffer, filename);
          requireThat(ext === '.png', 'La textura debe ser un archivo PNG', 415);
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          const filePath = `${id}_${name}.png`;
          // Delete old file if replacing
          const old = store.getResourceFile(id, name);
          if (old?.file_path) {
            const oldPath = join(resourceDir, old.file_path);
            if (existsSync(oldPath)) unlinkSync(oldPath);
          }
          // Delete old mcmeta if replacing
          if (old?.mcmeta_path) {
            const oldMcmeta = join(resourceDir, old.mcmeta_path);
            if (existsSync(oldMcmeta)) unlinkSync(oldMcmeta);
          }
          writeFileSync(join(resourceDir, filePath), buffer);
          store.saveResourceFile(id, name, filePath, sha256, buffer.length);
          // If name is "texture", also update legacy resources table for backward compat
          if (name === 'texture') {
            const legacyRes = store.getResource(id);
            if (legacyRes?.file_path) {
              const legacyPath = join(resourceDir, legacyRes.file_path);
              if (legacyPath !== join(resourceDir, filePath) && existsSync(legacyPath)) unlinkSync(legacyPath);
            }
            store.saveResource(id, filePath, sha256, buffer.length, 'image/png');
          }
          store.audit(actor, 'resource.file.upload', { cosmeticId: id, name, sha256, fileSize: buffer.length });
          return json(store.getResourceFile(id, name));
        }

        // Upload mcmeta for a texture
        if (method === 'PUT' && fileMcmetaMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(fileMcmetaMatch[1]);
          const name = fileMcmetaMatch[2];
          store.cosmetic(id);
          const file = store.getResourceFile(id, name);
          requireThat(file, 'Textura no encontrada, sube la textura primero', 404);
          const buffer = await binaryBody(request, MAX_RESOURCE_SIZE);
          // Validate it's valid JSON
          try { JSON.parse(buffer.toString('utf8')); } catch { throw new ApiError(400, 'JSON inválido'); }
          requireThat(buffer.length > 0, 'Archivo vacío');
          requireThat(buffer.length <= MAX_RESOURCE_SIZE, 'Archivo demasiado grande (máx. 2 MB)', 413);
          const mcmetaPath = `${id}_${name}.png.mcmeta`;
          // Delete old mcmeta if replacing
          if (file?.mcmeta_path) {
            const oldMcmeta = join(resourceDir, file.mcmeta_path);
            if (existsSync(oldMcmeta)) unlinkSync(oldMcmeta);
          }
          writeFileSync(join(resourceDir, mcmetaPath), buffer);
          store.saveResourceFileMcmeta(id, name, mcmetaPath, buffer.length);
          store.audit(actor, 'resource.file.mcmeta', { cosmeticId: id, name, mcmetaSize: buffer.length });
          return json(store.getResourceFile(id, name));
        }

        // Delete a texture file (+ its mcmeta)
        if (method === 'DELETE' && fileMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(fileMatch[1]);
          const name = fileMatch[2];
          const file = store.getResourceFile(id, name);
          if (file) {
            const filePath = join(resourceDir, file.file_path);
            if (existsSync(filePath)) unlinkSync(filePath);
            if (file.mcmeta_path) {
              const mcmetaFile = join(resourceDir, file.mcmeta_path);
              if (existsSync(mcmetaFile)) unlinkSync(mcmetaFile);
            }
            store.deleteResourceFile(id, name);
            // If name is "texture", also clear legacy resources table
            if (name === 'texture') {
              const legacyRes = store.getResource(id);
              if (legacyRes?.file_path) {
                const legacyPath = join(resourceDir, legacyRes.file_path);
                if (existsSync(legacyPath)) unlinkSync(legacyPath);
              }
              store.saveResource(id, '', '', 0, 'image/png');
            }
            store.audit(actor, 'resource.file.delete', { cosmeticId: id, name });
          }
          return json({ deleted: !!file });
        }

        // Delete only the mcmeta
        if (method === 'DELETE' && fileMcmetaMatch) {
          requireThat(resourceDir, 'Recursos no disponibles', 503);
          const id = cosmeticId(fileMcmetaMatch[1]);
          const name = fileMcmetaMatch[2];
          const file = store.getResourceFile(id, name);
          if (file?.mcmeta_path) {
            const mcmetaFile = join(resourceDir, file.mcmeta_path);
            if (existsSync(mcmetaFile)) unlinkSync(mcmetaFile);
            store.deleteResourceFileMcmeta(id, name);
            store.audit(actor, 'resource.file.mcmeta.delete', { cosmeticId: id, name });
          }
          return json({ deleted: !!(file?.mcmeta_path) });
        }

        if (method === 'POST' && ['/v1/admin/cosmetics/grants', '/v1/admin/cosmetics/revocations'].includes(path))
          return json(store.entitlement(await body(request), path.endsWith('/grants'), actor));
        const ownersMatch = path.match(/^\/v1\/admin\/cosmetics\/owners\/([a-z0-9_-]+)$/);
        if (method === 'GET' && ownersMatch) {
          const start = offset(url), items = store.owners(ownersMatch[1], start);
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }
        if (method === 'GET' && path === '/v1/admin/audit') {
          const start = offset(url), items = store.auditPage(start);
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }
        if (method === 'PUT' && path === '/v1/admin/pause-menu') return json(store.saveMenu(await body(request), actor));
        if (method === 'GET' && path === '/v1/admin/pause-menu/history') {
          const start = offset(url), items = store.menuHistory(start);
          return json({ items, nextOffset: items.length === 50 ? start + 50 : null });
        }
        if (method === 'POST' && path === '/v1/admin/pause-menu/restore') return json(store.restoreMenu(await body(request), actor));
        if (method === 'DELETE' && path.startsWith('/v1/admin/pause-menu/history/')) {
          const rev = Number(path.slice('/v1/admin/pause-menu/history/'.length));
          return json(store.deleteMenuEntry({ revision: rev }, actor));
        }

        // ── Cosmetic transforms (position/rotation/scale per slot) ────
        const transformsMatch = path.match(/^\/v1\/admin\/cosmetics\/transforms\/([a-z0-9_-]+)$/);
        if (method === 'GET' && transformsMatch) {
          const id = cosmeticId(transformsMatch[1]);
          store.cosmetic(id);
          return json({ transforms: store.getTransforms(id) });
        }
        if (method === 'PUT' && transformsMatch) {
          const id = cosmeticId(transformsMatch[1]);
          const input = await body(request);
          requireThat(input.slot && input.transform, 'Slot y transform requeridos');
          return json({ transforms: store.saveTransform(id, input.slot, input.transform, actor) });
        }
      }

      // ── Public routes ───────────────────────────────────────────────────
      if (method === 'GET' && path === '/health') return json({ ok: true, premiumEnabled, offlineAuthEnabled: !!accountAuth, stage: accountAuth ? 'account-api' : 'premium-api' });
      if (method === 'GET' && path === '/v1/cosmetics/catalog') {
        const items = store.catalog(false, offset(url)).map(item => ({ ...item, hasResource: !!store.getResource(item.id) }));
        return json({ items });
      }
      if (method === 'GET' && path === '/v1/client-config/pause-menu') return json(store.menu());
      if (method === 'GET' && path === '/v1/client-config/cosmetic-transforms') return json({ transforms: store.getAllTransforms() });
      if (method === 'GET' && path === '/v1/cosmetics/appearance') {
        const ids = [...new Set((url.searchParams.get('uuids') ?? '').split(',').map(uuid))];
        const names = [...new Set((url.searchParams.get('names') ?? '').split(',').filter(Boolean))];
        requireThat(ids.length <= 50 && names.length <= 50, 'Máximo 50 jugadores');
        const players = ids.map(id => {
          const account = store.accountAppearanceByIdentity(id, '', time - 2 * 60 * 60 * 1000);
          return account ?? { uuid: id, name: null, equipped: store.appearance(id) };
        });
        // Offline-mode servers expose a generated entity UUID. A verified name
        // lets clients resolve the premium UUID without ever granting ownership
        // from that name; it only selects already server-owned appearance data.
        for (const requestedName of names) {
          const account = store.accountAppearanceByIdentity('0'.repeat(32), requestedName, time - 2 * 60 * 60 * 1000);
          if (account) { players.push(account); continue; }
          const verified = store.verifiedPlayerByName(requestedName);
          if (verified) players.push({ uuid: verified.uuid, name: verified.name, equipped: store.appearance(verified.uuid) });
        }
        return json({ players, identityMode: accountAuth ? 'minelatino-account' : 'premium-uuid' });
      }
      if (path.startsWith('/v1/auth/') || path.startsWith('/v1/cosmetics/me/')) {
        // Never trust a UUID supplied by the client. Cosmetics ownership and
        // equipment are available only after Mojang/Microsoft session proof.
        if (method === 'POST' && path === '/v1/auth/offline') {
          throw new ApiError(403, 'Los cosméticos requieren una cuenta premium verificada con Mojang/Microsoft');
        }
        // Premium-only auth endpoints (challenge/verify)
        if (path.startsWith('/v1/auth/challenge') || path.startsWith('/v1/auth/verify')) {
          requireThat(premiumEnabled, 'Vinculación premium aún deshabilitada en este entorno', 503);
        }
        if (method === 'POST' && path === '/v1/auth/challenge') return json(playerAuth.challenge((await body(request)).username), 201);
        if (method === 'POST' && path === '/v1/auth/verify') {
          const session = await playerAuth.complete((await body(request)).challengeId);
          store.verifiedPlayer(session.uuid, session.name); return json(session);
        }
        // Session-based endpoints accept only sessions created by the premium
        // challenge/verify flow above.
        const owner = playerAuth.player(authorization);
        if (method === 'POST' && path === '/v1/auth/logout') { playerAuth.logout(authorization); return json({ ok: true }); }
        if (method === 'GET' && path === '/v1/cosmetics/me/wardrobe') return json(store.wardrobe(owner));
        if (method === 'PUT' && path === '/v1/cosmetics/me/equipment') {
          const input = await body(request);
          return json({ equipped: store.equip(owner, input.slot, input.cosmeticId) });
        }
      }
      throw new ApiError(404, 'Ruta no encontrada');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Unexpected error:', error.message, error.stack);
      return json({ error: error instanceof ApiError ? error.message : 'Error interno' }, error instanceof ApiError ? error.status : 500);
    }
  };
}
