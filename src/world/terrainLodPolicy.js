// Pure terrain-LOD policy. Kept free of Three.js/DOM so the opening-region
// streaming contract can be verified in Node without constructing WebGL.

export const TERRAIN_LOD_DIST = Object.freeze([200, 430]);

// Screen-space error view: instead of fixed switch distances, pick the finest
// LOD whose projected geometric error stays under `errorPx`. The per-level
// error proxy is reliefK x vertex spacing (128 m chunk / 96|48|24 segs);
// reliefK=0.35 is calibrated so the desktop defaults below reproduce the
// hand-tuned TERRAIN_LOD_DIST within a few percent — and then adapt for free:
// a sniper FOV keeps fine detail far into the distance (where fixed distances
// pop visibly through the scope) while a small viewport relaxes them.
export const TERRAIN_LOD_VIEW_DEFAULTS = Object.freeze({
  fovDeg: 60,
  viewportH: 1080,
  errorPx: 2,
  reliefK: 0.35,
});
// Chunk vertex spacings per LOD level, meters (128 / [96, 48, 24]).
export const TERRAIN_LOD_SPACING_M = Object.freeze([4 / 3, 8 / 3, 16 / 3]);
// A scope's narrow FOV can project "acceptable" error past the map's own
// reach; cap thresholds at the farthest terrain a camera can actually see.
const TERRAIN_VIEW_MAX_M = 720;

/**
 * Distance thresholds [t0, t1] at which each finer level's projected error
 * reaches errorPx. Fills `out` (a reused pair) and returns it.
 */
export function terrainLodThresholdsM(view = null, out = [0, 0]) {
  const v = view
    ? { ...TERRAIN_LOD_VIEW_DEFAULTS, ...view }
    : TERRAIN_LOD_VIEW_DEFAULTS;
  const tanHalf = Math.tan(v.fovDeg * Math.PI / 360);
  // pixels of projected size per meter of geometric error at distance 1 m
  const pxPerMeter = (v.viewportH * 0.5) / (Math.max(1e-3, v.errorPx) * tanHalf);
  // A scope's narrow FOV can project "acceptable" error past the map's own
  // reach; cap thresholds at the farthest terrain a camera can actually see,
  // keeping t0 < t1 so the picker stays well-formed.
  out[0] = Math.min(TERRAIN_VIEW_MAX_M - 1,
    Math.max(40, v.reliefK * TERRAIN_LOD_SPACING_M[0] * pxPerMeter));
  out[1] = Math.min(TERRAIN_VIEW_MAX_M,
    Math.max(out[0] + 1, v.reliefK * TERRAIN_LOD_SPACING_M[1] * pxPerMeter));
  return out;
}

/**
 * {@link terrainLodForDistance} against view-derived thresholds. Same ±10%
 * hysteresis shape; `th` is a [t0, t1] pair from {@link terrainLodThresholdsM}.
 */
export function terrainLodForView(distanceM, currentLevel = 2, th = TERRAIN_LOD_DIST) {
  const t0 = th[0] * (currentLevel === 0 ? 1.1 : 0.9);
  const t1 = th[1] * (currentLevel <= 1 ? 1.1 : 0.9);
  return distanceM < t0 ? 0 : distanceM < t1 ? 1 : 2;
}

export function terrainLodForDistance(distanceM, currentLevel = 2, th = TERRAIN_LOD_DIST) {
  return terrainLodForView(distanceM, currentLevel, th);
}

/**
 * Geometry required before the opening frame. Every chunk gets exactly the
 * level visible from deployment; other levels have a valid mesh to fall back
 * to until their identical-detail replacement is streamed.
 */
export function initialTerrainLods(distanceM) {
  const want = distanceM < TERRAIN_LOD_DIST[0]
    ? 0 : distanceM < TERRAIN_LOD_DIST[1] ? 1 : 2;
  return [want];
}

// Motion prefetch: rank lookahead jobs against where the camera is HEADING so
// the next finer level exists before the switch threshold crosses at speed.
// Lead time covers one streaming pass (~4 frames/job at 60 Hz plus margin);
// the clamp keeps slow pans from stretching the band.
export const TERRAIN_PREFETCH_LEAD_S = 1.5;
export const TERRAIN_PREFETCH_MAX_M = 150;

// Memory retention: built geometry beyond retainM[level] from the camera is
// released (the chooser rebuilds it on approach). The 1.6x margin sits just
// outside the +125 m prefetch ring (200+125=325 vs 320), so a chunk evicted
// at the retention edge is only re-requested after real travel — no thrash.
// Level 2 (the cheap coarse fallback every chunk must always have) is never
// evicted; level 0 is the ~465 KB heavyweight this policy actually targets.
export const TERRAIN_RETAIN_MARGIN = 1.6;
export const TERRAIN_LOD_RETAIN_M = Object.freeze([
  TERRAIN_LOD_DIST[0] * TERRAIN_RETAIN_MARGIN,
  TERRAIN_LOD_DIST[1] * TERRAIN_RETAIN_MARGIN,
]);

/**
 * Pick at most one missing geometry for this rendered frame. Missing visible
 * detail wins first; then a one-band lookahead quietly prepares the next finer
 * level before the camera reaches its normal switch threshold. With `motion`
 * ({vx, vz} in m/s) the lookahead band and prefetch ranking are evaluated
 * ahead of the camera along its velocity, biasing work toward chunks the
 * player is driving toward.
 *
 * @param {Array<{cx:number,cz:number,level:number,present:boolean[]}>} chunks
 * @param {?{vx:number,vz:number}} [motion] camera velocity m/s (optional)
 * @param {[number,number]} [th] switch thresholds (view-derived or default)
 * @param {?{index:number,level:number,distanceM:number,urgent:boolean}} [out]
 * @returns {null|{index:number,level:number,distanceM:number,urgent:boolean}}
 */
export function chooseTerrainLodBuild(chunks, camX, camZ, out = null, motion = null,
  th = TERRAIN_LOD_DIST) {
  // Project the camera forward along its motion for the PREFETCH decision
  // only: urgent (visible-detail-missing) work is about where the camera IS.
  let px = camX, pz = camZ;
  if (motion && Number.isFinite(motion.vx) && Number.isFinite(motion.vz)) {
    const speed = Math.hypot(motion.vx, motion.vz);
    if (speed > 0.5) {
      const lead = Math.min(speed * TERRAIN_PREFETCH_LEAD_S, TERRAIN_PREFETCH_MAX_M);
      px += (motion.vx / speed) * lead;
      pz += (motion.vz / speed) * lead;
    }
  }
  let bestIndex = -1;
  let bestLevel = -1;
  let bestDistance = Infinity;
  let bestUrgent = false;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const distanceM = Math.hypot(camX - chunk.cx, camZ - chunk.cz);
    const want = terrainLodForDistance(distanceM, chunk.level, th);
    const present = chunk.present || chunk.lods;
    if (!present[want]) {
      if (bestIndex < 0 || !bestUrgent || distanceM < bestDistance) {
        bestIndex = index;
        bestLevel = want;
        bestDistance = distanceM;
        bestUrgent = true;
      }
      continue;
    }
    if (bestUrgent) continue;

    // Prepare one finer band roughly one chunk before its visible threshold,
    // measured against the predicted camera position when moving.
    const predD = Math.hypot(px - chunk.cx, pz - chunk.cz);
    let prefetch = -1;
    if (want === 2 && predD < th[1] + 125) prefetch = 1;
    else if (want === 1 && predD < th[0] + 125) prefetch = 0;
    if (prefetch >= 0 && !present[prefetch]) {
      if (bestIndex < 0 || predD < bestDistance) {
        bestIndex = index;
        bestLevel = prefetch;
        bestDistance = predD;
        bestUrgent = false;
      }
    }
  }
  if (bestIndex < 0) return null;
  const result = out || {};
  result.index = bestIndex;
  result.level = bestLevel;
  result.distanceM = bestDistance;
  result.urgent = bestUrgent;
  return result;
}

/**
 * Memory-retention plan: built LOD geometries farther than retainM[level]
 * from the camera, excluding each chunk's currently displayed level. Coarsest
 * level 2 is outside the plan entirely (every chunk must keep its fallback).
 * Candidates come back farthest-first so a caller applying a per-frame cap
 * frees the most unreachable memory first. `out` is reused across calls.
 *
 * @returns {Array<{index:number,level:number,distanceM:number}>}
 */
export function planTerrainLodEvictions(chunks, camX, camZ, opts = null, out = []) {
  const retain = (opts && opts.retain) || TERRAIN_LOD_RETAIN_M;
  out.length = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const lods = chunk.lods;
    if (!lods) continue;
    const distanceM = Math.hypot(camX - chunk.cx, camZ - chunk.cz);
    for (let level = 0; level < retain.length && level < lods.length; level++) {
      if (level === chunk.level || !lods[level]) continue;
      if (distanceM > retain[level]) out.push({ index, level, distanceM });
    }
  }
  out.sort((a, b) => b.distanceM - a.distanceM);
  return out;
}
