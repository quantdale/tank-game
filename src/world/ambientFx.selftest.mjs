import assert from 'node:assert/strict';
import {
  mulberry32,
  createAmbientEmitter,
  createDecorativeZone,
  createTerrainAuxiliaryMesh,
  createDistantSceneryLayer,
  createAmbientFxSystem,
} from './ambientFx.js';
import {
  CELL_STATES,
  createCellLifecycle,
} from './cellLifecycle.js';

// ---- deterministic PRNG -----------------------------------------------------
const r1 = mulberry32(1234), r2 = mulberry32(1234), r3 = mulberry32(5678);
for (let i = 0; i < 32; i++) {
  const v = r1();
  assert.equal(v, r2(), 'same seed reproduces the same sequence');
  assert.ok(v >= 0 && v < 1, 'samples land in [0, 1)');
}
assert.notEqual(r1(), r3(), 'different seeds diverge');

// ---- factories normalize records --------------------------------------------
const em = createAmbientEmitter({ id: 'e1', kind: 'dust', x: 5, z: 7, rate: 4 });
assert.equal(em.interval, 0.25, 'interval defaults to 1/rate');
assert.equal(em.acc, 0);
assert.equal(em.cellIndex, -1, 'cellIndex assigned at registration');
assert.deepEqual(em.vel, [0, 1.5, 0], 'default rise velocity');
assert.equal(createAmbientEmitter({ rate: 2, interval: 3 }).interval, 3,
  'explicit interval wins over 1/rate');

const zone = createDecorativeZone({});
assert.equal(zone.r, 64);
assert.deepEqual(zone.coveringCells, [], 'covering cells filled at registration');

const aux = createTerrainAuxiliaryMesh({});
assert.equal(aux.hideWhenDormant, true, 'auxiliaries hide in DORMANT by default');
assert.equal(aux.castShadow, false);

const layer = createDistantSceneryLayer({});
assert.equal(layer.activeLod, 0);

// ---- system scaffolding ------------------------------------------------------
const bare = createAmbientFxSystem();
assert.equal(bare.cells.count, 64, 'default 8x8 lifecycle grid');
const s0 = bare.update(1 / 60, null, null);
assert.equal(s0.totalEmitters, 0, 'empty system updates without emitters');
bare.registerEmitter(createAmbientEmitter({ id: 'x', x: 0, z: 0 }));
assert.equal(bare.version, 1, 'registration bumps the version');

// ---- five-state emitter ladder ----------------------------------------------
// Camera parked at (0, 480) puts the column x=4 into one cell state per row:
// row 6 ACTIVE, row 5 VISIBLE, row 4 SHADOW_ONLY, row 3 DISTANT, rows <=2 DORMANT.
const cells = createCellLifecycle();
cells.update(0, 480, null, null, true);
assert.equal(cells.stateAt(0, 330), CELL_STATES.ACTIVE);
assert.equal(cells.stateAt(0, 190), CELL_STATES.VISIBLE);
assert.equal(cells.stateAt(0, 60), CELL_STATES.SHADOW_ONLY);
assert.equal(cells.stateAt(0, -60), CELL_STATES.DISTANT);
assert.equal(cells.stateAt(0, -200), CELL_STATES.DORMANT);

function createFakeFx() {
  return {
    emits: [],
    emit(pool, params) { this.emits.push({ pool, params }); },
  };
}

const sys = createAmbientFxSystem({ cells, seed: 0xabcd });
const mk = (id, z, extra = {}) => sys.registerEmitter(createAmbientEmitter({
  id, kind: 'smoke', x: 0, z, rate: 2, burstSize: 2, ...extra,
}));
const eActive = mk('active', 330);
const eVisible = mk('visible', 190);
mk('shadow', 60);
mk('distant', -60);
const eDormant = mk('dormant', -200);
for (const e of [eActive, eVisible, eDormant]) {
  assert.ok(e.cellIndex >= 0, `${e.id} emitter resolved a cell`);
}
assert.equal(cells.states[eActive.cellIndex], CELL_STATES.ACTIVE);
assert.equal(cells.states[eVisible.cellIndex], CELL_STATES.VISIBLE);
assert.equal(cells.states[eDormant.cellIndex], CELL_STATES.DORMANT);

const fx = createFakeFx();
let st = sys.update(1, null, fx);
assert.equal(st.totalEmitters, 5);
assert.equal(st.activeEmitters, 1, 'only the ACTIVE-cell emitter runs at full rate');
assert.equal(st.visibleEmitters, 1, 'the VISIBLE-cell emitter ticks at half cadence');
assert.equal(st.skippedEmitters, 3, 'SHADOW_ONLY/DISTANT/DORMANT emitters skip');
assert.equal(st.dormantEmitters, 1);
// ACTIVE: acc 1.0 -> two 0.5 s intervals x burstSize 2 = 4; VISIBLE: 0.5 -> one interval = 2.
assert.equal(st.particlesEmitted, 6, 'VISIBLE cadence halves ACTIVE throughput');
assert.equal(fx.emits.length, 3, 'two ACTIVE bursts + one VISIBLE burst reach the fx seam');
assert.ok(fx.emits.every((e) => e.pool === 'smoke'));
assert.equal(st.cpuTicksSaved, 3, 'each gated-out emitter saves its tick');
assert.equal(st.version, sys.version);

// Steady state keeps the 2:1 ratio across ten seconds.
fx.emits.length = 0;
for (let i = 0; i < 10; i++) sys.update(1, null, fx);
st = sys.getStats();
assert.equal(fx.emits.length, 30, 'ten seconds: 3 bursts/frame (2 ACTIVE + 1 VISIBLE)');
assert.equal(st.particlesEmitted, 6, 'particlesEmitted reports the last frame only');

// ---- disabled emitters --------------------------------------------------------
sys.registerEmitter(createAmbientEmitter({
  id: 'off', kind: 'fire', x: 0, z: 330, rate: 10, enabled: false,
}));
fx.emits.length = 0;
st = sys.update(1, null, fx);
assert.equal(st.skippedEmitters, 4, 'disabled emitters skip like gated ones');
assert.equal(fx.emits.length, 3, 'the disabled emitter contributes no bursts');

// ---- kind -> particle pool mapping -------------------------------------------
const chimney = sys.registerEmitter(createAmbientEmitter({
  id: 'chimney', kind: 'chimney', x: 0, z: 330, rate: 1,
}));
fx.emits.length = 0;
st = sys.update(1, null, fx);
assert.ok(fx.emits.some((e) => e.pool === 'smoke'),
  'chimney emitters feed the shared smoke pool');

// ---- decorative zones take their richest covering cell -----------------------
const mixed = sys.registerDecorativeZone(createDecorativeZone({
  id: 'mixed', kind: 'pollen', x: 0, y: 2, z: 260, r: 100, count: 16,
}));
assert.ok(mixed.coveringCells.includes(cells.indexAt(0, 260)),
  'zone covers its center cell');
let best = CELL_STATES.DORMANT;
for (const c of mixed.coveringCells) best = Math.min(best, cells.states[c]);
assert.equal(best, CELL_STATES.ACTIVE, 'zone spans an ACTIVE row');

const dead = sys.registerDecorativeZone(createDecorativeZone({
  id: 'dead', kind: 'snowFlurries', x: 0, y: 2, z: -200, r: 50, count: 16,
}));
for (const c of dead.coveringCells) {
  assert.equal(cells.states[c], CELL_STATES.DORMANT, 'dead zone sits fully in DORMANT rows');
}

fx.emits.length = 0;
st = sys.update(1, null, fx);
assert.equal(st.activeDecorativeZones, 1, 'only the mixed zone emits');
assert.equal(st.particlesEmitted, 8,
  '6 emitter particles + chimney + one decorative particle this frame');
assert.equal(fx.emits.at(-1).pool, 'sparks', 'pollen feeds the sparks pool');
assert.ok(Math.hypot(fx.emits.at(-1).params.origin[0],
  fx.emits.at(-1).params.origin[2] - 260) <= 100,
  'decorative spawn stays inside the zone radius');

// ---- decorative determinism (seeded drift) ------------------------------------
function runSeeded(seed) {
  const c2 = createCellLifecycle();
  c2.update(0, 480, null, null, true);
  const s2 = createAmbientFxSystem({ cells: c2, seed });
  s2.registerDecorativeZone(createDecorativeZone({
    id: 'dz', kind: 'cinders', x: 0, y: 2, z: 260, r: 100, count: 8,
  }));
  const f2 = createFakeFx();
  for (let i = 0; i < 5; i++) s2.update(1, null, f2);
  return f2.emits.map((e) => e.params.origin.map((v) => Math.round(v * 1000)));
}
assert.deepEqual(runSeeded(99), runSeeded(99), 'same seed reproduces spawns exactly');
assert.notDeepEqual(runSeeded(99), runSeeded(100), 'seeds vary the scatter');

// ---- auxiliary meshes: visibility + shadow gates ------------------------------
const auxSys = createAmbientFxSystem({ cells });
const meshActive = { visible: false, castShadow: false };
const meshShadowOnly = { visible: false, castShadow: false };
const meshDistant = { visible: false, castShadow: false };
const meshDormant = { visible: false, castShadow: false };
const meshKept = { visible: false, castShadow: false };
const meshDisabled = { visible: true, castShadow: false };
auxSys.registerAuxiliaryMesh(createTerrainAuxiliaryMesh({
  id: 'a-active', mesh: meshActive, x: 0, z: 330, castShadow: true,
}));
auxSys.registerAuxiliaryMesh(createTerrainAuxiliaryMesh({
  id: 'a-shadow', mesh: meshShadowOnly, x: 0, z: 60, castShadow: true,
}));
auxSys.registerAuxiliaryMesh(createTerrainAuxiliaryMesh({
  id: 'a-distant', mesh: meshDistant, x: 0, z: -60, castShadow: true,
}));
auxSys.registerAuxiliaryMesh(createTerrainAuxiliaryMesh({
  id: 'a-dormant', mesh: meshDormant, x: 0, z: -200, castShadow: true,
}));
auxSys.registerAuxiliaryMesh(createTerrainAuxiliaryMesh({
  id: 'a-kept', mesh: meshKept, x: 0, z: -200, hideWhenDormant: false,
}));
auxSys.registerAuxiliaryMesh(createTerrainAuxiliaryMesh({
  id: 'a-disabled', mesh: meshDisabled, x: 0, z: 330, enabled: false,
}));

st = auxSys.update(1, null, null);
assert.equal(meshActive.visible, true, 'ACTIVE-cell auxiliary renders');
assert.equal(meshActive.castShadow, true, 'ACTIVE-cell auxiliary casts shadows');
assert.equal(meshShadowOnly.visible, true, 'SHADOW_ONLY keeps the auxiliary visible');
assert.equal(meshShadowOnly.castShadow, true, 'SHADOW_ONLY still casts shadows');
assert.equal(meshDistant.visible, true, 'DISTANT keeps the auxiliary visible');
assert.equal(meshDistant.castShadow, false, 'DISTANT drops shadow casting');
assert.equal(meshDormant.visible, false, 'DORMANT hides the auxiliary (0 GPU draws)');
assert.equal(meshKept.visible, true, 'hideWhenDormant=false survives DORMANT');
assert.equal(meshDisabled.visible, false, 'disabled auxiliaries hide');
assert.equal(st.visibleAuxMeshes, 4);
assert.equal(st.dormantAuxMeshes, 2, 'hidden + disabled both save draws');
assert.ok(st.gpuDrawsSaved >= 2);

// ---- distant scenery layers follow CELL_SCENERY_LOD ---------------------------
const geo = [{ geometry: { id: 'g0' } }, { geometry: { id: 'g1' } }, { geometry: { id: 'g2' } }];
const card = { geometry: geo[0].geometry };
auxSys.registerSceneryLayer(createDistantSceneryLayer({
  id: 'treeline', object: card, x: 0, z: 330, lods: geo,
}));
auxSys.update(1, null, null);
assert.equal(card.geometry.id, 'g0', 'ACTIVE cell pins LOD 0');
cells.update(0, -480, null, null, true); // drive away: row 6 falls to DORMANT
auxSys.update(1, null, null);
assert.equal(card.geometry.id, 'g2', 'DORMANT cell swaps to the coarsest card');
cells.update(0, 480, null, null, true); // drive back
auxSys.update(1, null, null);
assert.equal(card.geometry.id, 'g0', 'returning restores the fine card');

// ---- reset restores accumulators, visibility, and counters --------------------
sys.reset();
assert.equal(eActive.acc, 0, 'emitter accumulators clear');
assert.equal(mixed.acc, 0, 'zone accumulators clear');
const rs = sys.getStats();
assert.equal(rs.particlesEmitted, 0);
assert.equal(rs.cpuTicksSaved, 0);
assert.equal(rs.gpuDrawsSaved, 0);

auxSys.reset();
assert.equal(meshDormant.visible, true, 'reset unhides auxiliaries for rematch');

// ---- getStats returns a copy ---------------------------------------------------
const snapshot = sys.getStats();
snapshot.particlesEmitted = 12345;
assert.equal(sys.getStats().particlesEmitted, 0, 'callers cannot mutate live telemetry');

// ---- updateCount / version bookkeeping -----------------------------------------
const before = sys.updateCount;
sys.update(1 / 60, null, null);
assert.equal(sys.updateCount, before + 1);
assert.ok(sys.version > 0);

console.log('ambientFx.selftest: PRNG, factories, five-state emitter ladder, decorative zones, aux meshes, scenery LOD, reset passed');
