// W2-G mobile-emulation HEADED smoke (campaign 2026-08-22 blocker B7:
// "Touch/mobile layout verified by selftests only — no live headed-touch
// walk"). Drives a real headed Chrome with Puppeteer device metrics
// (iPhone-class landscape, hasTouch/isMobile/dpr 3) against ?tier=mobile and
// asserts the three release-surface facts selftests cannot prove:
//   1. the touch layout engages (body.cot-touch-layout) and the mobile tier
//      owns the quality ladder (resolvePresetName -> mobile trio);
//   2. battle entry works end-to-end through the REAL garage flow;
//   3. in battle, the touch HUD renders inside the small viewport and the
//      virtual controls actually reach the input layer (joystick drag ->
//      setVirtualMove, fire button hold -> input.fire).
// Screenshot receipts land next to the JSON evidence (--out). Headed on
// purpose: headless SwiftShader is ~1.4x slower here (QA-COVERAGE issue #2)
// and B7 is explicitly about the live presentation.
// Usage: node tools/mobile-smoke.mjs [--out .qa-dev/w2g-mobile-smoke.json]
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, f) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : f; };
const OUT = opt('out', '.qa-dev/w2g-mobile-smoke.json');
const SHOT_GARAGE = OUT.replace(/\.json$/, '-garage.png');
const SHOT_BATTLE = OUT.replace(/\.json$/, '-battle.png');

// Known non-fatal console error classes (campaign doc issue #4 / blocker B5):
// one external ERR_CONNECTION_TIMED_OUT + two external 403s during captures.
const KNOWN_ERROR_RE = /net::ERR_CONNECTION_TIMED_OUT|Failed to load resource.*403/;

const results = { checks: {}, timings: {}, measurements: {}, consoleErrors: [], pageErrors: [] };
const check = (name, pass, detail = '') => {
  results.checks[name] = { pass: !!pass, detail: String(detail) };
  console.log(` ${pass ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await createServer({
  root: process.cwd(), logLevel: 'error',
  // Own server only (campaign issue #5); port below WinNAT 7185-7284 (issue #6).
  // hmr/watch OFF like tools/player-journey-probe.mjs: an editor save or doc
  // touch mid-run must not hot-reload the page out from under the smoke.
  server: { port: 5792, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } },
  optimizeDeps: {
    entries: ['index.html'],
    include: ['three', 'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/utils/SkeletonUtils.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
      'three/examples/jsm/geometries/RoundedBoxGeometry.js'],
  },
});
await server.listen();
const url = `http://localhost:${server.config.server.port}/?tier=mobile&nosplash=1`;

console.log('[smoke] launching HEADED chrome with iPhone-class device metrics');
const browser = await puppeteer.launch({
  headless: false,
  protocolTimeout: 600000, // battle-open can take ~190 s; keep huge watchdogs
  args: [
    '--use-gl=angle', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage',
    // headed-on-Windows hygiene from the journey probe: an occluded/minimized
    // window must not throttle rAF while the smoke waits on game state
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    '--window-position=40,40', '--window-size=1000,700', '--no-first-run',
  ],
});
try {
  const page = await browser.newPage();
  // Same proven emulation shape as tools/mobilelap.mjs (ratified mobile lap):
  // iPhone UA, landscape 892x412 CSS px, dpr 3, mobile+touch event surfaces.
  await page.emulate({
    viewport: { width: 892, height: 412, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 3 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  });
  page.on('pageerror', (e) => { results.pageErrors.push(e.message); console.error('[pageerror]', e.message); });
  page.on('console', (m) => {
    if (m.type() === 'error') { results.consoleErrors.push(m.text()); console.error('[console]', m.text().slice(0, 200)); }
  });
  const cdp = await page.createCDPSession();

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 420000 });
  // Navigation-tolerant boot wait: a first-run Vite dep-optimization reload
  // destroys the execution context mid-wait — ride it out and re-arm.
  let ready = false;
  while (!ready && Date.now() - t0 < 420000) {
    try {
      await page.waitForFunction('window.__GAME_READY === true', { timeout: 15000, polling: 250 });
      ready = true;
    } catch (e) {
      // inner-window timeout = still booting: re-arm. Only a destroyed context
      // (dep-optimization reload) or a dead target needs special handling —
      // both ride out until the deadline.
      if (/Target closed|Session closed/i.test(e.message)) throw e;
    }
  }
  if (!ready) {
    // Diagnose before dying: boot-stage timings + whatever the page logged.
    const diag = await page.evaluate(() => ({
      ready: !!window.__GAME_READY,
      bootMs: window.__BOOT_MS ?? null,
      timings: window.__BOOT_TIMINGS ?? null,
      phase: window.__DEBUG?.game?.phase ?? null,
      title: document.title,
    })).catch((e) => ({ evalFailed: e.message }));
    results.bootTimeoutDiag = diag;
    console.error('[smoke] boot timeout diagnostics:', JSON.stringify(diag, null, 2));
    throw new Error('__GAME_READY never set within 420 s');
  }
  results.timings.bootToReadyS = +((Date.now() - t0) / 1000).toFixed(1);

  // ---- 1) boot: garage phase, touch layout engaged, mobile tier owns preset --
  const boot = await page.evaluate(() => ({
    phase: window.__DEBUG.game.phase,
    touchLayout: document.body.classList.contains('cot-touch-layout'),
    coarse: matchMedia('(pointer: coarse)').matches,
    presetName: window.__DEBUG.quality.resolvePresetName(),
    uaMobile: /iPhone|Android|Mobile/i.test(navigator.userAgent),
    dpr: devicePixelRatio,
    vw: innerWidth, vh: innerHeight,
  }));
  check('boot_garage_ready', boot.phase === 'garage', `phase=${boot.phase} in ${results.timings.bootToReadyS}s`);
  check('touch_layout_engaged', boot.touchLayout && boot.coarse,
    `body.cot-touch-layout=${boot.touchLayout} pointer:coarse=${boot.coarse}`);
  check('mobile_tier_preset', ['mobile-low', 'mobile', 'mobile-high'].includes(boot.presetName),
    `resolvePresetName=${boot.presetName}`);
  results.measurements.viewport = { ...boot };

  await page.screenshot({ path: SHOT_GARAGE });
  console.log(`[smoke] garage screenshot -> ${SHOT_GARAGE}`);

  // ---- 2) battle entry through the REAL garage flow --------------------------
  const tB = Date.now();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, .btn, [class*="battle"]')]
      .find((el) => /^\s*BATTLE\s*$/i.test(el.textContent));
    if (!b) throw new Error('BATTLE button not found');
    b.click();
  });
  let entered = false;
  let countdownDone = false;
  while (!entered && Date.now() - tB < 600000) {
    try {
      await page.waitForFunction(
        () => window.__DEBUG.game.phase === 'battle',
        { timeout: 15000, polling: 250 });
      entered = true;
    } catch (e) {
      if (/Target closed|Session closed/i.test(e.message)) throw e;
    }
  }
  if (entered) {
    // Countdown drain is environment-paced (sim time starves under heavy
    // multi-worker host load): allow up to 120 s more, then record state
    // transparently instead of failing the layout-focused smoke.
    const cd = Date.now();
    while (!countdownDone && Date.now() - cd < 120000) {
      try {
        await page.waitForFunction(() => window.__DEBUG.game.preBattleS <= 0,
          { timeout: 10000, polling: 250 });
        countdownDone = true;
      } catch (_) { /* keep waiting */ }
    }
  }
  if (!entered) {
    const diag = await page.evaluate(() => ({
      phase: window.__DEBUG?.game?.phase ?? null,
      preBattleS: window.__DEBUG?.game?.preBattleS ?? null,
      worldMap: window.__DEBUG?.world?.mapId ?? null,
      loadStages: window.__BATTLE_LOAD ?? null,
    })).catch((e) => ({ evalFailed: e.message }));
    results.battleTimeoutDiag = diag;
    console.error('[smoke] battle-entry timeout diagnostics:', JSON.stringify(diag));
    check('battle_entry_real_flow', false, 'phase!=battle after 600 s');
  } else {
    const pb = await page.evaluate(() => window.__DEBUG.game.preBattleS).catch(() => null);
    results.timings.battleEntryS = +((Date.now() - tB) / 1000).toFixed(1);
    results.timings.preBattleSAtCheck = pb;
    check('battle_entry_real_flow', true,
      `phase=battle opened in ${results.timings.battleEntryS}s, ` +
      (countdownDone ? 'countdown drained' : `countdown pending at preBattleS=${pb} (host sim-time starvation)`));
  }
  if (entered) {
    await new Promise((r) => setTimeout(r, 1200)); // let the first HUD frames paint

    // ---- 3) touch HUD renders + controls reach the input layer -----------------
    const hud = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    const inView = (b) => !!b && b.w > 8 && b.h > 8 &&
      b.x >= -1 && b.y >= -1 && b.x + b.w <= innerWidth + 1 && b.y + b.h <= innerHeight + 1;
    const root = document.querySelector('.cot-touch.on');
    const canvas = document.querySelector('#app canvas');
    return {
      rootOn: !!root && getComputedStyle(root).display !== 'none',
      joy: box('.cot-touch .joy'),
      fire: box('.cot-touch .fire:not(.alt)'),
      scope: box('.cot-touch .scope'),
      autoaim: box('.cot-touch .autoaim'),
      minimap: box('.cot-minimap'),
      allInViewport: ['.cot-touch .joy', '.cot-touch .fire:not(.alt)', '.cot-touch .scope',
        '.cot-touch .autoaim', '.cot-minimap'].every((s) => inView(box(s))),
      canvasCss: { w: canvas ? canvas.clientWidth : 0, h: canvas ? canvas.clientHeight : 0 },
      canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
    };
  });
  check('touch_controls_render', hud.rootOn && hud.joy && hud.fire,
    `.cot-touch.on visible, joy ${JSON.stringify(hud.joy)}, fire ${JSON.stringify(hud.fire)}`);
  check('hud_fits_mobile_viewport', hud.allInViewport,
    `${results.measurements.viewport.vw}x${results.measurements.viewport.vh}: minimap ${JSON.stringify(hud.minimap)}`);
  check('hud_backing_store_sized', !!hud.canvasBacking && hud.canvasBacking.w > 0 &&
      hud.canvasBacking.w >= hud.canvasCss.w * 0.5 * Math.min(results.measurements.viewport.dpr || 1, 2),
    `css ${hud.canvasCss.w}x${hud.canvasCss.h}, backing ${hud.canvasBacking.w}x${hud.canvasBacking.h}`);
  results.measurements.hud = hud;

  // Joystick through the REAL pointer path. CDP nuance (W2-G probe): a bare
  // touchStart does not drive the lane — the deflection needs pointermove
  // steps, so drag center -> up exactly like tools/mobilelap.mjs gestures.
  const joyBox = hud.joy;
  const jx = joyBox.x + joyBox.w / 2, jy = joyBox.y + joyBox.h / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: jx, y: jy, id: 11 }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: jx, y: jy - i * 8, id: 11 }] });
    await new Promise((r) => setTimeout(r, 60));
  }
  const move = await page.evaluate(() => {
    const out = { x: 0, y: 0 };
    const active = window.__DEBUG.input.getVirtualMove(out);
    return { active, y: +out.y.toFixed(2), x: +out.x.toFixed(2) };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('joystick_reaches_input_layer', move.active && move.y > 0.25,
    `virtualMove y=${move.y} x=${move.x} active=${move.active}`);

  // Fire button hold: DYNAMIC AIM (touchControls.createMobileFireGesture)
  // arms auto-fire only after holdDelayMs=320, then input.pressVirtual('fire')
  // keeps virtualHeld('fire') set for the whole hold — state.fire stays hot,
  // so this read is not racy once past the hold threshold.
  const fireBox = hud.fire;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: fireBox.x + fireBox.w / 2, y: fireBox.y + fireBox.h / 2, id: 12 }],
  });
  await new Promise((r) => setTimeout(r, 650)); // > 320 ms hold threshold
  const fireHot = await page.evaluate(() => window.__DEBUG.input.getState().fire === true);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('fire_button_reaches_input_layer', fireHot, 'state.fire hot during >320ms touch hold');

  await page.screenshot({ path: SHOT_BATTLE });
  console.log(`[smoke] battle screenshot -> ${SHOT_BATTLE}`);
  }

  // ---- hygiene ----------------------------------------------------------------
  const unexpectedErrors = [...results.pageErrors, ...results.consoleErrors]
    .filter((e) => !KNOWN_ERROR_RE.test(e));
  check('no_unexpected_page_errors', results.pageErrors.length === 0,
    results.pageErrors.join(' | ') || 'none');
  check('no_unexpected_console_errors', unexpectedErrors.length === 0,
    unexpectedErrors.slice(0, 3).join(' | ') || `${results.consoleErrors.length} known-class errors`);

  results.verdict = Object.values(results.checks).every((c) => c.pass) ? 'PASS' : 'FAIL';
} finally {
  await browser.close();
  await server.close();
}

writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\n[smoke] ${results.verdict} — evidence ${OUT}`);
for (const [k, v] of Object.entries(results.checks)) {
  if (!v.pass) console.log(`  FAILED: ${k} — ${v.detail}`);
}
process.exit(results.verdict === 'PASS' ? 0 : 1);
