import assert from 'node:assert/strict';
import {
  JITTER_PHASE_COUNT,
  TAA_BLEND_K,
  TAA_MOTION_REJECT_TEXELS,
  accumulatePixel,
  accumulatePixelYCoCg,
  antiRingingFilter,
  applyCameraJitter,
  bicubicWeightsCatmullRom,
  calculateMotionVector,
  calculateResponsiveMask,
  clampToBounds,
  clampYCoCg,
  clipAABBYCoCg,
  compareAAApproaches,
  depthDiscontinuityCheck,
  focalPixels,
  ghostExtentPx,
  halton,
  jitterPhase,
  jitterPhaseY,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  motionPxPerFrame,
  neighborhoodBounds,
  neighborhoodBoundsYCoCg,
  neighborhoodVarianceBoundsYCoCg,
  removeCameraJitter,
  reprojectUv,
  resolveBlendK,
  rotationalShakePx,
  rgbToYCoCg,
  sampleHistoryBicubic5Tap,
  simulateEdgeAccumulation,
  simulateThinGeometryCoverage,
  transform4,
  yCoCgToRgb,
} from './taaCore.js';

const FOV_ARCADE = 60;   // cameraRig.js BASE_FOV_DEG
const FOV_X8 = 60 / 8;   // sniper zoom x8: fov = 60/zoom
const H = 1080;
const W = 1920;
const FPS = 60;

// --- T1: Halton jitter sequence & camera projection jitter manipulation ------
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
  const cells = new Set();
  for (let i = 0; i < 16; i++) {
    const cx = Math.min(3, Math.floor((jitterPhase(i) + 0.5) * 4));
    const cy = Math.min(3, Math.floor((jitterPhaseY(i) + 0.5) * 4));
    cells.add(`${cx},${cy}`);
  }
  assert.ok(cells.size >= 12, `jitter phases cluster: only ${cells.size}/16 cells`);
}
assert.equal(JITTER_PHASE_COUNT, 8);

{
  // Projection matrix jitter & unjitter roundtrip test
  const proj = mat4Perspective((FOV_ARCADE * Math.PI) / 180, 16 / 9, 0.5, 2000);
  const orig8 = proj[8];
  const orig9 = proj[9];
  const jx = jitterPhase(0);
  const jy = jitterPhaseY(0);

  const jittered = applyCameraJitter(proj, jx, jy, W, H);
  assert.ok(Math.abs(jittered[8] - (orig8 + (2 * jx) / W)) < 1e-12);
  assert.ok(Math.abs(jittered[9] - (orig9 + (2 * jy) / H)) < 1e-12);

  const unjittered = removeCameraJitter(jittered, jx, jy, W, H);
  assert.ok(Math.abs(unjittered[8] - orig8) < 1e-12);
  assert.ok(Math.abs(unjittered[9] - orig9) < 1e-12);
}

// --- T2: Camera-only reprojection is EXACT for world-static geometry ---------
{
  const aspect = 16 / 9;
  const near = 0.5;
  const far = 2000;
  const projA = mat4Perspective((FOV_ARCADE * Math.PI) / 180, aspect, near, far);
  const viewA = mat4View(0, 2.5, 0, 0, 0);
  const vpA = mat4Multiply(projA, viewA);
  const invVpA = mat4Invert(vpA);

  const w = transform4(vpA, 3, 1, -40, 1);
  const uA = (w[0] / w[3]) * 0.5 + 0.5;
  const vA = (w[1] / w[3]) * 0.5 + 0.5;
  const depthA = (w[2] / w[3]) * 0.5 + 0.5;

  const projB = mat4Perspective((FOV_ARCADE * Math.PI) / 180, aspect, near, far);
  const viewB = mat4View(1.2, 2.7, 0.8, 0.31, -0.12);
  const vpB = mat4Multiply(projB, viewB);

  const r = reprojectUv(invVpA, vpB, uA, vA, depthA);
  assert.ok(r.valid, 'world-static point must reproject on-screen');
  const wb = transform4(vpB, 3, 1, -40, 1);
  const uExpected = (wb[0] / wb[3]) * 0.5 + 0.5;
  const vExpected = (wb[1] / wb[3]) * 0.5 + 0.5;
  assert.ok(Math.abs(r.u - uExpected) < 1e-12, `u drift ${Math.abs(r.u - uExpected)}`);
  assert.ok(Math.abs(r.v - vExpected) < 1e-12, `v drift ${Math.abs(r.v - vExpected)}`);

  // Motion vector extraction
  const mv = calculateMotionVector(invVpA, vpB, uA, vA, depthA);
  assert.ok(mv.valid);
  assert.ok(Math.abs(mv.motionU - (uA - uExpected)) < 1e-12);
  assert.ok(Math.abs(mv.motionV - (vA - vExpected)) < 1e-12);

  // Depth discontinuity test
  assert.equal(depthDiscontinuityCheck(0.50, 0.51, 0.02), false);
  assert.equal(depthDiscontinuityCheck(0.50, 0.55, 0.02), true);
}

// --- T3: YCoCg color space conversion and AABB line-clipping -----------------
{
  // Lossless roundtrip test for RGB <-> YCoCg
  const colors = [
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
    [0.2, 0.7, 0.4],
    [0.9, 0.1, 0.3],
    [0.15, 0.25, 0.85],
  ];
  for (const c of colors) {
    const ycocg = rgbToYCoCg(c);
    const rgbOut = yCoCgToRgb(ycocg);
    assert.ok(Math.abs(rgbOut[0] - c[0]) < 1e-12, `R mismatch on ${c}`);
    assert.ok(Math.abs(rgbOut[1] - c[1]) < 1e-12, `G mismatch on ${c}`);
    assert.ok(Math.abs(rgbOut[2] - c[2]) < 1e-12, `B mismatch on ${c}`);
  }

  // YCoCg AABB line-clipping test
  const center = [0.2, 0.5, 0.3];
  const taps = [
    center,
    [0.22, 0.48, 0.31],
    [0.18, 0.52, 0.29],
    [0.21, 0.51, 0.30],
    [0.19, 0.49, 0.32],
  ];
  const boundsY = neighborhoodBoundsYCoCg(taps);
  const staleHistory = [0.9, 0.1, 0.1]; // Red ghost outside neighborhood
  const clipped = clipAABBYCoCg(staleHistory, center, boundsY.mn, boundsY.mx);
  const clippedY = rgbToYCoCg(clipped);

  // Clipped point must lie inside the YCoCg bounding box
  for (let i = 0; i < 3; i++) {
    assert.ok(clippedY[i] <= boundsY.mx[i] + 1e-9, `clipped value exceeds max on axis ${i}`);
    assert.ok(clippedY[i] >= boundsY.mn[i] - 1e-9, `clipped value below min on axis ${i}`);
  }
}

// --- T4: Neighborhood variance clipping (Mean ± gamma * stdDev) --------------
{
  const taps = [
    [0.20, 0.30, 0.10],
    [0.21, 0.31, 0.11],
    [0.19, 0.29, 0.09],
    [0.20, 0.30, 0.10],
    [0.22, 0.32, 0.12],
    [0.18, 0.28, 0.08],
  ];
  const vBounds = neighborhoodVarianceBoundsYCoCg(taps, 1.25);
  const rawBounds = neighborhoodBoundsYCoCg(taps);

  // Variance bounds must be tighter than raw absolute bounds
  for (let i = 0; i < 3; i++) {
    assert.ok(vBounds.mn[i] >= rawBounds.mn[i] - 1e-12);
    assert.ok(vBounds.mx[i] <= rawBounds.mx[i] + 1e-12);
    assert.ok(vBounds.stdDev[i] >= 0);
  }
}

// --- T5: Foliage cutout shimmer -> stable reconstruction ---------------------
{
  const pan = { speedPxPerFrame: 0.02, frames: 160 };
  const statusQuo = simulateEdgeAccumulation({ ...pan, useJitter: false, blendK: 1 });
  const taaRgb = simulateEdgeAccumulation({ ...pan, useJitter: true, colorSpace: 'rgb' });
  const taaYCoCg = simulateEdgeAccumulation({ ...pan, useJitter: true, colorSpace: 'ycocg' });

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
  const ftRgb = flicker(taaRgb.values);
  const ftYCoCg = flicker(taaYCoCg.values);

  assert.ok(fq.sd > 0.1 && fq.max > 0.9, `status quo flicker sd ${fq.sd}`);
  assert.ok(ftRgb.sd < 0.08 && ftRgb.max < 0.12, `RGB TAA sd ${ftRgb.sd}`);
  assert.ok(ftYCoCg.sd < 0.08 && ftYCoCg.max < 0.12, `YCoCg TAA sd ${ftYCoCg.sd}`);

  console.log(`foliage flicker |delta| sd/max: status quo ${fq.sd.toFixed(3)}/${fq.max.toFixed(2)} -> TAA(RGB) ${ftRgb.sd.toFixed(3)}/${ftRgb.max.toFixed(3)} -> TAA(YCoCg) ${ftYCoCg.sd.toFixed(3)}/${ftYCoCg.max.toFixed(3)}`);
}

// --- T6: Sub-pixel thin geometry reconstruction (0.25 px wire) ----------------
{
  const wireNoJitter = simulateThinGeometryCoverage({
    frames: 64, wireWidthPx: 0.25, useJitter: false, blendK: 1.0,
  });
  const wireTaa = simulateThinGeometryCoverage({
    frames: 64, wireWidthPx: 0.25, useJitter: true, blendK: 0.10,
  });

  // Without jitter, a 0.25 px wire only rasterizes when crossing the center pixel (flashes on/off)
  // With jitter and temporal accumulation, coverage reconstructs to continuous smooth value
  assert.ok(wireTaa.mean > 0.15 && wireTaa.mean < 0.35,
    `reconstructed wire coverage ${wireTaa.mean.toFixed(3)} matches expected ~0.25`);
  console.log(`subpixel wire coverage reconstruction (0.25 px wire): mean ${wireTaa.mean.toFixed(3)} (active samples: ${wireTaa.activeFrames}/64)`);
}

// --- T7: Responsive mask handling for movers / particles / tracers / sniper ---
{
  // 1. Particle card
  const mParticle = calculateResponsiveMask({ isParticle: true });
  assert.equal(mParticle, 0.80, 'particle gets high responsiveness');

  // 2. Weapon tracer / flash
  const mTracer = calculateResponsiveMask({ isTracer: true });
  assert.equal(mTracer, 0.95, 'tracer gets near-instant response');

  // 3. Fast moving vehicle (10 px/frame crossing)
  const mMover = calculateResponsiveMask({ isMover: true, velocityPx: 10 });
  assert.ok(mMover >= 0.80 && mMover <= 1.0, `mover responsiveness ${mMover}`);

  // 4. Sniper zoom transition (instant reseed)
  const mSniper = calculateResponsiveMask({ isSniperTransition: true });
  assert.equal(mSniper, 1.0, 'sniper zoom step forces immediate fresh frame');

  // 5. Effective blend resolution with responsive mask
  const blendKParticle = resolveBlendK({ responsiveMask: mParticle });
  assert.equal(blendKParticle, 0.80);

  const blendKStatic = resolveBlendK({ responsiveMask: 0, motionTexels: 0.2 });
  assert.equal(blendKStatic, TAA_BLEND_K);
}

// --- T8: Catmull-Rom 5-tap history filtering and anti-ringing ----------------
{
  // Test Catmull-Rom spline weights
  assert.equal(bicubicWeightsCatmullRom(0), 1.0);
  assert.equal(bicubicWeightsCatmullRom(1), 0.0);
  assert.equal(bicubicWeightsCatmullRom(2), 0.0);

  // 5-tap bicubic filter test
  const sampleMap = (u, v) => [u * 10, v * 10, (u + v) * 5];
  const filtered = sampleHistoryBicubic5Tap(sampleMap, 0.5, 0.5, 0.01, 0.01);
  assert.equal(filtered.length, 3);
  assert.ok(Math.abs(filtered[0] - 5.0) < 1e-4);
  assert.ok(Math.abs(filtered[1] - 5.0) < 1e-4);

  // Anti-ringing clamp
  const minRgb = [0.2, 0.2, 0.2];
  const maxRgb = [0.8, 0.8, 0.8];
  const ringed = [0.15, 0.85, 0.50];
  const clamped = antiRingingFilter(ringed, minRgb, maxRgb);
  assert.deepEqual(clamped, [0.2, 0.8, 0.5]);
}

// --- T9: Motion evidence & trauma shake rejection ----------------------------
{
  const fArcade = focalPixels(FOV_ARCADE, H);
  const fX8 = focalPixels(FOV_X8, H);
  assert.ok(Math.abs(fArcade - 935) < 2);
  assert.ok(Math.abs(fX8 - 8233) < 20);

  const close = motionPxPerFrame(20, 30, FOV_ARCADE, H, FPS);
  const trail = ghostExtentPx(close, TAA_BLEND_K);
  assert.ok(trail > 100);

  const shakeX8 = rotationalShakePx(0.045 * Math.pow(0.35, 1.6), 11, FPS, FOV_X8, H);
  assert.ok(shakeX8 > TAA_MOTION_REJECT_TEXELS * 5);
}

// --- T10: HDR glint strobing averaged below bloom threshold -------------------
{
  let h = 0;
  let hHi = 0;
  let hLo = 0;
  for (let n = 0; n < 400; n++) {
    const v = n % 2 === 0 ? 3.0 : 0.2;
    h += (v - h) * TAA_BLEND_K;
    if (n % 2 === 0) hHi = h; else hLo = h;
  }
  const cycleMean = (hHi + hLo) / 2;
  assert.ok(Math.abs(cycleMean - 1.6) < 0.01);
  assert.ok(hHi < 1.78, 'glint peak must stay below bloom threshold');
}

// --- T11: Comparison against SMAA + FSR1 baseline ---------------------------
{
  const comparison = compareAAApproaches();
  assert.ok(comparison.smaaFsr1);
  assert.ok(comparison.taaPhaseB);
  assert.ok(comparison.taauPhaseB);

  // TAA achieves ~9x reduction in foliage flicker vs status quo
  assert.ok(comparison.taaPhaseB.foliageFlickerSd < comparison.smaaFsr1.foliageFlickerSd * 0.15);
  // SMAA has zero ghosting on movers
  assert.equal(comparison.smaaFsr1.ghostingOnMovers, 'Zero ghosting by construction (spatial only)');
  // TAA cost is measured around ~0.48 ms @ 1080p
  assert.ok(comparison.taaPhaseB.gpuCostMs1080p < 1.0);

  console.log(`comparison matrix loaded: ${Object.keys(comparison).length} approaches verified`);
}

console.log('taaCore Phase B self-test passed (all 11 test suites green)');
