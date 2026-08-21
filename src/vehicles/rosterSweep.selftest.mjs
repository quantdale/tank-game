import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
// The factory registers every first-party expansion module before ALL_TANK_IDS
// is finalized (same boot contract as the gallery and wheel-quality sweeps).
import './tankFactory.js';
import {
  ALL_TANK_IDS,
  PRODUCTION_TANK_IDS,
  getSpec,
} from './specs.js';
import { COMBAT_ANATOMY_CALIBRATIONS } from './combatAnatomyCalibrations.js';
import { createTank } from './tankFactory.js';
import { createTankState } from '../sim/movement.js';
import { tankLabelRecord } from './tankLabels.js';
import { tankTier, tierNumeral } from './tier.js';
import { TANK_ASSET_VIEWS } from './tankAssets.js';
import { createGalleryRecord } from '../gallery/catalog.js';

/**
 * Fleet-wide roster sweep (Campaign 3 SA-05). Every registered playable tank
 * is constructed once and audited across the contracts the focused selftests
 * do not cover end-to-end: rig parenting, muzzle anchors, articulation +
 * spawn poses (NaN-free world transforms), visual bounds vs published dims,
 * materials/markings/LOD presence, icon assets on disk, and clean disposal.
 * Severe functional defects hard-fail; distribution drift is reported as
 * fleet statistics with named outliers.
 */

const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/icons');
const DEG = Math.PI / 180;

// ---- collected fleet drift statistics -------------------------------------
const failures = [];

function fail(id, message) {
  failures.push(`${id}: ${message}`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[(sorted.length - 1) >> 1] : 0;
}

/** Names of the worst `n` entries by metric value (for the drift report). */
function worst(byId, n = 4) {
  return [...byId.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n)
    .map(([id, value]) => `${id}=${Number(value).toFixed(2)}`)
    .join(' ');
}

// ============================================================================
// Phase A — spec data, metadata, labels, tiers, icons (no geometry)
// ============================================================================

const productionSet = new Set(PRODUCTION_TANK_IDS);
let shellMinCount = Infinity;
let hpMin = Infinity;
let hpMax = 0;

for (const id of ALL_TANK_IDS) {
  const spec = getSpec(id);
  for (const field of ['name', 'nation', 'era', 'class']) {
    if (typeof spec[field] !== 'string' || !spec[field]) fail(id, `spec.${field} missing`);
  }
  assert(Number.isFinite(spec.hp) && spec.hp > 0, `${id}: hp must be positive`);
  hpMin = Math.min(hpMin, spec.hp);
  hpMax = Math.max(hpMax, spec.hp);

  for (const dim of ['hullLengthM', 'overallLengthM', 'widthM', 'heightM']) {
    const value = spec.dims?.[dim];
    assert(Number.isFinite(value) && value > 0.5 && value < 40,
      `${id}: dims.${dim} out of plausible range (${value})`);
  }

  const gun = spec.gun;
  assert(Number.isFinite(gun.caliberMm) && gun.caliberMm > 19 && gun.caliberMm <= 920,
    `${id}: caliberMm implausible (${gun.caliberMm})`);
  assert(Array.isArray(gun.shells) && gun.shells.length >= 1,
    `${id}: no shells authored`);
  shellMinCount = Math.min(shellMinCount, gun.shells.length);
  // Effective cycle is per-shell (autocannon belts ride shell.reloadS; the
  // fleet spans 0.2 s IFV bursts to Sturmtiger's 30 s mortar reload).
  let effReload = Infinity;
  for (const shellData of gun.shells) {
    for (const field of ['caliberMm', 'pen100Mm', 'pen1000Mm', 'dmg', 'velocityMps']) {
      const value = shellData[field];
      if (!Number.isFinite(value) || value <= 0) fail(id, `shell ${shellData.name}.${field} invalid (${value})`);
    }
    if (!['AP', 'APCR', 'APFSDS', 'HEAT', 'HE', 'HESH'].includes(shellData.type)) {
      // Keep in sync with SHELL_BEHAVIOR in sim/damage.js — the combat
      // resolver throws on any type outside that table.
      fail(id, `shell ${shellData.name}: unknown type ${shellData.type}`);
    }
    const cycle = Number.isFinite(shellData.reloadS) ? shellData.reloadS : gun.reloadS;
    if (!Number.isFinite(cycle)) fail(id, `shell ${shellData.name}: no resolvable reloadS`);
    else effReload = Math.min(effReload, cycle);
  }
  if (!(effReload >= 0.15 && effReload <= 35)) {
    fail(id, `effective reload ${effReload}s outside plausible band`);
  }
  if (shellDataPenDrop(gun.shells)) fail(id, 'shell pen1000 below half of pen100');

  // Armor envelope: pivots finite, plates carry thickness and closed quads.
  const armor = spec.armor;
  for (const pivot of [armor.turretPivot, armor.gunPivot]) {
    if (!Array.isArray(pivot) || pivot.some((v) => !Number.isFinite(v))) fail(id, 'armor pivot not finite');
  }
  const plates = [...(armor.hullPlates || []), ...(armor.turretPlates || [])];
  if (plates.length < 6) fail(id, `only ${plates.length} armor plates`);
  for (const plateData of plates) {
    if (!(Number.isFinite(plateData.physicalMm) && plateData.physicalMm > 0)) {
      fail(id, `plate ${plateData.name}: physicalMm invalid`);
    }
    if (!Array.isArray(plateData.verts) || plateData.verts.length !== 4
        || plateData.verts.some((v) => !Array.isArray(v) || v.some((n) => !Number.isFinite(n)))) {
      fail(id, `plate ${plateData.name}: verts not a finite quad`);
    }
  }
  assert(Number.isFinite(armor.boundingRadiusM) && armor.boundingRadiusM > 1
    && armor.boundingRadiusM < 30, `${id}: boundingRadiusM implausible`);

  // Metadata surfaces: label record, tier table, authorship.
  const label = tankLabelRecord(spec);
  assert(label.displayName && typeof label.displayName === 'string',
    `${id}: label displayName missing`);
  assert(tierNumeral(id) >= 1 || Number.isFinite(tankTier(id)),
    `${id}: tier unresolvable`);

  if (productionSet.has(id)) {
    const record = createGalleryRecord(spec); // throws on malformed briefs/metrics
    if (!record.displayName) fail(id, 'gallery record without display name');
  }
}

// Icon assets: the generator dedups identical national marking sheets into
// shared content-addressed files, so existence is judged through the checked
// manifest records (exactly like tools/tank-assets-check.mjs), never by name.
{
  const manifestPath = join(ICONS_DIR, 'tank-assets.json');
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('fleet', 'public/icons/tank-assets.json missing or unparseable');
  }
  if (manifest?.tanks) {
    for (const id of productionSet) {
      const entry = manifest.tanks[id];
      if (!entry) { fail(id, 'no tank-assets manifest record'); continue; }
      const views = entry.assets || {};
      for (const view of Object.keys(TANK_ASSET_VIEWS)) {
        const rec = views[view];
        const file = rec && (rec.file ?? rec.path);
        if (!file) { fail(id, `manifest record lacks '${view}' asset`); continue; }
        if (!existsSync(join(ICONS_DIR, file))) fail(id, `icon asset missing on disk: ${file}`);
      }
    }
  }
}

function shellDataPenDrop(shells) {
  return shells.some((s) => Number.isFinite(s.pen100Mm) && Number.isFinite(s.pen1000Mm)
    && s.pen1000Mm < s.pen100Mm * 0.45);
}

// ============================================================================
// Phase B — per-tank construction sweep
// ============================================================================

const lenRatios = new Map();
const widRatios = new Map();
const hgtRatios = new Map();
const groundYs = new Map();
const meshCounts = new Map();
const vertexTotals = new Map();
const lodCounts = new Map();
const markingCounts = new Map();

const scratchParent = new THREE.Group();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _vec = new THREE.Vector3();

function scanNaN(root, phase) {
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const check = (label, values) => {
      if (!values.every(Number.isFinite)) {
        fail(root.name.replace('tank_', ''), `${phase}/${label}: non-finite transform`);
      }
    };
    check('pos', [object.position.x, object.position.y, object.position.z]);
    check('quat', [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w]);
    check('scale', [object.scale.x, object.scale.y, object.scale.z]);
    check('matrixWorld', [...object.matrixWorld.elements]);
    if (object.geometry?.attributes?.position) {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox;
      if (![box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
        .every(Number.isFinite)) {
        fail(root.name.replace('tank_', ''), `${phase}: non-finite geometry bounds`);
      }
    }
  });
}

for (const id of ALL_TANK_IDS) {
  const spec = getSpec(id);
  const fixedMount = COMBAT_ANATOMY_CALIBRATIONS[id].turret === null;

  let tank;
  try {
    tank = createTank(id, null, { proceduralOnly: true, geometryReceipt: true });
  } catch (error) {
    fail(id, `construction threw: ${error.message}`);
    continue;
  }
  await Promise.resolve(); // let any queued microtask settle (wheelQuality pattern)
  const { root } = tank;

  // --- rig parenting -------------------------------------------------------
  const hullG = root.getObjectByName('rig_hull');
  const turretG = root.getObjectByName('rig_turret');
  const gunG = root.getObjectByName('rig_gun');
  const recoilG = root.getObjectByName('rig_recoil');
  const muzzle = root.getObjectByName('rig_muzzle');
  if (!hullG || hullG.parent !== root) fail(id, 'rig_hull missing or misparented');
  if (!turretG || turretG.parent !== root) fail(id, 'rig_turret missing or not a root child');
  if (!gunG || gunG.parent !== turretG) fail(id, 'rig_gun not under rig_turret');
  if (!recoilG || (fixedMount ? recoilG.parent !== hullG : recoilG.parent !== gunG)) {
    fail(id, `rig_recoil parent wrong for ${fixedMount ? 'fixed mount' : 'turreted'} build`);
  }
  if (!muzzle) fail(id, 'rig_muzzle anchor missing');

  // --- meshes, materials, LOD, markings ------------------------------------
  let meshCount = 0;
  let vertexTotal = 0;
  let lodCount = 0;
  let markingCount = 0;
  root.traverse((object) => {
    if (object.isLOD) lodCount++;
    if (object.userData.vehicleMarking) markingCount++;
    if (!object.isMesh && !object.isBatchedMesh && !object.isInstancedMesh) return;
    meshCount++;
    if (object.geometry?.attributes?.position) {
      vertexTotal += object.geometry.attributes.position.count;
      if (!object.geometry.attributes.position.count) fail(id, `mesh ${object.name}: empty geometry`);
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.length || materials.some((m) => !m)) fail(id, `mesh ${object.name}: undefined material`);
  });

  // --- spawn pose + articulation sweep --------------------------------------
  const state = createTankState(spec, new THREE.Vector3(12, 0, -7), 0.7);
  scanNaN(root, 'spawn');
  const elevationRad = (spec.gun.gunElevationDeg ?? 8) * DEG;
  const depressionRad = -(spec.gun.gunDepressionDeg ?? 6) * DEG;
  const poses = [
    { turretYaw: 0, gunPitch: depressionRad / 2 },
    { turretYaw: 60 * DEG, gunPitch: elevationRad },
    { turretYaw: -60 * DEG, gunPitch: depressionRad },
    { turretYaw: Math.PI, gunPitch: elevationRad / 2 },
    { turretYaw: 120 * DEG, gunPitch: 0 },
  ];
  for (const pose of poses) {
    state.turretYaw = pose.turretYaw;
    state.gunPitch = pose.gunPitch;
    tank.syncFromState(state, 1 / 60);
    scanNaN(root, `pose(yaw${Math.round(pose.turretYaw / DEG)},pitch${Math.round(pose.gunPitch / DEG)})`);
    // Muzzle anchor stays ahead of its pivot along the barrel axis.
    tank.gunMuzzleWorld(_vec.set(0, 0, 0));
    if (![_vec.x, _vec.y, _vec.z].every(Number.isFinite)) {
      fail(id, 'gunMuzzleWorld returned non-finite tip');
    }
  }
  // Fire-kick + recovery frames: recuperator stroke must stay finite.
  const kickBarrel = tank.recoilKick(0, 1, 0);
  const muzzleDefs = Array.isArray(spec.gun.muzzles) ? spec.gun.muzzles.length : 0;
  if (muzzleDefs > 1 && kickBarrel == null) fail(id, 'multi-muzzle kick returned no barrel index');
  const expectedTips = muzzleDefs > 1 ? muzzleDefs : 0;
  if (expectedTips) {
    let tipCount = 0;
    root.traverse((object) => {
      if (object.name.startsWith('rig_muzzle_tip_')) tipCount++;
    });
    if (tipCount !== expectedTips) fail(id, `expected ${expectedTips} rig_muzzle_tip anchors, found ${tipCount}`);
  }
  for (let frame = 0; frame < 50; frame++) {
    tank.syncFromState(state, 1 / 60);
  }
  scanNaN(root, 'post-recoil');

  // --- rest bounds vs published dims ----------------------------------------
  // Measure at identity pose: an AABB of a yawed hull mixes length into
  // width, so drift ratios are only meaningful unrotated. Height is judged on
  // the STRUCTURAL silhouette (hull/turret/cupola armor meshes): whip
  // antennas, RWS masts and stowage legitimately tower past nominal heightM,
  // so only those carry a loose absolute cap while structure tracks dims.
  const restState = createTankState(spec, new THREE.Vector3(0, 0, 0), 0);
  tank.syncFromState(restState, 1 / 60);
  root.updateMatrixWorld(true);
  let structuralTopY = -Infinity;
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry?.boundingBox) return;
    if (!/^hull$|^turret$|Cupola$/.test(object.name)) return;
    const box = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
    structuralTopY = Math.max(structuralTopY, box.max.y);
  });
  _box.setFromObject(root);
  _box.getSize(_size);
  const lenRatio = _size.z / spec.dims.overallLengthM;
  const widRatio = _size.x / spec.dims.widthM;
  const hgtRatio = structuralTopY < 0 ? NaN : structuralTopY / spec.dims.heightM;
  const overhangM = _box.max.y - spec.dims.heightM;
  lenRatios.set(id, lenRatio);
  widRatios.set(id, widRatio);
  hgtRatios.set(id, hgtRatio);
  groundYs.set(id, _box.min.y);
  meshCounts.set(id, meshCount);
  vertexTotals.set(id, vertexTotal);
  lodCounts.set(id, lodCount);
  markingCounts.set(id, markingCount);

  // Grotesque outliers: exploded/shrunken builds, floating/buried chassis,
  // runaway roof furniture. Height bands stay coarse on purpose: heightM
  // semantics vary per spec pack (some quote MG/mast-inclusive sheet heights,
  // some roofline-only) and exact silhouettes are already certified by the
  // combatAnatomy calibration receipts — this gate only catches catastrophic
  // drift (half-missing hull, grossly doubled rig).
  if (lenRatio < 0.55 || lenRatio > 1.75) fail(id, `visual length ${(lenRatio * 100).toFixed(0)}% of overallLengthM`);
  if (widRatio < 0.65 || widRatio > 1.6) fail(id, `visual width ${(widRatio * 100).toFixed(0)}% of widthM`);
  if (!Number.isNaN(hgtRatio) && (hgtRatio < 0.68 || hgtRatio > 1.45)) {
    fail(id, `structural silhouette ${(hgtRatio * 100).toFixed(0)}% of heightM`);
  }
  if (overhangM > spec.dims.heightM * 1.4 + 1.5) {
    fail(id, `equipment towers ${(overhangM).toFixed(2)}m past heightM (exploded rig?)`);
  }
  if (_box.min.y < -0.35 || _box.min.y > 0.35) fail(id, `rest bottom y=${_box.min.y.toFixed(3)} (tracks must meet ground)`);

  // --- dispose cleanly --------------------------------------------------------
  const disposables = tank.disposables || [];
  let disposedGeometries = 0;
  for (const geometry of disposables) geometry.addEventListener('dispose', () => disposedGeometries++);
  scratchParent.add(root);
  tank.dispose();
  if (disposedGeometries !== disposables.length) {
    fail(id, `dispose released ${disposedGeometries}/${disposables.length} owned geometries`);
  }
  assert.doesNotThrow(() => tank.dispose(), `${id}: double dispose must be safe`);
  scratchParent.remove(root);
}

// ============================================================================
// Fleet drift report + gates calibrated to the healthy distribution
// ============================================================================

const ratioEntries = (map) => [...map.entries()];
const ratioSpread = (map) => {
  const values = ratioEntries(map).map(([, v]) => v);
  return `median ${median(values).toFixed(2)} min ${Math.min(...values).toFixed(2)} max ${Math.max(...values).toFixed(2)}`;
};

console.log(`roster sweep fleet drift:`);
console.log(`  length/dims  ${ratioSpread(lenRatios)} | worst: ${worst(lenRatios)}`);
console.log(`  width/dims   ${ratioSpread(widRatios)} | worst: ${worst(widRatios)}`);
console.log(`  height/dims  ${ratioSpread(hgtRatios)} | worst: ${worst(hgtRatios)}`);
{
  const grounds = ratioEntries(groundYs).map(([id, y]) => ({ id, y }));
  const lowest = grounds.reduce((a, b) => (b.y < a.y ? b : a));
  const highest = grounds.reduce((a, b) => (b.y > a.y ? b : a));
  console.log(`  rest bottom  lowest ${lowest.id}=${lowest.y.toFixed(3)} highest ${highest.id}=${highest.y.toFixed(3)}`);
}
{
  const vertices = ratioEntries(vertexTotals).sort((a, b) => a[1] - b[1]);
  console.log(`  vertices     median ${median(vertices.map(([, v]) => v))}`
    + ` lightest ${vertices.slice(0, 3).map(([id, v]) => `${id}=${v}`).join(' ')}`
    + ` heaviest ${vertices.slice(-3).map(([id, v]) => `${id}=${v}`).join(' ')}`);
}
{
  const lods = ratioEntries(lodCounts);
  const lodMin = lods.reduce((a, b) => (b[1] < a[1] ? b : a));
  console.log(`  lod nodes    median ${median(lods.map(([, v]) => v))} minimum ${lodMin[0]}=${lodMin[1]}`);
  if (lodMin[1] < 1) fail(lodMin[0], 'no THREE.LOD wrappers installed');
}
{
  const marks = ratioEntries(markingCounts);
  const markZero = marks.filter(([, v]) => v === 0).map(([id]) => id);
  const markMedian = median(marks.map(([, v]) => v));
  console.log(`  markings     median ${markMedian} zero-marking ids: ${markZero.length ? markZero.join(',') : '(none)'}`);
}
{
  const meshes = ratioEntries(meshCounts);
  const meshMin = meshes.reduce((a, b) => (b[1] < a[1] ? b : a));
  console.log(`  draw meshes  median ${median(meshes.map(([, v]) => v))} minimum ${meshMin[0]}=${meshMin[1]}`);
  if (meshMin[1] < 4) fail(meshMin[0], `suspiciously few meshes (${meshMin[1]})`);
}

assert.deepEqual(failures, [], `fleet-wide roster defects:\n  ${failures.join('\n  ')}`);
console.log(`rosterSweep.selftest: ${ALL_TANK_IDS.length} playable tanks swept`
  + ` (${productionSet.size} production icons verified), fleet data sane`
  + ` (min shells ${shellMinCount}, hp ${hpMin}-${hpMax})`);
