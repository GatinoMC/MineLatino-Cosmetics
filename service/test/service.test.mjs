import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store, validateMenu, DEFAULT_MENU, offlineUuid } from '../src/store.mjs';
import { PlayerAuth, verifyMojang } from '../src/auth.mjs';
import { AdminAuth } from '../src/adminAuth.mjs';
import { AccountAuth } from '../src/accountAuth.mjs';
import { createApi } from '../src/api.mjs';
import { createHttpServer } from '../src/http.mjs';
import { AiService, createAiServiceFromEnv } from '../src/ai.mjs';
import { AfkUsageService } from '../src/afkUsage.mjs';
import { DatabaseSync } from 'node:sqlite';

const OWNER = '1234567890abcdef1234567890abcdef';
const OTHER = 'abcdef1234567890abcdef1234567890';
const ADMIN = 'test-only-admin-token-not-for-deployment-123456';
const catalog = { name: 'Capa de prueba', slot: 'CAPE', status: 'published', expectedRevision: 0 };
const grant = { uuid: OWNER, cosmeticId: 'cape', reference: 'manual-1', reason: 'Prueba' };

test('backpack and pet equip in independent slots and are visible through public appearance', async t => {
  const { store, request, login } = fixture(t);
  const token = await login();
  for (const [id, slot] of [['pack', 'BACKPACK'], ['pet', 'PET']]) {
    store.saveCosmetic(id, { ...catalog, name: id, slot }, 'test');
    store.entitlement({ ...grant, cosmeticId: id, reference: id }, true, 'test');
    const saved = await request('/v1/cosmetics/me/equipment', { token, method: 'PUT', data: { slot, cosmeticId: id } });
    assert.equal(saved.status, 200);
  }
  const publicView = await request(`/v1/cosmetics/appearance?uuids=${OWNER}`);
  assert.deepEqual(publicView.data.players[0].equipped, [
    { slot: 'BACKPACK', cosmeticId: 'pack' }, { slot: 'PET', cosmeticId: 'pet' },
  ]);
  assert.equal((await request('/v1/cosmetics/me/equipment', { token, method: 'PUT', data: { slot: 'HAT', cosmeticId: 'pet' } })).status, 409);
  await request('/v1/cosmetics/me/equipment', { token, method: 'PUT', data: { slot: 'PET', cosmeticId: null } });
  assert.deepEqual((await request(`/v1/cosmetics/appearance?uuids=${OWNER}`)).data.players[0].equipped,
    [{ slot: 'BACKPACK', cosmeticId: 'pack' }]);
});

test('v4 slot migration preserves ownership and equipment and is idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'minelatino-slot-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE cosmetics(id TEXT PRIMARY KEY, name TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('CAPE','HAT','WINGS')), status TEXT NOT NULL CHECK(status IN ('draft','published','retired')), revision INTEGER NOT NULL);
    CREATE TABLE entitlements(uuid TEXT NOT NULL, cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id), active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(uuid,cosmetic_id));
    CREATE TABLE equipment(uuid TEXT NOT NULL, slot TEXT NOT NULL, cosmetic_id TEXT NOT NULL, PRIMARY KEY(uuid,slot), FOREIGN KEY(uuid,cosmetic_id) REFERENCES entitlements(uuid,cosmetic_id));
    CREATE TABLE resources(cosmetic_id TEXT PRIMARY KEY REFERENCES cosmetics(id), file_path TEXT NOT NULL, sha256 TEXT NOT NULL, file_size INTEGER NOT NULL, content_type TEXT NOT NULL, uploaded_at INTEGER NOT NULL);
    INSERT INTO cosmetics VALUES('cape','Legacy cape','CAPE','published',7);
    INSERT INTO entitlements VALUES('${OWNER}','cape',1);
    INSERT INTO equipment VALUES('${OWNER}','CAPE','cape');
    INSERT INTO resources VALUES('cape','/fixture/cape.png','fixture-hash',10,'image/png',1);
    PRAGMA user_version=4;`);
  old.close();
  let store = new Store(path);
  try {
    assert.equal(store.wardrobe(OWNER).owned[0].revision, 7);
    assert.equal(store.appearance(OWNER)[0].cosmeticId, 'cape');
    assert.equal(store.db.prepare('SELECT file_path FROM resources').get().file_path, '/fixture/cape.png');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    store.saveCosmetic('pack', { ...catalog, slot: 'BACKPACK' }, 'test');
    store.saveCosmetic('pet', { ...catalog, slot: 'PET' }, 'test');
  } finally { store.close(); }
  store = new Store(path);
  try {
    assert.equal(store.cosmetic('pet').slot, 'PET');
    assert.equal(store.appearance(OWNER)[0].cosmeticId, 'cape');
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { store.close(); }
});

test('all five cosmetic types persist independent transforms and reject mismatched types', t => {
  const { store } = fixture(t);
  for (const [id, catalogSlot, transformSlot] of [
    ['hat', 'HAT', 'hat'], ['cape', 'CAPE', 'cape'], ['wings', 'WINGS', 'wings'],
    ['pack', 'BACKPACK', 'backpack'], ['pet', 'PET', 'pet'],
  ]) {
    store.saveCosmetic(id, { ...catalog, name: id, slot: catalogSlot }, 'test');
    const transform = { translation: [1, 2, 3], rotation: [4, 5, 6], scale: [1.1, 1.2, 1.3] };
    assert.deepEqual(store.saveTransform(id, transformSlot, transform, 'test')[transformSlot].translation, [1, 2, 3]);
  }
  assert.deepEqual(Object.keys(store.getAllTransforms()).sort(), ['cape', 'hat', 'pack', 'pet', 'wings']);
  assert.throws(() => store.saveTransform('cape', 'backpack', { translation: [0, 0, 0] }, 'test'), { status: 409 });
});

test('legacy head/backpack transforms migrate to each cosmetic catalog type', t => {
  const dir = mkdtempSync(join(tmpdir(), 'minelatino-transform-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.sqlite'), old = new DatabaseSync(path);
  old.exec(`CREATE TABLE cosmetics(id TEXT PRIMARY KEY, name TEXT NOT NULL,
      slot TEXT NOT NULL CHECK(slot IN ('CAPE','HAT','WINGS','BACKPACK','PET')),
      status TEXT NOT NULL CHECK(status IN ('draft','published','retired')), revision INTEGER NOT NULL);
    CREATE TABLE cosmetic_transforms(cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
      slot TEXT NOT NULL CHECK(slot IN ('head','backpack')),
      translation_x REAL DEFAULT 0, translation_y REAL DEFAULT 0, translation_z REAL DEFAULT 0,
      rotation_x REAL DEFAULT 0, rotation_y REAL DEFAULT 0, rotation_z REAL DEFAULT 0,
      scale_x REAL DEFAULT 1, scale_y REAL DEFAULT 1, scale_z REAL DEFAULT 1,
      updated_at INTEGER, PRIMARY KEY(cosmetic_id, slot));
    INSERT INTO cosmetics VALUES('pet','Pet','PET','published',1),('cape','Cape','CAPE','published',1);
    INSERT INTO cosmetic_transforms VALUES('pet','head',1,2,3,0,0,0,1,1,1,10),('cape','backpack',4,5,6,0,0,0,2,2,2,11);
    PRAGMA user_version=5;`);
  old.close();
  const store = new Store(path);
  try {
    assert.deepEqual(store.getTransforms('pet').pet.translation, [1, 2, 3]);
    assert.deepEqual(store.getTransforms('cape').cape.scale, [2, 2, 2]);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 10);
  } finally { store.close(); }
});
function fixture(t, options = {}) {
  const store = new Store(); t.after(() => store.close());
  const auth = new PlayerAuth({ verify: async () => ({ uuid: OWNER, name: 'TestPlayer' }) });
  const adminAuth = new AdminAuth({ store, bootstrapToken: ADMIN });
  const accountAuth = new AccountAuth({ store, recovery: options.recovery, now: options.now });
  const ai = options.aiFactory?.(store);
  const afkUsage = new AfkUsageService({ store, now: options.now });
  const api = createApi({ store, adminToken: ADMIN, adminAuth, accountAuth, playerAuth: auth, premiumEnabled: true, ai, afkUsage, ...options });
  const request = async (path, { method = 'GET', data, token, headers = {} } = {}) => {
    const response = await api(new Request(`http://127.0.0.1:8787${path}`, { method,
      headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    }));
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async () => {
    const challenge = await request('/v1/auth/challenge', { method: 'POST', data: { username: 'TestPlayer' } });
    const session = await request('/v1/auth/verify', { method: 'POST', data: { challengeId: challenge.data.challengeId } });
    assert.equal(session.status, 200); return session.data.token;
  };
  return { store, auth, accountAuth, api, request, login };
}

test('MineLatino accounts reject duplicate active nicks', async t => {
  const { store, request } = fixture(t);
  store.saveCosmetic('cape', catalog, 'admin');
  const first = await request('/v1/account/register', { method: 'POST', data: {
    email: 'uno@example.com', password: 'correct-horse-1', nick: 'MismoNick',
  }});
  const second = await request('/v1/account/register', { method: 'POST', data: {
    email: 'dos@example.com', password: 'correct-horse-2', nick: 'MismoNick',
  }});
  assert.equal(first.status, 201); assert.equal(second.status, 409);
  store.accountEntitlement({ accountId: first.data.account.accountId, cosmeticId: 'cape' }, true, 'test');
  assert.equal((await request('/v1/account/wardrobe', { token: first.data.token })).data.owned.length, 1);
});

test('admin account assignments list the owners consumed by the launcher and mod', async t => {
  const { store, request } = fixture(t);
  store.saveCosmetic('cape', catalog, 'admin');
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'owner@example.com', password: 'correct-horse-owner', nick: 'AccountOwner',
  }});
  const accountId = registered.data.account.accountId;
  assert.equal((await request(`/v1/admin/player-accounts/${accountId}/cosmetics`, {
    method: 'POST', token: ADMIN, data: { cosmeticId: 'cape' },
  })).status, 200);
  const owners = await request('/v1/admin/account-cosmetics/owners/cape', { token: ADMIN });
  assert.deepEqual(owners.data.items.map(({ accountId: id, nick }) => ({ id, nick })), [{ id: accountId, nick: 'AccountOwner' }]);
  assert.equal((await request('/v1/account/wardrobe', { token: registered.data.token })).data.owned[0].id, 'cape');
});

test('v9 migrates legacy grants accidentally addressed to a MineLatino account ID', t => {
  const directory = mkdtempSync(join(tmpdir(), 'minelatino-account-grant-migration-'));
  const path = join(directory, 'state.sqlite'); let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true }); });
  store = new Store(path);
  store.createPlayerAccount({ accountId: OWNER, email: 'migrate@example.com', nick: 'MigratedOwner', passwordHash: 'a'.repeat(64), passwordSalt: 'b'.repeat(32) });
  store.saveCosmetic('cape', catalog, 'admin');
  store.entitlement({ ...grant, uuid: OWNER }, true, 'old-panel');
  store.db.exec('PRAGMA user_version=8'); store.close();
  store = new Store(path);
  assert.equal(store.accountWardrobe(OWNER).owned[0].id, 'cape');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 10);
  store.accountEntitlement({ accountId: OWNER, cosmeticId: 'cape' }, false, 'admin');
  store.close(); store = new Store(path);
  assert.equal(store.accountWardrobe(OWNER).owned.length, 0, 'migration must not regrant after an account-native revoke');
});

test('game token equips and publishes account cosmetics for offline identities', async t => {
  const { store, request } = fixture(t);
  store.saveCosmetic('cape', catalog, 'admin');
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'offline@example.com', password: 'correct-horse-3', nick: 'OfflineUser',
  }});
  store.accountEntitlement({ accountId: registered.data.account.accountId, cosmeticId: 'cape' }, true, 'test');
  const game = await request('/v1/account/game-token', { method: 'POST', token: registered.data.token, data: {} });
  assert.equal(game.status, 201); assert.equal(game.data.scope, 'game');
  assert.equal((await request('/v1/account/me', { token: game.data.token })).status, 403);
  assert.deepEqual((await request('/v1/account/session', { token: game.data.token })).data.account,
    { accountId: registered.data.account.accountId, nick: 'OfflineUser', status: 'active' });
  assert.equal((await request('/v1/account/equipment', { method: 'PUT', token: game.data.token,
    data: { slot: 'CAPE', cosmeticId: 'cape' } })).status, 200);
  const offlineId = offlineUuid('OfflineUser');
  assert.equal((await request('/v1/account/presence', { method: 'POST', token: game.data.token,
    data: { uuid: offlineId, name: 'OfflineUser' } })).status, 200);
  assert.equal((await request('/v1/account/presence', { method: 'POST', token: game.data.token,
    data: { uuid: OTHER, name: 'OfflineUser' } })).status, 409);
  const appearance = await request(`/v1/cosmetics/appearance?uuids=${offlineId}&names=OfflineUser`);
  assert.equal(appearance.data.identityMode, 'minelatino-account');
  assert.deepEqual(appearance.data.players[0].equipped, [{ slot: 'CAPE', cosmeticId: 'cape' }]);
});


test('player accounts can update themselves and administrators can suspend or permanently delete them', async t => {
  const { store, request } = fixture(t);
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'manage@example.com', password: 'correct-horse-4', nick: 'ManageMe',
  }});
  const accountId = registered.data.account.accountId;
  assert.equal((await request('/v1/account/me', { method: 'PATCH', token: registered.data.token,
    data: { nick: 'EditedNick', currentPassword: 'wrong-password' } })).status, 401);
  const edited = await request('/v1/account/me', { method: 'PATCH', token: registered.data.token,
    data: { nick: 'EditedNick', currentPassword: 'correct-horse-4' } });
  assert.equal(edited.data.account.nick, 'EditedNick');
  const listed = await request('/v1/admin/player-accounts?q=edited', { token: ADMIN });
  assert.equal(listed.data.items[0].accountId, accountId);
  const suspended = await request(`/v1/admin/player-accounts/${accountId}`, { method: 'PATCH', token: ADMIN,
    data: { status: 'suspended' } });
  assert.equal(suspended.data.account.status, 'suspended');
  assert.equal((await request('/v1/account/me', { token: registered.data.token })).status, 401);
  const deleted = await request(`/v1/admin/player-accounts/${accountId}`, { method: 'DELETE', token: ADMIN });
  assert.equal(deleted.data.account.status, 'deleted'); assert.equal(deleted.data.permanentlyDeleted, true);
  assert.equal(store.accountById(accountId, true), undefined);
  const recreated = await request('/v1/account/register', { method: 'POST', data: {
    email: 'manage@example.com', password: 'new-correct-horse-4', nick: 'EditedNick',
  }});
  assert.equal(recreated.status, 201);
});

test('password recovery uses an expiring one-time code without revealing unknown emails', async t => {
  const delivered = [];
  const recovery = { enabled: true, async send(message) { delivered.push(message); } };
  const { request } = fixture(t, { recovery });
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'recover@example.com', password: 'old-password-123', nick: 'RecoverMe',
  }});
  const unknown = await request('/v1/account/password/forgot', { method: 'POST', data: { email: 'missing@example.com' } });
  const requested = await request('/v1/account/password/forgot', { method: 'POST', data: { email: 'recover@example.com' } });
  await request('/v1/account/password/forgot', { method: 'POST', data: { email: 'recover@example.com' } });
  assert.equal(unknown.status, 202); assert.deepEqual(unknown.data, requested.data);
  assert.equal(requested.data.delivery, 'email'); assert.equal(delivered.length, 1);
  const reset = await request('/v1/account/password/reset', { method: 'POST', data: {
    email: 'recover@example.com', code: delivered[0].code, password: 'new-password-456',
  }});
  assert.equal(reset.status, 200);
  assert.equal((await request('/v1/account/me', { token: registered.data.token })).status, 401);
  assert.equal((await request('/v1/account/login', { method: 'POST', data: {
    email: 'recover@example.com', password: 'old-password-123',
  }})).status, 401);
  assert.equal((await request('/v1/account/login', { method: 'POST', data: {
    email: 'recover@example.com', password: 'new-password-456',
  }})).status, 200);
  assert.equal((await request('/v1/account/password/reset', { method: 'POST', data: {
    email: 'recover@example.com', code: delivered[0].code, password: 'third-password-789',
  }})).status, 400);
});

test('self deletion requires the current password and revokes the account', async t => {
  const { request } = fixture(t);
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'delete@example.com', password: 'delete-password-123', nick: 'DeleteMe',
  }});
  assert.equal((await request('/v1/account/me', { method: 'DELETE', token: registered.data.token,
    data: { currentPassword: 'wrong-password' } })).status, 401);
  assert.equal((await request('/v1/account/me', { method: 'DELETE', token: registered.data.token,
    data: { currentPassword: 'delete-password-123' } })).status, 200);
  assert.equal((await request('/v1/account/me', { token: registered.data.token })).status, 401);
});

test('account login is throttled per identity as well as per address', async t => {
  const { request } = fixture(t);
  await request('/v1/account/register', { method: 'POST', data: {
    email: 'limited@example.com', password: 'correct-password-123', nick: 'LimitedUser',
  }});
  for (let index = 0; index < 10; index++) assert.equal((await request('/v1/account/login', { method: 'POST', data: {
    email: 'limited@example.com', password: 'wrong-password-123',
  }})).status, 401);
  assert.equal((await request('/v1/account/login', { method: 'POST', data: {
    email: 'limited@example.com', password: 'correct-password-123',
  }})).status, 429);
});

test('signed-in password change verifies the old password and revokes every session', async t => {
  const { request } = fixture(t);
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'change@example.com', password: 'current-password-123', nick: 'ChangeMe',
  }});
  assert.equal((await request('/v1/account/password', { method: 'PUT', token: registered.data.token, data: {
    currentPassword: 'incorrect-password', password: 'next-password-456',
  }})).status, 401);
  assert.equal((await request('/v1/account/password', { method: 'PUT', token: registered.data.token, data: {
    currentPassword: 'current-password-123', password: 'next-password-456',
  }})).status, 200);
  assert.equal((await request('/v1/account/me', { token: registered.data.token })).status, 401);
  assert.equal((await request('/v1/account/login', { method: 'POST', data: {
    email: 'change@example.com', password: 'next-password-456',
  }})).status, 200);
});

test('administrator can generate a recovery code but cannot read or set the password', async t => {
  const { request } = fixture(t);
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'assisted@example.com', password: 'initial-password-123', nick: 'Assisted',
  }});
  const issued = await request(`/v1/admin/player-accounts/${registered.data.account.accountId}/password-reset`, {
    method: 'POST', token: ADMIN, data: {},
  });
  assert.equal(issued.status, 201); assert.match(issued.data.code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/);
  assert.equal((await request('/v1/account/password/reset', { method: 'POST', data: {
    email: 'assisted@example.com', code: issued.data.code, password: 'assisted-password-456',
  }})).status, 200);
  assert.equal((await request('/v1/account/login', { method: 'POST', data: {
    email: 'assisted@example.com', password: 'assisted-password-456',
  }})).status, 200);
});

test('administrative reads and writes require admin authorization', async t => {
  const { request, login } = fixture(t);
  for (const token of [undefined, 'wrong', await login()]) {
    assert.equal((await request('/v1/admin/cosmetics/catalog', { token })).status, 401);
    assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { token, method: 'PUT', data: catalog })).status, 401);
    assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { token, method: 'DELETE', data: { expectedRevision: 1 } })).status, 401);
  }
});
test('catalog preserves ownership across edits and rejects stale revisions', async t => {
  const { store, request } = fixture(t);
  const draft = { ...catalog, status: 'draft' };
  assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { token: ADMIN, method: 'PUT', data: draft })).status, 200);
  store.entitlement(grant, true, 'admin');
  const edited = await request('/v1/admin/cosmetics/catalog/cape', { token: ADMIN, method: 'PUT', data: { ...draft, name: 'Nueva capa', expectedRevision: 1 } });
  assert.equal(edited.data.revision, 2);
  assert.equal(store.wardrobe(OWNER).owned[0].name, 'Nueva capa');
  assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { token: ADMIN, method: 'PUT', data: draft })).status, 409);
  assert.equal(store.auditPage().length, 3);
});
test('admin API creates pets and reports invalid IDs instead of a missing route', async t => {
  const { request } = fixture(t);
  const pet = await request('/v1/admin/cosmetics/catalog/mascota-dragon', { token: ADMIN, method: 'PUT',
    data: { name: 'Mascota Dragón', slot: 'PET', status: 'draft', expectedRevision: 0 } });
  assert.equal(pet.status, 200);
  assert.equal(pet.data.slot, 'PET');
  const invalid = await request('/v1/admin/cosmetics/catalog/Mascota%20Drag%C3%B3n', { token: ADMIN, method: 'PUT',
    data: { name: 'Mascota inválida', slot: 'PET', status: 'draft', expectedRevision: 0 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, 'ID de cosmético inválido');
});
test('duplicate operation references cannot regrant a revoked item', t => {
  const { store } = fixture(t); store.saveCosmetic('cape', catalog, 'admin');
  assert.equal(store.entitlement(grant, true, 'admin').duplicate, false);
  assert.equal(store.entitlement(grant, true, 'admin').duplicate, true);
  store.entitlement({ ...grant, reference: 'revoke-1' }, false, 'admin');
  assert.equal(store.entitlement(grant, true, 'admin').duplicate, true);
  assert.equal(store.wardrobe(OWNER).owned.length, 0);
  assert.throws(() => store.entitlement({ ...grant, uuid: OTHER }, true, 'admin'), { status: 409 });
});
test('equipment is scoped to verified session, ignores body UUID, and revokes atomically', async t => {
  const { store, request, login } = fixture(t); store.saveCosmetic('cape', catalog, 'admin');
  const token = await login();
  const equip = { method: 'PUT', token, data: { uuid: OTHER, slot: 'CAPE', cosmeticId: 'cape' } };
  assert.equal((await request('/v1/cosmetics/me/equipment', equip)).status, 403);
  store.entitlement(grant, true, 'admin');
  assert.equal((await request('/v1/cosmetics/me/equipment', equip)).status, 200);
  assert.equal(store.appearance(OWNER).length, 1); assert.equal(store.appearance(OTHER).length, 0);
  store.entitlement({ ...grant, reference: 'revoke' }, false, 'admin');
  assert.equal(store.appearance(OWNER).length, 0);
});
test('unpublished or wrong-slot cosmetics cannot be equipped', t => {
  const { store } = fixture(t); store.saveCosmetic('cape', { ...catalog, status: 'draft' }, 'admin');
  store.entitlement(grant, true, 'admin');
  assert.throws(() => store.equip(OWNER, 'CAPE', 'cape'), { status: 409 });
  store.saveCosmetic('cape', { ...catalog, expectedRevision: 1 }, 'admin');
  assert.throws(() => store.equip(OWNER, 'HAT', 'cape'), { status: 409 });
  store.equip(OWNER, 'CAPE', 'cape');
  store.saveCosmetic('cape', { ...catalog, status: 'retired', expectedRevision: 2 }, 'admin');
  assert.equal(store.appearance(OWNER).length, 0); assert.equal(store.wardrobe(OWNER).owned.length, 1);
});
test('public responses do not expose owners or purchase records', async t => {
  const { store, request } = fixture(t); store.saveCosmetic('cape', catalog, 'admin'); store.entitlement(grant, true, 'admin');
  const publicCatalog = await request('/v1/cosmetics/catalog');
  assert.equal(JSON.stringify(publicCatalog.data).includes(OWNER), false);
  const appearance = await request(`/v1/cosmetics/appearance?uuids=${OWNER}`);
  assert.deepEqual(Object.keys(appearance.data.players[0]).sort(), ['equipped', 'name', 'uuid']);
  assert.equal((await request('/v1/admin/cosmetics/owners/cape')).status, 401);
  const owners = await request('/v1/admin/cosmetics/owners/cape', { token: ADMIN });
  assert.equal(owners.data.items[0].uuid, OWNER); assert.equal(owners.data.items[0].verified_at, null);
});
test('verified nickname follows UUID without changing ownership', async t => {
  const { store, login } = fixture(t); store.saveCosmetic('cape', catalog, 'admin'); store.entitlement(grant, true, 'admin');
  await login(); assert.equal(store.owners('cape')[0].name, 'TestPlayer');
  store.verifiedPlayer(OWNER, 'NewName'); assert.equal(store.owners('cape')[0].name, 'NewName');
  assert.equal(store.wardrobe(OWNER).owned.length, 1);
});
test('appearance resolves an offline server UUID through a verified premium nickname', async t => {
  const { store, request, login } = fixture(t);
  store.saveCosmetic('cape', catalog, 'admin');
  store.entitlement(grant, true, 'admin');
  store.equip(OWNER, 'CAPE', 'cape');
  await login();

  const appearance = await request(`/v1/cosmetics/appearance?uuids=${OTHER}&names=TestPlayer`);
  assert.deepEqual(appearance.data.players, [{
    uuid: OTHER,
    name: null,
    equipped: [],
  }, {
    uuid: OWNER,
    name: 'TestPlayer',
    equipped: [{ slot: 'CAPE', cosmeticId: 'cape' }],
  }]);
});
test('foreign browser origins and invalid media types are rejected', async t => {
  const { request } = fixture(t);
  assert.equal((await request('/v1/admin/cosmetics/catalog', { token: ADMIN, headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await request('/v1/auth/challenge', { method: 'POST', data: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
});
test('oversized bodies, malformed JSON and invalid pagination are rejected', async t => {
  const { request, api } = fixture(t);
  assert.equal((await request('/v1/auth/challenge', { method: 'POST', data: { x: 'x'.repeat(17_000) } })).status, 413);
  assert.equal((await api(new Request('http://127.0.0.1:8787/v1/auth/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await request('/v1/cosmetics/catalog?offset=-1')).status, 400);
});
test('catalog and owner queries are bounded and paginated', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 55; i++) store.saveCosmetic(`cape-${String(i).padStart(2, '0')}`, catalog, 'admin');
  assert.equal(store.catalog(false).length, 50); assert.equal(store.catalog(false, 50).length, 5);
});
test('disabling premium never enables client-supplied UUID authentication', async t => {
  const { request } = fixture(t, { premiumEnabled: false });
  assert.equal((await request('/v1/auth/challenge', { method: 'POST', data: { username: 'TestPlayer' } })).status, 503);
  assert.equal((await request('/v1/auth/offline', { method: 'POST', data: { uuid: OWNER, name: 'TestPlayer' } })).status, 403);
});
test('premium authentication is secure by default', async t => {
  const store = new Store(); t.after(() => store.close());
  const api = createApi({ store, adminToken: ADMIN });
  const health = await (await api(new Request('http://127.0.0.1:8787/health'))).json();
  assert.equal(health.premiumEnabled, true);
  assert.equal(health.offlineAuthEnabled, false);
  assert.equal(health.stage, 'premium-api');
});
test('logout invalidates a player session immediately', async t => {
  const { request, login } = fixture(t); const token = await login();
  assert.equal((await request('/v1/cosmetics/me/wardrobe', { token })).status, 200);
  assert.equal((await request('/v1/auth/logout', { method: 'POST', token })).status, 200);
  assert.equal((await request('/v1/cosmetics/me/wardrobe', { token })).status, 401);
});
test('rate limits expire and do not trust client identity', async t => {
  let now = 0; const { request } = fixture(t, { now: () => now });
  for (let i = 0; i < 120; i++) assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/health', { headers: { 'X-Forwarded-For': 'different' } })).status, 429);
  now = 60_001; assert.equal((await request('/health')).status, 200);
});
test('menu validation allows presentation but never code or arbitrary URLs', () => {
  assert.deepEqual(validateMenu(DEFAULT_MENU), DEFAULT_MENU);
  for (const button of [{ label: 'X', action: 'EXECUTE' }, { label: 'X', action: 'WEBSITE', url: 'https://minelatino.com.attacker.test/' }])
    assert.throws(() => validateMenu({ ...DEFAULT_MENU, buttons: [button] }), { status: 400 });
  assert.throws(() => validateMenu({ ...DEFAULT_MENU, buttons: Array(4).fill(DEFAULT_MENU.buttons[0]) }), { status: 400 });
});
test('menu publication is revisioned with optimistic locking', async t => {
  const { request, store } = fixture(t);
  const input = { expectedRevision: 0, config: { ...DEFAULT_MENU, enabled: false } };
  assert.equal((await request('/v1/admin/pause-menu', { method: 'PUT', token: ADMIN, data: input })).data.revision, 1);
  assert.equal((await request('/v1/admin/pause-menu', { method: 'PUT', token: ADMIN, data: input })).status, 409);
  assert.equal(store.menu().config.enabled, false); assert.equal(store.auditPage().length, 1);
});
test('SQLite persists across service restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'minelatino-cosmetics-test-'));
  let store;
  try {
    const path = join(directory, 'state.sqlite'); store = new Store(path);
    store.saveCosmetic('cape', catalog, 'admin'); store.entitlement(grant, true, 'admin'); store.close(); store = undefined;
    store = new Store(path); assert.equal(store.wardrobe(OWNER).owned[0].id, 'cape');
    assert.equal(store.cosmetic('cape').status, 'draft');
    assert.equal(store.auditPage().length, 3);
  } finally { store?.close(); rmSync(directory, { recursive: true }); }
});

test('challenges are consumed before awaiting verification, including concurrent replay', async () => {
  let finish;
  const auth = new PlayerAuth({ verify: () => new Promise(resolve => { finish = resolve; }) });
  const challenge = auth.challenge('TestPlayer'); const pending = auth.complete(challenge.challengeId);
  await assert.rejects(auth.complete(challenge.challengeId), { status: 401 });
  finish({ uuid: OWNER, name: 'TestPlayer' }); const result = await pending;
  assert.equal(auth.player(`Bearer ${result.token}`), OWNER);
  assert.equal([...auth.sessions.keys()].includes(result.token), false);
});
test('expired challenges and sessions are rejected', async () => {
  let now = 0;
  const auth = new PlayerAuth({ now: () => now, verify: async () => ({ uuid: OWNER, name: 'TestPlayer' }) });
  const old = auth.challenge('TestPlayer'); now = 60_001;
  await assert.rejects(auth.complete(old.challengeId), { status: 401 });
  const challenge = auth.challenge('TestPlayer'); const session = await auth.complete(challenge.challengeId);
  now += 15 * 60_000; assert.throws(() => auth.player(`Bearer ${session.token}`), { status: 401 });
});
test('upstream failure or mismatching username never issues a session', async () => {
  for (const verify of [async () => { throw new Error('offline'); }, async () => ({ uuid: OTHER, name: 'WrongUser' })]) {
    const auth = new PlayerAuth({ verify }); const challenge = auth.challenge('TestPlayer');
    await assert.rejects(auth.complete(challenge.challengeId)); assert.equal(auth.sessions.size, 0);
    await assert.rejects(auth.complete(challenge.challengeId), { status: 401 });
  }
});

test('restoring a menu creates a new revision and preserves history', async t => {
  const { store, request } = fixture(t);
  store.saveMenu({ expectedRevision: 0, config: DEFAULT_MENU }, 'admin');
  store.saveMenu({ expectedRevision: 1, config: { ...DEFAULT_MENU, enabled: false } }, 'admin');
  const restored = await request('/v1/admin/pause-menu/restore', { token: ADMIN, method: 'POST', data: { revision: 1, expectedRevision: 2 } });
  assert.equal(restored.data.revision, 3); assert.equal(restored.data.config.enabled, true);
  assert.equal(store.menuHistory().length, 3);
  assert.equal(store.menuHistory()[1].config.enabled, false);
});
test('menu history deletion requires admin and cannot remove the current revision', async t => {
  const { store, request } = fixture(t);
  store.saveMenu({ expectedRevision: 0, config: DEFAULT_MENU }, 'admin');
  store.saveMenu({ expectedRevision: 1, config: DEFAULT_MENU }, 'admin');
  const path = '/v1/admin/pause-menu/history/';
  assert.equal((await request(path + '1', { method: 'DELETE' })).status, 401);
  assert.equal((await request(path + '2', { method: 'DELETE', token: ADMIN })).status, 409);
  assert.equal((await request(path + 'invalid', { method: 'DELETE', token: ADMIN })).status, 400);
  assert.equal((await request(path + '1', { method: 'DELETE', token: ADMIN })).status, 200);
  assert.equal((await request(path + '1', { method: 'DELETE', token: ADMIN })).status, 404);
  assert.equal(store.menu().revision, 2);
  assert.equal(store.menuHistory().length, 1);
});

test('Mojang adapter uses a fixed origin, rejects redirects, and validates the response', async t => {
  let called;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    called = { url: new URL(url), options };
    return Response.json({ id: OWNER, name: 'TestPlayer' });
  });
  assert.deepEqual(await verifyMojang('TestPlayer', 'challenge'), { uuid: OWNER, name: 'TestPlayer' });
  assert.equal(called.url.origin, 'https://sessionserver.mojang.com');
  assert.equal(called.url.searchParams.get('serverId'), 'challenge');
  assert.equal(called.options.redirect, 'error');
});
test('Mojang adapter fails closed on a missing or unavailable session', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(verifyMojang('TestPlayer', 'challenge'), { status: 401 });
  mock.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(verifyMojang('TestPlayer', 'challenge'), { status: 503 });
});
test('real loopback HTTP supports authenticated writes and rejects unauthenticated ones', async t => {
  const { api } = fixture(t);
  const server = createHttpServer(api, 'http://127.0.0.1:8787');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const unauthorized = await fetch(`${origin}/v1/admin/cosmetics/catalog`);
  assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
  const saved = await fetch(`${origin}/v1/admin/cosmetics/catalog/cape`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ ...catalog, status: 'draft' }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).id, 'cape');
  const result = await fetch(`${origin}/v1/cosmetics/catalog`);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.json()).items.length, 0);
});
test('Railway transport trusts only a valid X-Real-IP address', async t => {
  const seen = [];
  const server = createHttpServer(async (_request, remoteAddress) => {
    seen.push(remoteAddress);
    return Response.json({ ok: true });
  }, 'http://127.0.0.1:8787', null, { trustRailwayProxy: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await (await fetch(origin, { headers: { 'X-Real-IP': '203.0.113.25' } })).arrayBuffer();
  await (await fetch(origin, { headers: { 'X-Real-IP': 'not-an-ip' } })).arrayBuffer();
  assert.equal(seen[0], '203.0.113.25');
  assert.ok(seen[1] === '127.0.0.1' || seen[1] === '::ffff:127.0.0.1');
});

test('admin static files receive browser security headers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'minelatino-admin-static-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Admin</title>');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createHttpServer(async () => Response.json({ ok: true }), 'http://127.0.0.1', directory);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /'unsafe-inline'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('admin CSP allowlists exact inline code with hashes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'minelatino-admin-csp-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><style>body{color:red}</style><button onclick="safeAction()" style="display:block">Go</button><script>function safeAction(){}</script>');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createHttpServer(async () => Response.json({ ok: true }), 'http://127.0.0.1', directory);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const csp = response.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /'unsafe-inline'/);
  assert.match(csp, /script-src 'self' 'unsafe-hashes' 'sha256-/);
  assert.match(csp, /style-src 'self' 'unsafe-hashes' 'sha256-/);
});

test('admin CSP hashes browser-normalized inline code from CRLF HTML', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'minelatino-admin-csp-crlf-'));
  const inlineScript = 'function safeAction(){\r\n  return true;\r\n}';
  const inlineStyle = 'body{\r\n  color:red;\r\n}';
  writeFileSync(join(directory, 'index.html'), `<style>${inlineStyle}</style><button onclick="safeAction()">Go</button><script>${inlineScript}</script>`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createHttpServer(async () => Response.json({ ok: true }), 'http://127.0.0.1', directory);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const csp = response.headers.get('content-security-policy');
  const hash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
  assert.ok(csp.includes(hash(inlineScript.replace(/\r\n?/g, '\n'))));
  assert.ok(csp.includes(hash(inlineStyle.replace(/\r\n?/g, '\n'))));
  assert.ok(csp.includes(hash('safeAction()')));
  assert.ok(!csp.includes(hash(inlineScript)));
  assert.doesNotMatch(csp, /'unsafe-inline'/);
});

// ── Admin auth tests ──────────────────────────────────────────────────

test('admin bootstrap creates first admin and rejects duplicates', async t => {
  const { request } = fixture(t);
  const boot = await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'admin1', password: 'secure1234' }, token: ADMIN });
  assert.equal(boot.status, 201); assert.equal(boot.data.role, 'superadmin');
  const dup = await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'admin2', password: 'secure5678' }, token: ADMIN });
  assert.equal(dup.status, 409);
});
test('admin login returns a session token and rejects bad credentials', async t => {
  const { request } = fixture(t);
  await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'admin1', password: 'secure1234' }, token: ADMIN });
  const ok = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'admin1', password: 'secure1234' } });
  assert.equal(ok.status, 200); assert.ok(ok.data.token); assert.equal(ok.data.username, 'admin1');
  const bad = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'admin1', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const missing = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'nobody', password: 'anything' } });
  assert.equal(missing.status, 401);
});
test('admin session token authorizes admin routes with correct actor', async t => {
  const { request, store } = fixture(t);
  await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'admin1', password: 'secure1234' }, token: ADMIN });
  const login = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'admin1', password: 'secure1234' } });
  const sessionToken = login.data.token;
  // Session token can create cosmetics
  const save = await request('/v1/admin/cosmetics/catalog/cape', { method: 'PUT', data: { ...catalog, status: 'draft' }, token: sessionToken });
  assert.equal(save.status, 200);
  // Audit records the admin username, not 'local-admin'
  const audit = await request('/v1/admin/audit', { token: sessionToken });
  assert.equal(audit.data.items[0].actor, 'admin1');
});
test('publishing requires a texture and succeeds after a resource is uploaded', async t => {
  const { request, store } = fixture(t);
  const draft = { ...catalog, status: 'draft' };
  assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { method: 'PUT', data: draft, token: ADMIN })).status, 200);
  assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { method: 'PUT', data: { ...catalog, expectedRevision: 1 }, token: ADMIN })).status, 409);
  store.saveResource('cape', 'cape.png', 'fixture', 8, 'image/png');
  assert.equal((await request('/v1/admin/cosmetics/catalog/cape', { method: 'PUT', data: { ...catalog, expectedRevision: 1 }, token: ADMIN })).status, 200);
});
test('admin logout invalidates the session', async t => {
  const { request } = fixture(t);
  await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'admin1', password: 'secure1234' }, token: ADMIN });
  const login = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'admin1', password: 'secure1234' } });
  const tok = login.data.token;
  assert.equal((await request('/v1/admin/accounts', { token: tok })).status, 200);
  await request('/v1/admin/auth/logout', { method: 'POST', token: tok });
  assert.equal((await request('/v1/admin/accounts', { token: tok })).status, 401);
});
test('bootstrap token is retired after the first administrator exists', async t => {
  const { request } = fixture(t);
  await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'admin1', password: 'secure1234' }, token: ADMIN });
  assert.equal((await request('/v1/admin/accounts', { token: ADMIN })).status, 401);
});
test('deleting an administrator revokes its active sessions', async t => {
  const { request } = fixture(t);
  await request('/v1/admin/auth/bootstrap', { method: 'POST', data: { username: 'root1', password: 'secure1234' }, token: ADMIN });
  const root = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'root1', password: 'secure1234' } });
  await request('/v1/admin/accounts', { method: 'POST', token: root.data.token,
    data: { username: 'root2', password: 'secure5678', role: 'superadmin' } });
  const second = await request('/v1/admin/auth/login', { method: 'POST', data: { username: 'root2', password: 'secure5678' } });
  assert.equal((await request('/v1/admin/accounts/root1', { method: 'DELETE', token: second.data.token })).status, 200);
  assert.equal((await request('/v1/admin/accounts', { token: root.data.token })).status, 401);
});
test('player search by name and UUID', async t => {
  const { store, request } = fixture(t);
  store.verifiedPlayer('aaaa0000bbbb1111cccc2222dddd3333', 'AlphaPlayer');
  store.verifiedPlayer('eeee4444ffff5555aaaa6666bbbb7777', 'BravoPlayer');
  const byName = await request('/v1/admin/players?q=alpha', { token: ADMIN });
  assert.equal(byName.data.items.length, 1); assert.equal(byName.data.items[0].name, 'AlphaPlayer');
  const byUuid = await request('/v1/admin/players?q=eeee4444ffff5555', { token: ADMIN });
  assert.equal(byUuid.data.items.length, 1); assert.equal(byUuid.data.items[0].name, 'BravoPlayer');
  const tooShort = await request('/v1/admin/players?q=x', { token: ADMIN });
  assert.equal(tooShort.status, 400);
});

// ── Resource tests ────────────────────────────────────────────────────

function fixtureWithResources(t, options = {}) {
  const resourceDir = mkdtempSync(join(tmpdir(), 'minelatino-resources-'));
  t.after(() => rmSync(resourceDir, { recursive: true, force: true }));
  const store = new Store(); t.after(() => store.close());
  const auth = new PlayerAuth({ verify: async () => ({ uuid: OWNER, name: 'TestPlayer' }) });
  const adminAuth = new AdminAuth({ store, bootstrapToken: ADMIN });
  const api = createApi({ store, adminToken: ADMIN, adminAuth, resourceDir, playerAuth: auth, premiumEnabled: true, ...options });
  const request = async (path, { method = 'GET', data, token, headers = {}, body: rawBody } = {}) => {
    const isJson = data !== undefined;
    const response = await api(new Request(`http://127.0.0.1:8787${path}`, { method,
      headers: { ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(isJson ? { body: JSON.stringify(data) } : rawBody !== undefined ? { body: rawBody } : {}),
    }));
    const ct = response.headers.get('content-type') || '';
    const respData = ct.includes('json') ? await response.json() : await response.arrayBuffer();
    return { status: response.status, data: respData, headers: response.headers };
  };
  return { store, api, request, resourceDir };
}

test('admin can permanently delete an unsold cosmetic and all associated data and files', async t => {
  const { store, request, resourceDir } = fixtureWithResources(t);
  const id = 'delete-pack';
  store.saveCosmetic(id, { ...catalog, name: 'Mochila eliminable', slot: 'BACKPACK',
    product: { description: 'Temporal', amountMinor: 500, currency: 'USD' } }, 'admin');
  assert.equal((await request(`/v1/admin/cosmetics/catalog/${id}/files/texture`, {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'texture.png' }, body: PNG_1x1,
  })).status, 200);
  assert.equal((await request(`/v1/admin/cosmetics/catalog/${id}/model`, {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'model.json' }, body: Buffer.from('{"elements":[]}'),
  })).status, 200);
  store.saveTransform(id, 'backpack', { translation: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }, 'admin');
  store.entitlement({ ...grant, cosmeticId: id, reference: 'delete-premium' }, true, 'admin');
  store.equip(OWNER, 'BACKPACK', id);
  store.createPlayerAccount({ accountId: OTHER, email: 'delete@example.com', nick: 'DeleteOwner',
    passwordHash: 'a'.repeat(64), passwordSalt: 'b'.repeat(32) });
  store.accountEntitlement({ accountId: OTHER, cosmeticId: id }, true, 'admin');
  store.accountEquip(OTHER, 'BACKPACK', id);
  const response = await request(`/v1/admin/cosmetics/catalog/${id}`, {
    method: 'DELETE', token: ADMIN, data: { expectedRevision: 1 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual({ premiumOwners: response.data.premiumOwners, accountOwners: response.data.accountOwners },
    { premiumOwners: 1, accountOwners: 1 });
  assert.throws(() => store.cosmetic(id), { status: 404 });
  assert.equal(store.wardrobe(OWNER).owned.length, 0);
  assert.equal(store.accountWardrobe(OTHER).owned.length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM cosmetic_products WHERE cosmetic_id=?').get(id).count, 0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(existsSync(join(resourceDir, `${id}_texture.png`)), false);
  assert.equal(existsSync(join(resourceDir, `${id}_model.json`)), false);
  assert.equal(store.auditPage().some(entry => entry.action === 'catalog.delete'), true);
});

// Minimal valid PNG (1x1 transparent pixel)
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6200010000000500010d0a2db40000000049454e44ae426082', 'hex');

test('pet bbmodel upload converts geometry and imports its embedded assets', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('bb-pet', { ...catalog, name: 'Mascota BBMODEL', slot: 'PET' }, 'admin');
  const bbmodel = Buffer.from(JSON.stringify({
    meta: { format_version: '4.5', model_format: 'free' }, resolution: { width: 16, height: 16 },
    textures: [{ name: 'pet.png', id: '0', source: `data:image/png;base64,${PNG_1x1.toString('base64')}` }],
    elements: [{ type: 'cube', uuid: 'cube', from: [0,0,0], to: [1,1,1], faces: { north: { uv: [0,0,16,16], texture: 0 } } }],
    outliner: [{ name: 'body', origin: [0,0,0], children: ['cube'] }],
    animations: [{ name: 'idle', loop: 'loop', length: 1, animators: { body: { name: 'body', type: 'bone', keyframes: [
      { channel: 'position', time: 0, data_points: [{ x: 0, y: 0, z: 0 }] },
    ] } } }],
  }));
  const uploaded = await request('/v1/admin/cosmetics/catalog/bb-pet/model', {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'pet.bbmodel' }, body: bbmodel,
  });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.converted, true);
  assert.deepEqual(uploaded.data.importedTextures, ['texture']);
  assert.equal(uploaded.data.importedAnimation, 'idle');
  const model = await request('/v1/resources/bb-pet?type=model');
  assert.equal(model.data.source_format, 'bbmodel');
  assert.equal(model.data.elements[0].faces.north.texture, '#texture');
  assert.equal((await request('/v1/resources/bb-pet?file=texture')).status, 200);
  assert.equal((await request('/v1/resources/bb-pet?type=animation-config')).data.animation, 'idle');
});

test('bbmodel upload is limited to pets', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('bb-hat', { ...catalog, name: 'Sombrero', slot: 'HAT' }, 'admin');
  const response = await request('/v1/admin/cosmetics/catalog/bb-hat/model', {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'hat.bbmodel' }, body: Buffer.from('{}'),
  });
  assert.equal(response.status, 409);
});

test('replacing named primary texture preserves new file and exposes manifest', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('test-cape', catalog, 'admin');
  for (let i=0;i<2;i++) {
    const upload = await request('/v1/admin/cosmetics/catalog/test-cape/files/texture', {
      method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'texture.png' }, body: PNG_1x1,
    });
    assert.equal(upload.status, 200);
    assert.equal((await request('/v1/resources/test-cape?file=texture')).status, 200);
    assert.equal((await request('/v1/resources/test-cape')).status, 200);
  }
  const manifest = await request('/v1/resources/test-cape?type=manifest');
  assert.deepEqual(manifest.data.files, [{ name: 'texture', hasMcmeta: false }]);
  assert.match(manifest.data.resourceVersion, /^[a-f0-9]{12}$/);
  assert.equal(manifest.headers.get('etag'), `"${manifest.data.resourceVersion}"`);
  const unchanged = await request('/v1/resources/test-cape?type=manifest', { headers: { 'If-None-Match': manifest.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
});

test('resource upload stores file with SHA-256 and serves it back', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('test-cape', catalog, 'admin');
  const r = await request(`/v1/admin/cosmetics/catalog/test-cape/resource`, {
    method: 'PUT', token: ADMIN,
    headers: { 'X-Filename': 'cape.png' },
    body: PNG_1x1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.content_type, 'image/png');
  assert.equal(r.data.file_size, PNG_1x1.length);
  assert.ok(r.data.sha256);
  // Serve it back
  const served = await request('/v1/resources/test-cape');
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(served.data).toString('hex'), PNG_1x1.toString('hex'));
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.ok(served.headers.get('cache-control').includes('immutable'));
});

test('draft resources require valid administrator authentication', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('draft-hat', { ...catalog, name: 'Draft hat', slot: 'HAT', status: 'draft' }, 'admin');
  const upload = await request('/v1/admin/cosmetics/catalog/draft-hat/resource', {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'draft.png' }, body: PNG_1x1,
  });
  assert.equal(upload.status, 200);
  assert.equal((await request('/v1/resources/draft-hat')).status, 404);
  assert.equal((await request('/v1/resources/draft-hat', { headers: { Origin: 'https://attacker.test' } })).status, 404);
  assert.equal((await request('/v1/resources/draft-hat', { token: 'invalid' })).status, 404);
  assert.equal((await request('/v1/resources/draft-hat', { token: ADMIN })).status, 200);
});

test('resource upload rejects non-PNG, oversized, and missing cosmetic', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('test-cape', catalog, 'admin');
  // Non-PNG extension
  const bad = await request('/v1/admin/cosmetics/catalog/test-cape/resource', {
    method: 'PUT', token: ADMIN,
    headers: { 'X-Filename': 'evil.exe' },
    body: Buffer.from('not a png'),
  });
  assert.equal(bad.status, 415);
  // Non-existent cosmetic
  const missing = await request('/v1/admin/cosmetics/catalog/nonexistent/resource', {
    method: 'PUT', token: ADMIN,
    headers: { 'X-Filename': 'cape.png' },
    body: PNG_1x1,
  });
  assert.equal(missing.status, 404);
  // Invalid PNG magic bytes
  const fakePng = await request('/v1/admin/cosmetics/catalog/test-cape/resource', {
    method: 'PUT', token: ADMIN,
    headers: { 'X-Filename': 'fake.png' },
    body: Buffer.from('not a real png file'),
  });
  assert.equal(fakePng.status, 400);
});

test('resource delete removes file and database entry', async t => {
  const { store, request, resourceDir } = fixtureWithResources(t);
  store.saveCosmetic('test-cape', catalog, 'admin');
  await request('/v1/admin/cosmetics/catalog/test-cape/resource', {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'cape.png' }, body: PNG_1x1,
  });
  const del = await request('/v1/admin/cosmetics/catalog/test-cape/resource', { method: 'DELETE', token: ADMIN });
  assert.equal(del.status, 200); assert.equal(del.data.deleted, true);
  // Resource no longer served
  const served = await request('/v1/resources/test-cape');
  assert.equal(served.status, 404);
});

test('catalog includes resource info for admin and public views', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('test-cape', catalog, 'admin');
  await request('/v1/admin/cosmetics/catalog/test-cape/resource', {
    method: 'PUT', token: ADMIN, headers: { 'X-Filename': 'cape.png' }, body: PNG_1x1,
  });
  const adminCatalog = await request('/v1/admin/cosmetics/catalog', { token: ADMIN });
  assert.equal(adminCatalog.data.items[0].resource.content_type, 'image/png');
  const publicCatalog = await request('/v1/cosmetics/catalog');
  assert.equal(publicCatalog.data.items[0].hasResource, true);
});

test('removed skins cannot be created, distributed or equipped', async t => {
  const { store, request } = fixtureWithResources(t);
  assert.throws(() => store.saveCosmetic('skin', { ...catalog, slot: 'SKIN' }, 'admin'), { status: 400 });
  store.db.prepare('INSERT INTO cosmetics VALUES(?,?,?,?,?)').run('legacy-skin', 'Old Skin', 'SKIN', 'published', 1);
  store.db.prepare('INSERT INTO entitlements VALUES(?,?,1)').run(OWNER, 'legacy-skin');
  store.db.prepare('INSERT INTO equipment VALUES(?,?,?)').run(OWNER, 'SKIN', 'legacy-skin');
  assert.deepEqual(store.wardrobe(OWNER).owned, []);
  assert.deepEqual(store.appearance(OWNER), []);
  assert.throws(() => store.entitlement({ ...grant, cosmeticId: 'legacy-skin' }, true, 'admin'), { status: 404 });
  for (const path of ['/v1/storefront/catalog', '/v1/cosmetics/catalog', '/v1/admin/cosmetics/catalog']) {
    const result = await request(path, { token: ADMIN });
    assert.equal(result.status, 200); assert.deepEqual(result.data.items, []);
  }
  assert.throws(() => store.equip(OWNER, 'SKIN', 'legacy-skin'), { status: 400 });
  assert.equal((await request('/v1/admin/cosmetics/catalog/legacy-skin/avatar-package', { token: ADMIN, method: 'PUT', body: Buffer.from('zip') })).status, 404);
  assert.equal((await request('/v1/resources/legacy-skin?type=avatar-package')).status, 410);
  assert.equal((await request('/v1/cosmetics/emotes')).status, 404);
  store.retireLegacySkins();
  assert.equal(store.db.prepare("SELECT status FROM cosmetics WHERE id='legacy-skin'").get().status, 'retired');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM entitlements WHERE cosmetic_id='legacy-skin'").get().n, 1);
  store.retireLegacySkins();
  assert.equal(store.db.prepare("SELECT revision FROM cosmetics WHERE id='legacy-skin'").get().revision, 2);
  const accountId = 'a'.repeat(32);
  store.createPlayerAccount({ accountId, email: 'legacy@example.com', nick: 'LegacyUser', passwordHash: 'b'.repeat(64), passwordSalt: 'c'.repeat(32) });
  store.db.prepare('INSERT INTO account_entitlements VALUES(?,?,1)').run(accountId, 'legacy-skin');
  store.db.prepare('INSERT INTO account_equipment VALUES(?,?,?)').run(accountId, 'SKIN', 'legacy-skin');
  assert.deepEqual(store.accountWardrobe(accountId).owned, []);
  assert.deepEqual(store.accountAppearance(accountId), []);
  assert.throws(() => store.accountEntitlement({ accountId, cosmeticId: 'legacy-skin' }, true, 'admin'), { status: 404 });
  assert.throws(() => store.accountEquip(accountId, 'SKIN', 'legacy-skin'), { status: 400 });
});

test('pet animation can be uploaded, selected and distributed to the mod', async t => {
  const { store, request } = fixtureWithResources(t);
  store.saveCosmetic('test-pet', { ...catalog, name: 'Pet', slot: 'PET' }, 'admin');
  store.saveResource('test-pet', 'pet.png', 'unused-in-this-test', 1, 'image/png');
  const animation=Buffer.from(JSON.stringify({ animations: {
    'animation.pet.idle': { loop: true, animation_length: 1, bones: { root: { rotation: [0, 0, 0] } } },
    'animation.pet.spin': { loop: true, animation_length: 2, bones: { root: { rotation: { 0: [0, 0, 0], 2: [0, 360, 0] } } } },
  }}));
  const uploaded=await request('/v1/admin/cosmetics/catalog/test-pet/animation', {
    method:'PUT',token:ADMIN,headers:{'X-Filename':'pet.animation.json','X-Animation-Name':'animation.pet.idle'},body:animation,
  });
  assert.equal(uploaded.status,200); assert.equal(uploaded.data.animation_name,'animation.pet.idle');
  const selected=await request('/v1/admin/cosmetics/catalog/test-pet/animation', {
    method:'PATCH',token:ADMIN,data:{animation:'animation.pet.spin'},
  });
  assert.equal(selected.status,200); assert.equal(selected.data.animation_name,'animation.pet.spin');
  const config=await request('/v1/resources/test-pet?type=animation-config');
  assert.deepEqual(config.data,{animation:'animation.pet.spin',hasFile:true});
  const served=await request('/v1/resources/test-pet?type=animation');
  assert.equal(served.status,200); assert.deepEqual(served.data,JSON.parse(animation));
});

test('AI assistant exchanges a game session for a short scoped token and stores usage by account', async t => {
  const calls = [];
  const { store, request } = fixture(t, { aiFactory: database => new AiService({ store: database,
    complete: async messages => {
      calls.push(messages);
      return { content: 'Respuesta segura', usage: { inputTokens: 12, outputTokens: 4 } };
    },
  }) });
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'ai@example.com', password: 'correct-horse-ai', nick: 'AiPlayer',
  } });
  const accountId = registered.data.account.accountId;
  const game = await request('/v1/account/game-token', { method: 'POST', token: registered.data.token, data: {} });
  const assistant = await request('/v1/ai/token', { method: 'POST', token: game.data.token, data: {} });
  assert.equal(assistant.status, 201);
  assert.deepEqual(assistant.data.scopes, ['ai:chat']);
  assert.equal((await request('/v1/ai/chat', { method: 'POST', token: game.data.token, data: {
    requestId: crypto.randomUUID(), conversationId: null, message: 'Hola',
  } })).status, 401, 'a broad game token must not call the AI route directly');

  const requestId = crypto.randomUUID();
  const first = await request('/v1/ai/chat', { method: 'POST', token: assistant.data.token, data: {
    requestId, conversationId: null, message: '¿Cómo inicio mi recorrido?',
  } });
  assert.equal(first.status, 200);
  assert.equal(first.data.message.content, 'Respuesta segura');
  assert.equal(store.aiUsageSince(accountId, 0).requests, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].some(message => message.role === 'system'), false);
  assert.equal(calls[0].at(-1).content, '¿Cómo inicio mi recorrido?');

  const replay = await request('/v1/ai/chat', { method: 'POST', token: assistant.data.token, data: {
    requestId, conversationId: first.data.conversationId, message: 'No debe duplicarse',
  } });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(store.aiUsageSince(accountId, 0).requests, 1);
  assert.equal(calls.length, 1);
});

test('AI assistant token is revoked together with its parent MineLatino session', async t => {
  const { request } = fixture(t, { aiFactory: store => new AiService({ store,
    complete: async () => ({ content: 'ok', usage: {} }),
  }) });
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'revoke-ai@example.com', password: 'correct-horse-ai-2', nick: 'AiRevoke',
  } });
  const game = await request('/v1/account/game-token', { method: 'POST', token: registered.data.token, data: {} });
  const assistant = await request('/v1/ai/token', { method: 'POST', token: game.data.token, data: {} });
  await request('/v1/account/logout-all', { method: 'POST', token: registered.data.token, data: {} });
  const result = await request('/v1/ai/status', { token: assistant.data.token });
  assert.equal(result.status, 401);
});

test('AI assistant supports an HTTPS OpenAI-compatible chat completions endpoint', async t => {
  const names = ['AI_SOURCE','AI_PROVIDER','AI_API_KEY','AI_MODEL','AI_BASE_URL','AI_API_STYLE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]; });
  Object.assign(process.env, { AI_SOURCE: 'direct', AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'test-only-provider-key',
    AI_MODEL: 'test-model', AI_BASE_URL: 'https://provider.example/v1', AI_API_STYLE: 'chat-completions' });
  let request;
  const { store } = fixture(t);
  const ai = createAiServiceFromEnv({ store, fetchImpl: async (url, options) => {
    request = { url, options };
    return Response.json({ choices: [{ message: { content: 'Respuesta compatible' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 } });
  } });
  const result = await ai.complete([{ role: 'user', content: 'Hola' }]);
  assert.equal(request.url, 'https://provider.example/v1/chat/completions');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.equal(result.content, 'Respuesta compatible');
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
});

test('AI assistant uses the official MineLatino website chat by default', async t => {
  const names = ['AI_SOURCE','MINELATINO_ASSISTANT_URL','AI_REQUEST_TIMEOUT_SECONDS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]; });
  delete process.env.AI_SOURCE;
  process.env.MINELATINO_ASSISTANT_URL = 'https://minelatino.net';
  const calls = [];
  const { store } = fixture(t);
  const ai = createAiServiceFromEnv({ store, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/asistente')) return new Response(
      '<html><head><meta name="csrf-token" content="test-csrf-token"></head></html>',
      { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'ml_session=test-session; Path=/; HttpOnly; Secure' } });
    return Response.json({ success: true, answer: 'Respuesta con el conocimiento oficial', sources: [
      { title: 'Normas', url: 'https://minelatino.net/normas' },
    ] });
  } });
  const result = await ai.complete([
    { role: 'user', content: 'Primera pregunta' },
    { role: 'assistant', content: 'Primera respuesta' },
    { role: 'user', content: '¿Cuáles son las normas?' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://minelatino.net/asistente');
  assert.equal(calls[1].url, 'https://minelatino.net/api/assistant/message');
  assert.equal(calls[1].options.headers['x-csrf-token'], 'test-csrf-token');
  assert.match(calls[1].options.headers.Cookie, /^ml_session=test-session$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    question: '¿Cuáles son las normas?',
    history: [
      { role: 'user', content: 'Primera pregunta' },
      { role: 'assistant', content: 'Primera respuesta' },
    ],
  });
  assert.equal(result.content, 'Respuesta con el conocimiento oficial');
  assert.deepEqual(result.usage, {});
});

test('AFK Farm time is assigned by admin, metered by server time, and blocks at zero', async t => {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const { store, request } = fixture(t, { now });
  const registered = await request('/v1/account/register', { method: 'POST', data: {
    email: 'afk-time@example.com', password: 'correct-horse-afk', nick: 'AfkTimer',
  } });
  const accountId = registered.data.account.accountId;
  const emptyToken = await request('/v1/afk/token', { method: 'POST', token: registered.data.token, data: {} });
  assert.equal(emptyToken.status, 201);
  assert.equal(emptyToken.data.scope, 'afk');
  assert.deepEqual(emptyToken.data.scopes, ['afk:usage']);
  assert.equal(new AccountAuth({ store, now }).authenticateAfk(`Bearer ${emptyToken.data.token}`).accountId, accountId,
    'the AFK capability must survive a backend process restart');
  assert.equal((await request('/v1/account/me', { token: emptyToken.data.token })).status, 403,
    'the AFK capability must not authorize account routes');
  assert.equal((await request('/v1/afk/status', { token: emptyToken.data.token })).data.remainingSeconds, 0);
  assert.equal((await request('/v1/afk/sessions', { method: 'POST', token: emptyToken.data.token, data: {} })).status, 402);

  const assigned = await request(`/v1/admin/player-accounts/${accountId}/afk-time`, { method: 'PUT', token: ADMIN,
    data: { mode: 'set', seconds: 45, reason: 'Prueba automatizada' } });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.remainingSeconds, 45);
  const started = await request('/v1/afk/sessions', { method: 'POST', token: emptyToken.data.token, data: {} });
  assert.equal(started.status, 201);
  assert.equal(started.data.active, true);
  clock += 20_000;
  const heartbeat = await request(`/v1/afk/sessions/${started.data.sessionId}/heartbeat`, {
    method: 'POST', token: emptyToken.data.token, data: {},
  });
  assert.equal(heartbeat.data.remainingSeconds, 25);
  clock += 30_000;
  const exhausted = await request(`/v1/afk/sessions/${started.data.sessionId}/heartbeat`, {
    method: 'POST', token: emptyToken.data.token, data: {},
  });
  assert.equal(exhausted.data.remainingSeconds, 0);
  assert.equal(exhausted.data.exhausted, true);
  assert.equal((await request('/v1/afk/sessions', { method: 'POST', token: emptyToken.data.token, data: {} })).status, 402);
  assert.equal((await request('/v1/account/logout', { method: 'POST', token: registered.data.token, data: {} })).status, 200);
  assert.equal((await request('/v1/afk/status', { token: emptyToken.data.token })).status, 401,
    'revoking the parent session must revoke its AFK capability');
});
