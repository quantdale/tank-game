import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRenderProbes } from './renderProbes.js';

let clock = 1000;
const now = () => clock;

// --- staged scene graph ------------------------------------------------------
const scene = new THREE.Scene();

// Terrain chunk group: marker is userData.updateLOD (terrain.js:2723); LOD
// buckets are classified by chunk vertex count (97²/49²/25² grids here).
const terrain = new THREE.Group();
terrain.userData.updateLOD = () => {};
const lod0 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 96, 96));
const lod1 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 48, 48));
const lod2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 24, 24));
lod1.visible = false; // hidden chunks must not enter the visible histogram
terrain.add(lod0, lod1, lod2);
scene.add(terrain);

// Vegetation group: marker is the root name 'vegetation' (vegetation.js:1518).
const veg = new THREE.Group();
veg.name = 'vegetation';
const grass = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 500);
const bushes = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 300);
bushes.visible = false; // culled band — its instances draw nothing
const hiddenTuft = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 999);
hiddenTuft.visible = false;
veg.add(grass, bushes, hiddenTuft);
scene.add(veg);

// Shadow flags + a texture-bearing material for the footprint census.
const caster = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({
  map: new THREE.DataTexture(new Uint8Array(4 * 64 * 64), 64, 64),
}));
caster.castShadow = true;
caster.receiveShadow = true;
scene.add(caster);

const cubeImg = { width: 32, height: 32 };
const skyMat = new THREE.MeshBasicMaterial();
skyMat.envMap = new THREE.CubeTexture([cubeImg, cubeImg, cubeImg, cubeImg, cubeImg, cubeImg]);
const skyBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skyMat);
scene.add(skyBox);

const renderer = { info: { memory: { geometries: 12, textures: 34 } } };
const lighting = {
  getShadowTelemetry: () => ({
    cascades: [
      { allocated: true, allocatedSize: 2048 },
      { allocated: true, allocatedSize: 1024 },
      { allocated: false, allocatedSize: 0 },
    ],
  }),
};

const probes = createRenderProbes({ scene, renderer, lighting, now });

// --- first sample traverses immediately ---------------------------------------
const snap = probes.sample();
assert.equal(probes.sample(), snap, 'sample() reuses one snapshot object');

assert.equal(snap.geoMem, 12);
assert.equal(snap.texMem, 34);
assert.equal(snap.casters, 1, 'only the flagged caster mesh counts');
assert.equal(snap.receivers, 1);
assert.equal(snap.vegMeshes, 1, 'only visible vegetation meshes count');
assert.equal(snap.vegInstances, 500);
assert.equal(snap.instancedMeshes, 1);
assert.equal(snap.instancedInstances, 500);
assert.equal(snap.chunksVisible, 2, 'lod0 + lod2 visible, lod1 hidden');
assert.equal(snap.chunksLod0, 1);
assert.equal(snap.chunksLod1, 0);
assert.equal(snap.chunksLod2, 1);
assert.equal(snap.shadowRTCount, 2);
// (2048² + 1024²) × 4 B depth / 1 MiB = 20 MB exactly.
assert.ok(Math.abs(snap.shadowRTMB - 20) < 1e-6, `shadow RT MB, got ${snap.shadowRTMB}`);
// DataTexture 64² + CubeTexture 6×32² faces, both ×4 B × mip 4/3.
const expectedTexMB = ((64 * 64) + 6 * (32 * 32)) * 4 * (4 / 3) / 1048576;
assert.ok(Math.abs(snap.texMB - expectedTexMB) < 1e-4, `texture MB, got ${snap.texMB}`);
assert.equal(snap.texCount, 2);
assert.equal(snap.texUnsized, 0);

// --- cadence: heavy traversal is cached between interval ticks ----------------
grass.count = 250;
clock += 500; // inside the 1000 ms window
probes.sample();
assert.equal(snap.vegInstances, 500, 'cached between traverse ticks');
clock += 500; // window elapsed
probes.sample();
assert.equal(snap.vegInstances, 250, 'refreshed after the interval');

// --- world.group takes precedence as the traversal root -----------------------
const worldRoot = new THREE.Group();
worldRoot.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
const worldProbes = createRenderProbes({
  scene, renderer, lighting, now,
  world: { group: worldRoot },
});
clock += 2000;
worldProbes.sample();
assert.equal(worldProbes.sample().casters, 0, 'world root replaces the scene root');
assert.equal(worldProbes.sample().geoMem, 12, 'renderer.info.memory still sampled');

// --- degenerate inputs never throw --------------------------------------------
const bare = createRenderProbes({ now });
bare.sample();
assert.equal(bare.sample().casters, 0);
createRenderProbes({ renderer: {}, lighting: {}, now }).sample();

console.log('renderProbes selftest: pass');
