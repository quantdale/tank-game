import assert from 'node:assert/strict';
import { PRESETS } from './quality.js';
import {
  SHADOW_CASTER_MIN_TEXELS,
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
}

console.log('shadowStability.selftest: ok');
