// Selftest for tools/campaign-png.mjs — the W11 campaign's dependency-free
// PNG codec. Proves lossless decode/encode round trips across color types,
// filter paths, and odd sizes, plus the gray+alpha safety rejection.
// Run: node tools/campaign-png.selftest.mjs

import assert from 'node:assert/strict';
import { decodePng, encodePng, fnv1a } from './campaign-png.mjs';

// seeded LCG — deterministic pseudo-random pixel content (no Math.random)
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

function makeImage(w, h, seed, { gray = false } = {}) {
  const rnd = lcg(seed);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (gray) {
      const v = Math.floor(rnd() * 256);
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
      data[i * 4 + 3] = Math.floor(rnd() * 256);
    } else {
      for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.floor(rnd() * 256);
    }
  }
  return { width: w, height: h, data };
}

const roundTripExact = (img, opts) =>
  Buffer.from(decodePng(encodePng(img, opts)).data).equals(Buffer.from(img.data));

// 1. RGBA round trips across sizes and content shapes (exercises every row
//    filter through the heuristic, including prev-row predictor propagation).
for (const [w, h, seed] of [[1, 1, 1], [3, 5, 2], [64, 64, 3], [128, 96, 4], [17, 31, 5]]) {
  assert.ok(roundTripExact(makeImage(w, h, seed), { colorType: 'rgba' }), `rgba round trip ${w}x${h}`);
}

// 2. Gray+alpha round trips on genuinely grayscale content.
for (const [w, h, seed] of [[1, 1, 6], [7, 13, 7], [256, 96, 8]]) {
  assert.ok(roundTripExact(makeImage(w, h, seed, { gray: true }), { colorType: 'grayalpha' }),
    `grayalpha round trip ${w}x${h}`);
}

// 3. Gradient content where Up/Average/Paeth predictors dominate (the shape
//    that regressed before the reconstructed-prev-row fix).
{
  const w = 100, h = 80;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = (x + y) & 0xff;
      data[i + 3] = (x * y) & 0xff;
    }
  }
  const img = { width: w, height: h, data };
  assert.ok(roundTripExact(img, { colorType: 'grayalpha' }), 'gradient grayalpha round trip');
  assert.ok(roundTripExact(img, { colorType: 'rgba' }), 'gradient rgba round trip');
}

// 4. Non-gray content must be REJECTED by the grayalpha encoder, not mangled.
assert.throws(() => encodePng(makeImage(8, 8, 9), { colorType: 'grayalpha' }),
  /non-gray/, 'grayalpha must reject non-gray pixels');

// 5. Encoding is deterministic: same input, same bytes.
{
  const img = makeImage(32, 32, 10, { gray: true });
  assert.equal(
    Buffer.compare(encodePng(img, { colorType: 'grayalpha' }), encodePng(img, { colorType: 'grayalpha' })),
    0, 'encodePng must be deterministic');
}

// 6. Palette PNGs (color type 3) with tRNS decode to correct RGBA.
{
  // hand-build a 2x1 palette PNG: indices [0, 1], palette red/green, tRNS a=77
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    // crc32 over type+data
    let crc = 0xffffffff;
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 3;
  const plte = Buffer.from([255, 0, 0, 0, 255, 0]);
  const trns = Buffer.from([77, 255]);
  const raw = Buffer.from([0, 0, 1]); // filter none, indices 0,1
  const { deflateSync } = await import('node:zlib');
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  const img = decodePng(png);
  assert.deepEqual([...img.data.slice(0, 4)], [255, 0, 0, 77], 'palette px0 with tRNS alpha');
  assert.deepEqual([...img.data.slice(4, 8)], [0, 255, 0, 255], 'palette px1 opaque');
}

// 7. fnv1a stability and input sensitivity.
assert.equal(fnv1a(Buffer.from([1, 2, 3])), fnv1a(Buffer.from([1, 2, 3])), 'fnv1a deterministic');
assert.notEqual(fnv1a(Buffer.from([1, 2, 3])), fnv1a(Buffer.from([1, 2, 4])), 'fnv1a input-sensitive');

console.log('campaign-png.selftest: all assertions passed');
