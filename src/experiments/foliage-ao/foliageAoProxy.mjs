// src/experiments/foliage-ao/foliageAoProxy.mjs
// W3 foliage-shimmer / GTAO-interaction prototype (research task — NOT wired
// into the game). Pure-node model of the mechanism behind "shadows under
// trees flash while driving / while parked":
//
//  1. Vegetation wind hooks (src/world/vegetation.js) displace alpha-cutout
//     foliage vertices every frame — `uWindTime += dt` runs unconditionally,
//     with no distance falloff.
//  2. GTAO consumes the SHARED scene depth directly (post.js feeds
//     SceneAAPass' DepthTexture via gtao.setGBuffer; the old override-prepass
//     that ignored alphaTest is gone), so every cutout flip rewrites the
//     occluder field GTAO integrates.
//  3. The AO temporal filter blends with k=0.15 only while the CAMERA moves;
//     once the camera is still it resolves k=1.0 — valid for world-static
//     scenes, wrong for wind-animated occluders, which then boil at full
//     amplitude on a parked camera.
//
// This module models one ground pixel's occluder field plus the exact
// rectify+blend math of the post.js EMA shader so the proposed patches
// (always-blend k, distance-frozen wind) can be validated without a browser.
// Deterministic: seeded mulberry32, no Math.random, no wall-clock time.

/**
 * Same PRNG the world modules use (src/world/vegetation.js).
 * @param {number} a seed
 * @returns {() => number} deterministic 0..1 stream
 */
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** GLSL smoothstep twin. */
export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Proposed Patch B freeze curve: wind amplitude multiplier by instance
 * distance. 1 (full sway) at or below `nearM`, 0 (frozen) at or beyond
 * `farM`, GLSM-smoothstep in between — mirrors the proposed
 * `1.0 - smoothstep(near, far, d)` term in the vegetation hooks.
 */
export function windAmplitudeFactor(distM, nearM, farM) {
  return 1 - smoothstep(nearM, farM, distM);
}

/**
 * Build the occluder field seen by ONE ground pixel under a canopy:
 * K leaf-cutout cells at deterministic base offsets, each swaying with the
 * tree hook's exact harmonic frequencies (1.15 / 2.63 rad/s, 0.45 mix) and
 * an aFlex-weighted 0.14 m amplitude scale. A cell contributes occlusion
 * when its displaced position sits inside the pixel's gather disk — the same
 * binary in/out flip a half-res depth texel undergoes when a cutout edge
 * crosses it.
 *
 * @param {object} [opts]
 * @param {number} [opts.cells] cutout cells in the gather volume
 * @param {number} [opts.cellRadiusM] projected cutout radius (m)
 * @param {number} [opts.occlusionStrength] AO depth at full coverage
 * @param {number} [opts.seed] PRNG seed
 */
export function createCanopyPixel({
  cells = 96,
  cellRadiusM = 0.26,
  occlusionStrength = 0.55,
  seed = 2001,
} = {}) {
  const rng = mulberry32(seed);
  // Only the SHELL of the gather volume matters: cells deep inside always
  // occlude, cells far outside never do — the boil comes from cutout edges
  // sitting within one sub-pixel sway arc of the boundary. Concentrate the
  // bases in that annulus (the realistic churn regime).
  const bx = [], bz = [], phase = [], flex = [];
  for (let k = 0; k < cells; k++) {
    const a = rng() * Math.PI * 2;
    const r = cellRadiusM * (0.4 + 1.5 * rng());
    bx.push(Math.cos(a) * r);
    bz.push(Math.sin(a) * r);
    phase.push(rng() * Math.PI * 2);
    flex.push(0.15 + rng() * 0.30); // matches foliageCard aFlex spread
  }
  /**
   * Raw (unfiltered) AO for this pixel at wind time `t`.
   * @param {number} t wind time (s)
   * @param {number} windAmp freeze-curve multiplier 0..1
   * @param {number} [offsetM] lateral pixel offset for neighborhood taps (m)
   * @returns {number} AO in occlusionStrength..1
   */
  function rawAo(t, windAmp, offsetM = 0) {
    let occ = 0;
    for (let k = 0; k < cells; k++) {
      const amp = windAmp * 0.14 * flex[k];
      const dx = amp * (Math.sin(t * 1.15 + phase[k])
        + 0.45 * Math.sin(t * 2.63 + phase[k] * 1.7));
      const dz = amp * 0.7 * Math.cos(t * 0.97 + phase[k] * 1.3);
      const px = bx[k] + dx - offsetM;
      const pz = bz[k] + dz;
      if (px * px + pz * pz < cellRadiusM * cellRadiusM) occ++;
    }
    return 1 - occlusionStrength * (occ / cells);
  }
  return { rawAo, cells };
}

/**
 * Exact port of the post.js ao-boil EMA shader for the still-camera case
 * (prevUv == vUv): clamp history into the current frame's 5-tap
 * neighborhood envelope, then blend toward the current value with k.
 * @param {number} now current-frame AO
 * @param {number[]} neighbors current-frame 4-neighborhood AO
 * @param {number} hist reprojected history AO
 * @param {number} k blend factor toward current
 * @returns {number}
 */
export function aoHistoryFilter(now, neighbors, hist, k) {
  let mn = now, mx = now;
  for (const n of neighbors) {
    if (n < mn) mn = n;
    if (n > mx) mx = n;
  }
  const clamped = Math.min(mx, Math.max(mn, hist));
  return clamped + (now - clamped) * k;
}
