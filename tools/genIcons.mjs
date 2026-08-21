// Fleet tank-asset generator. Each tank receives the five gameplay views plus
// data-driven hit-zone, armor/penetration and module diagrams. A checked
// manifest binds every file to the exact rendered geometry and gameplay data.
//
// Marking-sheet dedup: tanks whose national-marking sheets render identically
// ship one shared, content-addressed payload (`_markings_shared_<sha12>.png`)
// instead of one byte-identical PNG per tank. The manifest references the
// shared file from every member tank, which is exactly what
// tools/tank-assets-check.mjs and the tankAssets selftest verify against —
// both follow each record's `file` field and never assume the
// `<id>_markings.png` shape. Conventional per-tank names stay single-owner,
// so selective `--tanks` regeneration and retirement pruning stay local: a
// regenerated sheet adopts the existing shared file when its bytes match,
// otherwise it falls back to its own `<id>_markings.png`, and the prune pass
// deletes only files that no surviving manifest record references.
//
// Usage:
//   node tools/genIcons.mjs
//   node tools/genIcons.mjs --tanks m1a2,bmp2
//   node tools/genIcons.mjs --ids=m1a2,bmp2   (compatibility alias)
//   node tools/genIcons.mjs --views hitZonesSide,armorSide,modulesSide
//   node tools/genIcons.mjs --out /tmp/icons --ids=m1a2 --allow-partial
//   node tools/genIcons.mjs --dedup-existing   (browser-free: collapse the
//       byte-identical marking sheets already recorded in the manifest)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { TANK_ASSET_SCHEMA_VERSION, TANK_ASSET_VIEWS } from '../src/vehicles/tankAssets.js';

const args = process.argv.slice(2);
function opt(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// --- marking-sheet dedup core (pure, Node-runnable, covered by selftest) ----

export const MARKINGS_SHARED_PREFIX = '_markings_shared_';

/** Content-addressed filename for a shared marking sheet. */
export function sharedMarkingsName(shaHex) {
  return `${MARKINGS_SHARED_PREFIX}${String(shaHex).replace(/[^0-9a-f]/g, '').slice(0, 12)}.png`;
}

export function isSharedMarkingsName(file) {
  return typeof file === 'string' && file.startsWith(MARKINGS_SHARED_PREFIX) && file.endsWith('.png');
}

/**
 * Assign each freshly rendered marking sheet a concrete output file. Sheets
 * with identical bytes share one content-addressed file — adopting an already
 * shipped shared file when possible — while a sheet with no sharing partner
 * keeps its own single-owner `<id>_markings.png`.
 * @param {Map<string, Buffer>} buffersByTank tank id -> PNG bytes rendered this run
 * @param {Map<string, string>} [existingSharedByHash] sha256 -> shared file already shipped
 * @returns {{ targetByTank: Map<string, {file: string, buffer: Buffer}>, sharedWrites: Map<string, Buffer> }}
 */
export function assignMarkingsTargets(buffersByTank, existingSharedByHash = new Map()) {
  const byHash = new Map();
  for (const [id, buffer] of buffersByTank) {
    const sha = sha256(buffer);
    if (!byHash.has(sha)) byHash.set(sha, []);
    byHash.get(sha).push(id);
  }
  const targetByTank = new Map();
  const sharedWrites = new Map();
  for (const [sha, ids] of byHash) {
    if (ids.length === 1 && !existingSharedByHash.has(sha)) {
      targetByTank.set(ids[0], { file: `${ids[0]}_markings.png`, buffer: buffersByTank.get(ids[0]) });
      continue;
    }
    const file = existingSharedByHash.get(sha) || sharedMarkingsName(sha);
    for (const id of ids) targetByTank.set(id, { file, buffer: buffersByTank.get(id) });
    if (!existingSharedByHash.has(sha)) sharedWrites.set(file, buffersByTank.get(ids[0]));
  }
  return { targetByTank, sharedWrites };
}

/** Previous-manifest files that no surviving asset record references anymore. */
export function planPrune(previousFiles, referencedFiles) {
  return [...previousFiles].filter((file) => !referencedFiles.has(file)).sort();
}

/** Write only when the bytes on disk differ, so no-op runs leave files untouched. */
function writeIfChanged(outDir, file, buffer) {
  const path = resolve(outDir, file);
  if (existsSync(path)) {
    if (readFileSync(path).equals(buffer)) return { existed: true, changed: false };
    writeFileSync(path, buffer);
    return { existed: true, changed: true };
  }
  writeFileSync(path, buffer);
  return { existed: false, changed: true };
}

function assetRecord(outDir, file, view) {
  const def = TANK_ASSET_VIEWS[view];
  const buffer = readFileSync(resolve(outDir, file));
  return {
    file,
    width: def.width,
    height: def.height,
    mime: def.ext === 'png' ? 'image/png' : 'image/webp',
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
}

/**
 * Collapse byte-identical marking sheets already recorded in a complete
 * manifest — no browser, no rendering. Every marking record is verified
 * against its file first; a drifted tree refuses to migrate. The manifest is
 * rewritten only when something actually changed, so the pass is idempotent.
 */
export function dedupExistingMarkings({ outDir, manifestPath, manifest }) {
  if (!manifest || !manifest.tanks || !Object.keys(manifest.tanks).length) {
    throw new Error('needs an existing complete manifest; run the full fleet once first');
  }
  const buffersByTank = new Map();
  const records = new Map();
  for (const [id, tank] of Object.entries(manifest.tanks)) {
    const rec = tank.assets && tank.assets.markings;
    if (!rec || !rec.file) continue;
    const buffer = readFileSync(resolve(outDir, rec.file));
    if (sha256(buffer) !== rec.sha256 || buffer.length !== rec.bytes) {
      throw new Error(`${id}: ${rec.file} drifted from its manifest record; regenerate the fleet before deduplicating`);
    }
    buffersByTank.set(id, buffer);
    records.set(id, rec);
  }
  const previousFiles = new Set();
  for (const tank of Object.values(manifest.tanks)) {
    for (const asset of Object.values(tank.assets || {})) {
      if (asset && asset.file) previousFiles.add(asset.file);
    }
  }
  const existingSharedByHash = new Map();
  for (const [, rec] of records) {
    if (isSharedMarkingsName(rec.file)) existingSharedByHash.set(rec.sha256, rec.file);
  }

  const { targetByTank, sharedWrites } = assignMarkingsTargets(buffersByTank, existingSharedByHash);
  let createdFiles = 0;
  let createdBytes = 0;
  for (const [file, buffer] of sharedWrites) {
    const result = writeIfChanged(outDir, file, buffer);
    if (result.changed && !result.existed) {
      createdFiles++;
      createdBytes += buffer.length;
    }
  }

  const groups = new Map();
  let repointed = 0;
  for (const [id, tank] of Object.entries(manifest.tanks)) {
    const target = targetByTank.get(id);
    if (!target) continue;
    const rec = tank.assets.markings;
    if (rec && rec.file !== target.file) {
      tank.assets.markings = assetRecord(outDir, target.file, 'markings');
      repointed++;
    }
    if (isSharedMarkingsName(target.file)) {
      if (!groups.has(target.file)) groups.set(target.file, []);
      groups.get(target.file).push(id);
    }
  }

  const referenced = new Set();
  for (const tank of Object.values(manifest.tanks)) {
    for (const asset of Object.values(tank.assets || {})) {
      if (asset && asset.file) referenced.add(asset.file);
    }
  }
  const stale = planPrune(previousFiles, referenced);
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const file of stale) {
    const path = resolve(outDir, file);
    try {
      deletedBytes += statSync(path).size;
    } catch { /* already gone */ }
    rmSync(path, { force: true });
    deletedFiles++;
  }

  if (repointed || deletedFiles || createdFiles) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {
    groups: [...groups.entries()]
      .map(([file, ids]) => ({ file, ids: ids.sort() }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    repointed,
    deletedFiles,
    deletedBytes,
    createdFiles,
    createdBytes,
  };
}

// --- generation driver ------------------------------------------------------

async function main() {
  const outDir = resolve(opt('out', 'public/icons'));
  const selected = opt('tanks') || opt('ids');
  const onlyTanks = selected ? selected.split(',').map((id) => id.trim()).filter(Boolean) : [];
  const selectedViews = opt('views')
    ? opt('views').split(',').map((view) => view.trim()).filter(Boolean)
    : Object.keys(TANK_ASSET_VIEWS);
  const allowPartial = args.includes('--allow-partial');
  const manifestPath = resolve(outDir, 'tank-assets.json');
  mkdirSync(outDir, { recursive: true });

  function readManifest() {
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  }

  let startingManifest = readManifest();
  for (const view of selectedViews) {
    if (!TANK_ASSET_VIEWS[view]) {
      console.error(`[tank-assets] Unknown view '${view}'. Expected one of: ${Object.keys(TANK_ASSET_VIEWS).join(', ')}`);
      process.exit(1);
    }
  }
  if (args.includes('--dedup-existing')) {
    if (onlyTanks.length) {
      console.error('[tank-assets] dedup FAILED: --dedup-existing operates on the whole manifest; drop --tanks/--ids');
      process.exit(1);
    }
    if (!startingManifest) {
      console.error('[tank-assets] dedup FAILED: missing tank-assets.json; run the full fleet once first');
      process.exit(1);
    }
    if (startingManifest.schemaVersion !== TANK_ASSET_SCHEMA_VERSION) {
      console.error(`[tank-assets] dedup FAILED: manifest schema ${startingManifest.schemaVersion} != generator schema ${TANK_ASSET_SCHEMA_VERSION}; regenerate the full fleet first`);
      process.exit(1);
    }
    try {
      const summary = dedupExistingMarkings({ outDir, manifestPath, manifest: startingManifest });
      for (const group of summary.groups) {
        console.log(`[tank-assets] ${group.file} <- ${group.ids.join(', ')}`);
      }
      const net = summary.deletedBytes - summary.createdBytes;
      console.log(`[tank-assets] dedup: ${summary.repointed} record(s) repointed, `
        + `${summary.createdFiles} shared file(s) created (${summary.createdBytes} bytes), `
        + `${summary.deletedFiles} duplicate file(s) removed (${summary.deletedBytes} bytes), `
        + `net ${net >= 0 ? '' : '-'}${Math.abs(net)} bytes`);
    } catch (error) {
      console.error(`[tank-assets] dedup FAILED: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (selectedViews.length < Object.keys(TANK_ASSET_VIEWS).length && !startingManifest && !allowPartial) {
    console.error('[tank-assets] Selective view generation needs an existing complete manifest.');
    process.exit(1);
  }
  if (onlyTanks.length && !startingManifest && !allowPartial) {
    console.error('[tank-assets] Selective generation needs an existing complete manifest;');
    console.error('[tank-assets] run the full fleet once or pass --allow-partial for scratch output.');
    process.exit(1);
  }
  if (startingManifest && startingManifest.schemaVersion !== TANK_ASSET_SCHEMA_VERSION) {
    if (onlyTanks.length) {
      console.error(`[tank-assets] Manifest schema ${startingManifest.schemaVersion} is incompatible with generator schema ${TANK_ASSET_SCHEMA_VERSION}; regenerate the full fleet.`);
      process.exit(1);
    }
    console.log(`[tank-assets] schema ${startingManifest.schemaVersion} -> ${TANK_ASSET_SCHEMA_VERSION}; regenerating the complete fleet`);
    startingManifest = null;
  }

  const viteCacheDir = resolve('/tmp', `cot-icons-vite-${process.pid}`);
  const server = await createServer({
    root: process.cwd(), configFile: false, cacheDir: viteCacheDir,
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 7400 + (process.pid % 200), strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : server.config.server.port;
  const url = `http://127.0.0.1:${port}/tools/icons-page.html`;
  console.log(`[tank-assets] studio ${url}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-gl=angle', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon') && !message.text().includes('404')) {
      pageErrors.push(message.text());
    }
  });

  let failed = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('window.__ICONS_READY === true', { timeout: 60000 });
    await page.evaluate((ids) => window.__WARM(ids), onlyTanks);
    await page.waitForFunction(
      () => {
        window.__GLB_POLLS = (window.__GLB_POLLS || 0) + 1;
        const stats = window.__GLB_STATS;
        if (!stats) return window.__GLB_POLLS >= 10;
        const settled = stats.started === stats.settled;
        window.__GLB_SETTLE_STREAK = settled ? (window.__GLB_SETTLE_STREAK || 0) + 1 : 0;
        return window.__GLB_SETTLE_STREAK >= 2;
      },
      { timeout: 120000, polling: 400 },
    );

    const generated = await page.evaluate((ids, views) => window.__GEN(ids, views), onlyTanks, selectedViews);

    // Deduplicate marking sheets before anything is written: identical bytes
    // share one content-addressed file instead of one PNG per tank.
    const markingsBuffers = new Map();
    if (selectedViews.includes('markings')) {
      for (const [id, meta] of Object.entries(generated.tanks)) {
        const name = meta.requiredFiles && meta.requiredFiles.markings;
        const dataUrl = name && generated.files[name];
        if (dataUrl) markingsBuffers.set(id, Buffer.from(dataUrl.split(',')[1], 'base64'));
      }
    }
    const existingSharedByHash = new Map();
    if (startingManifest && startingManifest.tanks) {
      for (const tank of Object.values(startingManifest.tanks)) {
        const rec = tank.assets && tank.assets.markings;
        if (!rec || !isSharedMarkingsName(rec.file)) continue;
        try {
          const buffer = readFileSync(resolve(outDir, rec.file));
          if (sha256(buffer) === rec.sha256) existingSharedByHash.set(rec.sha256, rec.file);
          else console.warn(`[tank-assets] shared sheet ${rec.file} drifted from its record; skipping adoption`);
        } catch { /* missing file: regeneration recreates the content */ }
      }
    }
    const { targetByTank, sharedWrites } = assignMarkingsTargets(markingsBuffers, existingSharedByHash);
    const supersededNames = new Set();
    for (const [id, target] of targetByTank) {
      const meta = generated.tanks[id];
      const name = meta && meta.requiredFiles && meta.requiredFiles.markings;
      if (name && name !== target.file) supersededNames.add(name);
    }

    for (const [name, dataUrl] of Object.entries(generated.files)) {
      if (name.endsWith('.error')) {
        failed = true;
        console.error(`[tank-assets] ${name}: ${dataUrl}`);
        continue;
      }
      if (supersededNames.has(name)) continue;
      const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
      writeFileSync(resolve(outDir, name), buffer);
      console.log(`[tank-assets] wrote ${name} (${Math.round(buffer.length / 1024)} KB)`);
    }
    for (const [file, buffer] of sharedWrites) {
      const result = writeIfChanged(outDir, file, buffer);
      if (result.changed) console.log(`[tank-assets] wrote ${file} (${Math.round(buffer.length / 1024)} KB)`);
    }

    if (!failed) {
      const previous = startingManifest;
      const tanks = onlyTanks.length && previous ? { ...previous.tanks } : {};
      for (const [id, meta] of Object.entries(generated.tanks)) {
        const assets = { ...(previous?.tanks?.[id]?.assets || {}) };
        for (const [view, file] of Object.entries(meta.requiredFiles)) {
          if (!selectedViews.includes(view)) continue;
          const target = view === 'markings' ? targetByTank.get(id) : undefined;
          assets[view] = assetRecord(outDir, target ? target.file : file, view);
        }
        tanks[id] = { ...meta, assets };
        delete tanks[id].requiredFiles;
      }
      const sortedTanks = Object.fromEntries(Object.entries(tanks).sort(([a], [b]) => a.localeCompare(b)));
      const manifest = {
        schemaVersion: TANK_ASSET_SCHEMA_VERSION,
        partial: onlyTanks.length ? (previous ? !!previous.partial : true) : false,
        generator: 'tools/genIcons.mjs',
        requiredViews: Object.keys(TANK_ASSET_VIEWS),
        tanks: sortedTanks,
      };
      // Reference-counted prune: delete only files named by the previous
      // manifest that no surviving record references — retired tanks, marking
      // sheets whose sharing group dissolved, replaced shared payloads. Never
      // a directory glob: unrelated UI art in the icon directory is untouched.
      if (previous && previous.tanks) {
        const referenced = new Set();
        for (const tank of Object.values(manifest.tanks)) {
          for (const asset of Object.values(tank.assets || {})) {
            if (asset && asset.file) referenced.add(asset.file);
          }
        }
        const previousFiles = new Set();
        for (const tank of Object.values(previous.tanks)) {
          for (const asset of Object.values(tank.assets || {})) {
            if (asset && asset.file) previousFiles.add(asset.file);
          }
        }
        const stale = planPrune(previousFiles, referenced);
        for (const file of stale) rmSync(resolve(outDir, file), { force: true });
        if (stale.length) console.log(`[tank-assets] pruned ${stale.length} unreferenced generated file(s): ${stale.join(', ')}`);
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`[tank-assets] ${Object.keys(generated.tanks).length} tanks, ${Object.keys(generated.files).length - supersededNames.size} files -> ${outDir}`);
      console.log(`[tank-assets] manifest ${manifestPath}`);
    }
  } catch (error) {
    failed = true;
    console.error(`[tank-assets] FAILED: ${error.message}`);
  } finally {
    if (pageErrors.length) {
      failed = true;
      console.error(`[tank-assets] page errors (${pageErrors.length}):`);
      for (const error of pageErrors.slice(0, 20)) console.error(`  ${error}`);
    }
    await browser.close();
    await server.close();
    rmSync(viteCacheDir, { recursive: true, force: true });
  }

  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
