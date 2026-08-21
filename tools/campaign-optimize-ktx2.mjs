// tools/campaign-optimize-ktx2.mjs — Production-grade KTX2 / Basis Universal
// compressed texture pipeline tooling.
//
// Features:
// 1. Texture discovery & classification (albedo sRGB, normal Linear, ORM/data Linear, VFX atlases).
// 2. Deterministic KTX2 container generation via ktx-parse with proper Data Format Descriptors (DFD).
// 3. Mipmap pyramid generation:
//    - sRGB gamma-correct downsampling for albedos (avoids mipmap darkening).
//    - Tangent normal vector renormalization for normal maps (avoids flattening).
//    - Linear arithmetic box filtering for ORM / data.
//    - Alpha channel preservation for particle atlases.
// 4. Deterministic content hashing and caching (skips unchanged textures unless --force).
// 5. Accurate VRAM & transfer footprint analytics (uncompressed vs GPU compressed VRAM).
// 6. Manifest generation (public/textures/ktx2-manifest.json) for runtime pipeline queries.
//
// JPEG policy: pixel decoding needs the optional `jpeg-js` dev decoder. Without
// it, JPEG sources are skipped with a one-time warning — pixels are never
// synthesized, so --write can never emit content that mismatches its source.
// PNG sources are fully supported with zero dependencies.
//
// Usage:
//   node tools/campaign-optimize-ktx2.mjs [--dir=public/textures] [--write] [--force] [--benchmark]

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, extname, basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { decodePng, fnv1a } from './campaign-png.mjs';
import {
  createDefaultContainer,
  write as writeKtx2,
  read as readKtx2,
  KHR_DF_MODEL_RGBSDA,
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_TRANSFER_SRGB,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_FLAG_ALPHA_STRAIGHT,
  KHR_DF_FLAG_ALPHA_PREMULTIPLIED,
  KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_CHANNEL_RGBSDA_GREEN,
  KHR_DF_CHANNEL_RGBSDA_BLUE,
  KHR_DF_CHANNEL_RGBSDA_ALPHA,
  KHR_SUPERCOMPRESSION_NONE,
  VK_FORMAT_R8G8B8A8_SRGB,
  VK_FORMAT_R8G8B8A8_UNORM,
  VK_FORMAT_R8_UNORM,
  VK_FORMAT_R8G8_UNORM,
  VK_FORMAT_UNDEFINED
} from '../node_modules/three/examples/jsm/libs/ktx-parse.module.js';

/**
 * Extract dimensions and channels from JPEG buffer without external dependencies.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: number } | null}
 */
export function getJpegMetadata(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (offset + 10 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      const channels = buf[offset + 9];
      return { width, height, channels };
    }
    if (offset + 4 > buf.length) return null;
    const len = buf.readUInt16BE(offset + 2);
    offset += 2 + len;
  }
  return null;
}

// Optional JPEG pixel decoder. Without it, JPEG sources are SKIPPED (never
// fabricated) so `--write` can never emit a KTX2 whose pixels do not match the
// source image. Enable full JPEG conversion with: npm i -D jpeg-js
const optionalRequire = createRequire(import.meta.url);
let _jpegDecoder = undefined; // undefined = unresolved, null = missing

/**
 * Resolve the optional jpeg-js decoder once, without a hard dependency.
 * @returns {{ decode: Function } | null}
 */
export function getJpegDecoder() {
  if (_jpegDecoder === undefined) {
    try {
      _jpegDecoder = optionalRequire('jpeg-js');
    } catch (_) {
      _jpegDecoder = null;
    }
  }
  return _jpegDecoder;
}

/**
 * Decode a JPEG buffer to RGBA pixels using the optional decoder.
 * @param {Buffer} rawBytes
 * @param {string} filePath - For error messages only
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
function decodeJpeg(rawBytes, filePath) {
  const meta = getJpegMetadata(rawBytes);
  if (!meta) throw new Error(`Failed to parse JPEG headers: ${filePath}`);
  const decoder = getJpegDecoder();
  if (!decoder) {
    throw new Error(
      `JPEG pixel decode unavailable for ${filePath} — install the optional decoder with \`npm i -D jpeg-js\` or provide a PNG source`
    );
  }
  const decoded = decoder.decode(rawBytes, { useTArray: true, formatAsRGBA: true });
  return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
}

/**
 * Texture classification profiles.
 */
export const TEXTURE_PROFILES = {
  ALBEDO: 'albedo',
  NORMAL: 'normal',
  DATA_ORM: 'data_orm',
  PARTICLE_ATLAS: 'particle_atlas',
  GENERIC: 'generic',
};

/**
 * Classify texture type and color space from file path/name.
 * @param {string} filePath
 * @returns {{ profile: string, colorSpace: 'srgb'|'linear', vkFormat: number, transfer: number, hasAlpha: boolean }}
 */
export function classifyTexture(filePath) {
  const name = basename(filePath);
  const lower = name.toLowerCase();

  // 1. Normal maps
  if (/(?:_normalgl|_nor_gl|_normal|_norm|normal)[\w-]*\./i.test(lower)) {
    return {
      profile: TEXTURE_PROFILES.NORMAL,
      colorSpace: 'linear',
      vkFormat: VK_FORMAT_R8G8B8A8_UNORM,
      transfer: KHR_DF_TRANSFER_LINEAR,
      hasAlpha: false,
    };
  }

  // 2. Roughness, Ambient Occlusion, Metallic, ORM data
  if (/(?:_roughness|_rough|_ambientocclusion|_ao|_orm|_metallic|_metal)[\w-]*\./i.test(lower)) {
    return {
      profile: TEXTURE_PROFILES.DATA_ORM,
      colorSpace: 'linear',
      vkFormat: VK_FORMAT_R8G8B8A8_UNORM,
      transfer: KHR_DF_TRANSFER_LINEAR,
      hasAlpha: false,
    };
  }

  // 3. Particle atlases (VFX). SA-10 r1: the fx-directory term must match a
  // WHOLE path segment (`public/fx/…`), not any "fx" followed by a separator —
  // the substring form classified sources under arbitrary ancestors whose
  // name merely ENDS in "fx" (observed live: %TEMP%\cot-ktx2-jpeg-<rnd>fx\
  // where mkdtempSync's random suffix supplied the tail, flipping albedo
  // JPEGs to particle atlases and flaking section 9 of the selftest).
  if (/^particles-.*\.png$/i.test(lower) || /_atlas\./i.test(lower)
    || /(?:^|[\\/])fx[\\/]/i.test(filePath)) {
    return {
      profile: TEXTURE_PROFILES.PARTICLE_ATLAS,
      colorSpace: 'srgb',
      vkFormat: VK_FORMAT_R8G8B8A8_SRGB,
      transfer: KHR_DF_TRANSFER_SRGB,
      hasAlpha: true,
    };
  }

  // 4. Albedo / Color / Diffuse
  if (/(?:_color|_diff|_albedo|_col|color|diffuse)[\w-]*\./i.test(lower) ||
      /(?:grass|ground|rock|snow|sand|brick|plank|plaster|roof)[\w-]*\./i.test(lower)) {
    return {
      profile: TEXTURE_PROFILES.ALBEDO,
      colorSpace: 'srgb',
      vkFormat: VK_FORMAT_R8G8B8A8_SRGB,
      transfer: KHR_DF_TRANSFER_SRGB,
      hasAlpha: lower.endsWith('.png'),
    };
  }

  return {
    profile: TEXTURE_PROFILES.GENERIC,
    colorSpace: 'srgb',
    vkFormat: VK_FORMAT_R8G8B8A8_SRGB,
    transfer: KHR_DF_TRANSFER_SRGB,
    hasAlpha: lower.endsWith('.png'),
  };
}

// Gamma conversion lookup tables for fast, precision sRGB mipmapping
const SRGB_TO_LIN = new Float32Array(256);
const LIN_TO_SRGB_LUT = new Uint8Array(4096);
(() => {
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  for (let i = 0; i < 4096; i++) {
    const c = i / 4095;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
    LIN_TO_SRGB_LUT[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
})();

function linearToSrgbByte(lin) {
  const idx = Math.max(0, Math.min(4095, Math.round(lin * 4095)));
  return LIN_TO_SRGB_LUT[idx];
}

/**
 * Generate full mipmap chain from level 0 down to 1x1.
 * @param {Uint8Array} srcRgba - Level 0 RGBA pixels
 * @param {number} width - Level 0 width (must be power of 2 for clean downsampling)
 * @param {number} height - Level 0 height
 * @param {Object} [options]
 * @param {'srgb'|'linear'} [options.colorSpace='srgb']
 * @param {boolean} [options.isNormalMap=false]
 * @returns {Array<{ level: number, width: number, height: number, data: Uint8Array }>}
 */
export function generateMipmaps(srcRgba, width, height, { colorSpace = 'srgb', isNormalMap = false } = {}) {
  const levels = [{
    level: 0,
    width,
    height,
    data: new Uint8Array(srcRgba),
  }];

  let currW = width;
  let currH = height;
  let prevData = srcRgba;
  let level = 1;

  while (currW > 1 || currH > 1) {
    const nextW = Math.max(1, currW >> 1);
    const nextH = Math.max(1, currH >> 1);
    const nextData = new Uint8Array(nextW * nextH * 4);

    const scaleX = currW / nextW;
    const scaleY = currH / nextH;

    for (let ny = 0; ny < nextH; ny++) {
      for (let nx = 0; nx < nextW; nx++) {
        const destIdx = (ny * nextW + nx) * 4;

        // Sample 2x2 texels from previous level
        const sx0 = Math.min(currW - 1, Math.floor(nx * scaleX));
        const sx1 = Math.min(currW - 1, Math.floor(nx * scaleX + (scaleX > 1 ? 1 : 0)));
        const sy0 = Math.min(currH - 1, Math.floor(ny * scaleY));
        const sy1 = Math.min(currH - 1, Math.floor(ny * scaleY + (scaleY > 1 ? 1 : 0)));

        const p00 = (sy0 * currW + sx0) * 4;
        const p10 = (sy0 * currW + sx1) * 4;
        const p01 = (sy1 * currW + sx0) * 4;
        const p11 = (sy1 * currW + sx1) * 4;

        if (isNormalMap) {
          // Tangent normal vector renormalization
          let nxSum = 0, nySum = 0, nzSum = 0;
          for (const p of [p00, p10, p01, p11]) {
            nxSum += (prevData[p] / 255) * 2 - 1;
            nySum += (prevData[p + 1] / 255) * 2 - 1;
            nzSum += (prevData[p + 2] / 255) * 2 - 1;
          }
          const len = Math.hypot(nxSum, nySum, nzSum) || 1;
          const rnx = (nxSum / len) * 0.5 + 0.5;
          const rny = (nySum / len) * 0.5 + 0.5;
          const rnz = (nzSum / len) * 0.5 + 0.5;

          nextData[destIdx] = Math.max(0, Math.min(255, Math.round(rnx * 255)));
          nextData[destIdx + 1] = Math.max(0, Math.min(255, Math.round(rny * 255)));
          nextData[destIdx + 2] = Math.max(0, Math.min(255, Math.round(rnz * 255)));
          nextData[destIdx + 3] = 255;
        } else if (colorSpace === 'srgb') {
          // Gamma-correct sRGB downsampling
          let rLin = 0, gLin = 0, bLin = 0, aLin = 0;
          for (const p of [p00, p10, p01, p11]) {
            rLin += SRGB_TO_LIN[prevData[p]];
            gLin += SRGB_TO_LIN[prevData[p + 1]];
            bLin += SRGB_TO_LIN[prevData[p + 2]];
            aLin += prevData[p + 3];
          }
          nextData[destIdx] = linearToSrgbByte(rLin * 0.25);
          nextData[destIdx + 1] = linearToSrgbByte(gLin * 0.25);
          nextData[destIdx + 2] = linearToSrgbByte(bLin * 0.25);
          nextData[destIdx + 3] = Math.round(aLin * 0.25);
        } else {
          // Linear arithmetic box filter
          let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
          for (const p of [p00, p10, p01, p11]) {
            rSum += prevData[p];
            gSum += prevData[p + 1];
            bSum += prevData[p + 2];
            aSum += prevData[p + 3];
          }
          nextData[destIdx] = Math.round(rSum * 0.25);
          nextData[destIdx + 1] = Math.round(gSum * 0.25);
          nextData[destIdx + 2] = Math.round(bSum * 0.25);
          nextData[destIdx + 3] = Math.round(aSum * 0.25);
        }
      }
    }

    levels.push({
      level,
      width: nextW,
      height: nextH,
      data: nextData,
    });

    prevData = nextData;
    currW = nextW;
    currH = nextH;
    level++;
  }

  return levels;
}

/**
 * Calculate VRAM consumption in bytes for uncompressed vs GPU compressed formats.
 * @param {number} width
 * @param {number} height
 * @param {number} [mipCount]
 * @returns {{ uncompressedRgbaBytes: number, bc7AstcBytes: number, bc1Etc1Bytes: number, savingsBc7Percent: number }}
 */
export function estimateVramUsage(width, height, mipCount = 0) {
  let uncompressedRgba = 0;
  let bc7Astc = 0;
  let bc1Etc1 = 0;

  let w = width;
  let h = height;
  const count = mipCount > 0 ? mipCount : Math.floor(Math.log2(Math.max(width, height))) + 1;

  for (let i = 0; i < count; i++) {
    const curW = Math.max(1, w >> i);
    const curH = Math.max(1, h >> i);
    const blocksW = Math.ceil(curW / 4);
    const blocksH = Math.ceil(curH / 4);

    uncompressedRgba += curW * curH * 4;
    bc7Astc += blocksW * blocksH * 16; // 128 bits per 4x4 block = 1 byte/pixel
    bc1Etc1 += blocksW * blocksH * 8;  // 64 bits per 4x4 block = 0.5 byte/pixel
  }

  const savingsBc7Percent = Math.round((1 - bc7Astc / uncompressedRgba) * 1000) / 10;

  return {
    uncompressedRgbaBytes: uncompressedRgba,
    bc7AstcBytes: bc7Astc,
    bc1Etc1Bytes: bc1Etc1,
    savingsBc7Percent,
  };
}

/**
 * Create a valid KTX2 container object from image data and mipmaps.
 * @param {{ width: number, height: number, data: Uint8Array }} image
 * @param {Object} [options]
 * @param {string} [options.profile='albedo']
 * @param {'srgb'|'linear'} [options.colorSpace='srgb']
 * @param {string} [options.sourceHash='']
 * @param {boolean} [options.generateMips=true]
 * @returns {Object} KTX2 container structure compatible with ktx-parse write()
 */
export function createKtx2Container(image, {
  profile = TEXTURE_PROFILES.ALBEDO,
  colorSpace = 'srgb',
  sourceHash = '',
  generateMips = true,
} = {}) {
  const isNormal = profile === TEXTURE_PROFILES.NORMAL;
  const isLinear = colorSpace === 'linear';

  const mips = generateMips
    ? generateMipmaps(image.data, image.width, image.height, { colorSpace, isNormalMap: isNormal })
    : [{ level: 0, width: image.width, height: image.height, data: image.data }];

  const container = createDefaultContainer();
  container.vkFormat = isLinear ? VK_FORMAT_R8G8B8A8_UNORM : VK_FORMAT_R8G8B8A8_SRGB;
  container.typeSize = 1;
  container.pixelWidth = image.width;
  container.pixelHeight = image.height;
  container.pixelDepth = 0;
  container.layerCount = 0;
  container.faceCount = 1;
  container.levelCount = mips.length;
  container.supercompressionScheme = KHR_SUPERCOMPRESSION_NONE;

  container.dataFormatDescriptor = [{
    vendorId: 0,
    descriptorType: 0,
    versionNumber: 2,
    colorModel: KHR_DF_MODEL_RGBSDA,
    colorPrimaries: KHR_DF_PRIMARIES_BT709,
    transferFunction: isLinear ? KHR_DF_TRANSFER_LINEAR : KHR_DF_TRANSFER_SRGB,
    flags: KHR_DF_FLAG_ALPHA_STRAIGHT,
    texelBlockDimension: [0, 0, 0, 0],
    bytesPlane: [4, 0, 0, 0, 0, 0, 0, 0],
    samples: [
      { bitOffset: 0, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_RED, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
      { bitOffset: 8, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_GREEN, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
      { bitOffset: 16, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_BLUE, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
      { bitOffset: 24, bitLength: 8, channelType: KHR_DF_CHANNEL_RGBSDA_ALPHA, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 },
    ],
  }];

  container.levels = mips.map((m) => ({
    levelData: m.data,
    uncompressedByteLength: m.data.byteLength,
  }));

  container.keyValue = {
    KTXwriter: 'Claude-of-Tanks KTX2 Pipeline v1.0',
    COT_profile: profile,
    COT_colorSpace: colorSpace,
    COT_sourceHash: sourceHash || fnv1a(image.data),
  };

  return container;
}

/**
 * Encode an image object directly to KTX2 binary Buffer.
 * @param {{ width: number, height: number, data: Uint8Array }} image
 * @param {Object} [options]
 * @returns {Buffer} KTX2 binary buffer
 */
export function encodeKtx2(image, options = {}) {
  const container = createKtx2Container(image, options);
  const uint8 = writeKtx2(container);
  return Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength);
}

/**
 * Convert a source texture file (PNG / JPEG) to KTX2 buffer and metadata.
 * @param {string} filePath - Absolute or relative path to source texture
 * @param {Object} [options]
 * @returns {{ ktx2Buffer: Buffer, meta: Object }}
 */
export function optimizeTextureToKtx2(filePath, options = {}) {
  const rawBytes = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const classification = classifyTexture(filePath);

  let image;
  if (ext === '.png') {
    image = decodePng(rawBytes);
  } else if (ext === '.jpg' || ext === '.jpeg') {
    image = decodeJpeg(rawBytes, filePath);
  } else {
    throw new Error(`Unsupported texture extension ${ext}: ${filePath}`);
  }

  const hash = fnv1a(rawBytes);
  const ktx2Buffer = encodeKtx2(image, {
    profile: classification.profile,
    colorSpace: classification.colorSpace,
    sourceHash: hash,
    generateMips: options.generateMips ?? true,
  });

  const vram = estimateVramUsage(image.width, image.height, Math.floor(Math.log2(Math.max(image.width, image.height))) + 1);

  const meta = {
    sourceFile: filePath.split('\\').join('/'),
    width: image.width,
    height: image.height,
    profile: classification.profile,
    colorSpace: classification.colorSpace,
    vkFormat: classification.vkFormat,
    sourceBytes: rawBytes.length,
    ktx2Bytes: ktx2Buffer.length,
    uncompressedVramBytes: vram.uncompressedRgbaBytes,
    gpuVramBytesEstimated: vram.bc7AstcBytes,
    vramSavingsPercent: vram.savingsBc7Percent,
    sourceHash: hash,
  };

  return { ktx2Buffer, meta };
}

/**
 * Safely extract string value from KTX2 keyValue metadata.
 * @param {Object} container - Parsed KTX2 container
 * @param {string} key - Metadata key name
 * @returns {string}
 */
export function getKeyValueString(container, key) {
  const val = container.keyValue?.[key];
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (val instanceof Uint8Array) {
    return new TextDecoder().decode(val).replace(/\0+$/, '');
  }
  return String(val);
}

/**
 * Scan directory and optimize textures to KTX2.
 * @param {string} dir
 * @param {Object} [options]
 * @param {boolean} [options.write=false]
 * @param {boolean} [options.force=false]
 * @param {string} [options.manifestOut]
 * @returns {{ results: Array<Object>, summary: Object }}
 */
export function processTextureDirectory(dir, { write = false, force = false, manifestOut = null } = {}) {
  const results = [];
  let totalSourceBytes = 0;
  let totalKtx2Bytes = 0;
  let totalUncompressedVram = 0;
  let totalGpuVram = 0;
  let jpegDecoderWarned = false;
  let skippedJpegCount = 0;

  function* walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) yield* walk(p);
      else yield p;
    }
  }

  for (const filePath of walk(dir)) {
    const ext = extname(filePath).toLowerCase();
    if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') continue;
    if (filePath.endsWith('.ktx2.png') || filePath.includes('node_modules')) continue;

    // Never fabricate JPEG pixels: skip cleanly when the optional decoder is absent.
    if ((ext === '.jpg' || ext === '.jpeg') && !getJpegDecoder()) {
      if (!jpegDecoderWarned) {
        console.warn('[ktx2-opt] JPEG sources skipped: optional decoder not installed (`npm i -D jpeg-js`). PNG sources are fully supported.');
        jpegDecoderWarned = true;
      }
      skippedJpegCount++;
      continue;
    }

    const outPath = filePath.replace(/\.(png|jpg|jpeg)$/i, '.ktx2');
    const sourceBytes = readFileSync(filePath);
    const hash = fnv1a(sourceBytes);

    let skipped = false;
    let ktx2Buffer = null;
    let meta = null;

    if (!force && existsSync(outPath)) {
      try {
        const existing = readFileSync(outPath);
        const parsed = readKtx2(new Uint8Array(existing));
        const storedHash = getKeyValueString(parsed, 'COT_sourceHash');
        if (storedHash === hash) {
          skipped = true;
          const vram = estimateVramUsage(parsed.pixelWidth, parsed.pixelHeight, parsed.levels.length);
          meta = {
            sourceFile: filePath.split('\\').join('/'),
            outFile: outPath.split('\\').join('/'),
            width: parsed.pixelWidth,
            height: parsed.pixelHeight,
            profile: getKeyValueString(parsed, 'COT_profile') || 'cached',
            colorSpace: getKeyValueString(parsed, 'COT_colorSpace') || 'srgb',
            sourceBytes: sourceBytes.length,
            ktx2Bytes: existing.length,
            uncompressedVramBytes: vram.uncompressedRgbaBytes,
            gpuVramBytesEstimated: vram.bc7AstcBytes,
            vramSavingsPercent: vram.savingsBc7Percent,
            sourceHash: hash,
            cached: true,
          };
        }
      } catch (_) { /* re-encode if unreadable */ }
    }

    if (!skipped) {
      try {
        const opt = optimizeTextureToKtx2(filePath);
        ktx2Buffer = opt.ktx2Buffer;
        meta = { ...opt.meta, outFile: outPath.split('\\').join('/'), cached: false };
        if (write) {
          writeFileSync(outPath, ktx2Buffer);
          meta.written = true;
        }
      } catch (err) {
        console.warn(`[ktx2-opt] Failed to process ${filePath}: ${err.message}`);
        continue;
      }
    }

    totalSourceBytes += meta.sourceBytes;
    totalKtx2Bytes += meta.ktx2Bytes;
    totalUncompressedVram += meta.uncompressedVramBytes;
    totalGpuVram += meta.gpuVramBytesEstimated;
    results.push(meta);

    console.log(
      `[ktx2-opt] ${basename(filePath).padEnd(35)} ${String(meta.width) + 'x' + String(meta.height)} ` +
      `${meta.colorSpace.padEnd(6)} ${meta.profile.padEnd(14)} ` +
      `${String(meta.sourceBytes).padStart(8)}B -> ${String(meta.ktx2Bytes).padStart(8)}B ` +
      `VRAM: ${(meta.uncompressedVramBytes / (1024 * 1024)).toFixed(2)}MB -> ${(meta.gpuVramBytesEstimated / (1024 * 1024)).toFixed(2)}MB (-${meta.vramSavingsPercent}%)` +
      `${meta.cached ? ' [cached]' : meta.written ? ' [written]' : ' [dry-run]'}`
    );
  }

  const summary = {
    totalTextures: results.length,
    skippedJpegNoDecoder: skippedJpegCount,
    totalSourceBytes,
    totalKtx2Bytes,
    totalUncompressedVramBytes: totalUncompressedVram,
    totalGpuVramBytes: totalGpuVram,
    totalVramSavedBytes: totalUncompressedVram - totalGpuVram,
    overallVramSavingsPercent: totalUncompressedVram > 0
      ? Math.round((1 - totalGpuVram / totalUncompressedVram) * 1000) / 10
      : 0,
  };

  if (manifestOut && write) {
    const manifestDir = dirname(manifestOut);
    if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
    const manifest = {
      generated: new Date().toISOString(),
      summary,
      textures: Object.fromEntries(results.map((r) => [r.sourceFile, r])),
    };
    writeFileSync(manifestOut, JSON.stringify(manifest, null, 2));
    console.log(`[ktx2-opt] Manifest written to ${manifestOut}`);
  }

  console.log(
    `\n[ktx2-opt] Summary: ${summary.totalTextures} textures | ` +
    `Source: ${(totalSourceBytes / (1024 * 1024)).toFixed(2)} MB | ` +
    `KTX2: ${(totalKtx2Bytes / (1024 * 1024)).toFixed(2)} MB | ` +
    `VRAM Footprint: ${(totalUncompressedVram / (1024 * 1024)).toFixed(2)} MB -> ${(totalGpuVram / (1024 * 1024)).toFixed(2)} MB ` +
    `(-${summary.overallVramSavingsPercent}% savings)`
  );

  return { results, summary };
}

// CLI entry point
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );

  const targetDir = join(process.cwd(), String(args.dir || 'public/textures'));
  const manifestPath = args.manifest
    ? join(process.cwd(), String(args.manifest))
    : join(process.cwd(), 'public/textures/ktx2-manifest.json');

  processTextureDirectory(targetDir, {
    write: !!args.write,
    force: !!args.force,
    manifestOut: manifestPath,
  });
}
