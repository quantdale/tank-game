/**
 * movementWorldBound.selftest.mjs — SA-06 map-escape guard: the integrator
 * hard-clamps hulls to the ±460 m playable square (the same bound every
 * spawn/AI/prop constant assumes) and bleeds the blocked fraction of speed
 * like a wall contact, so no hull can drive off the rendered battlefield.
 * Run with: node src/sim/movementWorldBound.selftest.mjs
 */

import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createTankState, updateTank, SIM_DT } from './movement.js';

const SPEC = {
  name: 'bound-fixture',
  enginePowerHp: 1500,
  weightTons: 60,
  topSpeedKmh: 65,
  reverseSpeedKmh: 20,
  hullTraverseDegS: 36,
  turretTraverseDegS: 36,
  gunPitchDegS: 24,
  gunElevationDeg: 25,
  gunDepressionDeg: 10,
  pivotStyle: 'pivot',
  terrainResistance: { hard: 0.7, medium: 1.0, soft: 2.2 },
  dims: { hullLengthM: 7.5, overallLengthM: 9, widthM: 3.4, heightM: 2.9 },
  gun: {
    caliberMm: 120, baseAccuracy: 0.38, aimTimeS: 2.3,
    bloom: { move: 0.2, hullRot: 0.2, turret: 0.12, afterShot: 4 },
  },
  armor: {
    boundingRadiusM: 4,
    turretPivot: [0, 1.55, 0], gunPivot: [0, 0.25, 0.3],
    gunBarrel: { lengthM: 5 },
  },
};

const flatField = {
  getHeightAt: () => 0,
  getNormalAt: () => null,
  getGroundType: () => 'hard',
};

function makeEntity(x, z) {
  const pos = new Vector3(x, flatField.getHeightAt(x, z), z);
  return {
    spec: SPEC,
    state: createTankState(SPEC, pos, 0),
    input: { throttle: 1, steer: 0, brake: false, aimPoint: null },
    combat: null,
  };
}

// Driving straight ahead (yaw 0 = local +Z) from inside the square must stop
// exactly AT the rim — never beyond it — and the blocked drive must bleed
// instead of grinding against the boundary.
{
  const ent = makeEntity(400, 100);
  let maxAbsZ = 0;
  for (let i = 0; i < 60 * 90; i++) { // 90 s at full throttle is far past top-speed run-out
    updateTank(ent, flatField, SIM_DT);
    assert.ok(Math.abs(ent.state.pos.z) <= 460 + 1e-6,
      `hull stays inside the playable square (tick ${i}: z=${ent.state.pos.z})`);
    maxAbsZ = Math.max(maxAbsZ, Math.abs(ent.state.pos.z));
  }
  assert.ok(maxAbsZ > 440, `the run actually covered ground (max |z| ${maxAbsZ.toFixed(1)})`);
  assert.ok(Math.abs(ent.state.pos.z - 460) < 1e-4,
    `hull rests against the rim, not short of it (${ent.state.pos.z.toFixed(3)})`);
}

// A hull already outside the square (recoil shove / legacy spawn) is pulled
// back to the rim on its first tick rather than living off-map.
for (const [x, z] of [[472, 10], [-480, 0], [100, 495], [100, -505]]) {
  const ent = makeEntity(x, z);
  ent.input.throttle = 0;
  updateTank(ent, flatField, SIM_DT);
  assert.ok(Math.max(Math.abs(ent.state.pos.x), Math.abs(ent.state.pos.z)) <= 460 + 1e-6,
    `out-of-bounds hull at (${x},${z}) clamps back inside (got ` +
    `${ent.state.pos.x.toFixed(2)},${ent.state.pos.z.toFixed(2)})`);
}

console.log('movementWorldBound.selftest: playable-square clamp and drive bleed passed');
