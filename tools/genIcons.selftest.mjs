// Selftest for tools/genIcons.mjs marking-sheet dedup — proves identical
// marking sheets collapse into one content-addressed shared file, that every
// rewritten manifest record still satisfies the tank-assets-check contract
// (existence + sha256 + byte size + decoded dimensions), that pruning never
// touches referenced or unrelated files, and that the pass is idempotent.
// Run: node tools/genIcons.selftest.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKINGS_SHARED_PREFIX, assignMarkingsTargets, dedupExistingMarkings,
  isSharedMarkingsName, planPrune, sharedMarkingsName,
} from './genIcons.mjs';
import { decodePng, encodePng } from './campaign-png.mjs';
import { TANK_ASSET_SCHEMA_VERSION } from '../src/vehicles/tankAssets.js';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Deterministic 256x128 marking-shaped fixtures (flat field + painted blocks).
function sheet(bytes) {
  const data = new Uint8Array(256 * 128 * 4);
  for (let i = 0; i < 256 * 128; i++) {
    data[i * 4] = bytes[i % bytes.length];
    data[i * 4 + 1] = 250;
    data[i * 4 + 2] = 240;
    data[i * 4 + 3] = (i * 7) % 3 === 0 ? 0 : 255;
  }
  return encodePng({ width: 256, height: 128, data }, { colorType: 'rgba' });
}
const SHEET_A = sheet([12, 34, 56]);
const SHEET_B = sheet([98, 76, 54]);
assert.notEqual(Buffer.compare(SHEET_A, SHEET_B), 0, 'fixtures must differ');

function recordFor(buffer, file) {
  return {
    file,
    width: 256,
    height: 128,
    mime: 'image/png',
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
}

// 1. naming helpers
{
  const name = sharedMarkingsName('0123456789abcdef'.repeat(4));
  assert.equal(name, `${MARKINGS_SHARED_PREFIX}0123456789ab.png`);
  assert.equal(isSharedMarkingsName(name), true, 'shared name recognized');
  assert.equal(isSharedMarkingsName('m1a2_markings.png'), false, 'conventional name not shared');
}

// 2. assignment: identical sheets share, distinct sheets stay single-owner
{
  const buffers = new Map([['alpha', SHEET_A], ['bravo', SHEET_A], ['charlie', SHEET_B]]);
  const { targetByTank, sharedWrites } = assignMarkingsTargets(buffers);
  const sharedName = sharedMarkingsName(sha256(SHEET_A));
  assert.equal(targetByTank.get('alpha').file, sharedName);
  assert.equal(targetByTank.get('bravo').file, sharedName, 'identical sheets share one file');
  assert.equal(targetByTank.get('charlie').file, 'charlie_markings.png', 'distinct sheet stays single-owner');
  assert.deepEqual([...sharedWrites.keys()], [sharedName], 'only the new shared file is written');
  assert.equal(sharedWrites.get(sharedName).equals(SHEET_A), true);

  // adoption: an already-shipped shared file with matching bytes is reused,
  // even by a lone tank, and produces no redundant write
  const existing = new Map([[sha256(SHEET_A), 'legacy_shared_file.png']]);
  const adopted = assignMarkingsTargets(new Map([['delta', SHEET_A]]), existing);
  assert.equal(adopted.targetByTank.get('delta').file, 'legacy_shared_file.png');
  assert.equal(adopted.sharedWrites.size, 0, 'adoption must not rewrite the shipped file');
}

// 3. prune planning: previous-manifest files minus surviving references
{
  const stale = planPrune(
    ['a_markings.png', `${MARKINGS_SHARED_PREFIX}x.png`, 'kept_top.webp'],
    new Set([`${MARKINGS_SHARED_PREFIX}x.png`, 'kept_top.webp']),
  );
  assert.deepEqual(stale, ['a_markings.png'], 'only unreferenced previous files are pruned, sorted');
}

// 4. end-to-end --dedup-existing against a temp icon directory
{
  const outDir = mkdtempSync(join(tmpdir(), 'gen-icons-dedup-'));
  try {
    const manifestPath = join(outDir, 'tank-assets.json');
    const fixtureBytes = new Map();
    const webpRecord = (file, seed) => {
      const buffer = Buffer.alloc(10 + seed, seed);
      fixtureBytes.set(file, buffer);
      return { file, bytes: buffer.length, sha256: sha256(buffer) };
    };
    const markingsRecord = (buffer, file) => {
      fixtureBytes.set(file, buffer);
      return recordFor(buffer, file);
    };
    const manifest = {
      schemaVersion: TANK_ASSET_SCHEMA_VERSION,
      partial: false,
      generator: 'tools/genIcons.mjs',
      requiredViews: ['angle', 'markings'],
      tanks: {
        alpha: { id: 'alpha', assets: {
          angle: webpRecord('alpha_angle.webp', 1),
          markings: markingsRecord(SHEET_A, 'alpha_markings.png'),
        } },
        bravo: { id: 'bravo', assets: {
          angle: webpRecord('bravo_angle.webp', 2),
          markings: markingsRecord(SHEET_A, 'bravo_markings.png'),
        } },
        charlie: { id: 'charlie', assets: {
          angle: webpRecord('charlie_angle.webp', 3),
          markings: markingsRecord(SHEET_B, 'charlie_markings.png'),
        } },
      },
    };
    for (const [file, buffer] of fixtureBytes) writeFileSync(join(outDir, file), buffer);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const summary = dedupExistingMarkings({ outDir, manifestPath, manifest });
    const sharedName = summary.groups[0] && summary.groups[0].file;
    assert.ok(sharedName && isSharedMarkingsName(sharedName), 'one shared group reported');
    assert.deepEqual(summary.groups[0].ids, ['alpha', 'bravo'], 'group lists both members');
    assert.equal(summary.repointed, 2, 'both duplicate records repointed');
    assert.equal(summary.createdFiles, 1, 'one shared file created');
    assert.equal(summary.deletedFiles, 2, 'both private duplicates removed');
    assert.equal(summary.deletedBytes - summary.createdBytes, SHEET_A.length, 'net saving equals one sheet');

    // shared payload holds the exact bytes; private copies are gone
    assert.equal(readFileSync(join(outDir, sharedName)).equals(SHEET_A), true, 'shared bytes preserved');
    assert.equal(existsSync(join(outDir, 'alpha_markings.png')), false, 'duplicate removed');
    assert.equal(existsSync(join(outDir, 'bravo_markings.png')), false, 'duplicate removed');
    assert.equal(existsSync(join(outDir, 'charlie_markings.png')), true, 'distinct sheet kept');
    assert.equal(existsSync(join(outDir, 'alpha_angle.webp')), true, 'unrelated view untouched');

    // checker-contract rehearsal: every record's file exists and its recorded
    // sha256/byte-size/decoded dimensions all agree
    const savedText = readFileSync(manifestPath, 'utf8');
    const saved = JSON.parse(savedText);
    assert.equal(saved.schemaVersion, TANK_ASSET_SCHEMA_VERSION);
    for (const tank of Object.values(saved.tanks)) {
      for (const rec of Object.values(tank.assets)) {
        const buffer = readFileSync(join(outDir, rec.file));
        assert.equal(sha256(buffer), rec.sha256, `${rec.file}: hash drift`);
        assert.equal(buffer.length, rec.bytes, `${rec.file}: byte-size drift`);
        if (rec.file.endsWith('.png')) {
          const img = decodePng(buffer);
          assert.equal(img.width, rec.width, `${rec.file}: width`);
          assert.equal(img.height, rec.height, `${rec.file}: height`);
        }
      }
    }
    assert.equal(saved.tanks.alpha.assets.markings.file, sharedName);
    assert.equal(saved.tanks.bravo.assets.markings.file, sharedName);
    assert.equal(saved.tanks.charlie.assets.markings.file, 'charlie_markings.png',
      'single-owner sheet keeps its conventional name');

    // single-owner invariant: a conventional markings file is referenced only
    // by the tank whose id it carries
    for (const [id, tank] of Object.entries(saved.tanks)) {
      const file = tank.assets.markings.file;
      if (!isSharedMarkingsName(file)) assert.equal(file, `${id}_markings.png`);
    }

    // idempotent: a second pass changes nothing at all
    const again = dedupExistingMarkings({ outDir, manifestPath, manifest: saved });
    assert.equal(again.repointed + again.createdFiles + again.deletedFiles, 0, 'second pass is a no-op');
    assert.equal(readFileSync(manifestPath, 'utf8'), savedText, 'manifest bytes unchanged across passes');

    // drift guard: a file that no longer matches its record refuses to migrate
    writeFileSync(join(outDir, 'charlie_markings.png'), SHEET_A); // silent swap
    assert.throws(
      () => dedupExistingMarkings({ outDir, manifestPath, manifest: JSON.parse(savedText) }),
      /charlie_markings\.png drifted/,
      'drifted tree must abort instead of migrating',
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

console.log('genIcons.selftest: marking-sheet dedup contract verified');
