// vegetationLod.selftest.mjs — deterministic LOD/cull coverage for
// world/vegetation.js, run headless in pure Node (no browser, no GL).
//
// The REAL builder runs here: a stub 2D-canvas DOM lets the procedural
// texture painters execute (pixel content is irrelevant to the placement/
// partition/cull logic under test) and a flat synthetic height field stands
// in for terrain. Covered:
//   1. midfieldGrassFraction curve pins (near field untouched, tail drains).
//   2. behind-camera midfield chunk suppression — exact per-chunk visibility
//      against the camera forward, symmetric on turn, disabled when camFwd
//      is null/vertical.
//   3. tree near/far partition: slot conservation across teleports, cross-
//      fade transitions drain, dt=0 deterministic snap.
//   4. seeded determinism: two builds driven through identical camera
//      scripts produce byte-identical instance buffers; a different seed
//      does not.
// WA3 additions:
//   5. world-cell gating: sub-throttle jitter without class flips performs no
//      repartition scan; a focus-driven class flip triggers one with zero
//      camera drift (the cell path, not the drift net).
//   6. wind clock gate: the phase advances while sway-capable vegetation
//      renders, parks on vegetation-free stretches, and setWindTime still
//      pins absolutely (screenshot freeze contract).
//   7. preset levers: grassMidFadeEnd/grassTaperEnd override the hardcoded
//      desktop bands when present on the live preset; absence falls back.

import assert from 'node:assert/strict';

// --- headless canvas shim (must be installed before the module import) ----
class ImageDataShim {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
}
const ctx2d = () => ({
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
  quadraticCurveTo() {}, closePath() {}, arc() {}, ellipse() {}, fill() {},
  stroke() {}, save() {}, restore() {}, translate() {}, rotate() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  getImageData: (x, y, w, h) => new ImageDataShim(new Uint8ClampedArray(w * h * 4), w, h),
  putImageData() {},
});
globalThis.ImageData = ImageDataShim;
globalThis.document = {
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => ctx2d() }
    : { tagName: String(tag).toUpperCase() },
};

const { createVegetation, midfieldGrassFraction } = await import('./vegetation.js');
const { getPreset } = await import('../engine/quality.js');

// Desktop constants replicated from vegetation.js (the selftest deliberately
// pins them; Node resolves the 'desktop' device tier).
const CHUNK_SIZE = 128;
const CHUNK_EDGE_R = CHUNK_SIZE * 0.71; // chunk circumradius used as margin
const GRASS_FADE_END = 180;
const GRASS_TAPER_END = 155;

function flatHeightField() {
  return {
    _layout: {
      village: { x0: -5000, x1: -4999, z0: -5000, z1: -4999 },
      spawns: {
        player: { x: 0, z: 0 },
        enemies: [{ x: 300, z: 0 }, { x: -300, z: 0 }, { x: 0, z: 300 }],
      },
    },
    _noVeg: () => false,
    getGroundType: () => 'grass',
    _roadDist: () => 999,
    _villageMask: () => 0,
    getHeightAt: () => 0,
    getNormalAt: () => ({ x: 0, y: 1, z: 0 }),
  };
}
const engineCtx = { setupShadowMaterial() {} };

// --- 1. midfield density curve --------------------------------------------
{
  const f = (d) => midfieldGrassFraction(d, GRASS_FADE_END, GRASS_TAPER_END);
  assert.equal(f(0), 1, 'near field keeps full midfield density');
  assert.equal(f(55.9), 1, 'full density holds to the taper start');
  assert.ok(Math.abs(f(GRASS_TAPER_END) - 0.06) < 1e-9,
    'taper floor at taperEnd is unchanged (6%)');
  assert.equal(f(GRASS_FADE_END - 12), 0, 'residue fully drained before scale-out end');
  assert.equal(f(GRASS_FADE_END), 0);
  assert.equal(f(400), 0, 'beyond fade end stays zero');
  let prev = Infinity;
  for (let d = 0; d <= 200; d += 0.5) {
    const v = f(d);
    assert.ok(v >= 0 && v <= 1, `fraction in range at ${d}`);
    assert.ok(v <= prev + 1e-12, `fraction non-increasing at ${d}`);
    prev = v;
  }
  // generic shape also holds for the mobile band (132/112)
  assert.ok(Math.abs(midfieldGrassFraction(112, 132, 112) - 0.06) < 1e-9,
    'mobile taper floor preserved');
}

// --- shared build + classification helpers --------------------------------
function classify(veg) {
  const instanced = [];
  veg.group.traverse((o) => { if (o.isInstancedMesh) instanced.push(o); });
  return {
    instanced,
    trunks: instanced.filter((m) => m.userData.treeTrunk),
    grass: instanced.filter((m) => m.userData.grassChunkCx !== undefined),
  };
}
const sumCount = (ms) => ms.reduce((s, m) => s + m.count, 0);

const veg = createVegetation(flatHeightField(), engineCtx, 2001, null);
const { instanced, trunks, grass } = classify(veg);
assert.equal(grass.length, 128, '8x8 midfield chunks x 2 tuft variants');
assert.ok(trunks.length >= 8, 'trunk meshes exist for every species variant pair');

// --- 2. behind-camera chunk suppression ------------------------------------
// Expected visibility replicates update(): density fraction > 0 AND not
// entirely behind the horizontal camera plane.
function expectedVisible(cx, cz, camX, camZ, fx, fz) {
  const d = Math.max(0, Math.hypot(cx - camX, cz - camZ) - CHUNK_EDGE_R);
  if (midfieldGrassFraction(d, GRASS_FADE_END, GRASS_TAPER_END) <= 0) return false;
  if (fx === null) return true; // cull inactive
  return (cx - camX) * fx + (cz - camZ) * fz >= -(CHUNK_EDGE_R + 6);
}
function checkVisibility(label, camX, camZ, fwd) {
  let fx = null, fz = null;
  if (fwd) {
    const fl = Math.hypot(fwd.x, fwd.z);
    if (fl > 0.2) { fx = fwd.x / fl; fz = fwd.z / fl; }
  }
  for (const m of grass) {
    const cx = m.userData.grassChunkCx, cz = m.userData.grassChunkCz;
    const want = expectedVisible(cx, cz, camX, camZ, fx, fz);
    assert.equal(m.visible, want,
      `${label}: chunk (${cx},${cz}) visibility`);
  }
}

veg.update(0.016, v3(0, 0, 0), v3(0, 0, 1), null); // first update builds partition
checkVisibility('fwd +z @ origin', 0, 0, { x: 0, z: 1 });
const visibleFwd = grass.filter((m) => m.visible).length;

veg.update(0.016, v3(0, 0, 0), v3(0, 0, -1), null); // turned around
checkVisibility('fwd -z @ origin', 0, 0, { x: 0, z: -1 });
const visibleBack = grass.filter((m) => m.visible).length;
assert.ok(visibleFwd < 128 && visibleBack < 128,
  `cull hides rear chunks both ways (${visibleFwd}/${visibleBack}/128)`);

// rear rows hidden forward are exactly the front rows hidden backward:
// re-check the +z frame and assert no chunk is visible in BOTH facings
// beyond the conservative near-behind band.
veg.update(0.016, v3(0, 0, 0), v3(0, 0, 1), null);
const visSet = new Set(grass.filter((m) => m.visible));
veg.update(0.016, v3(0, 0, 0), v3(0, 0, -1), null);
let bothFacings = 0;
for (const m of grass) if (m.visible && visSet.has(m)) bothFacings++;
assert.ok(bothFacings > 0, 'conservative margin keeps the side bands visible');

// cull disabled: null and vertical forwards behave identically (density-only)
veg.update(0.016, v3(0, 0, 0), null, null);
checkVisibility('null fwd @ origin', 0, 0, null);
const visibleNull = grass.filter((m) => m.visible).length;
veg.update(0.016, v3(0, 0, 0), v3(0, 1, 0), null); // top-down rig
checkVisibility('vertical fwd @ origin', 0, 0, { x: 0, y: 1, z: 0 });
assert.ok(visibleNull > Math.max(visibleFwd, visibleBack),
  'cull actually removes draws vs the unculled frame');

// counts survive hide/show cycles (turn back and forth, then verify content)
veg.update(0.016, v3(0, 0, 0), v3(0, 0, 1), null);
const countsAfterTurns = new Map(grass.map((m) => [m, m.count]));
checkVisibility('fwd +z restored', 0, 0, { x: 0, z: 1 });
for (const m of grass) {
  assert.equal(m.count, countsAfterTurns.get(m),
    `chunk mesh count stable through cull cycling (${m.userData.grassChunkCx})`);
}

// --- 3. tree near/far partition --------------------------------------------
const stats = () => veg._partitionStats();
function drainTransitions(x = 0, z = 0) {
  let guard = 0;
  while (stats().transitioning > 0 && guard++ < 80) {
    veg.update(0.05, v3(x, 0, z), v3(0, 0, 1), null);
  }
  assert.equal(stats().transitioning, 0, 'cross-fades drain within sim time');
}
// Two updates per station: a frame whose camera crosses a carpet cell is
// consumed by the carpet upload (the deliberate rebuild staggering in
// update()), so the repartition lands on the following update.
function moveTo(x, z, dt = 0) {
  veg.update(dt, v3(x, 0, z), v3(0, 0, 1), null);
  veg.update(dt, v3(x, 0, z), v3(0, 0, 1), null);
  drainTransitions(x, z);
}
moveTo(0, 0);
const total = stats().near + stats().far; // conservation baseline
{
  const s = stats();
  assert.equal(s.transitioning, 0, 'settled baseline');
  assert.equal(s.near + s.far, total, 'slot totals conserved');
  assert.equal(sumCount(trunks), total,
    'every tree occupies exactly one trunk instance slot per partition');
}
// teleport: dt=0 must snap the repartition deterministically (shot mode)
moveTo(420, 420);
{
  const s = stats();
  assert.equal(s.transitioning, 0, 'dt=0 snaps LOD transitions complete');
  assert.equal(s.near + s.far, total, 'conservation after teleport snap');
  assert.equal(sumCount(trunks), total);
}
// drive between distinct stations; the near SET must respond to camera
// movement (membership fingerprint — counts alone can tie on a uniform
// field) while the population stays conserved
const nearPrints = [];
for (const [x, z] of [[0, 0], [300, -260], [-420, 380]]) {
  moveTo(x, z);
  const s = stats();
  assert.equal(s.near + s.far, total, `conservation at station (${x},${z})`);
  assert.equal(sumCount(trunks), total);
  nearPrints.push(s.nearFingerprint);
}
assert.ok(new Set(nearPrints).size > 1,
  'near-set membership responds to camera movement');

// --- 4. seeded determinism --------------------------------------------------
function hashVegetation(v) {
  const { instanced: meshes } = classify(v);
  let h = 0x811c9dc5;
  const mix = (x) => { h = (Math.imul(h ^ x, 16777619)) | 0; };
  for (const m of meshes) {
    mix(m.count); mix(m.visible ? 1 : 0);
    const ma = m.instanceMatrix.array;
    for (let i = 0; i < m.count * 16; i++) mix(ma[i] * 1000 | 0);
    if (m.instanceColor) {
      const ca = m.instanceColor.array;
      for (let i = 0; i < m.count * 3; i++) mix(ca[i] * 100000 | 0);
    }
  }
  return h;
}
function driveScript(v) {
  const steps = [
    [0.016, [0, 0, 0], [0, 0, 1]],
    [0.016, [10, 0, 30], [0, 0, 1]], // crosses a carpet cell boundary
    [0.016, [24, 0, 47], [0, 0, 1]],
    [0, [200, 0, -350], [0.94, 0, -0.34]], // teleport: repartition + snap
    [0.05, [200, 0, -350], [0.94, 0, -0.34]],
    [0.05, [206, 0, -356], [0.94, 0, -0.34]],
    [0.05, [212, 0, -362], [0.94, 0, -0.34]],
    [0.05, [218, 0, -368], [0.94, 0, -0.34]],
    [0.05, [224, 0, -374], [0.94, 0, -0.34]],
  ];
  for (const [dt, p, f] of steps) v.update(dt, v3(...p), v3(...f), null);
}
const vegA = createVegetation(flatHeightField(), engineCtx, 2001, null);
const vegB = createVegetation(flatHeightField(), engineCtx, 2001, null);
driveScript(vegA);
driveScript(vegB);
assert.equal(hashVegetation(vegA), hashVegetation(vegB),
  'identical seeds + identical camera script => identical instance buffers');
const vegC = createVegetation(flatHeightField(), engineCtx, 2027, null);
driveScript(vegC);
assert.notEqual(hashVegetation(vegA), hashVegetation(vegC),
  'different seed produces different placement (hash is not degenerate)');

// --- 5. world-cell gating ----------------------------------------------------
{
  const tel = () => veg._telemetry();
  assert.ok(veg._cells && typeof veg._cells.version === 'number',
    'internal cell tracker exposed with a version counter');
  moveTo(-420, 380); // settle at a far station (two updates + drained fades)
  veg.update(0.016, v3(-420, 0, 380), v3(0, 0, 1), null); // settle focus-off
  const s0 = tel().scans;
  const v0 = veg._cells.version;
  // +-3 m jitter around the station: every step stays below the classifier's
  // 4 m movement throttle or reclassifies without any band flip (the station
  // sits deep inside stable ACTIVE cells), and total displacement never
  // reaches the 24 m drift net -> no repartition work at all.
  for (let i = 0; i < 12; i++) {
    veg.update(0.016, v3(-420 + (i % 2 ? 3 : 0), 0, 380 + (i % 2 ? 0 : 3)),
      v3(0, 0, 1), null);
  }
  assert.equal(tel().scans, s0,
    'sub-throttle jitter without class flips performs no repartition scan');
  assert.equal(veg._cells.version, v0, 'no cell reclassified during jitter');
  // A chase-focus popping up hundreds of meters out flips its surrounding
  // cells DORMANT/DISTANT -> ACTIVE (dual-observer interest metric). That
  // must trigger a scan with ZERO camera drift — proving the cell path (not
  // the drift net) fired.
  veg.update(0.016, v3(-420, 0, 380), v3(0, 0, 1), v3(-100, 0, 80));
  assert.ok(tel().scans > s0,
    'focus-driven cell class flips trigger a repartition scan');
  assert.ok(veg._cells.version > v0, 'lifecycle version advanced across the flip');
  veg.update(0.016, v3(-420, 0, 380), v3(0, 0, 1), null); // focus off again
}

// --- 6. wind clock gate ------------------------------------------------------
{
  const tel = () => veg._telemetry();
  // Default verdant build: midfield chunks render inside the shader sway
  // radius from any position, so dt > 0 frames must keep advancing the phase.
  const t0 = tel().windTime;
  veg.update(0.05, v3(-420, 0, 380), v3(0, 0, 1), null);
  assert.ok(tel().windTime > t0,
    'wind clock advances while sway-capable vegetation renders');
  // Vegetation-free config: no trees, no bushes, no chunk tufts, empty
  // carpet -> nothing on screen can show sway, so the clock must park even
  // while frames advance and the camera drives.
  const bareVeg = createVegetation(flatHeightField(), engineCtx, 2001,
    { vegetation: { clusterCount: 0, loneCount: 0, rimCount: 0, bushCount: 0,
      grassDensity: 0 } });
  bareVeg.update(0.016, v3(0, 0, 0), v3(0, 0, 1), null);
  assert.equal(bareVeg._telemetry().windLive, false,
    'bare map reports no sway sources after classification');
  const w0 = bareVeg._telemetry().windTime;
  bareVeg.update(0.05, v3(40, 0, 0), v3(0, 0, 1), null);
  bareVeg.update(0.05, v3(80, 0, 0), v3(0, 0, 1), null);
  assert.equal(bareVeg._telemetry().windTime, w0,
    'wind clock parks on vegetation-free stretches');
  bareVeg.setWindTime(123.5); // screenshot freeze contract is untouched
  assert.equal(bareVeg._telemetry().windTime, 123.5,
    'setWindTime still pins the phase absolutely');
}

// --- 7. preset grass-range levers --------------------------------------------
{
  const preset = getPreset();
  const prevFade = preset.grassMidFadeEnd;
  const prevTaper = preset.grassTaperEnd;
  try {
    // Fallback first: without the keys, Node's desktop resolution must land
    // exactly on the hardcoded bands.
    assert.equal(veg._telemetry().grassFadeEnd, GRASS_FADE_END,
      'missing preset keys fall back to the desktop fade end');
    assert.equal(veg._telemetry().grassTaperEnd, GRASS_TAPER_END,
      'missing preset keys fall back to the desktop taper end');
    // With keys present, both the reported range and the visible chunk band
    // follow the preset: a chunk whose edge distance sits between the two
    // fade ends must drop out entirely under the shorter range.
    preset.grassMidFadeEnd = 90;
    preset.grassTaperEnd = 70;
    const vegP = createVegetation(flatHeightField(), engineCtx, 2001, null);
    assert.equal(vegP._telemetry().grassFadeEnd, 90, 'preset grassMidFadeEnd consumed');
    assert.equal(vegP._telemetry().grassTaperEnd, 70, 'preset grassTaperEnd consumed');
    // Both builds face the probe chunk from the origin so visibility reflects
    // density alone (the behind-camera cull must not confound the probe).
    veg.update(0.016, v3(0, 0, 0), v3(0, 0, 1), null);
    vegP.update(0.016, v3(0, 0, 0), v3(0, 0, 1), null);
    const probe = grass.find((m) =>
      m.userData.grassChunkCx === 192 && m.userData.grassChunkCz === 64);
    assert.ok(probe, 'probe chunk exists'); // edge distance ~111 m from origin
    const probeP = classify(vegP).grass.find((m) =>
      m.userData.grassChunkCx === 192 && m.userData.grassChunkCz === 64);
    assert.ok(probe.visible, 'probe chunk visible under the default 180 m band');
    assert.equal(midfieldGrassFraction(
      Math.hypot(192 - 0, 64 - 0) - CHUNK_EDGE_R, 90, 70), 0,
      'probe chunk density is zero under the 90 m preset band');
    assert.ok(!probeP.visible, 'probe chunk hidden under the shorter preset band');
  } finally {
    // Restore the shared preset object exactly as found.
    if (prevFade === undefined) delete preset.grassMidFadeEnd;
    else preset.grassMidFadeEnd = prevFade;
    if (prevTaper === undefined) delete preset.grassTaperEnd;
    else preset.grassTaperEnd = prevTaper;
  }
}

function v3(x, y, z) { return { x, y, z }; }

console.log('vegetationLod.selftest: density curve, behind-camera cull,'
  + ' tree partition conservation/snap, seeded determinism,'
  + ' world-cell repartition/wind gating, and preset grass-range levers passed');
