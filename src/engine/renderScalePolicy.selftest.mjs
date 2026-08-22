import assert from 'node:assert/strict';
import {
  AdaptiveBudgetCoordinator,
  aoSampleCount,
  baseDynamicScale,
  cappedPixelRatio,
  createAdaptiveBudgetCoordinator,
  dynamicScaleFloor,
  hierarchicalRecoveryLever,
  hierarchicalReliefLever,
  internalPixelRatio,
  OVERLOAD_RELIEF_STAGES,
  overloadReliefLever,
  RECOVERY_STAGES,
  reconstructionSharpness,
  resolveEffectiveAoScale,
  resolveEffectiveBloomScale,
  resolveEffectiveFxBudget,
  resolveEffectiveGrassBands,
  resolveEffectiveShadowLevers,
  resolveEffectiveTerrainStreamBudget,
} from './renderScalePolicy.js';
import {
  getBudgetCoordinator,
  getPreset,
  onBudgetAdjustment,
  resolveDeviceTier,
  resolveEffectiveQuality,
  taaRequested,
  texSize,
  PRESETS,
} from './quality.js';

// --- Pure render-scale and preset math tests ---------------------------------

const high = {
  maxPixelRatio: 1.5,
  adaptiveBasePixelRatio: 1.5,
  dynMin: 0.9,
};

assert.equal(cappedPixelRatio(2, high), 1.5);
assert.equal(baseDynamicScale(2, high), 1,
  'desktop High must start at its full configured density');
assert.equal(dynamicScaleFloor(2, high), 0.9);
assert.equal(internalPixelRatio(2, high, 0.75), 1.35,
  'desktop High must never fall back to the old muddy 1.125 ratio');

const ultra = { maxPixelRatio: 2, dynMin: 0.75 };
assert.equal(cappedPixelRatio(2, ultra), 2,
  'Ultra should reach native density on a DPR-2 display');
assert.equal(internalPixelRatio(2, ultra, 0.75), 1.5,
  'Ultra fallback must remain at least the full High ceiling');

const nativeDesktop = { maxPixelRatio: 1, dynMin: 0.75 };
assert.equal(dynamicScaleFloor(1, nativeDesktop), 1);
assert.equal(internalPixelRatio(1, nativeDesktop, 0.5), 1,
  'DPR-1 desktop output must not be softened below native CSS density');

const desktopFallback = { maxPixelRatio: 1, dynMin: 1 };
assert.equal(internalPixelRatio(2, desktopFallback, 0.5), 1,
  'desktop fallback tiers must not double-downscale below CSS density');

const mobile = {
  maxPixelRatio: 1.25,
  adaptiveBasePixelRatio: 1,
  dynMin: 0.6,
};
assert.equal(PRESETS.mobile.msaaSamples, 0,
  'balanced mobile must not allocate a multisampled half-float scene target');
assert.deepEqual(PRESETS.mobile.shadowMapSizes, [1024, 768, 512, 512],
  'balanced mobile shadows must retain a bounded resident footprint');
assert.equal(baseDynamicScale(2, mobile), 0.8,
  'mobile keeps its constrained starting density');
assert.equal(dynamicScaleFloor(2, mobile), 0.6,
  'mobile keeps its explicit memory/performance floor');

// --- Backward-compatible overloadReliefLever tests ----------------------------

assert.equal(overloadReliefLever(0, 1, 1, 0.9), 'trim',
  'AO/session trim must be the first overload response');
assert.equal(overloadReliefLever(1, 1, 1, 0.9), 'resolution',
  'resolution may move only after the trim is exhausted');
assert.equal(overloadReliefLever(1, 1, 0.9, 0.9), 'tier',
  'tier fallback owns overload after the readable floor');
assert.equal(overloadReliefLever(0, 0, 1, 0.6), 'resolution',
  'AO-free mobile presets proceed directly to their raster lever');

assert.equal(reconstructionSharpness(1), 0.12);
assert.ok(Math.abs(reconstructionSharpness(0.75) - 0.28) < 1e-12,
  'High retains the proven 0.28 RCAS recovery at a 75% input ratio');
assert.equal(reconstructionSharpness(0.5), 0.4,
  'larger Medium/Low reconstructions receive stronger but capped recovery');

assert.equal(aoSampleCount(1), 16,
  'full-res AO (ultra) keeps the 16-tap inspection profile');
assert.equal(aoSampleCount(0.99), 16, 'the full-res boundary is inclusive');
assert.equal(aoSampleCount(0.5), 8,
  'half-res AO leans on temporal accumulation instead of fresh taps');
assert.equal(aoSampleCount(0), 8,
  'disabled AO still reports the accumulation profile (pass is skipped)');

// --- Hierarchical Overload Response & Recovery Stages -------------------------

assert.deepEqual(OVERLOAD_RELIEF_STAGES, [
  'fx', 'vegetation', 'shadows', 'post', 'resolution', 'tier',
], 'hierarchical overload stages order is strictly defined');

assert.deepEqual(RECOVERY_STAGES, [
  'resolution', 'post', 'shadows', 'vegetation', 'fx',
], 'hierarchical recovery stages order is strictly defined');

{
  // Step-by-step hierarchical overload progression:
  // 1. Optional/secondary FX -> 2. Distant detail/vegetation -> 3. Shadow complexity ->
  // 4. Post-processing quality -> 5. Internal render scale -> 6. Tier demotion.
  const maxTrims = { maxFxTrim: 1, maxVegetationTrim: 1, maxShadowTrim: 1, maxPostTrim: 1 };
  const floor = 0.9;

  // Initial: everything untrimmed, resolution at 1.0
  let state = { fxTrim: 0, vegetationTrim: 0, shadowTrim: 0, postTrim: 0 };
  assert.equal(hierarchicalReliefLever(state, maxTrims, 1.0, floor), 'fx',
    'Stage 1: optional/secondary FX shed first');

  // After FX trimmed
  state.fxTrim = 1;
  assert.equal(hierarchicalReliefLever(state, maxTrims, 1.0, floor), 'vegetation',
    'Stage 2: distant detail & vegetation shed next');

  // After vegetation trimmed
  state.vegetationTrim = 1;
  assert.equal(hierarchicalReliefLever(state, maxTrims, 1.0, floor), 'shadows',
    'Stage 3: shadow complexity shed next');

  // After shadow trimmed
  state.shadowTrim = 1;
  assert.equal(hierarchicalReliefLever(state, maxTrims, 1.0, floor), 'post',
    'Stage 4: post-processing quality (AO/bloom) shed next');

  // After post trimmed
  state.postTrim = 1;
  assert.equal(hierarchicalReliefLever(state, maxTrims, 1.0, floor), 'resolution',
    'Stage 5: internal render scale steps down after all trims exhausted');

  // Resolution at floor
  assert.equal(hierarchicalReliefLever(state, maxTrims, 0.9, floor), 'tier',
    'Stage 6: tier demotion owns overload after resolution hits floor');

  // Presets without post AO (e.g. low or mobile-low with maxPostTrim = 0) bypass post stage
  const noPostLimits = { maxFxTrim: 1, maxVegetationTrim: 1, maxShadowTrim: 1, maxPostTrim: 0 };
  const noPostState = { fxTrim: 1, vegetationTrim: 1, shadowTrim: 1, postTrim: 0 };
  assert.equal(hierarchicalReliefLever(noPostState, noPostLimits, 1.0, floor), 'resolution',
    'bypass post stage when preset carries no AO');
}

{
  // Step-by-step recovery progression (reverse order: resolution -> post -> shadows -> vegetation -> fx -> nominal)
  let recState = { fxTrim: 1, vegetationTrim: 1, shadowTrim: 1, postTrim: 1 };
  let dynScale = 0.9;

  // Resolution recovers first
  assert.equal(hierarchicalRecoveryLever(recState, dynScale), 'resolution',
    'recovery prioritizes structural render resolution first');

  // Resolution restored to 1.0
  dynScale = 1.0;
  assert.equal(hierarchicalRecoveryLever(recState, dynScale), 'post',
    'recovery restores post-processing quality second');

  recState.postTrim = 0;
  assert.equal(hierarchicalRecoveryLever(recState, dynScale), 'shadows',
    'recovery restores shadow complexity third');

  recState.shadowTrim = 0;
  assert.equal(hierarchicalRecoveryLever(recState, dynScale), 'vegetation',
    'recovery restores distant detail & vegetation fourth');

  recState.vegetationTrim = 0;
  assert.equal(hierarchicalRecoveryLever(recState, dynScale), 'fx',
    'recovery restores optional/secondary FX fifth');

  recState.fxTrim = 0;
  assert.equal(hierarchicalRecoveryLever(recState, dynScale), 'nominal',
    'system reaches nominal when all trims are zero and resolution is 1.0');
}

// --- Effective Lever Resolvers -----------------------------------------------

{
  const testPreset = {
    grassMidFadeEnd: 180,
    grassTaperEnd: 155,
    shadowCasterMinTexels: 0.75,
    shadowFarInstanceBudget: 4096,
    terrainStreamBudgetMs: 1.25,
    aoScale: 0.5,
    bloomScale: 0.6,
  };

  // Grass bands
  assert.deepEqual(resolveEffectiveGrassBands(testPreset, 0), { grassMidFadeEnd: 180, grassTaperEnd: 155 });
  assert.deepEqual(resolveEffectiveGrassBands(testPreset, 1), { grassMidFadeEnd: 135, grassTaperEnd: 116 },
    'vegetation trim pulls in grass fade bands by 25%');

  // Shadow levers
  assert.deepEqual(resolveEffectiveShadowLevers(testPreset, 0), {
    shadowCasterMinTexels: 0.75, shadowFarInstanceBudget: 4096,
  });
  assert.deepEqual(resolveEffectiveShadowLevers(testPreset, 1), {
    shadowCasterMinTexels: 1.125, shadowFarInstanceBudget: 2662,
  }, 'shadow trim increases caster cull threshold and prunes far budget');

  // Terrain streaming budget
  assert.equal(resolveEffectiveTerrainStreamBudget(testPreset, 0), 1.25);
  assert.equal(resolveEffectiveTerrainStreamBudget(testPreset, 1), 0.75,
    'vegetation trim throttles terrain streaming budget');

  // AO & Bloom
  assert.equal(resolveEffectiveAoScale(testPreset, 0), 0.5);
  assert.equal(resolveEffectiveAoScale(testPreset, 1), 0, 'post trim disables AO');
  assert.equal(resolveEffectiveBloomScale(testPreset, 0), 0.6);
  assert.equal(resolveEffectiveBloomScale(testPreset, 1), 0.42, 'post trim scales bloom');

  // FX Budget
  assert.deepEqual(resolveEffectiveFxBudget(0), {
    admittedFraction: 1.0, columnPuffsMax: 4, dustAdmitted: true, heavyCredits: 2,
  });
  assert.deepEqual(resolveEffectiveFxBudget(1), {
    admittedFraction: 0.6, columnPuffsMax: 2, dustAdmitted: false, heavyCredits: 1,
  }, 'FX trim sheds secondary emitters and dust volume');
}

// --- AdaptiveBudgetCoordinator Tests (Hysteresis, Windows, Cooldowns) --------

{
  let demoteCalled = false;
  const coordinator = createAdaptiveBudgetCoordinator({
    targetMs: 8.5,
    budgetMaxMs: 34.0,
    intervalS: 1.5,
    warmupS: 3.0,
    trimStrikesMax: 2,
    tierStrikesMax: 4,
    onTierDemote: () => {
      demoteCalled = true;
      return true;
    },
  });

  const testPreset = { ...PRESETS.high };
  coordinator.reset(testPreset, 2.0);

  assert.equal(coordinator.dynamicScale, 1.0);
  assert.equal(coordinator.fxTrim, 0);
  assert.equal(coordinator.vegetationTrim, 0);
  assert.equal(coordinator.shadowTrim, 0);
  assert.equal(coordinator.postTrim, 0);

  // 1. Warmup period: frames within the first 3 seconds do NOT trigger decisions
  for (let i = 0; i < 100; i++) {
    coordinator.recordFrame(0.025, false, testPreset, 2.0); // 100 * 25ms = 2.5s (within 3s warmup)
  }
  assert.ok(coordinator.clock <= 3.0, 'clock is within warmup period');
  assert.equal(coordinator.fxTrim, 0, 'no trims during warmup');

  // 2. Drive overloaded frames to trigger Stage 1 (FX trim) via 2 consecutive overloaded windows
  // Reset coordinator clock past warmup to test decision windows directly
  coordinator.reset(testPreset, 2.0);
  coordinator.clock = 4.0;
  coordinator.lastDecision = 4.0;

  // Window 1: Overloaded frames (40 frames * 40ms = 1.6s on 8.5ms budget)
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.equal(coordinator.trimStrikes, 1, 'first overloaded window records strike 1');
  assert.equal(coordinator.fxTrim, 0, 'hysteresis prevents shedding on single strike');

  // Window 2: Second overloaded window
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.equal(coordinator.fxTrim, 1, 'two consecutive overloaded windows shed Stage 1 (FX)');
  assert.equal(coordinator.vegetationTrim, 0);

  // Window 3 + 4: Overload continues -> Stage 2 (Vegetation trim)
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.equal(coordinator.trimStrikes, 1);
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.equal(coordinator.vegetationTrim, 1, 'Stage 2 (Vegetation) shed after next strikes');

  // Window 5 + 6: Stage 3 (Shadows trim)
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.equal(coordinator.shadowTrim, 1, 'Stage 3 (Shadows) shed');

  // Window 7 + 8: Stage 4 (Post trim)
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.equal(coordinator.postTrim, 1, 'Stage 4 (Post-processing) shed');

  // Window 9: Stage 5 (Internal render scale reduction)
  for (let i = 0; i < 40; i++) coordinator.recordFrame(0.040, false, testPreset, 2.0);
  assert.ok(coordinator.dynamicScale < 1.0, 'Stage 5 (Render scale) steps down');
  assert.ok(coordinator.dynamicScale >= 0.9, 'Render scale respects preset dynamic floor');

  // Telemetry check
  const tel = coordinator.getTelemetry(testPreset, 2.0);
  assert.equal(tel.fxTrim, 1);
  assert.equal(tel.vegetationTrim, 1);
  assert.equal(tel.shadowTrim, 1);
  assert.equal(tel.postTrim, 1);
  assert.ok(tel.frameEmaMs > 0);

  // 3. Recovery: feed clean frames (5.0 ms on 8.5 ms budget, 300 frames = 1.5s window)
  // Ensure recovery cooldown is observed between windows
  for (let i = 0; i < 300; i++) coordinator.recordFrame(0.005, false, testPreset, 2.0);
  assert.equal(coordinator.dynamicScale, 1.0, 'clean window restores resolution first');

  for (let i = 0; i < 300; i++) coordinator.recordFrame(0.005, false, testPreset, 2.0);
  assert.equal(coordinator.postTrim, 0, 'clean window restores post-processing second');

  for (let i = 0; i < 300; i++) coordinator.recordFrame(0.005, false, testPreset, 2.0);
  assert.equal(coordinator.shadowTrim, 0, 'clean window restores shadows third');

  for (let i = 0; i < 300; i++) coordinator.recordFrame(0.005, false, testPreset, 2.0);
  assert.equal(coordinator.vegetationTrim, 0, 'clean window restores vegetation fourth');

  for (let i = 0; i < 300; i++) coordinator.recordFrame(0.005, false, testPreset, 2.0);
  assert.equal(coordinator.fxTrim, 0, 'clean window restores FX fifth (nominal restored)');

  // 4. Anti-flap backoff test
  // An up-step immediately followed by a down-step within flap window (8s) doubles backoff cooldown.
  // The down-step must be the resolution lever, so re-arm the coarse trims first —
  // straight after full recovery they are all zero and the lever would stop at 'fx'.
  coordinator.forceTrim('fx', 1);
  coordinator.forceTrim('vegetation', 1);
  coordinator.forceTrim('shadows', 1);
  coordinator.forceTrim('post', 1);
  const initBackoff = coordinator.upBackoffS;
  coordinator.lastUpAt = coordinator.clock;
  coordinator.clock += 2.0; // within 8s flap window
  coordinator._applyOverloadStep(testPreset, 2.0);
  assert.ok(coordinator.upBackoffS > initBackoff, 'flapping increases recovery backoff cooldown');

  // 5. Backoff forgiveness test
  coordinator.clock += coordinator.backoffResetS + 1.0; // 61s later
  for (let i = 0; i < 300; i++) coordinator.recordFrame(0.005, false, testPreset, 2.0);
  assert.equal(coordinator.upBackoffS, coordinator.intervalS, 'quiet minute resets backoff cooldown');
}

// --- Coordinator control surface: suspension, pinning, forced trims ----------

{
  const preset = { ...PRESETS.high };
  const coord = createAdaptiveBudgetCoordinator({ warmupS: 0, intervalS: 0.1 });
  coord.reset(preset, 2.0);

  // Suspension freezes accounting entirely: no clock advance, no decisions.
  coord.setSuspended(true);
  for (let i = 0; i < 200; i++) coord.recordFrame(0.04, false, preset, 2.0);
  assert.equal(coord.clock, 0, 'suspended coordinator does not accumulate frame time');
  assert.equal(coord.winFrames, 0, 'suspended coordinator drops window frames');
  assert.equal(coord.getTelemetry(preset, 2.0).suspended, true,
    'telemetry reports the suspended state');
  coord.setSuspended(false);

  // QA pin owns the dynamic scale: windows still count (live telemetry) but
  // neither relief nor recovery may move the pinned value.
  coord.pinDynamicScale(0.95, preset, 2.0);
  assert.equal(coord.dynamicScale, 0.95, 'pin applies immediately');
  for (let i = 0; i < 100; i++) coord.recordFrame(0.04, false, preset, 2.0); // heavy overload
  assert.equal(coord.dynamicScale, 0.95, 'overload cannot move a pinned scale');
  assert.equal(coord.fxTrim, 0, 'pinned scale also suppresses coarse trim steps');
  coord.pinDynamicScale(null);
  assert.equal(coord.pin, null, 'null unpins and returns control to the governor');

  // forceTrim drives exactly its own stage's effective levers.
  const base = coord.getEffectiveLevers(preset, 2.0);
  coord.forceTrim('fx', 1);
  const fxD = coord.getEffectiveLevers(preset, 2.0);
  assert.equal(fxD.fxTrim, 1);
  assert.equal(fxD.fxAdmittedFraction, 0.6, 'fx trim sheds secondary emitters');
  assert.equal(fxD.vegetationTrim, 0, 'fx trim leaves vegetation untouched');

  coord.forceTrim('vegetation', 1);
  const vegD = coord.getEffectiveLevers(preset, 2.0);
  assert.ok(vegD.grassMidFadeEnd < base.grassMidFadeEnd,
    'vegetation trim pulls the grass mid-fade band in');
  assert.ok(vegD.terrainStreamBudgetMs < base.terrainStreamBudgetMs,
    'vegetation trim throttles terrain streaming');

  coord.forceTrim('shadows', 1);
  const shD = coord.getEffectiveLevers(preset, 2.0);
  assert.ok(shD.shadowCasterMinTexels > base.shadowCasterMinTexels,
    'shadow trim raises the caster cull threshold');
  assert.ok(shD.shadowFarInstanceBudget < base.shadowFarInstanceBudget,
    'shadow trim prunes the far-cascade instance budget');

  coord.forceTrim('post', 1);
  const postD = coord.getEffectiveLevers(preset, 2.0);
  assert.equal(postD.aoScale, 0, 'post trim disables AO outright');
  assert.equal(postD.aoEnabled, false, 'aoEnabled tracks the trimmed AO state');
  assert.ok(postD.bloomScale < base.bloomScale, 'post trim scales the bloom chain down');
  assert.equal(postD.reliefStage, 'resolution',
    'with every trim applied the next relief lever is resolution');

  // Unknown stages are ignored; values clamp into the [0, inf) integer domain.
  coord.forceTrim('nonexistent', 3);
  coord.forceTrim('fx', -2);
  assert.equal(coord.fxTrim, 0, 'forceTrim clamps values into the valid domain');

  // Telemetry mirrors the decision state as numbers (devtools/QA contract).
  const tel = coord.getTelemetry(preset, 2.0);
  for (const key of ['frameEmaMs', 'fps', 'fpsBaseline', 'budgetMs', 'dynamicScale',
    'renderScale', 'reliefStage', 'trimStrikes', 'tierStrikes', 'upBackoffS']) {
    assert.ok(key in tel, `telemetry exposes ${key}`);
  }
}

// --- Tier demotion path: strikes, callback, and reset-on-demotion ------------

{
  const preset = { ...PRESETS.high };
  let demotions = 0;
  const coord = createAdaptiveBudgetCoordinator({
    warmupS: 0,
    intervalS: 0.1,
    tierStrikesMax: 2,
    onTierDemote: () => {
      demotions++;
      return true; // pretend quality.reportSustainedOverload() stepped the tier
    },
  });
  coord.reset(preset, 2.0);
  // Exhaust every in-session lever first so overload resolves to 'tier'.
  coord.forceTrim('fx', 1);
  coord.forceTrim('vegetation', 1);
  coord.forceTrim('shadows', 1);
  coord.forceTrim('post', 1);
  coord.dynamicScale = dynamicScaleFloor(2.0, preset); // at the readability floor
  coord.clock = 9; // past the boot-protection gate (clock > 8)
  coord.lastDecision = 0;
  const overloadedWindow = () => {
    for (let i = 0; i < 40; i++) coord.recordFrame(0.04, false, preset, 2.0);
  };
  overloadedWindow();
  assert.equal(demotions, 0, 'one strike does not demote the tier');
  overloadedWindow();
  assert.equal(demotions, 1, 'sustained floor overload escalates to tier demotion');
  assert.equal(coord.fxTrim, 0, 'a successful demotion resets the coordinator state');
  assert.equal(coord.dynamicScale, 1, 'post-demotion state restarts from full scale');
}

// --- quality.js integration surface (singleton + effective levers) -----------

{
  // Singleton identity: every accessor shares one coordinator instance.
  const c1 = getBudgetCoordinator();
  const c2 = getBudgetCoordinator();
  assert.equal(c1, c2, 'getBudgetCoordinator returns the shared singleton');

  // onBudgetAdjustment subscribes to the singleton and receives notifications.
  let notes = 0;
  const unsubscribe = onBudgetAdjustment(() => notes++);
  c1.forceTrim('fx', 1);
  assert.ok(notes > 0, 'budget adjustments notify subscribers');
  unsubscribe();
  const notesAfter = notes;
  c1.forceTrim('fx', 0);
  assert.equal(notes, notesAfter, 'unsubscribe detaches the listener');

  // resolveEffectiveQuality combines preset data with live trims.
  const highPreset = { ...PRESETS.high };
  c1.reset(highPreset, 2.0);
  const nominal = resolveEffectiveQuality(highPreset, c1, 2.0);
  assert.equal(nominal.fxTrim, 0);
  assert.equal(nominal.aoScale, highPreset.aoScale,
    'nominal levers pass the preset AO scale through');
  assert.equal(nominal.renderScale, internalPixelRatio(2.0, highPreset, 1.0),
    'renderScale follows the same capped-ratio math as the composer');
  c1.forceTrim('post', 1);
  const trimmed = resolveEffectiveQuality(highPreset, c1, 2.0);
  assert.equal(trimmed.aoScale, 0, 'live post trim reaches the resolved AO lever');
  assert.equal(trimmed.reliefStage, 'fx',
    'reliefStage names the next lever in the hierarchy');
  // With every coarse trim applied, resolution is the next relief lever.
  c1.forceTrim('fx', 1);
  c1.forceTrim('vegetation', 1);
  c1.forceTrim('shadows', 1);
  assert.equal(resolveEffectiveQuality(highPreset, c1, 2.0).reliefStage, 'resolution',
    'fully trimmed state reports resolution as the next relief stage');
  c1.forceTrim('post', 0);
  c1.forceTrim('fx', 0);
  c1.forceTrim('vegetation', 0);
  c1.forceTrim('shadows', 0);

  // The singleton's demotion callback is wired into quality governance: it
  // steps the auto tier (Node: storage writes are no-ops, verdict is true)
  // and the resulting preset rebroadcast resets the coordinator.
  c1.forceTrim('fx', 1);
  assert.equal(typeof c1.onTierDemoteCallback, 'function',
    'singleton wires onTierDemote to reportSustainedOverload');
  assert.equal(c1.onTierDemoteCallback(), true,
    'auto-tier governance accepts the demotion request');
  assert.equal(c1.fxTrim, 0,
    'preset rebroadcast after demotion resets coordinator trims');

  // Wave-2 preset lever data integrity: every preset carries the five levers
  // statically consumed by vegetation.js / lighting.js / shadowRefresh.js /
  // shadowStability.js / terrain.js.
  for (const [name, p] of Object.entries(PRESETS)) {
    for (const key of ['grassMidFadeEnd', 'grassTaperEnd', 'shadowCasterMinTexels',
      'shadowFarInstanceBudget', 'terrainStreamBudgetMs']) {
      assert.ok(Number.isFinite(p[key]), `${name}.${key} is a finite number`);
    }
    assert.ok(p.grassMidFadeEnd >= p.grassTaperEnd,
      `${name} grass bands keep mid-fade beyond taper`);
    assert.ok(p.terrainStreamBudgetMs >= 0.5, `${name} keeps a workable stream budget`);
    assert.ok(p.shadowFarInstanceBudget >= 512, `${name} keeps a far-instance budget`);
  }
}

// --- W2-E PRESET CERT: shipped-ladder facts -----------------------------------

{
  // SA-12 gate pinned across the whole shipped ladder: TAA is opt-in ONLY via
  // an exact `taa === true` on a preset object — and no shipped preset defines
  // the key at all, so persisted state (a whitelist-validated NAME string)
  // can never flip the pass on. Truthy junk inherited onto a preset object
  // ('yes', 1) must stay off; strict equality is the contract.
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.equal(taaRequested(p), false, `${name} must not request TAA`);
    assert.equal(p.taa, undefined, `${name} carries no taa key`);
  }
  assert.equal(taaRequested({ taa: 'yes' }), false, 'truthy junk string stays off');
  assert.equal(taaRequested({ taa: 1 }), false, 'truthy junk number stays off');
  assert.equal(taaRequested({ taa: true }), true, 'positive control: exact true enables TAA');

  // dpr-2 effective internal composer ratios at each tier's NOMINAL dynamic
  // scale (baseDynamicScale): the ladder the cert probe measures live.
  const expectedDpr2 = {
    ultra: 2.0,
    high: 1.5,
    medium: 1.0,
    low: 1.0,
    mobile: 1.0,
    'mobile-low': 0.78,
    'mobile-high': 1.1,
  };
  for (const [name, ratio] of Object.entries(expectedDpr2)) {
    const p = PRESETS[name];
    const got = internalPixelRatio(2, p, baseDynamicScale(2, p));
    assert.ok(Math.abs(got - ratio) < 5e-3,
      `${name} dpr2 internal ratio ${got} must sit at ${ratio}`);
  }

  // texSize mobile lever: Node has no `window`, but quality.js reads it
  // lazily inside try/catch — a minimal mock plus ?tier=mobile pins the
  // mobile device tier (and a tight gl cap through the capability probe).
  const store = new Map();
  globalThis.window = {
    location: new URL('https://cert.local/?tier=mobile'),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  try {
    resolveDeviceTier({ capabilities: { maxTextureSize: 600 } });
    const p = getPreset();
    assert.equal(getPreset().textureScale, 0.5, 'mobile texture lever halves');
    assert.equal(p.textureCap, 2048, 'mobile texture cap is 2048');
    assert.equal(texSize(1024), 512, 'mobile halves an authored 1024 albedo');
    assert.equal(texSize(4096), 600,
      'texSize clamps to the live gl MAX_TEXTURE_SIZE below the 2048 cap');
  } finally {
    delete globalThis.window;
  }
}

console.log('renderScalePolicy self-test passed');

