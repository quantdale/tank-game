// tools/campaign-meshopt.selftest.mjs — SA-04 coverage for the meshopt GLB
// compression tooling and its runtime decode support.
//
// Verifies:
// 1. GLB container parse/build identity.
// 2. EXT_meshopt_compression output structure (extensionsUsed/Required,
//    compressed bufferView defs, verbatim passthrough of non-geometry).
// 3. Decode fidelity: attribute segments bit-exact against the exported
//    optimizer's output; index segments topologically identical to source
//    (the meshopt index codec may rotate vertices within a triangle).
// 4. Runtime path: three GLTFLoader + MeshoptDecoder parses the compressed
//    GLB headlessly and yields the exact optimized geometry.
// 5. Contract: parsing a compressed GLB without a decoder rejects clearly.
// 6. Real-repo asset smoke test (public/models/props/sandbags_jtoastie.glb).
// 7. Directory processing with in-place write, manifest caching (output-hash
//    based, since processing replaces the source), and --force semantics.
//
// Run: node tools/campaign-meshopt.selftest.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  parseGlb,
  buildGlb,
  readAccessorRaw,
  toUint32Indices,
  optimizeIndexedPrimitive,
  indicesToBytes,
  canonicalTriangles,
  compressGlb,
  processGlbDirectory,
  MESHOPT_EXTENSION,
} from './campaign-meshopt.mjs';
import { parseMeshoptGlb, inspectGlbJson } from '../src/engine/meshoptGlbLoader.js';
import { fnv1a } from './campaign-png.mjs';

console.log('--- Running campaign-meshopt.selftest.mjs ---');

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Synthetic asset builder: structured (compressible) float32 geometry with
// ~10% unreferenced vertices so compaction is exercised, plus two orphan
// accessors that must pass through verbatim.
// ---------------------------------------------------------------------------
function buildSyntheticGlb({ vertexCount = 4096, triangleCount = 8000, referencedFraction = 0.9 } = {}) {
  const V = vertexCount;
  const T = triangleCount;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    const a = i * 0.01;
    const r = 8 + Math.sin(a * 3.1) * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a * 2.3) * 2;
    pos[i * 3 + 2] = Math.sin(a) * r;
    nrm[i * 3] = Math.cos(a);
    nrm[i * 3 + 1] = 0.3;
    nrm[i * 3 + 2] = Math.sin(a);
    uv[i * 2] = (i % 64) / 64;
    uv[i * 2 + 1] = Math.floor(i / 64) / 64;
  }
  const R = Math.max(3, Math.floor(V * referencedFraction));
  const idx = new Uint32Array(T * 3);
  for (let t = 0; t < T; t++) {
    idx[t * 3] = (t * 7) % R;
    idx[t * 3 + 1] = (t * 13 + 1) % R;
    idx[t * 3 + 2] = (t * 29 + 2) % R;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], pos[i * 3 + c]);
      max[c] = Math.max(max[c], pos[i * 3 + c]);
    }
  }
  const passthroughA = new Float32Array([1.5, -2.5, 3.25]);
  const passthroughB = new Uint16Array([7, 9, 11, 13]);

  const sizes = [V * 12, V * 12, V * 8, T * 12, 12, 8];
  const offsets = [];
  let acc = 0;
  for (const sz of sizes) {
    offsets.push(acc);
    acc += sz;
  }
  const bin = new Uint8Array(acc);
  bin.set(new Uint8Array(pos.buffer), offsets[0]);
  bin.set(new Uint8Array(nrm.buffer), offsets[1]);
  bin.set(new Uint8Array(uv.buffer), offsets[2]);
  bin.set(new Uint8Array(idx.buffer), offsets[3]);
  bin.set(new Uint8Array(passthroughA.buffer), offsets[4]);
  bin.set(new Uint8Array(passthroughB.buffer), offsets[5]);

  const json = {
    asset: { version: '2.0', generator: 'meshopt-selftest-synthetic' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'synthetic' }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        mode: 4,
      }],
    }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.7, 0.6, 1], metallicFactor: 0.1, roughnessFactor: 0.7 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: V, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: V, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: V, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count: T * 3, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'SCALAR' },
      { bufferView: 5, componentType: 5123, count: 4, type: 'SCALAR' },
    ],
    bufferViews: sizes.map((sz, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: sz })),
    buffers: [{ byteLength: bin.length }],
  };
  return { glb: buildGlb(json, bin), json, bin, idx, vertexCount: V, triangleCount: T, referenced: R };
}

// Rebuild optimizer expectations for every indexed TRIANGLES primitive using
// the tool's own exported primitives, then decode every compressed bufferView
// and compare: attributes bit-exact, indices rotation-canonical vs source.
async function verifyRoundtrip(srcU8, compU8) {
  await MeshoptDecoder.ready;
  const src = parseGlb(srcU8);
  const cmp = parseGlb(compU8);

  const expectedBytes = new Map();   // accessorIndex -> Uint8Array
  const indexPrimInfo = new Map();   // indexAccessorIndex -> { sourceIndices, sourcePositions, expectedPositions }
  for (const mesh of src.json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if ((prim.mode ?? 4) !== 4 || prim.indices == null) continue;
      const indexRaw = readAccessorRaw(src.json, src.bin, prim.indices);
      const attributeRaws = Object.entries(prim.attributes).map(([name, index]) => ({
        index,
        name,
        raw: readAccessorRaw(src.json, src.bin, index),
      }));
      const opt = optimizeIndexedPrimitive({ indexRaw, attributeRaws });
      const out = indicesToBytes(opt.indices, indexRaw.componentType);
      expectedBytes.set(prim.indices, out.bytes);
      indexPrimInfo.set(prim.indices, {
        // TRUE source indices (pre-optimization ids) paired with the original
        // position buffer; the decoded side pairs new ids with the compacted
        // buffer. Both sides must describe the same oriented triangle set.
        sourceIndices: toUint32Indices(indexRaw.bytes, indexRaw.componentType),
        sourcePositions: new Float32Array(
          attributeRaws[0].raw.bytes.buffer,
          attributeRaws[0].raw.bytes.byteOffset,
          attributeRaws[0].raw.count * 3
        ),
        expectedPositions: new Float32Array(opt.attributeBytes.get(attributeRaws[0].index).buffer, 0, opt.unique * 3),
      });
      for (const a of attributeRaws) expectedBytes.set(a.index, opt.attributeBytes.get(a.index));
    }
  }

  let checkedCompressed = 0;
  for (let vi = 0; vi < cmp.json.bufferViews.length; vi++) {
    const view = cmp.json.bufferViews[vi];
    const ext = view.extensions && view.extensions[MESHOPT_EXTENSION];
    if (!ext) continue;
    const ai = cmp.json.accessors.findIndex((a) => a.bufferView === vi);
    assert.ok(ai >= 0, `compressed view ${vi} unreferenced by any accessor`);
    const source = cmp.bin.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength);
    const decoded = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(decoded, ext.count, ext.byteStride, source, ext.mode, ext.filter);
    const exp = expectedBytes.get(ai);
    assert.ok(exp !== undefined, `accessor ${ai} was compressed but has no expectation`);
    if (indexPrimInfo.has(ai)) {
      // index segment: topology-equal up to codec rotation
      const info = indexPrimInfo.get(ai);
      const decodedIdx = new Uint32Array(decoded.buffer, 0, decoded.length / 4);
      assert.deepEqual(
        canonicalTriangles(decodedIdx, info.expectedPositions),
        canonicalTriangles(info.sourceIndices, info.sourcePositions),
        `decoded index buffer for accessor ${ai} changed mesh topology`
      );
    } else {
      assert.ok(
        Buffer.from(decoded).equals(Buffer.from(exp)),
        `decoded attribute ${ai} differs from optimized expectation`
      );
    }
    checkedCompressed++;
  }
  assert.ok(checkedCompressed > 0, 'no compressed segments found to verify');
  return { checkedCompressed, srcJson: src.json, cmpJson: cmp.json };
}

// ============================================================================
// 1. GLB container roundtrip identity
// ============================================================================
{
  const s = buildSyntheticGlb({ vertexCount: 64, triangleCount: 32 });
  const parsed = parseGlb(s.glb);
  assert.deepEqual(parsed.json, s.json, 'JSON chunk must survive parse');
  assert.ok(Buffer.from(parsed.bin).equals(Buffer.from(s.bin)), 'BIN chunk must survive parse');
  const rebuilt = buildGlb(parsed.json, parsed.bin);
  assert.ok(rebuilt.equals(s.glb), 'buildGlb(parseGlb(x)) must be byte-identical');
}

// ============================================================================
// 2+3. Compression structure + decode fidelity on the synthetic asset
// ============================================================================
{
  const s = buildSyntheticGlb();
  const { glb, metrics } = await compressGlb(s.glb, { label: 'synthetic' });
  assert.equal(metrics.skipped, false, `compression skipped: ${metrics.reason}`);

  const cmp = parseGlb(glb);
  assert.ok(cmp.json.extensionsUsed.includes(MESHOPT_EXTENSION), 'extensionsUsed must declare meshopt');
  assert.ok(cmp.json.extensionsRequired.includes(MESHOPT_EXTENSION), 'extensionsRequired must declare meshopt');
  assert.equal(cmp.json.buffers[0].byteLength, cmp.bin.length, 'buffer byteLength must match BIN chunk');

  assert.ok(metrics.outputBytes < metrics.sourceBytes, 'compression must shrink the synthetic asset');
  assert.ok(metrics.savingsPercent > 10, `savings ${metrics.savingsPercent}% unexpectedly low`);
  assert.ok(metrics.verticesOut < metrics.verticesIn, 'unreferenced vertices must be compacted away');
  assert.equal(metrics.triangles, s.triangleCount, 'triangle count must be preserved');

  // POSITION min/max survive permutation untouched
  const srcPos = s.json.accessors[0];
  const dstPos = cmp.json.accessors[0];
  assert.deepEqual(dstPos.min, srcPos.min, 'POSITION min must be preserved');
  assert.deepEqual(dstPos.max, srcPos.max, 'POSITION max must be preserved');
  assert.equal(dstPos.componentType, 5126, 'float32 positions stay float32');

  // Orphan accessors pass through uncompressed
  const passthrough = metrics.segments.filter((x) => x.role === 'passthrough');
  assert.equal(passthrough.length, 2, 'orphan accessors must be passed through verbatim');
  assert.ok(passthrough.every((x) => !x.compressed), 'passthrough segments must not be compressed');

  const { checkedCompressed } = await verifyRoundtrip(s.glb, glb);
  assert.ok(checkedCompressed >= 4, 'expected index + 3 attribute segments verified');
  console.log(`[synthetic] ${metrics.sourceBytes} -> ${metrics.outputBytes} bytes (-${metrics.savingsPercent}%), ${metrics.verticesIn}->${metrics.verticesOut} verts, ${checkedCompressed} segments decoded`);
}

// ============================================================================
// 4. Runtime path: headless GLTFLoader + MeshoptDecoder end-to-end
// ============================================================================
{
  const s = buildSyntheticGlb();
  const { glb, metrics } = await compressGlb(s.glb, { label: 'synthetic-runtime' });
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await parseMeshoptGlb(ab, '');

  let mesh = null;
  gltf.scene.traverse((o) => {
    if (!mesh && o.isMesh) mesh = o;
  });
  assert.ok(mesh, 'parsed scene must contain a mesh');

  const posAttr = mesh.geometry.getAttribute('position');
  assert.equal(posAttr.count, metrics.verticesOut, 'runtime vertex count must match compaction');

  // Expected compacted positions from the tool's own optimizer
  const src = parseGlb(s.glb);
  const prim = src.json.meshes[0].primitives[0];
  const attributeRaws = Object.entries(prim.attributes).map(([name, index]) => ({
    index,
    name,
    raw: readAccessorRaw(src.json, src.bin, index),
  }));
  const opt = optimizeIndexedPrimitive({
    indexRaw: readAccessorRaw(src.json, src.bin, prim.indices),
    attributeRaws,
  });
  const expPosBytes = opt.attributeBytes.get(prim.attributes.POSITION);
  assert.ok(
    Buffer.from(posAttr.array.buffer, posAttr.array.byteOffset, posAttr.array.byteLength)
      .equals(Buffer.from(expPosBytes.buffer, expPosBytes.byteOffset, expPosBytes.byteLength)),
    'runtime positions must equal the optimized vertex buffer bit-exact'
  );

  const idxAttr = mesh.geometry.getIndex();
  const srcPositions = new Float32Array(
    attributeRaws[0].raw.bytes.buffer,
    attributeRaws[0].raw.bytes.byteOffset,
    attributeRaws[0].raw.count * 3
  );
  assert.deepEqual(
    canonicalTriangles(idxAttr.array, new Float32Array(expPosBytes.buffer, 0, metrics.verticesOut * 3)),
    canonicalTriangles(s.idx, srcPositions),
    'runtime index buffer must render the identical mesh'
  );

  const insp = inspectGlbJson(parseGlb(glb).json);
  assert.equal(insp.usesMeshopt, true);
  assert.equal(insp.meshoptRequired, true);
  assert.equal(insp.triangleEstimate, s.triangleCount);
  assert.equal(insp.meshCount, 1);
}

// ============================================================================
// 5. Contract: compressed GLB without a wired decoder rejects clearly
// ============================================================================
{
  const s = buildSyntheticGlb({ vertexCount: 256, triangleCount: 400 });
  const { glb } = await compressGlb(s.glb, { label: 'no-decoder' });
  const bare = new GLTFLoader();
  await assert.rejects(
    () => new Promise((resolve, reject) =>
      bare.parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '', resolve, reject)),
    /setMeshoptDecoder/,
    'bare GLTFLoader must refuse meshopt-required files'
  );
}

// ============================================================================
// 6. Real-repo asset smoke test (dry-run, no writes)
// ============================================================================
{
  const path = join(REPO_ROOT, 'public/models/props/sandbags_jtoastie.glb');
  const srcU8 = readFileSync(path);
  const { glb, metrics } = await compressGlb(srcU8, { label: 'sandbags_jtoastie.glb' });
  assert.equal(metrics.skipped, false, `real asset skipped: ${metrics.reason}`);
  assert.ok(metrics.savingsPercent > 5, `real-asset savings only ${metrics.savingsPercent}%`);
  await verifyRoundtrip(srcU8, glb);
  console.log(`[smoke] sandbags_jtoastie.glb ${metrics.sourceBytes} -> ${metrics.outputBytes} bytes (-${metrics.savingsPercent}%), ${metrics.triangles} tris, ${metrics.verticesIn}->${metrics.verticesOut} verts`);
}

// ============================================================================
// 7. Directory processing: in-place write, manifest cache, force semantics
// ============================================================================
{
  const dir = mkdtempSync(join(tmpdir(), 'meshopt-selftest-'));
  try {
    const s = buildSyntheticGlb({ vertexCount: 1024, triangleCount: 1600 });
    const glbPath = join(dir, 'synthetic.glb');
    writeFileSync(glbPath, s.glb);
    const manifestOut = join(dir, 'meshopt-manifest.json');

    const run1 = await processGlbDirectory(dir, { write: true, manifestOut });
    assert.equal(run1.results.length, 1);
    assert.equal(run1.results[0].skipped, false);
    assert.equal(run1.results[0].written, true, 'first run must write in place');
    assert.equal(run1.summary.processed, 1);
    assert.ok(existsSync(manifestOut), 'manifest must be written');
    const after = readFileSync(glbPath);
    assert.ok(after.length < s.glb.length, 'in-place output must be smaller');
    const man = JSON.parse(readFileSync(manifestOut, 'utf8'));
    assert.equal(man.files[glbPath].outputHash, fnv1a(after), 'manifest must record the output hash');

    const run2 = await processGlbDirectory(dir, { write: true, manifestOut });
    assert.equal(run2.results[0].cached, true, 'second run must hit the output-hash cache');
    assert.equal(run2.summary.cached, 1);
    assert.ok(readFileSync(glbPath).equals(after), 'cached run must not touch the file');

    const run3 = await processGlbDirectory(dir, { write: true, force: true, manifestOut });
    assert.equal(run3.results[0].cached, false, '--force must bypass the cache');
    // --force bypasses the cache but must never double-compress: input that
    // already requires EXT_meshopt_compression is refused, file untouched.
    assert.equal(run3.results[0].written, false);
    assert.equal(run3.results[0].skipped, true);
    assert.match(run3.results[0].reason, /already compressed/);
    assert.ok(readFileSync(glbPath).equals(after), 'refused re-compression must not touch the file');

    // A changed (fresh uncompressed) source is reprocessed and rewritten.
    const fresh = buildSyntheticGlb({ vertexCount: 1024, triangleCount: 1600 });
    writeFileSync(glbPath, fresh.glb);
    const run4 = await processGlbDirectory(dir, { write: true, manifestOut });
    assert.equal(run4.results[0].cached, false, 'changed source must not hit the cache');
    assert.equal(run4.results[0].skipped, false);
    assert.equal(run4.results[0].written, true, 'changed source must be rewritten in place');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('campaign-meshopt.selftest.mjs: all assertions passed');
