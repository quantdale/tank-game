import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FX_LOD_FULL_M,
  FX_LOD_REDUCED_M,
  FX_LOD_WARM_S,
  FX_HEAVY_CREDITS_PER_TICK,
  FX_TRACER_MIN_HALF_PX,
  FX_TRACER_MAX_HALF_M,
  FX_PARTICLE_PROGRAM_GROUPS,
  fxLodLevel,
  fxColumnPuffsPerTick,
  fxDustAdmitted,
  fxPixelWorldSize,
  fxTracerEnergyK,
} from './fxPolicy.js';

// --- LOD bands ---------------------------------------------------------------
assert.equal(fxLodLevel(0), 0, 'near effects run full detail');
assert.equal(fxLodLevel(FX_LOD_FULL_M - 1), 0, 'inside FULL band: lod 0');
assert.equal(fxLodLevel(FX_LOD_FULL_M), 1, 'at FULL boundary: reduced');
assert.equal(fxLodLevel(FX_LOD_REDUCED_M - 1), 1, 'inside REDUCED band: lod 1');
assert.equal(fxLodLevel(FX_LOD_REDUCED_M), 2, 'at REDUCED boundary: primary masses only');
assert.equal(fxLodLevel(2000), 2, 'far effects stay clamped at lod 2');
for (let d = 0; d < 1200; d += 7) {
  const prev = fxLodLevel(d);
  const next = fxLodLevel(d + 7);
  assert.ok(next >= prev, `lod must be monotonic non-decreasing at ${d} m`);
}
assert.equal(fxLodLevel(NaN), 0, 'NaN distance guards to full detail');
assert.equal(fxLodLevel(-5), 0, 'negative distance guards to full detail');
assert.ok(FX_LOD_FULL_M < FX_LOD_REDUCED_M, 'LOD bands are ordered');
assert.ok(FX_LOD_WARM_S > 0 && FX_LOD_WARM_S < 3,
  'warm grace window covers boot warm passes without hiding live LOD');

// --- heavy-beat admission ------------------------------------------------------
assert.ok(Number.isInteger(FX_HEAVY_CREDITS_PER_TICK) && FX_HEAVY_CREDITS_PER_TICK >= 1,
  'heavy-beat budget is a positive integer per rendered frame');

// --- pool-pressure response ----------------------------------------------------
assert.equal(fxColumnPuffsPerTick(0.9, 0.0), 4, 'fresh column pumps 4 puffs/tick');
assert.equal(fxColumnPuffsPerTick(0.5, 0.0), 3, 'aged column pumps 3 puffs/tick');
assert.equal(fxColumnPuffsPerTick(0.5, 0.91), 2, '>90% smoke pressure throttles to 2');
assert.equal(fxColumnPuffsPerTick(0.9, 0.96), 1, '>95% smoke pressure keeps one continuity puff');
for (const [stage, occ] of [[0, 0], [1, 0.5], [0.5, 0.89], [1, 0.93], [0.2, 0.99]]) {
  const n = fxColumnPuffsPerTick(stage, occ);
  assert.ok(n >= 1 && n <= 4, `column tick count bounded 1..4 (${stage}/${occ})`);
}
assert.equal(fxDustAdmitted(0.5), true, 'dust admitted under pressure threshold');
assert.equal(fxDustAdmitted(0.92), true, 'dust admitted at the threshold (<=)');
assert.equal(fxDustAdmitted(0.93), false, 'dust refused above the threshold');

// --- tracer screen-space readability floor -------------------------------------
assert.ok(FX_TRACER_MIN_HALF_PX > 0 && FX_TRACER_MIN_HALF_PX < 2,
  'tracer pixel floor is a sub-2px half-width');
assert.ok(FX_TRACER_MAX_HALF_M > 1 && FX_TRACER_MAX_HALF_M <= 4,
  'tracer world-width ceiling keeps fog-range ribbons sane');
// 1080p, 55° vertical fov: one pixel at 300 m ≈ 0.29 m — a 0.10 m APFSDS
// ribbon must be floored up to ~0.75 px ≈ 0.22 m half-width there.
const px300 = fxPixelWorldSize(Math.tan((55 / 2) * Math.PI / 180), 1080, 300);
assert.ok(px300 > 0.25 && px300 < 0.35, `pixel world size at 300 m sane (${px300.toFixed(3)} m)`);
assert.equal(fxTracerEnergyK(0.5, 0.5), 1, 'physical-width ribbons keep full brightness');
assert.equal(fxTracerEnergyK(0.6, 0.3), 1, 'no dimming when no floor applies');
const k = fxTracerEnergyK(0.05, 0.22);
assert.ok(k > 0 && k < 1, `floored ribbons dim (${k.toFixed(3)})`);
assert.ok(k > 0.05 / 0.22, 'dimming is sub-linear (energy grows sub-linearly, not conserved 1:1)');
assert.equal(fxTracerEnergyK(0.05, 0), 1, 'degenerate final width guards to 1');

// --- shader/policy drift guard ---------------------------------------------------
// The tracer vertex shader inlines this policy (GLSL cannot call JS); fail
// loudly if the constants or the uniforms stop being wired through.
const effectsSrc = await readFile(new URL('./effects.js', import.meta.url), 'utf8');
assert.ok(/uViewport/.test(effectsSrc) && /uTanHalfFov/.test(effectsSrc),
  'tracer readability-floor uniforms are declared');
assert.ok(/FX_TRACER_MIN_HALF_PX\.toFixed/.test(effectsSrc) &&
  /FX_TRACER_MAX_HALF_M\.toFixed/.test(effectsSrc),
  'tracer shader interpolates the policy constants (no hand-copied drift)');
assert.ok(/fxColumnPuffsPerTick\(/.test(effectsSrc), 'column pressure policy is wired');
assert.ok(/fxDustAdmitted\(/.test(effectsSrc), 'dust admission policy is wired');
assert.ok(/admitHeavy\(\)/.test(effectsSrc), 'heavy-beat admission is wired');
assert.ok(/poolOccupancy\(\)/.test(effectsSrc), 'occupancy signal is consumed');

// --- WA2 particle program census (battle-open warm cost) ----------------------
// The warm stage's shader-first-use storm scales with unique programs. The
// census table in fxPolicy.js documents the real grouping; these assertions
// pin it to the particles.js source so a new pool or fragment variant must
// update the table (and the warm bill) deliberately.
const particlesSrc = await readFile(new URL('./particles.js', import.meta.url), 'utf8');
const censusFamilies = Object.values(FX_PARTICLE_PROGRAM_GROUPS).flat();
assert.equal(censusFamilies.length, 9, 'census covers all nine pooled families');
assert.equal(new Set(censusFamilies).size, 9, 'census families are distinct');
for (const family of censusFamilies) {
  const count = particlesSrc.split(`new Pool('${family}'`).length - 1;
  assert.equal(count, 1, `pool '${family}' is constructed exactly once and registered`);
}
// Shared-program pairs: smoke/dust and fire/flash must keep IDENTICAL shader
// sources — they differ only by uniforms/texture, which three's program cache
// ignores. A per-pool fragment override for these four would silently add two
// program links back to the battle-open warm.
assert.ok(/fragmentShader: additive \? PUFF_FRAG_ADDITIVE : PUFF_FRAG_NORMAL/.test(particlesSrc),
  'puff fragment selection stays the shared two-variant ternary');
for (const marker of [
  "m.fragmentShader = PUFF_FRAG_BILLOW;",   // billow only
  "m.fragmentShader = PUFF_FRAG_PROP;",     // psmoke only
]) {
  assert.equal(particlesSrc.split(marker).length - 1, 1,
    `fragment override '${marker.trim()}' remains single-use`);
}
// Idle-draw gating: empty pools must not submit draws (setProgram + uniform
// upload) every rendered frame. Hidden at construction and after killAll(),
// shown by the first claim(); warm routes fill every pool before their
// compile/render windows, so coverage is preserved.
assert.ok(/this\.mesh\.visible = false;\s*\n\s*\}\s*\n\s*\/\*\* Claim the next ring slot/.test(particlesSrc),
  'pools start hidden (no idle draw submissions)');
assert.ok(/claim\(\) \{[\s\S]*?this\.mesh\.visible = true;/m.test(particlesSrc),
  'first claim() shows the pool mesh');
assert.ok(/killAll\(\) \{[\s\S]*?this\.mesh\.visible = false;/m.test(particlesSrc),
  'killAll() hides the pool mesh again');
// Decoded prebuilt atlases are released once GPU-resident — never retained
// alongside the bake for the whole session.
assert.ok(/textureAssetImages = null;/.test(particlesSrc) &&
  /textureAssetPromise = null;/.test(particlesSrc),
  'decoded atlas heap is released after install/bake');

console.log('fxPolicy.selftest: LOD bands, admission budget, pressure response, tracer floor passed');
