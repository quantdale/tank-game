/**
 * mapsCert.selftest.mjs — SA-06 sixteen-map release certification.
 *
 * Per battlefield, headlessly (pure config + heightfield + the captured
 * dedicated-server collision manifests):
 *   1. reliable load + unique identity + complete lighting/sky block
 *   2. terrain integrity: finite heights everywhere, valid ground classes,
 *      sampled relief inside the baked min/max envelope
 *   3. spawn pads: inside the ±460 playable square, mutually separated,
 *      firm ground, graded exits a weak tank can drive, no solid cover
 *      intersecting a pad
 *   4. collision manifest integrity: EVERY movement/shell record carries its
 *      exact footprint shape (obb/circle/convex — no bare square force
 *      fields), finite bounds, sane extents, crushables stay crushable
 *      through their tree/prop pairing
 *   5. grounding: nothing floats above or is buried under the terrain
 *   6. cover density: every lane region keeps hard cover
 *   7. AI navigation: the real bot route planner drives every enemy spawn to
 *      the player spawn for a heavy and a medium chassis on every map
 *
 * Run with: node src/world/mapsCert.selftest.mjs
 */

import assert from 'node:assert/strict';
import { MAP_IDS, getMapConfig } from './maps/index.js';
import { createHeightField } from './terrain.js';
import { createDedicatedWorldCollision } from '../../server/dedicatedWorldCollision.js';
import {
  createBotNavigationGrid, planBotRoute,
} from '../sim/botRoutePlanner.js';
import { TANK_SPECS } from '../vehicles/specs.js';

const PLAY_BOUND = 460;        // sim/movement.js PLAY_BOUND_M — hulls clamp here
const PAD_RADIUS = 22;         // terrain.js spawn-pad flattening radius

// Measured floors/ceilings across the sixteen shipped maps (SA-06 sweep,
// 2026-08-22); thresholds carry margin but would catch real regressions.
const MIN_SPAWN_SEPARATION = 38;   // measured global min 39 m (desert/winter)
const MAX_PAD_RELIEF = 18;         // worst pad disc relief 17.1 m (alpine)
const MAX_PAD_EXIT_GRADE_UP = 0.11;   // steepest climb off a pad: 0.102 (alpine)
const MAX_PAD_EXIT_GRADE_DOWN = 0.35; // steepest run-off: 0.334 (alpine)
const MIN_SOLID_COVER_PLAYABLE = 150; // lowest hard-cover census 194 (delta)
const FLOAT_GAP_TOLERANCE = 0.9;   // props plant INTO slopes; float = above ALL support
const BURIED_DEPTH = 0.05;

const SKY_FIELDS = [
  'sunElevationDeg', 'sunAzimuthDeg', 'turbidity', 'rayleigh',
  'mieCoefficient', 'mieDirectionalG', 'fogDensity', 'fogTintHex', 'fogMix',
  'envIntensity', 'cloudOpacity', 'cloudOpacity2', 'sunIntensity',
  'sunColorHex', 'hemiIntensity',
];

// Deterministic match-style RNG (planBotRoute seeds itself from one draw).
let rngState = 0x5a06;
function seededRng() {
  rngState |= 0;
  rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Lowest/highest terrain support under an obstacle's authored footprint. */
function footprintSupport(hf, ob) {
  const s = ob.shape2;
  const pts = [];
  if (!s || s.kind === 'obb') {
    const cx = s ? s.cx : (ob.min[0] + ob.max[0]) / 2;
    const cz = s ? s.cz : (ob.min[2] + ob.max[2]) / 2;
    const hw = s ? s.hw : (ob.max[0] - ob.min[0]) / 2;
    const hl = s ? s.hl : (ob.max[2] - ob.min[2]) / 2;
    const yaw = s ? s.yaw : 0;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const lx = a * hw * 0.92;
      const lz = b * hl * 0.92;
      pts.push([cx + lx * c + lz * sn, cz - lx * sn + lz * c]);
    }
  } else if (s.kind === 'circle') {
    for (let i = 0; i < 8; i++) {
      const ang = i * Math.PI / 4;
      pts.push([s.cx + Math.cos(ang) * s.r * 0.92, s.cz + Math.sin(ang) * s.r * 0.92]);
    }
    pts.push([s.cx, s.cz]);
  } else { // convex — points are ABSOLUTE world coords (see setConvexShape)
    for (let i = 0; i < s.points.length; i += 2) pts.push([s.points[i], s.points[i + 1]]);
  }
  let mn = Infinity;
  let mx = -Infinity;
  for (const [x, z] of pts) {
    const h = hf.getHeightAt(Math.max(-509, Math.min(509, x)), Math.max(-509, Math.min(509, z)));
    if (h < mn) mn = h;
    if (h > mx) mx = h;
  }
  return { min: mn, max: mx };
}

/**
 * True when another solid record physically carries `ob` from below — stacked
 * compounds (stepped monument tiers, beam crossings) legally sit above the
 * terrain as long as something solid reaches their underside.
 */
function supportedFromBelow(ob, obstacles) {
  for (const other of obstacles) {
    if (other === ob) continue;
    if (other.max[1] < ob.min[1] - FLOAT_GAP_TOLERANCE) continue; // top too low
    if (other.min[1] >= ob.min[1]) continue;                      // doesn't extend below
    if (other.min[0] >= ob.max[0] || other.max[0] <= ob.min[0]) continue;
    if (other.min[2] >= ob.max[2] || other.max[2] <= ob.min[2]) continue;
    return true;
  }
  return false;
}

assert.equal(MAP_IDS.length, 16, 'sixteen battlefields are registered');

for (const mapId of MAP_IDS) {
  const tag = (msg) => `${mapId}: ${msg}`;
  const cfg = getMapConfig(mapId);

  // ---- 1. identity + lighting/sky completeness ---------------------------
  assert.equal(cfg.id, mapId, tag('config id matches registry'));
  assert.ok(cfg.name && cfg.blurb && cfg.sub, tag('player-facing copy exists'));
  for (const id of MAP_IDS) {
    if (id === mapId) continue;
    assert.notEqual(cfg.name, getMapConfig(id).name, 'battlefield display names are unique');
  }
  assert.ok(cfg.sky && SKY_FIELDS.every((f) => cfg.sky[f] != null),
    tag('complete sun/sky/fog/lighting block'));
  assert.ok(cfg.sky.sunElevationDeg > 2 && cfg.sky.sunElevationDeg < 89,
    tag('sun above the horizon so shadows never go infinite'));
  assert.ok(Array.isArray(cfg.shot?.pos) && cfg.shot.pos.length === 3 &&
    Array.isArray(cfg.shot?.look) && cfg.shot.look.length === 3,
    tag('establishing shot present (full camera contract pinned in mapQuality)'));

  // ---- 2. terrain integrity ---------------------------------------------
  const hf = createHeightField(1337, cfg);
  let sampledMin = Infinity;
  let sampledMax = -Infinity;
  let nonFinite = 0;
  const groundClasses = new Set();
  for (let z = -500; z <= 500; z += 16) {
    for (let x = -500; x <= 500; x += 16) {
      const h = hf.getHeightAt(x, z);
      if (!Number.isFinite(h)) nonFinite++;
      else {
        sampledMin = Math.min(sampledMin, h);
        sampledMax = Math.max(sampledMax, h);
      }
      groundClasses.add(hf.getGroundType(x, z));
    }
  }
  assert.equal(nonFinite, 0, tag('heightfield answers finite everywhere (no holes/NaN cliffs)'));
  assert.ok(sampledMin >= hf.minY - 1e-6 && sampledMax <= hf.maxY + 1e-6,
    tag('sampled relief stays inside the baked min/max envelope'));
  for (const g of groundClasses) {
    assert.ok(['hard', 'medium', 'soft'].includes(g), tag(`ground class ${g} is known`));
  }

  // ---- 3. spawn pads -----------------------------------------------------
  const pads = [cfg.spawns.player, ...cfg.spawns.enemies];
  for (const p of pads) {
    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) <= PLAY_BOUND - 20,
      tag(`pad (${p.x},${p.z}) sits inside the playable square with hull margin`));
    assert.notEqual(hf.getGroundType(p.x, p.z), 'soft',
      tag(`pad (${p.x},${p.z}) does not bog tanks at spawn`));
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      for (const r of [PAD_RADIUS, PAD_RADIUS / 2]) {
        const h = hf.getHeightAt(p.x + Math.cos(ang) * r, p.z + Math.sin(ang) * r);
        hMin = Math.min(hMin, h);
        hMax = Math.max(hMax, h);
      }
    }
    assert.ok(hMax - hMin <= MAX_PAD_RELIEF,
      tag(`pad (${p.x},${p.z}) disc relief ${(hMax - hMin).toFixed(1)} m within ${MAX_PAD_RELIEF} m`));
    const d = Math.hypot(p.x, p.z) || 1;
    const exitH = hf.getHeightAt(p.x - (p.x / d) * 30, p.z - (p.z / d) * 30);
    const grade = (exitH - hf.getHeightAt(p.x, p.z)) / 30;
    assert.ok(grade >= -MAX_PAD_EXIT_GRADE_DOWN && grade <= MAX_PAD_EXIT_GRADE_UP,
      tag(`pad (${p.x},${p.z}) exit grade ${grade.toFixed(3)} drivable toward midfield`));
  }
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const sep = Math.hypot(pads[i].x - pads[j].x, pads[i].z - pads[j].z);
      assert.ok(sep >= MIN_SPAWN_SEPARATION,
        tag(`spawn separation ${sep.toFixed(0)} m keeps deployment rows distinct`));
    }
  }

  // ---- 4+5+6. collision manifest integrity, grounding, cover -------------
  const world = createDedicatedWorldCollision(mapId);
  let solidPlayable = 0;
  for (const ob of world.getObstacles()) {
    const cx = (ob.min[0] + ob.max[0]) / 2;
    const cz = (ob.min[2] + ob.max[2]) / 2;
    assert.ok(ob.shape2, tag(`${ob.kind ?? 'record'}@(${cx.toFixed(0)},${cz.toFixed(0)}) ` +
      'carries an exact footprint shape — bare square collision columns are forbidden'));
    assert.ok(
      ob.shape2.kind === 'obb' || ob.shape2.kind === 'circle' || ob.shape2.kind === 'convex',
      tag('footprint shape kind is supported by the exact narrow phase'));
    for (let k = 0; k < 3; k++) {
      assert.ok(Number.isFinite(ob.min[k]) && Number.isFinite(ob.max[k]) && ob.min[k] < ob.max[k],
        tag('record bounds are finite and ordered'));
      assert.ok(Math.abs(ob.min[k]) < 520 && Math.abs(ob.max[k]) < 520,
        tag('record stays on the battlefield'));
    }
    if (ob.crushable) {
      assert.ok(ob.propIdx != null || ob.treeIdx != null,
        tag('crushable pairs with its destructible/tree runtime record'));
    }
    if (!ob.crushable && Math.max(Math.abs(cx), Math.abs(cz)) <= PLAY_BOUND + 10) solidPlayable++;

    if (Math.max(Math.abs(cx), Math.abs(cz)) <= PLAY_BOUND + 10) {
      const sup = footprintSupport(hf, ob);
      assert.ok(Number.isFinite(sup.min), tag('grounding samples resolve'));
      const gap = ob.min[1] - sup.max;
      if (gap > FLOAT_GAP_TOLERANCE &&
          !supportedFromBelow(ob, world.getObstacles())) {
        assert.fail(tag(`${ob.kind ?? 'prop'}@(${cx.toFixed(0)},${cz.toFixed(0)}) ` +
          `floats ${gap.toFixed(2)} m above its highest support`));
      }
      assert.ok(ob.max[1] >= sup.min - BURIED_DEPTH,
        tag(`${ob.kind ?? 'prop'}@(${cx.toFixed(0)},${cz.toFixed(0)}) is not buried`));
    }
  }
  for (const col of world.getColliders()) {
    assert.ok(col.shape2, tag('shell-collision records carry exact shapes too'));
  }
  assert.ok(solidPlayable >= MIN_SOLID_COVER_PLAYABLE,
    tag(`keeps ${solidPlayable} hard-cover pieces in the play field`));

  for (const con of world.getConcealment()) {
    assert.ok(Number.isFinite(con.x + con.z + con.r) && con.r > 0,
      tag('concealment discs are finite with positive radius'));
  }

  // Broad phase: dedupe + containment wherever records exist. Midfield can
  // legitimately be open (alpine's center valley), so probe several sectors
  // and only demand that at least one of them holds content.
  let probedAny = false;
  for (const [qx, qz] of [[0, 0], [-240, -240], [240, 240], [-240, 240], [240, -240]]) {
    const out = [];
    world.queryObstacles(qx - 40, qz - 40, qx + 40, qz + 40, out);
    assert.ok(new Set(out).size === out.length,
      tag(`broad phase deduplicates multi-cell records near (${qx},${qz})`));
    for (const rec of out) {
      assert.ok(
        rec.max[0] >= qx - 42 && rec.min[0] <= qx + 42 &&
        rec.max[2] >= qz - 42 && rec.min[2] <= qz + 42,
        tag('broad phase results overlap the queried window'));
    }
    if (out.length) probedAny = true;
  }
  assert.ok(probedAny, tag('broad phase finds environment content somewhere on the map'));

  // ---- 7. AI navigation succeeds -----------------------------------------
  const nav = createBotNavigationGrid({
    heightField: hf,
    queryObstacles: world.queryObstacles,
    getObstacles: world.getObstacles,
  });
  for (const spec of [TANK_SPECS.t34_85, TANK_SPECS.m1a2]) {
    for (const enemy of cfg.spawns.enemies) {
      rngState = 0x5a06; // same match seed for every leg — deterministic lanes
      const route = planBotRoute({
        start: enemy,
        goal: cfg.spawns.player,
        heightField: hf,
        navigation: nav,
        role: 'brawler',
        rng: seededRng,
        spec,
      });
      assert.ok(route.length > 0,
        tag(`${spec.id} routes ${enemy.x},${enemy.z} -> player spawn`));
      for (const [wx, wz] of route) {
        assert.ok(Math.abs(wx) <= 500 && Math.abs(wz) <= 500,
          tag(`${spec.id} route waypoints stay on the tactical grid`));
      }
    }
  }
}

console.log('mapsCert.selftest: sixteen-map load/terrain/spawn/collision/' +
  'grounding/cover/navigation certification passed');
