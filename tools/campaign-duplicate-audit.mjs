#!/usr/bin/env node
// campaign-duplicate-audit.mjs — W11 asset-compression campaign audit.
//
// Scans the repo's shipped assets and runtime bake outputs for duplication and
// compression opportunities, and emits a JSON report:
//
//   1. duplicate textures under public/ — PNGs are decoded and hashed by
//      PIXELS (catches re-encoded copies that byte hashing misses); JPG/WEBP/
//      GIF are grouped by exact file bytes (no dependency-free decoder).
//   2. duplicate geometry — src/world/props-models.json entries hashed from
//      their quantized vertex/index arrays, and GLB POSITION accessors hashed
//      straight from the BIN chunk across public/models/**/*.glb.
//   3. packed-ORM opportunities — public/textures/ PBR sets that ship separate
//      AO + roughness maps (the runtime recomposites them on every map load in
//      src/world/sourcedTextures.js; an offline bake could pre-pack them).
//
// Read-only: never modifies any asset. Licensed/source GLBs, quarantined trees
// and attribution records are only ever READ for inventory purposes.
// Deterministic: no timestamps, no randomness — same tree, same report.
//
// Usage: node tools/campaign-duplicate-audit.mjs [--root=<dir>] [--out=<file>]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, fnv1a } from './campaign-png.mjs';

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const BAKE_MODEL_JSON = join('src', 'world', 'props-models.json');

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function groupDuplicates(items, keyOf) {
  const byKey = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(item);
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/** Hash a props-models.json model entry from its quantized vertex payload. */
function geometryHash(m) {
  const parts = [];
  for (const key of ['positions', 'normals', 'colors']) {
    const a = m[key] || [];
    // round to 1e-6 so -0 vs 0 or float noise cannot split true duplicates
    let s = '';
    for (let i = 0; i < a.length; i++) s += Math.round(a[i] * 1e6) + ',';
    parts.push(fnv1a(Buffer.from(s)));
  }
  parts.push(fnv1a(Buffer.from(JSON.stringify(m.indices || []))));
  return parts.join(':');
}

const GLTF_COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GLTF_NUMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Parse a GLB container; hash every mesh primitive's POSITION accessor bytes. */
export function scanGlb(file, root) {
  const buf = readFileSync(file);
  const out = {
    file: relative(root, file).split('\\').join('/'),
    bytes: buf.length,
    ok: false,
  };
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    out.error = 'not a GLB';
    return out;
  }
  if (buf.readUInt32LE(4) !== 2) { out.error = 'not glTF 2.0'; return out; }
  let pos = 12, json = null, bin = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32LE(pos);
    const type = buf.readUInt32LE(pos + 4);
    if (type === 0x4e4f534a) {
      // spec pads the JSON chunk with 0x20; tolerate NUL padding too
      const text = buf.subarray(pos + 8, pos + 8 + len).toString('utf8').replace(/[\0\s]+$/, '');
      json = JSON.parse(text);
    }
    else if (type === 0x004e4942) bin = buf.subarray(pos + 8, pos + 8 + len);
    pos += 8 + len;
  }
  if (!json) { out.error = 'no JSON chunk'; return out; }
  out.ok = true;
  out.extensionsUsed = json.extensionsUsed || [];
  out.meshes = (json.meshes || []).length;
  out.images = (json.images || []).length;
  out.positionHashes = [];
  out.tris = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const accs = json.accessors || [];
      const posAcc = accs[prim.attributes && prim.attributes.POSITION];
      const idxAcc = accs[prim.indices];
      if (idxAcc) out.tris += idxAcc.count / 3;
      else if (posAcc) out.tris += posAcc.count / 3;
      if (!posAcc) continue;
      const bv = (json.bufferViews || [])[posAcc.bufferView];
      if (!bv || !bin) continue;
      const nPer = GLTF_NUMS[posAcc.type] || 3;
      const stride = bv.byteStride || (GLTF_COMP_BYTES[posAcc.componentType] * nPer);
      const off = (bv.byteOffset || 0) + (posAcc.byteOffset || 0);
      const len = stride * posAcc.count;
      if (off + len > bin.length) continue;
      out.positionHashes.push(fnv1a(bin.subarray(off, off + len)) + ':' + posAcc.count);
    }
  }
  return out;
}

/** Group public/textures PBR sets by material base name; measure packable bytes. */
export function scanPbrSets(root) {
  const SUFFIX_RE = /(?:_1K-JPG)?_(Color|AmbientOcclusion|Roughness|NormalGL|diff|ao|rough|nor_gl)\.(?:jpg|png)$/i;
  const sets = new Map();
  for (const file of walk(join(root, 'public', 'textures'))) {
    const m = basename(file).match(SUFFIX_RE);
    if (!m) continue;
    const base = basename(file).replace(m[0], '');
    const dir = relative(root, file).split('\\').join('/').replace(/[^/]+$/, '');
    const key = dir + base;
    if (!sets.has(key)) sets.set(key, {});
    sets.get(key)[m[1].toLowerCase()] = { path: relative(root, file).split('\\').join('/'), bytes: statSync(file).size };
  }
  return [...sets.entries()].map(([key, files]) => {
    const ao = files.ambientocclusion || files.ao || null;
    const rough = files.roughness || files.rough || null;
    const packable = [ao, rough].filter(Boolean);
    return {
      set: key,
      files,
      ormPackableBytes: sum(packable.map((f) => f.bytes)),
      note: packable.length === 2
        ? 'ships separate AO+roughness; runtime packs them per map load (sourcedTextures.js composeAlbedo)'
        : null,
    };
  });
}

/**
 * Run the full audit against `root`. Pure function of the directory tree.
 * @returns {object} report JSON
 */
export function runAudit(root) {
  const textureItems = [];
  for (const file of walk(join(root, 'public'))) {
    const ext = extname(file).toLowerCase();
    if (!TEXTURE_EXTS.has(ext)) continue;
    const rel = relative(root, file).split('\\').join('/');
    const bytes = statSync(file).size;
    const item = { file: rel, bytes, ext: ext.slice(1) };
    if (ext === '.png') {
      try {
        const img = decodePng(readFileSync(file));
        item.width = img.width;
        item.height = img.height;
        item.hashMethod = 'pixels';
        item.pixelHash = fnv1a(Buffer.from(img.data)) + ':' + img.width + 'x' + img.height;
      } catch (e) {
        item.hashMethod = 'bytes';
        item.decodeError = String(e.message || e);
      }
    }
    if (!item.hashMethod) item.hashMethod = 'bytes';
    if (item.hashMethod === 'bytes') item.byteHash = fnv1a(readFileSync(file));
    textureItems.push(item);
  }

  const dupGroups = [];
  for (const g of groupDuplicates(textureItems.filter((t) => t.pixelHash), (t) => t.pixelHash)) {
    dupGroups.push({ method: 'pixels', hash: g[0].pixelHash, wastedBytes: sum(g.slice(1).map((t) => t.bytes)), files: g.map((t) => t.file) });
  }
  for (const g of groupDuplicates(textureItems.filter((t) => t.hashMethod === 'bytes'), (t) => t.ext + ':' + t.byteHash)) {
    dupGroups.push({ method: 'bytes', hash: g[0].byteHash, wastedBytes: sum(g.slice(1).map((t) => t.bytes)), files: g.map((t) => t.file) });
  }
  dupGroups.sort((a, b) => b.wastedBytes - a.wastedBytes);

  // baked prop models (first-party regenerable bake output)
  let propsModels = null;
  try {
    const p = join(root, BAKE_MODEL_JSON);
    const json = JSON.parse(readFileSync(p, 'utf8'));
    const models = Object.entries(json).map(([name, m]) => ({
      name,
      tris: m.tris || 0,
      verts: (m.positions || []).length / 3,
      geoHash: geometryHash(m),
    }));
    propsModels = {
      file: BAKE_MODEL_JSON.split('\\').join('/'),
      bytes: statSync(p).size,
      models,
      duplicateGroups: groupDuplicates(models, (m) => m.geoHash)
        .map((g) => ({ names: g.map((m) => m.name), tris: g[0].tris })),
    };
  } catch { /* bake output absent — report stays valid without it */ }

  // GLB inventory + cross-file duplicate geometry
  const glbs = [];
  for (const file of walk(join(root, 'public', 'models'))) {
    if (extname(file).toLowerCase() !== '.glb') continue;
    glbs.push(scanGlb(file, root));
  }
  const glbDupGroups = groupDuplicates(
    glbs.filter((g) => g.ok).flatMap((g) => g.positionHashes.map((h) => ({ file: g.file, h }))),
    (x) => x.h,
  ).map((g) => ({
    positionHash: g[0].h.split(':')[0],
    verts: +g[0].h.split(':')[1],
    files: [...new Set(g.map((x) => x.file))],
  }));

  return {
    tool: 'campaign-duplicate-audit',
    root,
    textures: {
      scanned: textureItems.length,
      totalBytes: sum(textureItems.map((t) => t.bytes)),
      pixelHashed: textureItems.filter((t) => t.hashMethod === 'pixels').length,
      byteHashedOnly: textureItems.filter((t) => t.hashMethod === 'bytes').length,
      duplicateGroups: dupGroups,
      wastedBytes: sum(dupGroups.map((g) => g.wastedBytes)),
    },
    geometry: {
      propsModels,
      glbs: {
        scanned: glbs.length,
        totalBytes: sum(glbs.map((g) => g.bytes)),
        compressedWith: [...new Set(glbs.flatMap((g) => (g.extensionsUsed || []).filter((e) => /draco|meshopt/i.test(e))))],
        duplicateGroups: glbDupGroups,
        inventory: glbs.map(({ positionHashes, ...rest }) => rest),
      },
    },
    packedOrm: scanPbrSets(root),
    notes: [
      'PNG duplicates are detected on decoded pixels, so re-encoded copies still match.',
      'GLBs are inventoried read-only; licensed/source trees are never modified by this tool.',
      'packedOrm rows mark AO+roughness pairs the runtime recomposites at every map load.',
    ],
  };
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));
  const root = resolvePath(args.root ? String(args.root) : '.');
  const report = runAudit(root);
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(String(args.out), json);
    console.log(`[dup-audit] wrote ${args.out}`);
  }
  const t = report.textures, g = report.geometry;
  console.log(`[dup-audit] textures: ${t.scanned} scanned (${(t.totalBytes / 1048576).toFixed(1)} MB), ${t.duplicateGroups.length} duplicate groups, ${(t.wastedBytes / 1048576).toFixed(2)} MB reclaimable`);
  console.log(`[dup-audit] props-models.json: ${g.propsModels ? `${g.propsModels.models.length} models, ${(g.propsModels.bytes / 1048576).toFixed(2)} MB, ${g.propsModels.duplicateGroups.length} duplicate groups` : '(absent)'}`);
  console.log(`[dup-audit] glbs: ${g.glbs.scanned} scanned (${(g.glbs.totalBytes / 1048576).toFixed(2)} MB), ${g.glbs.duplicateGroups.length} duplicate-geometry groups, compressed: ${JSON.stringify(g.glbs.compressedWith)}`);
  console.log(`[dup-audit] packed-ORM candidates: ${report.packedOrm.filter((s) => s.ormPackableBytes > 0).length} sets, ${(sum(report.packedOrm.map((s) => s.ormPackableBytes)) / 1048576).toFixed(2)} MB of separable AO+roughness`);
}
