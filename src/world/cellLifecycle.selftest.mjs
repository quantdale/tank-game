import assert from 'node:assert/strict';
import {
  CELL_STATES,
  CELL_STATE_NAMES,
  CELL_UPDATE_SCALE,
  CELL_SHADOW,
  CELL_VISIBLE,
  CELL_DECAL_VISIBLE,
  CELL_PROP_UPDATE,
  CELL_CLUTTER_PHYSICS,
  CELL_PROP_SHADOW,
  CELL_AMBIENT_FX,
  CELL_AMBIENT_SCALE,
  CELL_AUXILIARY_VISIBLE,
  CELL_SCENERY_LOD,
  cellStateForDistance,
  cellEdgeDistance,
  createCellLifecycle,
} from './cellLifecycle.js';

// ---- band mapping (entry thresholds from DORMANT: 162/261/387/576) --------
assert.equal(cellStateForDistance(0), CELL_STATES.ACTIVE, 'inside a cell is ACTIVE');
assert.equal(cellStateForDistance(100), CELL_STATES.ACTIVE);
assert.equal(cellStateForDistance(170), CELL_STATES.VISIBLE, 'past the entry edge is VISIBLE');
assert.equal(cellStateForDistance(250), CELL_STATES.VISIBLE);
assert.equal(cellStateForDistance(300), CELL_STATES.SHADOW_ONLY);
assert.equal(cellStateForDistance(500), CELL_STATES.DISTANT);
assert.equal(cellStateForDistance(600), CELL_STATES.DORMANT);

// ---- hysteresis: enter 10% early, leave 10% late --------------------------
assert.equal(cellStateForDistance(195, CELL_STATES.ACTIVE), CELL_STATES.ACTIVE,
  'ACTIVE holds inside its exit margin');
assert.equal(cellStateForDistance(205, CELL_STATES.ACTIVE), CELL_STATES.VISIBLE,
  'ACTIVE gives up past its exit margin');
assert.equal(cellStateForDistance(310, CELL_STATES.VISIBLE), CELL_STATES.VISIBLE);
assert.equal(cellStateForDistance(325, CELL_STATES.VISIBLE), CELL_STATES.SHADOW_ONLY);
assert.equal(cellStateForDistance(630, CELL_STATES.DISTANT), CELL_STATES.DISTANT);
assert.equal(cellStateForDistance(710, CELL_STATES.DISTANT), CELL_STATES.DORMANT);
assert.equal(cellStateForDistance(700, CELL_STATES.ACTIVE), CELL_STATES.DORMANT,
  'teleport-scale distance drops through every band in one step');
assert.equal(cellStateForDistance(50, CELL_STATES.DORMANT), CELL_STATES.ACTIVE,
  'teleport-scale proximity rises through every band in one step');

let prev = -1;
for (let d = 0; d <= 800; d += 10) {
  const s = cellStateForDistance(d, CELL_STATES.VISIBLE);
  assert.ok(s >= prev, `state monotone in distance at ${d} m`);
  prev = s;
}

// ---- grid classification from the map center ------------------------------
const center = createCellLifecycle();
assert.equal(center.count, 64, '8x8 default grid');
assert.equal(center.sizeM, 128, 'cell size mirrors terrain/vegetation chunks');
assert.deepEqual(Array.from(center.states), new Array(64).fill(CELL_STATES.DORMANT),
  'every cell starts DORMANT before the first classify');

assert.equal(center.update(0, 0), true, 'first update classifies');
// Cell centers sit at origin + cx*128 + 64; edge distance subtracts 128*0.71.
assert.equal(center.stateAt(10, 10), CELL_STATES.ACTIVE, 'observer cell is ACTIVE');
assert.equal(center.stateAt(-60, 60), CELL_STATES.ACTIVE, 'adjacent cell is ACTIVE');
assert.equal(center.stateAt(-300, 64), CELL_STATES.VISIBLE, '~235 m edge distance');
assert.equal(center.stateAt(-500, 64), CELL_STATES.SHADOW_ONLY, '~362 m edge distance');
assert.equal(center.stateAt(-500, -500), CELL_STATES.DISTANT, 'corner ~543 m edge distance');
for (let i = 0; i < 64; i++) {
  assert.equal(center.changed[i], 1, `cell ${i} woke from DORMANT on first classify`);
}
assert.equal(center.version, 1);

assert.equal(center.update(0, 0, null, null, true), false,
  're-classifying an unchanged observer changes nothing');
for (let i = 0; i < 64; i++) {
  assert.equal(center.changed[i], 0, 'changed flags clear on a quiet pass');
}
assert.equal(center.version, 1);

// ---- focus takes the nearer observer --------------------------------------
const focused = createCellLifecycle();
focused.update(400, 400, -400, -400);
assert.equal(focused.stateAt(-450, -450), CELL_STATES.ACTIVE,
  'far corner wakes via the focus even though the camera is map-away');
assert.equal(focused.stateAt(450, 450), CELL_STATES.ACTIVE,
  'camera-side corner stays ACTIVE');
assert.equal(focused.update(401, 400, null, null), true,
  'losing the focus reclassifies and some states change');
assert.equal(focused.classifies, 2, 'focus disappearing forces a pass');
assert.equal(focused.stateAt(-450, -450), CELL_STATES.DORMANT,
  'without the focus the far corner falls back to DORMANT');

// ---- movement throttle -----------------------------------------------------
const throttled = createCellLifecycle();
throttled.update(0, 0);
assert.equal(throttled.classifies, 1);
assert.equal(throttled.update(2, 0), false, 'sub-threshold move skips classification');
assert.equal(throttled.update(3.9, 0), false);
assert.equal(throttled.classifies, 1, 'no hidden passes while throttled');
assert.equal(throttled.update(10, 0), false, 'return value tracks state change, not the pass');
assert.equal(throttled.classifies, 2, 'a >= 4 m move classifies');
assert.equal(throttled.update(10, 0, null, null, true), false,
  'forced pass at the classified position changes nothing');
assert.equal(throttled.classifies, 3, 'force bypasses the throttle');
throttled.update(13, 0, 20, 20);
assert.equal(throttled.classifies, 4, 'focus appearing forces a pass');
for (let i = 0; i < 70; i++) throttled.update(13, 0, 20, 20);
assert.equal(throttled.classifies, 5, 'the 64-update guard refreshes a parked observer');

// ---- monotone transitions along a drive across the map --------------------
const driven = createCellLifecycle();
const row = 4; // z range [0, 128)
const seqs = Array.from({ length: 8 }, () => []);
for (let x = -480; x <= 480; x += 16) {
  driven.update(x, 64, null, null, true);
  for (let cx = 0; cx < 8; cx++) {
    seqs[cx].push(driven.states[row * 8 + cx]);
  }
}
for (let cx = 0; cx < 8; cx++) {
  const seq = seqs[cx];
  const centerX = -512 + cx * 128 + 64;
  let k = 0;
  for (let i = 0; i < seq.length; i++) {
    if (Math.abs(-480 + i * 16 - centerX) < Math.abs(-480 + k * 16 - centerX)) k = i;
  }
  // Approaching reads richer (numerically down), receding reads poorer —
  // any other move means hysteresis failed to hold the band steady.
  for (let i = 1; i <= k; i++) {
    assert.ok(seq[i] <= seq[i - 1], `column ${cx} approaches monotonically`);
  }
  for (let i = k + 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1], `column ${cx} recedes monotonically`);
  }
}

// ---- static content registry ----------------------------------------------
const reg = createCellLifecycle();
const clusters = [
  { x: 10, z: 10 },               // point record -> exactly its cell
  { x: -300, z: 200, r: 60 },     // spans rows 5-6 x cols 1-2
  { x: -500, z: 0, r: 40 },       // hangs off the west edge -> col 0, rows 3-4
  { x: 600, z: 600 },             // fully off-grid -> nowhere
];
reg.registerContent(clusters, 'treeCluster');
function collect(cellIndex) {
  const out = [];
  reg.forEachContent('treeCluster', cellIndex, (i) => out.push(i));
  return out;
}
assert.deepEqual(collect(36), [0], 'point record lands in its containing cell');
assert.deepEqual(collect(41), [1], 'radius record covers its bounding box');
assert.deepEqual(collect(42), [1]);
assert.deepEqual(collect(49), [1]);
assert.deepEqual(collect(50), [1]);
assert.deepEqual(collect(24), [2], 'edge-clipped record covers only real cells');
assert.deepEqual(collect(32), [2]);
assert.deepEqual(collect(16), [], 'rows above the clipped record stay empty');
assert.deepEqual(collect(63), [], 'off-grid records register nowhere');

// ---- getContent and unregisterContent helpers ------------------------------
assert.deepEqual(reg.getContent('treeCluster', 36), [0]);
assert.deepEqual(reg.getContent('treeCluster', 63), []);
assert.deepEqual(reg.getContent('nonExistent', 36), []);

const auxMeshes = [
  { id: 'water0', x: 0, z: 0, r: 32 },
  { id: 'roadDecal0', x: -100, z: -100, r: 10 },
];
reg.registerContent(auxMeshes, 'auxiliaryMesh');
assert.equal(reg.getContent('auxiliaryMesh', reg.indexAt(0, 0)).length, 1);
reg.unregisterContent('auxiliaryMesh');
assert.deepEqual(reg.getContent('auxiliaryMesh', reg.indexAt(0, 0)), []);

// ---- determinism -----------------------------------------------------------
const a = createCellLifecycle(), b = createCellLifecycle();
const path = [[0, 0], [90, 0], [90, 300], [-350, 300], [-350, -480], [480, 480]];
for (const [x, z] of path) {
  a.update(x, z, null, null, true);
  b.update(x, z, null, null, true);
}
a.update(200, 200, -100, 50); // focus flip mid-sequence
b.update(200, 200, -100, 50);
assert.deepEqual(Array.from(a.states), Array.from(b.states),
  'identical observer paths reproduce identical cell states');

// ---- stats + query helpers -------------------------------------------------
const s = a.stats();
const sum = s.ACTIVE + s.VISIBLE + s.SHADOW_ONLY + s.DISTANT + s.DORMANT;
assert.equal(sum, 64, 'per-state counts cover the whole grid');
assert.equal(s.version, a.version);
assert.equal(a.stateAt(2000, 0), CELL_STATES.DORMANT, 'outside the grid is DORMANT');
assert.equal(a.updateScaleAt(2000, 0), 0, 'outside the grid updates nothing');
assert.equal(b.updateScaleAt(200, 200), 1, 'an ACTIVE cell ticks at full rate');

// ---- ambient and auxiliary query helpers -----------------------------------
assert.equal(a.ambientScaleAt(200, 200), 1, 'ACTIVE cell has ambientScale 1');
assert.equal(a.isAmbientActiveAt(200, 200), true, 'ACTIVE cell has ambient active');
assert.equal(a.isAuxiliaryVisibleAt(200, 200), true, 'ACTIVE cell auxiliary visible');
assert.equal(a.sceneryLodAt(200, 200), 0, 'ACTIVE cell scenery LOD 0');

assert.equal(a.ambientScaleAt(2000, 0), 0, 'DORMANT cell has ambientScale 0');
assert.equal(a.isAmbientActiveAt(2000, 0), false, 'DORMANT cell has ambient inactive');
assert.equal(a.isAuxiliaryVisibleAt(2000, 0), false, 'DORMANT cell auxiliary hidden');
assert.equal(a.sceneryLodAt(2000, 0), 2, 'DORMANT cell scenery LOD 2');

const observerCell = a.indexAt(200, 200);
assert.equal(a.isCellActive(observerCell), true);
assert.equal(a.isCellVisible(observerCell), true);
assert.equal(a.isCellRendered(observerCell), true);
assert.equal(a.isCellDormant(observerCell), false);
assert.equal(a.isCellDormant(-1), true);

let inStateCount = 0;
a.forEachInState(CELL_STATES.VISIBLE, (idx, st) => {
  assert.ok(st <= CELL_STATES.VISIBLE);
  inStateCount++;
});
assert.equal(inStateCount, s.ACTIVE + s.VISIBLE);

const activeCells = a.getActiveCells(CELL_STATES.VISIBLE);
assert.equal(activeCells.length, inStateCount);

// ---- policy tables ---------------------------------------------------------
assert.equal(CELL_STATE_NAMES.length, 5);
assert.deepEqual(Array.from(CELL_UPDATE_SCALE), [1, 0.5, 0, 0, 0]);
assert.deepEqual(Array.from(CELL_PROP_UPDATE), [1, 0.5, 0, 0, 0]);
assert.deepEqual(Array.from(CELL_DECAL_VISIBLE), [true, true, true, false, false],
  'ground decals cull in DISTANT and DORMANT');
assert.deepEqual(Array.from(CELL_CLUTTER_PHYSICS), [true, true, false, false, false],
  'clutter physics active only in ACTIVE and VISIBLE');
assert.deepEqual(Array.from(CELL_PROP_SHADOW), [true, true, true, false, false],
  'prop shadow casting active in ACTIVE, VISIBLE, and SHADOW_ONLY');

for (const table of [CELL_SHADOW, CELL_VISIBLE, CELL_DECAL_VISIBLE, CELL_CLUTTER_PHYSICS, CELL_PROP_SHADOW]) {
  assert.equal(table.length, 5, 'one gate per state');
  for (const v of table) assert.equal(typeof v, 'boolean');
}
assert.deepEqual(CELL_SHADOW, [true, true, true, false, false],
  'shadow participation ends below DISTANT');
assert.deepEqual(CELL_VISIBLE, [true, true, true, true, false],
  'only DORMANT leaves the main pass');

console.log('cellLifecycle.selftest: bands, hysteresis, throttle, registry, determinism, prop/decal lifecycle passed');
