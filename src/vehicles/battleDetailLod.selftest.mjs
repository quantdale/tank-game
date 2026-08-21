import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createTank } from './tankFactory.js';
import { battleDetailTier, stepBattleDetailTier } from './tankFactoryCore.js';
import { getSpec } from './specs.js';
import { createTankState } from '../sim/movement.js';

// --- pure tier policy (screen-space importance: normDist = dist / radius) --
assert.equal(battleDetailTier(0), 'hero');
assert.equal(battleDetailTier(18.9), 'hero');
assert.equal(battleDetailTier(19), 'battle');
assert.equal(battleDetailTier(28.9), 'battle');
assert.equal(battleDetailTier(29), 'distance');
// per-boundary hysteresis: leaving waits past the boundary, returning does not
assert.equal(stepBattleDetailTier('hero', 20), 'hero', 'hero holds inside its margin');
assert.equal(stepBattleDetailTier('hero', 25), 'battle');
assert.equal(stepBattleDetailTier('battle', 30), 'battle', 'battle holds inside its margin');
assert.equal(stepBattleDetailTier('battle', 33), 'distance');
assert.equal(stepBattleDetailTier('distance', 28), 'battle');
assert.equal(stepBattleDetailTier('battle', 18), 'hero');
assert.equal(stepBattleDetailTier('hero', 40), 'distance', 'a far jump skips the battle rung');

// --- built visual -----------------------------------------------------------
const visual = createTank('m1a2', null, {
  proceduralOnly: true,
  geometryReceipt: true,
  batchStatic: true,
  battleDetailLod: true,
});
const state = createTankState(getSpec('m1a2'), new THREE.Vector3(), 0);
const records = [];
const markingMeshes = [];
const costlyWrappers = [];
const rubberMeshes = [];
visual.root.traverse((object) => {
  if (object.userData.battleDetailGroup) records.push({ object, parent: object.parent });
  if (object.userData.vehicleMarking) markingMeshes.push(object);
  if (object.userData.battleCostlyWrapper) costlyWrappers.push(object);
  if (object.name === 'hullRubber') rubberMeshes.push(object);
});

assert(records.length > 0, 'battle bot installs articulation-local detail groups');
assert(visual.root.userData.battleDetailObjectCount >= records.length,
  'detail receipt counts the retained source objects');
assert(Number.isInteger(visual.root.userData.staticBatchSavedDraws),
  'battle build publishes deterministic static-batch savings');
assert(costlyWrappers.length > 0,
  'm1a2 authors tiny-fitting buckets (glass/cloth/spare links) into managed wrappers');
const estimate = visual.root.userData.battleTierDrawEstimate;
assert(estimate && Number.isInteger(estimate.hero) && Number.isInteger(estimate.battle)
  && Number.isInteger(estimate.distance), 'tier draw receipt is published');
assert(estimate.battle < estimate.hero, 'BATTLE strictly reduces submitted draws vs HERO');
assert(estimate.distance <= estimate.battle, 'DISTANCE never exceeds BATTLE draws');

const endWheelBatches = [];
visual.root.traverse((object) => {
  if (object.name === 'gearEndWheelBody') endWheelBatches.push(object);
});
assert(endWheelBatches.length > 0 && endWheelBatches.every((object) =>
  object.isBatchedMesh && object.instanceCount === 4),
'battle running gear batches sprocket/idler geometry without dropping independent animation state');

// m1a2 boundingRadiusM = 5.2 -> normDist boundaries: leave-hero 24.7 (~128 m),
// enter-hero 19 (~99 m), leave-battle 32.5 (~169 m).
const attached = () => records.every(({ object }) => object.parent !== null);
const detached = () => records.every(({ object }) => object.parent === null);
const wrappersVisible = () => costlyWrappers.every((object) => object.visible);
const rubberVisible = () => rubberMeshes.every((object) => object.visible);

visual.syncFromState(state, 0);
assert(attached() && wrappersVisible() && rubberVisible(),
  'inspection framing keeps every tier at full detail');

visual.syncFromState(state, 0, 120);
assert(attached(), 'hysteresis margin holds HERO detail just past the bare boundary');

visual.syncFromState(state, 0, 135);
assert(detached() && !wrappersVisible() && rubberVisible(),
  'BATTLE sheds clutter groups and tiny-fitting buckets but keeps skirt trim');

visual.syncFromState(state, 0, 160);
assert(detached() && !wrappersVisible() && rubberVisible(),
  'hysteresis margin holds BATTLE content just past its bare boundary');

visual.syncFromState(state, 0, 175);
assert(detached() && !wrappersVisible() && !rubberVisible(),
  'DISTANCE additionally sheds the rubber skirt trim');

visual.syncFromState(state, 0, 60);
assert(attached() && wrappersVisible() && rubberVisible(),
  'close combat restores every shed class to its articulation parent');

visual.syncFromState(state, 0, 175);
visual.setDestroyed({ ageS: 0 });
assert(detached() && !wrappersVisible() && !rubberVisible(),
  'distant destruction captures burn detail without presenting a one-frame cosmetic burst');
let lensMesh = null;
visual.root.traverse((object) => {
  if (!lensMesh && object.isMesh
    && (object.name === 'turretGlass' || object.name === 'hullGlass')) lensMesh = object;
});
assert(lensMesh && lensMesh.material?.userData?.__burnU,
  'the burn sweep hooked the tier-hidden lens material during the forced capture');
assert(markingMeshes.length > 0 && markingMeshes.every((object) => object.visible === false),
  'merged battle markings still hide on destruction');

visual.syncFromState(state, 0);
assert(attached() && wrappersVisible() && rubberVisible(),
  'inspection and killcam framing restore the captured charred detail');
visual.syncFromState(state, 0, 175);
assert(detached() && !wrappersVisible() && !rubberVisible(),
  'a distant wreck sheds captured detail after inspection');
visual.dispose();
assert(records.every(({ object, parent }) => object.parent === parent),
  'dispose reattaches detached detail so root traversal owns every resource');
const ownedWrappers = [];
visual.root.traverse((object) => {
  if (object.userData.battleCostlyWrapper) ownedWrappers.push(object);
});
assert.equal(ownedWrappers.length, costlyWrappers.length,
  'tier-hidden wrappers stay inside the root subtree for resource disposal');

console.log(`battleDetailLod.selftest: ${records.length} detachable articulation groups, `
  + `${costlyWrappers.length} costly-bucket wrappers, draws ${estimate.hero}/`
  + `${estimate.battle}/${estimate.distance} (hero/battle/distance) passed`);
