/**
 * taaCore.js — pure accumulation/rejection math for temporal anti-aliasing.
 *
 * W13 TEMPORAL STABILITY prototype. NOTHING in src/engine/temporal/ may be
 * imported by production code yet — this module exists so the exact math a
 * future TAA pass would run (jitter phases, camera-only reprojection,
 * neighborhood rectification, blend/reject policy) is Node-testable and can
 * back a GO/NO-GO decision with numbers instead of adjectives. See
 * FEASIBILITY.md in this directory for the renderer mapping and verdict.
 *
 * Design notes:
 *  - Zero imports, zero DOM/WebGL: mirrors renderScalePolicy.js (the existing
 *    "pure policy + Node selftest" pattern in this engine).
 *  - Matrices are column-major Float64Array(16), the same layout three.js and
 *    the GLSL uniforms in post.js' ao-boil r3 EMA shader use, so the math here
 *    transfers 1:1 into a ShaderMaterial later.
 *  - Every matrix routine takes an optional `out` buffer: a production pass
 *    must reuse scratch state per frame (repo invariant: no per-frame
 *    allocation in hot loops).
 *  - Fully deterministic: the jitter sequence is Halton radical inversion, no
 *    Math.random, no wall clock.
 */

// ---------------------------------------------------------------------------
// Sub-pixel jitter (Halton (2,3), the industry-standard TAA phase sequence)
// ---------------------------------------------------------------------------

/** Radical inverse of `index` in base `base` (van der Corput). */
export function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * Jitter phase `index` mapped to signed texel offsets in (-0.5, 0.5).
 * Phase 0 is NOT special-cased to zero: a jittered rasterizer wants every
 * frame displaced, and Halton's first terms already sit near the lattice
 * center. Add the offset to the sample position in the projection matrix.
 */
export function jitterPhase(index) {
  return halton(index + 1, 2) - 0.5;
}

export function jitterPhaseY(index) {
  return halton(index + 1, 3) - 0.5;
}

/** Default phase count: 8 covers the texel well while keeping history short. */
export const JITTER_PHASE_COUNT = 8;

// ---------------------------------------------------------------------------
// Minimal column-major mat4 (only what reprojection needs)
// ---------------------------------------------------------------------------

export function mat4Identity(out = new Float64Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b (column-major, out may alias neither input). */
export function mat4Multiply(a, b, out = new Float64Array(16)) {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

/** OpenGL-style perspective matrix, identical to three.js makePerspective. */
export function mat4Perspective(fovYRad, aspect, near, far, out = new Float64Array(16)) {
  const f = 1 / Math.tan(fovYRad / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * World-to-view matrix for a three.js-convention camera at (px,py,pz) with
 * yaw/pitch radians: yaw 0 / pitch 0 looks down -Z, +yaw turns toward -X,
 * +pitch looks up. Matches the rig's aim-yaw/pitch pair semantics.
 */
export function mat4View(px, py, pz, yaw, pitch, out = new Float64Array(16)) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const fx = -sy * cp, fy = sp, fz = -cy * cp; // forward
  const rx = cy, ry = 0, rz = -sy;             // right
  // up = right x forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  out[0] = rx; out[4] = ry; out[8] = rz;  out[12] = -(rx * px + ry * py + rz * pz);
  out[1] = ux; out[5] = uy; out[9] = uz;  out[13] = -(ux * px + uy * py + uz * pz);
  out[2] = -fx; out[6] = -fy; out[10] = -fz; out[14] = fx * px + fy * py + fz * pz;
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}

/** General 4x4 inverse (gl-matrix algorithm). Returns null when singular. */
export function mat4Invert(m, out = new Float64Array(16)) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Transform (x,y,z,w) by m; returns into `out` (length >= 4). */
export function transform4(m, x, y, z, w, out = new Float64Array(4)) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

// ---------------------------------------------------------------------------
// Camera-only reprojection (the ao-boil r3 scheme, generalized to any pass)
// ---------------------------------------------------------------------------

/**
 * Reproject pixel (u,v,depth01) rendered with `invViewProj` into the previous
 * frame's screen space given `prevViewProj`. Exactly the GLSL in post.js'
 * GTAO EMA shader (`uInvViewProj * vec4(uv*2-1, depth*2-1, 1)` then
 * `uPrevViewProj * world`), hoisted into testable JS.
 *
 * Exact for world-static geometry (terrain, buildings, props, foliage cards,
 * wrecks) under ANY camera motion. Moving vehicles need per-object motion
 * vectors — see ghostExtentPx() for the quantified cost of skipping them.
 *
 * @returns {{valid: boolean, u: number, v: number}} prev-frame UV; valid is
 *   false when the point projects behind the camera or lands off-screen
 *   (disocclusion / history miss -> caller must take the fresh sample).
 */
export function reprojectUv(invViewProj, prevViewProj, u, v, depth01) {
  const nx = u * 2 - 1;
  const ny = v * 2 - 1;
  const nz = depth01 * 2 - 1;
  const p = transform4(
    invViewProj, nx, ny, nz, 1, _reprojectScratch);
  if (Math.abs(p[3]) < 1e-12) return { valid: false, u: 0, v: 0 };
  const wx = p[0] / p[3];
  const wy = p[1] / p[3];
  const wz = p[2] / p[3];
  const c = transform4(prevViewProj, wx, wy, wz, 1, _reprojectScratch2);
  if (c[3] <= 1e-8) return { valid: false, u: 0, v: 0 };
  const pu = c[0] / c[3] * 0.5 + 0.5;
  const pv = c[1] / c[3] * 0.5 + 0.5;
  if (pu < 0 || pu > 1 || pv < 0 || pv > 1) return { valid: false, u: pu, v: pv };
  return { valid: true, u: pu, v: pv };
}
const _reprojectScratch = new Float64Array(4);
const _reprojectScratch2 = new Float64Array(4);

// ---------------------------------------------------------------------------
// History rejection + accumulation (neighborhood rectification, velocity gate)
// ---------------------------------------------------------------------------

/** Fixed share of the fresh frame in the blend, mirroring ao-boil r3's k. */
export const TAA_BLEND_K = 0.1;

/**
 * History is rejected outright when its reprojection sample moved more than
 * this many texels between the stored history location and this frame's
 * reprojected location — the cheap proxy for "this history is not my past".
 * Trauma shake bursts and sniper zoom steps exceed this by 5-70x (see
 * rotationalShakePx), so they take the fresh frame instead of smearing.
 */
export const TAA_MOTION_REJECT_TEXELS = 3;

/**
 * Blend weight for one accumulation step.
 *  - seeded / off-screen history -> 1 (fresh frame verbatim; also used after
 *    governor resizes, preset switches, zoom steps, >250 ms gaps);
 *  - reprojected motion beyond TAA_MOTION_REJECT_TEXELS -> 1 (reject);
 *  - otherwise the fixed blend k (~90% history).
 */
export function resolveBlendK({
  seeded = false,
  historyOffscreen = false,
  motionTexels = 0,
  blendK = TAA_BLEND_K,
  motionRejectTexels = TAA_MOTION_REJECT_TEXELS,
} = {}) {
  if (seeded || historyOffscreen) return 1;
  if (motionTexels >= motionRejectTexels) return 1;
  return blendK;
}

/**
 * AABB of a 3x3 (or 5-tap cross) neighborhood, `taps` = iterable of
 * [r,g,b] triples INCLUDING the center. Production shader: 4 texture taps +
 * center, exactly like the AO EMA shader's rectification.
 */
export function neighborhoodBounds(taps) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const t of taps) {
    for (let i = 0; i < 3; i++) {
      if (t[i] < mn[i]) mn[i] = t[i];
      if (t[i] > mx[i]) mx[i] = t[i];
    }
  }
  return { mn, mx };
}

/** Clamp `c` into [mn,mx] component-wise (standard TAA rectification). */
export function clampToBounds(c, mn, mx) {
  return [
    Math.min(Math.max(c[0], mn[0]), mx[0]),
    Math.min(Math.max(c[1], mn[1]), mx[1]),
    Math.min(Math.max(c[2], mn[2]), mx[2]),
  ];
}

/**
 * One accumulation step for one pixel: rectified history blended toward the
 * fresh frame by k. Returns the new history/output value. This is the whole
 * per-pixel TAA contract: output can NEVER leave the current frame's local
 * contrast envelope, so ghosts are contrast-bounded by construction.
 */
export function accumulatePixel(current, historySample, bounds, k) {
  const hist = clampToBounds(historySample, bounds.mn, bounds.mx);
  return [
    hist[0] + (current[0] - hist[0]) * k,
    hist[1] + (current[1] - hist[1]) * k,
    hist[2] + (current[2] - hist[2]) * k,
  ];
}

// ---------------------------------------------------------------------------
// Motion analysis helpers (evidence math for the feasibility verdict)
// ---------------------------------------------------------------------------

/** Pixels per radian of view rotation at screen `heightPx`, fovY degrees. */
export function focalPixels(fovYDeg, heightPx) {
  return heightPx / (2 * Math.tan((fovYDeg * Math.PI) / 180 / 2));
}

/**
 * Lateral screen motion of an object moving `speedMps` at `distanceM`,
 * in px/frame. Tank crossing at 20 m/s seen from 30 m in the arcade FOV is
 * ~10 px/frame; from 200 m ~1.6 px/frame.
 */
export function motionPxPerFrame(speedMps, distanceM, fovYDeg, heightPx, fps) {
  const radPerFrame = speedMps / Math.max(distanceM, 1e-6) / fps;
  return radPerFrame * focalPixels(fovYDeg, heightPx);
}

/**
 * Peak px/frame of the rig's trauma shake (cameraRig.js: noise-driven
 * rotational shake, amplitude `ampRad` at `freqHz`; derivative of a sine-like
 * oscillation peaks at amp*2*pi*freq). Quantifies why history must be
 * velocity-gated: a 0.35-trauma hit at x8 moves the sight picture ~75 px in
 * ONE frame.
 */
export function rotationalShakePx(ampRad, freqHz, fps, fovYDeg, heightPx) {
  const radPerFramePeak = (ampRad * 2 * Math.PI * freqHz) / fps;
  return radPerFramePeak * focalPixels(fovYDeg, heightPx);
}

/**
 * Spatial length (px) of the smear trail behind a mover when history is
 * sampled WITHOUT per-object motion vectors: the stale-history weight decays
 * geometrically (1-k)^n, so the trail reaches `visibilityFloor` of its initial
 * contrast after ~ln(floor)/ln(1-k) frames of motion. Bounded in CONTRAST by
 * rectification, unbounded in EXTENT along the motion direction — this is the
 * number that decides whether vehicles need motion vectors.
 */
export function ghostExtentPx(speedPxPerFrame, k, visibilityFloor = 0.1) {
  return speedPxPerFrame * Math.log(visibilityFloor) / Math.log(1 - k);
}

// ---------------------------------------------------------------------------
// Convergence simulation (deterministic stand-in for a jittered rasterizer)
// ---------------------------------------------------------------------------

/**
 * Simulate TAA over ONE world point sitting on a vertical alpha-cutout edge,
 * while the camera pans at `speedPxPerFrame` (the point slides across the
 * pixel lattice at that rate, wrapping pixel boundaries — history follows the
 * WORLD POINT via reprojection, which is why wrapping is legitimate here).
 * Each frame the rasterizer emits a BINARY coverage decision for the pixel
 * containing the point, tested at the pixel center plus the frame's jitter
 * phase — the minimal faithful model of 1-sample/pixel rasterization of a
 * cutout edge (exactly the alpha-tested foliage case on tiers where
 * msaaSamples is 0).
 *
 * `useJitter=false` reproduces today's chain: the binary decision flips only
 * when the point crosses the unjittered sample center — a square wave, i.e.
 * the shimmer/crawl. With jitter the decision threshold varies per frame and
 * the accumulation converges to the point's coverage fraction.
 *
 * @returns {{values: number[], mean: number}} per-frame OUTPUT values (what
 *   the screen shows for that surface point) and their mean over the run.
 */
export function simulateEdgeAccumulation({
  frames = 64,
  speedPxPerFrame = 0.02,
  startFrac = 0.3,
  useJitter = true,
  blendK = TAA_BLEND_K,
  phaseCount = JITTER_PHASE_COUNT,
} = {}) {
  const values = new Array(frames);
  let h = 0;
  let f = startFrac;
  for (let n = 0; n < frames; n++) {
    const j = useJitter ? jitterPhase(n % phaseCount) : 0;
    const sample = f > 0.5 + j ? 1 : 0; // interior left of the edge
    // Seed frame takes the fresh sample verbatim (resolveBlendK contract).
    const k = n === 0 ? 1 : blendK;
    h += (sample - h) * k;
    values[n] = h;
    f += speedPxPerFrame;
    if (f >= 1) f -= 1; // crossed into the next pixel; history follows the point
  }
  return { values, mean: values.reduce((a, b) => a + b, 0) / frames };
}
