import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function renderer(overrides = {}) {
  const context = vm.createContext({ console: { warn() {} }, performance: { now: () => 100 }, ...overrides });
  for (const file of ['three.min.js', 'cosmetic-preview.js'])
    vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), context);
  return context.MineLatinoCosmetics;
}

function editor() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../public/cosmetic-editor.js', import.meta.url), 'utf8'), context);
  return context.MineLatinoCosmeticEditor;
}
function afkTiming() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../public/afk-timing.js', import.meta.url), 'utf8'), context);
  return context.MineLatinoAfkTiming;
}
const model = {
  texture_size: [128, 128], textures: { main: 'pack/main', bubbles: 'pack/bubbles' },
  elements: [{ from: [0,0,0], to: [16,16,16], faces: {
    north: { texture: '#main', uv: [0,14.125,0.5,14.625], rotation: 270 },
    south: { texture: '#bubbles', uv: [0,0,16,16] },
  } }],
};

test('admin preview shares Java UV units and separates face materials', () => {
  const api = renderer(), geometry = api.cosmeticGeometry(model);
  assert.equal(geometry.groups.length, 2);
  assert.equal(geometry.groups[1].materialIndex, 1);
  assert.equal(geometry.getAttribute('uv').getX(0), 0.5/16);
  assert.equal(geometry.getAttribute('uv').getY(0), 1-14.125/16);
  geometry.dispose();
});

test('admin preview fetches each named texture, animates and retains bitmaps until disposal', async () => {
  let closed = 0;
  const requested = [];
  const authorizations = [];
  const api = renderer({
    fetch: async (url, options) => {
      const u = new URL(url, 'https://fixture.invalid'); requested.push(u.searchParams.get('file'));
      authorizations.push(options?.headers?.Authorization);
      if (u.searchParams.get('type') === 'manifest') return Response.json({ files: [{ name: 'main', hasMcmeta: false }, { name: 'bubbles', hasMcmeta: true }] });
      if (u.searchParams.get('type') === 'mcmeta') return Response.json({ animation: { frametime: 1.8 } });
      return new Response(new Uint8Array([1]));
    },
    createImageBitmap: async () => ({ width: 32, height: 384, close() { closed++; } }),
  });
  const mesh = await api.createCosmeticMesh({ id: 'fixture' }, model, new AbortController().signal,
    { headers: { Authorization: 'Bearer admin-preview' } });
  assert.equal(mesh.material.length, 2);
  assert(requested.includes('main')); assert(requested.includes('bubbles'));
  assert(authorizations.every(value => value === 'Bearer admin-preview'));
  assert.equal(closed, 0);
  mesh.onBeforeRender();
  assert.equal(mesh.material[1].map.repeat.y, 1/12);
  assert.equal(mesh.material[1].map.offset.y, 1-2/12);
  api.disposeCosmeticMesh(mesh);
  assert.equal(closed, 2);
});

test('admin inline scripts remain syntactically valid', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert(html.includes('src="cosmetic-preview.js"'));
  assert(html.includes('src="cosmetic-editor.js"'));
  assert(!html.includes('parseBlockbenchModel('));
});

test('redesigned admin separates catalog, product data and 3D resources', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['tab-catalog', 'tab-details', 'tab-resources', 'tab-grant', 'tab-players', 'tab-resource-packs', 'tab-menu', 'tab-afk', 'tab-audit'])
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${id} must be unique`);
  assert(html.includes('class="sidebar"'));
  assert(html.includes('href="admin.css"'));
  assert(html.includes('data-tab="resources"'));
  assert(html.includes("edSlotForType(item?.slot||'BACKPACK')"), '3D editor must use the selected catalog item slot');
  for (const slot of ['hat', 'cape', 'wings', 'backpack', 'pet']) assert(html.includes(`${slot}:`), `editor must label ${slot}`);
  assert(!html.includes("const cosSlot=$('cos-slot').value"), '3D editor must not use a stale product form slot');
  assert(html.includes('edUseModelDefaults()'), 'editor must offer the model display transform as a preset');
  assert(html.includes('id="delete-cosmetic-btn"'));
  assert(html.includes("method:'DELETE',body:JSON.stringify({expectedRevision:item.revision})"));
  assert(html.includes('function normalizeCosmeticId(value)'));
  assert(html.includes("slot:$('cos-slot').value"));
  assert(html.includes('id="model-file" accept=".json,.bbmodel"'));
  assert(html.includes('BBMODEL convertido'));
  assert(html.includes("grantItems=items.filter(i=>i.status!=='retired')"), 'draft cosmetics must remain assignable for testing');
  assert(html.includes('Podrá equiparse cuando publiques el producto.'));
  assert(html.includes('function buildAfkTimingPlan()'));
  assert(html.includes('src="afk-timing.js"'));
  assert(html.includes('/v1/admin/launcher/resource-packs/${version}'));
});

test('AFK web simulator mirrors post-join, between-command and movement delays', () => {
  const plan = afkTiming().build({ commands: '/warp granja\nhome animales', postJoin: 8, between: 4, movement: 12 });
  assert.deepEqual(Array.from(plan.events, event => [event.at, event.kind]), [[0, 'world'], [8, 'command'], [12, 'command'], [24, 'movement']]);
  assert.equal(plan.total, 24);
  assert.throws(() => afkTiming().build({ commands: '', postJoin: 301, between: 0, movement: 0 }), /0 y 300/);
  assert.throws(() => afkTiming().build({ commands: Array(11).fill('say test'), postJoin: 0, between: 0, movement: 0 }), /10 comandos/);
});

test('admin assignments use MineLatino accounts instead of legacy Minecraft UUID grants', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert(html.includes('/v1/admin/player-accounts/${accountId}/cosmetics'));
  assert(html.includes('/v1/admin/account-cosmetics/owners/${id}'));
  assert(!html.includes("api('/v1/admin/cosmetics/grants'"));
  assert(!html.includes('id="grant-uuid"'));
});

test('account table actions use CSP-compatible delegated events', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const rowBuilder = html.match(/async function loadPlayerAccounts\(\).*$/m)?.[0] ?? '';
  assert(rowBuilder.includes('data-account-action="delete"'));
  assert(!rowBuilder.includes('onclick='));
  assert(html.includes("$('accounts-body').addEventListener('click'"));
});

test('editor converts API transforms exactly like the Minecraft renderer', () => {
  const api = editor();
  const source = { translation: [8, 16, -4], rotation: [15, 30, -45], scale: [2, 1.5, .75] };
  const scene = api.toSceneTransform(source);
  assert.deepEqual(Array.from(scene.position), [-.5, 1, .25]);
  assert.deepEqual(Array.from(scene.scale), [2, 1.5, .75]);
  const restored = api.fromSceneTransform(scene.position, scene.rotation, scene.scale);
  for (const key of ['translation', 'rotation', 'scale'])
    assert.deepEqual(Array.from(restored[key]).map(n => Math.round(n * 1e9) / 1e9), source[key]);
});

test('backpack editor uses the torso anchor, Y/Z flip and back-facing yaw', () => {
  const base = editor().slotBase('backpack');
  assert.deepEqual(Array.from(base.position), [0, .3, .3]);
  assert.deepEqual(Array.from(base.scale), [1, -1, -1]);
  assert.equal(base.yaw, Math.PI);
});

test('editor exposes a distinct renderer-compatible anchor for every cosmetic type', () => {
  const api = editor();
  assert.deepEqual(Array.from(api.SLOTS), ['hat', 'cape', 'wings', 'backpack', 'pet']);
  assert.deepEqual(Array.from(api.slotBase('cape').position), [0, .3, .16]);
  assert.deepEqual(Array.from(api.slotBase('wings').position), [0, .3, .16]);
  assert.deepEqual(Array.from(api.slotBase('pet').position), [1.15, 1, 0]);
  assert.deepEqual(Array.from(api.slotBase('pet').scale), [.55, -.55, -.55]);
  assert.equal(api.slotBase('cape').yaw, Math.PI);
  assert.equal(api.slotBase('pet').yaw, 0);
});
