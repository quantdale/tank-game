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

/**
 * WA2 preset lever: per-preset override of the sub-texel caster floor
 * (quality.js `shadowCasterMinTexels`). A missing key falls back to the
 * shipped constant, so presets predating the lever keep exact wave-1
 * behavior. The value is validated (finite, > 0) so a preset typo fails
 * safe to the tuned default instead of silently disabling or widening the
 * cut; 0 is deliberately NOT accepted as "disable" — omit the key instead.
 * @param {{shadowCasterMinTexels?:number}} [preset] active quality preset
 * @returns {number} resolvability floor in cascade-map texels
 */
export function resolveCasterMinTexels(preset) {
  const v = preset?.shadowCasterMinTexels;
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? v
    : SHADOW_CASTER_MIN_TEXELS;
}
