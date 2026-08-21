// src/engine/meshoptGlbLoader.js — Runtime GLB loading with meshopt decode
// support (SA-04, Graphics & Performance Campaign 2).
//
// Wires three's GLTFLoader to the bundled MeshoptDecoder so static prop GLBs
// compressed by tools/campaign-meshopt.mjs (EXT_meshopt_compression) decode
// transparently. Files without the extension load through the exact same
// path, so callers never branch on compression.
//
// Node-safe: importing and parsing geometry-only GLBs requires no DOM/WebGL,
// which keeps the selftest coverage headless.

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const MESHOPT_EXTENSION = 'EXT_meshopt_compression';

let _decoderPromise = null;

/**
 * Resolves once the shared MeshoptDecoder WASM instance is ready.
 * @returns {Promise<typeof MeshoptDecoder>}
 */
export function getMeshoptDecoder() {
  if (!_decoderPromise) {
    _decoderPromise = MeshoptDecoder.ready.then(() => MeshoptDecoder);
  }
  return _decoderPromise;
}

let _globalLoader = null;

/**
 * Shared GLTFLoader singleton with the meshopt decoder attached.
 * @param {import('three').LoadingManager} [manager]
 * @returns {Promise<GLTFLoader>}
 */
export async function getGlobalMeshoptGlbLoader(manager) {
  if (!_globalLoader || (manager && _globalLoader.manager !== manager)) {
    const loader = manager ? new GLTFLoader(manager) : new GLTFLoader();
    loader.setMeshoptDecoder(await getMeshoptDecoder());
    _globalLoader = loader;
  }
  return _globalLoader;
}

/**
 * Load a GLB URL with meshopt decode support.
 * @param {string} url
 * @param {(progress: import('three').ProgressEvent) => void} [onProgress]
 * @returns {Promise<{scene: import('three').Group, scenes: import('three').Group[], json: object}>}
 */
export async function loadMeshoptGlb(url, onProgress) {
  const loader = await getGlobalMeshoptGlbLoader();
  return loader.loadAsync(url, onProgress);
}

/**
 * Parse GLB bytes (or a JSON string) already in memory.
 * @param {ArrayBuffer|string} data
 * @param {string} [path]
 * @returns {Promise<{scene: import('three').Group, scenes: import('three').Group[], json: object}>}
 */
export async function parseMeshoptGlb(data, path = '') {
  const loader = await getGlobalMeshoptGlbLoader();
  return new Promise((resolve, reject) => {
    loader.parse(data, path, resolve, reject);
  });
}

/**
 * Inspect a parsed glTF JSON document for compression state and coarse
 * geometry size (decode metrics / debug aid).
 * @param {object} json glTF root object
 * @returns {{
 *   usesMeshopt: boolean, meshoptRequired: boolean,
 *   extensionsUsed: string[], extensionsRequired: string[],
 *   meshCount: number, triangleEstimate: number
 * }}
 */
export function inspectGlbJson(json) {
  const used = json.extensionsUsed || [];
  const required = json.extensionsRequired || [];
  let triangleEstimate = 0;
  const accessors = json.accessors || [];
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if ((prim.mode ?? 4) !== 4) continue;
      if (prim.indices != null && accessors[prim.indices]) {
        triangleEstimate += Math.floor(accessors[prim.indices].count / 3);
      } else if (prim.attributes && prim.attributes.POSITION != null && accessors[prim.attributes.POSITION]) {
        triangleEstimate += Math.floor(accessors[prim.attributes.POSITION].count / 3);
      }
    }
  }
  return {
    usesMeshopt: used.includes(MESHOPT_EXTENSION),
    meshoptRequired: required.includes(MESHOPT_EXTENSION),
    extensionsUsed: used.slice(),
    extensionsRequired: required.slice(),
    meshCount: (json.meshes || []).length,
    triangleEstimate,
  };
}
