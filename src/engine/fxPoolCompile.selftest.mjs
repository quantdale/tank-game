// B14 fx first-use staging contract: pools must be GPU-compiled while
// presented frames still see them hidden, with visibility and camera layer
// state restored exactly after the sweep.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { compileParticleFamilies } from './offscreenWarm.js';

function fakeRenderer({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    compile(child, camera, scene) {
      // Capture the visibility state the traversal actually saw.
      calls.push({ child, visibleAtCompile: child.visible, camera, scene });
      if (failOn && child.name === failOn) throw new Error('synthetic compile failure');
    },
  };
}

{
  const renderer = fakeRenderer();
  const camera = new THREE.PerspectiveCamera();
  camera.layers.mask = 0x00000001;
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const mats = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const a = new THREE.Mesh(new THREE.BufferGeometry(), mats[0]); a.name = 'flash';
  const b = new THREE.Mesh(new THREE.BufferGeometry(), mats[1]); b.name = 'smoke';
  // Production invariant: pools are born hidden and flip visible on first claim().
  a.visible = false;
  b.visible = false;
  group.add(a, b);
  scene.add(group);

  const n = compileParticleFamilies(renderer, group, camera, scene);

  assert.equal(n, 2, 'every pool child is submitted exactly once');
  assert.equal(renderer.calls.length, 2);
  for (const call of renderer.calls) {
    assert.equal(call.visibleAtCompile, true, 'compile traversal must see the pool visible');
    assert.equal(call.child.visible, false, 'hidden pool must be re-hidden after its compile');
    assert.equal(call.camera, camera);
    assert.equal(call.scene, scene);
  }
  assert.equal(camera.layers.mask, 0x00000001, 'camera layer mask must be restored');
}

{
  // A pool that was legitimately visible before the sweep must stay visible.
  const renderer = fakeRenderer();
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const live = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  live.visible = true;
  group.add(live);
  compileParticleFamilies(renderer, group, camera, scene);
  assert.equal(live.visible, true, 'pre-visible pool visibility must be preserved');
}

{
  // One failing family must not block the rest nor corrupt state.
  const renderer = fakeRenderer({ failOn: 'boom' });
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const bad = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  bad.name = 'boom';
  const good = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  good.name = 'ok';
  bad.visible = false;
  good.visible = false;
  group.add(bad, good);
  const n = compileParticleFamilies(renderer, group, camera, scene);
  assert.equal(n, 1, 'failing family is skipped, remaining families still compile');
  assert.equal(bad.visible, false);
  assert.equal(good.visible, false);
  assert.ok(camera.layers.mask !== 0, 'mask restored to a valid value');
}

{
  // Late-FX layer membership must not hide pools from the sweep traversal:
  // simulate layer 30 with a restrictive camera mask like live gameplay.
  const renderer = fakeRenderer();
  const LATE_FX_LAYER = 30;
  const camera = new THREE.PerspectiveCamera();
  camera.layers.mask = 0x00000001; // gameplay mask excludes layer 30
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const soft = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  soft.layers.set(LATE_FX_LAYER);
  group.add(soft);
  const n = compileParticleFamilies(renderer, group, camera, scene);
  assert.equal(n, 1, 'layer-restricted pool is still compiled under full-mask override');
  assert.equal(soft.layers.mask, 1 << LATE_FX_LAYER, "pool's own layer membership untouched");
  assert.equal(camera.layers.mask, 0x00000001, 'gameplay camera mask restored');
}

{
  // Degenerate inputs stay no-ops.
  const renderer = fakeRenderer();
  assert.equal(compileParticleFamilies(renderer, null, null, null), 0);
  assert.equal(renderer.calls.length, 0);
}

console.log('fxPoolCompile.selftest: all checks passed');
