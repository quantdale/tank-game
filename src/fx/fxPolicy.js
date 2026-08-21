/**
 * fxPolicy.js — pure combat-FX budget/LOD policy (DOM-free, Node-runnable).
 *
 * W14 graphics campaign: the numeric policy for effects.js load control lives
 * here so it is unit-testable without WebGL and cannot drift silently. All
 * inputs are presentation-side (camera distance, pool occupancy, clock) —
 * nothing here touches simulation truth, and every function is deterministic.
 *
 * Philosophy mirrors src/net/presentationEventQueue.js: durable/critical
 * layers (lights, decals, wreck swaps) always apply; expensive cosmetic
 * volume is admitted against a per-frame budget and thinned by measured pool
 * pressure instead of dropping whole features.
 */

// --- Effect LOD (camera-distance bands) -------------------------------------
// Beyond FULL every subpixel sub-emitter (thin streaks, faint wisps, tiny
// chips) is dropped; beyond REDUCED only the primary readable masses (cores,
// jets, big billows, lights, tracers) remain. Sizes still get the existing
// distBoost compensation, so band edges are invisible in motion.
export const FX_LOD_FULL_M = 150;
export const FX_LOD_REDUCED_M = 340;
// LOD arms only after this much battle-clock time: boot/garage warm passes and
// every staged screenshot composition (resetAll() restarts the clock) always
// run full fidelity, keeping warm coverage and golden captures exact.
export const FX_LOD_WARM_S = 1.0;

/**
 * 0 = full detail, 1 = minus subpixel detail, 2 = primary masses only.
 * @param {number} distM camera distance to the effect (meters)
 * @returns {0|1|2}
 */
export function fxLodLevel(distM) {
  if (!(distM >= 0)) return 0; // NaN/negative guards to full detail
  if (distM < FX_LOD_FULL_M) return 0;
  if (distM < FX_LOD_REDUCED_M) return 1;
  return 2;
}

// --- Heavy-beat admission (per rendered frame) -------------------------------
// Live multi-kill batches (solo play bypasses the network presentation queue)
// may deliver several destruction spectacles in one tick. Two full beats per
// frame keep a hero kill intact; further beats defer by one tick via the
// existing clock-driven timer queue, preserving chronology and outcome.
export const FX_HEAVY_CREDITS_PER_TICK = 2;

// --- Particle program census (WA2 battle-open warm cost) ----------------------
// The pooled particle system creates one material per pool, but three r185
// caches WebGLPrograms by SHADER SOURCE + parameter class — never by uniform
// values or texture bindings — so families grouped below link exactly ONE
// program regardless of how many materials reference it. This is the audit
// table for the warm-stage shader-first-use storm: 9 pool materials collapse
// to 7 unique programs, and pairs that differ only by uniforms (smoke/dust,
// fire/flash) already share for free. Guarded by fxPolicy.selftest.mjs so a
// future pool or fragment variant must land here deliberately instead of
// silently growing the battle-open link bill.
export const FX_PARTICLE_PROGRAM_GROUPS = Object.freeze({
  puff_normal:   Object.freeze(['smoke', 'dust']),   // PUFF_VERT + PUFF_FRAG_NORMAL
  puff_additive: Object.freeze(['fire', 'flash']),   // PUFF_VERT + PUFF_FRAG_ADDITIVE
  puff_billow:   Object.freeze(['billow']),          // PUFF_VERT + PUFF_FRAG_BILLOW
  puff_prop:     Object.freeze(['psmoke']),          // PUFF_VERT + PUFF_FRAG_PROP
  jet:           Object.freeze(['jet']),             // JET_VERT + JET_FRAG
  streak:        Object.freeze(['sparks']),          // STREAK_VERT + STREAK_FRAG
  debris:        Object.freeze(['debris']),          // DEBRIS_VERT + DEBRIS_FRAG
});

// --- Pool-pressure response ---------------------------------------------------
// Measured occupancy fractions (see particles.js poolOccupancy) throttle the
// continuous emitters BEFORE the ring buffer starts overwriting live puffs.
// Column: 3-4 puffs/tick nominal, 2 under >90% smoke pressure, and the extra
// near-black core puff is dropped only in the >95% extreme.
export function fxColumnPuffsPerTick(stage, smokeOccFrac) {
  const base = stage > 0.85 ? 4 : 3;
  if (smokeOccFrac > 0.95) return 1;
  if (smokeOccFrac > 0.9) return 2;
  return base;
}

/** True when the dust pool has room for another wake veil. */
export function fxDustAdmitted(dustOccFrac) {
  return dustOccFrac <= 0.92;
}

// --- Tracer screen-space readability floor ------------------------------------
// A 0.10-0.16 m ribbon is sub-pixel past ~200 m and shimmers out. The tracer
// vertex shader widens each ribbon to at least this many PIXELS of half-width
// (energy-conserved — see fxTracerEnergyK) so distant shots stay readable.
export const FX_TRACER_MIN_HALF_PX = 0.75;
/** Absolute ceiling (m) so fog-range ribbons cannot balloon. */
export const FX_TRACER_MAX_HALF_M = 2.0;

/**
 * World-space size of one framebuffer pixel at `distM` for a perspective
 * camera (pure math split out of the shader for testing).
 * @param {number} tanHalfFov tan(fov/2)
 * @param {number} viewportH drawing-buffer height in pixels
 * @param {number} distM distance to the ribbon (m)
 * @returns {number} meters per pixel
 */
export function fxPixelWorldSize(tanHalfFov, viewportH, distM) {
  const h = viewportH > 0 ? viewportH : 1;
  return (2 * tanHalfFov * distM) / h;
}

/**
 * Brightness conservation when the readability floor widens a ribbon past its
 * physical width: dim toward (phys/final)^0.45 so total emitted light grows
 * sub-linearly instead of stacking a fat full-bright beam at range.
 * @param {number} physHalf physical half-width (m)
 * @param {number} finalHalf half-width actually drawn (m, >= physHalf)
 * @returns {number} 0..1 brightness multiplier
 */
export function fxTracerEnergyK(physHalf, finalHalf) {
  if (!(finalHalf > 0)) return 1;
  const r = physHalf / finalHalf;
  if (r >= 1) return 1;
  return Math.pow(Math.max(r, 0), 0.45);
}

// --- SA-13 combat VFX art ceiling: turbulent media advection ------------------
// Puff media flew pure ballistic arcs (velocity + drag + gravity), so smoke
// columns, dust palls and propellant clouds evolved as rigid fans of
// straight-line puffs. Every puff card now also runs a seeded sinusoidal
// curl-walk (PUFF_VERT in particles.js): phase-offset sines drift the card's
// world position while it ages, so columns shear, kink and curl like media.
// Amplitude is a FRACTION of the card's CURRENT world size per family below —
// near/far framing, caliber scaling and distBoost stay proportionate, and
// pinned precision elements (flash cores) get exactly 0. Deterministic: the
// phase reuses the existing per-particle rotation attribute, so no extra RNG
// draws and frozen captures stay byte-stable. Zero perf cost: same shared
// PUFF_VERT source for all six puff families (program census unchanged), no
// new attributes, a handful of ALU ops per vertex.
export const FX_PUFF_WOBBLE = Object.freeze({
  smoke: 0.16,   // columns/palls: the headline churn read
  dust: 0.14,    // wake veils + HE dust drift
  psmoke: 0.09,  // muzzle propellant mass: gentle boil, keeps its torn shape
  billow: 0.05,  // fireball body: silhouette must stay readable
  fire: 0.03,    // additive flame cards: near-pinned
  flash: 0.0,    // muzzle cores are precision-pinned to the tip — never drift
});

/** Shared angular frequency (rad/s) of the wobble walk. */
export const FX_WOBBLE_FREQ = 1.35;

/**
 * Wobble amplitude fraction for a puff family (0 for unknown/precision).
 * @param {'smoke'|'dust'|'psmoke'|'billow'|'fire'|'flash'} family
 * @returns {number} 0..~0.35 fraction of current card size
 */
export function fxPuffWobble(family) {
  return Object.prototype.hasOwnProperty.call(FX_PUFF_WOBBLE, family)
    ? FX_PUFF_WOBBLE[family]
    : 0;
}

// --- SA-13: debris ground bounce ----------------------------------------------
// Wreckage hit the ground and SNAPPED into a slide (a bare position clamp),
// so heavy chunks read as magnets sticking to the terrain. One analytic damped
// rebound (integrated in DEBRIS_VERT): the vertical impact velocity reflects
// at `restitution`, horizontal velocity keeps `tangentKeep`, and impacts
// slower than `minSpeed` (m/s) just settle — no visible pop for pebbles.
// Purely GPU-side algebra on the existing drag trajectory; the CPU clod-trail
// sampling in effects.js terminates AT ground contact, so trails and bouncing
// chunks never disagree. Constants are .toFixed()-interpolated into the
// shader and guarded below — no hand-copied drift.
export const FX_DEBRIS_BOUNCE = Object.freeze({
  restitution: 0.34,   // vertical keep (one bounce only, then the slide clamp)
  tangentKeep: 0.58,   // horizontal keep through the impact
  minSpeed: 2.2,       // below this impact speed chunks settle in place
});
