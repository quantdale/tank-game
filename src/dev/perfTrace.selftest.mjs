import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDevTraceCore } from './perfTrace.js';

let clock = 1000;
const game = {
  phase: 'battle', timeS: 1, preBattleS: 0, result: null,
  player: { input: { throttle: 0.5, steer: -0.25, fire: false } },
};
const renderer = {
  info: {
    programs: [{}, {}],
    render: { frame: 1, calls: 12, triangles: 3456 },
  },
};
const actionHandlers = new Map();
const input = {
  actionDefs: [{ id: 'reload' }, { id: 'sniperToggle' }],
  onAction(id, fn) { actionHandlers.set(id, fn); },
};
const trace = createDevTraceCore({
  enabled: true, now: () => clock,
  eventCapacity: 5, frameCapacity: 8,
});
trace.configure({ game, renderer, input, getContext: () => ({ cameraMode: 'CHASE' }) });
trace.clear();

const reused = { id: 7, nested: { hp: 900 }, loop: null };
reused.loop = reused;
trace.event('tank:damaged', reused);
reused.id = 99;
reused.nested.hp = 0;
const copied = trace.tail(1, 'bus')[0];
assert.equal(copied.data.id, 7, 'bus payload is copied at emission time');
assert.equal(copied.data.nested.hp, 900);
assert.equal(copied.data.loop, '[Circular]');

actionHandlers.get('reload')('KeyR');
assert.equal(trace.tail(1, 'action')[0].name, 'reload');

clock += 16;
trace.frame(16);
clock += 16;
game.timeS += 0.016;
renderer.info.render.frame++;
trace.frame(16);

// A marked, synthetic main-thread stall must be classified as a screen freeze.
clock += 320;
trace.frame(100);
clock += 448;
trace.frame(100);
let anomalies = trace.tail(20, 'anomaly');
assert.ok(anomalies.some((row) => row.name === 'screen:freeze'));
assert.ok(anomalies.some((row) => row.name === 'sim:freeze'));
assert.ok(anomalies.some((row) => row.name === 'render:freeze'));

clock += 16;
game.timeS += 0.016;
renderer.info.render.frame++;
trace.frame(16);
anomalies = trace.tail(20, 'anomaly');
assert.ok(anomalies.some((row) => row.name === 'sim:resume'));
assert.ok(anomalies.some((row) => row.name === 'render:resume'));

for (let i = 0; i < 12; i++) trace.event(`bounded:${i}`, { i });
const stats = trace.stats();
assert.equal(stats.frames, 5);
assert.equal(stats.events, 5);
assert.ok(stats.eventsDropped > 0, 'bounded event ring reports overwritten rows');
assert.ok(stats.freezes >= 2);
assert.ok(stats.maxGapMs >= 448);

const snapshot = trace.snapshot();
assert.deepEqual(snapshot.frameSchema.slice(0, 5), ['tMs', 'gapMs', 'dtMs', 'simS', 'preBattleS']);
assert.equal(snapshot.frames[0][0], 16, 'clear resets the trace-relative clock');
assert.equal(snapshot.frames[0].length, snapshot.frameSchema.length);
assert.equal(JSON.parse(trace.exportJson()).version, 1);

// --- campaign W1: whole-frame draw accumulation + render-attribution probes --
// A composer frame runs several renderer.render() passes; three resets info at
// the START of each, so the recorder must sum per-pass deltas itself.
const passRenderer = {
  info: {
    memory: { geometries: 5, textures: 6 },
    programs: [{}],
    render: { frame: 1, calls: 0, triangles: 0 },
  },
  render() {
    // Mimic three: reset-then-draw leaves ONLY this pass's numbers in info.
    this.info.render.calls = this.nextCalls;
    this.info.render.triangles = this.nextTris;
  },
};
passRenderer.nextCalls = 0;
passRenderer.nextTris = 0;

const scene = new THREE.Scene();
const vegGroup = new THREE.Group();
vegGroup.name = 'vegetation';
const grassMesh = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 40);
vegGroup.add(grassMesh);
scene.add(vegGroup);
const terrainGroup = new THREE.Group();
terrainGroup.userData.updateLOD = () => {};
terrainGroup.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 96, 96)));
scene.add(terrainGroup);

const w1trace = createDevTraceCore({ enabled: true, now: () => clock });
w1trace.clear();
w1trace.configure({ game, renderer: passRenderer, scene });

passRenderer.nextCalls = 5; passRenderer.nextTris = 100;
passRenderer.render(); // shadow pass
passRenderer.nextCalls = 7; passRenderer.nextTris = 200;
passRenderer.render(); // main pass
clock += 16;
w1trace.frame(16);

const schema = w1trace.snapshot().frameSchema;
assert.equal(schema.length, 23, 'W1/W2 attribution columns appended');
assert.deepEqual(schema.slice(15), ['geoMem', 'texMem', 'rtCount', 'texMB', 'casters', 'vegInst', 'chunks', 'cells']);
const row = w1trace.snapshot().frames.at(-1);
assert.equal(row[8], 12, 'calls summed across both passes');
assert.equal(row[9], 300, 'triangles summed across both passes');
assert.equal(row[15], 5, 'geoMem from renderer.info.memory');
assert.equal(row[16], 6, 'texMem from renderer.info.memory');
assert.equal(row[20], 40, 'visible vegetation instances via auto-probes');
assert.equal(row[21], 1, 'visible terrain chunks via auto-probes');
assert.ok(w1trace.tail(50, 'trace').some((r) => r.name === 'renderSample'),
  'rich probe sample rides the event ring');

// Test GPU timer integration in snapshot
const mockGpuTimer = {
  results: () => [{ seq: 1, pass: 'opaque', gpuMs: 4.2 }],
  breakdown: () => [{ pass: 'opaque', totalGpuMs: 4.2, p50GpuMs: 4.2 }],
};
w1trace.configure({ gpuTimer: mockGpuTimer });
const snapWithGpu = w1trace.snapshot();
assert.ok(Array.isArray(snapWithGpu.gpuTimer));
assert.equal(snapWithGpu.gpuTimer[0].pass, 'opaque');
assert.ok(Array.isArray(snapWithGpu.gpuBreakdown));
assert.equal(snapWithGpu.gpuBreakdown[0].p50GpuMs, 4.2);

console.log('perfTrace selftest: pass');

