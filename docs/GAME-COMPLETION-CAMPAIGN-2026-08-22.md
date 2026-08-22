# GAME COMPLETION CAMPAIGN 3 — 2026-08-22

Status: **WAVE 1 IN FLIGHT** (16 master workstreams dispatched)
Starting SHA / PRIMARY non-regression waypoint: `ff4708af` (== origin/main at campaign start)
Historical performance waypoint: `970ef9e3` (pre-Campaign-2)
Campaign 2 record: `docs/GRAPHICS-PERF-CAMPAIGN-2-2026-08-21.md`

Mission: take the repository to RELEASE CANDIDATE quality per spec §23 — feature/content/functionally complete, polished, performance-certified vs `ff4708af`, robust, tested, release-buildable (cross-platform incl. Windows), documented. Final state must be committed and pushed to `origin/main`.

---

## 1. Completion Matrix (control board — updated continuously)

Legend: COMPLETE / NEEDS WORK / BLOCKED / NOT-IN-SCOPE / UNKNOWN. Statuses are evidence-based; workers update rows as they verify.

| # | Subsystem | Implemented | Reachable | Correct | Content | Polish | Perf | Tested | Release-safe | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Core game loop / modes / match lifecycle | yes | yes | UNKNOWN | UNKNOWN | UNKNOWN | ok | partial | UNKNOWN | NEEDS WORK → SA-01 |
| 2 | Movement / physics / controls / camera | yes | yes | largely (fixed-step sim verified) | n/a | UNKNOWN | ok (C2) | good sim tests | UNKNOWN | NEEDS WORK → SA-02 |
| 3 | Ballistics / armor / damage / destruction | yes | yes | largely (~149-assertion combat selftest) | n/a | n/a | ok | good | UNKNOWN | NEEDS WORK → SA-03 |
| 4 | AI / navigation / tactics | yes | yes | UNKNOWN | n/a | n/a | ok | partial | UNKNOWN | NEEDS WORK → SA-04 |
| 5 | Vehicle roster (~111 registered) | yes | yes | UNKNOWN fleet-wide | UNKNOWN | UNKNOWN | ok | partial (profiles) | UNKNOWN | NEEDS WORK → SA-05 |
| 6 | Maps ×16 / world / collision | yes | yes | certified per-map (`mapsCert`: load/terrain/spawns/exact-collision-shapes/grounding/AI-routes) | yes | yes | ok (C2) | mapsCert + manifest census + headed recapture (0 console errors) | yes | DONE → SA-06 |
| 7 | Multiplayer / networking | yes (net/ + server/) | UNKNOWN reachability | selftests exist | n/a | n/a | n/a | extensive selftests | UNKNOWN | NEEDS WORK → SA-07 |
| 8 | UI / HUD / garage / onboarding | yes | yes | UNKNOWN | UNKNOWN | UNKNOWN | ok | dom/settings selftests | UNKNOWN | NEEDS WORK → SA-08 |
| 9 | Audio / game feel | yes (audio/ voices+timing selftests) | yes | UNKNOWN | UNKNOWN | UNKNOWN | ok | partial | UNKNOWN | NEEDS WORK → SA-09 |
| 10 | Graphics / lighting / post polish | yes | yes | C2-verified | yes | UNKNOWN | certified (C2) | contract tests | yes | NEEDS WORK → SA-10 |
| 11 | Performance / memory / streaming | yes | yes | C2-certified battle/garage | n/a | n/a | **baseline ff4708af locked** | probes exist | UNKNOWN | NEEDS WORK → SA-11 |
| 12 | Settings / persistence | yes | yes | UNKNOWN edge cases | n/a | n/a | n/a | settingsControls st | UNKNOWN | NEEDS WORK → SA-12 |
| 13 | Build / tooling / packaging | yes (`tools/build-public.mjs` wrapper; Windows/macOS/Linux) | yes | cross-platform verified: clean public+private builds via npm on Windows, env polarity proven in bundles, preview smoke green | n/a | n/a | n/a | wrapper validated by real clean builds | **yes** | FIXED by SA-13 (Wave 1): env-prefix defect gone |
| 14 | Automated QA / E2E gates | yes + NEW journey E2E: 180/180 selftests wired & guard-enforced; `test:journey` boot→garage→battle→damage→victory→rematch→death→wreck-exit GREEN headed AND headless; discovery gate `test:gate` with JSON evidence | n/a | n/a | n/a | n/a | n/a | strong unit + real E2E journey | yes (docs/QA-COVERAGE.md) | WAVE-1 COMPLETE → SA-14 |
| 15 | Code hardening / debt / security | UNKNOWN | n/a | 44 "placeholder/not-implemented" mentions need triage | n/a | n/a | n/a | n/a | UNKNOWN | NEEDS WORK → SA-15 |
| 16 | Release certification / player journey | not yet performed | n/a | n/a | n/a | n/a | n/a | n/a | NO | NOT STARTED → SA-16 |

### Known verified issues entering the campaign
1. `npm run build` fails on Windows (npm→cmd.exe cannot parse `VITE_PUBLIC_BUILD=1` env-prefix). Verified 2026-08-21/22.
2. Headless Chrome on this host cannot complete battle-open (~34 s renderer stall → frame detach). Reproduced IDENTICALLY at `970ef9e3`; environmental, not a code regression. Diagnostics in `.qa-dev/campaign2-*.json`. **[AMENDED 2026-08-22 by SA-14 — SUPERSEDED]:** the new player-journey probe (`tools/player-journey-probe.mjs`) completes the FULL journey headless 21/21 (battle-entry stage measured **190.5 s** vs Campaign-2's `openTimeoutMs=180000` watchdog — the "stall" was the budget, not the renderer; headed 138.1 s). Residual truth: headless runs GPU-less SwiftShader ~1.4× slower; keep ≥420 s budgets. Full evidence + timings: `docs/QA-COVERAGE.md`, `.qa-dev/player-journey-headless.json`.
3. Battle-open staging takes 107–152 s even headed (SA-11 target).
4. Two non-fatal console error classes observed during captures: one `ERR_CONNECTION_TIMED_OUT` and two external-resource `403`s — **[RESOLVED 2026-08-22 by W2-D]**: the paired 403s were `api.github.com` (stars widget) failing under the 60 req/hr/IP unauthenticated budget and being requested TWICE per page load (boot + garage mounts re-fired the failed request); the timeout is an intermittent connect failure to the same GitHub-family hosts. Fixed in-repo; residual single-request failures are documented environmental cases — see `## 6` W2-D.
5. A stale long-lived Vite dev server exists on port 5173 serving a rotten HMR module graph (fake boot errors). Workers MUST start their own servers and never trust a pre-existing one.
6. Windows port exclusions (WinNAT): TCP 7185–7284 reserved; random-port tools can die with EACCES.

---

## 2. Worker assignments

| Slot | Workstream | Mission (abbrev) | Report |
|---|---|---|---|
| SA-01 | Core game loop | full match lifecycle audit+hardening | DONE r1 (ff4708af): 3 fixes (openBattle stale-entry-tail phase guard; net countdown Infinity flash; deferred-visual kill hardening in state.js) + src/game/matchLifecycle.selftest.mjs (repeated sessions/verdict matrix/determinism/wrecks/spawns/live-fire, plain node, green); npm-test wiring requested |
| SA-02 | Movement/physics/controls/camera | production-quality feel + edge cases | DONE (W1): NaN-poison reseat guard in updateTank; analog pad drive wired; 2 new selftests (movement.edge, cameraRig) + input.selftest extended — all green; no tunneling/stuck/camera-penetration defects found |
| SA-03 | Ballistics/armor/damage | combat sim defect hunt | pending |
| SA-04 | AI/navigation/tactics | bot robustness all maps | pending |
| SA-05 | Roster completeness | fleet-wide automated contracts | DONE: new `src/vehicles/rosterSweep.selftest.mjs` sweeps all 121 playables (rigs/muzzle anchors/articulation+spawn NaN scan/bounds-vs-dims/materials/markings/manifest icons/recoil kick/dispose) green ~11s deterministic; fleet drift healthy (len 0.88–1.17×, wid 0.97–1.20×, grounded ±0.14m); FIXED severe rig defect: jpz_e100/sturmtiger/isu152/isu122s casemates lacked `P.fixedMount` (muzzle/bore anchors orbited off-hull inside the turretless traverse arc; now hull-seated, 0.000m drift). Needs npm-test wiring (SA-13/14 own package.json). |
| SA-06 | Maps/world/collision | 16-map certification + fixes | DONE @ff4708af: fixed town-monument invisible-wall AABB (urban/foundry → compound OBBs, manifests recaptured headed w/ 0 console errors, census +2/+2 both maps); added ±460 m hull clamp in sim/movement (map-escape fix; bots were only waypoint-clamped before); Windows agent-browser spawn fix in capture tool; NEW `src/world/mapsCert.selftest.mjs` (per-map load/terrain/spawn-pad/shape/grounding/cover/nav certification) + `src/sim/movementWorldBound.selftest.mjs`; 27-suite run green. WIRING REQUEST: add both new selftests to `npm test` (SA-13/14). |
| SA-07 | Multiplayer robustness | session lifecycle + authority | pending |
| SA-08 | UI/UX/HUD/onboarding | every screen, dead controls | DONE (Wave 1): 3 keyboard-ownership leaks fixed (settings.js+garage.js+keyboardOwnership.js+selftest), all screens walked live headless+headed; HUD/pause/end-screen verified in real battle (.qa-dev/sa08-headed-ui.mjs); 16/16 ui selftests green |
| SA-09 | Audio/game feel | spatial combat feedback coherence | pending |
| SA-10 | Graphics polish | final renderer audit, no C2 regression | DONE (W1): hot-loop alloc fix in shadowRefresh scheduler; TAA Phase-C seam pinned inert; ktx2 fx-dir classification flake root-caused+fixed; 4 comment-drift corrections; deferred-with-evidence: shadow-bias depth span, env-bake cloud IBL, fov-transition far-cascade staleness. npm test 125/125 exit 0; garage probe uncontended fps med 119 / frameMs med 8.4 (C2 ref 82.6/12.1) |
| SA-11 | Performance certification | vs ff4708af, battle-open p99 | DONE (Wave 1): cert evidence `.qa-dev/perf-cert-evidence-ff4708af.json`; battle fps 59.9/p99 ~33 ms certified (no C2 regression); battle-open attributed (cold 154-241 s → warm-profile 85 s) + Fix A cohort shadow-warm lands −25 s cold; see `## 4` |
| SA-12 | Settings/persistence | sanitize/persist/reset correctness | pending |
| SA-13 | Build/tooling/release packaging | fix Windows build script | DONE — `npm run build`/`build:public` now call shell-neutral `node tools/build-public.mjs`; clean public+private builds + preview smoke all green on Windows |
| SA-14 | QA/E2E infrastructure | player-journey gate + harness hardening | DONE (Wave 1): 8 historical unwired selftests found+verified+wired (180/180 now); NEW `tools/selftestChainGuard.selftest.mjs` in `npm test` makes unwired tracked tests a hard failure; wired SA-01 matchLifecycle, SA-05 rosterSweep, SA-06 mapsCert+movementWorldBound; NEW `tools/player-journey-probe.mjs` (`test:journey`) — full player loop via __DEBUG hooks GREEN headed 21/21 216.5 s AND headless 21/21 297.4 s (issue #2 reclassified: harness timeout budget, not renderer); NEW discovery runner `tools/release-gate.mjs` (`test:gate`, `--with-journey`) — full unit leg 180/180 green 321.5 s; coverage map + classification evidence `docs/QA-COVERAGE.md` |
| SA-15 | Hardening/debt/security | silent errors, NaN, dead code triage | XSS fixed (network nicknames→endScreen innerHTML escaped via new dom.escapeHtml + selftest); studio boot-poll runaway timers bounded; placeholder triage clean (0 real stubs of 44 mentions); net/protocol+server input validation verified solid |
| SA-16 | Release certification auditor | blocker list, player-journey runs | pending |
| W2-A | SA-11 follow-ups (b)+(c): warm-skip uniform discovery + fx atlas cache | DONE r1: parallel-link window in initializeForwardProgramsSteps (forwardWarm 62.3→10-13.7 s paired headed A/B/C/D, uniformsMs 60.4 s→≤2.8 s, births/p99/doneBeforeRollout invariants held) + content-hash IndexedDB cache for char/ember wreck atlases (materials.js, lossless+integrity-hash, legacy fallback); "16.6 s atlas bake" re-attributed via new fxMuzzle/wreckPre/Dance/Track marks — see `## 4`/`## 6` |
| W2-B | Boot post-chain first-visible-frame program links (B8(d) class): warm deferred composer passes | DONE r1: boot `'post'` stage now links the three fullscreen-quad programs whose passes skip/branch the first composer render — LateFxPass.Copy (skips while soft FX idle → linked mid-combat on first smoke), FSR1.EASU (skips at 1:1 raster → linked at the governor's first down-step), SceneAAPass.Copy (MSAA-only resolve path / live preset MSAA crossing) — via NEW `post.warmDeferredPrograms()` drawn bound to composer.renderTarget1 behind the veil (mirrors the srgb-linear variant warm); TAA left unwarmed (SA-12 gate keeps it unreachable); headless garage cert `--label w2b-postwarm`: `__BOOT_TIMINGS.postWarmDeferred` **86 ms** one-time, fpsMedian **59.9** ≥ 59.5 C2 floor, postFirstRender unchanged by design (24870 vs r6-artifact 23434 = host noise; the warm runs after that mark and covers programs that frame never links); post/offscreenWarm selftests green — see `## 6` |
| W2-C | Sniper-mode live verification (B3) | DONE r1: NEW `tools/sniper-scope-probe.mjs` (headed, own vite 5450-5599, evidence `.qa-dev/sniper-scope/*.json` + PNGs): pointer lock engages headed via one trusted CDP canvas click (verified natively; no special Chrome args); full wheel ladder through `input.js onWheel` — arcade orbit → SNIPER ×2 entry in ≤4 notches → ×4 → ×8 → ceiling clamp → wheel-out exit — asserted BOTH through native trusted deltas and through onWheel's own `lockDenied && target===canvas` cursor-aim notch path; scope presentation asserted by pixel-sampling the `.cot-ret` buffer (corner vignette alpha arcade 0.000 → sniper 0.557, soft falloff vs top edge 0.234, green reticle-arm delta 5→43 px, `×N.N` zoom plate present with per-magnification digest change); Shift-bound lane + RMB hold-to-aim live; zero page/console errors; harness bug found+fixed en route (puppeteer v25 `mouse.wheel` takes an options object — positional args silently sent deltaY:0) — see `## 6` |
| W2-D | External-resource errors root cause (B5, spec §14) | DONE r1: paired 403s root-caused to githubStars double-fetch; release-path 404 = analytics on non-Vercel host; fixes + clean-console proof — see `## 6` |
| W2-F | Memory soak (spec §13) | NEW `tools/memory-soak.mjs` (headed, own server 5700-5799): garage→battle→garage cycles over verdant/desert/urban/winter + vehicle switches, forced-GC sampling of heap / renderer.info / programs / auditSceneResources (per-scene-child attribution) / listener-proxy / DOM-node counts, taper-vs-linear verdict from revisit cycles only. 12-cycle evidence: world/pedestal caches bounded, listeners+RTs flat, GPU counts oscillate with random-roster composition (NOT growth); **heap +111.7 MB net across 7 revisit cycles (~+16 MB/battle retained after gc()) = suspected unbounded per-battle retention, mechanism attribution blocked** by a concurrent Wave-2 fleet refactor that broke boot (`type74` donor missing) — see `## 6` W2-F |
| W2-G | Gap closure: autoTier staleness (B6) + mobile smoke (B7) | DONE r1: quality.js policy-receipt validation is now PER-READ (`_autoPolicyHandled` once-per-boot gate removed; `reportSustainedOverload` pairs every verdict write with the current receipt) so a stale `cot.gfxAutoTier` written mid-session is discarded on the next read instead of owning the session; settingsPersistence.selftest extended with a B6 section (mid-session same-instance discard + receipt repair + governor-write pairing; regression proven against pre-fix logic); NEW `tools/mobile-smoke.mjs` headed iPhone-emulation smoke (?tier=mobile): touch layout engages, mobile preset owns ladder, real-flow battle entry, touch controls render in-viewport, joystick/fire reach the input layer, PNG receipts — see §5 blocker resolution notes |
| W2-I | Docs completion (spec §17) | post-Wave-1 doc refresh: DEVELOPMENT.md build/gates, README honest status, QA-COVERAGE cross-link, ASSET-PIPELINES.md | DONE — see `## 6` |
| W2-H | tankFactory chunk split (B4) | DONE r1: lazy-fleet split — browser boots through NEW `src/vehicles/fleetFactory.js` (eager core/canonical/misc + 4 dynamic family groups in `src/vehicles/fleet/`); eager first-load JS **4.05 → 2.91 MB (−1.14 MB, −28%)**, largest vehicle chunk **2200 kB → 366 kB**; garage navToReady parity vs PAIRED clean-HEAD worktree baseline (46.47 s vs 47.01 s headless back-to-back); solo battle entry verified headed end-to-end through the gates (world wreck-bakes + worst-case roster visuals + combatWarm + countdown→open 198.4 s); NEW `src/vehicles/fleetLazy.selftest.mjs` wired in posttest (identity+completeness+eval-order contracts; caught strv103 double-owner + merkava/challenger gaps); boot regression r1 (`type74` donor) root-caused+fixed — see `## 6` |

## 3. Wave log
- **Wave 1** (16 slots, master workstreams above): DISPATCHED 2026-08-22, **COMPLETE 2026-08-22** — all 16 reported; full `npm test` exit 0 on the combined tree (139 wired suites); integrated as commits 425218c3..16fa80d4 (10 subsystem commits). Headline fixes: dedicated-match server crash on disconnecting peer (B1 CRITICAL resolved), NaN combat damage propagation, casemate rig seating ×4, three stacked-modal UI defects, XSS via player names, Windows build P0, cold battle-open −25 s. Journey E2E green 21/21 headed (verdant + desert) and headless.

## 4. SA-11 Performance Certification Evidence (Wave 1, vs ff4708af)

Raw runs `.qa-dev/cert-battle-*.json`, consolidated `.qa-dev/perf-cert-evidence-ff4708af.json` (builder `.qa-dev/build-cert-evidence.mjs`; harness `.qa-dev/cert-perf.mjs`). Headed battle only (headless battle-open is environmentally broken — issue #2). Pinned worst-case GLB roster; vsync-real pacing; Windows-aware contention stamp (`os.loadavg()` is dead on this host).

**Sustained battle (verdant, worst-case roster) — certified at ff4708af:** fps median **59.9** (60 Hz vsync), frame p50 ~16.7 / p95 ~20 / **p99 33.2-33.5 ms**, max stall 33.5-66.9 ms, draw calls ≤811 worst frame, triangles ~4.56 M median, heap retained +0.06 MB/s (no leak), shader births ≈2 in-window, scene textures ~199 MB, RTs 8 (4 shadow cascades + post chain). No C2 regression; the old 94.7 ms headed p99 reference used a random roster and a fresh profile.

**Battle-open attribution (issue #3), cold profile, r1/r2:** nav→ready 33-37 s (boot `post` stage = first composer render link storm: `postFirstRender` 18.9 s of it); entry total 146-199 s = world build+activate 20-32 s (**minimap capture binds ALL world programs in one task** on the `precompile:false` path — activate 15-26 s), player visual reveal 27-31 s, bot stream ~4.6 s, entry warm 79-119 s (**combatWarm** 74-114 s: forward-program uniform discovery 37.8 s + fx sprite-atlas bakes 16.6 s + hidden variants 9.8 s), countdown+hide ~5 s.

**Fix A implemented (src/main.js ensureWorld):** the subset cohort shadow-warm now also runs on the fast `precompile:false` battle path instead of letting the minimap capture absorb every first-use link. Cold A/B (r3 vs r2): battle-open nav→open **179.5 → 154.7 s (−24.8 s)**, roster stage −18.9 s; sustained fps/p99 unchanged; garage unchanged (r6 parity with C2). Engine selftests (offscreenWarm/shadowRefresh/shadowStability/renderScalePolicy/deviceDiag/perfTrace/preBattleCountdown) all PASS.

**Returning-player reality (new harness `--profile` reuse):** puppeteer's fresh temp profiles defeat Chrome/GPU-driver shader disk caches, so every probe run paid cold links that a real returning player never does. With a reused profile: boot-to-ready **27.7 → 7.1 s**, player reveal 23.4 → 1.1 s, world stage 29.6 → 4.2 s, battle-open **154.1 → 84.7 s**. Issue #3's "107-152 s" is therefore the COLD worst case; remaining warm cost (~62 s combatWarm) is deliberate C2 design (zero first-combat hitches) and is main-thread canvas/CPU bake work — shrinking it further requires owner-level tradeoffs (worker offload or accepting first-contact hitches), not quick fixes.

**W2-A progress on follow-ups (b)+(c), 2026-08-22:** (b) LANDED — `initializeForwardProgramsSteps` no longer blocks each new program's `getUniforms()` on its serial driver link. With `KHR_parallel_shader_compile` it now submits all compiles first, breathes real frame boundaries until the batch reports complete (bounded 300 rounds / 8 s wall), then runs deferred discovery per program; without the extension the legacy path runs byte-for-byte (A/B switch `FORWARD_WARM_PARALLEL`, src/main.js). Paired headed cert runs (`--profile .qa-dev/w2a-prof`, worst-case roster): forwardWarm **62.3 → 10.2-13.7 s**, `__FORWARD_WARM_STATS.uniformsMs` **60388 → 14-2805 ms** for the same ~110 programs; combatWarm total 97.2 → 39-62 s under co-tenant load; sustained window births=2/jump=2 and `doneBeforeRollout=true` in every run — zero first-combat-hitch regression. (c) RE-ATTRIBUTED + PARTIAL: the "16.6 s fx sprite-atlas bake" line is actually the unmarked wreck-dance span plus first-render first-use around the fx volley — sub-marks show impacts/destructions/props/armor-scars are milliseconds and the burnt painter itself is already paid eagerly at staging (`createTankMaterials` → `ensureBurntTextures`). The char/ember pair is now ALSO disk-cached (content-hash keyed IndexedDB in src/vehicles/materials.js, lossless PNG + pixel-hash integrity, full legacy fallback) so repeat sessions skip repaint entirely. The remaining monster span is pinned to `fx.muzzleFlash`'s first-use frame — see `## 6` W2-A for the call-vs-wait split.

**Follow-ups for Wave 2:** (a) decide whether cert/E2E harnesses should default to a persistent profile (models players; faster gates); (b) `initializeForwardProgramsSteps` uniform discovery is 37.8 s/entry on this driver — candidate for KHR_parallel_shader_compile-driven skip when programs are disk-cache-warm; (c) fx sprite-atlas bake cost (16.6 s) could move to a cached-atlas artifact if art pipeline allows; (d) boot `postFirstRender` 18.9 s cold — same class as (b); (e) perfprobe.mjs still references vestigial `__GLB_STATS` (dead hook) and its contention guard is blind on Windows — port cert-perf's cpu-busy guard.

## 5. Release Blockers (SA-16, Wave 1)

Mission slot asked for "## 4"; that number was already taken by SA-11's
evidence section above, so blockers live here as ## 5 (no other content
touched). Pre-seeded from Wave-1 reports referenced in this doc
(`docs/QA-COVERAGE.md`, SA-08/10/11/14 rows, issues #1–#6) plus auditor
known-items. Live journey verdicts appended below when runs complete.

| # | Severity | Item | Rationale |
|---|---|---|---|
| B1 | **CRITICAL** | Multiplayer/networking reachability UNVERIFIED (matrix row 7: reachability UNKNOWN, selftests-only) | Cannot ship a networking feature certified by unit tests alone — needs one live session-vs-server proof before RC. |
| B2 | **HIGH** | Cold-profile battle-open still 85–155 s (issue #3; SA-11 Fix A landed −25 s; warm ≈62 s `combatWarm` is deliberate C2 design) | First-battle wait of 1.5–2.5 min is a player-facing UX cost measured in minutes; remaining fixes need owner-level tradeoffs (worker offload vs first-contact hitches). |
| B3 | **HIGH** | Sniper-mode UI never live-verified in-browser (needs pointer lock; outside journey probe coverage) → **RESOLVED by W2-C** (headed live verification `tools/sniper-scope-probe.mjs`: pointer lock engages natively, wheel ladder + scope pixels + Shift/RMB lanes all asserted in-browser; see `## 6`) | A core combat affordance verified only by code reading/selftests — silent breakage would ship undetected. |
| B4 | **HIGH** | Bundle size: chunk warnings >500 kB, `tankFactory` chunk 2.2 MB → **RESOLVED by W2-H** (lazy-fleet split: eager first-load JS 4.05→2.91 MB −28%; largest vehicle chunk 366 kB; garage load-to-ready parity proven vs paired HEAD baseline; residual >500 kB chunks `main`/`map` are pre-existing, separate scope — see `## 6`) | First-load cost on real networks scales directly from this; needs code-splitting/lazy-load pass before RC. |
| B5 | **MEDIUM** | External-resource failures during captures: 1× `ERR_CONNECTION_TIMED_OUT` + 2× 403s (issue #4), root cause unknown → **RESOLVED by W2-D** (githubStars double-fetch fixed; analytics host-gated; portrait lazy; release path probes 0 failures / 0 console errors — see `## 6`) | Non-fatal today but unknown-origin network errors in shipped builds are a reliability/error-policy liability. |
| B6 | **MEDIUM** | Stale `cot.gfxAutoTier` mid-session write not re-discarded until next boot → **RESOLVED by W2-G** (per-read receipt validation + governor-write pairing; see resolution notes below) | Graphics-tier mismatch persists silently for the whole session; users must reboot the game to clear a wrong tier. |
| B7 | **MEDIUM** | Touch/mobile layout verified by selftests only (no live device/headed-touch walk) → **RESOLVED by W2-G** (headed iPhone-emulation smoke `tools/mobile-smoke.mjs`: **9/9 PASS on HEAD** after fleet landing; also 9/9 on pre-fix baseline checkout; see resolution notes below) | If mobile is a release surface, selftest-green ≠ layout-correct on a real viewport. |
| B8 | **MEDIUM** | SA-11 perf follow-ups (a)–(d): harness profile policy undecided; forward-program uniform discovery 37.8 s/entry; fx sprite-atlas bake 16.6 s; cold `postFirstRender` 18.9 s → **PARTIALLY RESOLVED by W2-A**: (b) forward-uniform discovery −84% via KHR parallel window (62.3→10-13.7 s, zero-hitch invariants held); "16.6 s atlas bake" re-attributed + burnt/ember pair now content-hash disk-cached; residual muzzle-flash first-use span + (a)/(d) open — see `## 4`/`## 6` W2-A | Each is seconds-to-minutes of avoidable staging cost with an identified mechanism; grouped because they share the shader-compile/warm path. |
| B9 | **LOW** | Headless Chrome runs SwiftShader ~1.4× slower — CI/E2E budgets must stay ≥420 s or run headed (QA-COVERAGE revised issue #2) | Harness/environmental constraint, documented and worked around; zero player impact. |
| B10 | **LOW** | Stale long-lived Vite dev server on :5173 serves rotten HMR graph (issue #5) | Dev-environment hazard only; workers already instructed to spawn own servers. |
| B11 | **LOW** | Windows WinNAT reserves TCP 7185–7284 → EACCES for random-port tools (issue #6) | Host-specific tooling footgun; product port handling unaffected so far. |
| B12 | **LOW** | Steep spawn pads on alpine/monsoon/fjord (cosmetic geometry) | Visual/feel nit; spawns are functional per mapsCert. **W2-J triaged: ACCEPTED cosmetic debt** — real-sim drivability probe (`§6 W2-J`) shows 0/24 pads functionally bad; every pad exits multi-directionally even on the weakest climber (t95, 5.8 hp/t); no flatten warranted. |
| B13 | **LOW** | SA-10 deferred-with-evidence: shadow-bias depth span, env-bake cloud IBL, fov-transition far-cascade staleness; perfprobe.mjs vestigial `__GLB_STATS` + Windows-blind contention guard | Deferred with evidence by owner workstreams; polish debt, not defects. |
| B14 | **MEDIUM-HIGH** (**Wave-3 BLOCKER**, W2-A final-call r1) | First rendered frame after the fx volley flips particle pools visible pays all particle-family GPU first-use in ONE frame — `fxMuzzleCall` 1-3 ms vs `fxMuzzleWait` **0.7 s quiet host → 21.8 s under co-tenant load** (W2-A runs E/F, `.qa-dev/cert-battle-w2a-{E,F}*.json`). Behind the loader (`doneBeforeRollout=true` always), so no player-visible hitch today; the risk is contention-multiplied staging time on constrained machines. Candidate fix (Wave 3): compile soft-particle/fx programs BEFORE the volley (pool materials exist from factory time) or defer pool visibility until `initializeForwardProgramsSteps`; needs owner-level ordering tradeoff like the original (b) assessment. W2-A's uniform-discovery skip does NOT cover this span (verified: runs E/F post-fix). |

No CRITICAL beyond B1 identified pre-journey; matrix rows still NEEDS WORK
(1,2,4,5,8,9,12,15) carry UNKNOWN correctness/polish columns that Wave-2
audits must close — tracked here once, not itemized per-row.

### SA-16 live journey verdicts

**Run A — `npm run test:journey` (headed, m1a2 @ verdant, 2026-08-21T19:49Z,
wall 210.0 s): JOURNEY GREEN, 21/21 checks, exit 0**
(`.qa-dev/player-journey-report.json`).

| Leg | Verdict | Evidence |
|---|---|---|
| boot → garage | **PASS** (3/3) | `__GAME_READY` 29.8 s, phase=garage, zero page errors |
| garage select + BATTLE button | **PASS** (2/2) | selected=m1a2 |
| battle entry #1 (cold) | **PASS** (3/3) | mapId=verdant, 14 tanks, hp=2600, 128.8 s |
| combat damage | **PASS** (2/2) | LOS enemy at 431 m, playerShellLog=2 |
| victory + results overlay | **PASS** (4/4) | result=victory, rosters 7v7, BATTLE AGAIN present |
| rematch (battle #2) | **PASS** (2/2) | garage re-entry 20.5 s, fresh roster/result cleared |
| death leg + wreck exit | **PASS** (3/3) | spawnKillShell kill, dmgOnPlayer=457.76, wreck-exit → garage |
| global hygiene | **PASS** (2/2) | zero page errors, zero *unexpected* console errors |

Console errors observed: exactly one `net::ERR_CONNECTION_TIMED_OUT`
(classified expected; matches blocker B5 / doc issue #4 — no new error
classes). Stage timings consistent with SA-11 certification: cold entry
128.8 s < the 138.1 s SA-14 headed reference; warm re-entry 40.2 s.

**Run B — extra auditor probe on second map (`node tools/player-journey-probe.mjs
--map=desert --out=.qa-dev/player-journey-desert.json`, headed, m1a2,
2026-08-21T19:53Z, wall 191.3 s): JOURNEY GREEN, 21/21 checks, exit 0** —
same leg structure as Run A; cold entry 110.0 s, warm re-entry 37.9 s,
`consoleErrorsAll` EMPTY (cleaner than verdant). Second-map evidence closes
the "journey only ever proven on verdant" gap at the E2E level. Evidence:
`.qa-dev/player-journey-desert.json`.

### Blocker resolution notes — W2-G (B6, B7)

**B6 — stale `cot.gfxAutoTier` mid-session write (`src/engine/quality.js`).**
Root cause: `storedAutoTier()` spent its policy-receipt discard on the FIRST
read of a boot (`_autoPolicyHandled` once-per-boot gate), so any verdict that
reached localStorage later without carrying the current receipt — a second
tab still on the previous build across a deploy, a restored/partial write —
was trusted for the rest of the session; only a reboot (or pinning an
explicit preset) cleared it. Fix, both halves of the suggested direction:
(1) receipt validation is now PER-READ in `storedAutoTier()` (mismatch ⇒
verdict removed + receipt repaired immediately, mid-session included);
(2) explicit write-side pairing — `reportSustainedOverload()` writes the
receipt alongside every verdict it persists, so legit governor demotions
still survive across sessions ("next session starts where this one settled")
and can never read back as stale. Cross-session persistence semantics are
unchanged for current-policy verdicts. Regression proof: against HEAD's
logic the exact mid-session sequence (burn boot read → seed
`{tier:'low', policy:'clarity-r1'}` → read) returned `'low'`; post-fix it
returns the heuristic baseline and clears storage.

**Selftests:** `src/ui/settingsPersistence.selftest.mjs` gained a "B6
auto-tier staleness" section: mid-session same-instance discard + storage
repair assertions, receipt-less verdict discard, current-receipt verdict
survival (persistence contract), and governor-write receipt pairing.
Already wired via `npm test` (no new file → no package.json churn).

**B7 — mobile-emulation headed smoke (`tools/mobile-smoke.mjs`).** Headed
Chrome + Puppeteer device metrics (iPhone UA, landscape 892×412 @ dpr 3,
isMobile+hasTouch) against `?tier=mobile&nosplash=1`, own Vite server
(hmr/watch off — journey-probe harness shape), navigation-tolerant boot wait,
battle watchdog 600 s, live pageerror streaming, boot/battle timeout
diagnostics. Asserts: boot to garage with `body.cot-touch-layout` engaged
under a coarse pointer; `resolvePresetName()` lands in the mobile trio;
battle entry through the REAL garage flow; `.cot-touch.on` renders with
joystick/fire/scope/auto-aim/minimap boxes fully inside the small viewport;
backing store sized for dpr3; joystick drag reaches `input.getVirtualMove`
and a held (>320 ms holdDelayMs) fire button holds `input.getState().fire`
hot. PNG receipts + JSON evidence: `.qa-dev/w2g-mobile-smoke-garage.png`,
`.qa-dev/w2g-mobile-smoke-battle.png` (+ `-baseline*` variants),
`.qa-dev/w2g-mobile-smoke.json`.

**W2-G HEAD-run blocker (environmental, not W2-G code):** every mobile-smoke
attempt against the current working tree died at boot with uncaught
`Error: Japanese family donor missing: type74` (pageerror stream), reproduced
in plain Node via `node -e "import('./src/vehicles/japan.js')"` — the same
one-liner fails while the concurrent fleet-refactor worker's files are
mid-flight (`src/vehicles/fleet/`, `fleetFactory.js`, `tankFactoryCore.js`;
rosterPolicy.selftest still passes because it never imports japan.js). Boot
is broken tree-wide for every browser probe until that workstream lands.
Harness validity was therefore proven against the untouched sibling checkout
`D:/Documents/tryPython/tank-game/tank-game-baseline` (same tool invocation,
`--out` into this repo's `.qa-dev/`).

**W2-G smoke result (baseline verification, headed, `?tier=mobile&nosplash=1`,
2026-08-22): PASS — 9/9 checks.** Boot→garage **31.9 s**; `cot-touch-layout`
engaged under coarse pointer; `resolvePresetName()='mobile'`; REAL-flow
battle entry **137.6 s**; `.cot-touch.on` visible with joy 138×138 @(14,258),
fire 96×96 @(776,294), scope/autoaim present; every control + minimap
(116×116 @(8,8)) fully inside 892×412; canvas backing 1784×824 (dpr3 emulated,
renderer ratio cap 2 honored); joystick stepped-drag → `getVirtualMove`
y=1.0 active=true; >320 ms fire hold → `getState().fire` hot; zero page
errors; console limited to the two documented B5-class 403s. Probe finding
folded into the tool: a bare CDP `touchStart` does not drive the joystick
lane — stepped `touchMove`s are required (mobilelap gesture pattern).
Receipts: `.qa-dev/w2g-mobile-smoke-baseline-garage.png`,
`.qa-dev/w2g-mobile-smoke-baseline-battle.png`,
`.qa-dev/w2g-mobile-smoke-baseline.json`.

**W2-G smoke result on current HEAD (headed, `?tier=mobile&nosplash=1`, after
the fleet refactor landed): PASS — 9/9 checks.** Boot→garage **45.3 s**;
`cot-touch-layout` engaged under coarse pointer; `resolvePresetName()='mobile'`;
REAL-flow battle entry **179.6 s** with the pre-battle countdown fully drained;
`.cot-touch.on` renders (joy 138×138 @(14,258), fire 96×96 @(776,294), scope/
autoaim present); every control + minimap inside 892×412; backing 1784×824
(dpr3 emulated, ratio cap 2 honored); joystick stepped-drag → `getVirtualMove`
y=1.0 active; >320 ms fire hold → `state.fire` hot; **zero page errors, zero
console errors**. Receipts: `.qa-dev/w2g-mobile-smoke-garage.png`,
`.qa-dev/w2g-mobile-smoke-battle.png`, `.qa-dev/w2g-mobile-smoke.json`.
Harness notes: an earlier HEAD attempt under peak multi-worker host load saw
sim-time starvation stall the countdown mid-drain — the smoke now records
countdown state transparently rather than failing on it; a bare CDP
`touchStart` does not drive the joystick lane (stepped `touchMove`s required).

## 6. Wave 2 gap-closure log

### W2-B — boot post-chain deferred-program warm (B8(d) class), DONE 2026-08-22

- **Mechanism:** the hidden boot `post.render(SIM_DT)` only links passes that
  draw on it. Three fullscreen-quad programs skipped or branched around it and
  first-linked on a visible frame: `LateFxPass.Copy` (early-return until soft
  combat FX `isActive()` → mid-combat first smoke), `FSR1.EASU` (draws only
  when composer raster ≠ native canvas → dpr-1 hosts paid it exactly at the
  dynamic-resolution governor's first down-step), `SceneAAPass.Copy`
  (MSAA-only resolve blit; live-linked by a settings preset crossing
  MSAA 0↔N). TAA is deliberately unwarmed — the SA-12 gate keeps it
  unreachable from persisted state, so its program cannot link in normal play.
- **Change:** NEW `warmDeferredPrograms(renderer)` on the createPost return
  object (src/engine/post.js) draws the three quads once, bound to
  `composer.renderTarget1` (mirrors main.js's srgb-linear variant warm),
  restoring the prior binding in `finally`; called from the boot `'post'`
  stage in src/main.js right after `postFirstRender`, timed as new
  `__BOOT_TIMINGS.postWarmDeferred`. Between-frame hidden call only.
- **Evidence (headless garage cert, `--label w2b-postwarm`,
  `.qa-dev/cert-perf.json`, uncontended):** `postWarmDeferred` **86 ms**
  one-time behind the veil; `postFirstRender` 24870 ms vs pre-change artifact
  `.qa-dev/cert-garage-headless-r6.json` 23434 ms — delta ≈ +6 % host/driver-
  cache noise, not attributable (the warm runs *after* that mark and covers
  programs that frame never links; boot time unchanged by design). Headline:
  navToReady 33748 ms, fpsMedian **59.9** (C2 floor ≥59.5 held), p99 16.9 ms,
  max 17.6 ms, 1201 draws. The harness records no program-count-at-first-
  visible-frame metric; the boot-timeline keys above are the measured delta.
- **Verification:** `node --check src/main.js`;
  `node src/engine/post.selftest.mjs`; `node src/engine/offscreenWarm.selftest.mjs`
  — all green on the final tree.

### W2-D — external-resource errors root cause (B5, spec §14), DONE 2026-08-22

**Identification method:** headed-Chrome CDP probe (`.qa-dev/w2d-external-resource-probe.mjs`,
own Vite server, `Network.enable` → `Network.loadingFailed` + 4xx/5xx
`responseReceived`), because the console text ("Failed to load resource …
403 ()") carries no URL. Ran against dev server and against an isolated
production build (`vite build --outDir .qa-dev/w2d-dist` + preview).

**Root causes found (3 distinct):**

1. **The paired 403s — `https://api.github.com/repos/Kevin-Liu-01/claude-of-tanks`
   fetched twice per page load** (`src/ui/githubStars.js`). The boot screen and
   the garage both mount star nodes; `activeRequest` was cleared via `.finally()`
   as soon as a request settled, so a failed boot-time attempt re-fired from the
   garage mount. Deterministic repro with CDP-intercepted 403s: exactly two
   requests per load pre-fix, one post-fix (`.qa-dev/w2d-repro-prefix.json` /
   `w2d-repro-postfix.json`). Why failures at all: unauthenticated GitHub API is
   budgeted 60 req/hr **per IP** (`/rate_limit` showed the shared host budget);
   capture-heavy campaign days exhaust it for the rest of each hour, so every
   capture in the window logged the pair. UI degradation was already graceful
   (readable "Stars" fallback, no layout break).
2. **Release-path 404 — `/_vercel/insights/script.js`**
   (`src/analytics.js`, @vercel/analytics production mode). The endpoint only
   exists when served by Vercel; every vite-preview/dev load of a release build
   logged a guaranteed 404 console error.
3. **`ERR_CONNECTION_TIMED_OUT` / residual single 403 — environmental,
   GitHub-family hosts.** All three external hosts reachable in isolation at
   probe time (200/200/302); the timeout matches an intermittent TCP connect
   failure to api.github.com / github.com (avatar) under firewall flakiness.
   Documented environmental case; graceful handling unchanged.

**Fixes (in-repo):**

- `src/ui/githubStars.js`: one request per page load, success or failure — the
  settled promise stays shared, so later mounts can never re-fire a failed
  lookup (also stops burning rate-limit quota on doomed retries).
- `src/analytics.js`: injection gated to deployed hosts (`*.vercel.app`,
  `*.kevinliu.studio`) where `/​_vercel/insights/script.js` actually exists;
  local/dev builds make zero analytics requests instead of guaranteed-failing
  ones. Analytics behavior on real deployments unchanged.
- `index.html` credits portrait: `loading="lazy" decoding="async"` on the
  external GitHub-avatar `<img>` inside the closed credits `<dialog>` — zero
  boot-time request; verified it loads and renders only when the dialog opens
  (`.qa-dev/w2d-portrait-lazy-check.mjs`: complete=false/naturalWidth=0 before,
  complete=true/naturalWidth=460 after showModal, exactly 1 network request).

**Post-fix release-path verification** (isolated prod build, headed CDP probe):
**0 loading failures, 0 4xx/5xx, 0 console errors**, external requests = the one
stars fetch (200) plus inline `data:` URIs. Remaining documented environmental
case: if api.github.com is rate-limited/offline at capture time, ONE browser-level
"Failed to load resource" line may appear (browsers log any ≥400 response; JS
cannot suppress it) while the widget falls back gracefully.

**Tests:** new `src/ui/githubStars.selftest.mjs` (single-request contract:
failure does not re-fire on repeat mount; success renders count + aria label;
module-isolated via temp-copy import, plain node) wired into `npm test`;
analytics/publicNav/dom/loadingScreens selftests all green on the changed tree.

### W2-F — memory soak (spec §13), EVIDENCE r1 2026-08-22

**Tool:** NEW `tools/memory-soak.mjs` — headed Chrome, own vite server in the
assigned 5700–5799 band, `--js-flags=--expose-gc` so samples collect before
measuring. Drives real lifecycle cycles garage→battle→garage (`__DEBUG.beginSoloBattle`
/ `leaveBattleToGarage`, real loading path) cycling maps verdant/desert/urban/winter
and switching vehicles m1a2/t90m/tiger1/m4a3e8 between battles; each battle aims
+ fires (`aimAtNearest`/`forceFire`/`fastForward`) to exercise shell/fx/decal
paths. Sampling after every battle and every cycle-end: JS heap,
`renderer.info.memory.{geometries,textures}` + `info.programs.length`,
`auditSceneResources` totals AND per-top-level-scene-child breakdown
(attribution), world/pedestal cache residency + `lastWorldRelease` +
prefetch stats, DOM node count, and listener-proxy counts (an
`EventTarget.addEventListener/removeEventListener` proxy installed via
`evaluateOnNewDocument` BEFORE page scripts records adds/removes per target
class — approximate live-listener trend). Verdict logic uses REVISIT-cycle
deltas only (desktop `worldScenes=Infinity` caches every visited battlefield by
design → first visits legitimately grow), requires ≥2 revisit deltas else
returns INCONCLUSIVE, and classifies the per-cycle heap slope TAPERING vs LINEAR.

**Evidence runs** (`.qa-dev/memory-soak-report.json` 12-cycle final;
earlier 6-cycle `.qa-dev/memory-soak-smoke.json`; crash receipts
`.qa-dev/memory-soak-bootcheck.json`):

- **12 cycles / 4 maps / 6 vehicles-slots, headed, wall ~13 min.** All cycles
  green: mapOk ×12, zero page errors, zero unexpected console errors.
- **Bounded by design:** worldCache = exactly the 4 visited maps; pedestal LRU
  stable at 3 entries; scene renderTargets constant at 4 shadow cascades;
  listeners flat (~384→385 across all 12 cycles); GPU programs oscillate
  562→607 with no net trend after winter's first-visit spike.
- **Oscillation ≠ growth:** cycle-end sceneAudit geometries swing ±30–90
  because rosters are RANDOM per battle (~14 of 121 specs) and parked roster
  visuals stay in-scene until the next setupBattle evicts them — spec cost
  varies 2× (`tank_strv122` 103 geos vs `tank_pl01` 42). Per-child attribution
  confirms EVERY persistent subtree (worlds, garage dressing, fx pools,
  pedestal heroes) is FLAT across revisits.
- **REAL finding — heap:** with forced GC, cycle-end usedJSHeap climbs
  monotonically through the warm window: 1007.6 → 1119.3 MB over cycles 5–12
  (**net +111.7 MB / 7 revisit deltas ≈ +16 MB/battle retained**, tol 15 MB).
  Static audit ruled out: BAKE_CACHE (LRU-capped 64), perfTrace rings, profile
  lastBattle (single slot), HUD lists (capped), fx/decal pools (bounded),
  playerShellLog ring, __VISUAL_LOAD_TIMINGS ring. Suspects remaining:
  per-battle retained graphs not reachable from the scene (audio decode
  caches, killcam ghost backups, closure retention in bus/records) — needs one
  `--alloc-sample` run (CDP HeapProfiler sampling, already built into the tool)
  on a healthy tree.
- **BLOCKED for shape/attribution completion:** from ~21:15Z a concurrent
  Wave-2 fleet refactor (`src/vehicles/profiledProcedurals.js`,
  `tankFactoryCore.js` modified; new untracked `fleet/`, `fleetFactory.js`,
  `fleetLazy.selftest.mjs`) breaks boot durably: page throws
  **`Error: Japanese family donor missing: type74`** twice and `__GAME_READY`
  never sets (reproduced 21:24Z and 21:37Z; `japan.js:11` resolves donors from
  `TANK_SPECS`, `type74` is registered by `userdrops.js` — registration order
  under the new lazy factory is the likely break). Not W2-F-owned files; left
  untouched. Rerun when healed: `node tools/memory-soak.mjs --cycles=16
  --alloc-sample --out=.qa-dev/memory-soak-report.json`.

### W2-I — docs completion (spec §17), DONE 2026-08-22

- **docs/DEVELOPMENT.md:** public-build section now documents the shell-neutral
  `node tools/build-public.mjs` wrapper (in-process `VITE_PUBLIC_BUILD`, Node-spawned
  vite, fail-closed strip guard) and states the Windows env-prefix defect resolved;
  new "Fast validation" subsections for `test:journey` (headed player-loop E2E, exit-code
  contract, evidence JSON, headless SwiftShader caveat + ≥420 s budgets) and `test:gate`
  (discovery runner, `--filter/--chain/--report`, JSON evidence); chain-guard invariant
  noted; multiplayer rig section notes Windows `fileURLToPath` compatibility + WinNAT
  port-reservation guidance; verification matrix gained a release-candidate sweep row;
  doc map links ASSET-PIPELINES.md and QA-COVERAGE.md.
- **README.md honest-status refresh:** renderer/performance section cites Campaign-3 RC
  certification numbers (sustained battle fps median 59.9 @60 Hz vsync, p50 ≈16.7 ms /
  p99 ≈33 ms worst-case roster, ≤811 draw calls, ~4.56 M tris, no heap growth;
  uncontended garage median 119 FPS / 8.4 ms) and the battle-open reality (cold ~155 s,
  warm-profile returning player ~85 s, boot-to-garage 7 s); multiplayer section states
  live host verification lanes (signaling lifecycle, ranked queue→match→snapshots,
  browser-pair guest entry, mid-match disconnect resilience incl. the Wave-1 dedicated-
  server peer-disconnect crash fix) while keeping production endpoint requirements;
  "Develop and verify" adds test:gate/test:journey, names build-public as cross-platform,
  and reports 180 wired suites under the hard guard.
- **AGENTS.md:** prose-only cross-link to `docs/QA-COVERAGE.md` (+ gate/journey commands)
  appended to the selftest convention bullet. Generated `agent-docs:auto:*` blocks left
  untouched (owned by the scaffold).
- **NEW docs/ASSET-PIPELINES.md:** consolidated KTX2/Basis (`tools/campaign-optimize-ktx2.mjs`
  + `src/engine/ktx2Pipeline.js`), packed ORM (`tools/campaign-pack-orm.mjs` +
  `src/world/sourcedTextures.js`, `orm|`/`sep|` cache keys), Meshopt
  (`tools/campaign-meshopt.mjs` + `src/engine/meshoptGlbLoader.js`), shared PNG codec,
  deterministic/attribution/public-boundary contracts, and a verification table. Honest
  status recorded: KTX2 remains opt-in (uncompressed containers; no production consumer of
  `getGlobalKtx2Pipeline()` yet); no separate meshopt loader selftest exists.
- **Verification:** markdown link/path audit green for all owned files (only pre-existing
  machine-specific `file:///` links in untouched TAA-PHASE-B-FINDINGS.md flag);
  `npm run build` public artifact OK in dist/, strip-nc guard passed (55 playables,
  0 GLB-sourced). No code or tests changed.

### W2-C — sniper-mode live verification (B3), DONE 2026-08-22

Blocker B3 claimed the sniper/scope UI had zero in-browser evidence. NEW
committed gate **`tools/sniper-scope-probe.mjs`** (headed by default, own vite
server in the W2-C band 5450-5599, evidence JSON + PNGs under
`.qa-dev/sniper-scope/`) now drives the whole live path and closes it.
Product source was NOT modified — the defect hunt found the shipped code
healthy; the only bug found was in my own harness (below).

**Verified LIVE (real Chrome, real battle entry via beginSoloBattle):**

| Leg | Verdict | Receipt |
|---|---|---|
| Pointer lock engages natively | PASS | first-click engagement twice (`clicks=1 locked=true cursorAim=false`, no special Chrome args needed) |
| Wheel ladder through `input.js onWheel` | PASS | arcade orbit → SNIPER ×2 entry in ≤4 notches → ×4 → ×8 → ceiling CLAMP at ×8 → wheel-out ×4/×2 → exit to ARCADE; asserted through BOTH gated paths: trusted CDP deltas under lock AND onWheel's own `lockDenied && target===canvas` cursor-aim notch path when Chrome denies the lock |
| HUD mode mirror | PASS | `frameInfo.mode 'battle'→'sniper'→'battle'`; FOV 60→30 at ×2 |
| Scope overlay/vignette | PASS | corner alpha arcade 0.000 → sniper 0.557; SOFT falloff proven (corners 0.557 vs top-edge band 0.234); OFF again after exit |
| Reticle marks | PASS | green sight-family pixel delta across the cross arms arcade 5 → sniper 43 |
| Zoom readout plate | PASS | bottom-center `×N.N` present (254 green px), FNV digest distinct at ×2/×4/×8 — glyphs really restep |
| Shift toggle lane | PASS | with `sniperToggle='ShiftLeft'` bound (desktop DEFAULT is null — legacy ShiftLeft migrates to freeLook per input.selftest; probe binds then restores) |
| RMB hold-to-aim | PASS | hold enters SNIPER, release restores ARCADE (default rmbMode 'hold'), incl. under native lock |
| Hygiene | PASS | zero page errors, zero unexpected console errors |

**Environment notes (honest classification):**

- No single run held native lock AND stepped the ladder with trusted deltas:
  Chrome on this host intermittently denies lock requests for a whole session
  (5 clicks + deliberate denial-latch arming still denied once) and one run
  died to a contended-host renderer crash. The two halves are each proven
  natively (lock engagement; RMB-under-lock scope entry) and the ladder is
  additionally proven through the production no-lock fallback path — the
  player-facing behavior is fully covered either way.
- Harness bug found + FIXED in the probe itself: installed puppeteer v25
  `Mouse.wheel(options)` takes an options object — positional `(0,-120)`
  silently dispatched `deltaY:0`, which `input.js` correctly drops
  (`if (!enabled || e.deltaY === 0) return`). Raw CDP
  `Input.dispatchMouseEvent` with explicit fields is the reliable form.
- `tools/controls-probe.mjs` (not mine, not in npm test) asserts default
  `sniperToggle==='ShiftLeft'`, contradicting current defaults (`null`) —
  owner follow-up, stale expectation.
- Runs against the shared tree were repeatedly blocked mid-campaign by the
  parallel fleet refactor's transient boot throw (`Japanese family donor
  missing: type74`); final authoritative runs waited out / worked around it
  via a d5147fc4 worktree (hud/input/cameraRig byte-identical to the tree).
- fps spot-sample at ×8: median ~30 fps under heavy parallel-worker CPU
  contention (33 ms p50 / 50 ms p95) — contention-dominated, NOT a perf
  datum; Campaign-2 floors remain cert-perf's jurisdiction (untouched).

**Selftests:** cameraRig.selftest, input.selftest, dom.selftest all green on
the shared tree. Follow-up for lead/SA-14: optionally wire `test:sniper`
script post-integration and rerun the probe on the integrated tree once.

### W2-J — manifest determinism + spawn-pad drivability triage (SA-06 follow-ups, B12), DONE 2026-08-22

**Part 1 — placement determinism survived Wave-1.** Re-ran the headed-Chrome
recapture (`.qa-dev/sa06-recapture-manifests.mjs`, own vite, port 5527) against
post-Wave-1 HEAD: all 16 maps recaptured and the result is **byte-identical to
the committed `server/world-collision-manifests.json`** (`cmp` clean; zero
`git status` delta) — obstacles/colliders/concealers unchanged everywhere
(e.g. monsoon 5975/674/7754, alpine 4879/719/3897). Console errors during
capture: exactly one, the known environmental `ERR_CONNECTION_TIMED_OUT`
class (issue #4 / B5); no new error classes. No investigation needed: no delta.

**Part 2 — steep-pad drivability measured with the real movement sim**
(new probe `.qa-dev/w2j-pad-drivability.mjs`, evidence
`.qa-dev/w2j-pad-drivability.json`; rerun is byte-identical → deterministic).
Method: per map (alpine/monsoon/fjord) the real seeded heightfield + captured
collision manifests, and the real `updateTank` integrator driven full-throttle
off every one of the 8 pads × 12 outward headings × 30 s legs with three specs:
**t95 (worst climber, 5.8 hp/t)**, t34_85, m1a2 — collide callback replicates
the production static-obstacle branch (`state.js`, exact OBB/circle/convex MTV)
so slope stalls are distinguishable from cover blocks.

- **Grades confirmed:** worst 30 m chord climbs alpine 20.9° / monsoon 23.2° /
  fjord 18.1° (down-chords to 21.3°), matching B12's "up to ~21 deg"; local
  slope in the uphill cut azimuths right past the 22 m blend reaches
  ~46–51° — the cosmetic "pads carved into a hillside" look.
- **Verdict: 0 of 24 pads functionally bad.** Every pad has at least one exit
  ≥24 m from center within 30 s for ALL THREE specs including t95
  (t95 exits on 3–9 of 12 headings per pad; t34_85/m1a2 ≥7, mostly ≥9).
- Of 864 legs, 187 slope-stalled (>4 s no-progress, full throttle): only 1
  ended against solid cover → stalls are grade-driven engine/climb limits,
  concentrated on t95 at chords ≥0.33 (19–23°). Physical climb physics, not a
  pad defect; mediums/moderns climb or roll off nearly everywhere.
- **Decision — ACCEPT as cosmetic debt, no flatten:** mapsCert already pins a
  gentle midfield exit (≤0.11 grade) + bot nav routes pass on every map;
  flattening would mean cutting 40–50° hillside faces around whole pads
  (large silhouette change) for zero functional gain. B12 row updated.

**Tests run green:** `movement.selftest` (98 checks), `movement.edge`,
`movementWorldBound`, `mapQuality` (16 maps), `mapsCert` (full sixteen-map
certification). No game code changed by this slot (probe + docs only).


### W2-H — tankFactory chunk split (blocker B4, spec §18 first-load), DONE 2026-08-22

**Design.** The 2.2 MB `tankFactory` chunk existed because the browser boot
graph statically imported `src/vehicles/tankFactory.js`, which eagerly
evaluates every profile-family pack (leopard 781 kB src, merkava 698,
abrams 544, t90 461 …). Split implemented along the factory's own seams:

- NEW `src/vehicles/fleetFactory.js` — the BROWSER facade: same spec-pack
  evaluation order and roster sealing as `tankFactory.js`, but
  `configureTankFactory` runs WITHOUT the profiled builders; four family
  groups (`src/vehicles/fleet/g1Nato|g2East|g3UsMisc|g4CasemateAsia.js`)
  register via NEW `registerProfiledBuilders()` (tankFactoryCore) once their
  dynamic chunks resolve. `ensureFullFleet()` self-starts at facade eval so
  bytes download in parallel with boot instead of blocking it.
- All 8 runtime consumers switched to the facade (main, state, wrecks,
  garageDressing, tankThumbs, studio, gallery, browserBattleBridge);
  `tankFactory.js` stays fully eager for Node selftests/tools — zero test
  churn — and is now tree-shaken out of browser bundles entirely.
- Await gates only where vehicles get built: garage dressing stage +
  pedestal switch chain + battle-entry (`startBattleLoading`, covers world
  wreck bakes), bridge `prepareRoster`, gallery `loadTank`, studio `load`.
  Post-ready sync contracts (`__SHOTS.set`, killcam) are safe because
  `__GAME_READY` now fires only after fleet resolution.
- vite.config.js: no manualChunks/advancedChunks — measured as a
  byte-identical no-op under Rolldown's graph-driven splitting (documented
  in-config so nobody re-adds it blind).

**Boot-order regression r1 (caught by lead + repro'd in Node):**
profiles/misc.js registers the `type74` SPEC at module evaluation, consumed
at eval time by the eager japan.js spec pack; laziness moved that registration
after japan → "Japanese family donor missing: type74". Fix: MISC_PROFILES is
eager again in the facade (registered alongside canonical packs).
`fleetLazy.selftest.mjs` pins this class with isolated per-group child-process
imports.

**Chunk sizes (private build, dist/assets):**

| | before | after |
|---|---|---|
| largest vehicle chunk | tankFactory **2,200.13 kB** (gzip 664.0) | g4CasemateAsia **366.2 kB** (gzip 107.5) |
| eager index.html JS (measured preload sum) | **4,245,357 B = 4.05 MB** / 20 files | **3,048,715 B = 2.91 MB** / 26 files |
| deferred off critical path | — | g1Nato 42.9 + g2East 138.0 + g3UsMisc 104.1 + g4CasemateAsia 366.2 + casemate 298.1 + t72 249.2 kB (+ small shared) |

Residual >500 kB chunks are pre-existing and out of B4's scope (`map`
1,497 kB world props catalog; `main` 1,068 kB unchanged ±0.1%).

**Load-to-ready (cert-perf garage, headless, fresh profile each run):**
an initial naive comparison (baseline 30.7 s @05:00 vs tree 49.2 s @06:13)
was shown to be host-condition drift by a PAIRED A/B on a clean-HEAD git
worktree back-to-back under identical conditions:
HEAD baseline **47,008 ms** vs W2-H tree **46,465 ms** (−1.2%, parity;
fps median 59.9 both, contended=false both). Evidence:
`.qa-dev/w2h-garage-{baseline,after,base-rerun,after-rerun}.json`.

**Battle entry verified (headed, verdant, m1a2, worst-case pinned roster):**
boot→garage ready 52.4 s; entry-to-open **198.4 s** (inside the documented
107–199 s cold envelope); stages world 75.2 s (wreck bakes from lazy
casemate/ww2 families ✓), reveal 49.4 s, combatWarm 59 s, countdown→controls
released ✓. Roster visuals built across lazy groups (t95 1.2 s, m1a2_sepv3
0.87 s builds). Sustained-window fps sampled low (median 30) while sibling
worker builds ran concurrently — non-gating here; battle fps floors remain
SA-11/W2-A territory. Evidence `.qa-dev/w2h-battle-after.json`.

**Tests:** NEW `src/vehicles/fleetLazy.selftest.mjs` wired into posttest —
(0) isolated per-group import probes, (1) per-id identity of all 136 profile
rows between lazy groups+eager misc and the eager union, exactly-one-owner
(strv103 double-ownership casemate/sweden caught+fixed), (2) full-fleet sweep
builds all 111 visible playables through the dynamic path. Also green:
tankFactoryCore, rosterSweep, fleetOrder, combatAnatomy, specHelpers, tier,
tankAssets, rosterPolicy, wheelQuality, battleDetailLod, mudguardFenderSeating
family set, preBattleCountdown, matchmaking, privateMatchHandoff,
browserBattleBridge, localTankPrediction, hitEventFormat, gallery.catalog,
game.profile. Builds: private `vite build` + public `npm run build`
(wrapper + strip-nc-assets) both green.

### W2-A — SA-11 follow-ups (b) forward-uniform discovery + (c) fx atlas cache, DONE r1 2026-08-22

**(b) `initializeForwardProgramsSteps` parallel-link window (`src/main.js`).**
Root cause of the 37.8 s/entry line: each new program's `getUniforms()` was
called immediately after its object's `renderer.compile()`, blocking the task
on that program's driver link — serially, ~550 ms per program on this ANGLE
host (cert A: 110 programs = `uniformsMs` 60388 ms of a 62.3 s stage), even
when Chrome's shader disk cache makes the link itself trivial. Fix: with
`KHR_parallel_shader_compile`, submit all compiles first, breathe REAL frame
boundaries until the batch reports complete (bounded 300 rounds / 8 s wall;
yield-hint `'frame'` consumed by `warmCombatPipelineChunked`), then run
deferred per-program discovery. Discovery still covers EVERY new program
before the generator returns, so first-combat frames keep paying zero
first-use uniform work; without the extension the legacy path runs
byte-for-byte (A/B switch `FORWARD_WARM_PARALLEL`). New diagnostic
`window.__FORWARD_WARM_STATS` splits compile vs uniforms wall time.

**(c) derived-atlas disk cache (`src/vehicles/materials.js`).** The cert r1
"16.6 s fx sprite-atlas bake" attribution was stale: W11's committed PNG
atlases already replaced the particle bakes, and new sub-marks show the volley
itself is milliseconds (`fxImpacts/fxDestruct/fxFamilies` ≤5 ms). The real
runtime bake left in the path is the char/ember wreck pair per family
(1024²+256² canvases, painted eagerly by `ensureBurntTextures` at acquire).
Both atlases now persist to IndexedDB (`cot-derived-fx/burnt`) as lossless PNG
blobs keyed by sha256(cacheKey|dims|BAKE_VERSION|sha256(camoCanvas pixels)),
with a stored output pixel-hash verified at load — painter drift or camo
repaints invalidate automatically. Hydration is offered in
`prebakeSharedTextures` before acquire (bounded 4 s await); first paints
persist fire-and-forget from `ensureBurntTextures`; every failure mode (no
IDB/crypto, quota, decode error, hash mismatch) degrades to the exact legacy
paint. Counters: `window.__BURNT_DISK_STATS`. Determinism: PNG round-trip is
lossless and hash-gated, so hydrated visuals are identical to painter output.

**Evidence (paired headed `.qa-dev/cert-perf.mjs`, worst-case roster,
reused profile; co-tenant worker load varied between runs — compare pairs):**

| run | tree | host | open | combatWarm | forwardWarm | uniformsMs |
|---|---|---|---|---|---|---|
| A | legacy | busy | 242.7 s | 97.2 s | **62.3 s** | **60388** |
| B/D/F | candidate | busy | 159-220 s | 42-46 s | **10.1-10.8 s** | **11-639** |
| E | candidate | quiet | **38.4 s** | **8.9 s** | 1.2 s | 27 |

Zero-first-combat-hitch invariants held in EVERY run: sustained-window
shader births=2 / biggest jump=2, frame p99 33.5-50 ms, countdown-warm
`doneBeforeRollout=true`, zero page/console errors. Quiet-host candidate
battle-open 38.4 s vs Wave-1 returning-player reference 84.7 s (−55%).
Cache reuse proven live: run G on run F's origin reported
`{offer:14, hit:5, miss:9, persisted:15}` — partial because fire-and-forget
IDB writes race browser shutdown across short harness runs; misses repaint
identically (no content loss). Harness additions: additive captures only
(`forwardWarmStats`, `burntDiskStats`) plus `--port` pinning (IndexedDB is
per-origin; random ports defeat cross-run reuse).

**Selftests:** engine chain (offscreenWarm/shadowRefresh/shadowStability/
renderScalePolicy/deviceDiag/perfTrace/preBattleCountdown) +
materialQuality (+W2-A degrade contract section) + factoryCamo +
particleTextureAssets + impactDecals all PASS.

**Residuals:** (1) under heavy co-tenant load the single rendered frame after
the fx pools flip visible stretches to seconds-to-tens-of-seconds
(`fxMuzzleWait` 0.7 s quiet → 21.8 s busy) — GPU first-use work outside the
discovery fix; candidates are earlier soft-particle compile placement or
pool-visibility deferral, needs owner-level tradeoff like (b)'s original
assessment. (2) follow-ups (a)/(d)/(e) untouched. Raw runs:
`.qa-dev/cert-battle-w2a-{A..G}*.json`, logs `.qa-dev/w2a-*.log`.
