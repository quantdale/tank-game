# Graphics & Performance Campaign — 2026-08-21

Status: **waves 1+2 integrated** (24 workstreams, commits `60111d1f..1de6d01a` on `main`),
final gates recorded below. Start HEAD: `20318447`. This document is the durable
record of the campaign; the live task board lives in `.agent-docs/perf-campaign-workboard.md`.

## How to read the numbers

All browser measurement for this campaign ran on the campaign host: HeadlessChrome
151, **Intel UHD Graphics (D3D11, integrated class)**, 20 CPU cores, dpr 1,
1365x768, development build, `?tier=desktop&gfxreset=1`. Absolute desktop-High FPS
targets (>=60 median at 1080p) are **not establishable on this GPU**; the honest
local metrics are battle-open construction cost, frame-gap tails, draw/instance
counts, bandwidth arithmetic, and byte-level resource wins. Where a number below
says "arithmetic" it is derived from pass sizes and formats, not wall-clocked.
The pinned baseline worktree (`tank-game-baseline` @ `20318447`) preserves the
ability to re-measure both sides on any future machine.

## Baseline (before)

`npm test`: PASS. `npm run perf:dev -- --profile=normal`
(`.qa-campaign/baseline-normal.json`, archived copy in this directory's history):

| Metric | Value |
| --- | --- |
| readyWallMs | 45 938 |
| combatWarm total | 45.6 s (effects 30.9 s, visuals 7.0 s, shadows 5.9 s) |
| battleOpen10s effective FPS | 2.96 (p50 gap 348 ms, 27 freezes, 2 long tasks) |
| firstLive5s | 1 frame observed (host too slow for a meaningful window) |
| CPU profile top self | WebGLUniforms 97.8 s (shader first-use storm); paintPatchRoughness 17.5 s; heightToNormalSteps 12.2 s; composeAlbedo 2.8 s |

## Wave 1 — what changed (by subsystem)

**Profiling (W1).** Flight-recorder draw/triangle columns were systematically
undercounting (three r185 resets `renderer.info` per `render()`; only the last
composer pass was recorded). Now accumulated per pass. New `src/dev/renderProbes.js`
(shadow casters/receivers, instanced draws, vegetation instances, chunk LOD
histogram, unique-texture footprint MB, cascade RT estimate; 1 Hz traversal),
`src/dev/gpuTimer.js` (opt-in `EXT_disjoint_timer_query_webgl2` per-pass timing via
`?gputrace=1`, bounded query pool), and `tools/campaign-trace-report.mjs` (offline
trace analyzer). Dev builds only.

**Vegetation (W2+W3).** Conservative behind-camera chunk cull (~12% fewer grass
instances / ~17% fewer draws at spawn view, more while driving); the 155-180 m
constant 6%-density residue drains to zero (sub-2px speckle the terrain albedo
already carries); one merged grass program key (one fewer compile + per-frame
switch). Wind freeze (ao-boil r4): grass sway fades out 60-110 m, tree/canopy sway
140-220 m, so alpha-cutout depth stops churning the GTAO occluder field where the
sway arc is sub-pixel. Near-field sway and density untouched.

**GTAO temporal stability (W3, applied by lead).** The AO history filter's
"camera still => resolve immediately" fast path assumed a world-static scene;
wind-displaced foliage kept rewriting depth under parked cameras and fed raw
half-res boil into the AO multiply at k=1.0. The filter now blends every frame
(exact world-space reprojection makes a static signal converge in one frame);
new occluders take ~230 ms to darken instead of flashing.

**Shadows (W4).** Per-cascade sub-texel caster skip (instances below 0.75 of the
cascade texel edge are dropped per cascade — sub-perceivable before PCF dilution)
and a deterministic 4096-instance largest-first budget per far cascade. Near
cascade pair unbudgeted; penumbra-width compensation untouched. Two-pass
compaction proven byte-identical on nothing-culled frames.

**Terrain (W5+W6).** Materials (matqual r1): baked curvature occlusion attribute
(hollows/berms ground the object), far-band splat sampling early-out (>=160 m pays
1-2 fetches instead of 3-6), lazy wall noise, soil/grass boundary dithering,
winter sastrugi (uniform-gated), dirt-road compaction bands, roughness variation
above the 0.92 matte floor. Streaming: chunk construction moved from "one whole
job synchronously every 4th frame" to row-sliced builders under a 1.25 ms
background / 3 ms urgent budget with urgent preemption — node benchmark along a
real camera drive: **worst single update 13.9 ms -> 2.8 ms**, geometry bytes
provably identical; plus screen-space-error LOD thresholds, motion-aware prefetch,
and retention with GPU-buffer release on eviction.

**Props (W7).** Five ground-decal families batched into one 512^2 atlas mesh
(N transparent draws -> 1 per map). Determinism and a full destruction round-trip
(break/topple/physics + reset digest equality) pinned by a new headless selftest.

**World cells (W8).** Five-state cell lifecycle (ACTIVE/VISIBLE/SHADOW_ONLY/
DISTANT/DORMANT) on the existing 128 m grid, bands aligned with existing visual
partitions, hysteresis state machine, dual-observer min-distance, static content
registry. Foundations only; consumers land in wave 2+.

**Vehicles (W9).** Binary 96 m detail detach replaced by size-relative tiers
(hero/battle/distance, normalized by armor bounding radius, hysteresis at
boundaries). BATTLE sheds roof clutter + costly buckets (glass/cloth/track-dress)
and the fixed gear-dress regex miss; DISTANCE also hides skirt trim. Fleet sweep:
**6060 -> 3361 renderable leaves at battle tier (-44.5%)**; silhouette, turret,
gun, wheels, ERA, and all combat articulation preserved. Wreck burn integrity
kept (tier-shed classes force-show for the char sweep). A wreck-path regression
(`battleCostlyWrappers` iterated when null for non-LOD builds) was caught by the
props selftest during integration and fixed before commit.

**Vehicle materials (W10).** Track-band steel canvases collapse to a 4-variant
shared library per tier size (was one ~512^2 bake per cache entry); decals became
a refcounted shared library keyed by what they draw (duplicate-spec instances stop
re-baking identical canvases); surface responses frozen into one data table; Sobel
normal pass writes directly into its target; program-feature census caps vehicle
material shader variants at <=12.

**Assets (W11).** The six particle atlases are alpha-only payloads that shipped as
full RGBA PNGs; re-encoded as grayscale+alpha with per-file decode-equality proof:
**797,708 -> 470,345 bytes (-41%, -327 KB off the boot preload path)**, VRAM
identical; future bakes inherit the optimizer. New duplicate-resource audit
(pixel/byte textures, baked geometry, GLB POSITION accessors, packed-ORM
opportunities): findings include 15 pixel-identical icon marking groups (~1.04 MB)
and 11 packed-ORM candidate sets (~11.6 MB) for later waves. KTX2/meshopt runtime
support ships with three r185 but no in-repo encoder exists — adoption documented,
not forced.

**Post (W12).** AO composition fused from two fullscreen draws into one
(bit-identical math); the grade->SMAA->FSR display tail moved from HalfFloat
ping-pong to reusable RGBA8 targets (SMAA internals retyped to 8-bit):
**~-243 MB/frame bandwidth at retina High raster (arithmetic)**, -107 MB/frame at
dpr-1 1080p, one fewer fullscreen draw with AO on. Governor and preset contracts
unchanged.

**Temporal/TAA (W13).** Bounded pure prototype + FEASIBILITY.md. Verdict:
**conditional GO, phased, default-OFF** — foliage cutouts lose MSAA coverage on
the default tier (A2C no-op at msaaSamples 0), and temporal accumulation is the
one remaining lever that owns shimmer/crawl/thin-geometry together; tripwires
pre-committed (ghosting, smear, capture nondeterminism) and deferral costs
nothing. Nothing imported by production.

**VFX (W14).** Tracer screen-space readability floor (sub-0.75 px ribbons widen
with sub-linear brightness yield — distant tracers stop shimmering out);
150/340 m effect LOD bands dropping only provably subpixel sub-emitters (armed
after a warm-up grace so staged captures stay full-fidelity); destruction beats
admit <=2 heavy spectacles per frame; smoke/dust throttle on measured pool
occupancy; blast rings drape over sampled terrain; HE terrain hits gain a pressure
ring; kill-frame trajectory solves halve beyond 150 m; two hot-loop allocation
sites removed.

**UI CPU (W15).** HUD DOM-write gating: steady-state ~30 querySelector + ~32 DOM
writes per frame reduced to ~0-2 (shell slots, cooldowns, consumables, special
actions, target plates, roster/score/clock all value-gated); sniper fringe
gradient cached per resize; percentile sort skips while the panel is hidden.
Combat-critical feedback paths untouched.

**Boot/memory (W16).** `map.js` (sole static importer of terrain/vegetation/props,
~11k lines) now loads via dynamic import so boot module-eval stops serializing it;
composer construction moved into the measured `'post'` boot stage; visual-load
timings bounded (256-entry ring); light shadow maps (`shadow.map`/`mapPass`) now
collected by resource disposal so evicted lights cannot leak VRAM.

## Verification so far

- Full `npm test` (including 14 new selftests wired into the chain): **PASS**
  after integration.
- All 19 targeted subsystem selftests re-run individually: PASS.
- Deterministic screenshot contract harness: run on the committed tree (result
  recorded in the wave-2 section below).
- Focused browser probes and the after-benchmark: scheduled after wave 2 lands,
  on a quiet tree, against the pinned baseline worktree.

## Wave 2 (landed)

Evidence-ranked follow-ups, all integrated and committed:

- **main.js per-frame CPU (WA1).** The dispersion-cone graze ray and the
  `queryAimArmor` plate sweep now re-solve only on real motion beyond tight
  epsilons or a ~30 Hz cap; `getConcealment` polls at ~7 Hz + observer change;
  the battle tick's duplicate `camera.getWorldDirection` collapsed to one solve.
  Steady-state aim-path raycasts drop from every frame to ~1/4 of frames on
  settled lays; center pen-ray stays every-frame.
- **FX idle draws + heap (WA2).** Empty particle pools and parked ATGM meshes
  submitted ~11 full draws per rendered frame forever; they now hide until
  content exists (warm routes still fill every pool inside compile windows).
  The ~8.8 MB of decoded atlas bitmaps are released after GPU install. A
  program/material census (9 materials / ~12 programs) is code-pinned by test.
- **Vegetation x world cells (WA3).** Tree repartition fires on cell-class
  turnover (+24 m drift net) instead of every 6 m of travel; the wind clock
  advances only while some rendered vegetation can still show sway; grass
  range constants read preset data with shipped fallbacks.
- **Shadow preset levers + telemetry (WA4).** `shadowCasterMinTexels` /
  `shadowFarInstanceBudget` resolve per preset (validated, fail-safe);
  `getShadowTelemetry()` exposes per-cascade culled/budgeted counters split by
  mechanism. quality.js data: medium 0.9/3072, low 1.0/2048, mobile tiers down
  to 1.25/1024 — High keeps its calibrated constants.
- **Terrain motion prefetch + budget lever (WA5).** Render-side velocity feed
  enables the scheduler's motion-aware prefetch (next-finer LOD exists ~150 m
  sooner along travel); stream budget reads preset data. Node benchmark profile
  unchanged byte-for-byte; worst-update win from wave 1 holds (13.9 -> ~2.8 ms).
- **sourcedTextures memoization (WA6).** Identical Color x AO x roughness
  composites are cached (LRU 16) so rematches/revisits drive repeat composition
  to zero; AO/roughness decodes share one `willReadFrequently` scratch. Outputs
  pinned byte-identical by a 16-option golden-matrix selftest. (Baseline profile:
  `composeAlbedo` 2.8 s self per session.)
- **Icon markings dedup (WA7).** 15 byte-identical marking groups collapsed to
  content-addressed shared sheets: **-1,094,097 bytes**, 46 manifest records
  repointed, idempotent `--dedup-existing` migration mode added. Also diagnosed
  and repaired a pre-existing red gate: commit `20318447` had rewritten nine
  diagram records without committing matching PNG bytes; the nine sheets were
  regenerated from live builders (`1de6d01a`), and the checker gained explicit
  puppeteer protocol headroom.
- **Post scene resolve-copy elimination (WA8).** With MSAA off (the default on
  high/medium/low/mobile) the scene rasterizes directly into the composer
  buffer: **~-74.6 MB/frame bandwidth at retina High raster (arithmetic)**,
  -33 MB/frame at dpr-1 1080p, one fewer fullscreen draw, and the dedicated
  sceneTarget allocation freed. Depth consumers repoint per frame; MSAA tiers
  keep the stock path; `window.__SCENE_RESOLVE_COPY` forces the stock path for
  A/B.

Lead integrations in wave 2: preset lever DATA landed in `quality.js`
(consumed by vegetation/lighting/terrain — High unchanged, constrained tiers
shed more), WA2's network-warm preload gap closed in `main.js`, shadow selftests
updated to the per-tier contract, WA6's selftest wired into `npm test`.

## Final gates

| Gate | Result |
| --- | --- |
| Full `npm test` (incl. 15 new campaign selftests) | **PASS** (exit 0) after wave 1 and again after wave 2 |
| Deterministic screenshot contract (29 views: garage, all 16 biomes, FX, killcam) | **PASS**, zero console errors |
| `tools/tank-assets-check.mjs` file-level assertions | green post-repair (pure-node rehearsal over all 1332 records); full browser audit could not complete under host contention (below) |
| Terrain streaming node benchmark | worst single update **13.9 ms -> ~2.8 ms** (-80%), geometry bytes identical |
| Asset payload | FX atlases **-41% (-327 KB boot path)**; icon markings **-1.09 MB** |
| Draw/bandwidth arithmetic | battle-tier vehicle leaves **-44.5%**; post chain **~-318 MB/frame** combined at retina High raster (AO fusion + 8-bit tail + resolve-copy elimination); ~11 idle draws/frame removed |
| Browser wall-clock A/B probe | **REFUSED this session**: the after-probe watchdog fired at battle-open (2 frames in ~56 s) under documented host contention — two unrelated long-running dev servers on this machine (a vite instance at sustained >1 core since 08:55 and an expo CLI since 12:28) starve the already-marginal Intel UHD iGPU. The baseline capture predates the second offender. Per PERFORMANCE.md, contended runs are refused rather than recorded; re-run both sides on a quiet host via the pinned baseline worktree (`tank-game-baseline` @ `20318447`). |

## Recommended next campaign

1. Re-run the paired perf probes on quiet hardware (baseline worktree is pinned
   for exactly this) to attach wall-clock numbers to the structural wins.
2. TAA Phase B behind a default-OFF preset lever (FEASIBILITY.md §7) with A/B
   screenshots against foliage/scope views.
3. KTX2/meshopt adoption: pick an encoder dependency, extend the fx bake entry,
   wire KTX2Loader-with-PNG-fallback into particle preload.
4. Packed-ORM bake for the 11 sourced texture sets (~11.6 MB + map-load CPU)
   pending owner sign-off on attribution continuity.
5. Props destructible-pool consolidation onto BatchedMesh once the x8 scope
   scan consumer is updated in the same change.
6. Split the 'effects' warm-stage label so scene-wide shader compilation is
   attributed separately from fx work.

## Known limitations / honest gaps

- No desktop-class GPU available: absolute FPS targets unproven here; all
  frame-rate claims are structural or integrated-GPU-relative.
- TAA remains unbuilt in production by design (prototype + verdict only).
- Packed-ORM migration touches third-party CC0 texture sets and needs owner
  sign-off on attribution continuity; audited, not migrated.
- KTX2/meshopt adoption requires choosing an encoder dependency; documented.
