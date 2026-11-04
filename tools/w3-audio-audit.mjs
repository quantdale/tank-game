#!/usr/bin/env node
// W08a — release audio audit harness (Campaign 3 final wave).
//
// Live headed-browser audit of the combat audio system on the REAL battle
// path. Complements the Node selftests (voices.selftest / audioTiming.selftest)
// with the guarantees only a real AudioContext graph can prove:
//
//   1. Combat SFX families fire on the real path: cannon reports
//      (fire_{cls}_{sub,crack,tail}), impact families, HE/explosion layers,
//      tank destruction (expl_tank_core_a/b, expl_burnout).
//   2. VOICE-STEALING CONTRACT (dfe315ef): under sustained report pressure,
//      an important event (tank explosion) still receives its voice within
//      its gate window — belt-fed spam may not starve one-shots.
//   3. ORPHAN CHECK: after leaveBattleToGarage, live AudioBufferSourceNode
//      count returns to the garage baseline and engine loops are stopped
//      (stopWorldLoops effect — audio.js phase hooks).
//   4. REPEAT-MATCH: three entry/exit cycles must not grow live audio nodes
//      monotonically.
//
// Usage:
//   node tools/w3-audio-audit.mjs [--entry=full|fast] [--cycles=3]
//        [--combat-seconds=8] [--headless] [--dry-run]
//        [--out=.qa-dev/w3/audio-audit/report.json]
//
//   --entry=full  real beginSoloBattle loading pipeline (default; slow)
//   --entry=fast  synchronous startBattle shortcut (quick iteration only)
//   --dry-run     validate structure in Node without Chrome
//
// Exit codes: 0 = all checks green, 1 = failures (see JSON receipt).

import { createServer } from 'vite';

const arg = (name, fallback) => {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const ENTRY = arg('entry', 'full');
const CYCLES = Math.max(1, Number(arg('cycles', '3')));
const COMBAT_SECONDS = Number(arg('combat-seconds', '8'));
const OUT = arg('out', '.qa-dev/w3/audio-audit/report.json');
const HEADLESS = hasFlag('headless');
const DRY_RUN = hasFlag('dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Leg plan (shared between dry-run validation and the live run).
// ---------------------------------------------------------------------------
const LEGS = [
  { id: 'boot', desc: 'vite + Chrome boot to garage (__GAME_READY)' },
  { id: 'families', desc: 'cannon/impact/explosion families present in sfxLog' },
  { id: 'steal-contract', desc: 'explosion gets its voice under report pressure (dfe315ef)' },
  { id: 'orphan', desc: 'live source nodes back to baseline; engine loops stopped' },
  { id: 'repeat', desc: `${CYCLES} entry/exit cycles without monotonic node growth` },
];

const { default: puppeteer } = await import('puppeteer');
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Installed before any page script runs: lifecycle counter for
// AudioBufferSourceNodes so orphan voices are measurable directly.
// Same pattern as tools/memory-soak.mjs AUDIO_PROBE_SOURCE.
const AUDIO_PROBE_SOURCE = `
(() => {
  const probe = { started: 0, stopped: 0 };
  const OrigSource = window.AudioBufferSourceNode;
  const origStart = OrigSource.prototype.start;
  const origStop = OrigSource.prototype.stop;
  const live = new Set();
  OrigSource.prototype.start = function (...a) {
    try { probe.started++; live.add(this); } catch (_) {}
    return origStart.apply(this, a);
  };
  OrigSource.prototype.stop = function (...a) {
    try { probe.stopped++; live.delete(this); } catch (_) {}
    return origStop.apply(this, a);
  };
  window.__AUDIO_PROBE = {
    get started() { return probe.started; },
    get stopped() { return probe.stopped; },
    approxLive() { return live.size; },
  };
})();
`;

if (DRY_RUN) {
  console.log('[w3-audio-audit] DRY RUN — structure validation only');
  console.log(`  entry=${ENTRY} cycles=${CYCLES} combatSeconds=${COMBAT_SECONDS} headless=${HEADLESS}`);
  console.log('  legs:');
  for (const l of LEGS) console.log(`    - ${l.id}: ${l.desc}`);
  // Validate the page-side probe snippet parses as JS before any browser run.
  new Function(AUDIO_PROBE_SOURCE.replace(/\bwindow\b/g, 'globalThis'));
  console.log('  AUDIO_PROBE_SOURCE: parses OK');
  console.log('[w3-audio-audit] DRY RUN GREEN');
  process.exit(0);
}

const results = [];
const failures = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failures.push(`${id}: ${detail}`);
  console.log(`[w3-audio-audit] ${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
}

// sfxLog entry names observed in src/audio/audio.js sampleLayer calls.
const RE_CANNON_LAYER = /^fire_(small|medium|large|huge)_(sub|crack|tail)$/;
const RE_EXPLOSION = /^(expl_tank_core_[ab]|expl_burnout|expl_turret_pop)/;
const RE_IMPACT_FAMILY = /^(impact_|ricochet|penetrat|nonpen|era_pop|expl_he_[ab])/;

let server = null;
let browser = null;
try {
  // Own vite server in the W08a band (5308-5347); never touch :5173 and stay
  // clear of the Windows WinNAT reservation TCP 7185-7284.
  const port = 5308 + Math.floor(Math.random() * 40);
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { port, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } },
    optimizeDeps: { entries: ['index.html'] },
  });
  await server.listen();
  const url = `http://localhost:${server.config.server.port}/`;
  console.log(`[w3-audio-audit] vite up at ${url}`);

  browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    args: [
      '--use-gl=angle', '--enable-webgl', '--no-sandbox',
      '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-position=40,40', '--window-size=1380,860',
      '--js-flags=--expose-gc',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.evaluateOnNewDocument(AUDIO_PROBE_SOURCE);

  // ---- boot -----------------------------------------------------------------
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__GAME_READY === true', { timeout: 240000, polling: 250 });
  await page.mouse.click(680, 384); // trusted gesture -> AudioContext.resume
  await sleep(400);
  check('boot', true, `garage ready; audio ctx state=${await page.evaluate(() => window.__COT_AUDIO?.ctx?.state || 'none')}`);

  const readAudioState = () => page.evaluate(() => ({
    sfxCount: window.__COT_AUDIO.sfxCount,
    sfxLoaded: window.__COT_AUDIO.sfxLoaded,
    logLen: window.__COT_AUDIO.sfxLog.length,
    engines: window.__COT_AUDIO.engineState().length,
    liveSources: window.__AUDIO_PROBE.approxLive(),
    started: window.__AUDIO_PROBE.started,
    stopped: window.__AUDIO_PROBE.stopped,
    ctxState: window.__COT_AUDIO.ctx?.state || 'none',
  }));

  const garageBaseline = await readAudioState();
  console.log(`[w3-audio-audit] garage baseline: ${JSON.stringify(garageBaseline)}`);

  const enterBattle = async () => {
    const t0 = Date.now();
    if (ENTRY === 'fast') {
      await page.evaluate(() => window.__DEBUG.startBattle('m1a2'));
    } else {
      await page.evaluate(async () => {
        await window.__DEBUG.beginSoloBattle({ specId: 'm1a2', mapId: 'verdant' });
      });
    }
    await page.waitForFunction(
      'window.__DEBUG.game.phase === "battle"',
      { timeout: 420000, polling: 500 },
    );
    // Hold the sim open through the countdown so bursts land while audible.
    await page.evaluate(() => { window.__DEBUG.game.preBattleS = 999; });
    await sleep(600);
    return Date.now() - t0;
  };

  const exitToGarage = async () => {
    const t0 = Date.now();
    await page.evaluate(() => { window.__DEBUG.leaveBattleToGarage(); });
    await page.waitForFunction(
      'window.__DEBUG.game.phase === "garage"',
      { timeout: 180000, polling: 250 },
    );
    await sleep(4000); // deferred dispose work settles
    return Date.now() - t0;
  };

  /** Names logged since `sinceSeq` (sfxLog is a 200-entry rolling window). */
  const namesSince = async (sinceSeq) => page.evaluate((s) =>
    window.__COT_AUDIO.sfxLog.filter((e) => e.seq > s).map((e) => e.n), sinceSeq);

  // ===========================================================================
  // LEG 1+2 (first cycle doubles as the family + steal-contract audit)
  // ===========================================================================
  const entryMs = await enterBattle();
  await page.waitForFunction('window.__COT_AUDIO.sfxLoaded === true', { timeout: 30000 });
  await page.evaluate(() => window.__DEBUG.bus.emit('ui:volumes',
    { master: 0.8, engine: 0.6, combat: 1, ambience: 0.4, ui: 0.4, voice: 0.6 }));
  console.log(`[w3-audio-audit] battle open (${Math.round(entryMs / 1000)}s); exercising combat audio`);

  // --- combat families -------------------------------------------------------
  let seqBefore = await page.evaluate(() =>
    window.__COT_AUDIO.sfxLog.length ? window.__COT_AUDIO.sfxLog[window.__COT_AUDIO.sfxLog.length - 1].seq : 0);
  const aimed = await page.evaluate(async (secs) => {
    const d = window.__DEBUG;
    let ok = null;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      ok = d.aimAtNearest();
      if (!ok) d.fastForward(3);
    }
    if (!ok) return false;
    d.flags.forceFire = true;
    d.fastForward(secs);
    d.flags.forceFire = false;
    return true;
  }, COMBAT_SECONDS);
  await sleep(1500); // scheduled layers land + log flushes
  const familyNames = aimed ? await namesSince(seqBefore) : [];
  const sawCannon = familyNames.some((n) => RE_CANNON_LAYER.test(n));
  const sawImpact = familyNames.some((n) => RE_IMPACT_FAMILY.test(n));
  check('families.cannon', aimed && sawCannon,
    `${familyNames.filter((n) => RE_CANNON_LAYER.test(n)).length} cannon layers${aimed ? '' : ' (no aim target!)'}`);
  check('families.impact', sawImpact,
    sawImpact ? familyNames.filter((n) => RE_IMPACT_FAMILY.test(n))[0] : 'no impact-family samples in log');

  // --- voice-stealing contract (dfe315ef) ------------------------------------
  // Sustained report pressure (more shots) with an explosion landing inside
  // the same window: the destruction one-shot MUST reach sfxLog despite the
  // per-kind report gate and the 24-voice steal budget.
  seqBefore = await page.evaluate(() =>
    window.__COT_AUDIO.sfxLog[window.__COT_AUDIO.sfxLog.length - 1]?.seq || 0);
  const stealOutcome = await page.evaluate(async (secs) => {
    const d = window.__DEBUG;
    d.flags.forceFire = true;          // pressure: keep reports spawning
    d.fastForward(secs * 0.5);
    d.slayEnemies();                    // the important event under pressure
    d.fastForward(secs * 0.5);
    d.flags.forceFire = false;
    const last = window.__COT_AUDIO.sfxLog[window.__COT_AUDIO.sfxLog.length - 1];
    return { lastSeq: last ? last.seq : 0 };
  }, COMBAT_SECONDS);
  // Poll up to 4 s of wall time for an explosion layer newer than seqBefore.
  let explosionName = null;
  for (let poll = 0; poll < 20 && !explosionName; poll++) {
    await sleep(200);
    const names = await namesSince(seqBefore);
    explosionName = names.find((n) => RE_EXPLOSION.test(n)) || null;
  }
  check('steal.contract', !!explosionName,
    explosionName
      ? `'${explosionName}' voiced under pressure (lastSeq=${stealOutcome.lastSeq})`
      : 'destruction one-shot never reached the log under sustained pressure');

  // ===========================================================================
  // LEG 3: orphan check on first exit
  // ===========================================================================
  await exitToGarage();
  const afterExit1 = await readAudioState();
  const liveDelta = afterExit1.liveSources - garageBaseline.liveSources;
  check('orphan.voices', liveDelta <= 2,
    `live sources ${garageBaseline.liveSources} -> ${afterExit1.liveSources} (delta ${liveDelta}, <=2 allowed for garage ambience)`);
  check('orphan.engines', afterExit1.engines === 0,
    `engine loops after garage return: ${afterExit1.engines} (stopWorldLoops must have cleared them)`);

  // ===========================================================================
  // LEG 4: repeat match-entry growth contract
  // ===========================================================================
  const cycleSamples = [{ live: afterExit1.liveSources, engines: afterExit1.engines }];
  for (let c = 2; c <= CYCLES; c++) {
    await enterBattle();
    await sleep(1200); // let loops spin up
    await exitToGarage();
    const s = await readAudioState();
    cycleSamples.push({ live: s.liveSources, engines: s.engines });
    console.log(`[w3-audio-audit] repeat cycle ${c}/${CYCLES}: live=${s.liveSources} engines=${s.engines}`);
  }
  const monotonic = cycleSamples.length >= 2 && cycleSamples.every((s, i) =>
    i === 0 ? true : s.live > cycleSamples[i - 1].live);
  const lastVsFirst = cycleSamples[cycleSamples.length - 1].live - cycleSamples[0].live;
  check('repeat.growth', !monotonic && lastVsFirst <= 2,
    `cycle-end live nodes [${cycleSamples.map((s) => s.live).join(' -> ')}]; ` +
    `last-first delta ${lastVsFirst}${monotonic ? ' MONOTONIC GROWTH' : ''}`);

  // ---- hygiene ---------------------------------------------------------------
  const unexpectedErrors = pageErrors.filter((e) =>
    !/ERR_CONNECTION_TIMED_OUT|net::ERR_|favicon/i.test(e));
  check('hygiene.pageerrors', unexpectedErrors.length === 0,
    unexpectedErrors.length ? unexpectedErrors.slice(0, 3).join(' | ') : 'zero page errors');

  // ---- receipt ----------------------------------------------------------------
  const receipt = {
    when: new Date().toISOString(),
    entry: ENTRY,
    cycles: CYCLES,
    combatSeconds: COMBAT_SECONDS,
    headless: HEADLESS,
    green: failures.length === 0,
    checks: results,
    garageBaseline,
    cycleSamples,
    failures,
  };
  const outPath = resolve(OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(receipt, null, 2));
  console.log(`[w3-audio-audit] ${receipt.green ? 'GREEN' : 'RED'} — ${results.filter((r) => r.ok).length}/${results.length} checks; receipt: ${outPath}`);
  process.exitCode = receipt.green ? 0 : 1;
} catch (err) {
  console.error(`[w3-audio-audit] FATAL ${err && err.stack || err}`);
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch (_) {}
  try { if (server) await server.close(); } catch (_) {}
}
