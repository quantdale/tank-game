import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { getMapConfig } from './maps/index.js';
import { createHeightField } from './terrain.js';
import { createProps } from './props.js';

// ---------------------------------------------------------------------------
// Headless DOM shims — props.js paints its procedural textures onto canvases
// and the wreck pipeline strokes marking paths. In Node nothing reaches a GPU,
// so recording stubs are enough; sourced-texture swaps never resolve.
// ---------------------------------------------------------------------------
function makeContext2d(canvas) {
  return {
    canvas,
    strokeStyle: null, fillStyle: null, lineWidth: 1, globalAlpha: 1, lineCap: 'butt',
    putImageData() {}, clearRect() {}, fillRect() {}, drawImage() {},
    save() {}, restore() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    isPointInPath() { return false; },
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    createImageData(w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    closePath() {}, stroke() {}, fill() {}, arc() {}, ellipse() {},
    strokeText() {}, fillText() {}, measureText() { return { width: 0 }; },
    setTransform() {}, resetTransform() {},
  };
}
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => makeContext2d(canvas);
    return canvas;
  },
  createElementNS(_ns, tag) { return this.createElement(tag); },
};
globalThis.ImageData = class {
  constructor(px, w, h) { this.data = px; this.width = w; this.height = h ?? w; }
};
globalThis.Path2D = class {
  moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {}
  arc() {} ellipse() {} closePath() {} rect() {}
};
// sourced-texture loader: an Image stub that never fires keeps the swap
// pending silently instead of logging a caught fallback on every material.
globalThis.Image = class {
  set src(_v) {} get src() { return ''; }
};

const engineCtx = {
  anisotropy: 4,
  setupShadowMaterial(mat) { return mat; },
};

/** Build one map's props layer headlessly (deterministic given seed). */
function buildProps(mapId, seed = 2002) {
  const config = getMapConfig(mapId);
  const heightField = createHeightField(seed, config);
  return createProps(heightField, engineCtx, seed, config);
}

/**
 * Stable digest of the AUTHORITATIVE placement/collision state: obstacles,
 * colliders, destructible records, loose-body poses, crushables. Rendering
 * organization must never move these bytes.
 */
function stateDigest(props) {
  const h = createHash('sha256');
  const feedRecords = (recs) => {
    for (const r of recs) {
      h.update(JSON.stringify(r.min));
      h.update(JSON.stringify(r.max));
      h.update(String(!!r.dead));
      h.update(String(!!r.crushed));
    }
  };
  feedRecords(props.obstacles);
  feedRecords(props.colliders);
  for (const d of props.destructibles) {
    h.update(JSON.stringify([d.kind, d.x, d.y, d.z, d.yaw, d.sc, d.slot, d.state]));
    if (d.body) {
      h.update(JSON.stringify([d.body.x, d.body.y, d.body.z,
        d.body.qx, d.body.qy, d.body.qz, d.body.qw]));
    }
  }
  for (const c of props.crushables) {
    h.update(JSON.stringify([c.x, c.y, c.z, c.index ?? -1, c.recIdx ?? -1, c.toppled]));
  }
  return h.digest('hex');
}

/** Flatten the render-object list the renderer would walk each frame. */
function renderObjects(group) {
  const out = [];
  group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    out.push(o);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 1. Headless build works end-to-end and exposes the documented facade.
// ---------------------------------------------------------------------------
for (const mapId of ['verdant', 'urban', 'desert']) {
  const props = buildProps(mapId);
  assert.ok(props.group.isGroup, `${mapId}: props group exists`);
  assert.ok(props.obstacles.length > 50, `${mapId}: hull obstacles were authored`);
  assert.ok(props.colliders.length > 20, `${mapId}: shell colliders were authored`);
  assert.ok(props.crushables.length > 0, `${mapId}: crushable props exist`);
  assert.ok(props.destructibles.length > 40, `${mapId}: destructible records exist`);
  for (const key of ['updateProps', 'resetDestructibles', 'crushProp',
    'crushDestructible', 'getLoosePropStats']) {
    assert.equal(typeof props[key], 'function', `${mapId}: facade exposes ${key}`);
  }
  assert.ok(Array.isArray(props.tankWreckSpots), `${mapId}: wreck spots exposed`);
  if (mapId === 'verdant') {
    // Wreck bakes depend on src/vehicles/tankFactoryCore.js (NOT owned here).
    // A concurrent worker's in-flight battleDetailLod change can fail bakes;
    // validate well-formedness when they land instead of hard-failing.
    if (props.tankWreckSpots.length > 0) {
      for (const spot of props.tankWreckSpots) {
        assert.ok(spot.hx > 0 && spot.hz > 0 && spot.h > 0 && Number.isFinite(spot.yaw),
          'wreck spot carries a real rotated footprint');
      }
      console.log(`props.selftest: ${props.tankWreckSpots.length} wreck hulks baked`);
    } else {
      console.log('props.selftest: WARNING - 0 wreck hulks baked '
        + '(tankFactoryCore.js setDestroyed fails without battleDetailLod; '
        + 'see CROSS-SYSTEM follow-up in W7 report)');
    }
  }
  const objects = renderObjects(props.group);
  assert.ok(objects.length > 40 && objects.length < 200,
    `${mapId}: render-object count stays batched (${objects.length})`);
  console.log(`props.selftest: ${mapId} built — ${objects.length} render objects, `
    + `${props.destructibles.length} destructibles, ${props.obstacles.length} obstacles`);
}

// ---------------------------------------------------------------------------
// 2. Determinism: two independent builds produce byte-identical authoritative
// state (same seed -> same world, no wall-clock/random leakage).
// ---------------------------------------------------------------------------
for (const mapId of ['verdant', 'urban']) {
  const a = stateDigest(buildProps(mapId));
  const b = stateDigest(buildProps(mapId));
  assert.equal(a, b, `${mapId}: repeated builds are byte-identical`);
}
console.log('props.selftest: repeated builds are deterministic');

// ---------------------------------------------------------------------------
// 3. Destruction round-trip: breaking every interaction class (swap-break,
// hinge topple, ballistic toss, loose-body kick, pole topple with wires),
// settling the sim, then rematch-reset must restore the authoritative state
// EXACTLY — placement and collision outputs are identical before/after.
// ---------------------------------------------------------------------------
{
  const props = buildProps('verdant');
  const pristine = stateDigest(props);

  // capture the pristine wire instance matrices (utility network spans)
  let wireIM = null;
  props.group.traverse((o) => { if (o.name === 'utility-wires') wireIM = o; });
  assert.ok(wireIM, 'verdant strings its telegraph-pole utility network');
  const pristineWires = new Float32Array(wireIM.instanceMatrix.array);

  // topple a telegraph pole through the main.js crushables seam
  const poleCrush = props.crushables.findIndex((c) => c.recIdx == null && c.index != null);
  assert.ok(poleCrush >= 0, 'a sourced telegraph pole is crushable');
  assert.equal(props.crushProp(poleCrush, 1, 0.3, 10), true, 'pole topple accepts the ram');

  // break one record of every other interaction class
  let broke = { break: 0, topple: 0, toss: 0, physics: 0 };
  for (let i = 0; i < props.destructibles.length; i++) {
    const rec = props.destructibles[i];
    if (rec.state || rec.cls === 'physics') continue;
    if (broke[rec.cls] >= 6) continue;
    if (props.crushDestructible(i, 0.8, 0.4, 9, 'ram')) broke[rec.cls]++;
  }
  // kick loose clutter through the loop-contact seam
  for (const c of props.crushables) {
    if (c.recIdx == null || broke.physics >= 6) continue;
    if (props.crushProp(props.crushables.indexOf(c), 1, 0, 7)) broke.physics++;
  }
  assert.ok(broke.break >= 3 && broke.topple >= 1 && broke.physics >= 1,
    `destruction classes exercised (${JSON.stringify(broke)})`);

  // settle anims + loose bodies
  for (let t = 0; t < 240; t++) props.updateProps(1 / 60);
  assert.ok(stateDigest(props) !== pristine, 'battering changes the state');
  const fallenWires = wireIM.instanceMatrix.array;
  let wiresMoved = 0;
  for (let i = 0; i < fallenWires.length; i++) {
    if (fallenWires[i] !== pristineWires[i]) wiresMoved++;
  }
  assert.ok(wiresMoved > 0, 'toppling a pole drags its catenary spans down');

  // rematch reset: everything stands back up byte-for-byte
  props.resetDestructibles();
  for (let t = 0; t < 10; t++) props.updateProps(1 / 60);
  assert.equal(stateDigest(props), pristine, 'reset restores placement + collision exactly');
  const restoredWires = wireIM.instanceMatrix.array;
  for (let i = 0; i < restoredWires.length; i++) {
    assert.equal(restoredWires[i], pristineWires[i],
      'reset rebuilds the original catenary matrices');
  }
  // loose clutter sleeps again after the kick/settle cycle
  assert.deepEqual(props.getLoosePropStats(), { total: props.looseRecords.length, active: 0 },
    'loose bodies all sleep after reset');
  console.log('props.selftest: destruction round-trip restores state exactly '
    + `(classes ${JSON.stringify(broke)}, ${wiresMoved} wire components moved)`);
}

// ---------------------------------------------------------------------------
// 4. Ground-decal atlas batching: five decal families ride ONE merged mesh +
// ONE atlas material, with UVs contained in their declared atlas cells.
// ---------------------------------------------------------------------------
{
  const props = buildProps('urban'); // town maps place every decal family
  const decals = renderObjects(props.group).filter((o) => o.name === 'ground-decals');
  assert.equal(decals.length, 1, 'all ground decals merged into one mesh');
  const mesh = decals[0];
  assert.equal(mesh.material.map.image.width, 512, 'atlas texture is 512px');
  assert.equal(mesh.material.map.image.height, 512, 'atlas texture is square');
  assert.equal(mesh.renderOrder, 1, 'decals keep their overlay order');
  assert.equal(mesh.castShadow, false, 'decals never cast shadows');
  assert.equal(mesh.receiveShadow, true, 'decals still receive shadows');
  const CELLS = {
    dirt: [8, 8, 128, 128], apron: [144, 8, 128, 128], crater: [280, 8, 128, 128],
    scorch: [8, 144, 128, 128], churn: [144, 144, 128, 256],
  };
  const uv = mesh.geometry.attributes.uv;
  const hits = new Set();
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    let inCell = null;
    for (const [kind, [x0, y0, w, h]] of Object.entries(CELLS)) {
      // flipY-aware cell rect in UV space
      const u0 = x0 / 512, u1 = (x0 + w) / 512;
      const v0 = (512 - y0 - h) / 512, v1 = (512 - y0) / 512;
      if (u >= u0 && u <= u1 && v >= v0 && v <= v1) { inCell = kind; break; }
    }
    assert.ok(inCell, `decal uv (${u.toFixed(3)}, ${v.toFixed(3)}) lands in a family cell`);
    hits.add(inCell);
  }
  assert.ok(hits.size >= 3, `multiple decal families share the atlas (${[...hits]})`);
  console.log(`props.selftest: ground-decal atlas carries ${uv.count} uvs across `
    + `${hits.size} families in one draw`);
}

console.log('props.selftest: headless build, determinism, destruction round-trip, '
  + 'and decal batching passed');
