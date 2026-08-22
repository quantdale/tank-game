#!/usr/bin/env node
// tools/w3-fleet-visual-sample.mjs — W13a stratified live fleet visual sampler.
//
// rosterSweep.selftest.mjs certifies every playable tank STRUCTURALLY in Node
// (rigs, anchors, NaN poses, bounds, disposal). This probe is the complementary
// BROWSER/VISUAL certification: a deterministic stratified sample of the fleet
// is driven through real garage + battle presentation, with PNG receipts and
// coarse pixel-stat checks per shot.
//
// The sample (~24 vehicles) is DERIVED, never hardcoded blind: nation blocs,
// classes, eras, casemate/fixed-mount builds (COMBAT_ANATOMY_CALIBRATIONS),
// ERA plating, lazy-fleet group membership (src/vehicles/fleet/g1..g4 + eager)
// and decoration weight (built vertex totals) all come from fleet metadata.
// `--dry-run` prints the derivation table and exits without a browser.
//
// Heheaded runtime (phase 2 — run on a quiet host):
//   boot -> garage pedestal screenshot -> battle spawn screenshot ->
//   turret/gun articulation sweep (3 poses) -> muzzle anchor sanity ->
//   battle-detail LOD census -> destruction/wreck screenshot -> garage return.
// Pixel checks per PNG: decodability, luminance variance above noise floor,
// and center-region "silhouette" contrast against the frame's border color.
//
// Usage:
//   node tools/w3-fleet-visual-sample.mjs --dry-run
//        [--universe=all|production] [--size=24]
//   node tools/w3-fleet-visual-sample.mjs [--map=verdant] [--only=id1,id2]
//        [--headless] [--out-dir=.qa-dev/w3/fleet-visual]
//
// Evidence: <out-dir>/sample.json (derivation + verdicts), <out-dir>/<id>/*.png.
// Exit codes: 0 green, 1 assertion failures, 2 harness crash.
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Fleet registration side effect: same contract as rosterSweep/gallery sweeps
// (expansion modules must register before ALL_TANK_IDS is finalized).
import '../src/vehicles/tankFactory.js';
import {
  ALL_TANK_IDS,
  PRODUCTION_TANK_IDS,
  getSpec,
} from '../src/vehicles/specs.js';
import { RETIRED_EXTERNAL_PLACEHOLDER_IDS, isProductionHiddenTankId } from '../src/vehicles/rosterPolicy.js';
import { COMBAT_ANATOMY_CALIBRATIONS } from '../src/vehicles/combatAnatomyCalibrations.js';
import { createTank } from '../src/vehicles/tankFactory.js';
import { GROUP_PROFILES as G1 } from '../src/vehicles/fleet/g1Nato.js';
import { GROUP_PROFILES as G2 } from '../src/vehicles/fleet/g2East.js';
import { GROUP_PROFILES as G3 } from '../src/vehicles/fleet/g3UsMisc.js';
import { GROUP_PROFILES as G4 } from '../src/vehicles/fleet/g4CasemateAsia.js';
import { decodePng } from './campaign-png.mjs';

const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const DRY_RUN = hasFlag('dry-run');
const UNIVERSE_MODE = arg('universe', 'all'); // all | production
const SAMPLE_SIZE = Math.max(8, Number(arg('size', '24')) || 24);
const MAP_ID = arg('map', 'verdant');
const ONLY_IDS = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = resolve(arg('out-dir', '.qa-dev/w3/fleet-visual'));
const HEADLESS = hasFlag('headless');
const PORT_BASE = 5313; // W13a band (below WinNAT reserve 7185-7284)

// Presentation-only grouping so 'USSR/Russia' | 'Russia' | 'USSR' spec labels
// count as one coverage bloc (the raw labels are historical data, untouched).
const NATION_BLOC = {
  USSR: 'USSR/Russia',
  Russia: 'USSR/Russia',
  'USSR/Russia': 'USSR/Russia',
};
const nationBloc = (nation) => NATION_BLOC[nation] ?? nation;

// Suspension oddballs the stratifier must always include. Derived where the
// data allows (strv103* = Swedish siege-line casemate family, id-prefixed);
// t95 is the documented twin-track WW2 outlier and has no metadata flag, so it
// is named here deliberately rather than discovered badly.
const UNUSUAL_SUSPENSION_RE = /^(strv103|t95)/;

// ============================================================================
// Phase A (Node, both modes) — derive fleet metadata + build weights
// ============================================================================

const retiredSet = new Set(RETIRED_EXTERNAL_PLACEHOLDER_IDS);
const productionVisible = new Set(PRODUCTION_TANK_IDS);

/** Lazy-group membership maps: profile-row key -> group label. */
const GROUP_LABELS = [
  ['fleet/g1Nato', G1],
  ['fleet/g2East', G2],
  ['fleet/g3UsMisc', G3],
  ['fleet/g4CasemateAsia', G4],
];

function fleetGroupOf(id) {
  for (const [label, profiles] of GROUP_LABELS) {
    if (Object.hasOwn(profiles, id)) return label;
  }
  return 'eager'; // canonical TANK_IDS + eager misc/profile packs
}

function armorPlateNames(spec) {
  return [...(spec.armor?.hullPlates || []), ...(spec.armor?.turretPlates || [])]
    .map((p) => String(p.name || ''));
}

/**
 * Build once to measure visual complexity (decoration weight proxy) exactly
 * like rosterSweep does — deterministic, no GPU, disposed immediately.
 */
function buildWeight(id) {
  const tank = createTank(id, null, { proceduralOnly: true, geometryReceipt: true });
  let meshCount = 0;
  let vertexTotal = 0;
  let lodCount = 0;
  let markingCount = 0;
  tank.root.traverse((object) => {
    if (object.isLOD) lodCount++;
    if (object.userData.vehicleMarking) markingCount++;
    if (!object.isMesh && !object.isBatchedMesh && !object.isInstancedMesh) return;
    meshCount++;
    if (object.geometry?.attributes?.position) vertexTotal += object.geometry.attributes.position.count;
  });
  tank.dispose();
  return { meshCount, vertexTotal, lodCount, markingCount };
}

console.log(`[w3-fleet-visual] deriving fleet metadata (${ALL_TANK_IDS.length} registered ids)...`);
const fleet = [];
for (const id of ALL_TANK_IDS) {
  if (retiredSet.has(id)) continue; // retired external placeholders are unbuildable archaeology
  const spec = getSpec(id);
  const calib = COMBAT_ANATOMY_CALIBRATIONS[id];
  const plates = armorPlateNames(spec);
  fleet.push({
    id,
    name: spec.name,
    nation: spec.nation,
    bloc: nationBloc(spec.nation),
    class: spec.class,
    era: spec.era,
    group: fleetGroupOf(id),
    productionHidden: isProductionHiddenTankId(id),
    casemate: calib ? calib.turret === null : false,
    hasEraPlates: plates.some((n) => /(^|_)era(_|$|_L$|_R$)/i.test(n)),
    apfsds: Array.isArray(spec.gun?.shells) && spec.gun.shells.some((sh) => sh.type === 'APFSDS'),
    unusualSuspension: UNUSUAL_SUSPENSION_RE.test(id),
    ...buildWeight(id),
  });
}
console.log(`[w3-fleet-visual] built+measured ${fleet.length} vehicles in Node.`);

// ============================================================================
// Phase B — deterministic stratified selection
// ============================================================================

const byVertexDesc = (a, b) => b.vertexTotal - a.vertexTotal || (a.id < b.id ? -1 : 1);
const chosen = new Map(); // id -> reasons[]
const addReason = (id, reason) => {
  const entry = chosen.get(id);
  if (entry && !entry.includes(reason)) entry.push(reason);
};
/** Mark an id as chosen; records the stratification reason when given. */
const pick = (v, reason) => {
  if (!v || chosen.has(v.id)) { if (v) addReason(v.id, reason); return; }
  chosen.set(v.id, []);
  if (reason) addReason(v.id, reason);
};
const findId = (pred) => selectableFleet.filter(pred).sort(byVertexDesc)[0] || null;

// Universe gate: 'production' keeps only player-facing garage vehicles;
// default 'all' also covers the retained WW2/casemate reference rows (the
// Wave-1 fixedMount repair families), flagged prod-hidden in the table.
const selectableFleet = UNIVERSE_MODE === 'production'
  ? fleet.filter((f) => !f.productionHidden)
  : fleet;

// 1. Forced suspension oddballs (explicit mission requirement).
for (const v of selectableFleet.filter((f) => f.unusualSuspension).sort(byVertexDesc)) {
  pick(v, 'suspension-oddball');
  addReason(v.id, 'suspension-oddball');
}
// strv103a vs strv103: keep only one of the near-identical pair unless size allows.
if (chosen.has('strv103') && chosen.has('strv103a')) chosen.delete('strv103a');

// 2. Nation-bloc coverage: heaviest-built representative per bloc.
const blocs = [...new Set(selectableFleet.map((f) => f.bloc))].sort();
for (const bloc of blocs) {
  pick(selectableFleet.filter((f) => f.bloc === bloc).sort(byVertexDesc)[0] || null, `nation:${bloc}`);
}

// 3. Structural quotas on top of whatever step 2 already satisfied.
const countWhere = (pred) => [...chosen.keys()].map((id) => fleet.find((f) => f.id === id)).filter(pred).length;
const quotaPicks = [
  { pred: (f) => f.casemate, min: 3, reason: 'quota:casemate>=3' },
  { pred: (f) => f.class === 'ifv', min: 2, reason: 'quota:ifv>=2' },
  { pred: (f) => f.class === 'td', min: 1, reason: 'quota:td>=1' },
  { pred: (f) => f.class === 'heavy', min: 1, reason: 'quota:heavy>=1' },
  { pred: (f) => f.era === 'ww2', min: 3, reason: 'quota:ww2>=3' },
  { pred: (f) => f.era === 'coldwar', min: 1, reason: 'quota:coldwar>=1' },
  { pred: (f) => f.hasEraPlates, min: 2, reason: 'quota:era-plated>=2' },
];
for (const q of quotaPicks) {
  let have = countWhere(q.pred);
  for (const v of selectableFleet.filter(q.pred).sort(byVertexDesc)) {
    if (have >= q.min) break;
    if (!chosen.has(v.id)) { chosen.set(v.id, []); have++; }
    addReason(v.id, q.reason);
  }
}

// 4. Decoration extremes across the whole measured fleet.
pick(findId(() => true), 'extreme:heaviest-build');
{
  const lightest = selectableFleet.filter((f) => !chosen.has(f.id))
    .sort((a, b) => a.vertexTotal - b.vertexTotal || (a.id < b.id ? -1 : 1))[0];
  pick(lightest, 'extreme:lightest-build');
}

// 5. Lazy-group coverage (every dynamic chunk + eager path represented).
for (const [label] of GROUP_LABELS) {
  const rep = findId((f) => f.group === label);
  pick(rep, `group:${label}`);
}
{
  const eagerRep = findId((f) => f.group === 'eager');
  pick(eagerRep, 'group:eager');
}

// 6. Deterministic fill to SAMPLE_SIZE: rotate nation blocs, prefer heavier
// builds inside each rotation so slots stay visually informative.
{
  const remaining = selectableFleet.filter((f) => !chosen.has(f.id)).sort(byVertexDesc);
  let i = 0;
  while (chosen.size < SAMPLE_SIZE && remaining.length) {
    const bloc = blocs[i % blocs.length];
    const next = remaining.find((f) => f.bloc === bloc);
    if (next) { chosen.set(next.id, ['fill:bloc-rotation']); addReason(next.id, 'fill:bloc-rotation'); }
    i++;
    if (i > blocs.length * 4) {
      // Some bloc may be exhausted; take global heaviest leftovers.
      const fallback = remaining.find((f) => !chosen.has(f.id));
      if (!fallback) break;
      chosen.set(fallback.id, ['fill:global']);
    }
  }
}

const sampleIds = ONLY_IDS.length ? ONLY_IDS : [...chosen.keys()].sort();
const sampleRows = sampleIds.map((id) => fleet.find((f) => f.id === id)).filter(Boolean);

function printDerivation() {
  console.log(`\nw3-fleet-visual sample (${sampleRows.length} of ${fleet.length}):`);
  console.log('id | nation(bloc) | class/era | group | flags | verts | reasons');
  for (const f of sampleRows) {
    const flags = [
      f.casemate ? 'casemate' : null,
      f.hasEraPlates ? 'era-plated' : null,
      f.unusualSuspension ? 'odd-susp' : null,
      f.productionHidden ? 'prod-hidden' : null,
    ].filter(Boolean).join(',') || '-';
    const why = ONLY_IDS.length ? ['--only'] : (chosen.get(f.id) || []);
    console.log(`${f.id} | ${f.nation}(${f.bloc}) | ${f.class}/${f.era} | ${f.group} | ${flags} | ${f.vertexTotal} | ${why.join('+')}`);
  }
  const cov = (label, pred) => `${label}=${sampleRows.filter(pred).length}`;
  console.log(cov('casemate', (f) => f.casemate), cov('ifv', (f) => f.class === 'ifv'),
    cov('ww2', (f) => f.era === 'ww2'), cov('coldwar', (f) => f.era === 'coldwar'),
    cov('era-plated', (f) => f.hasEraPlates),
    `blocs=${new Set(sampleRows.map((f) => f.bloc)).size}/${blocs.length}`,
    `groups=${new Set(sampleRows.map((f) => f.group)).size}/${GROUP_LABELS.length + 1}`,
    `prod-hidden=${sampleRows.filter((f) => f.productionHidden).length}`);
}

if (DRY_RUN) {
  printDerivation();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'sample.json'), JSON.stringify({
    version: 1,
    mode: 'dry-run',
    universe: UNIVERSE_MODE,
    registered: ALL_TANK_IDS.length,
    measurable: fleet.length,
    productionVisibleFleet: productionVisible.size,
    sampleSize: sampleRows.length,
    sample: sampleRows,
    reasons: Object.fromEntries([...chosen.entries()].filter(([id]) => sampleIds.includes(id))),
  }, null, 1));
  console.log(`\nw3-fleet-visual dry-run receipt: ${join(OUT_DIR, 'sample.json')}`);
  process.exit(0);
}

// ============================================================================
// Phase C — headed browser runtime (phase 2; NOT exercised by --dry-run)
// ============================================================================

const failures = [];
let checks = 0;
function check(stage, name, cond, detail = '') {
  checks++;
  const tag = `[${stage}] ${name}`;
  if (cond) console.log(`  PASS ${tag}${detail ? ` (${detail})` : ''}`);
  else { failures.push(`${tag}${detail ? ` — ${detail}` : ''}`); console.error(`  FAIL ${tag}${detail ? ` (${detail})` : ''}`); }
}
const warn = (msg) => { failures.push(`WARN: ${msg}`); console.warn(`  WARN ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Coarse pixel stats from a PNG buffer via the repo's dependency-free codec. */
function pixelStats(pngBuffer) {
  const img = decodePng(pngBuffer); // throws on undecodable input
  const { width, height, data } = img;
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  // Border median color (10px inset ring) as the background estimate.
  const borderLums = [];
  const inset = 10;
  for (let x = 0; x < width; x += 16) {
    borderLums.push(lum(((inset * width) + x) * 4), lum((((height - inset - 1) * width) + x) * 4));
  }
  for (let y = 0; y < height; y += 16) {
    borderLums.push(lum((y * width + inset) * 4), lum((y * width + (width - inset - 1)) * 4));
  }
  borderLums.sort((a, b) => a - b);
  const bg = borderLums[borderLums.length >> 1];
  let sum = 0; let sumSq = 0; let n = 0; let silhouette = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const l = lum((y * width + x) * 4);
      sum += l; sumSq += l * l; n++;
      if (Math.abs(l - bg) > 18) silhouette++; // ~7% luminance delta vs background
    }
  }
  const mean = sum / n;
  return {
    width, height,
    meanLum: mean,
    stddevLum: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    silhouetteFraction: silhouette / n,
  };
}

async function shoot(page, file) {
  const buffer = await page.screenshot({ type: 'png' });
  const path = join(OUT_DIR, file);
  writeFileSync(path, buffer);
  try {
    return { file: path, ...pixelStats(buffer) };
  } catch (err) {
    warn(`${file}: PNG decode failed (${err.message})`);
    return { file: path, decodeFailed: true };
  }
}

let server = null;
let browser = null;
const report = { version: 1, generatedAtIso: new Date().toISOString(), map: MAP_ID, headless: HEADLESS, universe: UNIVERSE_MODE, vehicles: {}, summary: {} };
try {
  server = await createServer({
    root: resolve(import.meta.dirname, '..'),
    logLevel: 'error',
    server: { port: PORT_BASE, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await server.listen();
  const port = server.config.server.port;

  browser = await puppeteer.launch({
    headless: HEADLESS,
    protocolTimeout: 600000,
    args: [
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion',
      '--window-position=40,40', '--window-size=1380,860', '--no-first-run',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

  await page.goto(`http://localhost:${port}/?nosplash=1&tier=desktop&gfxreset=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__GAME_READY === true', { timeout: 240000, polling: 250 });

  for (const meta of sampleRows) {
    const id = meta.id;
    const veh = { screenshots: {}, checks: {} };
    report.vehicles[id] = veh;
    console.log(`\n=== ${id} (${meta.nation} ${meta.class}, ${meta.group}) ===`);
    try {
      // ---- garage pedestal -------------------------------------------------
      await page.evaluate((vid) => window.__DEBUG.selectGarageTank(vid), id);
      await sleep(1800); // pedestal switch chain settle
      {
        const ped = await page.evaluate(() => ({
          selected: window.__DEBUG.selectedSpecId,
          onStage: window.__DEBUG.pedestalOnStage,
        }));
        check(id, 'garage pedestal shows vehicle', ped.selected === id && !!ped.onStage, `selected=${ped.selected}`);
        veh.screenshots.garage = await shoot(page, `${id}/garage.png`);
      }

      // ---- battle entry ----------------------------------------------------
      await page.evaluate(async (vid, m) => {
        await window.__DEBUG.beginSoloBattle({ specId: vid, mapId: m });
      }, id, MAP_ID);
      try {
        await page.waitForFunction(
          'window.__DEBUG.game.phase === "battle" && window.__DEBUG.game.preBattleS <= 0',
          { timeout: 420000, polling: 500 },
        );
      } catch {
        throw new Error('battle-open timeout');
      }
      await sleep(800);
      veh.screenshots.battleSpawn = await shoot(page, `${id}/battle-spawn.png`);

      // ---- articulation sweep ----------------------------------------------
      const poses = [
        { yawDeg: 90, pitchDeg: 6 },
        { yawDeg: -60, pitchDeg: -5 },
        { yawDeg: 150, pitchDeg: 12 },
      ];
      let poseIdx = 0;
      for (const pose of poses) {
        poseIdx++;
        await page.evaluate((_id, p) => {
          const player = window.__DEBUG.game.player;
          if (player?.state) {
            player.state.turretYaw = (p.yawDeg * Math.PI) / 180;
            player.state.gunPitch = (p.pitchDeg * Math.PI) / 180;
          }
          window.__DEBUG.fastForward(0.15);
        }, id, pose);
        await sleep(250);
        veh.screenshots[`pose${poseIdx}`] = await shoot(page, `${id}/pose${poseIdx}.png`);
      }

      // ---- muzzle anchor sanity + LOD census (defensive hooks) --------------
      const census = await page.evaluate(() => {
        const player = window.__DEBUG.game.player;
        const vis = player?.visual || player?.tank || null;
        const out = { hookFound: !!vis, muzzleFinite: null, detailGroups: null, costlyWrappers: null };
        if (!vis) return out;
        try {
          const tip = vis.gunMuzzleWorld?.({ x: 0, y: 0, z: 0 });
          out.muzzleFinite = tip == null ? null : [tip.x, tip.y, tip.z].every(Number.isFinite);
        } catch { out.muzzleFinite = null; }
        try {
          out.detailGroups = 0; out.costlyWrappers = 0;
          vis.root?.traverse?.((o) => {
            if (o.userData?.battleDetailGroup) out.detailGroups++;
            if (o.userData?.battleCostlyWrapper) out.costlyWrappers++;
          });
        } catch { /* census best-effort */ }
        return out;
      });
      veh.checks.census = census;
      if (!census.hookFound || census.muzzleFinite === null) {
        warn(`${id}: muzzle-anchor hook unavailable at runtime — recorded, not gated`);
      } else {
        check(id, 'muzzle anchor world pos finite', census.muzzleFinite === true);
      }

      // ---- wreck leg --------------------------------------------------------
      const killed = await page.evaluate(() => {
        const d = window.__DEBUG;
        if (!d.spawnKillShell()) return false;
        d.fastForward(2);
        return !!(d.game.player && d.game.player.combat.destroyed);
      });
      check(id, 'spawnKillShell destroys vehicle', killed);
      await sleep(400);
      veh.screenshots.wreck = await shoot(page, `${id}/wreck.png`);

      // ---- garage return ----------------------------------------------------
      await page.evaluate(() => { window.__DEBUG.leaveBattleToGarage(); });
      try {
        await page.waitForFunction('window.__DEBUG.game.phase === "garage"', { timeout: 120000, polling: 250 });
      } catch {
        throw new Error('garage return timeout');
      }

      // ---- pixel gates ------------------------------------------------------
      for (const [shot, stats] of Object.entries(veh.screenshots)) {
        if (stats.decodeFailed) { check(id, `pixels:${shot}`, false, 'undecodable PNG'); continue; }
        const ok = stats.stddevLum >= 4 && stats.silhouetteFraction >= 0.02 && stats.silhouetteFraction <= 0.9;
        check(id, `pixels:${shot}`, ok,
          `sd=${stats.stddevLum.toFixed(1)} sil=${(stats.silhouetteFraction * 100).toFixed(1)}%`);
      }
    } catch (err) {
      check(id, 'vehicle leg completed', false, String(err).slice(0, 200));
      // Re-sync to garage for the next vehicle if this leg died mid-battle.
      try {
        await page.evaluate(() => { window.__DEBUG.leaveBattleToGarage(); });
        await page.waitForFunction('window.__DEBUG.game.phase === "garage"', { timeout: 90000, polling: 250 });
      } catch { /* next leg will surface it */ }
    }
  }

  const unexpectedErrors = pageErrors.filter((e) => !/ResizeObserver loop/i.test(e));
  check('global', 'zero page errors across sweep', unexpectedErrors.length === 0,
    unexpectedErrors.slice(0, 2).join(' | ').slice(0, 200));

  report.summary = { vehicles: sampleRows.length, checks, failures: failures.length, pageErrors };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 1));
  printDerivation();
  console.log(`\n[w3-fleet-visual] ${failures.length === 0 ? 'GREEN' : 'FAILED'} — ${checks} checks, report: ${join(OUT_DIR, 'report.json')}`);
  process.exit(failures.length === 0 ? 0 : 1);
} catch (err) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({
      ...report, crashed: true, crashMessage: String(err).slice(0, 500),
    }, null, 1));
  } catch { /* best-effort */ }
  console.error(`[w3-fleet-visual] CRASHED: ${String(err).slice(0, 300)}`);
  process.exit(failures.length ? 1 : 2);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (server) await server.close(); } catch { /* ignore */ }
}
