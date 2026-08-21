# QA Coverage Map & Release Gate — SA-14 (Campaign 3, 2026-08-22)

Status at `ff4708af` + Campaign 3 Wave 1: **180/180 selftests wired** (175
git-tracked + 5 uncommitted worker outputs), enforced by a hard guard. The
suite now has three legs: Node logic selftests (`npm test`), the browser
player-journey E2E (`npm run test:journey`), and the one-command discovery
gate that runs both (`npm run test:gate`).

## Release gate entry points

| Command | Scope | Needs display |
|---|---|---|
| `npm test` | pretest → test → posttest chains (187 steps) incl. wiring guard | no |
| `npm run test:journey` | headed Chrome E2E: boot → garage → solo battle → damage dealt → victory results → BATTLE AGAIN rematch → death leg → wreck exit | yes (headed) |
| `npm run test:gate` | every tracked-or-wired `*.selftest.mjs` via **discovery** (not a copied list), per-file timings, domain summary, JSON evidence to `.qa-dev/release-gate-report.json`, then the journey | yes |

The chains remain the canonical serial runner; the gate adds discovery,
reporting, and drift protection on top.

## Wiring invariant (the gate property)

`tools/selftestChainGuard.selftest.mjs` (in the `test` chain) fails the build
if any git-tracked `*.selftest.mjs` is missing from all three npm chains or if
a documented EXEMPT entry goes stale. Entering Campaign 3 there were **8
tracked strays that `npm test` silently never ran** (publicNav, publicCopy,
garageDossier, imagePreload, camoPolicy, factoryCamo, fleetOrder, genIcons) —
all verified green individually, then wired. This class of silent gap is now
impossible: adding a selftest without wiring it turns `npm test` red with an
actionable message.

## Coverage by game domain

Counts are selftest files per domain, all wired (mapper:
`.qa-dev/map-selftests.mjs`, transient tool):

| Domain | Files | Representative coverage |
|---|---|---|
| vehicles/fleet | 68 | profile geometry/fidelity closures, rosterPolicy, combatAnatomy, afvBalance, tier, markings, fleetOrder, rosterSweep |
| maps/world/cells | 21 | mapQuality contract, collision, propPlacement/cellPools/cellLifecycle, terrain grid/LOD/streaming, wrecks, topple, mapsCert (SA-06) |
| engine/render | 16 | deviceDiag, renderScalePolicy, shadowStability/Refresh, post/TAA core, resourceLifetime, ktx2 pipeline, perfTrace/gpuTimer probes |
| build/tools | 16 | campaign png/meshopt/ktx2/orm optimizers, duplicate audit, trace report, genIcons, chain guard |
| gameplay-sim | 15 | movement (+movementWorldBound SA-06), combat, spotting, autoloader, specialActions, botRoutePlanner, ai.aim, input, mobileAutoAim, matchLifecycle (SA-01) |
| garage/UI | 14 | dom, settingsControls, keyboardOwnership, touchControls, hudMagazine, endScreen math, garageOrder/Dossier, spectatorSwitcher, loadingScreens |
| net/server | 9 | protocol, lobby/handoff, adverse transport, prediction, signaling/dedicated match/rating/matchmaker/http, authoritative bots, pacing |
| battle-entry/lifecycle | 5 | preBattleCountdown, matchmaking, killcamGhostPolicy, presentationPose, authoritativeMatch |
| boot/loaders | 2 | loadingScreens, publicNav |
| other (audio/presentation/net misc) | 14 | voices, audioTiming, analytics, roomInvite, privateMatchHandoff, rankedServiceClient, … |

### Journey-level (E2E) coverage — the gap this wave closed

Before Wave 1 nothing drove a real browser through the player loop. Now
`tools/player-journey-probe.mjs` asserts, through public `__DEBUG` hooks only:

1. boot completes (`__GAME_READY`), phase = garage, zero page errors;
2. garage selection works (`selectGarageTank`) and the BATTLE button exists;
3. `beginSoloBattle` opens a full-roster battle with a live player (finite HP);
4. aim/fire loop lands shells (`playerShellLog` receipts);
5. `slayEnemies` → `victory` verdict → results overlay renders team rosters +
   BATTLE AGAIN button;
6. clicking BATTLE AGAIN returns to the garage and auto re-enters battle #2
   (fresh roster, cleared result);
7. death leg: `spawnKillShell` destroys the player through the real shell
   pipeline; leaving from a wreck lands back in the garage.

Evidence JSON per run: `.qa-dev/player-journey-report.json`.

## Headless battle-open — REVISED CLASSIFICATION (Wave 1 evidence)

Campaign doc issue #2 claimed headless Chrome "cannot complete battle-open"
on this host. **The player-journey probe DISPROVES that at the current
working tree**: on 2026-08-22 the identical journey passed **21/21 checks in
headless mode** (exit 0, `.qa-dev/player-journey-headless.json`).

Timings from the paired runs (same vehicle/map/seeded hooks):

| Stage | headed | headless | note |
|---|---|---|---|
| boot | 28.0 s | 38.2 s | garage-ready under SwiftShader |
| battle entry #1 (cold) | 138.1 s | **190.5 s** | exceeds Campaign-2's 180 s watchdog |
| combat→victory→overlay | 1.9 s | 2.5 s | deterministic sim: dmgOnPlayer identical (457.76) in both modes |
| rematch entry #2 (warm) | 42.2 s | 50.6 s | BATTLE AGAIN full loop |
| whole journey | 216.5 s | 297.4 s | |

Revised verdict:
- **NOT a GAME BUG** — the game completes the full journey headless.
- **Primary historical cause: HARNESS BUG (timeout budget)** — the Campaign-2
  diagnostic used `openTimeoutMs = 180_000`, *below* the real headless
  staging time (~190 s). The "renderer stall → frame detach" was the
  watchdog killing staging that would have succeeded.
- **Residual ENVIRONMENT LIMITATION** — headless Chrome reports `gpu:null`
  (SwiftShader); staging runs ~1.4× slower than headed. Workable, but E2E
  budgets must stay generous (this probe uses 420 s).
- Caveat: the old "reproduced identically at 970ef9e3" claim used the same
  tight-budget harness, so baseline-era evidence cannot distinguish
  then-slower code from the harness budget; irrelevant operationally —
  current tree completes both modes. CI hosts without a GPU should keep the
  420 s battle-entry budget or run headed.

## Adding a selftest (the only correct way)

1. Drop `myThing.selftest.mjs` next to the module (Node-runnable, DOM/WebGL-free).
2. Wire `node <path>` into package.json `pretest`/`test`/`posttest`.
3. Run `npm test` — the guard verifies you did step 2 (and fails otherwise).

Browser-dependent verification belongs in `tools/*probe.mjs` scripts (see
`bootgate-probe.mjs`, `player-journey-probe.mjs`); they stay out of the
default chains because they need a display and minutes of runtime.
