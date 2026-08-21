import assert from 'node:assert/strict';
import { createHeightField, createCameraMotionFeed, feedCameraMotion } from './terrain.js';
import {
  createChunkGeometryBuilder,
  createFineGridBaker,
  TERRAIN_LOD_SEGS,
} from './terrainStreamSlices.js';
import {
  createTerrainStreamScheduler,
  estimateCameraMotion,
} from './terrainStreamScheduler.js';

// Deterministic clock: every scheduler clock() read costs one fixed virtual
// step, so budget compliance and job interleaving are exact in Node.
const STEP_MS = 0.01;
let nowCalls = 0;
const fakeClock = () => (nowCalls++ * STEP_MS);
const resetClock = () => { nowCalls = 0; };

const heightField = createHeightField(1337);

function makeChunk(cx0, cz0, openingLevel = 2) {
  const fine = openingLevel < 2 ? drainFine(cx0, cz0) : null;
  const geo = drainGeo(cx0, cz0, TERRAIN_LOD_SEGS[openingLevel], fine);
  const lods = [null, null, null];
  lods[openingLevel] = geo;
  return {
    mesh: { geometry: geo }, lods, fine, level: openingLevel,
    cx: cx0 + 64, cz: cz0 + 64, cx0, cz0,
  };
}

function drainFine(cx0, cz0) {
  const baker = createFineGridBaker(heightField, cx0, cz0);
  for (let r = 0; r < baker.rows; r++) baker.step();
  return baker.result();
}

function drainGeo(cx0, cz0, segs, fine) {
  const builder = createChunkGeometryBuilder(heightField, cx0, cz0, segs, fine);
  for (let r = 0; r < builder.rows; r++) builder.step();
  return builder.finish();
}

function sameGeometry(a, b) {
  for (const key of ['position', 'normal']) {
    const aa = a.attributes[key].array, bb = b.attributes[key].array;
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  }
  const ai = a.index.array, bi = b.index.array;
  if (ai.length !== bi.length) return false;
  for (let i = 0; i < ai.length; i++) if (ai[i] !== bi[i]) return false;
  return true;
}

// --- A job spreads across updates under the budget and lands byte-identical ---
resetClock();
// Chunk center (64, 320); camera 220 m south => mid band wanted, missing =>
// the job is picked urgent, so the tight urgentBudget is what must spread it.
const chunk = makeChunk(0, 256, 2);
const scheduler = createTerrainStreamScheduler({
  chunks: [chunk], heightField, clock: fakeClock,
  budgetMs: 1.25, urgentBudgetMs: 0.3, retentionInterval: 1 << 30,
});
const camX = 64, camZ = 100;
let updates = 0;
let maxSlicesPerUpdate = 0;
let completed = false;
while (updates < 500) {
  const s = scheduler.update(camX, camZ);
  updates++;
  maxSlicesPerUpdate = Math.max(maxSlicesPerUpdate, s.slices);
  if (s.completed) { completed = true; break; }
}
assert.ok(completed, 'the streaming job completes');
assert.ok(updates > 1, `a full mid-band job spans several updates (took ${updates})`);
// 0.3 ms budget / 0.01 ms per clock read bounds the slices any single update
// may spend; slack covers the completion bookkeeping read.
assert.ok(maxSlicesPerUpdate <= 40,
  `no update ran away (max slices ${maxSlicesPerUpdate})`);
assert.equal(chunk.level, 1, 'completed visible detail swaps in immediately');
assert.equal(chunk.mesh.geometry, chunk.lods[1], 'mesh takes the streamed geometry');
assert.ok(chunk.fine, 'fine grid stays cached while coarser levels are still missing');

// Scheduling must not change WHAT was built: compare against a direct drain.
const reference = drainGeo(0, 256, TERRAIN_LOD_SEGS[1], drainFine(0, 256));
assert.ok(sameGeometry(chunk.lods[1], reference),
  'budgeted build is byte-identical to the monolithic build');

// Vertex heights stay faithful to the analytic height field after slicing.
const pos = chunk.lods[1].attributes.position.array;
const n = TERRAIN_LOD_SEGS[1] + 1;
const midStep = 128 / TERRAIN_LOD_SEGS[1];
for (const [gx, gz] of [[0, 0], [13, 7], [24, 24], [48, 48]]) {
  const wx = gx * midStep, wz = 256 + gz * midStep;
  const vy = pos[(gz * n + gx) * 3 + 1];
  assert.ok(Math.abs(vy - heightField.getHeightAt(wx, wz)) < 1e-4,
    `vertex (${gx},${gz}) matches getHeightAt`);
}

// --- Greedy single-update run produces the same bytes ---
resetClock();
const greedyChunk = makeChunk(0, 256, 2);
const greedy = createTerrainStreamScheduler({
  chunks: [greedyChunk], heightField, clock: fakeClock,
  budgetMs: 1e9, urgentBudgetMs: 1e9, retentionInterval: 1 << 30,
});
greedy.update(camX, camZ);
assert.ok(sameGeometry(greedyChunk.lods[1], reference),
  'greedy drain matches the sliced build exactly');

// --- Urgent work preempts background prefetch, which later resumes ---
resetClock();
// Camera (320, 120): the far chunk sits 523 m out (quiet prefetch band),
// the near chunk 120 m out (its level-0 is the visible detail).
const prefetchChunk = makeChunk(0, 512, 2); // center (64, 576)
const nearChunk = makeChunk(256, -64, 2);   // center (320, 0)
nearChunk.lods[0] = drainGeo(256, -64, TERRAIN_LOD_SEGS[0], drainFine(256, -64));
const pair = [prefetchChunk, nearChunk];
const preempt = createTerrainStreamScheduler({
  chunks: pair, heightField, clock: fakeClock,
  budgetMs: 0.5, urgentBudgetMs: 3, retentionInterval: 1 << 30,
});
preempt.update(320, 120); // starts the far prefetch job
assert.ok(preempt.stats.picked && !preempt.stats.urgent,
  'far missing band is background work');
nearChunk.lods[0] = null; // visible detail vanishes -> urgent
let sawUrgent = false;
for (let i = 0; i < 400; i++) {
  const s = preempt.update(320, 120);
  if (s.urgent && s.picked) sawUrgent = true;
  if (s.urgent && s.completed) break;
}
assert.ok(sawUrgent, 'urgent rebuild runs while the prefetch is suspended');
assert.ok(nearChunk.lods[0], 'urgent visible detail completed');
assert.ok(preempt.stats.suspended >= 1, 'the background job was suspended');
for (let i = 0; i < 800; i++) {
  const s = preempt.update(320, 120);
  if (!s.picked) break;
}
assert.ok(prefetchChunk.lods[1], 'suspended prefetch resumed and completed');
assert.ok(sameGeometry(prefetchChunk.lods[1],
  drainGeo(0, 512, TERRAIN_LOD_SEGS[1], drainFine(0, 512))),
  'resumed prefetch is byte-identical to an uninterrupted build');

// --- Retention sweep releases stale far geometry through onDispose ---
resetClock();
let disposed = [];
const far = makeChunk(0, 512, 2); // center (64, 576): ~780 m from the camera
far.lods[0] = drainGeo(0, 512, TERRAIN_LOD_SEGS[0], drainFine(0, 512));
const near = makeChunk(256, 0, 0); // center (320, 64): close, showing level 0
const retention = createTerrainStreamScheduler({
  chunks: [far, near], heightField, clock: fakeClock,
  retentionInterval: 1, maxEvictionsPerSweep: 1,
  onDispose: (c, level, geoRef) => disposed.push([c, level, geoRef]),
});
retention.update(320, -160);
assert.deepEqual(disposed.map(([, level]) => level), [0],
  'one eviction per sweep: the far chunk stale level-0 goes first');
assert.equal(far.lods[0], null, 'evicted slot cleared so policy can rebuild it');
assert.ok(near.lods[0], 'near chunk untouched by the sweep');
retention.update(320, -160);
assert.equal(disposed.length, 1, 'coarse fallback and retained levels never evicted');

// --- statsTarget mirroring for drop-in terrain.js wiring ---
resetClock();
const mirrored = {};
const mirrorChunk = makeChunk(0, 256, 2);
const mirror = createTerrainStreamScheduler({
  chunks: [mirrorChunk], heightField, clock: fakeClock,
  statsTarget: mirrored, retentionInterval: 1 << 30,
});
for (let i = 0; i < 500; i++) {
  const s = mirror.update(camX, camZ);
  if (s.completed) break;
}
assert.equal(mirrored.streamedGeometryCount, 1, 'statsTarget mirrors job completions');

assert.deepEqual(estimateCameraMotion(0, 0, 3, -4, 0.5), { vx: 6, vz: -8 },
  'camera motion estimate is plain finite differencing');
assert.equal(estimateCameraMotion(10, 10, 13, 6, 0).vx, 0,
  'zero dt clamps to zero velocity instead of dividing by zero');

// --- WA5: terrain.js's render-side motion feed (updateLOD -> stream.update) ---
const feed = createCameraMotionFeed();
assert.deepEqual(feedCameraMotion(feed, 10, 20, 1000), { vx: 0, vz: 0 },
  'first feed has no previous pose: zero velocity');
const fedMotion = feedCameraMotion(feed, 25, -10, 1250);
assert.deepEqual(fedMotion, { vx: 60, vz: -120 },
  'one-frame finite difference reads as m/s');
assert.equal(feedCameraMotion(feed, feed.prevX + 1, feed.prevZ, feed.prevMs + 5000).vx, 4,
  'a 5 s stall clamps to the 0.25 s dt cap (1 m / 0.25 s), not a dead stop');
feedCameraMotion(feed, 20, 20, 9000);
assert.deepEqual(feedCameraMotion(feed, 21, 20, 9000), { vx: 0, vz: 0 },
  'same-ms double fire yields zero velocity instead of dividing by ~0');
assert.equal(feedCameraMotion(feed, 22, 20, 9000 + 1000 / 60), feed.motion,
  'motion vector is reused across feeds (no per-frame allocation)');

// --- WA5: motion pulls an out-of-band chunk into the prefetch pick ---
resetClock();
// Chunk center (64, 600) sits 600 m from the camera at (64, 0): outside the
// static prefetch band (th[1] + 125 = 555 m), so an idle camera picks no job.
// Heading straight at it at 100 m/s projects the pick point 150 m ahead
// (TERRAIN_PREFETCH_MAX_M clamp), putting it 450 m out — inside the band.
const ahead = makeChunk(0, 536, 2); // center (64, 600)
const mover = createTerrainStreamScheduler({
  chunks: [ahead], heightField, clock: fakeClock, retentionInterval: 1 << 30,
});
assert.ok(!mover.update(64, 0).picked,
  'idle camera: the 600 m chunk stays inside the quiet band');
let drove = false;
for (let i = 0; i < 400 && !drove; i++) {
  drove = mover.update(64, 0, { vx: 0, vz: 100 }).completed;
}
assert.ok(drove && ahead.lods[1],
  'driving toward the chunk engages prefetch and builds its level 1');
assert.ok(sameGeometry(ahead.lods[1],
  drainGeo(0, 536, TERRAIN_LOD_SEGS[1], drainFine(0, 536))),
  'motion-prefetched geometry is byte-identical to a direct build');

console.log('terrainStreamScheduler.selftest: budget compliance, byte-identical slicing, preemption, retention and motion prefetch passed');
