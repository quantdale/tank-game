// Pure world-cell lifecycle policy. Kept free of Three.js/DOM (same contract
// as terrainLodPolicy.js) so the state machine is Node-verifiable and a
// headless authority can later share the renderer's interest metric.
//
// W8 foundations: the map is partitioned into the 8x8 grid of 128 m cells
// already shared by terrain chunks (terrain.js CHUNKS/CHUNK_SIZE) and
// vegetation chunks (vegetation.js CHUNK_SIZE). Each cell holds one lifecycle
// state that consumers use to govern update rate, visibility, shadow
// participation and (conceptually) residency of everything inside it, instead
// of each subsystem re-deriving its own distance bands:
//
//   ACTIVE      full update rate, full representation, casts shadows
//   VISIBLE     rendered + casting at reduced update cadence
//   SHADOW_ONLY resting-pose representation + shadow pass, no per-frame updates
//   DISTANT     coarsest representation, no shadow participation, no updates
//   DORMANT     outside interest; hidden / conceptually evictable residency
//
// States derive purely from observer geometry with entry/exit hysteresis —
// no wall clock, no randomness — so identical camera paths reproduce
// identical state sequences.

export const CELL_STATES = Object.freeze({
  ACTIVE: 0,
  VISIBLE: 1,
  SHADOW_ONLY: 2,
  DISTANT: 3,
  DORMANT: 4,
});

export const CELL_STATE_NAMES = Object.freeze([
  'ACTIVE', 'VISIBLE', 'SHADOW_ONLY', 'DISTANT', 'DORMANT',
]);

// Rich→poor band edges in edge-adjusted meters, aligned with the established
// visual partitions: 180 = grass full-density fade end (vegetation
// GRASS_FADE_END), 290 = tree full-detail outer hysteresis (TREE_NEAR_OUT),
// 430 = terrain mid/far LOD boundary (TERRAIN_LOD_DIST[1]), 640 = max aimed-
// fire corridor (the uScopeDist cap in vegetation.setSniperFade).
export const CELL_STATE_DISTS = Object.freeze([180, 290, 430, 640]);

// Same margins as terrainLodForDistance: a richer state is entered 10% early
// and given up 10% late so a hull idling on a band edge cannot oscillate.
const STATE_ENTER = 0.9;
const STATE_EXIT = 1.1;

/**
 * Suggested per-state animation-update cadence multiplier. Consumers treat it
 * as "tick every 1/scale opportunities", never as fractional dt.
 */
export const CELL_UPDATE_SCALE = Object.freeze([1, 0.5, 0, 0, 0]);

/** Main-pass shadow participation per state (castShadow gate for content). */
export const CELL_SHADOW = Object.freeze([true, true, true, false, false]);

/** Main-pass visibility per state (DORMANT content may hide/unmount). */
export const CELL_VISIBLE = Object.freeze([true, true, true, true, false]);

// Lifecycle grid mirrors the shared terrain/vegetation chunk grid.
export const CELL_GRID_N = 8;
export const CELL_SIZE_M = 128;

// Reclassify when either observer moved this far, or this many updates after
// the last pass — whichever first. 4 m is ~17 frames of top-speed driving and
// well under a third of a cell, so cached states stay fresh between passes.
const CLASSIFY_MOVE_M = 4;
const CLASSIFY_MAX_UPDATES = 64;

/**
 * Lifecycle state for an edge-adjusted distance, with entry/exit hysteresis
 * around every band edge (same shape as terrainLodForDistance). Transitions
 * may skip bands in one step (teleports) but hysteresis still applies to the
 * band the cell currently sits in.
 * @param {number} distanceM distance from the observer to the cell's near edge
 * @param {number} [currentState] current state (defaults DORMANT)
 * @returns {number} CELL_STATES value
 */
export function cellStateForDistance(distanceM, currentState = CELL_STATES.DORMANT) {
  for (let i = 0; i < CELL_STATE_DISTS.length; i++) {
    const edge = CELL_STATE_DISTS[i] * (currentState === i ? STATE_EXIT : STATE_ENTER);
    if (distanceM < edge) return i;
  }
  return CELL_STATES.DORMANT;
}

/**
 * Distance from a point to a cell's near edge, measured from its center minus
 * the half-diagonal (vegetation's grass-chunk convention, CHUNK_SIZE * 0.71):
 * a point inside the cell reads 0 regardless of where the center sits.
 */
export function cellEdgeDistance(dxM, dzM, cellSizeM) {
  return Math.max(0, Math.hypot(dxM, dzM) - cellSizeM * 0.71);
}

/**
 * Per-map lifecycle tracker: classifies all cells from up to two observers
 * (render camera + chase focus; each cell takes the nearer), buckets static
 * world content into cells once at build time, and answers cached queries
 * without allocating. All hot-path writes land in preallocated typed arrays.
 *
 * @param {{gridN?:number, cellSizeM?:number, originM?:number}} [opts]
 */
export function createCellLifecycle(opts = {}) {
  const gridN = opts.gridN ?? CELL_GRID_N;
  const sizeM = opts.cellSizeM ?? CELL_SIZE_M;
  const originM = opts.originM ?? -(gridN * sizeM) / 2;
  const count = gridN * gridN;

  const states = new Uint8Array(count);
  states.fill(CELL_STATES.DORMANT); // nothing is awake before the first classify
  const changed = new Uint8Array(count);
  const statsCounts = new Uint16Array(CELL_STATE_NAMES.length);
  const statsOut = { ACTIVE: 0, VISIBLE: 0, SHADOW_ONLY: 0, DISTANT: 0, DORMANT: 0, version: 0 };

  // Static content registry: kind → per-cell arrays of record indices. Built
  // once by map.js at assemble time so W2/W7-style consumers can enumerate
  // what a state change affects without scanning whole-map record lists.
  /** @type {Map<string, Array<number[]|null>>} */
  const registry = new Map();

  let version = 0;
  let classifies = 0;
  let lastCamX = NaN, lastCamZ = NaN, lastFocusX = NaN, lastFocusZ = NaN;
  let updatesSince = 0;

  /**
   * Reclassify every cell from the render camera and (optionally) the chase
   * focus; each cell takes the nearer observer. Throttled: a no-op unless an
   * observer moved {@linkcode CLASSIFY_MOVE_M} or
   * {@linkcode CLASSIFY_MAX_UPDATES} updates elapsed. `force` bypasses the
   * throttle (teleports, match start).
   * @param {number} camX render camera x
   * @param {number} camZ render camera z
   * @param {?number} [focusX] chase-focus x (player hull)
   * @param {?number} [focusZ] chase-focus z
   * @param {boolean} [force=false] skip the movement throttle
   * @returns {boolean} true if any cell changed state this pass
   */
  function update(camX, camZ, focusX = null, focusZ = null, force = false) {
    updatesSince++;
    const hasFocus = focusX != null;
    // A focus appearing/disappearing changes the interest metric itself, so
    // it always reclassifies (main.js passes occlFocus only in arcade chase).
    if (!force && !Number.isNaN(lastCamX) &&
        Number.isNaN(lastFocusX) === !hasFocus) {
      let moved = Math.hypot(camX - lastCamX, camZ - lastCamZ);
      if (hasFocus && !Number.isNaN(lastFocusX)) {
        moved = Math.min(moved, Math.hypot(focusX - lastFocusX, focusZ - lastFocusZ));
      }
      if (moved < CLASSIFY_MOVE_M && updatesSince < CLASSIFY_MAX_UPDATES) return false;
    }
    lastCamX = camX; lastCamZ = camZ;
    // NaN, not null: null coerces to 0 in the arithmetic above.
    lastFocusX = focusX == null ? NaN : focusX;
    lastFocusZ = focusZ == null ? NaN : focusZ;
    updatesSince = 0;
    classifies++;
    let anyChange = false;
    for (let cz = 0; cz < gridN; cz++) {
      const ccz = originM + cz * sizeM + sizeM * 0.5;
      for (let cx = 0; cx < gridN; cx++) {
        const index = cz * gridN + cx;
        const ccx = originM + cx * sizeM + sizeM * 0.5;
        let d = cellEdgeDistance(camX - ccx, camZ - ccz, sizeM);
        if (focusX != null) {
          const df = cellEdgeDistance(focusX - ccx, focusZ - ccz, sizeM);
          if (df < d) d = df;
        }
        const s = cellStateForDistance(d, states[index]);
        if (s !== states[index]) {
          states[index] = s;
          changed[index] = 1;
          anyChange = true;
        } else {
          changed[index] = 0;
        }
      }
    }
    if (anyChange) version++;
    return anyChange;
  }

  /** Cell index containing (x, z), or -1 outside the grid. */
  function indexAt(x, z) {
    const cx = Math.floor((x - originM) / sizeM);
    const cz = Math.floor((z - originM) / sizeM);
    if (cx < 0 || cx >= gridN || cz < 0 || cz >= gridN) return -1;
    return cz * gridN + cx;
  }

  function stateAt(x, z) {
    const index = indexAt(x, z);
    return index < 0 ? CELL_STATES.DORMANT : states[index];
  }

  function updateScaleAt(x, z) {
    return CELL_UPDATE_SCALE[stateAt(x, z)];
  }

  /** Per-state cell counts into a reused object (debug HUD / probes). */
  function stats() {
    statsCounts.fill(0);
    for (let i = 0; i < count; i++) statsCounts[states[i]]++;
    statsOut.ACTIVE = statsCounts[CELL_STATES.ACTIVE];
    statsOut.VISIBLE = statsCounts[CELL_STATES.VISIBLE];
    statsOut.SHADOW_ONLY = statsCounts[CELL_STATES.SHADOW_ONLY];
    statsOut.DISTANT = statsCounts[CELL_STATES.DISTANT];
    statsOut.DORMANT = statsCounts[CELL_STATES.DORMANT];
    statsOut.version = version;
    return statsOut;
  }

  /**
   * Bucket static content records ({x, z, r?}) into their covering cells once
   * at build time. A record with radius r covers every cell its bounding box
   * touches; point records cover exactly their containing cell.
   * @param {Array<{x:number, z:number, r?:number}>} items
   * @param {string} kind stable consumer key ('treeCluster' | 'building' ...)
   */
  function registerContent(items, kind) {
    let cells = registry.get(kind);
    if (!cells) {
      cells = new Array(count).fill(null);
      registry.set(kind, cells);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const r = item.r || 0;
      // Clamped index ranges handle records hanging off any grid edge; a
      // record fully outside collapses to lo>hi and is skipped.
      const loX = Math.max(0, Math.floor((item.x - r - originM) / sizeM));
      const hiX = Math.min(gridN - 1, Math.floor((item.x + r - originM) / sizeM));
      const loZ = Math.max(0, Math.floor((item.z - r - originM) / sizeM));
      const hiZ = Math.min(gridN - 1, Math.floor((item.z + r - originM) / sizeM));
      if (loX > hiX || loZ > hiZ) continue;
      for (let cz = loZ; cz <= hiZ; cz++) {
        for (let cx = loX; cx <= hiX; cx++) {
          const index = cz * gridN + cx;
          (cells[index] || (cells[index] = [])).push(i);
        }
      }
    }
  }

  /**
   * Enumerate registered content indices of `kind` covering a cell.
   * @param {string} kind registry key passed to registerContent
   * @param {number} cellIndex 0..count-1
   * @param {function(number): void} cb
   */
  function forEachContent(kind, cellIndex, cb) {
    const cells = registry.get(kind);
    const list = cells && cells[cellIndex];
    if (list) for (let i = 0; i < list.length; i++) cb(list[i]);
  }

  return {
    gridN, sizeM, originM, count,
    states, changed, // read-only by convention; typed for cheap fan-out
    get version() { return version; },
    get classifies() { return classifies; }, // passes run (throttle telemetry)
    update, indexAt, stateAt, updateScaleAt, stats,
    registerContent, forEachContent,
  };
}
