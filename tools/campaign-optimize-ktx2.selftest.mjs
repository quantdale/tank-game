// tools/campaign-optimize-ktx2.selftest.mjs — Comprehensive selftest for KTX2 / Basis Universal
// optimization tooling, container serialization, color space handling, mipmap generation,
// runtime loading pipeline, and VRAM footprint metrics.
//
// Run: node tools/campaign-optimize-ktx2.selftest.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import {
  classifyTexture,
  TEXTURE_PROFILES,
  getJpegMetadata,
  generateMipmaps,
  estimateVramUsage,
  createKtx2Container,
  encodeKtx2,
  optimizeTextureToKtx2,
  processTextureDirectory,
  getKeyValueString,
  getJpegDecoder,
} from './campaign-optimize-ktx2.mjs';
import {
  Ktx2Pipeline,
  resolveColorSpace,
  inferColorSpace,
  deriveFallbackUrl,
  getGlobalKtx2Pipeline,
} from '../src/engine/ktx2Pipeline.js';
import { read as readKtx2 } from '../node_modules/three/examples/jsm/libs/ktx-parse.module.js';
import { encodePng } from './campaign-png.mjs';

console.log('--- Running campaign-optimize-ktx2.selftest.mjs ---');

// ============================================================================
// 1. Texture classification & color space routing
// ============================================================================
{
  const albedo = classifyTexture('public/textures/terrain/Grass004_1K-JPG_Color.jpg');
  assert.equal(albedo.profile, TEXTURE_PROFILES.ALBEDO);
  assert.equal(albedo.colorSpace, 'srgb');
  assert.equal(albedo.hasAlpha, false);

  const phAlbedo = classifyTexture('public/textures/terrain/withered_grass_diff_1k.jpg');
  assert.equal(phAlbedo.profile, TEXTURE_PROFILES.ALBEDO);
  assert.equal(phAlbedo.colorSpace, 'srgb');

  const normal = classifyTexture('public/textures/terrain/Grass004_1K-JPG_NormalGL.jpg');
  assert.equal(normal.profile, TEXTURE_PROFILES.NORMAL);
  assert.equal(normal.colorSpace, 'linear');

  const phNormal = classifyTexture('public/textures/terrain/withered_grass_nor_gl_1k.jpg');
  assert.equal(phNormal.profile, TEXTURE_PROFILES.NORMAL);
  assert.equal(phNormal.colorSpace, 'linear');

  const rough = classifyTexture('public/textures/buildings/Planks023A_1K-JPG_Roughness.jpg');
  assert.equal(rough.profile, TEXTURE_PROFILES.DATA_ORM);
  assert.equal(rough.colorSpace, 'linear');

  const ao = classifyTexture('public/textures/terrain/withered_grass_ao_1k.jpg');
  assert.equal(ao.profile, TEXTURE_PROFILES.DATA_ORM);
  assert.equal(ao.colorSpace, 'linear');

  const vfx = classifyTexture('public/fx/particles-smoke.png');
  assert.equal(vfx.profile, TEXTURE_PROFILES.PARTICLE_ATLAS);
  assert.equal(vfx.colorSpace, 'srgb');
  assert.equal(vfx.hasAlpha, true);

  // SA-10 r1 regression pin: the fx-directory heuristic matches whole path
  // SEGMENTS only. An ancestor whose name merely ends in "fx" (Windows
  // %TEMP% mkdtemp suffixes, sibling project folders) must not flip an
  // albedo source into a particle atlas — that exact shape flaked section 9
  // mid-chain before the segment-anchor fix.
  const tailFx = join(tmpdir(), 'cot-ktx2-jpeg-ABgfx', 'solid_Color.jpg');
  assert.equal(classifyTexture(tailFx).profile, TEXTURE_PROFILES.ALBEDO,
    'ancestor name ending in "fx" is not an fx directory');
  const segPath = process.platform === 'win32'
    ? 'D:\\proj\\public\\fx\\solid_Color.jpg'
    : '/proj/public/fx/solid_Color.jpg';
  assert.equal(classifyTexture(segPath).profile, TEXTURE_PROFILES.PARTICLE_ATLAS,
    'a real fx path segment still classifies as particle atlas');

  console.log('[PASS] 1. Texture classification & color space routing');
}

// ============================================================================
// 2. JPEG header parser
// ============================================================================
{
  // Construct minimal valid JPEG stream with SOF0 marker
  const fakeJpg = Buffer.from([
    0xff, 0xd8,             // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x04, 0x00, 0x03, // SOF0: precision 8, H 512, W 1024, 3 channels
    0xff, 0xd9              // EOI
  ]);
  const meta = getJpegMetadata(fakeJpg);
  assert.ok(meta, 'JPEG metadata must parse');
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 512);
  assert.equal(meta.channels, 3);

  assert.equal(getJpegMetadata(Buffer.from([1, 2, 3])), null, 'invalid buffer returns null');
  console.log('[PASS] 2. JPEG header parser');
}

// ============================================================================
// 3. Mipmap generation: sRGB gamma, normal renormalization, aspect ratio
// ============================================================================
{
  // Test A: 64x64 sRGB texture produces 7 mip levels (64, 32, 16, 8, 4, 2, 1)
  const w = 64, h = 64;
  const pixels = new Uint8Array(w * h * 4);
  pixels.fill(128); // 50% gray
  const srgbMips = generateMipmaps(pixels, w, h, { colorSpace: 'srgb' });
  assert.equal(srgbMips.length, 7, '64x64 image must produce 7 mip levels');
  assert.equal(srgbMips[0].width, 64);
  assert.equal(srgbMips[0].height, 64);
  assert.equal(srgbMips[6].width, 1);
  assert.equal(srgbMips[6].height, 1);

  // Test B: Normal map tangent vector renormalization
  // Authors flat normal (128, 128, 255) -> (0, 0, 1)
  const normPixels = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    normPixels[i * 4] = 128;
    normPixels[i * 4 + 1] = 128;
    normPixels[i * 4 + 2] = 255;
    normPixels[i * 4 + 3] = 255;
  }
  const normMips = generateMipmaps(normPixels, 16, 16, { isNormalMap: true, colorSpace: 'linear' });
  assert.equal(normMips.length, 5);
  // Bottom 1x1 mip level must preserve (128, 128, 255)
  const lastMip = normMips[4].data;
  assert.equal(lastMip[0], 128);
  assert.equal(lastMip[1], 128);
  assert.equal(lastMip[2], 255);

  // Test C: Non-square dimensions (256x96 -> particle jet)
  const nonSquareMips = generateMipmaps(new Uint8Array(256 * 96 * 4), 256, 96);
  assert.equal(nonSquareMips[0].width, 256);
  assert.equal(nonSquareMips[0].height, 96);
  const finalLevel = nonSquareMips[nonSquareMips.length - 1];
  assert.equal(finalLevel.width, 1);
  assert.equal(finalLevel.height, 1);

  console.log('[PASS] 3. Mipmap generation');
}

// ============================================================================
// 4. KTX2 container serialization and round-trip parsing
// ============================================================================
{
  const imgData = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < imgData.length; i += 4) {
    imgData[i] = 200;
    imgData[i + 1] = 100;
    imgData[i + 2] = 50;
    imgData[i + 3] = 255;
  }

  // 4a. sRGB Albedo KTX2
  const ktx2Albedo = encodeKtx2({ width: 32, height: 32, data: imgData }, {
    profile: TEXTURE_PROFILES.ALBEDO,
    colorSpace: 'srgb',
    sourceHash: 'test-hash-123',
  });

  // Verify KTX2 magic identifier: 0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A
  assert.equal(ktx2Albedo[0], 0xAB);
  assert.equal(ktx2Albedo[1], 0x4B); // 'K'
  assert.equal(ktx2Albedo[2], 0x54); // 'T'
  assert.equal(ktx2Albedo[3], 0x58); // 'X'

  const parsedAlbedo = readKtx2(new Uint8Array(ktx2Albedo));
  assert.equal(parsedAlbedo.pixelWidth, 32);
  assert.equal(parsedAlbedo.pixelHeight, 32);
  assert.equal(parsedAlbedo.levels.length, 6); // 32, 16, 8, 4, 2, 1
  assert.equal(parsedAlbedo.dataFormatDescriptor[0].transferFunction, 2); // KHR_DF_TRANSFER_SRGB = 2
  assert.equal(getKeyValueString(parsedAlbedo, 'COT_sourceHash'), 'test-hash-123');

  // 4b. Linear Normal KTX2
  const ktx2Normal = encodeKtx2({ width: 32, height: 32, data: imgData }, {
    profile: TEXTURE_PROFILES.NORMAL,
    colorSpace: 'linear',
  });
  const parsedNormal = readKtx2(new Uint8Array(ktx2Normal));
  assert.equal(parsedNormal.dataFormatDescriptor[0].transferFunction, 1); // KHR_DF_TRANSFER_LINEAR = 1

  console.log('[PASS] 4. KTX2 container serialization and round-trip parsing');
}

// ============================================================================
// 5. Determinism & content-hash caching
// ============================================================================
{
  const imgData = new Uint8Array(16 * 16 * 4);
  imgData.fill(77);
  const buf1 = encodeKtx2({ width: 16, height: 16, data: imgData }, { sourceHash: 'hash-a' });
  const buf2 = encodeKtx2({ width: 16, height: 16, data: imgData }, { sourceHash: 'hash-a' });
  assert.ok(buf1.equals(buf2), 'identical inputs must produce bit-exact KTX2 buffers');

  console.log('[PASS] 5. Determinism & content-hash caching');
}

// ============================================================================
// 6. VRAM footprint calculations
// ============================================================================
{
  // 1024x1024 texture:
  // Uncompressed RGBA = 1024*1024*4 * 1.3333 = ~5.59 MB (5592404 bytes)
  // BC7/ASTC 4x4 (min 4x4 block padding at 2x2 and 1x1) = 1398128 bytes (75% savings)
  // BC1/ETC1 = 699064 bytes (87.5% savings)
  const vram = estimateVramUsage(1024, 1024, 11);
  assert.equal(vram.uncompressedRgbaBytes, 5592404);
  assert.equal(vram.bc7AstcBytes, 1398128);
  assert.equal(vram.savingsBc7Percent, 75.0);

  console.log('[PASS] 6. VRAM footprint calculations');
}

// ============================================================================
// 7. Runtime Ktx2Pipeline API and fallback logic
// ============================================================================
{
  const pipeline = new Ktx2Pipeline();

  // Test color space inferencing
  assert.equal(inferColorSpace('/textures/terrain/Rock058_Color.ktx2'), THREE.SRGBColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_NormalGL.ktx2'), THREE.LinearSRGBColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_Roughness.ktx2'), THREE.NoColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_ao.ktx2'), THREE.NoColorSpace);

  // Test fallback derivation
  assert.equal(deriveFallbackUrl('/textures/terrain/Grass004_1K-JPG_Color.ktx2'), '/textures/terrain/Grass004_1K-JPG_Color.jpg');
  assert.equal(deriveFallbackUrl('/fx/particles-smoke.ktx2'), '/fx/particles-smoke.png');

  // Test mock loading in Node environment
  const texPromise1 = pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2');
  const texPromise2 = pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2');
  assert.equal(texPromise1, texPromise2, 'in-flight promises for identical URL must be deduplicated');

  const tex = await texPromise1;
  assert.ok(tex.isTexture, 'must return a valid THREE.Texture');
  assert.equal(tex.colorSpace, THREE.SRGBColorSpace, 'albedo texture must have sRGB colorSpace');
  assert.equal(tex.wrapS, THREE.RepeatWrapping);

  // Test PBR set loader
  const pbr = await pipeline.loadPbrSet('/textures/terrain', 'Grass004_1K-JPG');
  assert.equal(pbr.color.colorSpace, THREE.SRGBColorSpace);
  assert.equal(pbr.normal.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(pbr.rough.colorSpace, THREE.NoColorSpace);
  assert.equal(pbr.ao.colorSpace, THREE.NoColorSpace);

  pipeline.dispose();

  console.log('[PASS] 7. Runtime Ktx2Pipeline API and fallback logic');
}

// ============================================================================
// 8. End-to-end Directory Processing & Manifest Generation
// ============================================================================
{
  const tempDir = mkdtempSync(join(tmpdir(), 'cot-ktx2-selftest-'));
  try {
    const pngPixels = new Uint8Array(16 * 16 * 4);
    pngPixels.fill(200);
    const pngBytes = encodePng({ width: 16, height: 16, data: pngPixels }, { colorType: 'rgba' });

    writeFileSync(join(tempDir, 'test_Color.png'), pngBytes);
    writeFileSync(join(tempDir, 'test_NormalGL.png'), pngBytes);

    const manifestPath = join(tempDir, 'manifest.json');
    const { results, summary } = processTextureDirectory(tempDir, {
      write: true,
      manifestOut: manifestPath,
    });

    assert.equal(results.length, 2, 'both test textures processed');
    assert.equal(summary.totalTextures, 2);
    assert.ok(existsSync(join(tempDir, 'test_Color.ktx2')), 'Color KTX2 written');
    assert.ok(existsSync(join(tempDir, 'test_NormalGL.ktx2')), 'Normal KTX2 written');
    assert.ok(existsSync(manifestPath), 'Manifest JSON written');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.summary.totalTextures, 2);

    // Re-run should skip and report cached
    const rerun = processTextureDirectory(tempDir, { write: true });
    assert.equal(rerun.results.every((r) => r.cached), true, 'second run must use cache');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('[PASS] 8. End-to-end Directory Processing & Manifest Generation');
}

// ============================================================================
// 9. Optional JPEG decode path (jpeg-js present: real conversion; absent: safe skip)
// ============================================================================
{
  const decoder = getJpegDecoder();
  if (decoder && typeof decoder.encode === 'function') {
    const tempDir = mkdtempSync(join(tmpdir(), 'cot-ktx2-jpeg-'));
    try {
      // Encode a solid-color 8x8 JPEG with the same package's encoder, then
      // verify the KTX2 level-0 texels round-trip within lossy tolerance.
      const w = 8, h = 8;
      const rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = 200;
        rgba[i * 4 + 1] = 100;
        rgba[i * 4 + 2] = 50;
        rgba[i * 4 + 3] = 255;
      }
      const jpg = decoder.encode({ data: rgba, width: w, height: h }, 90);
      assert.ok(jpg && jpg.data && jpg.data.length > 4, 'encoder produced a JPEG stream');
      writeFileSync(join(tempDir, 'solid_Color.jpg'), Buffer.from(jpg.data));

      const { results } = processTextureDirectory(tempDir, { write: true });
      assert.equal(results.length, 1, 'JPEG source processed when decoder present');
      assert.equal(results[0].profile, TEXTURE_PROFILES.ALBEDO);
      assert.ok(results[0].width === 8 && results[0].height === 8);

      const parsed = readKtx2(new Uint8Array(readFileSync(join(tempDir, 'solid_Color.ktx2'))));
      assert.equal(parsed.pixelWidth, 8);
      assert.equal(parsed.pixelHeight, 8);
      const px = parsed.levels[0].levelData;
      assert.ok(Math.abs(px[0] - 200) <= 12, `R near 200, got ${px[0]}`);
      assert.ok(Math.abs(px[1] - 100) <= 12, `G near 100, got ${px[1]}`);
      assert.ok(Math.abs(px[2] - 50) <= 12, `B near 50, got ${px[2]}`);
      assert.equal(px[3], 255);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    console.log('[PASS] 9. Optional JPEG decode path (real pixel round-trip)');
  } else {
    console.log('[SKIP] 9. Optional JPEG decode path (jpeg-js not installed — JPEG sources are skipped safely)');
  }
}

console.log('campaign-optimize-ktx2.selftest: all assertions passed');