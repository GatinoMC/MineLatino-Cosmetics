import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const requireThat = (condition, message, status = 400) => { if (!condition) throw new ApiError(status, message); };
export function text(value, max = 80) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 'Texto inválido');
  return value.trim();
}
export function uuid(value) {
  requireThat(typeof value === 'string' && /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value), 'UUID inválido');
  return value.replaceAll('-', '').toLowerCase();
}
export function offlineUuid(name) {
  requireThat(typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name), 'Nombre de Minecraft inválido');
  const digest = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return digest.toString('hex');
}
export function cosmeticId(value) {
  requireThat(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value), 'ID de cosmético inválido');
  return value;
}
export const SLOTS = ['CAPE', 'HAT', 'WINGS', 'BACKPACK', 'PET'];
const SUPPORTED_SLOTS_SQL = SLOTS.map(slot => `'${slot}'`).join(',');
export const TRANSFORM_SLOTS = ['cape', 'hat', 'wings', 'backpack', 'pet'];

/** Check if hostname matches an allowed domain or any of its subdomains. */
function isAllowedHost(hostname, allowedDomains) {
  return allowedDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}
export const DEFAULT_MENU = { schemaVersion: 1, enabled: true, buttons: [{ label: 'Cosméticos MineLatino', action: 'WARDROBE' }], labels: {}, vanillaUrls: {} };
export function validateMenu(config) {
  requireThat(config && config.schemaVersion === 1 && typeof config.enabled === 'boolean' && Array.isArray(config.buttons) && config.buttons.length <= 3, 'Menú inválido');
  const allowed = ['menu.returnToGame', 'menu.options', 'menu.disconnect', 'menu.returnToMenu', 'gui.advancements', 'gui.stats', 'menu.sendFeedback', 'menu.reportBugs', 'menu.shareToLan'];
  requireThat(config.labels && typeof config.labels === 'object' && !Array.isArray(config.labels) && Object.keys(config.labels).length <= 9, 'Etiquetas inválidas');
  const labels = Object.fromEntries(Object.entries(config.labels).map(([key, value]) => {
    requireThat(allowed.includes(key), 'Botón original desconocido');
    return [key, text(value, 40)];
  }));
  // vanillaUrls: maps vanilla button keys to custom URLs (Discord, store, etc.)
  const rawUrls = config.vanillaUrls || {};
  requireThat(typeof rawUrls === 'object' && !Array.isArray(rawUrls), 'URLs vanilla inválidas');
  const vanillaUrls = Object.fromEntries(Object.entries(rawUrls).map(([key, url]) => {
    requireThat(allowed.includes(key), 'Botón original desconocido para URL');
    let parsed;
    try { parsed = new URL(url); } catch { throw new ApiError(400, 'URL inválida'); }
    requireThat(parsed.protocol === 'https:' && isAllowedHost(parsed.hostname, ['minelatino.com', 'minelatino.shop', 'discord.com']) && !parsed.username && !parsed.password && !parsed.port, 'URL no permitida');
    return [key, parsed.href];
  }));
  const buttons = config.buttons.map(button => {
    requireThat(button && ['WARDROBE', 'WEBSITE'].includes(button.action), 'Acción no permitida');
    const result = { label: text(button.label, 40), action: button.action };
    if (button.action === 'WEBSITE') {
      let url;
      try { url = new URL(button.url); } catch { throw new ApiError(400, 'URL inválida'); }
      requireThat(url.protocol === 'https:' && isAllowedHost(url.hostname, ['minelatino.com', 'minelatino.shop']) && !url.username && !url.password && !url.port, 'URL no permitida');
      result.url = url.href;
    }
    return result;
  });
  return { schemaVersion: 1, enabled: config.enabled, buttons, labels, vanillaUrls };
}

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cosmetics(id TEXT PRIMARY KEY, name TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('CAPE','HAT','WINGS','BACKPACK','PET','SKIN')), status TEXT NOT NULL CHECK(status IN ('draft','published','retired')), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS players(uuid TEXT PRIMARY KEY, name TEXT NOT NULL, verified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entitlements(uuid TEXT NOT NULL, cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id), active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(uuid,cosmetic_id));
      CREATE TABLE IF NOT EXISTS operations(reference TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS equipment(uuid TEXT NOT NULL, slot TEXT NOT NULL, cosmetic_id TEXT NOT NULL, PRIMARY KEY(uuid,slot), FOREIGN KEY(uuid,cosmetic_id) REFERENCES entitlements(uuid,cosmetic_id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS menus(revision INTEGER PRIMARY KEY AUTOINCREMENT, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cosmetic_products(cosmetic_id TEXT PRIMARY KEY REFERENCES cosmetics(id), description TEXT NOT NULL, amount_minor INTEGER, currency TEXT NOT NULL DEFAULT 'USD', stock_mode TEXT NOT NULL DEFAULT 'unlimited' CHECK(stock_mode IN ('unlimited','limited')), stock_remaining INTEGER CHECK(stock_remaining IS NULL OR stock_remaining>=0));
      CREATE INDEX IF NOT EXISTS entitlement_owners ON entitlements(cosmetic_id,active,uuid);
      CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resources(cosmetic_id TEXT PRIMARY KEY REFERENCES cosmetics(id), file_path TEXT NOT NULL, sha256 TEXT NOT NULL, file_size INTEGER NOT NULL, content_type TEXT NOT NULL, uploaded_at INTEGER NOT NULL, model_path TEXT, model_sha256 TEXT, model_size INTEGER, avatar_path TEXT, avatar_sha256 TEXT, avatar_size INTEGER);
      CREATE TABLE IF NOT EXISTS resource_files(cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id), name TEXT NOT NULL, file_path TEXT NOT NULL, sha256 TEXT NOT NULL, file_size INTEGER NOT NULL, mcmeta_path TEXT, mcmeta_size INTEGER, uploaded_at INTEGER NOT NULL, PRIMARY KEY(cosmetic_id, name));
      CREATE TABLE IF NOT EXISTS cosmetic_transforms(cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id), slot TEXT NOT NULL CHECK(slot IN ('cape','hat','wings','backpack','pet','skin')), translation_x REAL DEFAULT 0, translation_y REAL DEFAULT 0, translation_z REAL DEFAULT 0, rotation_x REAL DEFAULT 0, rotation_y REAL DEFAULT 0, rotation_z REAL DEFAULT 0, scale_x REAL DEFAULT 1, scale_y REAL DEFAULT 1, scale_z REAL DEFAULT 1, updated_at INTEGER, PRIMARY KEY(cosmetic_id, slot));
      CREATE TABLE IF NOT EXISTS pet_animations(cosmetic_id TEXT PRIMARY KEY REFERENCES cosmetics(id), animation_name TEXT NOT NULL, file_path TEXT, sha256 TEXT, file_size INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS player_accounts(account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, nick TEXT NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, scope TEXT NOT NULL CHECK(scope IN ('account','game')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS password_reset_tokens(token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS account_entitlements(account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id), active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(account_id,cosmetic_id));
      CREATE TABLE IF NOT EXISTS account_equipment(account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, slot TEXT NOT NULL, cosmetic_id TEXT NOT NULL, PRIMARY KEY(account_id,slot), FOREIGN KEY(account_id,cosmetic_id) REFERENCES account_entitlements(account_id,cosmetic_id));
      CREATE TABLE IF NOT EXISTS account_presence(account_id TEXT PRIMARY KEY REFERENCES player_accounts(account_id) ON DELETE CASCADE, profile_uuid TEXT NOT NULL, name TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_emotes(account_id TEXT PRIMARY KEY REFERENCES player_accounts(account_id) ON DELETE CASCADE, clip TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS player_accounts_nick ON player_accounts(nick COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS password_reset_account ON password_reset_tokens(account_id,expires_at);
      CREATE INDEX IF NOT EXISTS account_presence_identity ON account_presence(name COLLATE NOCASE,profile_uuid,updated_at);
      CREATE INDEX IF NOT EXISTS account_entitlement_owners ON account_entitlements(cosmetic_id,active,account_id);
      CREATE TABLE IF NOT EXISTS ai_conversations(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_requests(account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('pending','complete')), response_message_id TEXT, created_at INTEGER NOT NULL, completed_at INTEGER, PRIMARY KEY(account_id,request_id));
      CREATE TABLE IF NOT EXISTS ai_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_conversations_owner ON ai_conversations(account_id,updated_at);
      CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS ai_usage_owner_time ON ai_usage(account_id,created_at);
      CREATE TABLE IF NOT EXISTS afk_time_balances(account_id TEXT PRIMARY KEY REFERENCES player_accounts(account_id) ON DELETE CASCADE, remaining_seconds INTEGER NOT NULL DEFAULT 0 CHECK(remaining_seconds>=0), updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS afk_usage_sessions(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('active','stopped','exhausted')), started_at INTEGER NOT NULL, last_heartbeat_at INTEGER NOT NULL, stopped_at INTEGER, consumed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(consumed_seconds>=0));
      CREATE INDEX IF NOT EXISTS afk_usage_owner ON afk_usage_sessions(account_id,started_at);
      CREATE UNIQUE INDEX IF NOT EXISTS afk_usage_one_active ON afk_usage_sessions(account_id) WHERE status='active';
      `);
    // Migration: ensure model columns exist (for databases that may have incomplete migration)
    const columns = this.db.prepare("PRAGMA table_info(resources)").all().map(c => c.name);
    if (!columns.includes('model_path')) {
      this.db.prepare('ALTER TABLE resources ADD COLUMN model_path TEXT').run();
    }
    if (!columns.includes('model_sha256')) {
      this.db.prepare('ALTER TABLE resources ADD COLUMN model_sha256 TEXT').run();
    }
    if (!columns.includes('model_size')) {
      this.db.prepare('ALTER TABLE resources ADD COLUMN model_size INTEGER').run();
    }
    if (!columns.includes('avatar_path')) this.db.prepare('ALTER TABLE resources ADD COLUMN avatar_path TEXT').run();
    if (!columns.includes('avatar_sha256')) this.db.prepare('ALTER TABLE resources ADD COLUMN avatar_sha256 TEXT').run();
    if (!columns.includes('avatar_size')) this.db.prepare('ALTER TABLE resources ADD COLUMN avatar_size INTEGER').run();
    const productColumns = this.db.prepare("PRAGMA table_info(cosmetic_products)").all().map(c => c.name);
    if (!productColumns.includes('stock_mode')) this.db.prepare("ALTER TABLE cosmetic_products ADD COLUMN stock_mode TEXT NOT NULL DEFAULT 'unlimited' CHECK(stock_mode IN ('unlimited','limited'))").run();
    if (!productColumns.includes('stock_remaining')) this.db.prepare('ALTER TABLE cosmetic_products ADD COLUMN stock_remaining INTEGER CHECK(stock_remaining IS NULL OR stock_remaining>=0)').run();
    this.migrateCosmeticSlots();
    this.migrateCosmeticTransforms();
    this.migrateLegacyAccountEntitlements();
    this.retireLegacySkins();
    this.repairInvalidPublishedCosmetics();
  }
  retireLegacySkins() {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE cosmetics SET status='retired',revision=revision+1 WHERE slot='SKIN' AND status<>'retired'").run();
      if (Number(result.changes)) this.audit('system', 'catalog.retire-skins', { count: Number(result.changes) });
    });
  }
  repairInvalidPublishedCosmetics() {
    const invalid = this.db.prepare(`SELECT id FROM cosmetics c WHERE c.status='published' AND c.slot<>'SKIN'
      AND NOT EXISTS(SELECT 1 FROM resources r WHERE r.cosmetic_id=c.id AND (r.file_path<>'' OR r.avatar_path IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM resource_files f WHERE f.cosmetic_id=c.id)`).all();
    if (invalid.length === 0) return;
    this.transaction(() => {
      for (const { id } of invalid) {
        this.db.prepare('DELETE FROM equipment WHERE cosmetic_id=?').run(id);
        this.db.prepare("UPDATE cosmetics SET status='draft',revision=revision+1 WHERE id=?").run(id);
        this.audit('system', 'catalog.auto-draft', { id, reason: 'missing-texture' });
      }
    });
  }
  migrateCosmeticSlots() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='cosmetics'").get().sql;
    if (SLOTS.every(slot => schema.includes(`'${slot}'`))) {
      if (this.db.prepare('PRAGMA user_version').get().user_version < 7) this.db.exec('PRAGMA user_version=7');
      return;
    }
    // SQLite cannot ALTER a CHECK constraint. Rebuild only this table in a transaction,
    // keeping IDs/revisions and all referencing ownership, equipment and resource rows.
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE cosmetics_slots_v7(id TEXT PRIMARY KEY, name TEXT NOT NULL,
          slot TEXT NOT NULL CHECK(slot IN ('CAPE','HAT','WINGS','BACKPACK','PET','SKIN')),
          status TEXT NOT NULL CHECK(status IN ('draft','published','retired')), revision INTEGER NOT NULL);
          INSERT INTO cosmetics_slots_v7 SELECT id,name,slot,status,revision FROM cosmetics;
          DROP TABLE cosmetics;
          ALTER TABLE cosmetics_slots_v7 RENAME TO cosmetics;`);
        requireThat(this.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Migración de categorías: referencias inválidas', 500);
        this.db.exec('PRAGMA user_version=7');
      });
    } finally { this.db.exec('PRAGMA foreign_keys=ON'); }
  }
  migrateCosmeticTransforms() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='cosmetic_transforms'").get().sql;
    if (TRANSFORM_SLOTS.every(slot => schema.includes(`'${slot}'`))) {
      if (this.db.prepare('PRAGMA user_version').get().user_version < 8) this.db.exec('PRAGMA user_version=8');
      return;
    }
    // The original editor stored every body cosmetic as "backpack" and pets/hats as
    // "head". Preserve those attempted adjustments while giving each catalog type its
    // own independently addressable transform.
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE cosmetic_transforms_v8(cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
          slot TEXT NOT NULL CHECK(slot IN ('cape','hat','wings','backpack','pet','skin')),
          translation_x REAL DEFAULT 0, translation_y REAL DEFAULT 0, translation_z REAL DEFAULT 0,
          rotation_x REAL DEFAULT 0, rotation_y REAL DEFAULT 0, rotation_z REAL DEFAULT 0,
          scale_x REAL DEFAULT 1, scale_y REAL DEFAULT 1, scale_z REAL DEFAULT 1,
          updated_at INTEGER, PRIMARY KEY(cosmetic_id, slot));
          INSERT INTO cosmetic_transforms_v8
          SELECT t.cosmetic_id, lower(c.slot), t.translation_x, t.translation_y, t.translation_z,
            t.rotation_x, t.rotation_y, t.rotation_z, t.scale_x, t.scale_y, t.scale_z, t.updated_at
          FROM cosmetic_transforms t JOIN cosmetics c ON c.id=t.cosmetic_id
          WHERE (c.slot IN ('HAT','PET') AND t.slot='head')
             OR (c.slot IN ('CAPE','WINGS','BACKPACK') AND t.slot='backpack');
          DROP TABLE cosmetic_transforms;
          ALTER TABLE cosmetic_transforms_v8 RENAME TO cosmetic_transforms;`);
        requireThat(this.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Migración de transforms: referencias inválidas', 500);
        this.db.exec('PRAGMA user_version=8');
      });
    } finally { this.db.exec('PRAGMA foreign_keys=ON'); }
  }
  migrateLegacyAccountEntitlements() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 9) return;
    this.transaction(() => {
      // A previous admin screen accepted any 32-hex value as a Minecraft UUID.
      // If that value is an existing MineLatino account ID, preserve the intended
      // delivery in the account inventory. Never overwrite an account-native row.
      const migrated = this.db.prepare(`INSERT INTO account_entitlements(account_id,cosmetic_id,active)
        SELECT a.account_id,e.cosmetic_id,e.active FROM entitlements e
        JOIN player_accounts a ON a.account_id=e.uuid
        ON CONFLICT(account_id,cosmetic_id) DO NOTHING`).run();
      this.db.exec('PRAGMA user_version=9');
      if (Number(migrated.changes) > 0) this.audit('system', 'account-entitlement.migrate-legacy', { count: Number(migrated.changes) });
    });
  }
  close() { this.db.close(); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, payload) {
    this.db.prepare('INSERT INTO audit(actor,action,payload,at) VALUES(?,?,?,?)').run(actor, action, JSON.stringify(payload), Date.now());
  }
  catalog(admin, offset = 0) {
    return this.db.prepare(`SELECT * FROM cosmetics WHERE slot IN (${SUPPORTED_SLOTS_SQL}) ${admin ? '' : "AND status='published'"} ORDER BY id LIMIT 50 OFFSET ?`).all(offset);
  }
  cosmetic(id) {
    const item = this.db.prepare('SELECT * FROM cosmetics WHERE id=?').get(cosmeticId(id));
    requireThat(item && SLOTS.includes(item.slot), 'Cosmético no encontrado', 404); return item;
  }
  saveCosmetic(id, input, actor) {
    id = cosmeticId(id);
    const name = text(input.name);
    requireThat(SLOTS.includes(input.slot) && ['draft', 'published', 'retired'].includes(input.status), 'Categoría o estado inválido');
    requireThat(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'Revisión requerida');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM cosmetics WHERE id=?').get(id);
      requireThat((old?.revision ?? 0) === input.expectedRevision, 'Otro administrador modificó este cosmético', 409);
      requireThat(!old || old.slot === input.slot, 'La categoría de un ID existente no se puede cambiar', 409);
      const revision = input.expectedRevision + 1;
      this.db.prepare('INSERT INTO cosmetics VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,revision=excluded.revision').run(id, name, input.slot, input.status, revision);
      if (input.product !== undefined) {
        const p = input.product;
        requireThat(p && typeof p.description === 'string' && p.description.length <= 2000, 'Descripción inválida (máximo 2000 caracteres)');
        requireThat(p.amountMinor === null || (Number.isSafeInteger(p.amountMinor) && p.amountMinor >= 0 && p.amountMinor <= 100000000), 'Precio inválido; usa unidades menores enteras o null');
        requireThat(['USD', 'EUR', 'UYU', 'ARS', 'BRL', 'MXN'].includes(p.currency), 'Moneda no admitida');
        const stockMode = p.stockMode ?? 'unlimited';
        requireThat(['unlimited', 'limited'].includes(stockMode), 'Modo de stock inválido');
        const stockRemaining = stockMode === 'limited' ? p.stockRemaining : null;
        requireThat(stockMode !== 'limited' || (Number.isSafeInteger(stockRemaining) && stockRemaining >= 0 && stockRemaining <= 100000000), 'Stock inválido');
        this.db.prepare(`INSERT INTO cosmetic_products(cosmetic_id,description,amount_minor,currency,stock_mode,stock_remaining) VALUES(?,?,?,?,?,?)
          ON CONFLICT(cosmetic_id) DO UPDATE SET description=excluded.description,amount_minor=excluded.amount_minor,
          currency=excluded.currency,stock_mode=excluded.stock_mode,stock_remaining=excluded.stock_remaining`)
          .run(id, p.description.trim(), p.amountMinor, p.currency, stockMode, stockRemaining);
      }
      if (input.status !== 'published') this.db.prepare('DELETE FROM equipment WHERE cosmetic_id=?').run(id);
      this.audit(actor, 'catalog.save', { id, name, slot: input.slot, status: input.status, revision });
      return this.cosmetic(id);
    });
  }
  deleteCosmetic(id, expectedRevision, actor) {
    id = cosmeticId(id);
    requireThat(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'Revisión requerida');
    return this.transaction(() => {
      const item = this.db.prepare('SELECT * FROM cosmetics WHERE id=?').get(id);
      requireThat(item && SLOTS.includes(item.slot), 'Cosmético no encontrado', 404);
      requireThat(item.revision === expectedRevision, 'Otro administrador modificó este cosmético', 409);
      const hasOrdersTable = !!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cosmetic_orders'").get();
      if (hasOrdersTable) {
        const orderCount = Number(this.db.prepare('SELECT COUNT(*) count FROM cosmetic_orders WHERE cosmetic_id=?').get(id).count);
        requireThat(orderCount === 0, 'Este producto tiene órdenes registradas. Cámbialo a Retirado para conservar el historial de pagos.', 409);
      }
      const counts = {
        premiumOwners: Number(this.db.prepare('SELECT COUNT(*) count FROM entitlements WHERE cosmetic_id=? AND active=1').get(id).count),
        accountOwners: Number(this.db.prepare('SELECT COUNT(*) count FROM account_entitlements WHERE cosmetic_id=? AND active=1').get(id).count),
      };
      this.db.prepare('DELETE FROM equipment WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM account_equipment WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM entitlements WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM account_entitlements WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM pet_animations WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM cosmetic_transforms WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM resource_files WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM resources WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM cosmetic_products WHERE cosmetic_id=?').run(id);
      this.db.prepare('DELETE FROM cosmetics WHERE id=?').run(id);
      this.audit(actor, 'catalog.delete', { id, name: item.name, slot: item.slot, revision: item.revision, ...counts });
      return { deleted: true, id, ...counts };
    });
  }
  entitlement(input, active, actor) {
    const owner = uuid(input.uuid), id = cosmeticId(input.cosmeticId);
    const reason = (input.reason && input.reason.trim()) ? text(input.reason, 240) : (active ? 'grant' : 'revoke');
    const reference = (input.reference && input.reference.trim()) ? text(input.reference, 100) : `${active ? 'grant' : 'revoke'}-${Date.now()}`;
    const payload = JSON.stringify({ owner, id, active, reason });
    return this.transaction(() => {
      this.cosmetic(id);
      const old = this.db.prepare('SELECT payload FROM operations WHERE reference=?').get(reference);
      if (old) { requireThat(old.payload === payload, 'Referencia ya usada para otra operación', 409); return { duplicate: true }; }
      this.db.prepare('INSERT INTO operations VALUES(?,?)').run(reference, payload);
      this.db.prepare('INSERT INTO entitlements VALUES(?,?,?) ON CONFLICT(uuid,cosmetic_id) DO UPDATE SET active=excluded.active').run(owner, id, active ? 1 : 0);
      if (!active) this.db.prepare('DELETE FROM equipment WHERE uuid=? AND cosmetic_id=?').run(owner, id);
      this.audit(actor, active ? 'entitlement.grant' : 'entitlement.revoke', { uuid: owner, cosmeticId: id, reason, reference });
      return { duplicate: false };
    });
  }
  owners(id, offset = 0) {
    this.cosmetic(id);
    return this.db.prepare('SELECT e.uuid,p.name,p.verified_at FROM entitlements e LEFT JOIN players p ON p.uuid=e.uuid WHERE cosmetic_id=? AND active=1 ORDER BY e.uuid LIMIT 50 OFFSET ?').all(id, offset);
  }
  verifiedPlayer(owner, name) {
    this.db.prepare('INSERT INTO players VALUES(?,?,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,verified_at=excluded.verified_at').run(uuid(owner), text(name, 16), Date.now());
  }
  verifiedPlayerByName(name) {
    requireThat(typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name), 'Nombre de Minecraft inválido');
    return this.db.prepare('SELECT uuid,name FROM players WHERE name=? COLLATE NOCASE ORDER BY verified_at DESC LIMIT 1').get(name);
  }
  wardrobe(owner) {
    owner = uuid(owner);
    return {
      uuid: owner,
      owned: this.db.prepare("SELECT c.* FROM entitlements e JOIN cosmetics c ON c.id=e.cosmetic_id WHERE e.uuid=? AND e.active=1 AND c.slot<>'SKIN' ORDER BY c.id").all(owner),
      equipped: this.appearance(owner),
    };
  }
  appearance(owner) {
    return this.db.prepare("SELECT q.slot,q.cosmetic_id AS cosmeticId FROM equipment q JOIN entitlements e ON e.uuid=q.uuid AND e.cosmetic_id=q.cosmetic_id JOIN cosmetics c ON c.id=q.cosmetic_id WHERE q.uuid=? AND e.active=1 AND c.status='published' AND c.slot<>'SKIN' ORDER BY q.slot").all(uuid(owner));
  }
  equip(owner, slot, id) {
    owner = uuid(owner);
    requireThat(SLOTS.includes(slot), 'Categoría inválida');
    return this.transaction(() => {
      if (id === null) this.db.prepare('DELETE FROM equipment WHERE uuid=? AND slot=?').run(owner, slot);
      else {
        const cosmetic = this.cosmetic(id);
        requireThat(cosmetic.slot === slot && cosmetic.status === 'published', 'Cosmético no equipable', 409);
        requireThat(this.db.prepare('SELECT 1 FROM entitlements WHERE uuid=? AND cosmetic_id=? AND active=1').get(owner, id), 'No posees este cosmético', 403);
        this.db.prepare('INSERT INTO equipment VALUES(?,?,?) ON CONFLICT(uuid,slot) DO UPDATE SET cosmetic_id=excluded.cosmetic_id').run(owner, slot, id);
      }
      return this.appearance(owner);
    });
  }
  menu() {
    const row = this.db.prepare('SELECT * FROM menus ORDER BY revision DESC LIMIT 1').get();
    return { revision: row?.revision ?? 0, config: row ? JSON.parse(row.config) : structuredClone(DEFAULT_MENU) };
  }
  saveMenu(input, actor) {
    const config = validateMenu(input.config);
    return this.transaction(() => {
      requireThat(input.expectedRevision === this.menu().revision, 'Revisión de menú desactualizada', 409);
      this.db.prepare('INSERT INTO menus(config) VALUES(?)').run(JSON.stringify(config));
      const result = this.menu();
      this.audit(actor, 'menu.publish', result);
      return result;
    });
  }
  menuHistory(offset = 0) {
    return this.db.prepare('SELECT revision,config FROM menus ORDER BY revision DESC LIMIT 50 OFFSET ?').all(offset)
      .map(row => ({ revision: row.revision, config: JSON.parse(row.config) }));
  }
  restoreMenu(input, actor) {
    requireThat(Number.isSafeInteger(input.revision) && input.revision > 0, 'Revisión inválida');
    const old = this.db.prepare('SELECT config FROM menus WHERE revision=?').get(input.revision);
    requireThat(old, 'Revisión no encontrada', 404);
    // Restoration publishes a new revision: never deletes intervening history.
    return this.saveMenu({ expectedRevision: input.expectedRevision, config: JSON.parse(old.config) }, actor);
  }
  deleteMenuEntry(input, actor) {
    requireThat(Number.isSafeInteger(input.revision) && input.revision > 0, 'Revisión inválida');
    const current = this.menu().revision;
    requireThat(input.revision !== current, 'No se puede eliminar la configuración activa', 409);
    const row = this.db.prepare('SELECT revision FROM menus WHERE revision=?').get(input.revision);
    requireThat(row, 'Revisión no encontrada', 404);
    this.db.prepare('DELETE FROM menus WHERE revision=?').run(input.revision);
    this.audit(actor, 'menu.delete', { revision: input.revision });
    return { deleted: input.revision };
  }
  auditPage(offset = 0) { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50 OFFSET ?').all(offset); }

  // ── MineLatino player accounts ─────────────────────────────────────────

  publicPlayerAccount(row) {
    if (!row) return undefined;
    return { accountId: row.account_id, email: row.email, nick: row.nick, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at ?? null };
  }

  createPlayerAccount(input) {
    const now = Date.now();
    requireThat(!this.db.prepare("SELECT 1 FROM player_accounts WHERE nick=? COLLATE NOCASE AND status='active'").get(input.nick),
      'Ya existe una cuenta activa con ese nick', 409);
    this.db.prepare(`INSERT INTO player_accounts(account_id,email,nick,password_hash,password_salt,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)`).run(input.accountId, input.email, input.nick, input.passwordHash, input.passwordSalt, now, now);
    this.audit(`account:${input.accountId}`, 'player-account.create', { accountId: input.accountId, nick: input.nick });
    return this.publicPlayerAccount(this.accountById(input.accountId, true));
  }

  accountByEmail(email, includePrivate = false) {
    const row = this.db.prepare('SELECT * FROM player_accounts WHERE email=? COLLATE NOCASE').get(email);
    return includePrivate ? row : this.publicPlayerAccount(row);
  }

  accountById(accountId, includePrivate = false) {
    requireThat(typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId), 'ID de cuenta inválido');
    const row = this.db.prepare('SELECT * FROM player_accounts WHERE account_id=?').get(accountId);
    return includePrivate ? row : this.publicPlayerAccount(row);
  }

  listPlayerAccounts(query = '', offset = 0) {
    const q = `%${String(query).trim().toLowerCase()}%`;
    return this.db.prepare(`SELECT account_id,email,nick,status,created_at,updated_at,deleted_at FROM player_accounts
      WHERE lower(email) LIKE ? OR lower(nick) LIKE ? OR account_id LIKE ? ORDER BY created_at DESC LIMIT 50 OFFSET ?`)
      .all(q, q, q, offset).map(row => this.publicPlayerAccount(row));
  }

  updatePlayerAccount(accountId, input, actor = `account:${accountId}`) {
    const row = this.accountById(accountId, true); requireThat(row, 'Cuenta no encontrada', 404);
    const email = input.email === undefined ? row.email : input.email.trim().toLowerCase();
    const nick = input.nick === undefined ? row.nick : input.nick;
    const status = input.status === undefined ? row.status : input.status;
    requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254, 'Correo inválido');
    requireThat(/^[A-Za-z0-9_]{3,16}$/.test(nick), 'Nick inválido');
    requireThat(['active','suspended','deleted'].includes(status), 'Estado inválido');
    const duplicate = this.db.prepare('SELECT account_id FROM player_accounts WHERE email=? COLLATE NOCASE AND account_id<>?').get(email, accountId);
    requireThat(!duplicate, 'Ya existe una cuenta con ese correo', 409);
    const duplicateNick = this.db.prepare(`SELECT account_id FROM player_accounts
      WHERE nick=? COLLATE NOCASE AND status='active' AND account_id<>?`).get(nick, accountId);
    requireThat(status !== 'active' || !duplicateNick, 'Ya existe una cuenta activa con ese nick', 409);
    const passwordHash = input.passwordHash ?? row.password_hash, passwordSalt = input.passwordSalt ?? row.password_salt;
    const now = Date.now(), deletedAt = status === 'deleted' ? (row.deleted_at ?? now) : null;
    this.db.prepare(`UPDATE player_accounts SET email=?,nick=?,status=?,password_hash=?,password_salt=?,updated_at=?,deleted_at=? WHERE account_id=?`)
      .run(email, nick, status, passwordHash, passwordSalt, now, deletedAt, accountId);
    if (status !== 'active') this.deleteAccountSessions(accountId);
    this.audit(actor, 'player-account.update', { accountId, nick, status, emailChanged: email !== row.email });
    return this.accountById(accountId);
  }

  deletePlayerAccount(accountId, actor) {
    const result = this.updatePlayerAccount(accountId, { status: 'deleted' }, actor);
    this.db.prepare('DELETE FROM account_presence WHERE account_id=?').run(accountId);
    this.audit(actor, 'player-account.delete', { accountId });
    return result;
  }

  purgePlayerAccount(accountId, actor) {
    const row = this.accountById(accountId, true);
    requireThat(row, 'Cuenta no encontrada', 404);
    const deletedAt = Date.now();
    const account = { ...this.publicPlayerAccount(row), status: 'deleted', deletedAt };
    const fingerprint = createHash('sha256').update(accountId).digest('hex').slice(0, 16);
    return this.transaction(() => {
      let deletedOrders = 0;
      const hasOrders = !!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cosmetic_orders'").get();
      if (hasOrders) {
        const reservations = this.db.prepare(`SELECT cosmetic_id,COUNT(*) count FROM cosmetic_orders
          WHERE owner_type='account' AND owner=? AND status='pending' AND stock_reserved=1 GROUP BY cosmetic_id`).all(accountId);
        for (const reservation of reservations) {
          this.db.prepare(`UPDATE cosmetic_products SET stock_remaining=stock_remaining+?
            WHERE cosmetic_id=? AND stock_mode='limited'`).run(Number(reservation.count), reservation.cosmetic_id);
        }
        deletedOrders = Number(this.db.prepare("DELETE FROM cosmetic_orders WHERE owner_type='account' AND owner=?").run(accountId).changes);
      }
      // Every account-owned table uses ON DELETE CASCADE. Removing the parent
      // releases the unique email and nick while revoking all current sessions.
      this.db.prepare('DELETE FROM player_accounts WHERE account_id=?').run(accountId);
      // A permanent deletion must not leave the opaque account ID or nick in
      // historical JSON. Keep only a one-way fingerprint in the new admin event.
      this.db.prepare("DELETE FROM audit WHERE actor=? OR instr(payload,?)>0").run(`account:${accountId}`, accountId);
      this.audit(actor, 'player-account.purge', { accountFingerprint: fingerprint, deletedOrders });
      return account;
    });
  }

  createAccountSession(tokenHash, accountId, scope, expiresAt, now) {
    this.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(now);
    this.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run(tokenHash, accountId, scope, expiresAt, now, now);
  }
  accountSession(tokenHash) { return this.db.prepare('SELECT * FROM account_sessions WHERE token_hash=?').get(tokenHash); }
  touchAccountSession(tokenHash, now) { this.db.prepare('UPDATE account_sessions SET last_used_at=? WHERE token_hash=?').run(now, tokenHash); }
  deleteAccountSession(tokenHash) { this.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(tokenHash); }
  deleteAccountSessions(accountId) { this.db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(accountId); }

  // ── AFK Farm metered usage ───────────────────────────────────────────

  afkBalance(accountId) {
    requireThat(this.accountById(accountId, true), 'Cuenta no encontrada', 404);
    const row = this.db.prepare('SELECT remaining_seconds,updated_at FROM afk_time_balances WHERE account_id=?').get(accountId);
    return { accountId, remainingSeconds: Number(row?.remaining_seconds ?? 0), updatedAt: row?.updated_at ?? null };
  }

  changeAfkBalance(accountId, seconds, mode, actor, reason, now = Date.now()) {
    requireThat(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 315_360_000, 'Tiempo inválido');
    requireThat(['set','add'].includes(mode), 'Operación de tiempo inválida');
    requireThat(typeof reason === 'string' && reason.trim().length <= 200, 'Motivo inválido');
    requireThat(this.accountById(accountId, true), 'Cuenta no encontrada', 404);
    return this.transaction(() => {
      const current = this.afkBalance(accountId).remainingSeconds;
      const remaining = mode === 'set' ? seconds : Math.min(315_360_000, current + seconds);
      this.db.prepare(`INSERT INTO afk_time_balances(account_id,remaining_seconds,updated_at) VALUES(?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET remaining_seconds=excluded.remaining_seconds,updated_at=excluded.updated_at`)
        .run(accountId, remaining, now);
      this.audit(actor, 'afk-time.change', { accountId, mode, seconds, previousSeconds: current, remainingSeconds: remaining, reason: reason.trim() });
      return { accountId, remainingSeconds: remaining, updatedAt: now };
    });
  }

  activeAfkSession(accountId) {
    return this.db.prepare("SELECT * FROM afk_usage_sessions WHERE account_id=? AND status='active'").get(accountId);
  }

  createAfkSession(accountId, id, now) {
    this.db.prepare("UPDATE afk_usage_sessions SET status='stopped',stopped_at=? WHERE account_id=? AND status='active'").run(now, accountId);
    this.db.prepare("INSERT INTO afk_usage_sessions(id,account_id,status,started_at,last_heartbeat_at) VALUES(?,?,'active',?,?)")
      .run(id, accountId, now, now);
    return this.afkSession(accountId, id);
  }

  afkSession(accountId, id) {
    return this.db.prepare('SELECT * FROM afk_usage_sessions WHERE id=? AND account_id=?').get(id, accountId);
  }

  settleAfkSession(accountId, id, now, stop = false) {
    return this.transaction(() => {
      const session = this.afkSession(accountId, id);
      requireThat(session, 'Sesión AFK no encontrada', 404);
      const balance = this.afkBalance(accountId).remainingSeconds;
      if (session.status !== 'active') return { session, remainingSeconds: balance, exhausted: session.status === 'exhausted' || balance === 0 };
      // A missing client cannot spend unlimited time. Heartbeats normally arrive
      // every 20 s; the 60 s cap closes the crash/network-loss window safely.
      const elapsed = Math.min(60, Math.max(0, Math.floor((now - session.last_heartbeat_at) / 1000)));
      const consumed = Math.min(balance, elapsed), remaining = balance - consumed;
      const status = remaining === 0 ? 'exhausted' : (stop ? 'stopped' : 'active');
      this.db.prepare(`INSERT INTO afk_time_balances(account_id,remaining_seconds,updated_at) VALUES(?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET remaining_seconds=excluded.remaining_seconds,updated_at=excluded.updated_at`)
        .run(accountId, remaining, now);
      this.db.prepare('UPDATE afk_usage_sessions SET status=?,last_heartbeat_at=?,stopped_at=?,consumed_seconds=consumed_seconds+? WHERE id=?')
        .run(status, now, status === 'active' ? null : now, consumed, id);
      return { session: this.afkSession(accountId, id), remainingSeconds: remaining, exhausted: remaining === 0 };
    });
  }

  // ── MineLatino AI assistant ──────────────────────────────────────────

  ensureAiConversation(accountId, conversationId, now = Date.now()) {
    requireThat(this.accountById(accountId, true)?.status === 'active', 'La cuenta no está activa', 403);
    const existing = this.db.prepare('SELECT account_id FROM ai_conversations WHERE id=?').get(conversationId);
    requireThat(!existing || existing.account_id === accountId, 'Conversación no disponible', 404);
    if (!existing) this.db.prepare('INSERT INTO ai_conversations VALUES(?,?,?,?)').run(conversationId, accountId, now, now);
    return conversationId;
  }

  aiContext(accountId, conversationId, limit) {
    requireThat(this.db.prepare('SELECT 1 FROM ai_conversations WHERE id=? AND account_id=?').get(conversationId, accountId), 'Conversación no disponible', 404);
    return this.db.prepare(`SELECT role,content FROM (SELECT id,role,content,created_at FROM ai_messages
      WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT ?) ORDER BY created_at,id`).all(conversationId, limit);
  }

  aiRequest(accountId, requestId) {
    return this.db.prepare('SELECT * FROM ai_requests WHERE account_id=? AND request_id=?').get(accountId, requestId);
  }

  beginAiRequest(accountId, requestId, conversationId, now = Date.now()) {
    this.db.prepare("INSERT INTO ai_requests VALUES(?,?,?,'pending',NULL,?,NULL)").run(accountId, requestId, conversationId, now);
  }

  completeAiRequest(accountId, requestId, conversationId, userContent, assistantContent, usage = {}, now = Date.now()) {
    return this.transaction(() => {
      const request = this.aiRequest(accountId, requestId);
      requireThat(request?.status === 'pending' && request.conversation_id === conversationId, 'Solicitud no disponible', 409);
      const userId = randomUUID(), assistantId = randomUUID();
      this.db.prepare("INSERT INTO ai_messages VALUES(?,?, 'user',?,?)").run(userId, conversationId, userContent, now);
      this.db.prepare("INSERT INTO ai_messages VALUES(?,?, 'assistant',?,?)").run(assistantId, conversationId, assistantContent, now + 1);
      this.db.prepare("UPDATE ai_requests SET status='complete',response_message_id=?,completed_at=? WHERE account_id=? AND request_id=?")
        .run(assistantId, now + 1, accountId, requestId);
      this.db.prepare('UPDATE ai_conversations SET updated_at=? WHERE id=?').run(now + 1, conversationId);
      const inputTokens = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 ? usage.inputTokens : 0;
      const outputTokens = Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 ? usage.outputTokens : 0;
      this.db.prepare('INSERT INTO ai_usage(account_id,conversation_id,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?)')
        .run(accountId, conversationId, inputTokens, outputTokens, now + 1);
      return { conversationId, message: { id: assistantId, role: 'assistant', content: assistantContent, createdAt: now + 1 },
        usage: { inputTokens, outputTokens } };
    });
  }

  aiCompletedResponse(accountId, requestId) {
    const row = this.db.prepare(`SELECT r.conversation_id,m.id,m.role,m.content,m.created_at FROM ai_requests r
      JOIN ai_messages m ON m.id=r.response_message_id WHERE r.account_id=? AND r.request_id=? AND r.status='complete'`).get(accountId, requestId);
    requireThat(row, 'Respuesta no disponible', 404);
    return { conversationId: row.conversation_id,
      message: { id: row.id, role: row.role, content: row.content, createdAt: row.created_at }, replayed: true };
  }

  failAiRequest(accountId, requestId) {
    this.db.prepare("DELETE FROM ai_requests WHERE account_id=? AND request_id=? AND status='pending'").run(accountId, requestId);
  }

  aiUsageSince(accountId, since) {
    const row = this.db.prepare(`SELECT COUNT(*) requests,COALESCE(SUM(input_tokens),0) inputTokens,
      COALESCE(SUM(output_tokens),0) outputTokens FROM ai_usage WHERE account_id=? AND created_at>=?`).get(accountId, since);
    return { requests: Number(row.requests), inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens) };
  }

  createPasswordReset(accountId, tokenHash, expiresAt, actor = 'system', now = Date.now()) {
    requireThat(this.accountById(accountId, true), 'Cuenta no encontrada', 404);
    this.transaction(() => {
      this.db.prepare('DELETE FROM password_reset_tokens WHERE expires_at<=? OR account_id=?').run(now, accountId);
      this.db.prepare('INSERT INTO password_reset_tokens(token_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)')
        .run(tokenHash, accountId, expiresAt, now);
      this.audit(actor, 'player-account.password-reset.issue', { accountId, expiresAt });
    });
  }

  consumePasswordReset(email, tokenHash, credentials, now = Date.now()) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT r.*,a.email,a.status FROM password_reset_tokens r
        JOIN player_accounts a ON a.account_id=r.account_id
        WHERE r.token_hash=? AND a.email=? COLLATE NOCASE AND a.status='active'
          AND r.consumed_at IS NULL AND r.expires_at>?`).get(tokenHash, email, now);
      requireThat(row, 'Código de recuperación inválido o caducado', 400);
      this.db.prepare('UPDATE password_reset_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(now, tokenHash);
      this.db.prepare('UPDATE player_accounts SET password_hash=?,password_salt=?,updated_at=? WHERE account_id=?')
        .run(credentials.passwordHash, credentials.passwordSalt, now, row.account_id);
      this.deleteAccountSessions(row.account_id);
      this.db.prepare('DELETE FROM password_reset_tokens WHERE account_id=? AND token_hash<>?').run(row.account_id, tokenHash);
      this.audit(`account:${row.account_id}`, 'player-account.password-reset.consume', { accountId: row.account_id });
      return this.accountById(row.account_id);
    });
  }

  accountEntitlement(input, active, actor) {
    const accountId = input.accountId, id = cosmeticId(input.cosmeticId);
    requireThat(this.accountById(accountId, true), 'Cuenta no encontrada', 404); this.cosmetic(id);
    this.db.prepare(`INSERT INTO account_entitlements VALUES(?,?,?) ON CONFLICT(account_id,cosmetic_id)
      DO UPDATE SET active=excluded.active`).run(accountId, id, active ? 1 : 0);
    if (!active) this.db.prepare('DELETE FROM account_equipment WHERE account_id=? AND cosmetic_id=?').run(accountId, id);
    this.audit(actor, active ? 'account-entitlement.grant' : 'account-entitlement.revoke', { accountId, cosmeticId: id });
    return { active };
  }

  accountOwners(id, offset = 0) {
    id = cosmeticId(id); this.cosmetic(id);
    return this.db.prepare(`SELECT a.account_id AS accountId,a.email,a.nick,a.status,a.created_at AS createdAt
      FROM account_entitlements e JOIN player_accounts a ON a.account_id=e.account_id
      WHERE e.cosmetic_id=? AND e.active=1 ORDER BY lower(a.nick),a.account_id LIMIT 50 OFFSET ?`).all(id, offset);
  }

  accountAppearance(accountId) {
    return this.db.prepare(`SELECT q.slot,q.cosmetic_id AS cosmeticId FROM account_equipment q
      JOIN account_entitlements e ON e.account_id=q.account_id AND e.cosmetic_id=q.cosmetic_id
      JOIN cosmetics c ON c.id=q.cosmetic_id WHERE q.account_id=? AND e.active=1 AND c.status='published' AND c.slot<>'SKIN' ORDER BY q.slot`).all(accountId);
  }

  accountWardrobe(accountId) {
    return { accountId, uuid: accountId, owned: this.db.prepare(`SELECT c.* FROM account_entitlements e JOIN cosmetics c ON c.id=e.cosmetic_id
      WHERE e.account_id=? AND e.active=1 AND c.slot<>'SKIN' ORDER BY c.id`).all(accountId), equipped: this.accountAppearance(accountId) };
  }

  accountEquip(accountId, slot, id) {
    requireThat(SLOTS.includes(slot), 'Categoría inválida');
    if (id === null) this.db.prepare('DELETE FROM account_equipment WHERE account_id=? AND slot=?').run(accountId, slot);
    else {
      const cosmetic = this.cosmetic(id);
      requireThat(cosmetic.slot === slot && cosmetic.status === 'published', 'Cosmético no equipable', 409);
      requireThat(this.db.prepare('SELECT 1 FROM account_entitlements WHERE account_id=? AND cosmetic_id=? AND active=1').get(accountId, id), 'No posees este cosmético', 403);
      this.db.prepare(`INSERT INTO account_equipment VALUES(?,?,?) ON CONFLICT(account_id,slot)
        DO UPDATE SET cosmetic_id=excluded.cosmetic_id`).run(accountId, slot, id);
    }
    return this.accountAppearance(accountId);
  }

  updateAccountPresence(accountId, profileUuid, name, now = Date.now()) {
    profileUuid = uuid(profileUuid); name = text(name, 16);
    requireThat(/^[A-Za-z0-9_]{3,16}$/.test(name), 'Nombre de Minecraft inválido');
    const duplicateNick = this.db.prepare(`SELECT COUNT(*) count FROM player_accounts
      WHERE nick=? COLLATE NOCASE AND status='active'`).get(name).count;
    requireThat(duplicateNick === 1, 'Este nick pertenece a varias cuentas; elige un nick único para mostrar cosméticos', 409);
    requireThat(profileUuid === offlineUuid(name), 'El UUID del servidor no corresponde al nick de tu cuenta', 409);
    const claimed = this.db.prepare('SELECT account_id FROM account_presence WHERE profile_uuid=? AND account_id<>?').get(profileUuid, accountId);
    requireThat(!claimed, 'Esta identidad ya está vinculada a otra cuenta', 409);
    this.db.prepare(`INSERT INTO account_presence VALUES(?,?,?,?) ON CONFLICT(account_id)
      DO UPDATE SET profile_uuid=excluded.profile_uuid,name=excluded.name,updated_at=excluded.updated_at`)
      .run(accountId, profileUuid, name, now);
    return { accountId, profileUuid, name };
  }

  accountAppearanceByIdentity(profileUuid, name, freshAfter) {
    const row = this.db.prepare(`SELECT p.account_id,p.profile_uuid,p.name FROM account_presence p
      JOIN player_accounts a ON a.account_id=p.account_id
      WHERE p.updated_at>=? AND a.status='active'
        AND ((?<>'' AND p.profile_uuid=?) OR (?<>'' AND p.name=? COLLATE NOCASE))
      ORDER BY p.updated_at DESC LIMIT 1`).get(freshAfter, profileUuid, profileUuid, name, name);
    return row ? { accountId: row.account_id, uuid: row.profile_uuid, name: row.name, equipped: this.accountAppearance(row.account_id) } : undefined;
  }

  adminCount() { return this.db.prepare('SELECT COUNT(*) AS count FROM admins').get().count; }

  createAdmin(username, passwordHash, passwordSalt, role = 'admin') {
    requireThat(/^[a-zA-Z0-9_]{2,32}$/.test(username), 'Nombre de administrador inválido');
    requireThat(typeof passwordHash === 'string' && passwordHash.length === 64, 'Hash inválido');
    requireThat(typeof passwordSalt === 'string' && passwordSalt.length === 32, 'Salt inválido');
    requireThat(['admin', 'superadmin'].includes(role), 'Rol inválido');
    requireThat(this.adminCount() < 50, 'Demasiados administradores', 429);
    this.db.prepare('INSERT INTO admins VALUES(?,?,?,?,?)').run(username, passwordHash, passwordSalt, role, Date.now());
    this.audit(username, 'admin.create', { username, role });
    return { username, role, created_at: Date.now() };
  }

  getAdmin(username) { return this.db.prepare('SELECT username,role,created_at FROM admins WHERE username=?').get(username); }

  listAdmins() { return this.db.prepare('SELECT username,role,created_at FROM admins ORDER BY username').all(); }

  deleteAdmin(username, actor) {
    requireThat(this.adminCount() > 1, 'No se puede eliminar el último administrador');
    const admin = this.getAdmin(username);
    requireThat(admin, 'Administrador no encontrado', 404);
    this.db.prepare('DELETE FROM admins WHERE username=?').run(username);
    this.audit(actor, 'admin.delete', { username });
    return { deleted: true };
  }

  // ── Player search ───────────────────────────────────────────────────────

  searchPlayers(query, offset = 0) {
    const q = query.trim().toLowerCase();
    requireThat(q.length >= 2, 'Búsqueda demasiado corta');
    if (/^[a-f0-9]{6,32}$/.test(q)) {
      return this.db.prepare('SELECT uuid,name,verified_at FROM players WHERE uuid LIKE ? ORDER BY name LIMIT 50 OFFSET ?').all(`%${q}%`, offset);
    }
    return this.db.prepare('SELECT uuid,name,verified_at FROM players WHERE name LIKE ? ORDER BY name LIMIT 50 OFFSET ?').all(`%${q}%`, offset);
  }

  // ── Cosmetic resources ─────────────────────────────────────────────

  saveResource(id, filePath, sha256, fileSize, contentType) {
    id = cosmeticId(id);
    this.cosmetic(id); // verify exists
    this.db.prepare('INSERT INTO resources(cosmetic_id,file_path,sha256,file_size,content_type,uploaded_at) VALUES(?,?,?,?,?,?) ON CONFLICT(cosmetic_id) DO UPDATE SET file_path=excluded.file_path,sha256=excluded.sha256,file_size=excluded.file_size,content_type=excluded.content_type,uploaded_at=excluded.uploaded_at')
      .run(id, filePath, sha256, fileSize, contentType, Date.now());
    return this.getResource(id);
  }

  saveResourceModel(id, modelPath, modelSha256, modelSize) {
    id = cosmeticId(id);
    this.cosmetic(id); // verify exists
    this.db.prepare('UPDATE resources SET model_path=?, model_sha256=?, model_size=? WHERE cosmetic_id=?')
      .run(modelPath, modelSha256, modelSize, id);
    return this.getResource(id);
  }

  savePetAnimation(id, animationName, filePath, sha256, fileSize, actor) {
    id = cosmeticId(id);
    const item = this.cosmetic(id);
    requireThat(item.slot === 'PET', 'Las animaciones solo se pueden asignar a mascotas');
    requireThat(typeof animationName === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(animationName), 'Nombre de animación inválido');
    this.db.prepare(`INSERT INTO pet_animations(cosmetic_id,animation_name,file_path,sha256,file_size,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(cosmetic_id) DO UPDATE SET animation_name=excluded.animation_name,
      file_path=COALESCE(excluded.file_path,pet_animations.file_path),sha256=COALESCE(excluded.sha256,pet_animations.sha256),
      file_size=COALESCE(excluded.file_size,pet_animations.file_size),updated_at=excluded.updated_at`)
      .run(id, animationName, filePath, sha256, fileSize, Date.now());
    this.audit(actor, 'pet.animation.save', { cosmeticId: id, animationName, fileSize });
    return this.getPetAnimation(id);
  }

  getPetAnimation(id) {
    return this.db.prepare('SELECT * FROM pet_animations WHERE cosmetic_id=?').get(cosmeticId(id));
  }

  deletePetAnimation(id, actor) {
    const old = this.getPetAnimation(id);
    if (old) this.db.prepare('DELETE FROM pet_animations WHERE cosmetic_id=?').run(cosmeticId(id));
    if (old) this.audit(actor, 'pet.animation.delete', { cosmeticId: id });
    return old;
  }

  getResource(id) {
    return this.db.prepare('SELECT * FROM resources WHERE cosmetic_id=?').get(cosmeticId(id));
  }

  hasTexture(id) {
    id = cosmeticId(id);
    const legacy = this.getResource(id);
    return !!legacy?.file_path || this.resourceFileCount(id) > 0;
  }

  product(id) {
    const row = this.db.prepare('SELECT * FROM cosmetic_products WHERE cosmetic_id=?').get(cosmeticId(id));
    return {
      description: row?.description ?? '', amountMinor: row?.amount_minor ?? null, currency: row?.currency ?? 'USD',
      stockMode: row?.stock_mode === 'limited' ? 'limited' : 'unlimited',
      stockRemaining: row?.stock_mode === 'limited' ? Number(row.stock_remaining ?? 0) : null,
    };
  }

  deleteResource(id) {
    const res = this.getResource(id);
    if (res) this.db.prepare('DELETE FROM resources WHERE cosmetic_id=?').run(cosmeticId(id));
    return res;
  }

  // ── Multi-file resources (textures + mcmeta) ─────────────────────

  saveResourceFile(id, name, filePath, sha256, fileSize) {
    id = cosmeticId(id);
    this.cosmetic(id);
    requireThat(/^[a-z0-9_]{1,32}$/.test(name), 'Nombre de archivo inválido');
    this.db.prepare('INSERT INTO resource_files(cosmetic_id,name,file_path,sha256,file_size,uploaded_at) VALUES(?,?,?,?,?,?) ON CONFLICT(cosmetic_id,name) DO UPDATE SET file_path=excluded.file_path,sha256=excluded.sha256,file_size=excluded.file_size,uploaded_at=excluded.uploaded_at')
      .run(id, name, filePath, sha256, fileSize, Date.now());
    return this.getResourceFile(id, name);
  }

  saveResourceFileMcmeta(id, name, mcmetaPath, mcmetaSize) {
    id = cosmeticId(id);
    requireThat(/^[a-z0-9_]{1,32}$/.test(name), 'Nombre de archivo inválido');
    this.db.prepare('UPDATE resource_files SET mcmeta_path=?, mcmeta_size=?, uploaded_at=? WHERE cosmetic_id=? AND name=?')
      .run(mcmetaPath, mcmetaSize, Date.now(), id, name);
    return this.getResourceFile(id, name);
  }

  getResourceFile(id, name) {
    return this.db.prepare('SELECT * FROM resource_files WHERE cosmetic_id=? AND name=?').get(cosmeticId(id), name);
  }

  getResourceFiles(id) {
    return this.db.prepare('SELECT * FROM resource_files WHERE cosmetic_id=? ORDER BY name').all(cosmeticId(id));
  }

  resourceFileCount(id) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM resource_files WHERE cosmetic_id=?').get(cosmeticId(id)).count;
  }

  deleteResourceFile(id, name) {
    const file = this.getResourceFile(id, name);
    if (file) this.db.prepare('DELETE FROM resource_files WHERE cosmetic_id=? AND name=?').run(cosmeticId(id), name);
    return file;
  }

  deleteResourceFileMcmeta(id, name) {
    this.db.prepare('UPDATE resource_files SET mcmeta_path=NULL, mcmeta_size=NULL WHERE cosmetic_id=? AND name=?')
      .run(cosmeticId(id), name);
    return this.getResourceFile(id, name);
  }

  // ── Cosmetic transforms (position/rotation/scale per slot) ─────────

  getTransforms(id) {
    id = cosmeticId(id);
    this.cosmetic(id);
    const rows = this.db.prepare('SELECT * FROM cosmetic_transforms WHERE cosmetic_id=?').all(id);
    const result = {};
    for (const row of rows) {
      result[row.slot] = {
        translation: [row.translation_x, row.translation_y, row.translation_z],
        rotation: [row.rotation_x, row.rotation_y, row.rotation_z],
        scale: [row.scale_x, row.scale_y, row.scale_z],
        updatedAt: row.updated_at
      };
    }
    return result;
  }

  saveTransform(id, slot, transform, actor) {
    id = cosmeticId(id);
    const item = this.cosmetic(id);
    slot = slot === 'head' ? 'hat' : slot;
    requireThat(TRANSFORM_SLOTS.includes(slot), 'Tipo de cosmético inválido');
    requireThat(item.slot.toLowerCase() === slot, 'El transform debe coincidir con el tipo del cosmético', 409);
    requireThat(transform && typeof transform === 'object', 'Transform inválido');
    const t = Array.isArray(transform.translation) ? transform.translation : [0, 0, 0];
    const r = Array.isArray(transform.rotation) ? transform.rotation : [0, 0, 0];
    const s = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];
    requireThat(t.length === 3 && r.length === 3 && s.length === 3, 'Transform debe tener 3 valores por eje');
    for (const v of [...t, ...r, ...s]) requireThat(Number.isFinite(v), 'Valores de transform deben ser números finitos');
    requireThat(t.every(v => Math.abs(v) <= 1024), 'La posición excede el límite permitido');
    requireThat(r.every(v => Math.abs(v) <= 36000), 'La rotación excede el límite permitido');
    requireThat(s.every(v => v > 0 && v <= 100), 'La escala debe ser mayor que 0 y como máximo 100');
    this.db.prepare(`INSERT INTO cosmetic_transforms(cosmetic_id, slot, translation_x, translation_y, translation_z, rotation_x, rotation_y, rotation_z, scale_x, scale_y, scale_z, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cosmetic_id, slot) DO UPDATE SET
      translation_x=excluded.translation_x, translation_y=excluded.translation_y, translation_z=excluded.translation_z,
      rotation_x=excluded.rotation_x, rotation_y=excluded.rotation_y, rotation_z=excluded.rotation_z,
      scale_x=excluded.scale_x, scale_y=excluded.scale_y, scale_z=excluded.scale_z, updated_at=excluded.updated_at`)
      .run(id, slot, t[0], t[1], t[2], r[0], r[1], r[2], s[0], s[1], s[2], Date.now());
    this.audit(actor, 'transform.save', { id, slot, transform: { translation: t, rotation: r, scale: s } });
    return this.getTransforms(id);
  }

  getAllTransforms() {
    const rows = this.db.prepare('SELECT cosmetic_id, slot, translation_x, translation_y, translation_z, rotation_x, rotation_y, rotation_z, scale_x, scale_y, scale_z FROM cosmetic_transforms WHERE slot<>\'skin\'').all();
    const result = {};
    for (const row of rows) {
      if (!result[row.cosmetic_id]) result[row.cosmetic_id] = {};
      const value = {
        translation: [row.translation_x, row.translation_y, row.translation_z],
        rotation: [row.rotation_x, row.rotation_y, row.rotation_z],
        scale: [row.scale_x, row.scale_y, row.scale_z]
      };
      result[row.cosmetic_id][row.slot] = value;
      // alpha.14 and older request the legacy name for hats during the rolling update.
      if (row.slot === 'hat') result[row.cosmetic_id].head = value;
    }
    return result;
  }
}
