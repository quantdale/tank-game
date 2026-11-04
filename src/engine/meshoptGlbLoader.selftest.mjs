// src/engine/meshoptGlbLoader.selftest.mjs — W10 release-audit coverage for
// the runtime meshopt GLB loader surface that tools/campaign-meshopt.selftest.mjs
// does not own: the shared MeshoptDecoder readiness promise, the shared-loader
// singleton semantics (decoder attached; manager swap rebuilds), and the
// UNCOMPRESSED parity contract ("callers never branch on compression").
//
// Compressed-decode fidelity itself is covered by the tool suite (synthetic
// round-trip + real repo asset); this file only pins the loader module's own
// contracts. Node-safe per module header (no DOM/WebGL needed).
//
// Run: node src/engine/meshoptGlbLoader.selftest.mjs

import assert from "node:assert/strict";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildGlb } from "../../tools/campaign-meshopt.mjs";
import {
  MESHOPT_EXTENSION,
  getMeshoptDecoder,
  getGlobalMeshoptGlbLoader,
  parseMeshoptGlb,
  inspectGlbJson,
} from "./meshoptGlbLoader.js";

// --- Minimal two-triangle quad GLB (positions float32 + uint16 indices) ----
const POSITIONS = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 0, -1, 1, 0, -1, 0, 0, 0, 0, 0, -1,
]);
const INDICES = new Uint16Array([0, 1, 2, 3, 4, 5]);
const posBytes = new Uint8Array(POSITIONS.buffer);
const idxBytes = new Uint8Array(INDICES.buffer);

function pad4(u8) {
  const p = (4 - (u8.length % 4)) % 4;
  if (!p) return u8;
  const out = new Uint8Array(u8.length + p);
  out.set(u8);
  return out;
}
const bin = new Uint8Array(pad4(idxBytes).length + pad4(posBytes).length);
bin.set(pad4(idxBytes), 0);
bin.set(pad4(posBytes), pad4(idxBytes).length);

const glbJson = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [
    {
      primitives: [
        {
          attributes: { POSITION: 0 },
          indices: 1,
          mode: 4,
        },
      ],
    },
  ],
  accessors: [
    {
      bufferView: 1,
      componentType: 5126,
      count: 6,
      type: "VEC3",
      min: [0, 0, -1],
      max: [1, 0, 0],
    },
    { bufferView: 0, componentType: 5123, count: 6, type: "SCALAR" },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: idxBytes.length },
    {
      buffer: 0,
      byteOffset: pad4(idxBytes).length,
      byteLength: posBytes.length,
    },
  ],
  buffers: [{ byteLength: bin.length }],
};
const plainGlb = buildGlb(glbJson, bin);
const toAb = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

let checks = 0;
const ok = (name) => {
  checks++;
  console.log(`[meshoptGlbLoader] ok ${checks}: ${name}`);
};

// 1. Decoder readiness resolves and looks like the meshopt decoder.
{
  const dec = await getMeshoptDecoder();
  assert.ok(dec, "getMeshoptDecoder must resolve");
  assert.equal(dec.supported, true, "WASM decoder must report supported");
  ok("shared MeshoptDecoder ready");
}

// 2. Shared-loader singleton: same instance back-to-back, decoder attached;
//    an explicit manager swaps in a fresh loader without losing the decoder.
{
  const a = await getGlobalMeshoptGlbLoader();
  const b = await getGlobalMeshoptGlbLoader();
  assert.equal(a, b, "repeat calls must return the same loader instance");
  assert.equal(typeof a.parse, "function", "loader is a GLTFLoader");

  const manager = new (await import("three")).LoadingManager();
  const c = await getGlobalMeshoptGlbLoader(manager);
  assert.notEqual(c, a, "a distinct LoadingManager must rebuild the loader");
  assert.equal(
    await getGlobalMeshoptGlbLoader(),
    c,
    "manager variant becomes the cached singleton",
  );
  // Restore the manager-less singleton for any later consumer in-process.
  const d = await getGlobalMeshoptGlbLoader(
    new (await import("three")).LoadingManager(),
  );
  assert.equal(d instanceof GLTFLoader, true);
  ok("singleton semantics (cache + manager swap)");
}

// 3. Uncompressed parity: plain GLBs parse through the same path.
{
  const gltf = await parseMeshoptGlb(toAb(plainGlb), "");
  let mesh = null;
  gltf.scene.traverse((o) => {
    if (!mesh && o.isMesh) mesh = o;
  });
  assert.ok(mesh, "parsed scene must contain a mesh");
  assert.equal(
    mesh.geometry.getAttribute("position").count,
    6,
    "vertex count preserved",
  );
  assert.deepEqual(
    Array.from(mesh.geometry.getIndex().array),
    Array.from(INDICES),
    "indices bit-exact",
  );
  ok("uncompressed GLB parses through the identical path");
}

// 4. inspectGlbJson: clean document reports no meshopt, correct estimates.
{
  const insp = inspectGlbJson(JSON.parse(JSON.stringify(glbJson)));
  assert.equal(insp.usesMeshopt, false);
  assert.equal(insp.meshoptRequired, false);
  assert.equal(insp.meshCount, 1);
  assert.equal(insp.triangleEstimate, 2, "two indexed triangles counted");
  assert.deepEqual(insp.extensionsUsed, []);
  const reqd = inspectGlbJson({
    ...glbJson,
    extensionsUsed: [MESHOPT_EXTENSION],
    extensionsRequired: [MESHOPT_EXTENSION],
  });
  assert.equal(reqd.usesMeshopt && reqd.meshoptRequired, true);
  ok("inspectGlbJson compression-state contract");
}

console.log(`meshoptGlbLoader.selftest: all ${checks} sections passed`);
