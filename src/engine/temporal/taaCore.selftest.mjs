import assert from 'node:assert/strict';
import {
  JITTER_PHASE_COUNT,
  TAA_BLEND_K,
  TAA_MOTION_REJECT_TEXELS,
  accumulatePixel,
  clampToBounds,
  focalPixels,
  ghostExtentPx,
  halton,
  jitterPhase,
  jitterPhaseY,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  motionPxPerFrame,
  neighborhoodBounds,
  reprojectUv,
  resolveBlendK,
  rotationalShakePx,
  simulateEdgeAccumulation,
  transform4,
} from './taaCore.js';

const FOV_ARCADE = 60;   // cameraRig.js BASE_FOV_DEG
const FOV_X8 = 60 / 8;   // sniper zoom x8: fov = 60/zoom
const H = 1080;
const FPS = 60;

// --- T1: Halton jitter sequence — deterministic, in-range, low-discrepancy --
assert.equal(halton(1, 2), 0.5);
assert.equal(halton(2, 2), 0.25);
assert.equal(halton(3, 2), 0.75);
assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-15);
assert.ok(Math.abs(halton(2, 3) - 2 / 3) < 1e-15);

for (let i = 0; i < 64; i++) {
  const jx = jitterPhase(i);
  const jy = jitterPhaseY(i);
  assert.ok(jx > -0.5 && jx < 0.5, `phase ${i} x out of range`);
  assert.ok(jy > -0.5 && jy < 0.5, `phase ${i} y out of range`);
}
{
  // The first 16 phases must spread over the texel: >= 12 distinct cells of a
  // 4x4 subdivision (a clustered sequence would leave sub-pixel edges unsampled).
  const cells = new Set();
  for (let i = 0; i < 16; i++) {
    const cx = Math.min(3, Math.floor((jitterPhase(i) + 0.5) * 4));
    const cy = Math.min(3, Math.floor((jitterPhaseY(i) + 0.5) * 4));
    cells.add(`${cx},${cy}`);
  }
  assert.ok(cells.size >= 12, `jitter phases cluster: only ${cells.size}/16 cells`);
}
assert.equal(JITTER_PHASE_COUNT, 8);

// --- T2: camera-only reprojection is EXACT for world-static geometry --------
{
  const aspect = 16 / 9;
  const near = 0.5;
  const far = 2000;
  const projA = mat4Perspective((FOV_ARCADE * Math.PI) / 180, aspect, near, far);
  const viewA = mat4View(0, 2.5, 0, 0, 0); // arcade pivot height
  const vpA = mat4Multiply(projA, viewA);
  const invVpA = mat4Invert(vpA);

  // A world-static point (terrain/prop/foliage class): project to (uv, depth),
  // then recover its previous-frame UV after the camera has moved + rotated.
  const w = transform4(vpA, 3, 1, -40, 1);
  const uA = w[0] / w[3] * 0.5 + 0.5;
  const vA = w[1] / w[3] * 0.5 + 0.5;
  const depthA = w[2] / w[3] * 0.5 + 0.5;

  const projB = mat4Perspective((FOV_ARCADE * Math.PI) / 180, aspect, near, far);
  const viewB = mat4View(1.2, 2.7, 0.8, 0.31, -0.12); // drove + looked around
  const vpB = mat4Multiply(projB, viewB);

  const r = reprojectUv(invVpA, vpB, uA, vA, depthA);
  assert.ok(r.valid, 'world-static point must reproject on-screen');
  const wb = transform4(vpB, 3, 1, -40, 1);
  const uExpected = wb[0] / wb[3] * 0.5 + 0.5;
  const vExpected = wb[1] / wb[3] * 0.5 + 0.5;
  assert.ok(Math.abs(r.u - uExpected) < 1e-12, `u drift ${Math.abs(r.u - uExpected)}`);
  assert.ok(Math.abs(r.v - vExpected) < 1e-12, `v drift ${Math.abs(r.v - vExpected)}`);

  // Identity: same camera reprojects onto itself.
  const rSame = reprojectUv(invVpA, vpA, uA, vA, depthA);
  assert.ok(Math.abs(rSame.u - uA) < 1e-12 && Math.abs(rSame.v - vA) < 1e-12);

  // Off-screen history (turned away) must invalidate, not wrap.
  const viewC = mat4View(0, 2.5, 0, Math.PI, 0);
  const rOff = reprojectUv(invVpA, mat4Multiply(projB, viewC), uA, vA, depthA);
  assert.equal(rOff.valid, false, 'history behind the camera must be rejected');
}

// --- T3: foliage-class shimmer -> stable reconstruction ----------------------
{
  // Static cutout edge, camera panning 0.02 px/frame: a surface point slides
  // across the pixel lattice. STATUS QUO (blendK 1 = no history) displays the
  // raw binary rasterizer decision — a square wave as the point crosses the
  // unjittered sample center: the shimmer/crawl. Jittered world-anchored
  // accumulation converges to the point's coverage fraction instead.
  const pan = { speedPxPerFrame: 0.02, frames: 160 };
  const statusQuo = simulateEdgeAccumulation({ ...pan, useJitter: false, blendK: 1 });
  const taa = simulateEdgeAccumulation({ ...pan, useJitter: true });

  // Flicker metric: frame-to-frame deltas of the displayed value over the
  // settled tail. (Raw value-std would also count the LEGITIMATE coverage ramp
  // as the point crosses pixels — the perceptual offender is flip amplitude.)
  const flicker = (values) => {
    const d = [];
    for (let i = Math.max(1, values.length - 48); i < values.length; i++) {
      d.push(Math.abs(values[i] - values[i - 1]));
    }
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) * (b - mean), 0) / d.length);
    return { sd, max: Math.max(...d) };
  };
  const fq = flicker(statusQuo.values);
  const ft = flicker(taa.values);
  assert.ok(fq.sd > 0.1 && fq.max > 0.9,
    `status quo must show hard binary flips, got sd ${fq.sd.toFixed(3)} max ${fq.max.toFixed(2)}`);
  assert.ok(ft.sd < 0.08,
    `accumulated output should be temporally stable, got sd ${ft.sd.toFixed(3)}`);
  assert.ok(ft.max < 0.12,
    `accumulated worst-case step ${ft.max.toFixed(3)} must stay far below a full flip`);
  console.log(`edge-point flicker |delta| sd/max: status quo ${fq.sd.toFixed(3)}/${fq.max.toFixed(2)} -> TAA ${ft.sd.toFixed(3)}/${ft.max.toFixed(3)}`);

  // Static-camera accuracy: converged value approaches true coverage.
  const staticTaa = simulateEdgeAccumulation({
    frames: 96, speedPxPerFrame: 0, startFrac: 0.37, useJitter: true,
  });
  const err = Math.abs(staticTaa.mean - 0.37);
  assert.ok(err < 0.05, `coverage reconstruction error ${err.toFixed(3)} too large`);
  console.log(`static-edge coverage reconstruction: ${(staticTaa.mean).toFixed(3)} vs truth 0.370`);

  // Sanity: without jitter the same static edge stays binary-wrong forever.
  const staticNo = simulateEdgeAccumulation({
    frames: 96, speedPxPerFrame: 0, startFrac: 0.37, useJitter: false, blendK: 1,
  });
  assert.ok(Math.abs(staticNo.mean - 0.37) > 0.3,
    'unjittered chain must keep the half-texel error this fixes');
}

// --- T4: rejection bounds — ghosts cannot exceed local contrast --------------
{
  // Stale bright history (old fireball), current frame is dark grass.
  const taps = [[0.10, 0.12, 0.08], [0.11, 0.13, 0.09], [0.09, 0.11, 0.07],
    [0.12, 0.14, 0.10], [0.10, 0.12, 0.08]];
  const bounds = neighborhoodBounds(taps);
  const out = accumulatePixel([0.10, 0.12, 0.08], [2.0, 2.0, 2.0], bounds, TAA_BLEND_K);
  for (let i = 0; i < 3; i++) {
    assert.ok(out[i] <= bounds.mx[i] + 1e-12,
      'rectified output must never exceed the current frame local max');
    assert.ok(out[i] >= bounds.mn[i] - 1e-12,
      'rectified output must never fall below the current frame local min');
  }
  // Unclamped, the stale 2.0 would survive at 1.9 — a real ghost above contrast.
  assert.ok(out[0] < 0.13, `ghost not suppressed: ${out[0]}`);

  // Disocclusion / resize / zoom-step: fresh frame verbatim.
  assert.equal(resolveBlendK({ seeded: true }), 1);
  assert.equal(resolveBlendK({ historyOffscreen: true }), 1);

  // Velocity gate: trauma-shake-scale motion rejects history outright.
  assert.equal(resolveBlendK({ motionTexels: 40 }), 1);
  assert.equal(resolveBlendK({ motionTexels: TAA_MOTION_REJECT_TEXELS }), 1);
  assert.equal(resolveBlendK({ motionTexels: 0.5 }), TAA_BLEND_K,
    'slow pans keep the long-exposure accumulation');
}

// --- T5: motion evidence — px/frame numbers that drive the design ------------
{
  // Focal lengths.
  const fArcade = focalPixels(FOV_ARCADE, H);
  const fX8 = focalPixels(FOV_X8, H);
  assert.ok(Math.abs(fArcade - 935) < 2, `arcade focal ${fArcade.toFixed(1)}`);
  assert.ok(Math.abs(fX8 - 8233) < 20, `x8 focal ${fX8.toFixed(1)}`);

  // Tank crossing (topSpeedKmh 57-75 => ~16-21 m/s) at engagement ranges.
  const close = motionPxPerFrame(20, 30, FOV_ARCADE, H, FPS);
  const mid = motionPxPerFrame(20, 150, FOV_ARCADE, H, FPS);
  const far = motionPxPerFrame(20, 300, FOV_ARCADE, H, FPS);
  assert.ok(close > 9 && close < 12, `30 m crossing ${close.toFixed(1)} px/frame`);
  assert.ok(mid > 1.5 && mid < 2.5, `150 m crossing ${mid.toFixed(1)} px/frame`);
  assert.ok(far < 1.5, `300 m crossing ${far.toFixed(1)} px/frame`);
  console.log(`vehicle crossing px/frame @1080p arcade: 30 m ${close.toFixed(1)}, 150 m ${mid.toFixed(1)}, 300 m ${far.toFixed(1)}`);

  // Without per-object motion vectors the smear trail behind a 30 m crossing
  // reaches ghostExtentPx px at 10% contrast — the number that forces either
  // velocity-gated rejection or a vehicle MV prepass.
  const trail = ghostExtentPx(close, TAA_BLEND_K);
  assert.ok(trail > 100, `expected a disqualifying raw trail, got ${trail.toFixed(0)} px`);
  console.log(`raw no-MV trail @30 m, k=${TAA_BLEND_K}: ~${trail.toFixed(0)} px to 10% contrast (unacceptable => gate or MVs required)`);

  // Trauma shake (cameraRig.js SHAKE_AMP_XY 0.045, SHAKE_FREQ 11; a hit lands
  // trauma ~0.35 => amp 0.045*0.35^1.6): at x8 this is tens of px in ONE frame.
  const shakeX8 = rotationalShakePx(0.045 * Math.pow(0.35, 1.6), 11, FPS, FOV_X8, H);
  const shakeArcade = rotationalShakePx(0.045 * Math.pow(0.35, 1.6), 11, FPS, FOV_ARCADE, H);
  assert.ok(shakeX8 > TAA_MOTION_REJECT_TEXELS * 5,
    `x8 shake ${shakeX8.toFixed(0)} px/frame must trip the reject gate`);
  assert.ok(shakeArcade > TAA_MOTION_REJECT_TEXELS,
    `arcade shake ${shakeArcade.toFixed(1)} px/frame must trip the reject gate`);
  console.log(`trauma-0.35 shake px/frame: arcade ${shakeArcade.toFixed(1)}, x8 ${shakeX8.toFixed(0)} (both rejected => no smear during hits)`);

  // Slow scoped pan (sensitivity divided by zoom): stays under the gate, so
  // the x8 sight picture keeps full accumulation while the player aims.
  const slowPanX8 = motionPxPerFrame(0, 1, FOV_X8, H, FPS); // placeholder guard
  assert.equal(slowPanX8, 0);
  const aimPanX8 = (0.05 / FPS) * fX8; // 0.05 rad/s deliberate pan
  assert.ok(aimPanX8 > TAA_MOTION_REJECT_TEXELS,
    'even deliberate x8 pans exceed the texel gate — reprojection (not the gate) must own global rotation');
}

// --- T6: HDR glint strobing is averaged below the bloom-strobe band ----------
{
  // Sub-pixel specular pops every other frame (the aa-r1 firefly case: raw
  // values alternate 3.0 / 0.2, so BLOOM_THRESHOLD 1.78 is crossed on every
  // pop and bloom halos pulse). Accumulation settles on a period-2 orbit.
  let h = 0;
  let hHi = 0;
  let hLo = 0;
  for (let n = 0; n < 400; n++) {
    const v = n % 2 === 0 ? 3.0 : 0.2;
    h += (v - h) * TAA_BLEND_K;
    if (n % 2 === 0) hHi = h; else hLo = h;
  }
  const cycleMean = (hHi + hLo) / 2;
  assert.ok(Math.abs(cycleMean - 1.6) < 0.01,
    `cycle-mean display ${(cycleMean).toFixed(3)} must equal the true mean 1.6`);
  // The win: the DISPLAYED peak never reaches the bloom threshold again, so
  // the halo stops pulsing (raw path peaked at 3.0, far above 1.78).
  assert.ok(hHi < 1.78,
    `displayed glint peak ${hHi.toFixed(3)} must stay under BLOOM_THRESHOLD 1.78`);
  const ripple = hHi - hLo;
  assert.ok(ripple < 0.16, `ripple ${ripple.toFixed(3)} too visible`);
  console.log(`50%-duty HDR glint: displays ${hLo.toFixed(3)}..${hHi.toFixed(3)} (mean ${cycleMean.toFixed(3)}, raw peak 3.0) — no bloom-threshold crossing`);
}

console.log('taaCore self-test passed');
