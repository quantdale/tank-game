import assert from 'node:assert/strict';
import {
  mulberry32, smoothstep, windAmplitudeFactor,
  createCanopyPixel, aoHistoryFilter,
} from './foliageAoProxy.mjs';

// ---------------------------------------------------------------------------
// 1. GLSL-twin math: smoothstep + the proposed freeze curve
// ---------------------------------------------------------------------------
for (const [a, b] of [[60, 110], [140, 220]]) {
  assert.equal(smoothstep(a, b, a), 0);
  assert.equal(smoothstep(a, b, b), 1);
  assert.ok(Math.abs(smoothstep(a, b, (a + b) / 2) - 0.5) < 1e-12);
  let prev = -1;
  for (let x = a; x <= b; x += (b - a) / 32) {
    const s = smoothstep(a, b, x);
    assert.ok(s >= prev, `smoothstep must be monotone at ${x}`);
    prev = s;
  }
}
const FROST_NEAR = 140, FROST_FAR = 220; // proposed tree-hook constants
assert.equal(windAmplitudeFactor(0, FROST_NEAR, FROST_FAR), 1);
assert.equal(windAmplitudeFactor(FROST_NEAR, FROST_NEAR, FROST_FAR), 1);
assert.equal(windAmplitudeFactor(FROST_FAR, FROST_NEAR, FROST_FAR), 0);
assert.equal(windAmplitudeFactor(500, FROST_NEAR, FROST_FAR), 0);

// ---------------------------------------------------------------------------
// 2. Scenario A — parked camera under a swaying canopy (the reported bug):
//      current post.js: camera still => k = 1.0 (raw boil, unfiltered)
//      proposed post.js: k = AO_TAA_K = 0.15 every frame
// ---------------------------------------------------------------------------
const DT = 1 / 60;
const FRAMES = 600;
function runFilter(pixel, k, t0) {
  // neighborhood taps model the rectification cross: same canopy seen from
  // pixels one HALF-RES AO texel away (~5 cm world-space at 25 m / 1080p)
  const offs = [0.05, -0.05, 0, 0];
  let hist = pixel.rawAo(t0, 1); // seed frame takes current verbatim
  const deltas = [];
  for (let i = 1; i <= FRAMES; i++) {
    const t = t0 + i * DT;
    const now = pixel.rawAo(t, 1);
    const nb = offs.map((o) => pixel.rawAo(t, 1, o));
    const out = aoHistoryFilter(now, nb, hist, k);
    deltas.push(Math.abs(out - hist));
    hist = out;
  }
  deltas.sort((a, b) => a - b);
  const rms = Math.sqrt(deltas.reduce((s, d) => s + d * d, 0) / deltas.length);
  return { rms, p95: deltas[Math.floor(deltas.length * 0.95)] };
}
// Boil metric: per-frame flicker the eye reads (RMS + p95 of |dAO|/frame),
// NOT total variation — a low-pass filter legitimately spreads one flip over
// several frames, which reads as smooth settling, not boil. Asserted across
// several canopies so no single lucky seed can pass. The model omits the
// Poisson denoiser that runs BEFORE this filter in the real pass (it already
// attenuates input churn), so measured suppression here is conservative.
let boilStillK1 = null, boilStillK015 = null;
for (const seed of [2001, 2002, 2003]) {
  const canopy = createCanopyPixel({ seed });
  const raw = runFilter(canopy, 1.0, 11.3);    // today's still-camera path
  const blended = runFilter(canopy, 0.15, 11.3); // proposed always-blend
  assert.ok(
    blended.rms < 0.6 * raw.rms && blended.p95 < 0.6 * raw.p95,
    `seed ${seed}: always-blend must cut parked-camera flicker >=1.7x `
      + `(rms ${blended.rms.toFixed(5)} vs ${raw.rms.toFixed(5)},`
      + ` p95 ${blended.p95.toFixed(5)} vs ${raw.p95.toFixed(5)})`,
  );
  if (seed === 2001) { boilStillK1 = raw; boilStillK015 = blended; }
}

// ---------------------------------------------------------------------------
// 3. Scenario B — frozen wind (Patch B) makes the signal static; the
//    always-blend filter must converge onto it and then hold it EXACTLY
//    (no crawl/lag penalty vs the old k=1.0 fast path).
// ---------------------------------------------------------------------------
{
  const pixel = createCanopyPixel({ seed: 2001 });
  const C = pixel.rawAo(4.2, 0); // frozen occluders => constant AO
  let hist = 1.0;                // deliberately wrong initial history
  const K = 0.15;
  for (let i = 0; i < 25; i++) {
    const nb = [C, C, C, C]; // static scene: neighborhood == center
    hist = aoHistoryFilter(C, nb, hist, K);
  }
  assert.ok(
    Math.abs(hist - C) < 0.02,
    `static signal must converge within 25 frames (residual ${Math.abs(hist - C).toExponential(2)})`,
  );
  for (let i = 0; i < 10; i++) {
    hist = aoHistoryFilter(C, [C, C, C, C], hist, K);
    assert.ok(
      Math.abs(hist - C) < 1e-9,
      'converged filter must hold a static signal exactly (mix identity)',
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Scenario C — the freeze curve itself: raw cutout churn (mean |dAO|/frame)
//    is untouched inside the sway radius and exactly zero beyond it.
// ---------------------------------------------------------------------------
function rawChurn(distM, frozen) {
  const amp = frozen ? windAmplitudeFactor(distM, FROST_NEAR, FROST_FAR) : 1;
  const pixel = createCanopyPixel({ seed: 2001 });
  let churn = 0;
  for (let i = 1; i <= FRAMES; i++) {
    churn += Math.abs(pixel.rawAo(i * DT, amp) - pixel.rawAo((i - 1) * DT, amp));
  }
  return churn / FRAMES;
}
const nearUnfrozen = rawChurn(50, false);
const nearFrozen = rawChurn(50, true);
assert.equal(nearFrozen, nearUnfrozen, 'sway radius keeps full motion');
assert.ok(nearUnfrozen > 0, 'model must actually churn near the camera');
const midFrozen = rawChurn(160, true);
const midUnfrozen = rawChurn(160, false);
assert.ok(midFrozen < midUnfrozen && midFrozen > 0, 'fade band blends churn down');
assert.equal(rawChurn(FROST_FAR + 40, true), 0, 'frozen foliage has zero depth churn');

// ---------------------------------------------------------------------------
// 5. Determinism — identical runs, byte-identical summaries.
// ---------------------------------------------------------------------------
function summarize() {
  return JSON.stringify({
    a: [boilStillK1, boilStillK015],
    c: [nearUnfrozen, midUnfrozen, midFrozen],
  });
}
assert.equal(summarize(), JSON.stringify({
  a: [runFilter(createCanopyPixel({ seed: 2001 }), 1.0, 11.3),
    runFilter(createCanopyPixel({ seed: 2001 }), 0.15, 11.3)],
  c: [rawChurn(50, false), rawChurn(160, false), rawChurn(160, true)],
}), 'runs must be deterministic');

console.log(`foliageAoProxy.selftest: ok
  parked-camera flicker rms: k=1.0 ${boilStillK1.rms.toFixed(5)} -> k=0.15 ${boilStillK015.rms.toFixed(5)} AO/frame
  parked-camera flicker p95: k=1.0 ${boilStillK1.p95.toFixed(5)} -> k=0.15 ${boilStillK015.p95.toFixed(5)}
  raw cutout churn @50 m ${nearUnfrozen.toFixed(5)}, @160 m ${midUnfrozen.toFixed(5)} -> frozen ${midFrozen.toFixed(5)}, @260 m+ 0`);
