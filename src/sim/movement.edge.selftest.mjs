/**
 * movement.edge.selftest.mjs — SA-02 adversarial edge-case coverage for the
 * authoritative movement sim: poisoned-state containment (NaN/Infinity),
 * unyielding-wall contact with the production narrow phase, downhill
 * overspeed cap, reverse-steer flip contract, spawn-ground intersection,
 * parked jitter, serpentine stability, handbrake slope hold.
 * Run with: node src/sim/movement.edge.selftest.mjs
 * Inline fixtures only — no dependency on vehicles/specs.js.
 */

import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createTankState, updateTank, resetTankVerticalState, SIM_DT } from './movement.js';
import { setObbShape, pushHullFromObstacle } from '../world/collision.js';

const SPEC = {
  name: 'edge-fixture',
  enginePowerHp: 500,
  weightTons: 33,
  topSpeedKmh: 42,
  reverseSpeedKmh: 15,
  hullTraverseDegS: 36,
  turretTraverseDegS: 36,
  gunPitchDegS: 24,
  gunElevationDeg: 25,
  gunDepressionDeg: 10,
  pivotStyle: 'pivot',
  terrainResistance: { hard: 1.0, medium: 1.2, soft: 2.2 },
  dims: { hullLengthM: 6.27, overallLengthM: 7.52, widthM: 3.0, heightM: 2.97 },
  gun: {
    caliberMm: 76, baseAccuracy: 0.38, aimTimeS: 2.3,
    bloom: { move: 0.2, hullRot: 0.2, turret: 0.12, afterShot: 4 },
  },
  armor: {
    boundingRadiusM: 3.8,
    turretPivot: [0, 1.55, 0],
    gunPivot: [0, 0.25, 0.3],
    gunBarrel: { lengthM: 4.0 },
  },
};
const TOP_MPS = SPEC.topSpeedKmh / 3.6;
const OVERSPEED_CAP = 1.2; // movement.js OVERSPEED_CAP (not exported)

function field(fn, ground = 'medium') {
  return { getHeightAt: fn, getNormalAt: () => null, getGroundType: () => ground };
}
function entity(f, x = 0, z = 0, yaw = 0) {
  const pos = new Vector3(x, f.getHeightAt(x, z), z);
  return {
    spec: SPEC,
    state: createTankState(SPEC, pos, yaw),
    input: { throttle: 0, steer: 0, brake: false, aimPoint: null },
    combat: null,
  };
}
const finiteState = (s) =>
  Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.speed + s.yaw +
    s.yawRate + s.verticalSpeed + s.turretYaw + s.gunPitch +
    s.visualPitch + s.visualRoll + s.bloomF);

// ---- 1. persistent-NaN heightfield: state stays finite forever -------------
{
  const f = field((x, z) => (x * x + z * z > 60 * 60 ? NaN : 0));
  const ent = entity(f);
  ent.input.throttle = 1;
  let allFinite = true;
  let maxSpeed = 0;
  for (let i = 0; i < 1800; i++) {
    updateTank(ent, f, SIM_DT);
    allFinite &&= finiteState(ent.state);
    maxSpeed = Math.max(maxSpeed, Math.abs(ent.state.speed));
  }
  assert.ok(allFinite, 'NaN terrain: every published field stays finite');
  assert.ok(maxSpeed <= TOP_MPS * OVERSPEED_CAP + 1e-9,
    `NaN terrain: blind driving stays speed-bounded (${maxSpeed.toFixed(2)})`);
}

// ---- 2. injected poison recovers; tank remains drivable --------------------
for ( const [label, inject] of [
  ['speed=NaN', (s) => { s.speed = NaN; }],
  ['pos.y=NaN', (s) => { s.pos.y = NaN; }],
  ['yaw=Infinity', (s) => { s.yaw = Infinity; }],
]) {
  const f = field(() => 1.5);
  const ent = entity(f);
  for (let i = 0; i < 60; i++) updateTank(ent, f, SIM_DT);
  inject(ent.state);
  updateTank(ent, f, SIM_DT);
  assert.ok(finiteState(ent.state), `${label}: re-seated to a finite state in one tick`);
  ent.input.throttle = 1;
  const zBefore = ent.state.pos.z;
  for (let i = 0; i < 120; i++) {
    updateTank(ent, f, SIM_DT);
    assert.ok(finiteState(ent.state), `${label}: stays finite while driving on`);
  }
  assert.ok(ent.state.pos.z > zBefore + 1, `${label}: tank still drives after recovery`);
}

// ---- 3. NaN aimPoint through the turret solve: exit containment ------------
{
  const f = field(() => 0);
  const ent = entity(f);
  ent.input.aimPoint = new Vector3(NaN, NaN, NaN);
  updateTank(ent, f, SIM_DT);
  assert.ok(finiteState(ent.state), 'NaN aimPoint: published state stays finite');
  assert.equal(ent.state.turretYaw, 0, 'NaN aimPoint: turret re-seated, not poisoned');
}

// ---- 4. extended unyielding wall stops the hull at top speed ---------------
{
  const f = field(() => 0);
  const ent = entity(f, 0, -40, 0);
  ent.input.throttle = 1;
  const rec = { min: [0, 0, 0], max: [0, 0, 0] };
  setObbShape(rec, 0, 30, 30, 0.075, 0); // 60 m wide, 15 cm thick wall
  rec.min[1] = 0; rec.max[1] = 10;
  const halfL = SPEC.dims.hullLengthM * 0.5;
  const halfW = SPEC.dims.widthM * 0.5;
  function collide(pos, radiusM, outPush) {
    // CONTRACT: write the MTV into the caller-owned outPush vector.
    outPush.set(0, 0, 0);
    const fx = Math.sin(ent.state.yaw), fz = Math.cos(ent.state.yaw);
    return pushHullFromObstacle(pos, fx, fz, fz, -fx, halfL, halfW, rec, outPush);
  }
  let crossed = false;
  let bigImpacts = 0;
  for (let i = 0; i < 900; i++) {
    updateTank(ent, f, SIM_DT, collide);
    if (ent.state.pos.z > 30) crossed = true;
    if (ent.state.impactMps > 1.5) bigImpacts++;
  }
  assert.ok(!crossed, `wall: hull never crosses an extended wall (z=${ent.state.pos.z.toFixed(2)})`);
  assert.ok(bigImpacts >= 1, 'wall: the initial ram fires impact telemetry (>1.5 m/s)');
  assert.ok(Math.abs(ent.state.speed) < 0.05, `wall: held throttle settles at rest (${ent.state.speed.toFixed(3)})`);
  const noseGap = 30 - 0.075 - (ent.state.pos.z + halfL);
  assert.ok(noseGap > -0.01, `wall: stops at the face, not short of it (gap ${noseGap.toFixed(3)})`);
}

// ---- 5. downhill overspeed is capped ----------------------------------------
{
  const grade = Math.tan(25 * Math.PI / 180);
  const f = field((x, z) => -grade * z);
  const ent = entity(f, 0, 200, 0);
  ent.input.throttle = 1;
  let maxSpeed = 0;
  for (let i = 0; i < 1200; i++) {
    updateTank(ent, f, SIM_DT);
    maxSpeed = Math.max(maxSpeed, Math.abs(ent.state.speed));
  }
  assert.ok(maxSpeed <= TOP_MPS * OVERSPEED_CAP + 1e-9,
    `downhill: ${(maxSpeed * 3.6).toFixed(1)} km/h within the 1.2x transmission cap`);
}

// ---- 6. reverse-steer flip contract (car-like A/D in reverse) ---------------
{
  const f = field(() => 0);
  const fwd = entity(f);
  fwd.input.throttle = 0.5;
  fwd.input.steer = 1;
  for (let i = 0; i < 120; i++) updateTank(fwd, f, SIM_DT);
  assert.ok(fwd.state.yaw > 0.1, 'forward: positive steer raises hull yaw');

  const rev = entity(f);
  rev.input.throttle = -0.5;
  rev.input.steer = 1;
  for (let i = 0; i < 120; i++) updateTank(rev, f, SIM_DT);
  assert.ok(rev.state.yaw < -0.1, 'reverse: same steer flips yaw like a reversing car');
}

// ---- 7. spawn-ground intersection recovery ----------------------------------
{
  const f = field(() => 5);
  const buried = entity(f);
  resetTankVerticalState(buried.state, 3.0); // authored 2 m underground
  updateTank(buried, f, SIM_DT);
  assert.ok(buried.state.pos.y >= 5 - 0.06,
    `buried spawn: seated on terrain in one tick (${buried.state.pos.y.toFixed(3)})`);

  const drop = entity(f, 10, 10, 0);
  resetTankVerticalState(drop.state, 40, 0, false); // authored airborne
  let landed = false;
  for (let i = 0; i < 600 && !landed; i++) {
    updateTank(drop, f, SIM_DT);
    landed = drop.state.grounded === true && i > 0;
  }
  assert.ok(landed, 'airborne spawn: lands under gravity within 10 s');
  assert.ok(finiteState(drop.state) && Math.abs(drop.state.pos.y - 5) < 0.3,
    `airborne spawn: settles onto the ground (${drop.state.pos.y.toFixed(3)})`);
}

// ---- 8. parked jitter / creep bounds on rough ground ------------------------
{
  const f = field((x, z) => 0.05 * Math.sin(x * 3.1) * Math.cos(z * 2.7));
  const ent = entity(f, 3.3, 1.1, 0.4);
  for (let i = 0; i < 600; i++) updateTank(ent, f, SIM_DT);
  const px = ent.state.pos.x, pz = ent.state.pos.z, py = ent.state.pos.y;
  let yRange = 0, drift = 0;
  for (let i = 0; i < 300; i++) {
    updateTank(ent, f, SIM_DT);
    yRange = Math.max(yRange, Math.abs(ent.state.pos.y - py));
    drift = Math.max(drift, Math.hypot(ent.state.pos.x - px, ent.state.pos.z - pz));
  }
  assert.ok(yRange < 0.01, `parked: vertical jitter ${(yRange * 100).toFixed(2)} cm < 1 cm`);
  assert.ok(drift < 0.02, `parked: horizontal creep ${(drift * 100).toFixed(2)} cm < 2 cm`);
}

// ---- 9. full-lock serpentine stability --------------------------------------
{
  const f = field(() => 0);
  const ent = entity(f);
  ent.input.throttle = 1;
  const trMaxHealthy =
    SPEC.hullTraverseDegS * Math.PI / 180 * (SPEC.terrainResistance.hard /
      SPEC.terrainResistance.medium);
  let maxYawRate = 0;
  let maxSpeed = 0;
  for (let i = 0; i < 1200; i++) {
    ent.input.steer = Math.sin(i * 0.05);
    updateTank(ent, f, SIM_DT);
    maxYawRate = Math.max(maxYawRate, Math.abs(ent.state.yawRate));
    maxSpeed = Math.max(maxSpeed, Math.abs(ent.state.speed));
  }
  assert.ok(maxYawRate <= trMaxHealthy * 1.02 + 1e-9,
    `serpentine: yaw rate ${(maxYawRate * 180 / Math.PI).toFixed(1)} deg/s within spec traverse`);
  assert.ok(maxSpeed <= TOP_MPS * OVERSPEED_CAP + 1e-9, 'serpentine: speed bounded');
  assert.ok(Number.isFinite(maxYawRate + maxSpeed), 'serpentine: no divergence');
}

// ---- 10. handbrake holds a moderate grade -----------------------------------
{
  const grade = Math.tan(20 * Math.PI / 180);
  const f = field((x, z) => -grade * z);
  const ent = entity(f, 0, 50, 0);
  ent.input.brake = true;
  for (let i = 0; i < 600; i++) {
    updateTank(ent, f, SIM_DT);
    assert.ok(Math.abs(ent.state.speed) < 0.5,
      `handbrake on 20 deg: never rolls away (${ent.state.speed.toFixed(3)})`);
  }
}

console.log(`movement.edge.selftest: all checks passed`);
