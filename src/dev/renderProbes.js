// Development-only render-attribution probes for the flight recorder
// (campaign W1/W2). Pure counters — no engine behavior change, no allocation in
// the per-frame path: expensive scene traversals run on a wall-clock cadence
// and their results are written into ONE reused snapshot object that
// `sample()` keeps returning.
//
// Everything here reads state three.js already exposes (renderer.info.memory,
// object flags, material maps) plus the lighting telemetry facade and world-cell
// lifecycle tracker (cellLifecycle.js). Objects are duck-typed
// (isMesh/isInstancedMesh/isGroup), so the module stays Node-runnable without
// instantiating any WebGL object. Nothing imports or patches engine modules,
// so production builds that never load src/dev stay byte-for-byte untouched.

// RGBA8 + full mip chain factor used for the texture footprint ESTIMATE. The
// game bakes 8-bit canvas/DataTextures almost exclusively, so 4 B/px is the
// right order; 1.33 accounts for the 1/2 + 1/4 + ... mip chain.
const MIP_FACTOR = 4 / 3;
const BYTES_PER_TEXEL = 4;

/** Terrain LOD bucket by chunk vertex count (LOD_SEGS 96/48/24 + skirts). */
function terrainLodBucket(positionCount) {
  if (positionCount >= 8000) return 0;
  if (positionCount >= 2000) return 1;
  return 2;
}

function findGroup(root, match) {
  let found = null;
  root.traverse((object) => {
    if (!found && object.isGroup && match(object)) found = object;
  });
  return found;
}

/**
 * Create the probe set.
 *
 * @param {object} [options]
 * @param {THREE.Scene|THREE.Object3D} [options.scene] traversal root
 * @param {object} [options.renderer] THREE.WebGLRenderer (info.memory source)
 * @param {object} [options.lighting] engine lighting facade (optional; its
 *   getShadowTelemetry() reports allocated cascade maps)
 * @param {object} [options.world] world facade (optional; group preferred as
 *   the shadow-count root, mirroring main.js shadowSceneCounts; cells facade)
 * @param {object} [options.cells] explicit cell lifecycle tracker
 * @param {() => number} [options.now] injectable clock (node selftests)
 * @param {number} [options.traverseIntervalMs] minimum gap between full scene
 *   traversals (default 1000 ms; per-frame calls between traversals only copy
 *   cached numbers plus renderer.info.memory)
 * @returns {{ sample: () => object }} sample() returns a REUSED object — copy
 *   it if you must retain values across calls.
 */
export function createRenderProbes(options = {}) {
  const scene = options.scene || null;
  const renderer = options.renderer || null;
  const lighting = options.lighting || null;
  const world = options.world || null;
  const explicitCells = options.cells || null;
  const now = options.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const intervalMs = options.traverseIntervalMs ?? 1000;

  // Reused snapshot — the flight recorder's frame() reads it every frame, so
  // it must never allocate (AGENTS.md hot-loop rule).
  const snap = {
    geoMem: 0, texMem: 0,
    casters: 0, receivers: 0,
    instancedMeshes: 0, instancedInstances: 0,
    vegMeshes: 0, vegInstances: 0,
    chunksVisible: 0, chunksLod0: 0, chunksLod1: 0, chunksLod2: 0,
    cellsActive: 0, cellsVisible: 0, cellsShadowOnly: 0, cellsDistant: 0, cellsDormant: 0, cellsTotal: 0,
    cellsVersion: 0,
    texMB: 0, texCount: 0, texUnsized: 0,
    shadowRTCount: 0, shadowRTMB: 0,
    rtCount: 0, rtMB: 0,
  };

  let lastTraverseAt = -Infinity;
  let texBytes = 0;
  const textures = new Set();

  function censusTextures(object) {
    const materials = Array.isArray(object.material)
      ? object.material : (object.material ? [object.material] : []);
    for (const material of materials) {
      if (!material || typeof material !== 'object') continue;
      for (const key of Object.keys(material)) {
        const value = material[key];
        if (!value?.isTexture || textures.has(value)) continue;
        textures.add(value);
        snap.texCount++;
        const img = value.image;
        const w = value.isCubeTexture ? img?.[0]?.width : img?.width;
        const h = value.isCubeTexture ? img?.[0]?.height : img?.height;
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          const faces = value.isCubeTexture ? 6 : 1;
          texBytes += w * h * BYTES_PER_TEXEL * MIP_FACTOR * faces;
        } else {
          snap.texUnsized++; // compressed/custom layouts we cannot size
        }
      }
    }
  }

  function traverseHeavy() {
    const root = world?.group || scene;
    snap.casters = snap.receivers = 0;
    snap.instancedMeshes = snap.instancedInstances = 0;
    snap.vegMeshes = snap.vegInstances = 0;
    snap.chunksVisible = snap.chunksLod0 = snap.chunksLod1 = snap.chunksLod2 = 0;
    snap.texMB = 0; snap.texCount = 0; snap.texUnsized = 0;
    texBytes = 0;
    if (!root) return;
    root.traverse((object) => {
      if ((object.isMesh || object.isInstancedMesh) && object.visible) {
        if (object.castShadow) snap.casters++;
        if (object.receiveShadow) snap.receivers++;
      }
      if (object.isInstancedMesh && object.visible) {
        snap.instancedMeshes++;
        snap.instancedInstances += Math.max(0, object.count | 0);
      }
      // Texture census across every material slot of any renderable (visible
      // or not — GPU uploads happen on first bind, not on visibility).
      if (object.isMesh || object.isPoints || object.isLine || object.isSprite) {
        censusTextures(object);
      }
    });
    snap.texMB = texBytes / 1048576;

    // Scoped sub-traverses: vegetation.js names its root group ('vegetation',
    // vegetation.js:1518); the terrain chunk group carries userData.updateLOD
    // (terrain.js:2723). Subtrees stay bounded, so this stays cheap at 1 Hz.
    const vegRoot = findGroup(root, (g) => g.name === 'vegetation');
    if (vegRoot) {
      vegRoot.traverse((object) => {
        if (!object.isInstancedMesh || !object.visible) return;
        snap.vegMeshes++;
        snap.vegInstances += Math.max(0, object.count | 0);
      });
    }
    const terrain = findGroup(root, (g) => typeof g.userData?.updateLOD === 'function');
    if (terrain) {
      terrain.traverse((object) => {
        if (!object.isMesh || !object.visible) return;
        snap.chunksVisible++;
        const bucket = terrainLodBucket(object.geometry?.attributes?.position?.count || 0);
        if (bucket === 0) snap.chunksLod0++;
        else if (bucket === 1) snap.chunksLod1++;
        else snap.chunksLod2++;
      });
    }
  }

  function sampleCells() {
    try {
      const cells = explicitCells || world?.cells || world?._cells || options.vegetation?._cells;
      if (cells && typeof cells.stats === 'function') {
        const cs = cells.stats();
        snap.cellsActive = cs.ACTIVE || 0;
        snap.cellsVisible = cs.VISIBLE || 0;
        snap.cellsShadowOnly = cs.SHADOW_ONLY || 0;
        snap.cellsDistant = cs.DISTANT || 0;
        snap.cellsDormant = cs.DORMANT || 0;
        snap.cellsTotal = (cs.ACTIVE || 0) + (cs.VISIBLE || 0) + (cs.SHADOW_ONLY || 0) + (cs.DISTANT || 0) + (cs.DORMANT || 0);
        snap.cellsVersion = cs.version || 0;
      } else {
        snap.cellsActive = snap.cellsVisible = snap.cellsShadowOnly = snap.cellsDistant = snap.cellsDormant = snap.cellsTotal = snap.cellsVersion = 0;
      }
    } catch (_) {
      snap.cellsActive = snap.cellsVisible = snap.cellsShadowOnly = snap.cellsDistant = snap.cellsDormant = snap.cellsTotal = snap.cellsVersion = 0;
    }
  }

  function sampleShadowTelemetry() {
    try {
      const tele = lighting?.getShadowTelemetry?.();
      if (!tele?.cascades) { snap.shadowRTCount = 0; snap.shadowRTMB = 0; }
      else {
        let count = 0;
        let bytes = 0;
        for (const cascade of tele.cascades) {
          if (!cascade.allocated || !cascade.allocatedSize) continue;
          count++;
          // Depth-only cascade target: 4 B/px is the conservative D32 case.
          bytes += cascade.allocatedSize * cascade.allocatedSize * 4;
        }
        snap.shadowRTCount = count;
        snap.shadowRTMB = bytes / 1048576;
      }
    } catch (_) { snap.shadowRTCount = 0; snap.shadowRTMB = 0; }

    snap.rtCount = snap.shadowRTCount;
    snap.rtMB = snap.shadowRTMB;
    try {
      const post = options.post || options.composer;
      if (post) {
        const postCount = options.postRTCount || 4;
        const postMB = options.postRTMB || 16;
        snap.rtCount += postCount;
        snap.rtMB += postMB;
      }
    } catch (_) {}
  }

  function sample() {
    const info = renderer?.info;
    snap.geoMem = Math.min(info?.memory?.geometries || 0, 65535);
    snap.texMem = Math.min(info?.memory?.textures || 0, 65535);
    const at = now();
    if (at - lastTraverseAt >= intervalMs) {
      lastTraverseAt = at;
      try { traverseHeavy(); } catch (_) { /* keep last good counters */ }
      sampleShadowTelemetry();
      sampleCells();
    }
    return snap;
  }

  return { sample };
}

