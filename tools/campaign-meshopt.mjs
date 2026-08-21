// tools/campaign-meshopt.mjs — Meshopt geometry compression for static GLB assets.
//
// SA-04 (Graphics & Performance Campaign 2): offline meshopt tooling producing
// EXT_meshopt_compression GLBs plus decode metrics, paired with the runtime
// loader support in src/engine/meshoptGlbLoader.js (three GLTFLoader +
// MeshoptDecoder).
//
// Pipeline per file:
// 1. Parse the GLB container (JSON + BIN chunks).
// 2. Vertex-cache optimize every indexed TRIANGLES primitive
//    (MeshoptEncoder.reorderMesh) and compact unreferenced vertices.
// 3. Re-encode index/attribute segments with EXT_meshopt_compression
//    (modes TRIANGLES / INDICES / ATTRIBUTES, filter NONE — lossless).
// 4. Pass all non-geometry accessors (animations, skins, instancing) and
//    image bufferViews through verbatim; drop dead bufferViews.
// 5. Emit metrics: per-primitive vertex/triangle counts and byte deltas,
//    file-level savings, aggregate summary. Optional manifest caching.
//
// Accessors that cannot satisfy codec constraints (element size % 4 != 0 or
// > 256 bytes; 8-bit indices are promoted to 16-bit instead) fall back to
// verbatim uncompressed segments so a file is never corrupted by this tool.
//
// Usage:
//   node tools/campaign-meshopt.mjs [--dir=public/models] [--file=path/to.glb]
//        [--write] [--force] [--manifest=public/models/meshopt-manifest.json]

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder } from 'meshoptimizer';
import { fnv1a } from './campaign-png.mjs';

export const MESHOPT_EXTENSION = 'EXT_meshopt_compression';
const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

// glTF 2.0 accessor layout tables.
export const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/**
 * Byte size of one accessor element (componentSize * componentCount).
 * @param {{componentType:number,type:string}} accessor
 * @returns {number}
 */
export function accessorElementSize(accessor) {
  const cs = COMPONENT_SIZE[accessor.componentType];
  const nc = TYPE_COMPONENTS[accessor.type];
  if (!cs || !nc) throw new Error(`unsupported accessor layout componentType=${accessor.componentType} type=${accessor.type}`);
  return cs * nc;
}

/**
 * Parse a GLB container into its JSON object and BIN chunk.
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 * @returns {{ json: object, bin: Uint8Array | null }}
 */
export function parseGlb(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 20) throw new Error('GLB too small');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB container (bad magic)');
  if (dv.getUint32(4, true) !== 2) throw new Error('unsupported glTF version (only 2.0)');
  const totalLen = dv.getUint32(8, true);
  let json = null;
  let bin = null;
  let off = 12;
  while (off + 8 <= Math.min(totalLen, u8.length)) {
    const chunkLen = dv.getUint32(off, true);
    const chunkType = dv.getUint32(off + 4, true);
    const dataStart = off + 8;
    if (dataStart + chunkLen > u8.length) throw new Error('truncated GLB chunk');
    if (chunkType === CHUNK_TYPE_JSON) {
      json = JSON.parse(new TextDecoder().decode(u8.subarray(dataStart, dataStart + chunkLen)));
    } else if (chunkType === CHUNK_TYPE_BIN) {
      bin = u8.slice(dataStart, dataStart + chunkLen); // own aligned copy
    }
    off = dataStart + chunkLen;
  }
  if (!json) throw new Error('GLB missing JSON chunk');
  return { json, bin };
}

/**
 * Serialize JSON + BIN back into a GLB container (JSON space-padded,
 * BIN zero-padded to 4-byte alignment per spec).
 * @param {object} json
 * @param {Uint8Array|null} bin
 * @returns {Buffer}
 */
export function buildGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binLen = bin ? bin.length : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, CHUNK_TYPE_JSON, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20;
  if (bin) {
    const bOff = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(bOff, binLen, true);
    dv.setUint32(bOff + 4, CHUNK_TYPE_BIN, true);
    out.set(bin, bOff + 8);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Raw accessor bytes (sparse accessors unsupported).
 * @param {object} json
 * @param {Uint8Array} bin
 * @param {number} accessorIndex
 * @returns {{ bytes: Uint8Array, count: number, elementSize: number, componentType: number, type: string }}
 */
export function readAccessorRaw(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  if (!acc) throw new Error(`missing accessor ${accessorIndex}`);
  if (acc.sparse) throw new Error(`accessor ${accessorIndex} uses sparse storage (unsupported)`);
  const elementSize = accessorElementSize(acc);
  if (acc.bufferView == null) {
    return { bytes: new Uint8Array(acc.count * elementSize), count: acc.count, elementSize, componentType: acc.componentType, type: acc.type };
  }
  const bv = json.bufferViews[acc.bufferView];
  if (!bv) throw new Error(`accessor ${accessorIndex} references missing bufferView ${acc.bufferView}`);
  if (bv.byteStride) throw new Error(`accessor ${accessorIndex} lives in an interleaved bufferView (unsupported)`);
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const len = acc.count * elementSize;
  if (start + len > bin.length) throw new Error(`accessor ${accessorIndex} exceeds BIN chunk`);
  return { bytes: bin.subarray(start, start + len), count: acc.count, elementSize, componentType: acc.componentType, type: acc.type };
}

/**
 * Copy raw index bytes into a fresh Uint32Array.
 * @param {Uint8Array} bytes
 * @param {number} componentType 5121 | 5123 | 5125
 * @returns {Uint32Array}
 */
export function toUint32Indices(bytes, componentType) {
  if (componentType === 5125) {
    const out = new Uint32Array(bytes.length / 4);
    new Uint8Array(out.buffer).set(bytes);
    return out;
  }
  if (componentType === 5123) {
    const src = new Uint16Array(bytes.length / 2);
    new Uint8Array(src.buffer).set(bytes);
    const out = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return out;
  }
  if (componentType === 5121) {
    const out = new Uint32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
    return out;
  }
  throw new Error(`unsupported index componentType ${componentType}`);
}

/**
 * Serialize optimized index values back to bytes under an output component
 * type. 8-bit sources are promoted to 16-bit (the meshopt index codec only
 * accepts 16/32-bit strides); values always fit because compaction only
 * shrinks the id range.
 * @param {Uint32Array} indices
 * @param {number} componentType 5121 | 5123 | 5125
 * @returns {{ bytes: Uint8Array, componentType: number }}
 */
export function indicesToBytes(indices, componentType) {
  if (componentType === 5121) {
    const u16 = new Uint16Array(indices.length);
    for (let i = 0; i < indices.length; i++) u16[i] = indices[i];
    return { bytes: new Uint8Array(u16.buffer), componentType: 5123 };
  }
  if (componentType === 5123) {
    const u16 = new Uint16Array(indices.length);
    for (let i = 0; i < indices.length; i++) u16[i] = indices[i];
    return { bytes: new Uint8Array(u16.buffer), componentType: 5123 };
  }
  if (componentType === 5125) {
    const out = new Uint32Array(indices.length);
    out.set(indices);
    return { bytes: new Uint8Array(out.buffer), componentType: 5125 };
  }
  throw new Error(`unsupported index componentType ${componentType}`);
}

/**
 * Vertex-cache optimize one indexed TRIANGLES primitive and compact away
 * unreferenced vertices. Mutates nothing in the source arrays.
 *
 * remap semantics (meshoptimizer reorderMesh): indices are rewritten in place
 * to NEW ids and remap[oldVertexId] = newVertexId (entries >= unique or
 * 0xffffffff mark unreferenced/dropped vertices).
 *
 * @param {{ indexRaw: object, attributeRaws: Array<{index:number, raw:object}> }} input
 * @returns {{ indices: Uint32Array, unique: number, vertexCountIn: number, attributeBytes: Map<number, Uint8Array> }}
 */
export function optimizeIndexedPrimitive({ indexRaw, attributeRaws }) {
  const indices = toUint32Indices(indexRaw.bytes, indexRaw.componentType);
  const vertexCountIn = Math.max(
    ...attributeRaws.map((a) => a.raw.count),
    indices.length ? 1 + indices.reduce((m, v) => (v > m ? v : m), 0) : 0
  );
  const [remapOldToNew, unique] = MeshoptEncoder.reorderMesh(indices, /* triangles= */ true, /* optsize= */ true);
  const attributeBytes = new Map();
  for (const { index, raw } of attributeRaws) {
    const es = raw.elementSize;
    const dst = new Uint8Array(unique * es);
    for (let old = 0; old < vertexCountIn && old < remapOldToNew.length; old++) {
      const n = remapOldToNew[old];
      if (n === 0xffffffff || n >= unique) continue;
      dst.set(raw.bytes.subarray(old * es, (old + 1) * es), n * es);
    }
    attributeBytes.set(index, dst);
  }
  return { indices, unique, vertexCountIn, attributeBytes };
}

/**
 * Rotation-canonical triangle keys built from position tuples. The meshopt
 * index codec preserves winding but may rotate vertices within a triangle
 * ((a,b,c) -> (b,c,a)); canonicalizing on the lexicographically smallest
 * vertex makes decoded topology directly comparable to source topology.
 * @param {Uint32Array|number[]} indices
 * @param {Float32Array} positions
 * @param {number} [stride=3]
 * @returns {string[]} sorted key list (multiset of oriented triangles)
 */
export function canonicalTriangles(indices, positions, stride = 3) {
  const keys = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const verts = [indices[t], indices[t + 1], indices[t + 2]].map((v) => {
      const o = v * stride;
      return `${positions[o]},${positions[o + 1]},${positions[o + 2]}`;
    });
    // Degenerate triangles (repeated vertex) render nothing and may be
    // collapsed or reordered arbitrarily by the meshopt index codec;
    // exclude them from topology comparison.
    if (verts[0] === verts[1] || verts[1] === verts[2] || verts[0] === verts[2]) continue;
    let m = 0;
    if (verts[1] < verts[m]) m = 1;
    if (verts[2] < verts[m]) m = 2;
    keys.push(`${verts[m]}|${verts[(m + 1) % 3]}|${verts[(m + 2) % 3]}`);
  }
  keys.sort();
  return keys;
}

function skipResult(glb, base, reason) {
  return { glb, metrics: { ...base, skipped: true, reason, primitives: [], segments: [], savedBytes: 0, savingsPercent: 0 } };
}

/**
 * Compress one GLB with EXT_meshopt_compression. Lossless for geometry:
 * attributes decode bit-exact; index buffers decode topologically identical
 * (triangle vertex rotation allowed by the codec).
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} sourceBuffer
 * @param {{ label?: string }} [options]
 * @returns {Promise<{ glb: Buffer|Uint8Array, metrics: object }>}
 */
export async function compressGlb(sourceBuffer, { label = 'glb' } = {}) {
  await MeshoptEncoder.ready;
  const srcU8 = sourceBuffer instanceof Uint8Array ? sourceBuffer : new Uint8Array(sourceBuffer);
  const base = { label, sourceBytes: srcU8.length };
  let parsed;
  try {
    parsed = parseGlb(srcU8);
  } catch (err) {
    return skipResult(srcU8, base, `parse failed: ${err.message}`);
  }
  const { json, bin } = parsed;
  if (!bin || bin.length === 0) return skipResult(srcU8, base, 'no BIN chunk');

  const required = json.extensionsRequired || [];
  const blocker = required.find((r) => r === 'KHR_draco_mesh_compression' || r === MESHOPT_EXTENSION || r === 'MESHOPT_compression');
  if (blocker) return skipResult(srcU8, base, `already compressed (${blocker})`);

  // ---- plan optimization units over meshes/primitives -----------------------
  const processedAccessors = new Set();
  const conflictingAccessors = new Set();
  const units = [];
  const meshes = json.meshes || [];
  for (let mi = 0; mi < meshes.length; mi++) {
    const prims = meshes[mi].primitives || [];
    for (let pi = 0; pi < prims.length; pi++) {
      const prim = prims[pi];
      if (prim.targets && prim.targets.length) return skipResult(srcU8, base, `morph targets unsupported (mesh ${mi})`);
      if (prim.extensions && prim.extensions.KHR_draco_mesh_compression) return skipResult(srcU8, base, `draco primitive (mesh ${mi})`);
      const attrEntries = Object.entries(prim.attributes || {});
      if (!attrEntries.length) continue;
      const mode = prim.mode ?? 4;
      const unit = {
        meshIndex: mi,
        primIndex: pi,
        mode,
        indexAccessor: prim.indices ?? null,
        attributes: attrEntries.map(([name, index]) => ({ name, index })),
        reorder: mode === 4 && prim.indices != null,
      };
      for (const a of unit.attributes) {
        if (processedAccessors.has(a.index)) conflictingAccessors.add(a.index);
        processedAccessors.add(a.index);
      }
      if (unit.indexAccessor != null) {
        if (processedAccessors.has(unit.indexAccessor)) conflictingAccessors.add(unit.indexAccessor);
        processedAccessors.add(unit.indexAccessor);
      }
      units.push(unit);
    }
  }
  if (conflictingAccessors.size) return skipResult(srcU8, base, 'accessor shared across primitives');
  if (!units.length) return skipResult(srcU8, base, 'no compressible geometry');

  // ---- optimize indexed triangle primitives ---------------------------------
  const optimizedBytes = new Map();   // accessorIndex -> Uint8Array (new content)
  const optimizedCounts = new Map();  // accessorIndex -> new count
  const componentTypeOverride = new Map(); // accessorIndex -> output componentType
  const primRows = [];

  for (const unit of units) {
    const row = {
      mesh: unit.meshIndex,
      primitive: unit.primIndex,
      mode: unit.mode,
      indexed: unit.indexAccessor != null,
      reordered: unit.reorder,
      verticesIn: 0,
      verticesOut: 0,
      triangles: 0,
      geometryBytesIn: 0,
    };
    try {
      if (unit.reorder) {
        const indexRaw = readAccessorRaw(json, bin, unit.indexAccessor);
        const attributeRaws = unit.attributes.map((a) => ({ index: a.index, name: a.name, raw: readAccessorRaw(json, bin, a.index) }));
        const opt = optimizeIndexedPrimitive({ indexRaw, attributeRaws });
        optimizedCounts.set(unit.indexAccessor, opt.indices.length);
        const idxOut = indicesToBytes(opt.indices, indexRaw.componentType);
        componentTypeOverride.set(unit.indexAccessor, idxOut.componentType);
        optimizedBytes.set(unit.indexAccessor, idxOut.bytes);
        for (const a of attributeRaws) {
          optimizedBytes.set(a.index, opt.attributeBytes.get(a.index));
          optimizedCounts.set(a.index, opt.unique);
        }
        row.verticesIn = opt.vertexCountIn;
        row.verticesOut = opt.unique;
        row.triangles = opt.indices.length / 3;
        row.geometryBytesIn = indexRaw.bytes.length + attributeRaws.reduce((s, a) => s + a.raw.bytes.length, 0);
      } else {
        let maxCount = 0;
        let geomIn = 0;
        for (const a of unit.attributes) {
          const raw = readAccessorRaw(json, bin, a.index);
          maxCount = Math.max(maxCount, raw.count);
          geomIn += raw.bytes.length;
        }
        if (unit.indexAccessor != null) {
          const raw = readAccessorRaw(json, bin, unit.indexAccessor);
          maxCount = Math.max(maxCount, raw.count);
          geomIn += raw.bytes.length;
          row.triangles = Math.floor(raw.count / 3);
        } else if (unit.mode === 4) {
          row.triangles = Math.floor(maxCount / 3);
        }
        row.verticesIn = maxCount;
        row.verticesOut = maxCount;
        row.geometryBytesIn = geomIn;
      }
    } catch (err) {
      return skipResult(srcU8, base, `primitive ${unit.meshIndex}/${unit.primIndex}: ${err.message}`);
    }
    primRows.push(row);
  }

  // ---- emit output segments --------------------------------------------------
  const binParts = [];
  let binLen = 0;
  const align4 = () => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) {
      binParts.push(new Uint8Array(pad));
      binLen += pad;
    }
  };
  const newViews = [];
  const viewForAccessor = new Map();
  const segments = [];

  const emitCompressed = (bytes, { accessorIndex, role, mode, count, elementSize }) => {
    // Vertex codec requires stride % 4 == 0 and <= 256; index codecs require
    // 16/32-bit strides (promotion already handled 8-bit). Fall back to a
    // verbatim segment when a layout cannot satisfy the codec.
    const encodable = elementSize > 0 && elementSize <= 256 && elementSize % 4 === 0 &&
      (mode === 'ATTRIBUTES' || elementSize === 2 || elementSize === 4);
    if (!encodable) {
      emitVerbatim(bytes, { accessorIndex, role });
      return;
    }
    let enc;
    try {
      enc = MeshoptEncoder.encodeGltfBuffer(bytes, count, elementSize, mode);
    } catch (err) {
      emitVerbatim(bytes, { accessorIndex, role });
      return;
    }
    align4();
    const offset = binLen;
    binParts.push(enc); // the compressed payload is what lands in the BIN
    binLen += enc.length;
    align4();
    const viewIndex = newViews.length;
    newViews.push({
      buffer: 0,
      byteOffset: 0, // informational: uncompressed length, no fallback stored
      byteLength: bytes.byteLength,
      extensions: {
        [MESHOPT_EXTENSION]: {
          buffer: 0,
          byteOffset: offset,
          byteLength: enc.length,
          byteStride: elementSize,
          mode,
          count,
          filter: 'NONE',
        },
      },
    });
    viewForAccessor.set(accessorIndex, viewIndex);
    segments.push({ accessorIndex, role, bufferView: viewIndex, mode, count, elementSize, compressed: true, bytesIn: bytes.byteLength, bytesOut: enc.length });
  };

  const emitVerbatim = (bytes, { accessorIndex = null, role = 'verbatim' } = {}) => {
    align4();
    const offset = binLen;
    binParts.push(bytes);
    binLen += bytes.length;
    const viewIndex = newViews.length;
    newViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    if (accessorIndex != null) viewForAccessor.set(accessorIndex, viewIndex);
    segments.push({ accessorIndex, role, bufferView: viewIndex, mode: null, compressed: false, bytesIn: bytes.byteLength, bytesOut: bytes.byteLength });
  };

  for (const unit of units) {
    if (unit.indexAccessor != null) {
      const ai = unit.indexAccessor;
      const bytes = optimizedBytes.get(ai) ?? readAccessorRaw(json, bin, ai).bytes.slice();
      const ct = componentTypeOverride.get(ai) ?? json.accessors[ai].componentType;
      const es = COMPONENT_SIZE[ct];
      const mode = unit.mode === 4 ? 'TRIANGLES' : 'INDICES';
      emitCompressed(bytes, { accessorIndex: ai, role: 'index', mode, count: bytes.length / es, elementSize: es });
    }
    for (const a of unit.attributes) {
      const ai = a.index;
      const bytes = optimizedBytes.get(ai) ?? readAccessorRaw(json, bin, ai).bytes.slice();
      const acc = json.accessors[ai];
      const es = accessorElementSize(acc);
      emitCompressed(bytes, { accessorIndex: ai, role: 'attribute', mode: 'ATTRIBUTES', count: optimizedCounts.get(ai) ?? acc.count, elementSize: es });
    }
  }

  // All remaining accessors anywhere in the document (animations, skins,
  // EXT_mesh_gpu_instancing, ...) pass through verbatim. Interleaved or
  // sparse stragglers fall back to copying their whole parent bufferView,
  // preserving the accessor's byteOffset within it.
  const accessors = json.accessors || [];
  const accessorByteOffsetKeep = new Map(); // accessorIndex -> byteOffset to preserve
  for (let ai = 0; ai < accessors.length; ai++) {
    if (processedAccessors.has(ai) || viewForAccessor.has(ai)) continue;
    const acc = accessors[ai];
    if (acc.bufferView == null) continue;
    let raw;
    try {
      raw = readAccessorRaw(json, bin, ai);
    } catch (_) {
      const bv = json.bufferViews[acc.bufferView];
      const start = bv.byteOffset || 0;
      emitVerbatim(bin.subarray(start, start + (bv.byteLength || 0)).slice(), { role: 'passthrough-view' });
      accessorByteOffsetKeep.set(ai, acc.byteOffset || 0);
      continue;
    }
    emitVerbatim(raw.bytes.slice(), { accessorIndex: ai, role: 'passthrough' });
  }

  // Image payload views (embedded textures) pass through verbatim.
  for (const image of json.images || []) {
    if (image.bufferView == null) continue;
    const bv = json.bufferViews[image.bufferView];
    const start = bv.byteOffset || 0;
    const len = bv.byteLength || 0;
    emitVerbatim(bin.subarray(start, start + len).slice(), { role: 'image' });
  }

  // ---- rewrite JSON -----------------------------------------------------------
  const outBin = new Uint8Array(binLen);
  let cursor = 0;
  for (const part of binParts) {
    outBin.set(part, cursor);
    cursor += part.length;
  }

  const newAccessors = accessors.map((acc, ai) => {
    const vi = viewForAccessor.get(ai);
    if (vi == null) return acc; // zero-fill default accessor (no bufferView)
    const next = { ...acc, bufferView: vi };
    const keepOffset = accessorByteOffsetKeep.get(ai);
    if (keepOffset != null) next.byteOffset = keepOffset;
    else delete next.byteOffset;
    const ct = componentTypeOverride.get(ai);
    if (ct != null) next.componentType = ct;
    const oc = optimizedCounts.get(ai);
    if (oc != null) next.count = oc;
    return next;
  });

  const newJson = {
    ...json,
    accessors: newAccessors,
    bufferViews: newViews,
    buffers: [{ ...(json.buffers && json.buffers[0] ? json.buffers[0] : {}), byteLength: outBin.length }],
  };
  newJson.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []), MESHOPT_EXTENSION]));
  newJson.extensionsRequired = Array.from(new Set([...(json.extensionsRequired || []), MESHOPT_EXTENSION]));
  const generatorNote = ' + campaign-meshopt (EXT_meshopt_compression)';
  newJson.asset = { ...(json.asset || {}) };
  newJson.asset.generator = `${json.asset?.generator || 'unknown'}${generatorNote}`;

  const glb = buildGlb(newJson, outBin);

  const geometryBytesIn = primRows.reduce((s, r) => s + r.geometryBytesIn, 0);
  const geometryBytesOut = segments
    .filter((s) => s.role === 'index' || s.role === 'attribute')
    .reduce((s, r) => s + r.bytesOut, 0);
  const metrics = {
    ...base,
    skipped: false,
    sourceBytes: srcU8.length,
    outputBytes: glb.length,
    savedBytes: Math.max(0, srcU8.length - glb.length),
    savingsPercent: srcU8.length ? Math.round(((srcU8.length - glb.length) / srcU8.length) * 1000) / 10 : 0,
    geometryBytesIn,
    geometryBytesOut,
    geometrySavingsPercent: geometryBytesIn ? Math.round(((geometryBytesIn - geometryBytesOut) / geometryBytesIn) * 1000) / 10 : 0,
    triangles: primRows.reduce((s, r) => s + r.triangles, 0),
    verticesIn: primRows.reduce((s, r) => s + r.verticesIn, 0),
    verticesOut: primRows.reduce((s, r) => s + r.verticesOut, 0),
    primitives: primRows,
    segments,
  };
  return { glb, metrics };
}

/**
 * Process a single GLB file: hash-cache check, compress, optional in-place
 * write, manifest bookkeeping.
 * @param {string} filePath absolute path to the .glb
 * @param {{ write?: boolean, force?: boolean, manifest?: object|null }} [options]
 * @returns {Promise<object>} result row (metrics + path/cache fields)
 */
export async function processGlbFile(filePath, { write = false, force = false, manifest = null } = {}) {
  const sourceBytes = readFileSync(filePath);
  const currentHash = fnv1a(sourceBytes);
  const cachedEntry = manifest && manifest.files && manifest.files[filePath];
  // In-place processing replaces the source, so the cache matches on the
  // OUTPUT hash of the file currently on disk (falling back to sourceHash
  // for manifests written before output hashing existed).
  if (!force && cachedEntry &&
      (cachedEntry.outputHash === currentHash ||
       (cachedEntry.outputHash == null && cachedEntry.sourceHash === currentHash))) {
    return {
      file: filePath,
      sourceHash: currentHash,
      sourceBytes: sourceBytes.length,
      outputBytes: cachedEntry.outputBytes,
      savingsPercent: cachedEntry.savingsPercent,
      triangles: cachedEntry.triangles ?? 0,
      skipped: false,
      cached: true,
      written: false,
    };
  }
  const { glb, metrics } = await compressGlb(sourceBytes, { label: basename(filePath) });
  const row = {
    file: filePath,
    sourceHash: currentHash,
    ...metrics,
    cached: false,
    written: false,
  };
  if (write && !metrics.skipped) {
    writeFileSync(filePath, glb);
    row.written = true;
    row.outputBytes = glb.length;
    row.outputHash = fnv1a(glb);
  }
  return row;
}

/**
 * Walk a directory tree and process every .glb found.
 * @param {string} dir
 * @param {{ write?: boolean, force?: boolean, manifestOut?: string|null }} [options]
 * @returns {Promise<{ results: object[], summary: object }>}
 */
export async function processGlbDirectory(dir, { write = false, force = false, manifestOut = null } = {}) {
  let manifest = null;
  if (manifestOut && existsSync(manifestOut)) {
    try {
      manifest = JSON.parse(readFileSync(manifestOut, 'utf8'));
    } catch (_) {
      manifest = null;
    }
  }

  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(p);
      } else if (extname(e.name).toLowerCase() === '.glb') {
        files.push(p);
      }
    }
  })(dir);
  files.sort();

  const results = [];
  for (const f of files) {
    try {
      results.push(await processGlbFile(f, { write, force, manifest }));
    } catch (err) {
      results.push({ file: f, error: err.message, skipped: true });
    }
  }

  const ok = results.filter((r) => !r.error);
  // Skipped files contribute no output bytes; exclude them from savings math.
  const counted = ok.filter((r) => !r.skipped);
  const summary = {
    totalFiles: results.length,
    processed: ok.filter((r) => !r.cached && !r.skipped).length,
    cached: ok.filter((r) => r.cached).length,
    skippedFiles: results.filter((r) => r.skipped || r.metrics?.skipped).map((r) => ({ file: r.file, reason: r.reason || r.metrics?.reason })),
    totalSourceBytes: counted.reduce((s, r) => s + (r.sourceBytes || 0), 0),
    totalOutputBytes: counted.reduce((s, r) => s + (r.outputBytes || 0), 0),
    totalTriangles: counted.reduce((s, r) => s + (r.triangles || 0), 0),
    totalVerticesIn: counted.reduce((s, r) => s + (r.verticesIn || 0), 0),
    totalVerticesOut: counted.reduce((s, r) => s + (r.verticesOut || 0), 0),
  };
  summary.totalSavedBytes = Math.max(0, summary.totalSourceBytes - summary.totalOutputBytes);
  summary.overallSavingsPercent = summary.totalSourceBytes
    ? Math.round((summary.totalSavedBytes / summary.totalSourceBytes) * 1000) / 10
    : 0;

  if (write && manifestOut) {
    if (!existsSync(dirname(manifestOut))) mkdirSync(dirname(manifestOut), { recursive: true });
    const manifestData = {
      generated: new Date().toISOString(),
      tool: 'tools/campaign-meshopt.mjs',
      extension: MESHOPT_EXTENSION,
      summary,
      files: Object.fromEntries(ok.filter((r) => !r.cached).map((r) => [r.file, {
        sourceHash: r.sourceHash,
        outputHash: r.outputHash ?? null,
        sourceBytes: r.sourceBytes,
        outputBytes: r.outputBytes,
        savingsPercent: r.savingsPercent,
        triangles: r.triangles || 0,
      }])),
    };
    writeFileSync(manifestOut, JSON.stringify(manifestData, null, 2));
  }

  return { results, summary };
}

// CLI entry point -------------------------------------------------------------
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
  const cwd = process.cwd();
  const manifestPath = args.manifest
    ? join(cwd, String(args.manifest))
    : join(cwd, 'public/models/meshopt-manifest.json');

  const rows = [];
  if (args.file) {
    rows.push(await processGlbFile(join(cwd, String(args.file)), { write: !!args.write, force: !!args.force }));
  } else {
    const targetDir = join(cwd, String(args.dir || 'public/models'));
    const { results, summary } = await processGlbDirectory(targetDir, {
      write: !!args.write,
      force: !!args.force,
      manifestOut: manifestPath,
    });
    rows.push(...results);
    console.log(
      `\n[meshopt] Summary: ${summary.totalFiles} files | ${summary.processed} processed, ${summary.cached} cached | ` +
      `Source: ${(summary.totalSourceBytes / 1024).toFixed(1)} KB -> Output: ${(summary.totalOutputBytes / 1024).toFixed(1)} KB ` +
      `(-${summary.overallSavingsPercent}%) | ${summary.totalTriangles} triangles, ${summary.totalVerticesIn}->${summary.totalVerticesOut} vertices`
    );
    if (summary.skippedFiles.length) {
      for (const s of summary.skippedFiles) console.log(`[meshopt] skipped ${basename(s.file)}: ${s.reason}`);
    }
  }
  for (const r of rows) {
    if (r.error) console.log(`[meshopt] ERROR ${basename(r.file)}: ${r.error}`);
    else if (r.skipped) console.log(`[meshopt] ${basename(r.file)} skipped: ${r.reason}`);
    else console.log(`[meshopt] ${basename(r.file)} ${(r.sourceBytes / 1024).toFixed(1)}KB -> ${((r.outputBytes || 0) / 1024).toFixed(1)}KB (-${r.savingsPercent}%)${r.cached ? ' [cached]' : r.written ? ' [written]' : ' [dry-run]'}`);
  }
}
