import assert from 'node:assert/strict';
import {
  TERRAIN_LOD_DIST,
  chooseTerrainLodBuild,
  initialTerrainLods,
  planTerrainLodEvictions,
  terrainLodForDistance,
  terrainLodForView,
  terrainLodThresholdsM,
} from './terrainLodPolicy.js';

assert.deepEqual(initialTerrainLods(50), [0], 'opening near chunk creates only visible detail');
assert.deepEqual(initialTerrainLods(300), [1], 'opening mid chunk creates only visible detail');
assert.deepEqual(initialTerrainLods(600), [2], 'opening far chunk creates only visible detail');

assert.equal(terrainLodForDistance(170, 1), 0, 'near detail enters inside hysteresis');
assert.equal(terrainLodForDistance(205, 0), 0, 'fine LOD remains inside exit hysteresis');
assert.equal(terrainLodForDistance(230, 0), 1, 'fine LOD exits beyond hysteresis');

// Screen-space error view: desktop defaults must land close to the hand-tuned
// switch distances (the relief constant is calibrated against them), then
// adapt — a narrow sniper FOV holds fine detail far out, a small viewport
// relaxes the thresholds.
const th = terrainLodThresholdsM(null, [0, 0]);
assert.ok(th[0] > 180 && th[0] < 240, `desktop t0 ${th[0]} tracks the tuned 200 m band`);
assert.ok(th[1] > 390 && th[1] < 480, `desktop t1 ${th[1]} tracks the tuned 430 m band`);
for (let d = 0; d <= 900; d += 25) {
  for (let level = 0; level <= 2; level++) {
    assert.equal(terrainLodForView(d, level, TERRAIN_LOD_DIST),
      terrainLodForDistance(d, level),
      `view picker matches the distance picker on shared thresholds at ${d} m`);
  }
}
assert.equal(terrainLodForView(100, 2, th), 0, 'view thresholds keep near ground fine');
assert.equal(terrainLodForView(300, 2, th), 1, 'view thresholds place the mid band');
assert.equal(terrainLodForView(600, 2, th), 2, 'view thresholds coarsen the far field');
const scoped = terrainLodThresholdsM({ fovDeg: 12 }, [0, 0]);
assert.ok(scoped[0] > 600, `sniper FOV keeps fine detail far (${scoped[0]} m)`);
const tiny = terrainLodThresholdsM({ viewportH: 360 }, [0, 0]);
assert.ok(tiny[0] < th[0] && tiny[1] < th[1], 'small viewport relaxes both thresholds');
assert.ok(scoped[0] < scoped[1] && th[0] < th[1], 'thresholds stay ordered');

const chunks = [
  { cx: 0, cz: 0, level: 2, present: [false, false, true] },
  { cx: 500, cz: 0, level: 2, present: [false, false, true] },
];
assert.deepEqual(chooseTerrainLodBuild(chunks, 20, 0), {
  index: 0, level: 0, distanceM: 20, urgent: true,
}, 'missing visible geometry is the first streaming job');

chunks[0].present[0] = true;
chunks[0].level = 0;
assert.deepEqual(chooseTerrainLodBuild(chunks, 20, 0), {
  index: 1, level: 1, distanceM: 480, urgent: false,
}, 'the nearest upcoming transition band is prepared after visible detail exists');

// Motion-aware prefetch: with symmetric ahead/behind candidates the static
// policy takes the first (behind) chunk; velocity bias flips the work toward
// the chunk the camera is driving toward. Urgent work ignores motion — it is
// about where the camera IS, not where it is heading.
const moving = [
  { cx: -500, cz: 0, level: 2, present: [false, false, true] },
  { cx: 500, cz: 0, level: 2, present: [false, false, true] },
];
const still = chooseTerrainLodBuild(moving, 0, 0);
assert.equal(still.index, 0, 'without motion the first in-band candidate wins');
const driven = chooseTerrainLodBuild(moving, 0, 0, null, { vx: 30, vz: 0 });
assert.equal(driven.index, 1, 'velocity biases prefetch toward the leading chunk');
assert.equal(driven.level, 1, 'motion prefetch prepares the same next-finer band');
assert.ok(driven.urgent === false, 'motion prefetch stays background work');
const fleeing = [{ cx: 100, cz: 0, level: 2, present: [false, false, true] }];
const urgentPick = chooseTerrainLodBuild(fleeing, 0, 0, null, { vx: -50, vz: 0 });
assert.deepEqual(urgentPick, { index: 0, level: 0, distanceM: 100, urgent: true },
  'missing visible detail is chosen at its actual distance regardless of motion');

// Memory retention: built levels beyond their retain radius are released,
// never the displayed level and never the coarse fallback every chunk keeps.
const geo = { id: 'geo' };
const resident = [
  { cx: 0, cz: 0, level: 0, lods: [geo, geo, geo] },
  { cx: 350, cz: 0, level: 1, lods: [geo, null, geo] },
  { cx: 700, cz: 0, level: 2, lods: [geo, geo, geo] },
  { cx: 350, cz: 40, level: 0, lods: [geo, geo, geo] },
];
const plan = planTerrainLodEvictions(resident, 0, 0);
assert.deepEqual(plan.map((c) => `${c.index}:${c.level}`), ['2:0', '2:1', '1:0'],
  'farthest stale geometry first; displayed level 0 of the 350 m chunk is safe');
assert.equal(planTerrainLodEvictions([
  { cx: 0, cz: 0, level: 1, lods: [geo, geo, geo] },
], 0, 0).length, 0, 'everything near the camera is retained');
assert.equal(TERRAIN_LOD_DIST[0] * 1.6, 320, 'retain margin documented at 1.6x');

console.log('terrainLodPolicy.selftest: opening-region priority, view-error thresholds, motion prefetch and retention passed');
