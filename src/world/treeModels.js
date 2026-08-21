// src/world/treeModels.js — species silhouette / variation tables for the
// vegetation layer (SA-12 Vegetation Art Ceiling).
//
// PURE DATA, Node-safe: no THREE, no DOM, no canvas. vegetation.js consumes
// these tables when building near/far tree geometry and grass tufts; this
// module exists so the variation model is inspectable and regression-tested
// headlessly (vegetation.js itself needs a browser canvas and cannot run in
// `node`).
//
// Contract:
// - Every table is a frozen array of frozen plain objects. Do not mutate at
//   runtime — geometry builders read them at battle-build time.
// - The FIRST PINE_VAR entry pins the legacy pine proportions (h0 5.9,
//   hr 0.6, topY 6.4, rMul 1) so an accidental retune of the default fails
//   the selftest instead of silently shifting every conifer stand.
// - Builders treat every field as optional-with-default; adding fields is
//   backward compatible, renaming them is not.

// Broadleaf crown silhouettes: round classic / tall columnar / wide spreading.
export const OAK_SHAPES = [
  { cy: 4.35, rx: 2.35, ry: 1.75, rz: 2.35, trunkH: 3.1, n: 58 }, // round classic
  // r4: columnar crown widened + more cards (1.85/52 -> 2.05/62) — at the
  // frame edge the sparse narrow variant read as "a bare pole with a tiny
  // blob canopy" (player_view right edge, critique)
  { cy: 5.05, rx: 2.05, ry: 2.30, rz: 2.05, trunkH: 3.8, n: 62 }, // tall columnar
  { cy: 3.80, rx: 3.05, ry: 1.40, rz: 3.05, trunkH: 2.6, n: 66 }, // wide spreading
];

// Palm stature variants: squat-thick leaning / classic / tall slender, with
// matching trunk gauges (rMul scales frond spread against trunk height).
export const PALM_VAR = [
  { h0: 4.5, hr: 1.0, rMul: 1.40, lean0: 0.72, leanR: 0.5 }, // squat, thick, leaning
  { h0: 5.6, hr: 1.4, rMul: 1.15, lean0: 0.50, leanR: 0.5 }, // classic (thicker)
  { h0: 7.0, hr: 1.6, rMul: 0.95, lean0: 0.32, leanR: 0.4 }, // tall slender
];

// Birch proportions: young slender / classic / old broad (SA-12: moved here
// verbatim from vegetation.js where it was first introduced by the r5
// terrain_environment rebuild).
export const BIRCH_VAR = [
  { h0: 4.3, hr: 0.9, crw: 1.15, nBr: 11 }, // young slender
  { h0: 6.0, hr: 1.3, crw: 1.55, nBr: 14 }, // classic
  { h0: 7.5, hr: 1.6, crw: 2.00, nBr: 17 }, // old broad
];

// SA-12: conifers were the last species without a silhouette table — near
// variants differed only by seed jitter, so stands still read as "the same
// pine repeated". Three distinct spruce statures; entry [0] pins the legacy
// proportions (see contract above). Fields:
// - h0/hr: base trunk height + jitter band (meters)
// - topY: crown tip height; drives card tier extent, snow-lobe band, and the
//   far-silhouette tier stack so near/far LODs stay coherent per variant
// - rMul: tier radius multiplier (spire < 1 < broad skirt)
export const PINE_VAR = [
  { h0: 5.9, hr: 0.6, topY: 6.4, rMul: 1.00 }, // classic conical (legacy)
  { h0: 6.9, hr: 0.5, topY: 7.5, rMul: 0.82 }, // narrow spire
  { h0: 5.1, hr: 0.5, topY: 5.8, rMul: 1.20 }, // broad skirt
];

// Grass tuft card profiles (SA-12: extracted from inline magic numbers in
// vegetation.js). Variant 0 is the upright lush tuft that breaks the ground
// plane beside the tracks; variant 1 is the wider low turf tuft.
export const GRASS_TUFTS = [
  { w: 0.92, h: 0.74 }, // upright lush tuft
  { w: 1.14, h: 0.58 }, // wide low turf tuft
];

const _isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// Integrity checks used by treeModels.selftest.mjs. Returns an array of
// human-readable problems; empty means every table satisfies the contract.
export function validateTreeModels() {
  const errors = [];
  const checkTable = (name, table, keys, { minLen = 1 } = {}) => {
    if (!Array.isArray(table) || table.length < minLen) {
      errors.push(`${name}: expected a frozen array of >= ${minLen} entries`);
      return;
    }
    if (!Object.isFrozen(table)) errors.push(`${name}: table is not frozen`);
    for (let i = 0; i < table.length; i++) {
      const e = table[i];
      if (!_isPlainObject(e)) { errors.push(`${name}[${i}]: not a plain object`); continue; }
      if (!Object.isFrozen(e)) errors.push(`${name}[${i}]: entry is not frozen`);
      for (const k of Object.keys(keys)) {
        const v = e[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errors.push(`${name}[${i}].${k}: expected finite number, got ${String(v)}`);
        } else if (v <= 0 && keys[k] === 'pos') {
          errors.push(`${name}[${i}].${k}: expected > 0, got ${v}`);
        }
      }
    }
  };
  checkTable('OAK_SHAPES', OAK_SHAPES,
    { cy: 'pos', rx: 'pos', ry: 'pos', rz: 'pos', trunkH: 'pos', n: 'pos' }, { minLen: 3 });
  checkTable('PALM_VAR', PALM_VAR,
    { h0: 'pos', hr: 'pos', rMul: 'pos', lean0: 'pos', leanR: 'pos' }, { minLen: 3 });
  checkTable('BIRCH_VAR', BIRCH_VAR,
    { h0: 'pos', hr: 'pos', crw: 'pos', nBr: 'pos' }, { minLen: 3 });
  checkTable('PINE_VAR', PINE_VAR,
    { h0: 'pos', hr: 'pos', topY: 'pos', rMul: 'pos' }, { minLen: 3 });
  checkTable('GRASS_TUFTS', GRASS_TUFTS, { w: 'pos', h: 'pos' }, { minLen: 2 });

  // Cross-field sanity: the three pine statures must actually differ, with
  // the spire taller+narrower than the legacy cone and the skirt shorter+wider.
  if (PINE_VAR.length >= 3) {
    const [legacy, spire, skirt] = PINE_VAR;
    if (!(spire.topY > legacy.topY && spire.rMul < legacy.rMul)) {
      errors.push('PINE_VAR[1]: expected a taller, narrower spire than the legacy cone');
    }
    if (!(skirt.topY < legacy.topY && skirt.rMul > legacy.rMul)) {
      errors.push('PINE_VAR[2]: expected a shorter, wider skirt than the legacy cone');
    }
  }
  return errors;
}

for (const t of [OAK_SHAPES, PALM_VAR, BIRCH_VAR, PINE_VAR, GRASS_TUFTS]) {
  Object.freeze(t);
  for (const e of t) Object.freeze(e);
}
