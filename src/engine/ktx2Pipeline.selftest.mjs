// src/engine/ktx2Pipeline.selftest.mjs — Node-safe selftest for the runtime
// KTX2 / Basis Universal loading pipeline (color space contracts, fallback URL
// derivation, headless mock loading, cache/dedup semantics, disposal).
//
// Run: node src/engine/ktx2Pipeline.selftest.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Ktx2Pipeline,
  resolveColorSpace,
  inferColorSpace,
  deriveFallbackUrl,
  getGlobalKtx2Pipeline,
} from './ktx2Pipeline.js';

console.log('--- Running ktx2Pipeline.selftest.mjs ---');

// ============================================================================
// 1. Color space resolution contract
// ============================================================================
{
  assert.equal(resolveColorSpace('srgb'), THREE.SRGBColorSpace);
  assert.equal(resolveColorSpace('linear'), THREE.LinearSRGBColorSpace);
  assert.equal(resolveColorSpace('none'), THREE.NoColorSpace);
  // THREE constants pass through unchanged
  assert.equal(resolveColorSpace(THREE.SRGBColorSpace), THREE.SRGBColorSpace);
  assert.equal(resolveColorSpace(THREE.LinearSRGBColorSpace), THREE.LinearSRGBColorSpace);
  assert.equal(resolveColorSpace(THREE.NoColorSpace), THREE.NoColorSpace);
  // Unknown values fail safe to sRGB
  assert.equal(resolveColorSpace('bogus'), THREE.SRGBColorSpace);
  assert.equal(resolveColorSpace(undefined), THREE.SRGBColorSpace);
  console.log('[PASS] 1. Color space resolution contract');
}

// ============================================================================
// 2. Filename-based color space inference
// ============================================================================
{
  assert.equal(inferColorSpace('/textures/terrain/Rock058_Color.ktx2'), THREE.SRGBColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/withered_grass_diff_1k.ktx2'), THREE.SRGBColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_NormalGL.ktx2'), THREE.LinearSRGBColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/withered_grass_nor_gl_1k.ktx2'), THREE.LinearSRGBColorSpace);
  assert.equal(inferColorSpace('/textures/buildings/Planks023A_1K-JPG_Roughness.ktx2'), THREE.NoColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_AmbientOcclusion.ktx2'), THREE.NoColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_orm.ktx2'), THREE.NoColorSpace);
  assert.equal(inferColorSpace('/textures/terrain/Rock058_metallic.ktx2'), THREE.NoColorSpace);
  console.log('[PASS] 2. Filename-based color space inference');
}

// ============================================================================
// 3. Fallback URL derivation
// ============================================================================
{
  assert.equal(deriveFallbackUrl('/textures/terrain/Grass004_1K-JPG_Color.ktx2'), '/textures/terrain/Grass004_1K-JPG_Color.jpg');
  assert.equal(deriveFallbackUrl('/textures/terrain/Grass004_1K-JPG_Color.ktx2', '.png'), '/textures/terrain/Grass004_1K-JPG_Color.png');
  // FX / particle atlases must fall back to PNG to preserve alpha
  assert.equal(deriveFallbackUrl('/fx/particles-smoke.ktx2'), '/fx/particles-smoke.png');
  assert.equal(deriveFallbackUrl('/fx/atlas/particles-jet.ktx2'), '/fx/atlas/particles-jet.png');
  // Non-KTX2 URLs pass through untouched
  assert.equal(deriveFallbackUrl('/textures/ui/logo.png'), '/textures/ui/logo.png');
  console.log('[PASS] 3. Fallback URL derivation');
}

// ============================================================================
// 4. Headless mock loading, texture configuration & dedup semantics
// ============================================================================
{
  const pipeline = new Ktx2Pipeline();
  assert.equal(pipeline.isSupported(), false, 'Node environment must report unsupported');

  const tex = await pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2');
  assert.ok(tex.isTexture, 'must return a valid THREE.Texture');
  assert.equal(tex.userData.mock, true, 'Node loads use the mock path');
  assert.equal(tex.userData.sourceUrl, '/textures/terrain/Grass004_Color.ktx2');
  assert.equal(tex.colorSpace, THREE.SRGBColorSpace, 'albedo infers sRGB');
  assert.equal(tex.wrapS, THREE.RepeatWrapping);
  assert.equal(tex.wrapT, THREE.RepeatWrapping);
  assert.equal(tex.magFilter, THREE.LinearFilter);

  // Explicit colorSpace option overrides filename inference
  const linearTex = await pipeline.loadTexture('/textures/data/custom.ktx2', { colorSpace: 'linear' });
  assert.equal(linearTex.colorSpace, THREE.LinearSRGBColorSpace);

  // Identical URL + options deduplicate to one promise
  const p1 = pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2');
  const p2 = pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2');
  assert.equal(p1, p2, 'identical requests must share the in-flight promise');

  // Different sampling state must NOT share the cached texture
  const clamped = await pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2', {
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
  assert.notEqual(clamped, tex, 'different wrap state requires its own texture');
  assert.equal(clamped.wrapS, THREE.ClampToEdgeWrapping);

  // Explicit mipmap policy participates in the cache key
  const mipmapped = await pipeline.loadTexture('/textures/terrain/Grass004_Color.ktx2', { generateMipmaps: true });
  assert.notEqual(mipmapped, tex);
  assert.equal(mipmapped.generateMipmaps, true);

  console.log('[PASS] 4. Headless mock loading, texture configuration & dedup semantics');
}

// ============================================================================
// 5. PBR set loader applies per-map color spaces
// ============================================================================
{
  const pipeline = new Ktx2Pipeline();
  const acg = await pipeline.loadPbrSet('/textures/terrain', 'Grass004_1K-JPG');
  assert.equal(acg.color.colorSpace, THREE.SRGBColorSpace);
  assert.equal(acg.normal.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(acg.rough.colorSpace, THREE.NoColorSpace);
  assert.equal(acg.ao.colorSpace, THREE.NoColorSpace);

  const polyhaven = await pipeline.loadPbrSet('/textures/terrain', 'withered_grass_1k');
  assert.equal(polyhaven.color.colorSpace, THREE.SRGBColorSpace);
  assert.equal(polyhaven.normal.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(polyhaven.rough.colorSpace, THREE.NoColorSpace);
  assert.equal(polyhaven.ao.colorSpace, THREE.NoColorSpace);
  pipeline.dispose();
  console.log('[PASS] 5. PBR set loader applies per-map color spaces');
}

// ============================================================================
// 6. Dispose clears caches and stays idempotent / reusable
// ============================================================================
{
  const pipeline = new Ktx2Pipeline();
  const texA = await pipeline.loadTexture('/textures/a_Color.ktx2');
  pipeline.dispose();
  assert.equal(pipeline._loadedTextures.size, 0, 'loaded textures released');
  assert.equal(pipeline._cache.size, 0, 'promise cache cleared');
  assert.equal(pipeline._ktx2Loader, null, 'loader released');
  pipeline.dispose(); // idempotent

  const texB = await pipeline.loadTexture('/textures/a_Color.ktx2');
  assert.notEqual(texB, texA, 'post-dispose load creates a fresh texture');
  console.log('[PASS] 6. Dispose clears caches and stays idempotent / reusable');
}

// ============================================================================
// 7. Global singleton identity & renderer-init safety
// ============================================================================
{
  const a = getGlobalKtx2Pipeline();
  const b = getGlobalKtx2Pipeline();
  assert.equal(a, b, 'global pipeline is a singleton');
  // Passing a renderer in Node must be a safe no-op (no DOM/WebGL present)
  assert.equal(a.init({ domElement: {} }), a, 'init returns this even when inert');
  assert.equal(a._renderer, null, 'renderer binding is skipped in Node');
  console.log('[PASS] 7. Global singleton identity & renderer-init safety');
}

console.log('ktx2Pipeline.selftest: all assertions passed');
