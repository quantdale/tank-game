// Selftest for tools/campaign-optimize-fx-atlases.mjs — proves the FX atlas
// migration only ever writes verified pixel-exact gray+alpha re-encodes and
// passes through anything that is not an alpha-only payload.
// Run: node tools/campaign-optimize-fx-atlases.selftest.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optimizeAtlasPng, optimizeFxAtlasDir } from './campaign-optimize-fx-atlases.mjs';
import { decodePng, encodePng } from './campaign-png.mjs';

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

// alpha-only atlas shaped like the real particle bakes (RGB=255, noisy alpha)
const alphaOnly = (w, h, seed) => {
  const rnd = lcg(seed);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.floor(rnd() * 256);
  }
  return { width: w, height: h, data };
};

// 1. alpha-only input: optimized output decodes to the identical pixels
{
  const img = alphaOnly(64, 64, 11);
  const orig = encodePng(img, { colorType: 'rgba' });
  const opt = optimizeAtlasPng(orig);
  assert.equal(opt.mode, 'grayalpha', 'alpha-only atlas takes the grayalpha path');
  assert.ok(opt.buffer.length < orig.length, 'gray+alpha encoding is smaller');
  const rt = decodePng(opt.buffer);
  assert.equal(Buffer.from(rt.data).equals(Buffer.from(img.data)), true,
    'optimized atlas must decode to byte-identical pixels');
}

// 2. RGB content: passed through untouched (no quality gamble)
{
  const rnd = lcg(12);
  const w = 16, h = 16;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.floor(rnd() * 256);
  const orig = encodePng({ width: w, height: h, data }, { colorType: 'rgba' });
  const opt = optimizeAtlasPng(orig);
  assert.equal(opt.mode, 'passthrough', 'non-alpha-only atlas passes through');
  assert.equal(opt.reason, 'not-alpha-only');
  assert.equal(Buffer.compare(opt.buffer, orig), 0, 'passthrough returns original bytes');
}

// 3. directory run in dry-run mode writes nothing; --write replaces files
{
  const dir = join(mkdtempSync(join(tmpdir(), 'fx-opt-')), 'fx');
  mkdirSync(dir, { recursive: true });
  try {
    const imgA = alphaOnly(32, 32, 13);
    const imgB = alphaOnly(16, 16, 14);
    writeFileSync(join(dir, 'particles-a.png'), encodePng(imgA, { colorType: 'rgba' }));
    writeFileSync(join(dir, 'particles-b.png'), encodePng(imgB, { colorType: 'rgba' }));
    writeFileSync(join(dir, 'unrelated.png'), Buffer.from([1, 2, 3]));

    optimizeFxAtlasDir(dir, { write: false });
    const afterDry = readdirSync(dir).map((n) => readFileSync(join(dir, n)).length);
    // dry run must not touch anything
    assert.equal(afterDry.reduce((a, b) => a + b, 0) > 0, true);

    const summary = optimizeFxAtlasDir(dir, { write: true });
    assert.equal(summary.results.filter((r) => r.written).length, 2, 'both atlases rewritten');
    // pixel-exactness on disk
    const a = decodePng(readFileSync(join(dir, 'particles-a.png')));
    assert.equal(Buffer.from(a.data).equals(Buffer.from(imgA.data)), true, 'a.png pixels preserved');
    const b = decodePng(readFileSync(join(dir, 'particles-b.png')));
    assert.equal(Buffer.from(b.data).equals(Buffer.from(imgB.data)), true, 'b.png pixels preserved');
    // unrelated file untouched
    assert.deepEqual([...readFileSync(join(dir, 'unrelated.png'))], [1, 2, 3]);
    // idempotent: second pass finds nothing to shrink further
    const again = optimizeFxAtlasDir(dir, { write: true });
    assert.equal(again.results.every((r) => !r.written), true,
      're-running on optimized atlases must be a no-op');
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
}

console.log('campaign-optimize-fx-atlases.selftest: all assertions passed');
