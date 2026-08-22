// SA-12 SETTINGS/PERSISTENCE campaign selftest — pure Node, deterministic,
// no DOM/WebGL. Drives the REAL production readers against corrupted /
// legacy-shaped localStorage records:
//   - game/input.js  (cot.settings.v1 gameplay+sound, cot.bindings*.v1,
//     cot.padBindings.v1) via createInput end-to-end and sanitizeSettings;
//   - engine/quality.js whitelist gates (cot.gfxPreset, cot.gfxMobilePreset,
//     cot.gfxAutoTier[Policy]) incl. mobile-tier pinning via a fresh module
//     instance forced to ?tier=mobile;
//   - the experimental-TAA guarantee: no shipped preset or stored value can
//     arm the W13 temporal-AA pass (quality.taaRequested gate used by post.js).
// Run: node src/ui/settingsPersistence.selftest.mjs

import assert from 'node:assert/strict';
import {
  createInput,
  getStoredDifficulty,
  sanitizeSettings,
} from '../game/input.js';
import {
  MOBILE_PRESET_ORDER,
  PRESETS,
  PRESET_ORDER,
  getMobilePresetChoice,
  getStoredChoice,
  getPreset,
  reportSustainedOverload,
  resolveAutoTier,
  resolvePresetName,
  setPresetName,
  taaRequested,
} from '../engine/quality.js';

// --- browser-global stubs ------------------------------------------------------
// input.js touches window/document/localStorage only inside createInput();
// quality.js reads them lazily behind try/catch. Assigning onto globalThis
// makes the bare `window` / `document` / `localStorage` identifiers resolve.
const store = new Map(); // shared backing for BOTH stubs (same origin semantics)
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.localStorage = localStorageStub;
globalThis.window = {
  location: { search: '' },
  localStorage: localStorageStub,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  pointerLockElement: null,
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};

const K_SETTINGS = 'cot.settings.v1';
const K_BINDINGS = 'cot.bindings.v1';
const K_BINDINGS2 = 'cot.bindings2.v1';
const K_PAD = 'cot.padBindings.v1';
const K_GFX = 'cot.gfxPreset';
const K_GFX_MOBILE = 'cot.gfxMobilePreset';
const K_AUTO_TIER = 'cot.gfxAutoTier';
const K_AUTO_POLICY = 'cot.gfxAutoTierPolicy';

/** Seed the stub store (objects are JSON-stringified, strings verbatim). */
function seed(records) {
  store.clear();
  globalThis.window.location.search = '';
  for (const [k, v] of Object.entries(records)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
}

/** Boot a real input layer against whatever the stub store holds. */
function bootInput() {
  return createInput({ lockElement: null });
}

const readStoredJson = (k) => JSON.parse(store.get(k));

// ============================================================================
console.log('--- sanitizeSettings (pure stored-record sanitizer) ---');
{
  const defaults = sanitizeSettings(null);
  assert.equal(defaults.sensitivity, 1);
  assert.equal(defaults.invertY, false);
  assert.equal(defaults.sniperSensScale, 1);
  assert.equal(defaults.aimSmoothing, 0.5);
  assert.equal(defaults.padSensitivity, 1);
  assert.equal(defaults.rmbMode, 'hold');
  assert.equal(defaults.aiDifficulty, 'normal');
  assert.equal(defaults.showPerfMeter, true);
  assert.equal(defaults.alarmHeartbeat, true);
  assert.equal(defaults.volMaster, 0.8);
  for (const k of ['volEngine', 'volCombat', 'volAmbience', 'volUi', 'volVoice']) {
    assert.equal(defaults[k], 1, `${k} default`);
  }
  // Non-object garbage of every shape lands on shipped defaults.
  for (const junk of [null, undefined, 'garbage', '', 42, true, [], [['sensitivity', 9]]]) {
    assert.deepEqual(sanitizeSettings(junk), defaults, `junk ${JSON.stringify(junk)}`);
  }

  // Wrong types fall back per-key; numerics clamp into range; ±Infinity (JSON
  // can carry it via 1e999) cannot leak through.
  const dirty = sanitizeSettings(JSON.parse(`{
    "sensitivity": "fast", "invertY": "yes", "sniperSensScale": null,
    "aimSmoothing": -2, "padSensitivity": 99, "aiDifficulty": "lunatic",
    "rmbMode": "spin", "showPerfMeter": "nope", "alarmHeartbeat": 0,
    "volMaster": 7, "volEngine": -3, "volAmbience": "loud",
    "hackerKey": {"x":1}, "__proto__": {"polluted": true}
  }`));
  // Numeric junk CLAMPS into range (the shipped behavior); non-numeric junk
  // and out-of-family enums fall back to defaults.
  const dirtyExpected = {
    ...defaults,
    aimSmoothing: 0,     // -2 -> 0
    padSensitivity: 3,   // 99 -> 3
    volMaster: 1,        // 7 -> 1
    volEngine: 0,        // -3 -> 0
  };
  assert.deepEqual(dirty, dirtyExpected);
  assert.ok(!('hackerKey' in dirty), 'unknown keys are dropped');
  assert.equal(Object.getPrototypeOf(dirty), Object.prototype, 'prototype stays clean');

  const clamped = sanitizeSettings({
    sensitivity: 1e999, // parses to Infinity -> clamps high
    invertY: true,
    sniperSensScale: -Infinity,
    aimSmoothing: 42,
    padSensitivity: 0.01,
    aiDifficulty: 'hard',
    rmbMode: 'toggle',
    showPerfMeter: false,
    alarmHeartbeat: false,
    volMaster: 1.5,
    volUi: -0.5,
  });
  assert.equal(clamped.sensitivity, 3);
  assert.equal(clamped.invertY, true);
  assert.equal(clamped.sniperSensScale, 0.2);
  assert.equal(clamped.aimSmoothing, 1);
  assert.equal(clamped.padSensitivity, 0.2);
  assert.equal(clamped.aiDifficulty, 'hard');
  assert.equal(clamped.rmbMode, 'toggle');
  assert.equal(clamped.showPerfMeter, false);
  assert.equal(clamped.alarmHeartbeat, false);
  assert.equal(clamped.volMaster, 1);
  assert.equal(clamped.volUi, 0);

  // A fully valid record round-trips untouched.
  const good = { ...defaults, sensitivity: 2.25, invertY: true, volCombat: 0.33 };
  assert.deepEqual(sanitizeSettings(good), good);
}

// ============================================================================
console.log('--- cot.settings.v1 corruption -> real createInput load path ---');
{
  // Raw junk strings (what a truncated/corrupt write leaves behind).
  seed({ [K_SETTINGS]: 'not json at all {{' });
  let api = bootInput();
  assert.deepEqual(api.getSettings(), sanitizeSettings(null));
  assert.equal(getStoredDifficulty(), 'normal');

  seed({ [K_SETTINGS]: JSON.stringify({ sensitivity: 999, volMaster: -5 }) });
  api = bootInput();
  assert.equal(api.getSettings().sensitivity, 3);
  assert.equal(api.getSettings().volMaster, 0);

  // Write-through stays sanitized: out-of-range setSetting persists CLAMPED.
  api.setSetting('sensitivity', 999);
  assert.equal(api.getSettings().sensitivity, 3);
  assert.equal(readStoredJson(K_SETTINGS).sensitivity, 3, 'persisted blob is clamped too');

  // Reset-to-defaults restores every gameplay/sound key and persists the clean shape.
  api.setSetting('invertY', true);
  api.setSetting('aiDifficulty', 'hard');
  api.resetSettings();
  assert.deepEqual(api.getSettings(), sanitizeSettings(null));
  const persisted = readStoredJson(K_SETTINGS);
  for (const k of Object.keys(persisted)) {
    assert.ok(k in sanitizeSettings(null), `persisted key ${k} is a known setting`);
  }
  assert.deepEqual(persisted, sanitizeSettings(null));
}

// ============================================================================
console.log('--- binding stores: type gates, explicit clears, dedupe, reset ---');
{
  seed({
    [K_BINDINGS]: JSON.stringify({
      forward: 42,           // numbers are not codes -> keep default
      fire: { evil: true },  // objects -> keep default
      shell1: null,          // explicit player-cleared slot -> stays cleared
      specialAction: '',     // empty string -> ignored
      back: 'KeyS',
    }),
    [K_BINDINGS2]: JSON.stringify({ forward: null }),
    [K_PAD]: JSON.stringify({
      fire: 7.5,             // fractional index must NOT survive sanitization
      sniperToggle: 6,       // valid LT default override
      handbrake: 0,
      consumable1: 99,       // out of range -> keep default
      reloadMagazine: null,
    }),
  });
  const api = bootInput();
  assert.equal(api.getBinding('forward', 0), 'KeyW');
  assert.equal(api.getBinding('fire', 0), 'Mouse0');
  assert.equal(api.getBinding('shell1', 0), null, 'explicit clear honored');
  assert.equal(api.getBinding('specialAction', 0), 'KeyE');
  assert.equal(api.getBinding('back', 0), 'KeyS');
  assert.equal(api.getBinding('forward', 1), null, 'explicit secondary clear honored');
  assert.equal(api.getBinding('back', 1), 'ArrowDown', 'untouched secondary keeps its default');
  assert.equal(api.getPadBinding('fire'), 7, 'fractional pad index rejected');
  assert.equal(api.getPadBinding('sniperToggle'), 6);
  assert.equal(api.getPadBinding('handbrake'), 0);
  assert.equal(api.getPadBinding('consumable1'), 2);
  assert.equal(api.getPadBinding('reloadMagazine'), null);

  // First-owner dedupe across keyboard slots.
  seed({ [K_BINDINGS]: JSON.stringify({ forward: 'KeyW', back: 'KeyW' }) });
  const dup = bootInput();
  assert.equal(dup.getBinding('back', 0), null, 'later duplicate cleared, first owner wins');

  // resetBindings restores every column (incl. previously cleared slots) and persists.
  seed({
    [K_BINDINGS]: JSON.stringify({ forward: null, fire: 'Digit9' }),
    [K_BINDINGS2]: JSON.stringify({ freeLook: null }),
    [K_PAD]: JSON.stringify({ fire: null }),
  });
  const wiped = bootInput();
  wiped.resetBindings();
  assert.equal(wiped.getBinding('forward', 0), 'KeyW');
  assert.equal(wiped.getBinding('freeLook', 0), 'ShiftLeft');
  assert.equal(wiped.getBinding('freeLook', 1), 'AltLeft');
  assert.equal(wiped.getPadBinding('fire'), 7);
  assert.deepEqual(readStoredJson(K_BINDINGS).forward, 'KeyW');
  assert.deepEqual(readStoredJson(K_PAD).fire, 7);
}

// ============================================================================
console.log('--- graphics preset whitelists (stored NAME strings only) ---');
{
  for (const junk of ['ultra-trojan', '__proto__', '{}', 'AUTO', 'high;rm -rf', '']) {
    seed({ [K_GFX]: junk });
    assert.equal(getStoredChoice(), 'auto', `gfx junk ${JSON.stringify(junk)} -> auto`);
  }
  seed({ [K_GFX]: 'ultra' }); // explicit opt-in IS a legal stored choice
  assert.equal(getStoredChoice(), 'ultra');
  assert.equal(resolvePresetName(), 'ultra'); // desktop tier honors it
  assert.equal(getPreset(), PRESETS.ultra);

  // setPresetName refuses non-whitelisted names without touching storage.
  seed({ [K_GFX]: 'high' });
  setPresetName('bogus-preset');
  assert.equal(store.get(K_GFX), 'high', 'invalid setPresetName is a no-op');

  for (const junk of ['desktop-ultra', 'low', 'ULTRA', null]) {
    seed(junk == null ? {} : { [K_GFX_MOBILE]: junk });
    assert.equal(getMobilePresetChoice(), 'mobile', `mobile junk ${JSON.stringify(junk)} -> balanced default`);
  }
  seed({ [K_GFX_MOBILE]: 'mobile-low' });
  assert.equal(getMobilePresetChoice(), 'mobile-low');

  // Auto-tier demotion store: whitelist + versioned policy receipt. The auto
  // ladder is module-local, so its 'ultra' exclusion is asserted behaviorally.
  seed({ [K_AUTO_TIER]: 'ultra', [K_AUTO_POLICY]: 'clarity-r2' });
  assert.notEqual(resolveAutoTier(), 'ultra', 'auto can NEVER resolve to ultra');
  assert.ok(['low', 'medium', 'high'].includes(resolveAutoTier()),
    'auto resolves to a concrete desktop tier');
  seed({ [K_AUTO_TIER]: 'low', [K_AUTO_POLICY]: 'clarity-r2' });
  assert.equal(resolveAutoTier(), 'low');
  // Stale/missing policy receipt -> the persisted verdict is discarded and
  // resolution falls back to the boot heuristic. A fresh module instance
  // proves this from a cold boot; the B6 section below proves it also holds
  // MID-SESSION on an instance whose reads already ran (per-read receipt
  // validation, not a one-shot boot sweep).
  seed({});
  const baselineTier = resolveAutoTier(); // heuristic-only baseline
  seed({ [K_AUTO_TIER]: 'medium' });
  const qPolicy = await import('../engine/quality.js?sa12-policy-instance');
  assert.equal(qPolicy.resolveAutoTier(), baselineTier,
    'stale-policy auto verdict is discarded on a fresh boot');
  assert.equal(store.get(K_AUTO_TIER) == null, true,
    'discarded verdict is removed from storage');

  // Preset ladder data contracts (Auto/Low/Medium/High/Ultra + mobile trio).
  for (const name of [...PRESET_ORDER, ...MOBILE_PRESET_ORDER]) {
    const p = PRESETS[name];
    assert.ok(p, `${name} exists in PRESETS`);
    for (const lever of ['msaaSamples', 'maxPixelRatio', 'aoScale', 'bloomScale',
      'shadowMaxFar', 'dynMin', 'grassMidFadeEnd', 'grassTaperEnd',
      'shadowCasterMinTexels', 'shadowFarInstanceBudget', 'terrainStreamBudgetMs']) {
      assert.equal(typeof p[lever], 'number', `${name}.${lever} is numeric`);
      assert.ok(Number.isFinite(p[lever]), `${name}.${lever} is finite`);
    }
    assert.ok(Array.isArray(p.shadowMapSizes) && p.shadowMapSizes.length === 4,
      `${name} defines all four CSM cascades`);
    for (const size of p.shadowMapSizes) {
      // Mobile tiers tune 768/1536 steps on purpose; just bound + quantize.
      assert.ok(Number.isInteger(size) && size >= 512 && size <= 4096 &&
        size % 256 === 0, `${name} cascade ${size} is a sane bounded allocation`);
    }
    assert.ok(p.grassMidFadeEnd > p.grassTaperEnd, `${name} grass bands ordered`);
  }
  for (const name of MOBILE_PRESET_ORDER) {
    const p = PRESETS[name];
    assert.equal(p.aoScale, 0, `${name}: AO off (mobile safety)`);
    assert.equal(p.textureScale, 0.5, `${name}: half-res texture bakes`);
    assert.ok(p.textureCap <= 2048, `${name}: texture cap within mobile budget`);
    assert.ok(p.maxPixelRatio <= 1.35 && p.msaaSamples <= 2,
      `${name}: raster/MSAA stay inside phone budgets`);
  }

  // MOBILE-TIER SAFETY: on a mobile device the device tier owns the ladder —
  // a stored DESKTOP choice (even 'ultra') must be pinned to the mobile trio.
  // Fresh module instance because the resolved tier is cached once per process.
  seed({ [K_GFX]: 'ultra', [K_GFX_MOBILE]: '' });
  globalThis.window.location.search = '?tier=mobile';
  const qMobile = await import('../engine/quality.js?sa12-mobile-instance');
  assert.equal(qMobile.resolveDeviceTier(undefined), 'mobile');
  const pinned = qMobile.resolvePresetName(qMobile.getStoredChoice());
  assert.ok(qMobile.MOBILE_PRESET_ORDER.includes(pinned),
    `stored 'ultra' pinned to mobile ladder (got ${pinned})`);
  assert.notEqual(pinned, 'ultra');
  assert.equal(qMobile.getPreset().textureCap <= 2048, true,
    'active mobile preset keeps the constrained texture budget');
}

// ============================================================================
console.log('--- B6 auto-tier staleness: per-read policy invalidation ---');
{
  // Baseline on this stubbed host: no GPU string / deviceMemory / cores, so
  // heuristicAutoCap() is null and 'auto' resolves to 'high'.
  seed({});
  const baseline = resolveAutoTier();

  // THE B6 REGRESSION: a stale-policy verdict written MID-SESSION — after
  // this module instance has already served reads earlier in this file —
  // must be discarded on the very next read instead of owning the rest of
  // the session. The pre-fix sweep ran exactly once per boot
  // (_autoPolicyHandled), so this exact sequence returned 'low' and kept it.
  seed({ [K_AUTO_TIER]: 'low', [K_AUTO_POLICY]: 'clarity-r1' });
  assert.equal(resolveAutoTier(), baseline,
    'stale-policy verdict is discarded mid-session (same module instance)');
  assert.equal(store.has(K_AUTO_TIER), false,
    'stale verdict removed from storage as soon as it is seen');
  assert.equal(store.get(K_AUTO_POLICY), 'clarity-r2',
    'policy receipt repaired to the running build version');

  // A MISSING receipt is equally stale (pre-receipt build or partial write).
  seed({ [K_AUTO_TIER]: 'medium' });
  assert.equal(resolveAutoTier(), baseline, 'receipt-less verdict discarded too');

  // A verdict carrying the CURRENT receipt is honored: a legit governor
  // demotion persisted by an earlier session still starts where it settled
  // (cross-session persistence is the feature; only stale receipts die).
  seed({ [K_AUTO_TIER]: 'medium', [K_AUTO_POLICY]: 'clarity-r2' });
  assert.equal(resolveAutoTier(), 'medium', 'current-receipt verdict survives');
  assert.equal(store.get(K_AUTO_TIER), 'medium', 'and stays in storage');

  // reportSustainedOverload pairs every persisted verdict with the current
  // receipt, so the governor's own mid-session writes can never read back
  // as stale on a later read/boot. Desktop choice defaults to 'auto' here.
  seed({});
  const before = resolveAutoTier();
  const stepped = reportSustainedOverload();
  if (stepped) {
    const order = ['low', 'medium', 'high'];
    assert.equal(resolveAutoTier(), order[order.indexOf(before) - 1],
      'overload step persists one notch below the resolved tier');
    assert.equal(store.get(K_AUTO_POLICY), 'clarity-r2',
      'governor write carries the policy receipt (B6 pairing)');
    assert.equal(store.has(K_AUTO_TIER), true, 'verdict itself is persisted');
  } else {
    assert.fail('stub host resolves auto=high; overload step must be available');
  }
}

// ============================================================================
console.log('--- experimental TAA can never arm from stored state ---');
{
  for (const name of [...PRESET_ORDER, ...MOBILE_PRESET_ORDER]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(PRESETS[name], 'taa'), false,
      `${name} ships no taa lever`,
    );
    assert.equal(taaRequested(PRESETS[name]), false, `${name} cannot arm TAA`);
  }
  assert.equal(taaRequested(null), false);
  assert.equal(taaRequested(undefined), false);
  assert.equal(taaRequested({}), false);
  assert.equal(taaRequested({ taa: true }), true, 'dev contract: exact boolean opts in');
  assert.equal(taaRequested({ taa: 'yes' }), false, 'truthy junk does not arm TAA');
  assert.equal(taaRequested({ taa: 1 }), false, 'truthy junk does not arm TAA');
  globalThis.window.__TAA_ENABLED = true;
  try {
    assert.equal(taaRequested(null), true, 'dev-console global remains the manual opt-in');
    // And still: no preset object alone flips it while the flag is unset…
  } finally {
    delete globalThis.window.__TAA_ENABLED;
  }
  globalThis.window.__TAA_ENABLED = false;
  assert.equal(taaRequested(PRESETS.high), false);
  delete globalThis.window.__TAA_ENABLED;

  // The exact expression post.js used to trust (Boolean(preset.taa)) would
  // have armed on truthy junk; the exported gate must agree with itself for
  // every shipped preset under any stored gfx choice.
  for (const stored of ['auto', 'low', 'medium', 'high', 'ultra']) {
    seed({ [K_GFX]: stored });
    assert.equal(taaRequested(getPreset()), false, `stored '${stored}' cannot arm TAA`);
  }
}

store.clear();
console.log('settingsPersistence.selftest: stored-state sanitization, binding stores, '
  + 'preset whitelists/mobile pinning, reset-to-defaults, B6 auto-tier per-read '
  + 'invalidation, and the TAA persistence gate all passed');
