import { IMPACT_DECAL_CAP, IMPACT_DECAL_LIFT_M, decalVisibleForPosition } from './impactDecals.js';
import { SURFACE_MARKING_STYLE } from '../vehicles/vehicleMarkings.js';
import { createCellLifecycle, CELL_STATES } from '../world/cellLifecycle.js';

if (IMPACT_DECAL_CAP < 16) throw new Error('impact decal vehicle budget regressed');
if (IMPACT_DECAL_LIFT_M <= 0 || IMPACT_DECAL_LIFT_M > 0.01) {
  throw new Error(`impact decals must sit within 10 mm of armor (${IMPACT_DECAL_LIFT_M} m)`);
}
if (IMPACT_DECAL_LIFT_M !== SURFACE_MARKING_STYLE.surfaceLiftM) {
  throw new Error('impact scars and painted designations must share one surface-layer contract');
}

// ---- SA-07 world-cell visibility gate --------------------------------------
// The grid spans [-512, 512] m in 128 m cells; cell centers sit at
// ±64, ±192, ±320, ±448. cellEdgeDistance subtracts the half-diagonal, so a
// camera AT a cell center reads that cell at edge distance 0 (ACTIVE).
const cells = createCellLifecycle();
cells.update(0, 0); // observer at the map center

if (!decalVisibleForPosition(cells, 0, 0)) {
  throw new Error('scarring in the observer ACTIVE cell must render');
}
// Diagonal far cell: edge distance = hypot(448,448) - 128*0.71 ≈ 543 m from
// the center observer -> DISTANT band [430, 640). (The axis cell (448,0)
// reads only ~357 m -> SHADOW_ONLY, where decals stay visible by policy.)
const farState = cells.stateAt(448, 448);
if (farState !== CELL_STATES.DISTANT) {
  throw new Error(`expected far cell DISTANT, got ${farState}`);
}
if (decalVisibleForPosition(cells, 448, 448)) {
  throw new Error('scarring in a DISTANT cell must be culled (subpixel)');
}
// Outside the grid is DORMANT by contract — scars there never render.
if (decalVisibleForPosition(cells, 2000, 0)) {
  throw new Error('off-grid scarring must be culled');
}
// Enriching the far cell restores its marks: move the observer onto it.
cells.update(448, 448);
if (!decalVisibleForPosition(cells, 448, 448)) {
  throw new Error('marks must restore when their cell enriches');
}
if (decalVisibleForPosition(cells, 0, 0)) {
  throw new Error('abandoned center cell must now cull its marks');
}

console.log('impactDecals.selftest: budget/lift constants + SA-07 world-cell gate passed');
