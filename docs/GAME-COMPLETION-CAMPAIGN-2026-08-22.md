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
4. Two non-fatal console error classes observed during captures: one `ERR_CONNECTION_TIMED_OUT` and two external-resource `403`s — root cause unknown (error-policy target).
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

## 3. Wave log
- **Wave 1** (16 slots, master workstreams above): DISPATCHED 2026-08-22, **COMPLETE 2026-08-22** — all 16 reported; full `npm test` exit 0 on the combined tree (139 wired suites); integrated as commits 425218c3..16fa80d4 (10 subsystem commits). Headline fixes: dedicated-match server crash on disconnecting peer (B1 CRITICAL resolved), NaN combat damage propagation, casemate rig seating ×4, three stacked-modal UI defects, XSS via player names, Windows build P0, cold battle-open −25 s. Journey E2E green 21/21 headed (verdant + desert) and headless.

## 4. SA-11 Performance Certification Evidence (Wave 1, vs ff4708af)

Raw runs `.qa-dev/cert-battle-*.json`, consolidated `.qa-dev/perf-cert-evidence-ff4708af.json` (builder `.qa-dev/build-cert-evidence.mjs`; harness `.qa-dev/cert-perf.mjs`). Headed battle only (headless battle-open is environmentally broken — issue #2). Pinned worst-case GLB roster; vsync-real pacing; Windows-aware contention stamp (`os.loadavg()` is dead on this host).

**Sustained battle (verdant, worst-case roster) — certified at ff4708af:** fps median **59.9** (60 Hz vsync), frame p50 ~16.7 / p95 ~20 / **p99 33.2-33.5 ms**, max stall 33.5-66.9 ms, draw calls ≤811 worst frame, triangles ~4.56 M median, heap retained +0.06 MB/s (no leak), shader births ≈2 in-window, scene textures ~199 MB, RTs 8 (4 shadow cascades + post chain). No C2 regression; the old 94.7 ms headed p99 reference used a random roster and a fresh profile.

**Battle-open attribution (issue #3), cold profile, r1/r2:** nav→ready 33-37 s (boot `post` stage = first composer render link storm: `postFirstRender` 18.9 s of it); entry total 146-199 s = world build+activate 20-32 s (**minimap capture binds ALL world programs in one task** on the `precompile:false` path — activate 15-26 s), player visual reveal 27-31 s, bot stream ~4.6 s, entry warm 79-119 s (**combatWarm** 74-114 s: forward-program uniform discovery 37.8 s + fx sprite-atlas bakes 16.6 s + hidden variants 9.8 s), countdown+hide ~5 s.

**Fix A implemented (src/main.js ensureWorld):** the subset cohort shadow-warm now also runs on the fast `precompile:false` battle path instead of letting the minimap capture absorb every first-use link. Cold A/B (r3 vs r2): battle-open nav→open **179.5 → 154.7 s (−24.8 s)**, roster stage −18.9 s; sustained fps/p99 unchanged; garage unchanged (r6 parity with C2). Engine selftests (offscreenWarm/shadowRefresh/shadowStability/renderScalePolicy/deviceDiag/perfTrace/preBattleCountdown) all PASS.

**Returning-player reality (new harness `--profile` reuse):** puppeteer's fresh temp profiles defeat Chrome/GPU-driver shader disk caches, so every probe run paid cold links that a real returning player never does. With a reused profile: boot-to-ready **27.7 → 7.1 s**, player reveal 23.4 → 1.1 s, world stage 29.6 → 4.2 s, battle-open **154.1 → 84.7 s**. Issue #3's "107-152 s" is therefore the COLD worst case; remaining warm cost (~62 s combatWarm) is deliberate C2 design (zero first-combat hitches) and is main-thread canvas/CPU bake work — shrinking it further requires owner-level tradeoffs (worker offload or accepting first-contact hitches), not quick fixes.

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
| B3 | **HIGH** | Sniper-mode UI never live-verified in-browser (needs pointer lock; outside journey probe coverage) | A core combat affordance verified only by code reading/selftests — silent breakage would ship undetected. |
| B4 | **HIGH** | Bundle size: chunk warnings >500 kB, `tankFactory` chunk 2.2 MB | First-load cost on real networks scales directly from this; needs code-splitting/lazy-load pass before RC. |
| B5 | **MEDIUM** | External-resource failures during captures: 1× `ERR_CONNECTION_TIMED_OUT` + 2× 403s (issue #4), root cause unknown | Non-fatal today but unknown-origin network errors in shipped builds are a reliability/error-policy liability. |
| B6 | **MEDIUM** | Stale `cot.gfxAutoTier` mid-session write not re-discarded until next boot | Graphics-tier mismatch persists silently for the whole session; users must reboot the game to clear a wrong tier. |
| B7 | **MEDIUM** | Touch/mobile layout verified by selftests only (no live device/headed-touch walk) | If mobile is a release surface, selftest-green ≠ layout-correct on a real viewport. |
| B8 | **MEDIUM** | SA-11 perf follow-ups (a)–(d): harness profile policy undecided; forward-program uniform discovery 37.8 s/entry; fx sprite-atlas bake 16.6 s; cold `postFirstRender` 18.9 s | Each is seconds-to-minutes of avoidable staging cost with an identified mechanism; grouped because they share the shader-compile/warm path. |
| B9 | **LOW** | Headless Chrome runs SwiftShader ~1.4× slower — CI/E2E budgets must stay ≥420 s or run headed (QA-COVERAGE revised issue #2) | Harness/environmental constraint, documented and worked around; zero player impact. |
| B10 | **LOW** | Stale long-lived Vite dev server on :5173 serves rotten HMR graph (issue #5) | Dev-environment hazard only; workers already instructed to spawn own servers. |
| B11 | **LOW** | Windows WinNAT reserves TCP 7185–7284 → EACCES for random-port tools (issue #6) | Host-specific tooling footgun; product port handling unaffected so far. |
| B12 | **LOW** | Steep spawn pads on alpine/monsoon/fjord (cosmetic geometry) | Visual/feel nit; spawns are functional per mapsCert. |
| B13 | **LOW** | SA-10 deferred-with-evidence: shadow-bias depth span, env-bake cloud IBL, fov-transition far-cascade staleness; perfprobe.mjs vestigial `__GLB_STATS` + Windows-blind contention guard | Deferred with evidence by owner workstreams; polish debt, not defects. |

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

