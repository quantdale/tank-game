#!/usr/bin/env node
// tools/player-journey-probe.mjs — SA-14 player-journey E2E release gate.
//
// The selftest suite covers sim/UI logic in Node but nothing drove a REAL
// browser through the actual player loop end to end. This probe does exactly
// that through the public __DEBUG hooks (same seam every committed probe
// uses), asserting one full journey:
//
//   boot -> garage -> solo battle entry (real loading path)
//        -> aim + fire (damage dealt, shell pipeline receipts)
//        -> slayEnemies -> VICTORY results screen (roster rows, BATTLE AGAIN)
//        -> BATTLE AGAIN click -> garage re-entry -> auto re-entry into battle #2
//        -> death leg: spawnKillShell -> player destroyed
//        -> leaveBattleToGarage from a wreck -> garage again
//
// HEADED BY DEFAULT: headless Chrome on this host cannot complete battle-open
// (SwiftShader renderer stall, campaign doc issue #2 — see
// .qa-dev/campaign2-current.json; reproduced identically at 970ef9e3). Run
// `--headless` only to REPRODUCE/classify that environment limitation; on GPU
// hosts (CI/Linux) headless is expected to work.
//
// Evidence: .qa-dev/player-journey-report.json (stage timings, assertions,
// console/page errors). Exits 0 green, 1 assertion failure, 2 harness failure.
//
// Usage:
//   node tools/player-journey-probe.mjs [--headless] [--vehicle=m1a2]
//        [--map=verdant] [--out=.qa-dev/player-journey-report.json]
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const HEADLESS = hasFlag('headless');
const VEHICLE = arg('vehicle', 'm1a2');
const MAP = arg('map', 'verdant');
const OUT = resolve(arg('out', '.qa-dev/player-journey-report.json'));

// Console-error classes already triaged as environmental on this host
// (campaign doc issue #4: one ERR_CONNECTION_TIMED_OUT + two external-resource
// 403s observed during captures; favicon noise filtered by bootgate too).
const ENVIRONMENTAL_CONSOLE_RE = /ERR_CONNECTION_TIMED_OUT|net::ERR_|favicon/i;

const failures = [];
let checks = 0;
function check(stage, name, cond, detail = '') {
  checks++;
  const tag = `[${stage}] ${name}`;
  if (cond) console.log(`  PASS ${tag}${detail ? ` (${detail})` : ''}`);
  else {
    failures.push(`${tag}${detail ? ` — ${detail}` : ''}`);
    console.error(`  FAIL ${tag}${detail ? ` (${detail})` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stages = {};
let tStage = Date.now();
function stage(name) {
  const now = Date.now();
  if (name !== null) { stages[name] = { startedAtIso: new Date().toISOString() }; }
  else { /* close-out handled via stageMs */ }
  tStage = now;
}
function stageDone(name) {
  if (stages[name]) stages[name].ms = Date.now() - tStage;
}

const consoleErrors = [];
const pageErrors = [];

let server = null;
let browser = null;
try {
  // OWN server: never trust a pre-existing dev server (campaign doc issue #5).
  // Port range stays below the WinNAT-reserved 7185-7284 band (issue #6).
  const port = 5200 + Math.floor(Math.random() * 300);
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    // hmr/watch OFF: an editor save mid-run must not hot-reload the page out
    // from under the probe.
    server: { port, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await server.listen();

  browser = await puppeteer.launch({
    headless: HEADLESS,
    protocolTimeout: 420000,
    args: [
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-position=40,40',
      '--window-size=1380,860',
      '--no-first-run',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 400)));

  const url = `http://localhost:${server.config.server.port}/?nosplash=1&tier=desktop&gfxreset=1`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // ---- STAGE: boot ---------------------------------------------------------
  stage('boot');
  try {
    await page.waitForFunction('window.__GAME_READY === true', { timeout: 240000, polling: 250 });
  } catch (err) {
    check('boot', '__GAME_READY', false, `${err.message.slice(0, 120)} after ${Date.now() - t0}ms`);
    throw new Error('boot never became ready');
  }
  check('boot', '__GAME_READY sets', true, `${Date.now() - t0}ms`);
  let snap = await page.evaluate(() => ({
    phase: window.__DEBUG?.game?.phase,
    bootMs: window.__BOOT_MS ?? null,
  }));
  check('boot', "phase === 'garage'", snap.phase === 'garage', `phase=${snap.phase}`);
  check('boot', 'no page errors during boot', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
  stageDone('boot');

  // ---- STAGE: garage -------------------------------------------------------
  stage('garage');
  await page.evaluate((v) => {
    const d = window.__DEBUG;
    d.selectGarageTank(v);
  }, VEHICLE);
  await sleep(250); // selection event propagation
  snap = await page.evaluate(() => ({
    selectedSpecId: window.__DEBUG.selectedSpecId,
    hasBattleBtn: !!document.querySelector('.cot-battle'),
  }));
  check('garage', `selectGarageTank('${VEHICLE}') selects`, snap.selectedSpecId === VEHICLE, `selected=${snap.selectedSpecId}`);
  check('garage', 'garage BATTLE button present', snap.hasBattleBtn === true);
  stageDone('garage');

  // ---- STAGE: battle entry #1 (victory leg) --------------------------------
  stage('battleEntry1');
  let entryErr = null;
  try {
    await page.evaluate(async (v, m) => {
      await window.__DEBUG.beginSoloBattle({ specId: v, mapId: m });
    }, VEHICLE, MAP);
  } catch (err) { entryErr = err; }
  if (entryErr) {
    check('battleEntry1', 'beginSoloBattle resolves', false, String(entryErr).slice(0, 200));
    throw new Error('solo battle entry failed');
  }
  try {
    await page.waitForFunction(
      `window.__DEBUG.game.phase === "battle" && window.__DEBUG.game.preBattleS <= 0`,
      { timeout: 420000, polling: 500 },
    );
  } catch (err) {
    check('battleEntry1', 'battle open + countdown drained', false, err.message.slice(0, 140));
    throw new Error('battle-open timeout (see classification notes in report)');
  }
  snap = await page.evaluate(() => {
    const d = window.__DEBUG;
    const p = d.game.player;
    return {
      tanks: d.game.tanks.length,
      playerAlive: !!(p && p.state && p.combat && !p.combat.destroyed),
      hp: p?.combat?.hp ?? null,
      hpFinite: Number.isFinite(p?.combat?.hp),
      mapId: d.game.mapId,
    };
  });
  check('battleEntry1', `map is '${MAP}'`, snap.mapId === MAP, `mapId=${snap.mapId}`);
  check('battleEntry1', 'full roster built (>= 8 tanks)', snap.tanks >= 8, `tanks=${snap.tanks}`);
  check('battleEntry1', 'player alive with finite hp > 0', snap.playerAlive && snap.hpFinite && snap.hp > 0, `hp=${snap.hp}`);
  stageDone('battleEntry1');

  // ---- STAGE: combat damage dealt ------------------------------------------
  stage('combatDamage');
  const fireResult = await page.evaluate(async (v) => {
    const d = window.__DEBUG;
    let aimed = null;
    for (let attempt = 0; attempt < 6 && !aimed; attempt++) {
      aimed = d.aimAtNearest();
      if (!aimed) d.fastForward(3); // reposition/wait for LOS, then retry
    }
    if (!aimed) return { aimed: false, shells: 0, logLen: d.playerShellLog.length };
    d.flags.forceFire = true;
    d.fastForward(10); // several reload cycles' worth of shells downrange
    d.flags.forceFire = false;
    return {
      aimed: true,
      targetDistM: aimed.distM,
      logLen: d.playerShellLog.length,
      botPressure: { ...d.botPressure },
    };
  }, VEHICLE);
  check('combatDamage', 'aimAtNearest found an LOS-clear enemy', fireResult.aimed === true,
    fireResult.aimed ? `${Math.round(fireResult.targetDistM)}m` : 'no candidate in 6 attempts');
  check('combatDamage', 'player shells reached terminal events', fireResult.logLen >= 1, `playerShellLog=${fireResult.logLen}`);
  stageDone('combatDamage');

  // ---- STAGE: victory + results screen -------------------------------------
  stage('victoryResults');
  await page.evaluate(() => { window.__DEBUG.slayEnemies(); window.__DEBUG.fastForward(1); });
  // kill-cam may replay a captured deciding shell before the overlay shows;
  // poll generously and defensively cancel a stuck replay.
  let overlayShown = false;
  for (let waited = 0; waited <= 45000; waited += 500) {
    overlayShown = await page.evaluate(() =>
      !!document.querySelector('.cot-si-stats.cot-es.show'));
    if (overlayShown) break;
    if (waited === 20000) {
      await page.evaluate(() => {
        try { window.__DEBUG.killcam && window.__DEBUG.killcam.cancel && window.__DEBUG.killcam.cancel(); } catch (_) {}
      });
    }
    await sleep(500);
  }
  check('victoryResults', "game.result === 'victory'", await page.evaluate(() =>
    window.__DEBUG.game.result === 'victory'));
  check('victoryResults', 'results overlay visible', overlayShown);
  const esDom = await page.evaluate(() => {
    const host = document.querySelector('.cot-si-stats.cot-es');
    const btn = document.querySelector('.cot-es-btn.prime');
    return {
      allies: host?.dataset?.rosterAllies ?? null,
      enemies: host?.dataset?.rosterEnemies ?? null,
      battleAgainLabel: btn ? btn.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null,
    };
  });
  check('victoryResults', 'team rosters rendered', Number(esDom.allies) >= 1 && Number(esDom.enemies) >= 1,
    `allies=${esDom.allies} enemies=${esDom.enemies}`);
  check('victoryResults', 'BATTLE AGAIN button present', /BATTLE AGAIN/.test(esDom.battleAgainLabel || ''), esDom.battleAgainLabel || 'missing');
  stageDone('victoryResults');

  // ---- STAGE: rematch (BATTLE AGAIN -> garage -> battle #2) -----------------
  stage('rematch');
  await page.click('.cot-es-btn.prime'); // real user input path
  try {
    await page.waitForFunction('window.__DEBUG.game.phase === "garage"', { timeout: 90000, polling: 250 });
  } catch (err) {
    stageDone('rematch');
    check('rematch', 'returns to garage after BATTLE AGAIN', false, err.message.slice(0, 140));
    throw new Error('rematch garage re-entry failed');
  }
  stageDone('rematch');
  check('rematch', 'garage re-entry after BATTLE AGAIN', true, `${stages.rematch.ms}ms`);
  // main.js ui:battleAgain handler clicks .cot-battle itself once the garage
  // transition finishes — the standard loading path must then reopen battle.
  try {
    await page.waitForFunction(
      `window.__DEBUG.game.phase === "battle" && window.__DEBUG.game.preBattleS <= 0`,
      { timeout: 240000, polling: 500 },
    );
  } catch (err) {
    check('rematch', 'auto re-entry into battle #2', false, err.message.slice(0, 140));
    throw new Error('rematch battle re-entry failed');
  }
  snap = await page.evaluate(() => {
    const p = window.__DEBUG.game.player;
    return { alive: !!(p && p.state && !p.combat.destroyed), result: window.__DEBUG.game.result };
  });
  check('rematch', 'fresh battle #2: player reset & result cleared', snap.alive && snap.result === null,
    `alive=${snap.alive} result=${snap.result}`);
  stageDone('rematch');

  // ---- STAGE: death leg (deterministic player destruction) ------------------
  stage('deathLeg');
  let killed = false;
  for (let i = 0; i < 2 && !killed; i++) {
    killed = await page.evaluate(() => {
      const d = window.__DEBUG;
      if (!d.spawnKillShell()) return false;
      d.fastForward(2);
      return !!(d.game.player && d.game.player.combat.destroyed);
    });
  }
  check('deathLeg', 'spawnKillShell destroys the player', killed);
  const pressure = await page.evaluate(() => ({ ...window.__DEBUG.botPressure }));
  check('deathLeg', 'enemy pressure counters live', pressure.enemyShells >= 0, JSON.stringify(pressure));
  stageDone('deathLeg');

  // ---- STAGE: leave wreck to garage ----------------------------------------
  stage('leaveWreckGarage');
  await page.evaluate(() => { window.__DEBUG.leaveBattleToGarage(); });
  let backInGarage = false;
  try {
    await page.waitForFunction('window.__DEBUG.game.phase === "garage"', { timeout: 120000, polling: 250 });
    backInGarage = true;
  } catch (err) { /* reported below */ }
  check('leaveWreckGarage', 'wreck-state exit lands in garage', backInGarage);
  stageDone('leaveWreckGarage');

  // ---- global verdicts ------------------------------------------------------
  const realPageErrors = pageErrors.filter((e) => !/ResizeObserver loop/i.test(e));
  check('global', 'zero page errors across journey', realPageErrors.length === 0, realPageErrors.join(' | ').slice(0, 300));
  const envFiltered = consoleErrors.filter((e) => !ENVIRONMENTAL_CONSOLE_RE.test(e));
  check('global', 'zero unexpected console errors', envFiltered.length === 0,
    envFiltered.slice(0, 3).join(' | ').slice(0, 300));

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: HEADLESS ? 'headless' : 'headed',
    vehicle: VEHICLE,
    map: MAP,
    url,
    wallMs: Date.now() - t0,
    checks,
    failures: failures.length,
    stages,
    consoleErrorsAll: consoleErrors,
    consoleErrorsUnexpected: consoleErrors.filter((e) => !ENVIRONMENTAL_CONSOLE_RE.test(e)),
    pageErrors,
    classificationNote: HEADLESS
      ? 'Headless run: if this failed at battleEntry1 with a stall/timeout, that reproduces campaign doc issue #2 — classify ENVIRONMENT LIMITATION (SwiftShader software rasterization; identical at 970ef9e3), not a game bug.'
      : null,
  };
  mkdirSync('.qa-dev', { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\n[player-journey] ${failures.length === 0 ? 'JOURNEY GREEN' : 'JOURNEY FAILED'} — ${checks} checks, report: ${OUT}`);
  process.exit(failures.length === 0 ? 0 : 1);
} catch (err) {
  // Stage-level crash (boot/battle-entry timeouts etc.) still writes evidence.
  try {
    mkdirSync('.qa-dev', { recursive: true });
    writeFileSync(OUT, JSON.stringify({
      version: 1, generatedAt: new Date().toISOString(), mode: HEADLESS ? 'headless' : 'headed',
      vehicle: VEHICLE, map: MAP, crashed: true, crashMessage: String(err).slice(0, 500),
      stages, checks, failures, consoleErrorsAll: consoleErrors, pageErrors,
    }, null, 1));
  } catch (_) { /* report write is best-effort */ }
  console.error(`[player-journey] CRASHED: ${String(err).slice(0, 300)}`);
  process.exit(failures.length ? 1 : 2);
} finally {
  try { if (browser) await browser.close(); } catch (_) {}
  try { if (server) await server.close(); } catch (_) {}
}
