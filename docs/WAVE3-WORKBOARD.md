# CAMPAIGN 3 — FINAL WAVE WORKBOARD (2026-08-22)

Lead: ox-alpha (orchestrator). Starting SHA: `30a7e38d` (== origin/main last known).
Baselines: primary non-regression `ff4708af`, historical `970ef9e3`, pre-wave reference `30a7e38d`.
Concurrency budget: ~16 slots. Evidence root: `.qa-dev/w3/<worker>/`. Port bands per worker
(never 5173; avoid Windows-reserved 7185–7284).

## Release risks entering the wave

| ID | Risk | Owner |
| --- | --- | --- |
| R1/B14 | FX first-use staging: `fxMuzzleWait` 0.7 s quiet → 21.8 s contended | W01 |
| R2 | Battle-open latency: cold ~155-240 s, returning ~85 s, quiet-warm best 38.4 s | W01/W02/W03 |
| R3 | Memory soak truth: +16 MB/battle retained after GC unattributed | W04 |
| R4 | Final perf cert contaminated (30 fps co-tenant sample) | W05 |
| R5 | Deferred render/tool debt (shadow-bias, cloud IBL, FOV far-cascade, __GLB_STATS, Win-blind guard) | W09 |
| R6 | Campaign doc/matrix staleness | W15 |

## Phase 1 (dispatched 2026-08-22)

| Slot | Worker | Kind | Isolation | Mission (abbrev) | Status |
| --- | --- | --- | --- | --- | --- |
| W01 | b14-fx | impl | worktree | B14 GPU first-use elimination + telemetry contract + regression test | RUN |
| W02 | boot-post | impl | worktree | cold `postFirstRender` breakdown + safe reductions | RUN |
| W03a | loadpath-scout | recon | read-only | battle-open waterfall map + top-3 reduction plan (feeds W03b) | RUN |
| W04a | memsoak-analyst | recon | read-only | mine existing soak/heapprofile artifacts → retention-owner hypotheses | RUN |
| W05a | perf-harness | impl | main tree | harden `.qa-dev/cert-perf.mjs`: contention rejection, profile policy, promote to `tools/` | RUN |
| W06a | ai-cert-build | impl | main tree | build all-map AI live-cert harness (Node legs now, browser legs phase 2) | RUN |
| W07a | net-soak-prep | recon | read-only | verify net tooling runs on Windows today; runbook for full soak | RUN |
| W08a | audio-audit-build | impl | main tree | build audio/game-feel audit harness skeleton + checklist | RUN |
| W09a | gfx-debt | recon | read-only | quantify R5 items; fix-or-accept recommendations with evidence plans | RUN |
| W10 | asset-pipe | measure | offline | KTX2/Meshopt production-adoption verdict from real measurements | RUN |
| W11 | bundle-census | measure | offline | chunk census + clean split-boundary proposals; no gratuitous splits | RUN |
| W12 | controls-fix | impl | main tree | stale probe expectations (sniperToggle etc.) reconciled with defaults | RUN |
| W13a | fleet-visual-build | impl | main tree | stratified fleet visual sampler tool (~24 vehicles) ready for phase 2 | RUN |
| W14a | cleanprep | recon | read-only | clean-checkout/reproducibility checklist + what's untracked-but-needed | RUN |
| W16a | redteam-recon | recon | read-only | distrust-the-campaign review plan + static hunt on post-be5bf437 deltas | RUN |
| W15 | docs-reconcile | impl | main tree | reconcile campaign matrix vs evidence (draft; finalized at end) | RUN |

## Phase log

- **Phase 1 COMPLETE** (integrated commits 7ab783c4..3996cfa1): B14 FX precompile merged+tested; boot postFirstRender −94.5% (33.8s→1.85s) merged; asset verdicts (KTX2 defer/Meshopt keep); bundle census (no further splits); harness promoted with contamination rejection; controls probes reconciled; render debt C fixed/D+E retired; soak tool W04a protocol; doc matrix draft; red-team static clean (no P0/P1); AI fire-corridor defect FOUND+FIXED (launch-ray vs aimPoint divergence) + all-map Leg-A cert 69/80 (residuals → W06c).
- **Phase 2a RUNNING**: W03b battle-open reductions (worktree), W04b memory soak 16-cycle pinned+muted-split (R3 gate), W07b multiplayer runbook soak, W09c journey/mobile/sniper re-certs, W08b audio audit live, W13b fleet visual sweep (~24 vehicles), W06c AI residual closures.
- **Phase 2b** (queued): fleet-family expansions if W13b finds defects; net/journey follow-ups; B14+boot quiet-host verification runs.
- **Phase 3** (quiet host): perf A/B vs ff4708af cold+returning (wt-perfbase ready), independent final reviews A-D, docs finalization with real numbers, clean-worktree full gates, push.

## Integration rules

- No worker edits `package.json` — lead wires selftests/scripts during integration.
- Implementation workers land via isolated worktree branches; lead merges in order and re-runs affected selftests.
- All browser probes spawn their OWN vite server on assigned ports; never trust :5173.
- Perf-sensitive headed runs record contention stamps; contaminated runs are rejected, not explained away.

## Phase 1 progress log (append-only)

- W15 r1 landed: campaign doc header flipped to FINAL WAVE IN FLIGHT; §1 matrix rows 1-5,7-12,15,16 re-statused against commit evidence (`425218c3..30a7e38d`) with reconciliation note; §5 gained "Blocker final dispositions" table with `<<FINAL:B#>>` placeholder column; §8 Wave-3 skeleton + final-results ledger appended. Remaining `<<FINAL:*>>` tokens are intentionally unfilled until measured on the integrated tree.
