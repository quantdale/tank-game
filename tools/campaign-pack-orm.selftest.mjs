// tools/campaign-pack-orm.selftest.mjs — Selftest for packed ORM pipeline and consolidation tooling.
// Run: node tools/campaign-pack-orm.selftest.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  packOrmData,
  unpackOrmData,
  packOrmPng,
  decodeImage,
  encodeOrmImage,
  scanPbrSets,
  packAllPbrSets,
  measureOrmSavings,
} from './campaign-pack-orm.mjs';
import { decodePng, encodePng, fnv1a } from './campaign-png.mjs';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Channel packing & default values
// ---------------------------------------------------------------------------
{
  const W = 4, H = 4, TOTAL = W * H;
  const ao = new Uint8Array(TOTAL);
  const rough = new Uint8Array(TOTAL);
  const metal = new Uint8Array(TOTAL);

  for (let i = 0; i < TOTAL; i++) {
    ao[i] = (i * 15) & 255;
    rough[i] = (255 - i * 12) & 255;
    metal[i] = (i % 2 === 0 ? 0 : 255);
  }

  const packed = packOrmData(ao, rough, metal, W, H);
  assert.equal(packed.width, W);
  assert.equal(packed.height, H);
  assert.equal(packed.data.length, TOTAL * 4);

  for (let i = 0; i < TOTAL; i++) {
    const o = i * 4;
    assert.equal(packed.data[o + 0], ao[i], `Pixel ${i} Red channel must match AO`);
    assert.equal(packed.data[o + 1], rough[i], `Pixel ${i} Green channel must match Roughness`);
    assert.equal(packed.data[o + 2], metal[i], `Pixel ${i} Blue channel must match Metalness`);
    assert.equal(packed.data[o + 3], 255, `Pixel ${i} Alpha channel must be 255`);
  }

  // Unpack round-trip
  const unpacked = unpackOrmData(packed.data, W, H);
  assert.deepEqual(unpacked.ao, ao, 'Unpacked AO must match source');
  assert.deepEqual(unpacked.rough, rough, 'Unpacked Roughness must match source');
  assert.deepEqual(unpacked.metal, metal, 'Unpacked Metalness must match source');

  console.log('[pack-orm] test 1 passed: channel packing and unpack round-trip verified');
}

// ---------------------------------------------------------------------------
// 2. Missing channel defaults & fallback handling
// ---------------------------------------------------------------------------
{
  const W = 2, H = 2, TOTAL = W * H;
  const rough = new Uint8Array([100, 150, 200, 250]);

  // AO missing (defaults to 255), Metal missing (defaults to 0)
  const packedDefault = packOrmData(null, rough, null, W, H);
  for (let i = 0; i < TOTAL; i++) {
    assert.equal(packedDefault.data[i * 4 + 0], 255, 'Default AO must be 255 (full occlusion)');
    assert.equal(packedDefault.data[i * 4 + 1], rough[i], 'Roughness must match input');
    assert.equal(packedDefault.data[i * 4 + 2], 0, 'Default Metalness must be 0 (dielectric)');
    assert.equal(packedDefault.data[i * 4 + 3], 255, 'Alpha must be 255');
  }

  // Custom defaults
  const customPacked = packOrmData(null, null, null, W, H, {
    defaultAo: 240,
    defaultRoughness: 180,
    defaultMetalness: 50,
  });
  for (let i = 0; i < TOTAL; i++) {
    assert.equal(customPacked.data[i * 4 + 0], 240);
    assert.equal(customPacked.data[i * 4 + 1], 180);
    assert.equal(customPacked.data[i * 4 + 2], 50);
    assert.equal(customPacked.data[i * 4 + 3], 255);
  }

  console.log('[pack-orm] test 2 passed: default fallbacks and custom defaults verified');
}

// ---------------------------------------------------------------------------
// 3. PNG decode -> pack -> PNG encode round trip
// ---------------------------------------------------------------------------
{
  const W = 8, H = 8;
  const makeGrayPng = (v) => {
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v(i);
      data[i * 4 + 3] = 255;
    }
    return encodePng({ width: W, height: H, data }, { colorType: 'rgba' });
  };

  const aoPng = makeGrayPng((i) => (i * 3) & 255);
  const roughPng = makeGrayPng((i) => (200 + i * 2) & 255);
  const metalPng = makeGrayPng((i) => (i > 30 ? 255 : 0));

  const result = packOrmPng(aoPng, roughPng, metalPng);
  assert.ok(Buffer.isBuffer(result.buffer), 'Result must contain PNG buffer');
  assert.equal(result.width, W);
  assert.equal(result.height, H);

  // Decode packed PNG and verify channels
  const decoded = decodePng(result.buffer);
  assert.equal(decoded.width, W);
  assert.equal(decoded.height, H);

  for (let i = 0; i < W * H; i++) {
    assert.equal(decoded.data[i * 4 + 0], (i * 3) & 255, 'Decoded Red is AO');
    assert.equal(decoded.data[i * 4 + 1], (200 + i * 2) & 255, 'Decoded Green is Roughness');
    assert.equal(decoded.data[i * 4 + 2], i > 30 ? 255 : 0, 'Decoded Blue is Metalness');
    assert.equal(decoded.data[i * 4 + 3], 255, 'Decoded Alpha is 255');
  }

  // Determinism check
  const result2 = packOrmPng(aoPng, roughPng, metalPng);
  assert.equal(sha256(result.buffer), sha256(result2.buffer), 'Packing must be deterministic');

  console.log('[pack-orm] test 3 passed: PNG encode/decode round trip & determinism verified');
}

// ---------------------------------------------------------------------------
// 3b. JPEG source ingestion (SA-05): ambientCG/Poly Haven sets ship JPG maps,
//     so Node-side packing must decode JPEG. Round-trip through jpeg-js both
//     ways; channel fidelity within codec tolerance, alpha exact.
// ---------------------------------------------------------------------------
{
  const W = 32, H = 32, TOTAL = W * H;
  const jpeg = (await import('jpeg-js')).default;

  const makeJpeg = (fn) => {
    const data = new Uint8Array(TOTAL * 4);
    for (let i = 0; i < TOTAL; i++) {
      const v = fn(i) & 255;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    return Buffer.from(jpeg.encode({ data, width: W, height: H }, 92).data);
  };

  const aoPngBuf = makeJpeg((i) => 40 + ((i * 7) % 200));
  const roughPngBuf = makeJpeg((i) => 230 - ((i * 5) % 190));
  const metalPngBuf = makeJpeg((i) => (i % 3 === 0 ? 255 : 0));

  // Decode fidelity sanity: the tool's decoder must land near the source bytes
  const decAo = decodeImage(aoPngBuf);
  assert.equal(decAo.format, 'jpg');
  assert.equal(decAo.width, W);
  let maxDrift = 0;
  for (let i = 0; i < TOTAL; i++) {
    maxDrift = Math.max(maxDrift, Math.abs(decAo.data[i * 4] - (40 + ((i * 7) % 200))));
  }
  assert.ok(maxDrift <= 12, `JPEG decode drift ${maxDrift} must stay within codec tolerance`);

  const result = packOrmPng(aoPngBuf, roughPngBuf, metalPngBuf, { format: 'png' });
  assert.ok(Buffer.isBuffer(result.buffer));
  // Packing copies decoded bytes verbatim into channels — exact vs decoded input
  for (let i = 0; i < TOTAL; i++) {
    assert.equal(result.data[i * 4 + 0], decAo.data[i * 4], 'R carries decoded AO');
    assert.equal(result.data[i * 4 + 3], 255, 'Alpha stays exactly 255');
  }

  // Determinism across full JPEG pipeline
  const again = packOrmPng(aoPngBuf, roughPngBuf, metalPngBuf, { format: 'png' });
  assert.equal(sha256(result.buffer), sha256(again.buffer), 'JPEG-source packing deterministic');

  console.log('[pack-orm] test 3b passed: JPEG ingestion, channel fidelity, determinism verified');
}

// ---------------------------------------------------------------------------
// 3c. Output container selection: 'jpg' encodes via jpeg-js; 'auto' keeps the
//     smaller of the two and reports which one won.
// ---------------------------------------------------------------------------
{
  const W = 256, H = 256, TOTAL = W * H;
  // Photographic-style content: smooth gradient + mid-frequency mottle plus a
  // deterministic high-frequency grain term, where JPEG decisively beats
  // lossless PNG (mirrors the committed photo sets; tiny fixtures flip the
  // comparison because JPEG's DCT/table overhead dominates small images).
  const data = new Uint8Array(TOTAL * 4);
  const grain = (i) => {
    let h = 2166136261 >>> 0;
    h = Math.imul(h ^ (i * 2654435761), 16777619) >>> 0;
    return (h % 49) - 24; // ±24 deterministic grain
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = 90 + Math.round(60 * Math.sin(x * 0.17) + 40 * Math.sin(y * 0.11 + x * 0.03) + 18 * Math.sin((x + y) * 0.9)) + grain(y * W + x);
      data[i] = v; data[i + 1] = 255 - v / 2; data[i + 2] = ((x * y) & 63) + grain(x + y * 7);
      data[i + 3] = 255;
    }
  }
  const packed = packOrmData(data.slice(0, TOTAL), data.slice(0, TOTAL), null, W, H);

  const asPng = encodeOrmImage(packed, { format: 'png' });
  const asJpg = encodeOrmImage(packed, { format: 'jpg', quality: 90 });
  assert.equal(asPng.format, 'png');
  assert.equal(asJpg.format, 'jpg');
  // Container selection is the contract here; which codec wins depends on
  // content statistics (the live photographic sets favor JPEG decisively —
  // see the bake receipt in docs/GRAPHICS-PERF-CAMPAIGN-2-2026-08-21.md).
  const auto = encodeOrmImage(packed, { format: 'auto' });
  assert.equal(auto.bytes, Math.min(asPng.bytes, asJpg.bytes), 'auto keeps the smaller container');
  assert.equal(auto.format, asJpg.bytes < asPng.bytes ? 'jpg' : 'png');

  // Channel fidelity of the JPEG OUTPUT path: the encoded container must
  // decode back to (near-)identical channel bytes. Guards against encoder
  // option misuse silently flattening content to mid-gray.
  {
    const back = decodeImage(asJpg.buffer);
    let maxDrift = 0;
    for (let i = 0; i < packed.data.length; i++) {
      maxDrift = Math.max(maxDrift, Math.abs(back.data[i] - packed.data[i]));
    }
    assert.ok(maxDrift <= 48, `JPEG ORM round-trip drift ${maxDrift} must stay within codec tolerance`);
    // and the mean must survive per channel (a flat-gray bug shows here;
    // per-pixel drift above is loose because the ±24 grain fixture is exactly
    // where the codec spends its error budget)
    for (const ch of [0, 1, 2]) {
      let s = 0;
      for (let i = ch; i < back.data.length; i += 4) s += back.data[i];
      const mean = s / (back.data.length / 4);
      let sRef = 0;
      for (let i = ch; i < packed.data.length; i += 4) sRef += packed.data[i];
      const refMean = sRef / (packed.data.length / 4);
      assert.ok(Math.abs(mean - refMean) <= 4, `channel ${ch} mean drifted ${mean} vs ${refMean}`);
    }
  }

  // Whatever container auto chose must decode back through the same sniffer
  const roundTrip = decodeImage(auto.buffer);
  assert.equal(roundTrip.width, W);
  assert.equal(roundTrip.height, H);

  console.log(`[pack-orm] test 3c passed: container selection verified (png=${asPng.bytes}B jpg=${asJpg.bytes}B auto=${auto.format})`);
}

// ---------------------------------------------------------------------------
// 4. Synthetic Directory Audit & Packing Execution
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'orm-audit-test-'));
try {
  mkdirSync(join(root, 'public', 'textures', 'terrain'), { recursive: true });
  mkdirSync(join(root, 'public', 'textures', 'buildings'), { recursive: true });

  const makePng = (w, h, fill) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = fill;
      data[i * 4 + 1] = fill;
      data[i * 4 + 2] = fill;
      data[i * 4 + 3] = 255;
    }
    return encodePng({ width: w, height: h, data }, { colorType: 'rgba' });
  };

  // Set 1: ambientCG terrain set with separate AO + Roughness (PNG format)
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'TestRock_1K-JPG_Color.png'), makePng(16, 16, 120));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'TestRock_1K-JPG_NormalGL.png'), makePng(16, 16, 128));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'TestRock_1K-JPG_AmbientOcclusion.png'), makePng(16, 16, 200));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'TestRock_1K-JPG_Roughness.png'), makePng(16, 16, 180));

  // Set 2: Poly Haven terrain set (withered grass style naming)
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'test_grass_diff_1k.png'), makePng(16, 16, 100));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'test_grass_nor_gl_1k.png'), makePng(16, 16, 128));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'test_grass_ao_1k.png'), makePng(16, 16, 220));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'test_grass_rough_1k.png'), makePng(16, 16, 160));

  // Set 3: Building set already pre-packed with ORM
  writeFileSync(join(root, 'public', 'textures', 'buildings', 'TestPlaster_1K-JPG_Color.png'), makePng(16, 16, 150));
  writeFileSync(join(root, 'public', 'textures', 'buildings', 'TestPlaster_1K-JPG_NormalGL.png'), makePng(16, 16, 128));
  writeFileSync(join(root, 'public', 'textures', 'buildings', 'TestPlaster_1K-JPG_ORM.png'), makePng(16, 16, 255));

  // Run audit scan
  const scan = scanPbrSets(root);
  assert.equal(scan.totalSets, 3, 'Scan must discover all 3 PBR sets');
  assert.equal(scan.packableSets, 3, 'All 3 sets are packable or already packed');
  assert.equal(scan.gpuTexturesEliminated, 3, 'Eliminates 3 separate textures');
  assert.equal(scan.textureBindingsSaved, 3, 'Saves 3 texture binding slots');

  const savings = measureOrmSavings(root);
  assert.equal(savings.totalSetsScanned, 3);
  assert.ok(savings.diskBytesConsolidatable > 0);

  // Dry run
  const dryReport = packAllPbrSets(root, { write: false });
  assert.equal(dryReport.write, false);
  const dryRock = dryReport.operations.find((o) => o.set.endsWith('TestRock'));
  assert.ok(dryRock);
  assert.equal(dryRock.written, false);
  assert.equal(existsSync(join(root, dryRock.target)), false, 'Dry run must not create files');

  // Write mode
  const writeReport = packAllPbrSets(root, { write: true });
  assert.equal(writeReport.write, true);
  const writtenRock = writeReport.operations.find((o) => o.set.endsWith('TestRock'));
  assert.ok(writtenRock);
  assert.equal(writtenRock.written, true);
  assert.equal(existsSync(join(root, writtenRock.target)), true, 'Write mode must output ORM file');

  const writtenGrass = writeReport.operations.find((o) => o.set.endsWith('test_grass'));
  assert.ok(writtenGrass);
  assert.equal(writtenGrass.written, true);
  assert.equal(existsSync(join(root, writtenGrass.target)), true, 'Write mode must output Poly Haven ORM file');

  // Verify packed content on disk
  const rockOrmBytes = readFileSync(join(root, writtenRock.target));
  const rockOrm = decodePng(rockOrmBytes);
  assert.equal(rockOrm.width, 16);
  assert.equal(rockOrm.height, 16);
  assert.equal(rockOrm.data[0], 200, 'Red channel must contain AO (200)');
  assert.equal(rockOrm.data[1], 180, 'Green channel must contain Roughness (180)');
  assert.equal(rockOrm.data[2], 0, 'Blue channel must contain Metalness (0)');
  assert.equal(rockOrm.data[3], 255, 'Alpha channel must be 255');

  console.log('[pack-orm] test 4 passed: synthetic asset scan, dry-run and write execution verified');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4b. End-to-end with JPEG sources (SA-05): a full ambientCG-style JPG set
//     must pack in Node, write with the container-matching extension, and
//     honor --format=auto at the packAllPbrSets level.
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'orm-jpg-e2e-'));
  try {
    mkdirSync(join(root, 'public', 'textures', 'terrain'), { recursive: true });

    const jpeg = (await import('jpeg-js')).default;
    const makeJpeg = (w, h, fill) => {
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = fill;
        data[i * 4 + 3] = 255;
      }
      return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
    };

    writeFileSync(join(root, 'public', 'textures', 'terrain', 'JpgRock_1K-JPG_Color.jpg'), makeJpeg(16, 16, 120));
    writeFileSync(join(root, 'public', 'textures', 'terrain', 'JpgRock_1K-JPG_NormalGL.jpg'), makeJpeg(16, 16, 128));
    writeFileSync(join(root, 'public', 'textures', 'terrain', 'JpgRock_1K-JPG_AmbientOcclusion.jpg'), makeJpeg(16, 16, 200));
    writeFileSync(join(root, 'public', 'textures', 'terrain', 'JpgRock_1K-JPG_Roughness.jpg'), makeJpeg(16, 16, 180));

    // Dry run: JPG set is now Node-packable
    const dry = packAllPbrSets(root, { write: false });
    assert.equal(dry.scan.totalSets, 1);
    assert.equal(dry.operations[0].status, 'dry-run-packed', 'JPG set packs without writing');

    // Write with explicit png format keeps the .png target from the scan hint
    const asPng = packAllPbrSets(root, { write: true, format: 'png' });
    assert.equal(asPng.operations[0].written, true);
    assert.equal(asPng.operations[0].ormFormat, 'png');
    assert.ok(existsSync(join(root, 'public', 'textures', 'terrain', 'JpgRock_1K-JPG_ORM.png')));

    // Write with auto format: extension follows whichever container won
    const asAuto = packAllPbrSets(root, { write: true, format: 'auto' });
    const op = asAuto.operations[0];
    assert.equal(op.written, true);
    assert.ok(/\.png$|\.jpg$/.test(op.target), `auto target extension follows container (${op.target})`);
    assert.ok(existsSync(join(root, op.target)), 'auto-written file exists at reported path');
    const decodedBack = decodeImage(readFileSync(join(root, op.target)));
    assert.equal(decodedBack.width, 16);
    assert.equal(decodedBack.height, 16);

    console.log(`[pack-orm] test 4b passed: JPEG e2e pack/write verified (auto chose ${op.ormFormat})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. Verification on live repository public/textures assets (SA-05 final
//    state): every discovered set must be CONSOLIDATED — a packed ORM file
//    on disk, separate AO/Roughness maps retired (net -8.05 MB disk,
//    13.36 MB of separable masks replaced by 5.32 MB of packed ORM).
// ---------------------------------------------------------------------------
{
  const repoScan = scanPbrSets(process.cwd());
  assert.ok(repoScan.totalSets >= 11, `Found ${repoScan.totalSets} PBR sets in repo`);
  const unpacked = repoScan.sets.filter((s) => s.isPackable && !s.isAlreadyPacked);
  assert.deepEqual(unpacked.map((s) => s.set), [],
    `every live set must be already-packed; unpacked: ${unpacked.map((s) => s.set).join(', ')}`);
  // each set's ORM file exists at its target path
  for (const s of repoScan.sets) {
    assert.ok(existsSync(join(process.cwd(), s.targetOrmPath.replace(/\.png$/i, '.jpg'))),
      `${s.set}: packed ORM missing at ${s.targetOrmPath}`);
  }
  assert.ok(repoScan.gpuTexturesEliminated >= 11, 'Calculates eliminated GPU textures');
  assert.ok(repoScan.memoryResidencySaved >= 40 * 1024 * 1024, 'Calculates >40 MB VRAM residency reduction');

  console.log(`[pack-orm] live repo audit: ${repoScan.totalSets} sets, all consolidated `
    + `(${repoScan.gpuTexturesEliminated} GPU textures eliminated, `
    + `${(repoScan.memoryResidencySaved / 1048576).toFixed(1)} MB VRAM residency saved)`);
}

console.log('campaign-pack-orm.selftest: ALL PASS');
