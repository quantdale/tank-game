import assert from 'node:assert/strict';
import { PRESETS } from './quality.js';
import {
  SHADOW_CASTER_MIN_TEXELS,
  resolveCasterMinTexels,
  snapShadowCoordinate,
  subtexelCullRadius,
} from './shadowStability.js';

const cascadeSpans = [82.5, 176.25, 391.5, 806.75];

for (const [name, preset] of Object.entries(PRESETS)) {
  preset.shadowMapSizes.forEach((size, index) => {
    const texel = cascadeSpans[index] / size;
    const cell = 137 + index * 11;
    const insideCell = (cell + 0.2) * texel;
    const snapped = snapShadowCoordinate(insideCell, texel);
    assert.ok(
      Math.abs(snapped / texel - cell) < 1e-9,
      `${name} cascade ${index} must align to its ${size}px texel grid`,
    );
    assert.equal(
      snapShadowCoordinate(insideCell + texel * 0.5, texel),
      snapped,
      `${name} cascade ${index} must not move within one texel`,
    );
    assert.ok(
      Math.abs(snapShadowCoordinate(insideCell + texel, texel) - snapped - texel) < 1e-9,
      `${name} cascade ${index} must advance by exactly one texel`,
    );
  });
}

// --- W4 per-cascade sub-texel caster floor ---------------------------------
// A caster whose silhouette is below the floor cannot resolve as a visible
// shadow in THAT cascade; the floor must scale with each cascade's texel so
// near/contact maps keep every caster while far maps shed tiny casters.
{
  assert.equal(subtexelCullRadius(0), 0, 'unknown texel size disables the sub-texel cut');
  assert.equal(subtexelCullRadius(-1), 0, 'degenerate texel size disables the sub-texel cut');
  assert.equal(subtexelCullRadius(Number.NaN), 0, 'NaN texel size disables the sub-texel cut');
  for (const [name, preset] of Object.entries(PRESETS)) {
    let prevFloor = -1;
    preset.shadowMapSizes.forEach((size, index) => {
      const texel = cascadeSpans[index] / size;
      const floor = subtexelCullRadius(texel);
      assert.ok(
        Math.abs(floor - texel * SHADOW_CASTER_MIN_TEXELS) < 1e-12,
        `${name} cascade ${index} floor is ${SHADOW_CASTER_MIN_TEXELS}x its texel`,
      );
      if (prevFloor >= 0) {
        assert.ok(floor > prevFloor,
          `${name} cascade ${index} culls more than cascade ${index - 1}`);
      }
      prevFloor = floor;
    });
  }
  // Concrete distance tiers (ultra): a 5 cm pebble keeps its shadow in the
  // hero cascade but is useless work in the far map...
  const ultraTexels = cascadeSpans.map((span, i) => span / PRESETS.ultra.shadowMapSizes[i]);
  assert.ok(subtexelCullRadius(ultraTexels[0]) < 0.05,
    'ultra hero cascade still resolves a 5 cm caster');
  assert.ok(subtexelCullRadius(ultraTexels[3]) > 0.05,
    'ultra far cascade sheds a 5 cm caster');
  // ...and a 50 cm crate stays resolvable on ultra's far map but drops out of
  // a mobile far map, whose texels are ~8x coarser.
  const mobileTexels = cascadeSpans.map((span, i) => span / PRESETS.mobile.shadowMapSizes[i]);
  assert.ok(subtexelCullRadius(ultraTexels[2]) < 0.5,
    'ultra mid-far cascade keeps a 50 cm caster');
  assert.ok(subtexelCullRadius(mobileTexels[2]) > 0.5,
    'mobile far cascade sheds a 50 cm caster');
  // An explicit (preset-resolved) floor is honored, and a higher floor sheds
  // a strict superset; floor 0 disables the cut entirely.
  const midTexel = ultraTexels[2];
  assert.ok(subtexelCullRadius(midTexel, 1.25) > subtexelCullRadius(midTexel, 0.75),
    'a raised preset floor culls more than the shipped one');
  assert.equal(subtexelCullRadius(midTexel, 0), 0,
    'floor 0 disables the sub-texel cut');
}

// --- WA2 preset lever: shadowCasterMinTexels ---------------------------------
// The W4 sub-texel floor becomes preset-readable (quality.js
// `shadowCasterMinTexels`) with the shipped constant as fallback. Until
// quality.js grows the key, every tier must resolve to wave-1 behavior.
{
  assert.equal(resolveCasterMinTexels(undefined), SHADOW_CASTER_MIN_TEXELS,
    'missing preset falls back to the shipped floor');
  assert.equal(resolveCasterMinTexels(null), SHADOW_CASTER_MIN_TEXELS,
    'null preset falls back to the shipped floor');
  assert.equal(resolveCasterMinTexels({}), SHADOW_CASTER_MIN_TEXELS,
    'preset without the key keeps the shipped floor');
  assert.equal(resolveCasterMinTexels({ shadowCasterMinTexels: 1.25 }), 1.25,
    'preset override is honored');
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'big', null]) {
    assert.equal(resolveCasterMinTexels({ shadowCasterMinTexels: bad }),
      SHADOW_CASTER_MIN_TEXELS,
      `invalid override ${String(bad)} fails safe to the shipped floor`);
  }
  // Presets now carry per-tier floor data (campaign-2026-08-21 wave 2):
  // every preset must resolve a usable (finite, positive) floor, desktop
  // tiers keep the shipped 0.75, and constrained tiers shed more.
  for (const [name, preset] of Object.entries(PRESETS)) {
    const resolved = resolveCasterMinTexels(preset);
    assert.ok(Number.isFinite(resolved) && resolved > 0,
      `${name} resolves a usable floor`);
    if (name === 'medium' || name === 'low' || name.includes('mobile')) {
      assert.ok(resolved >= SHADOW_CASTER_MIN_TEXELS,
        `${name} sheds at least the shipped floor`);
    } else {
      assert.equal(resolved, SHADOW_CASTER_MIN_TEXELS,
        `${name} keeps the shipped floor`);
    }
  }
}

console.log('shadowStability.selftest: ok');
