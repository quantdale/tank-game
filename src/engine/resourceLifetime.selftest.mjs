import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  disposeObject3DResources,
  residentResourceLimits,
  collectMaterialTextures,
  collectObjectResources,
  auditSceneResources,
  createResourceTracker,
} from './resourceLifetime.js';

// ---------------------------------------------------------------------------
// 1. Tier resident limits
// ---------------------------------------------------------------------------
assert.deepEqual(residentResourceLimits('mobile'), {
  pedestalVisuals: 2,
  worldScenes: 1,
});
assert.equal(residentResourceLimits('desktop').pedestalVisuals, 6);
assert.equal(residentResourceLimits('desktop').worldScenes, Infinity);

// ---------------------------------------------------------------------------
// 2. Object3D and Texture/Geometry/Material disposal with preserved roots
// ---------------------------------------------------------------------------
const sharedTexture = new THREE.Texture();
const retiredTexture = new THREE.Texture();
const retiredGeometry = new THREE.BufferGeometry();
const retiredMaterial = new THREE.MeshStandardMaterial({ map: sharedTexture });
retiredMaterial.normalMap = retiredTexture;
const retired = new THREE.Group();
retired.add(new THREE.Mesh(retiredGeometry, retiredMaterial));
const parent = new THREE.Scene();
parent.add(retired);

const live = new THREE.Group();
live.add(new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshStandardMaterial({ map: sharedTexture }),
));

let geometryDisposals = 0;
let materialDisposals = 0;
let sharedTextureDisposals = 0;
let retiredTextureDisposals = 0;
retiredGeometry.addEventListener('dispose', () => { geometryDisposals += 1; });
retiredMaterial.addEventListener('dispose', () => { materialDisposals += 1; });
sharedTexture.addEventListener('dispose', () => { sharedTextureDisposals += 1; });
retiredTexture.addEventListener('dispose', () => { retiredTextureDisposals += 1; });

const released = disposeObject3DResources(retired, { preserveRoots: [live] });
assert.equal(retired.parent, null, 'retired subtree must detach from the live scene');
assert.equal(geometryDisposals, 1, 'retired geometry must release its GPU buffer');
assert.equal(materialDisposals, 1, 'retired material must release its program state');
assert.equal(retiredTextureDisposals, 1, 'unshared retired texture must be released');
assert.equal(sharedTextureDisposals, 0, 'texture used by a preserved root must stay resident');
assert.equal(released.objects, 2);
assert.equal(released.geometries, 1);
assert.equal(released.materials, 1);
assert.equal(released.textures, 1);

// ---------------------------------------------------------------------------
// 3. Shadow maps & Lights disposal
// ---------------------------------------------------------------------------
const shadowMap = { disposed: 0, dispose() { this.disposed += 1; } };
const shadowMapPass = { disposed: 0, dispose() { this.disposed += 1; } };
const lamp = new THREE.Object3D();
lamp.isLight = true;
lamp.shadow = { map: shadowMap, mapPass: shadowMapPass };
const litGroup = new THREE.Group();
litGroup.add(lamp);
litGroup.add(new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshStandardMaterial({ map: sharedTexture }),
));
parent.add(litGroup);

disposeObject3DResources(litGroup, { preserveRoots: [live] });
assert.equal(shadowMap.disposed, 1, 'an evicted light must release its shadow map');
assert.equal(shadowMapPass.disposed, 1, 'an evicted light must release its VSM target');

const keptShadowMap = { disposed: 0, dispose() { this.disposed += 1; } };
const liveLamp = new THREE.Object3D();
liveLamp.isLight = true;
liveLamp.shadow = { map: keptShadowMap };
live.add(liveLamp);
const retiredLamp = new THREE.Object3D();
retiredLamp.isLight = true;
retiredLamp.shadow = { map: keptShadowMap };
const retiredGroup = new THREE.Group();
retiredGroup.add(retiredLamp);
retiredGroup.add(new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshStandardMaterial(),
));
parent.add(retiredGroup);

disposeObject3DResources(retiredGroup, { preserveRoots: [live] });
assert.equal(keptShadowMap.disposed, 0,
  'a shadow map shared with a preserved root must stay resident');

// ---------------------------------------------------------------------------
// 4. Batched / Instanced meshes disposal
// ---------------------------------------------------------------------------
let batchedDisposed = 0;
const fakeBatched = new THREE.Object3D();
fakeBatched.isBatchedMesh = true;
fakeBatched.dispose = () => { batchedDisposed += 1; };
const batchedGroup = new THREE.Group();
batchedGroup.add(fakeBatched);
disposeObject3DResources(batchedGroup);
assert.equal(batchedDisposed, 1, 'batched mesh dispose() must be called on subtree disposal');

// ---------------------------------------------------------------------------
// 5. ShaderMaterial Uniforms and Nested Textures Extraction
// ---------------------------------------------------------------------------
const customUniformTex = new THREE.Texture();
const arrayUniformTex = new THREE.Texture();
const nestedUniformTex = new THREE.Texture();
const shaderMat = new THREE.ShaderMaterial({
  uniforms: {
    uDirect: { value: customUniformTex },
    uArray: { value: [arrayUniformTex] },
    uStruct: { value: { map: nestedUniformTex } },
  },
});
const extractedTextures = new Set();
collectMaterialTextures(shaderMat, extractedTextures);
assert.equal(extractedTextures.has(customUniformTex), true, 'direct uniform texture collected');
assert.equal(extractedTextures.has(arrayUniformTex), true, 'array uniform texture collected');
assert.equal(extractedTextures.has(nestedUniformTex), true, 'nested struct uniform texture collected');

// ---------------------------------------------------------------------------
// 6. auditSceneResources catalog
// ---------------------------------------------------------------------------
const testScene = new THREE.Scene();
const testMesh1 = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
const testMesh2 = new THREE.Mesh(new THREE.BufferGeometry(), shaderMat);
const testLight = new THREE.DirectionalLight();
testLight.shadow.map = { dispose() {} };
testScene.add(testMesh1, testMesh2, testLight);
const audit = auditSceneResources(testScene);
assert.equal(audit.objects, 4); // scene, mesh1, mesh2, light
assert.equal(audit.geometries, 2);
assert.equal(audit.materials, 2);
assert.equal(audit.textures >= 3, true);
assert.equal(audit.lights, 1);
assert.equal(audit.shadowMaps, 1);

// ---------------------------------------------------------------------------
// 7. ResourceLifetimeTracker (GPU, Event Listeners, Timers, Workers)
// ---------------------------------------------------------------------------
const tracker = createResourceTracker();

// Test GPU resource auto-tracking via dispose events. Fakes extend the real
// THREE.EventDispatcher because trackShadowMap hangs TWO 'dispose' handlers
// (render target + shadow map) off one object; a last-write-wins listener
// store would silently drop the first and report a false render-target leak.
class GpuTargetFake extends THREE.EventDispatcher {
  constructor(extra = {}) {
    super();
    Object.assign(this, extra);
  }
  dispose() {
    this.dispatchEvent({ type: 'dispose' });
  }
}
const trackedTex = new THREE.Texture();
const trackedGeo = new THREE.BufferGeometry();
const trackedMat = new THREE.MeshBasicMaterial();
const trackedRT = new GpuTargetFake({ texture: new THREE.Texture() });
const trackedLight = { isLight: true, shadow: { map: new GpuTargetFake() } };

tracker.trackTexture(trackedTex);
tracker.trackGeometry(trackedGeo);
tracker.trackMaterial(trackedMat);
tracker.trackRenderTarget(trackedRT);
tracker.trackShadowMap(trackedLight.shadow.map);

assert.equal(tracker.getCounts().textures, 2); // trackedTex + trackedRT.texture
assert.equal(tracker.getCounts().geometries, 1);
assert.equal(tracker.getCounts().materials, 1);
assert.equal(tracker.getCounts().renderTargets, 2); // trackedRT + shadow.map
assert.equal(tracker.getCounts().shadowMaps, 1);

// Trigger disposal
trackedTex.dispose();
trackedGeo.dispose();
trackedMat.dispose();
trackedRT.dispose();
trackedLight.shadow.map.dispose();

assert.equal(tracker.getCounts().textures, 1); // only trackedRT.texture if not separately disposed
assert.equal(tracker.getCounts().geometries, 0);
assert.equal(tracker.getCounts().materials, 0);
assert.equal(tracker.getCounts().renderTargets, 0);
assert.equal(tracker.getCounts().shadowMaps, 0);

// Test Event Listeners, Timers, Workers with Scope Management
const fakeTarget = {
  listeners: {},
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); },
};

const unbindClick = tracker.trackEventListener(fakeTarget, 'click', () => {}, null, 'battle');
const unbindKey = tracker.trackEventListener(fakeTarget, 'keydown', () => {}, null, 'battle');
assert.equal(tracker.getCounts().eventListeners, 2);
assert.equal(fakeTarget.listeners.click.length, 1);

const timer1 = tracker.trackTimeout(() => {}, 1000, 'battle');
const interval1 = tracker.trackInterval(() => {}, 500, 'battle');
assert.equal(tracker.getCounts().timers, 2);

let workerTerminated = false;
const fakeWorker = { terminate() { workerTerminated = true; } };
tracker.trackWorker(fakeWorker, 'battle');
assert.equal(tracker.getCounts().workers, 1);

// Clear 'battle' scope
const scopeResult = tracker.clearScope('battle');
assert.equal(scopeResult.listenersCleared, 2);
assert.equal(scopeResult.timersCleared, 2);
assert.equal(scopeResult.workersTerminated, 1);
assert.equal(workerTerminated, true);
assert.equal(tracker.getCounts().eventListeners, 0);
assert.equal(tracker.getCounts().timers, 0);
assert.equal(tracker.getCounts().workers, 0);
assert.equal(fakeTarget.listeners.click.length, 0);

// ---------------------------------------------------------------------------
// 8. Complete Multi-Transition Lifecycle Sequence Simulation & Leak Hunt:
// Boot -> Garage -> Battle -> Garage -> Battle -> Map switch -> Battle -> Studio -> Garage -> Battle
// ---------------------------------------------------------------------------
{
  const seqTracker = createResourceTracker();
  const rootScene = new THREE.Scene();
  const worldCache = new Map();
  const pedestalCache = new Map();
  let activeWorld = null;
  let activePedestal = null;

  function createMockTankVisual(specId) {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const root = new THREE.Group();
    root.name = 'tank-' + specId;
    root.add(new THREE.Mesh(geo, mat));
    seqTracker.trackGeometry(geo);
    seqTracker.trackMaterial(mat);
    seqTracker.trackTexture(mat.map);
    return { specId, root, geo, mat, dispose() { disposeObject3DResources(root); } };
  }

  function createMockWorld(mapId) {
    const group = new THREE.Group();
    group.name = 'world-' + mapId;
    const terrainGeo = new THREE.BufferGeometry();
    const terrainMat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    group.add(terrainMesh);

    const vegGeo = new THREE.BufferGeometry();
    const vegMat = new THREE.MeshStandardMaterial();
    const vegMesh = new THREE.InstancedMesh(vegGeo, vegMat, 10);
    group.add(vegMesh);

    const sun = new THREE.DirectionalLight();
    sun.shadow = { map: new GpuTargetFake() };
    group.add(sun);

    seqTracker.trackGeometry(terrainGeo);
    seqTracker.trackGeometry(vegGeo);
    seqTracker.trackMaterial(terrainMat);
    seqTracker.trackMaterial(vegMat);
    seqTracker.trackTexture(terrainMat.map);
    seqTracker.trackShadowMap(sun.shadow.map);

    return { mapId, group, dispose() { disposeObject3DResources(group); } };
  }

  // --- Step 1: BOOT ---
  const bootSnap = seqTracker.takeSnapshot('Boot');

  // --- Step 2: GARAGE 1 ---
  activePedestal = createMockTankVisual('m1a1');
  pedestalCache.set('m1a1', activePedestal);
  rootScene.add(activePedestal.root);
  const garage1Snap = seqTracker.takeSnapshot('Garage1');
  assert.equal(garage1Snap.counts.geometries, 1);
  assert.equal(garage1Snap.counts.materials, 1);

  // --- Step 3: BATTLE 1 (Verdant) ---
  activeWorld = createMockWorld('verdant');
  worldCache.set('verdant', activeWorld);
  rootScene.add(activeWorld.group);
  const battleTanks = [];
  for (let i = 0; i < 8; i++) {
    const tank = createMockTankVisual('bot-' + i);
    battleTanks.push(tank);
    rootScene.add(tank.root);
  }
  // Register battle-scoped listeners & timers
  seqTracker.trackEventListener(fakeTarget, 'pointermove', () => {}, null, 'battle1');
  seqTracker.trackTimeout(() => {}, 5000, 'battle1');
  const battle1Snap = seqTracker.takeSnapshot('Battle1');
  assert.equal(battle1Snap.counts.geometries, 1 + 2 + 8); // pedestal + world(2) + 8 tanks = 11

  // --- Step 4: GARAGE (Return from Battle 1) ---
  // Battle exit teardown: clear battle entities, scope listeners & timers, set world dormant
  for (const t of battleTanks) {
    t.root.removeFromParent();
    t.dispose();
  }
  battleTanks.length = 0;
  seqTracker.clearScope('battle1');
  activeWorld.group.visible = false;
  const garage2Snap = seqTracker.takeSnapshot('Garage2');
  assert.equal(garage2Snap.counts.eventListeners, 0, 'zero leaked battle event listeners');
  assert.equal(garage2Snap.counts.timers, 0, 'zero leaked battle timers');

  // --- Step 5: BATTLE 2 (Rematch on cached Verdant) ---
  activeWorld.group.visible = true;
  for (let i = 0; i < 8; i++) {
    const tank = createMockTankVisual('bot-' + i);
    battleTanks.push(tank);
    rootScene.add(tank.root);
  }
  seqTracker.trackEventListener(fakeTarget, 'pointermove', () => {}, null, 'battle2');
  seqTracker.trackInterval(() => {}, 100, 'battle2');
  const battle2Snap = seqTracker.takeSnapshot('Battle2');
  assert.equal(battle2Snap.counts.geometries, 11);

  // --- Step 6: GARAGE (Return from Battle 2) ---
  for (const t of battleTanks) {
    t.root.removeFromParent();
    t.dispose();
  }
  battleTanks.length = 0;
  seqTracker.clearScope('battle2');
  activeWorld.group.visible = false;

  // --- Step 7: MAP SWITCH (Verdant -> Desert, Mobile budget worldScenes: 1) ---
  // Evict Verdant
  worldCache.delete('verdant');
  activeWorld.group.removeFromParent();
  activeWorld.dispose();
  activeWorld = createMockWorld('desert');
  worldCache.set('desert', activeWorld);
  rootScene.add(activeWorld.group);
  const mapSwitchSnap = seqTracker.takeSnapshot('MapSwitch');
  assert.equal(mapSwitchSnap.counts.geometries, 1 + 2); // 1 pedestal + 2 desert = 3

  // --- Step 8: BATTLE 3 (on Desert) ---
  for (let i = 0; i < 8; i++) {
    const tank = createMockTankVisual('bot-' + i);
    battleTanks.push(tank);
    rootScene.add(tank.root);
  }
  seqTracker.trackEventListener(fakeTarget, 'pointerdown', () => {}, null, 'battle3');
  seqTracker.trackTimeout(() => {}, 3000, 'battle3');

  // --- Step 9: STUDIO (Direct from battle/desert) ---
  for (const t of battleTanks) {
    t.root.removeFromParent();
    t.dispose();
  }
  battleTanks.length = 0;
  seqTracker.clearScope('battle3');

  // Studio setup: 3 actors + studio rail & listeners
  const studioActors = [
    createMockTankVisual('studio-hero'),
    createMockTankVisual('studio-victim'),
    createMockTankVisual('studio-wreck'),
  ];
  for (const a of studioActors) rootScene.add(a.root);
  seqTracker.trackEventListener(fakeTarget, 'wheel', () => {}, null, 'studio');
  seqTracker.trackInterval(() => {}, 16, 'studio');
  const studioSnap = seqTracker.takeSnapshot('Studio');
  assert.equal(studioSnap.counts.geometries, 1 + 2 + 3); // pedestal(1) + desert(2) + 3 studio actors = 6

  // --- Step 10: GARAGE (Exit Studio) ---
  for (const a of studioActors) {
    a.root.removeFromParent();
    a.dispose();
  }
  studioActors.length = 0;
  seqTracker.clearScope('studio');
  activeWorld.group.visible = false;
  const garage4Snap = seqTracker.takeSnapshot('Garage4');
  assert.equal(garage4Snap.counts.eventListeners, 0);
  assert.equal(garage4Snap.counts.timers, 0);
  assert.equal(garage4Snap.counts.geometries, 1 + 2); // pedestal + desert

  // --- Step 11: BATTLE 4 (Final Battle) ---
  activeWorld.group.visible = true;
  for (let i = 0; i < 8; i++) {
    const tank = createMockTankVisual('bot-' + i);
    battleTanks.push(tank);
    rootScene.add(tank.root);
  }
  seqTracker.trackEventListener(fakeTarget, 'click', () => {}, null, 'battle4');

  // End Battle 4 -> Final Garage
  for (const t of battleTanks) {
    t.root.removeFromParent();
    t.dispose();
  }
  battleTanks.length = 0;
  seqTracker.clearScope('battle4');
  activeWorld.group.visible = false;

  const finalGarageSnap = seqTracker.takeSnapshot('FinalGarage');

  // --- LEAK AUDIT CERTIFICATION ---
  const auditResult = seqTracker.auditScopeLeaks('RepeatedLifecycleAudit', garage4Snap, finalGarageSnap);
  assert.equal(auditResult.passed, true, 'Zero resource leaks across full lifecycle sequence');
  assert.equal(finalGarageSnap.counts.eventListeners, 0, 'Zero lingering event listeners');
  assert.equal(finalGarageSnap.counts.timers, 0, 'Zero lingering timers');
  assert.equal(finalGarageSnap.counts.workers, 0, 'Zero lingering workers');
  assert.equal(finalGarageSnap.counts.geometries, 3, 'Steady-state geometries match resident budget');
}

// ---------------------------------------------------------------------------
// 9. disposeObject3DResources onDispose telemetry + userData.renderTarget
// ---------------------------------------------------------------------------
{
  const rt = { disposed: 0, dispose() { this.disposed += 1; } };
  const retiredGroup = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.userData.renderTarget = rt;
  retiredGroup.add(mesh);

  const events = [];
  const released = disposeObject3DResources(retiredGroup, {
    onDispose: (type) => events.push(type),
  });
  assert.equal(rt.disposed, 1, 'a userData.renderTarget must release with its subtree');
  assert.equal(released.renderTargets, 1);
  assert.ok(events.includes('geometry'), 'geometry disposal reported through onDispose');
  assert.ok(events.includes('material'), 'material disposal reported through onDispose');
  assert.ok(events.includes('renderTarget'), 'renderTarget disposal reported through onDispose');

  const keptRt = { disposed: 0, dispose() { this.disposed += 1; } };
  const liveKeeper = new THREE.Group();
  const keeperMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  keeperMesh.userData.renderTarget = keptRt;
  liveKeeper.add(keeperMesh);
  const evicted = new THREE.Group();
  const evictedMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  evictedMesh.userData.renderTarget = keptRt;
  evicted.add(evictedMesh);
  const keptRelease = disposeObject3DResources(evicted, { preserveRoots: [liveKeeper] });
  assert.equal(keptRt.disposed, 0, 'render target shared with a preserved root must stay resident');
  assert.equal(keptRelease.renderTargets, 0);
}

// ---------------------------------------------------------------------------
// 10. auditSceneResources instanced / batched catalog
// ---------------------------------------------------------------------------
{
  const scene = new THREE.Scene();
  scene.add(new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 4));
  const batched = new THREE.Object3D();
  batched.isBatchedMesh = true;
  scene.add(batched);
  const audit = auditSceneResources(scene);
  assert.equal(audit.objects, 3); // scene + instanced + batched
  assert.equal(audit.instancedOrBatched, 2);
  assert.ok(audit.rawSets.instancedOrBatched.has(batched), 'rawSets exposes the batched object');
}

// ---------------------------------------------------------------------------
// 11. Tracker hygiene: idempotent re-tracking, rAF fallback, manual clears,
// snapshot diffing, reset
// ---------------------------------------------------------------------------
{
  const tracker = createResourceTracker();

  const tex = new THREE.Texture();
  tracker.trackTexture(tex);
  tracker.trackTexture(tex); // duplicate registration must be a no-op
  assert.equal(tracker.getCumulative().allocatedTextures, 1, 're-tracking must not double-count');
  tex.dispose();
  assert.equal(tracker.getCounts().textures, 0);

  // Outside the browser trackAnimationFrame falls back to setTimeout(16ms).
  let frames = 0;
  tracker.trackAnimationFrame(() => { frames += 1; }, 'loop');
  assert.equal(tracker.getCounts().timers, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(frames, 1, 'fallback rAF fires exactly once');
  assert.equal(tracker.getCounts().timers, 0, 'naturally fired frame timer leaves the active set');

  const timeout = tracker.trackTimeout(() => {}, 10000, 'loop');
  const interval = tracker.trackInterval(() => {}, 10000, 'loop');
  assert.equal(tracker.getCounts().timers, 2);
  timeout.clear();
  interval.clear();
  assert.equal(tracker.getCounts().timers, 0, 'manual clears retire both timers');
  assert.equal(tracker.getCumulative().clearedTimers, 2, 'only cancellations count as cleared');

  const before = tracker.takeSnapshot('before');
  tracker.trackEventListener(
    { addEventListener() {}, removeEventListener() {} }, 'resize', () => {}, null, 'loop',
  );
  const after = tracker.takeSnapshot('after');
  const comparison = tracker.compareSnapshots(before, after);
  assert.equal(comparison.leaked, true, 'net listener growth flags as a leak');
  assert.equal(comparison.diff.eventListeners, 1);
  assert.equal(tracker.auditScopeLeaks('loop', before, after).passed, false);
  tracker.clearScope('loop');
  assert.equal(
    tracker.auditScopeLeaks('loop', after, tracker.takeSnapshot('clean')).passed,
    true,
    'scope teardown restores a clean audit',
  );

  tracker.reset();
  const counts = tracker.getCounts();
  assert.equal(
    counts.textures + counts.geometries + counts.materials +
    counts.renderTargets + counts.shadowMaps + counts.eventListeners +
    counts.timers + counts.workers,
    0,
    'reset empties every active set',
  );
}

// ---------------------------------------------------------------------------
// 12. App-driven worker terminate is observed exactly once
// ---------------------------------------------------------------------------
{
  const tracker = createResourceTracker();
  let terminated = 0;
  const worker = { terminate() { terminated += 1; } };
  tracker.trackWorker(worker, 'net');
  worker.terminate();
  assert.equal(tracker.getCounts().workers, 0, 'app-driven terminate retires the tracked worker');
  assert.equal(tracker.getCumulative().terminatedWorkers, 1);
  worker.terminate(); // repeated terminate must not double-count
  assert.equal(tracker.getCumulative().terminatedWorkers, 1);
  assert.equal(terminated, 2, 'underlying worker still terminates on every call');
}

console.log('resourceLifetime self-test passed');
