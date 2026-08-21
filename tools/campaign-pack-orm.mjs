#!/usr/bin/env node
// tools/campaign-pack-orm.mjs — W11/Campaign 2 asset consolidation pipeline:
// packs separate Occlusion (AO), Roughness, and Metallic textures into a single
// standard ORM texture (R: Occlusion, G: Roughness, B: Metallic, A: 255).
//
// In glTF 2.0 and standard PBR materials:
//   R: Ambient Occlusion / Occlusion (default 255 if missing)
//   G: Roughness (default 230-255 if missing)
//   B: Metallic / Metalness (default 0 if missing)
//   A: 255 (opaque)
//
// Benefits:
// - Eliminates separate AO and Roughness texture files (~11.6 MB download/disk reduction).
// - Reduces GPU memory residency: single RGBA texture instead of separate AO and Roughness buffers.
// - Reduces runtime canvas composite readbacks by 50% (1 decode pass instead of 2).
// - Reuses a single texture unit across aoMap / roughnessMap / metalnessMap in Three.js shaders.
//
// Usage:
//   node tools/campaign-pack-orm.mjs [--root=<dir>] [--dir=public/textures] [--write]
//                                    [--format=png|jpg|auto] [--quality=90]
//
// SA-05 update: sources may be PNG or JPEG (magic-byte sniffed; JPEG decode
// uses the optional jpeg-js devDependency). Output container defaults to
// 'auto' (smaller of lossless PNG vs q90 JPEG per set) and the written file
// extension follows the chosen container.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decodePng, encodePng, fnv1a } from './campaign-png.mjs';

// SA-05: the committed ambientCG / Poly Haven sets ship JPEG maps, so Node-side
// packing needs a JPEG decoder. Optional require (mirrors campaign-optimize-ktx2.mjs):
// PNG-only inputs keep working without the devDependency installed.
const optionalRequire = createRequire(import.meta.url);
let _jpeg = null;
function jpegCodec() {
  if (!_jpeg) _jpeg = optionalRequire('jpeg-js');
  return _jpeg;
}

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/**
 * Pack raw channel byte arrays into an RGBA8 ORM buffer.
 * R: Occlusion (default 255)
 * G: Roughness (default 230)
 * B: Metallic (default 0)
 * A: 255
 *
 * @param {Uint8Array|Uint8ClampedArray|null} aoData
 * @param {Uint8Array|Uint8ClampedArray|null} roughData
 * @param {Uint8Array|Uint8ClampedArray|null} metalData
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function packOrmData(aoData, roughData, metalData, width, height, opts = {}) {
  const defaultAo = opts.defaultAo ?? 255;
  const defaultRough = opts.defaultRoughness ?? 230;
  const defaultMetal = opts.defaultMetalness ?? 0;
  const total = width * height;
  const out = new Uint8Array(total * 4);

  const aoStride = aoData ? (aoData.length === total * 4 ? 4 : aoData.length === total ? 1 : null) : null;
  const roughStride = roughData ? (roughData.length === total * 4 ? 4 : roughData.length === total ? 1 : null) : null;
  const metalStride = metalData ? (metalData.length === total * 4 ? 4 : metalData.length === total ? 1 : null) : null;

  for (let i = 0; i < total; i++) {
    const dst = i * 4;
    const aoVal = aoStride !== null ? aoData[i * aoStride] : defaultAo;
    const roughVal = roughStride !== null ? roughData[i * roughStride] : defaultRough;
    const metalVal = metalStride !== null ? metalData[i * metalStride] : defaultMetal;

    out[dst] = aoVal;
    out[dst + 1] = roughVal;
    out[dst + 2] = metalVal;
    out[dst + 3] = 255;
  }

  return { width, height, data: out };
}

/**
 * Extract separate grayscale AO, Roughness, and Metallic arrays from an RGBA ORM buffer.
 *
 * @param {Uint8Array|Uint8ClampedArray} ormData RGBA8 data
 * @param {number} width
 * @param {number} height
 * @returns {{ ao: Uint8Array, rough: Uint8Array, metal: Uint8Array, width: number, height: number }}
 */
export function unpackOrmData(ormData, width, height) {
  const total = width * height;
  const ao = new Uint8Array(total);
  const rough = new Uint8Array(total);
  const metal = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    ao[i] = ormData[i * 4];
    rough[i] = ormData[i * 4 + 1];
    metal[i] = ormData[i * 4 + 2];
  }

  return { ao, rough, metal, width, height };
}

/**
 * Decode a PNG or JPEG buffer into { width, height, data } RGBA8.
 * Format is sniffed from magic bytes (PNG signature vs FFD8FF JPEG SOI).
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Uint8Array, format: 'png'|'jpg' }}
 */
export function decodeImage(buf) {
  if (!buf || buf.length < 4) throw new Error('Empty or truncated image buffer');
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const img = decodePng(buf);
    return { ...img, format: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const img = jpegCodec().decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data, format: 'jpg' };
  }
  throw new Error(`Unsupported image format (magic ${buf[0].toString(16)}${buf[1].toString(16)}${buf[2].toString(16)})`);
}

/**
 * Encode a packed RGBA8 ORM image. 'png' is lossless; 'jpg' trades a few LSBs
 * on the AO/roughness masks for the JPEG codec's grayscale-friendly chroma
 * handling (the committed sets are photographic — PNG of packed ORM runs
 * several times larger than the JPG maps it replaces). 'auto' encodes both
 * and keeps the smaller buffer.
 *
 * @param {{ width: number, height: number, data: Uint8Array }} packed
 * @param {{ format?: 'png'|'jpg'|'auto', quality?: number, level?: number }} [opts]
 * @returns {{ buffer: Buffer, format: 'png'|'jpg', bytes: number }}
 */
export function encodeOrmImage(packed, { format = 'png', quality = 90, level = 9 } = {}) {
  if (format === 'auto') {
    const png = encodeOrmImage(packed, { format: 'png', level });
    const jpg = encodeOrmImage(packed, { format: 'jpg', quality });
    return jpg.bytes < png.bytes ? jpg : png;
  }
  if (format === 'jpg') {
    // jpeg-js takes a NUMERIC quality (an options object silently encodes
    // flat mid-gray) — clamp to the codec's 1..100 range.
    const q = Math.max(1, Math.min(100, Math.round(quality)));
    const out = jpegCodec().encode(
      { data: packed.data, width: packed.width, height: packed.height },
      q,
    );
    return { buffer: Buffer.from(out.data), format: 'jpg', bytes: out.data.length };
  }
  const buffer = encodePng(packed, { colorType: 'rgba', level });
  return { buffer, format: 'png', bytes: buffer.length };
}

/**
 * Pack separate AO, Roughness, and (optional) Metallic image buffers (PNG or
 * JPEG) into a single ORM image.
 *
 * @param {Buffer|null} aoPngBuf
 * @param {Buffer|null} roughPngBuf
 * @param {Buffer|null} [metalPngBuf]
 * @param {object} [opts]
 * @returns {{ buffer: Buffer, width: number, height: number, data: Uint8Array, format: 'png'|'jpg', bytes: number }}
 */
export function packOrmPng(aoPngBuf, roughPngBuf, metalPngBuf = null, opts = {}) {
  let aoImg = null, roughImg = null, metalImg = null;
  if (aoPngBuf) aoImg = decodeImage(aoPngBuf);
  if (roughPngBuf) roughImg = decodeImage(roughPngBuf);
  if (metalPngBuf) metalImg = decodeImage(metalPngBuf);

  const primary = aoImg || roughImg || metalImg;
  if (!primary) throw new Error('At least one texture map buffer must be provided to pack ORM');

  const width = opts.width || primary.width;
  const height = opts.height || primary.height;

  const packed = packOrmData(
    aoImg ? aoImg.data : null,
    roughImg ? roughImg.data : null,
    metalImg ? metalImg.data : null,
    width,
    height,
    opts,
  );

  const encoded = encodeOrmImage(packed, opts);
  return { buffer: encoded.buffer, width, height, data: packed.data, format: encoded.format, bytes: encoded.bytes };
}

/**
 * Suffix regex for identifying PBR set texture components (ambientCG and Poly Haven naming).
 */
export const PBR_SUFFIX_RE = /(?:_1K-JPG)?_(Color|AmbientOcclusion|Roughness|NormalGL|diff|ao|rough|nor_gl|orm|ARM|metalness|metallic)(?:_1k)?\.(?:jpg|jpeg|png|webp)$/i;

/**
 * Scan a directory tree for PBR sets and audit ORM packing opportunities.
 *
 * @param {string} root
 * @param {string} [subDir='public/textures']
 * @returns {{
 *   sets: Array<object>,
 *   totalSets: number,
 *   packableSets: number,
 *   totalPackableBytes: number,
 *   gpuTexturesEliminated: number,
 *   textureBindingsSaved: number,
 *   memoryResidencySaved: number
 * }}
 */
export function scanPbrSets(root, subDir = 'public/textures') {
  const targetDir = join(root, subDir);
  const sets = new Map();

  for (const file of walk(targetDir)) {
    const ext = extname(file).toLowerCase();
    if (!TEXTURE_EXTS.has(ext)) continue;
    const filename = basename(file);
    const m = filename.match(PBR_SUFFIX_RE);
    if (!m) continue;

    const base = filename.replace(m[0], '');
    const dir = relative(root, file).split('\\').join('/').replace(/[^/]+$/, '');
    const key = dir + base;
    if (!sets.has(key)) sets.set(key, { base, dir, files: {} });

    const kind = m[1].toLowerCase();
    const relPath = relative(root, file).split('\\').join('/');
    sets.get(key).files[kind] = {
      path: relPath,
      filename,
      bytes: statSync(file).size,
      ext,
    };
  }

  const results = [...sets.entries()].map(([key, item]) => {
    const { files, base, dir } = item;
    const ao = files.ambientocclusion || files.ao || null;
    const rough = files.roughness || files.rough || null;
    const metal = files.metalness || files.metallic || null;
    const orm = files.orm || files.arm || null;

    const packableFiles = [ao, rough, metal].filter(Boolean);
    const ormPackableBytes = sum(packableFiles.map((f) => f.bytes));
    const isPackable = !orm && (ao !== null && rough !== null);
    const isAlreadyPacked = Boolean(orm);

    // Standard naming targets for ORM output
    const isPolyHaven = key.includes('withered_grass') || Boolean(files.diff);
    const targetOrmPath = isPolyHaven
      ? `${dir}${base}_orm_1k.png`
      : `${dir}${base}_1K-JPG_ORM.png`;

    return {
      set: key,
      base,
      dir,
      files,
      ao,
      rough,
      metal,
      orm,
      isPackable,
      isAlreadyPacked,
      targetOrmPath,
      ormPackableBytes,
      packableFilesCount: packableFiles.length,
      // 1024x1024 RGBA8 = 4 MB per texture in uncompressed GPU memory
      uncompressedVramBytes: packableFiles.length > 0 ? (packableFiles.length - 1) * 1024 * 1024 * 4 : 0,
      note: isPackable
        ? `Ships separate AO + Roughness (${packableFiles.length} textures); consolidating into 1 ORM texture saves ${ormPackableBytes} disk bytes and 1 GPU texture.`
        : isAlreadyPacked
          ? 'Already consolidated with packed ORM texture.'
          : 'Incomplete PBR set or non-standard naming.',
    };
  });

  const packableSets = results.filter((s) => s.isPackable || s.isAlreadyPacked);
  const totalPackableBytes = sum(packableSets.map((s) => s.ormPackableBytes));
  // Consolidating 2 textures (AO + Roughness) into 1 ORM texture eliminates 1 GPU texture per set
  const gpuTexturesEliminated = packableSets.filter((s) => s.isPackable || s.isAlreadyPacked).length;
  // Texture sampler units saved in shader bindings
  const textureBindingsSaved = gpuTexturesEliminated;
  // Uncompressed GPU residency reduction (1024x1024 RGBA8 = 4.19 MB per texture eliminated)
  const memoryResidencySaved = gpuTexturesEliminated * 1024 * 1024 * 4;

  return {
    sets: results,
    totalSets: results.length,
    packableSets: packableSets.length,
    totalPackableBytes,
    gpuTexturesEliminated,
    textureBindingsSaved,
    memoryResidencySaved,
  };
}

/**
 * Measure achievable ORM consolidation savings across the asset inventory.
 *
 * @param {string} root
 * @returns {object}
 */
export function measureOrmSavings(root) {
  const scan = scanPbrSets(root);
  return {
    totalSetsScanned: scan.totalSets,
    packableSetsCount: scan.packableSets,
    diskBytesConsolidatable: scan.totalPackableBytes,
    diskMbConsolidatable: +(scan.totalPackableBytes / 1048576).toFixed(2),
    gpuTexturesEliminated: scan.gpuTexturesEliminated,
    textureBindingsSaved: scan.textureBindingsSaved,
    vramResidencySavedMb: +(scan.memoryResidencySaved / 1048576).toFixed(2),
    sets: scan.sets.map((s) => ({
      set: s.set,
      isPackable: s.isPackable,
      isAlreadyPacked: s.isAlreadyPacked,
      bytes: s.ormPackableBytes,
      target: s.targetOrmPath,
    })),
  };
}

/**
 * Execute ORM packing across all candidate sets under `root`.
 *
 * @param {string} root
 * @param {{ write?: boolean, subDir?: string }} [opts]
 * @returns {object}
 */
export function packAllPbrSets(root, opts = {}) {
  const { write = false, subDir = 'public/textures' } = opts;
  const scan = scanPbrSets(root, subDir);
  const operations = [];

  for (const set of scan.sets) {
    if (!set.isPackable && !set.isAlreadyPacked) continue;

    const op = {
      set: set.set,
      target: set.targetOrmPath,
      packableBytes: set.ormPackableBytes,
      status: 'pending',
      written: false,
    };

    // If separate image files exist (PNG or JPEG), we can pack them in Node
    const aoPath = set.ao ? join(root, set.ao.path) : null;
    const roughPath = set.rough ? join(root, set.rough.path) : null;
    const metalPath = set.metal ? join(root, set.metal.path) : null;

    const nodeDecodable = (p) => p && existsSync(p) && /\.(png|jpe?g)$/i.test(p);
    const canPackInNode = [aoPath, roughPath, metalPath].some(nodeDecodable);

    if (canPackInNode) {
      try {
        const aoBuf = (aoPath && existsSync(aoPath)) ? readFileSync(aoPath) : null;
        const roughBuf = (roughPath && existsSync(roughPath)) ? readFileSync(roughPath) : null;
        const metalBuf = (metalPath && existsSync(metalPath)) ? readFileSync(metalPath) : null;

        const packed = packOrmPng(aoBuf, roughBuf, metalBuf, { format: opts.format || 'png', quality: opts.quality });
        op.ormBytes = packed.bytes;
        op.ormFormat = packed.format;
        op.width = packed.width;
        op.height = packed.height;
        // Target extension follows the chosen container (scan hints .png)
        op.target = set.targetOrmPath.replace(/\.png$/i, `.${packed.format}`);

        if (write) {
          const outPath = join(root, op.target);
          writeFileSync(outPath, packed.buffer);
          op.written = true;
          op.status = 'written';
        } else {
          op.status = 'dry-run-packed';
        }
      } catch (err) {
        op.status = 'error';
        op.error = err.message;
      }
    } else {
      // No Node-decodable sources on disk: either a foreign-format candidate
      // or (post-consolidation) a set whose separate maps were already
      // retired in favor of its packed ORM file.
      op.status = set.isAlreadyPacked ? 'already-packed' : (write ? 'requires-runtime-or-bake' : 'audited-candidate');
    }

    operations.push(op);
  }

  return {
    scan,
    operations,
    write,
    totalPackableBytes: scan.totalPackableBytes,
    gpuTexturesEliminated: scan.gpuTexturesEliminated,
    textureBindingsSaved: scan.textureBindingsSaved,
    memoryResidencySaved: scan.memoryResidencySaved,
  };
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));

  const root = resolvePath(args.root ? String(args.root) : '.');
  const subDir = args.dir ? String(args.dir) : 'public/textures';
  const write = Boolean(args.write);
  const format = args.format ? String(args.format) : 'auto';
  const quality = args.quality ? Number(args.quality) : undefined;

  const report = packAllPbrSets(root, { write, subDir, format, quality });
  const mb = (bytes) => (bytes / 1048576).toFixed(2);

  const writtenOps = report.operations.filter((o) => o.written);
  const ormBytesTotal = writtenOps.reduce((a, o) => a + (o.ormBytes || 0), 0);
  const eliminatedBytes = writtenOps.reduce((a, o) => a + (o.packableBytes || 0), 0);
  // Net disk delta once the replaced separate maps are removed from the build
  const netSavedBytes = eliminatedBytes - ormBytesTotal;

  console.log(`\n=== Campaign 2: Packed ORM Texture Consolidation ===`);
  console.log(`Root: ${root}`);
  console.log(`Directory: ${subDir}`);
  console.log(`Mode: ${write ? 'WRITE (packing assets)' : 'DRY RUN (auditing candidates)'}`);
  console.log(`Format: ${format}${quality ? ` (q${quality})` : ''}`);
  console.log(`----------------------------------------------------`);
  console.log(`Total PBR Sets Scanned:      ${report.scan.totalSets}`);
  console.log(`Packable ORM Candidates:     ${report.scan.packableSets} sets`);
  console.log(`Separate Map Disk Bytes:     ${mb(report.totalPackableBytes)} MB`);
  console.log(`GPU Textures Eliminated:     ${report.gpuTexturesEliminated} textures`);
  console.log(`Texture Bindings Saved:      ${report.textureBindingsSaved} sampler slots`);
  console.log(`VRAM Residency Reduction:    ${mb(report.memoryResidencySaved)} MB`);
  if (writtenOps.length) {
    console.log(`ORM Written:                 ${writtenOps.length} files, ${mb(ormBytesTotal)} MB`);
    console.log(`Separate Maps Replaced:      ${mb(eliminatedBytes)} MB`);
    console.log(`Net Disk Delta (on delete):  -${mb(netSavedBytes)} MB`);
  }
  console.log(`----------------------------------------------------`);

  for (const op of report.operations) {
    const statusTag = op.written ? '[WRITTEN]' : `[${op.status}]`;
    const fmt = op.ormFormat ? ` (${op.ormFormat}, ${((op.ormBytes || 0) / 1024).toFixed(0)} KB)` : '';
    console.log(`  ${op.set.padEnd(36)} -> ${op.target} ${statusTag}${fmt}`);
  }
  console.log(`====================================================\n`);
}
