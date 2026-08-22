# Graphics & Performance Campaign Workboard

- Repo: quantdale/tank-game — branch `main`
- Campaign start HEAD: `20318447`
- Lead: main session (architect/integrator; ONLY committer)
- Baseline worktree: `../tank-game-baseline` pinned at start HEAD

## Baseline evidence
- `npm test` @ start HEAD: PASS (exit 0).
- `perf:dev --profile=normal` on pinned worktree → `.qa-campaign/baseline-normal.json`:
  - Host: HeadlessChrome 151, Intel UHD Graphics (D3D11), 20 cores, dpr 1, 1365x768.
  - readyWallMs 45.9 s; combatWarm totalMs 45.6 s (effects 30.9 s, visuals 7.0 s, shadows 5.9 s).
  - battleOpen10s: effectiveFps 2.96, p50 gap 348 ms, freezes 27, longTasks 2.
  - CPU profile top self: WebGLUniforms 97.8 s (shader first-use), paintPatchRoughness 17.5 s,
    heightToNormalSteps 12.2 s, composeAlbedo 2.8 s (materials.js/sourcedTextures.js bakes).
  - Absolute desktop-High FPS targets NOT establishable on this iGPU host; battle-open
    construction cost + hitch profile are the honest local metrics.

## Wave 1 (16 workers) — all completed, integrated on main tree
| W | Scope | Result |
|---|---|---|
| W1 | Profiling | perfTrace whole-frame draw fix; renderProbes (casters/veg/chunks/texMB); gpuTimer (?gputrace=1); trace analyzer CLI |
| W2 | Vegetation | behind-camera chunk cull (~12-17% fewer instances at spawn view); distant residue drain; merged grass program key |
| W3 | Shimmer/GTAO | root causes RC1-RC4; Patch A (AO EMA always-blend) APPLIED by lead; wind freeze B1/B2 APPLIED by lead |
| W4 | Shadows | per-cascade sub-texel caster skip; far-cascade 4096-instance budget; two-pass compaction hardening |
| W5 | Terrain materials | baked curvature occlusion aCavity; far splatSamp early-out; lazy wall noise; boundary dither; sastrugi; road blending; roughness variation |
| W6 | Terrain streaming | sliced builders + budgeted scheduler (worst update 13.9→2.8 ms in node bench); screen-space thresholds; motion prefetch; retention; WIRED into terrain.js by lead (+onDispose GPU release) |
| W7 | Props | ground-decal atlas 5 draws→1; JSON import attr; destruction round-trip selftest; found W9 wreck regression |
| W8 | World cells | five-state cellLifecycle + map.js facade; foundations (no consumers yet) |
| W9 | Vehicle LOD | hero/battle/distance size-relative tiers; costly buckets; gear regex fix; −44.5% battle-tier draws (fleet sweep); wreck regression FIXED by lead |
| W10 | Vehicle materials | shared track library (≤4 canvases fleet-wide); refcounted decal library; SURFACE_LIBRARY; bake alloc trims; ≤12 variant census |
| W11 | Assets | FX atlases gray+alpha −41% (−327 KB boot path); duplicate audit tooling; KTX2/meshopt assessment (runtime support ships, no encoder dep) |
| W12 | Post | fused AO composite (−1 fullscreen draw); 8-bit display tail grade→SMAA→FSR (−243 MB/frame @ retina High arithmetic) |
| W13 | TAA feasibility | CONDITIONAL GO phased; inert pure prototype + FEASIBILITY.md; default OFF |
| W14 | VFX | tracer pixel floor; effect LOD bands; kill-frame CPU LOD; load-aware admission; pool-pressure response; terrain-draped shockwaves; big-HE ring |
| W15 | UI CPU | HUD DOM-write gating (~30 queries+32 writes/frame → ~0 steady state); main.js CPU findings listed for wave 2 |
| W16 | Boot/memory | lazy map.js import; staged createPost; bounded visual-timing ring; shadow-map lifetime disposal |

## Lead cross-integrations applied
1. tankFactoryCore.js `setBattleCostlyVisible` null guard (wreck regression).
2. post.js AO EMA always-blend (W3 Patch A) atop W12's fused composite.
3. vegetation.js wind freeze 60-110 m (grass) / 140-220 m (trees) (W3 B1/B2).
4. terrain.js budgeted scheduler wiring + geometry.dispose on eviction (W6).
5. main.js devTrace configure {scene,lighting,world} + ?gputrace=1 opt-in (W1).
6. package.json: 14 new selftests wired into npm test.

## Wave 2 candidates (evidence-ranked)
1. Battle-open warm cost (effects warm 31 s on iGPU; WebGLUniforms compile storm) — lead-run probe attribution, then targeted fixes.
2. main.js per-frame CPU: aim graze/armor ray throttle, duplicate getWorldDirection, concealment poll (W15 evidence).
3. sourcedTextures composeAlbedo map-load CPU (2.8 s self).
4. Vegetation consuming world.cells; preset levers for grass range / shadow floors / stream budget.
5. Icons markings dedup (~1.04 MB, 15 groups).
6. post SceneAA resolve-copy elimination when MSAA off (needs buffer redesign).

## Status log
- [x] Baseline npm test PASS + probe captured
- [x] Wave 1 dispatched (16) + integrated
- [ ] Full npm test after integration (running)
- [ ] Commits per category
- [ ] Wave 2
  - [x] W2-A final call r1 (2026-08-22): uniform-discovery parallel window + burnt-atlas IDB cache verified landed, affected selftests green; muzzleFlash first-use wait span reclassified → Wave-3 BLOCKER (B14), not fixed per campaign rules
- [ ] After-probe + screenshots + build gates
- [ ] Docs + final push
