/**
 * cameraRig.selftest.mjs — SA-02 headless coverage of the WoT camera rig:
 * terrain clearance, obstacle pull-in, server-aim writes, sniper roundtrip,
 * zoom ladder, free-look aim freeze, pitch clamps. Runs under plain node
 * (THREE.PerspectiveCamera is WebGL-free).
 * Run with: node src/engine/cameraRig.selftest.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCameraRig } from './cameraRig.js';

const PITCH_MIN_DEG = -65;
const PITCH_MAX_DEG = 30;

function makeWorld() {
  const heightField = { getHeightAt: (x) => Math.max(0, 0.35 * x), getNormalAt: () => null };
  const slab = { min: [-6, 0, 39], max: [6, 12, 41] };
  function raycast(origin, dir, maxDist) {
    let tmin = 0, tmax = maxDist, axis = -1, sign = 1;
    const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < slab.min[a] || o[a] > slab.max[a]) return null;
        continue;
      }
      const inv = 1 / d[a];
      let t0 = (slab.min[a] - o[a]) * inv, t1 = (slab.max[a] - o[a]) * inv, s = -1;
      if (t0 > t1) { const q = t0; t0 = t1; t1 = q; s = 1; }
      if (t0 > tmin) { tmin = t0; axis = a; sign = s; }
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) return null;
    }
    if (axis < 0) return null;
    return {
      point: origin.clone().addScaledVector(dir, tmin),
      normal: new THREE.Vector3().setComponent(axis, sign),
      dist: tmin, kind: 'prop',
    };
  }
  function aimRaycast(origin, dir, maxDist) {
    for (let t = 2; t <= maxDist; t += 2) {
      const p = origin.clone().addScaledVector(dir, t);
      if (p.y <= Math.max(0, 0.35 * p.x)) {
        return { point: p, normal: new THREE.Vector3(0, 1, 0), dist: t, kind: 'terrain' };
      }
    }
    return null;
  }
  return { heightField, raycast, aimRaycast };
}

function boot(px = 0, pz = 0) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const world = makeWorld();
  const player = {
    state: { pos: new THREE.Vector3(px, world.heightField.getHeightAt(px, pz), pz),
      yaw: 0, turretYaw: 0 },
    visual: null,
    spec: { dims: { heightM: 2.9 } },
    input: { aimPoint: new THREE.Vector3(0, 0, 100) },
  };
  const rig = createCameraRig(camera, {
    heightField: world.heightField,
    raycast: world.raycast,
    aimRaycast: world.aimRaycast,
    getPlayer: () => player,
  });
  const frame = (o) => rig.update(1 / 60, { mouseDX: 0, mouseDY: 0, wheel: 0,
    rmb: false, shiftPressed: false, ...o });
  return { camera, world, player, rig, frame };
}
const viewPitchDeg = (cam) => {
  const d = cam.getWorldDirection(new THREE.Vector3());
  return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)));
};

// 1. arcade orbit never subterranean across a hostile ridge sweep
{
  const { camera, rig, frame } = boot(30, 0);
  let minClear = Infinity;
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    rig.snapArcade(0, yaw, -0.2);
    for (let i = 0; i < 240; i++) {
      frame({});
      minClear = Math.min(minClear,
        camera.position.y - Math.max(0, 0.35 * camera.position.x));
    }
  }
  assert.ok(minClear >= 0.99, `arcade camera keeps >=1 m terrain clearance (${minClear.toFixed(2)})`);
}

// 2. obstacle pull-in keeps the boom out of a wall
{
  const { camera, rig, frame } = boot(0, 55);
  rig.snapArcade(0, 0, -0.05); // orbit boom crosses the z=40 slab
  for (let i = 0; i < 120; i++) frame({});
  assert.ok(!(camera.position.z > 39.02 && camera.position.z < 40.98 && camera.position.y < 12),
    `pull-in never parks the camera inside the wall (z=${camera.position.z.toFixed(2)})`);
}

// 3. server-aim writes the player input point and follows mouse motion
{
  const { player, rig, frame } = boot();
  rig.snapArcade(2, 0, -0.1);
  frame({});
  const before = player.input.aimPoint.clone();
  frame({ mouseDX: 50 });
  assert.ok(player.input.aimPoint.distanceTo(before) > 0,
    'mouse motion moves the published aim point');
  assert.ok(player.input.aimPoint.toArray().every(Number.isFinite), 'aim point stays finite');
}

// 4. sniper roundtrip: mode transitions + exit behind the cannon
{
  const { player, rig, frame } = boot();
  rig.snapArcade(2, 0.4, -0.05);
  frame({});
  rig.enterSniper();
  frame({});
  assert.equal(rig.mode, 'SNIPER', 'enterSniper switches modes');
  rig.exitSniper(true);
  frame({});
  assert.equal(rig.mode, 'ARCADE', 'exitSniper returns to arcade');
  assert.ok(Math.abs(player.state.yaw - 0) < 1e-6, 'fixture sanity');
}

// 5. zoom ladder: wheel-in enters sniper at closest step; ceiling x8; out exits
{
  const { rig, frame } = boot();
  rig.snapArcade(5, 0, -0.1); // closest orbit step
  frame({ wheel: 1 });
  assert.equal(rig.mode, 'SNIPER', 'wheel-in past closest orbit enters sniper');
  for (let i = 0; i < 10; i++) frame({ wheel: 1 });
  assert.ok(rig.zoom <= 8.01, `sniper zoom ceiling is x8 (${rig.zoom})`);
  for (let i = 0; i < 20; i++) frame({ wheel: -1 });
  assert.equal(rig.mode, 'ARCADE', 'wheel-out past x2 returns to arcade');
}

// 6. free-look hold freezes the published aim while the view orbits
{
  const { player, rig, frame } = boot();
  rig.snapArcade(2, 0, -0.05);
  frame({});
  const frozen = player.input.aimPoint.clone();
  for (let i = 0; i < 30; i++) frame({ mouseDX: 40, mouseDY: 10, rmb: true });
  assert.ok(player.input.aimPoint.distanceTo(frozen) < 0.01,
    'free look does not leak aim motion');
}

// 7. pitch clamps enforced on the actual view direction
{
  const { camera, rig, frame } = boot();
  rig.snapArcade(2, 0, 0);
  for (let i = 0; i < 120; i++) frame({ mouseDY: 400 }); // drag down hard
  const down = viewPitchDeg(camera);
  assert.ok(down >= PITCH_MIN_DEG - 0.5, `down clamp holds (${down.toFixed(1)} deg)`);
  for (let i = 0; i < 300; i++) frame({ mouseDY: -400 }); // drag up hard
  const up = viewPitchDeg(camera);
  assert.ok(up <= PITCH_MAX_DEG + 0.5, `up clamp holds (${up.toFixed(1)} deg)`);
}

// 8. spectate chase keeps terrain clearance during blend and settled
{
  const { camera, world, rig, frame } = boot(0, 0);
  const ally = {
    state: { pos: new THREE.Vector3(80, 28, 0), yaw: 0, turretYaw: 0 },
    visual: null, spec: { dims: { heightM: 2.9 } }, input: { aimPoint: null },
  };
  rig.startSpectate(ally);
  for (let i = 0; i < 180; i++) frame({});
  const clear = camera.position.y - world.heightField.getHeightAt(
    camera.position.x, camera.position.z);
  assert.ok(clear >= 0.99, `spectate clearance (${clear.toFixed(2)})`);
}

console.log('cameraRig.selftest: all checks passed');
