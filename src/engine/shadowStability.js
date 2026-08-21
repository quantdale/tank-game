/** Snap one light-space coordinate to a shadow-map texel. */
export function snapShadowCoordinate(coordinate, worldUnitsPerTexel) {
  return Math.floor(coordinate / worldUnitsPerTexel) * worldUnitsPerTexel;
}

// Smallest caster silhouette still worth rasterizing, in cascade-map texels.
// An orthographic shadow map projects an occluder's cross-section 1:1 onto the
// map plane, so a caster whose bounding-sphere radius is a fraction of one
// texel can darken at most that same fraction of a texel — and the PCF disk
// radii (lighting.js SHADOW_RADII, >= 1.25 texels on every tier) then spread
// it below perceivable contrast. 0.75 keeps every caster at or above roughly
// 1.5 texels across, safely inside "the map can resolve this shadow".
export const SHADOW_CASTER_MIN_TEXELS = 0.75;

/**
 * Minimum per-instance caster radius (meters) that a cascade map can still
 * resolve as a visible shadow. Instances below it are useless work in THAT
 * cascade only — the same instance stays a full caster in tighter cascades.
 * Returns 0 for a degenerate/unknown texel size so callers keep every caster.
 * @param {number} worldUnitsPerTexel cascade texel edge length (meters)
 * @param {number} [minTexels] resolvability floor in texels
 * @returns {number} radius floor in meters (0 = do not cull by size)
 */
export function subtexelCullRadius(worldUnitsPerTexel,
  minTexels = SHADOW_CASTER_MIN_TEXELS) {
  if (!(worldUnitsPerTexel > 0)) return 0;
  return worldUnitsPerTexel * minTexels;
}
