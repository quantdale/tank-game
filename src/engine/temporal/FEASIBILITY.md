# Temporal stability / TAA feasibility (W13 bounded prototype)

Status: PROTOTYPE — nothing in `src/engine/temporal/` is imported by
production code. This document maps a modern temporal solution onto the
current renderer and states an evidence-backed GO/NO-GO. Companion pure-logic
module: `taaCore.js` (selftest: `node src/engine/temporal/taaCore.selftest.mjs`).

## 1. The four offenders vs today's stack

Chain today (post.js): SceneAAPass (MSAA render + single resolve) → Aerial
(+ aa-r1 firefly clamp) → GTAO (ao-boil r3 temporal AO) → LateFx → Bloom →
OutputGrade (ACES+sRGB+grade) → SMAA (high preset: threshold 0.055, 16 search
steps) → FSR1 EASU+RCAS upscale to native canvas.

- **Foliage shimmer**: vegetation cards are alpha-tested WITH
  `alphaToCoverage: true` (vegetation.js:1621, :2369; props.js:2767;
  horizon.js:1450) plus coverage mipmaps (lighting.js). But alpha-to-coverage
  modulates MSAA samples — and `msaaSamples` is **0** on high (the default),
  medium, low and every mobile preset (quality.js; perf-120 r2 removed the
  2x scene MSAA from High after measuring it at ~40 median-fps). On the
  default tier the cutout edges rasterize at 1 sample/pixel with NO coverage
  AA; SMAA is an edge-PATTERN filter that deliberately ignores isolated
  pixels (aa-r1 header), so 1 px leaf dust reshuffles every frame. This is
  the loudest unowned artifact and precisely what jittered accumulation fixes.
- **Specular crawling**: partially owned today by the FIREFLY clamp (linear
  HDR neighborhood cap, pre-bloom) and the scoped-unsharp ±0.085 cap. What
  remains is temporal: glints pop in/out across frames; the firefly clamp
  bounds each frame's spike but cannot average it away.
- **Distant thin geometry** (telegraph poles, wires, fences, far combs):
  sub-pixel-width rasterized geometry flips coverage frame to frame. SMAA
  cannot own it (isolated pixels); MSAA at 4x helps silhouettes but is gone
  on the default tier anyway.
- **Reconstruction stability**: when the dynamic-resolution governor steps
  (`dynScale`, 0.09 steps) or on non-native presets, FSR1 EASU enlarges an
  aliased internal frame; 1 px churn is magnified. Temporally stabilizing the
  pre-upscale frame is exactly the problem FSR2/TSR solve internally.

## 2. Motion characteristics (what the accumulator must survive)

- Rig (cameraRig.js): spring-followed pivot τ=0.1 s, orbit-distance lerp
  τ=0.15 s, damped free look; trauma shake amplitude 0.045 rad at 11 Hz scaled
  by `trauma^1.6` (fire 0.25, hit 0.45, near-explosion 0.7), ×0.3 in sniper;
  recoil kick. Sniper: FOV = 60°/zoom, zoom ×2/×4/×8 (×16/×25 flag), mouse
  sensitivity ÷ zoom.
- Fleet: top speeds 57–75 km/h ≈ 16–21 m/s; turret traverse up to 60°/s.
- Screen motion at 1080p/60 (taaCore focalPixels/motionPxPerFrame):
  arcade focal ≈ 935 px/rad; x8 focal ≈ 8233 px/rad.
  - Tank crossing laterally: **10.4 px/frame at 30 m**, 2.1 at 150 m,
    1.0 at 300 m.
  - Trauma-0.35 shake bursts: **≈9 px/frame arcade, ≈80 px/frame at x8**.
  - Deliberate slow x8 pan (0.05 rad/s): ≈6.9 px/frame — global rotation,
    handled exactly by reprojection, NOT by the reject gate.

## 3. Requirements mapped onto this renderer

1. **Sub-pixel jitter**: Halton(2,3) phases (taaCore, 8-phase cycle) added to
   the projection of the ONE scene render inside SceneAAPass. No second scene
   pass. All depth consumers were audited: the aerial pass' distance curves
   are smooth in depth (±0.5-texel parallax invisible); GTAO's reprojection
   reads `cam.projectionMatrix` every frame and stores the previous VP, so it
   stays self-consistent with a jittered projection automatically (the
   ao-boil r3 shader needs no change); LateFx soft-intersection fades are
   ±0.5-texel insensitive.
2. **Velocity handling**: v1 is camera-only reprojection — exact for the
   world-static majority of pixels (terrain, buildings, props, foliage,
   wrecks). Moving vehicles are the gap: without motion vectors the stale-
   history trail behind a 30 m crossing reaches ~227 px at 10% contrast
   (ghostExtentPx, k=0.1) — unacceptable raw, BUT bounded in contrast by
   rectification and concentrated in close crossings. Mitigation ladder:
   (a) velocity-gated blend using SIM-derived per-tank screen velocity
   (deterministic sim state, no G-buffer render), (b) a dynamic-object-only
   motion-vector prepass only if (a) still smears in playtests.
3. **History rejection**: neighborhood AABB rectification (5-tap cross,
   identical shape to the existing GTAO EMA shader) makes ghosting
   contrast-bounded BY CONSTRUCTION — proven in T4: output can never leave
   the current frame's local [min,max]. Disocclusion/off-screen → fresh frame
   verbatim. Fast global motion (shake bursts, zoom steps) → reject via the
   ≥3-texel motion gate (measured shake exceeds it 3–27×).
4. **Reactive masks**: per-pixel k elevation where |rectified history −
   current| is large (specular pop-in responsiveness). Extension point is
   `resolveBlendK`; tuning happens at integration time, not in the prototype.
5. **Placement**: accumulate immediately AFTER the SceneAAPass resolve, i.e.
   in linear HDR before aerial/GTAO/bloom. Bloom then reads a temporally
   denoised buffer (glint strobe stops driving halo pulse — T6). SMAA and
   FSR1 stay downstream unchanged (TAA→SMAA is a standard stack; FSR1 gets a
   stabilized input, which is what FSR2 does internally).
6. **Buffers/reseeds**: two RGBA16F ping-pong targets at composer internal
   resolution, resized through the composer's existing setSize flow. Reseed
   (fresh frame, one frame) on: governor step, preset switch, sniper zoom
   step, mode switch, >250 ms gap — the exact policy ao-boil r3 already uses
   (`emaLastMs`), so there is in-repo precedent for every event.
7. **Determinism/captures**: no randomness beyond the fixed Halton schedule;
   snapArcade/snapSniper captures already run settle frames. Integration
   should add a `forceConverge()` QA hook (present several accumulate steps)
   so capture paths converge explicitly.

## 4. Prototype evidence (all from the Node selftest, deterministic)

- **Shimmer → stability**: panning camera over a static cutout edge, status
  quo (raw 1-spp binary sample) flickers with |Δ| sd 0.143 and full-contrast
  flips (max 1.0); accumulated output |Δ| sd **0.015**, worst step **0.083**
  — roughly a 9× flicker-energy reduction and no full-intensity flips.
- **Accuracy**: static-edge coverage reconstructs to 0.339 vs 0.370 truth
  after 96 frames (Halton(2,3) discrepancy; more phases tighten this).
- **Ghost bound**: stale bright history clamps into the current frame's local
  envelope (output ≤ local max), unlike the unclamped 1.9-of-2.0 survivor.
- **Motion gates**: shake bursts (9–80 px/frame) trip the reject gate →
  fresh frame during hits (smear-free, and perceptually masked by the shake);
  slow pans stay under it only in translation — rotation is owned by
  reprojection, which T2 proves EXACT (1e-12) for world-static points under
  combined translation+rotation.
- **Bloom decoupling**: a 50%-duty HDR glint (raw peak 3.0, threshold 1.78)
  displays 1.526..1.674 — never crosses the bloom threshold again, ending
  halo pulsing.

## 5. Cost (estimate, not measurement — browser work is out of this worker's scope)

One fullscreen accumulation pass (2 HDR reads + depth read + 1 write) plus
history resampling: order 0.3–0.6 ms at 1080p-class GPUs (WebGL2). Memory:
2× RGBA16F at composer resolution (High/dpr2 worst case ≈ 74 MB desktop;
mobile presets at ≤0.9 ratio are far smaller). No additional scene render in
v1. On Ultra, TAA can REPLACE the 4x scene MSAA (net GPU win there); High
already runs MSAA-free.

## 6. Verdict: CONDITIONAL GO (phased), with explicit NO-GO tripwires

The math is sound, cheap, and has an in-repo production precedent (ao-boil
r3 temporal AO uses the same reprojection+rectification+reseed skeleton on a
world-static signal). The highest-value offender — foliage cutout shimmer on
the DEFAULT tier, where MSAA/A2C are dead and restoring MSAA was measured at
~40 fps — is unreachable by any cheaper lever this engine currently has.

- **Phase A (this wave, done)**: pure module + selftest + this analysis. No
  production imports.
- **Phase B (follow-up wave; owners: post.js worker + lead)**: integrate
  behind a preset lever, default OFF; lead-run browser A/B on: foliage pan,
  x8 scope pan, close tank crossing, capture determinism, governor-step
  flash.
- **Phase C**: vehicle handling decided from Phase B evidence — velocity-
  gated k from sim state first; dynamic-object MV prepass only if needed.

**NO-GO / deferral tripwires** (any one ⇒ keep the lever off; deferral costs
nothing because Phase A is inert): foliage reads translucent/mushy at k≤0.12
even with the reactive mask; close-crossing vehicle trails judged worse than
status-quo shimmer in lead probes; capture nondeterminism not fixable by
forceConverge(); governor-step reseed flash visible in transitions.

A ghosty TAA would indeed be worse than status quo — that is why the
recommendation ships with rectification-as-contract (T4), the motion gate,
and pre-committed tripwires rather than a blanket "add TAA".

## 7. Proposed quality.js data addition (NOT applied — file is out of scope)

Add one lever per preset, consumed by post.js at chain build:

```js
// quality.js presets — temporal AA lever (W13 proposal; default undefined = off)
ultra: { /* ...existing... */ taa: 1 },
high:  { /* ...existing... */ taa: 1 }, // default tier; candidate for the first A/B
// medium/low/mobile-*: no `taa` key => disabled, zero behavior change
```

`post.js` would read `preset.taa` next to `preset.msaaSamples`, build the
accumulation stage from `src/engine/temporal/` promotion candidates, and
publish `dataset.postAa = 'taa+smaa-high+fsr1'` when active.
