// ambientFx.js — world-cell-gated ambient FX, dust/smoke emitters,
// decorative particles, and terrain auxiliary mesh lifecycle.
//
// Pure and headless-runnable (like cellLifecycle.js / terrainLodPolicy.js):
// spatial queries and cadence scaling run deterministically in Node without
// WebGL/DOM dependencies. When Three.js / fx particles are available, it
// drives particle emissions and auxiliary mesh visibility.
//
// Spatial lifecycle contract (cellLifecycle.js):
//   ACTIVE      full cadence (1.0x), emits all ambient FX, auxiliaries visible + cast shadows
//   VISIBLE     reduced cadence (0.5x), emits ambient FX at half-rate, auxiliaries visible
//   SHADOW_ONLY resting pose, NO ambient FX emission (0 CPU ticks / 0 particles), auxiliaries visible
//   DISTANT     coarsest scenery LOD, NO ambient FX emission, auxiliaries visible (no shadow)
//   DORMANT     OUTSIDE interest: NO ambient FX emission, auxiliary meshes HIDDEN (0 GPU draws)

import {
  CELL_STATES,
  CELL_UPDATE_SCALE,
  CELL_AMBIENT_FX,
  CELL_AMBIENT_SCALE,
  CELL_AUXILIARY_VISIBLE,
  CELL_SHADOW,
  CELL_SCENERY_LOD,
  createCellLifecycle,
} from "./cellLifecycle.js";

/** Canonical PRNG for deterministic decorative particle drift. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Standard factory for ambient emitters.
 * @param {object} opts
 * @returns {object} normalized emitter record
 */
export function createAmbientEmitter({
  id = "",
  kind = "smoke", // "smoke" | "dust" | "chimney" | "fire" | "sparks" | "ash"
  x = 0,
  y = 0,
  z = 0,
  r = 0,
  rate = 2.0, // particles per second at ACTIVE rate
  interval = null, // seconds between emissions (defaults 1/rate)
  burstSize = 1,
  vel = null, // [vx, vy, vz] or function
  grav = 0.5,
  drag = 0.05,
  size0 = 1.0,
  size1 = 2.5,
  life = 3.0,
  color0 = 0x888888,
  color1 = 0x444444,
  alpha = 0.6,
  enabled = true,
} = {}) {
  const emissionInterval = interval ?? (rate > 0 ? 1 / rate : 1.0);
  return {
    id,
    kind,
    x, y, z, r,
    rate,
    interval: emissionInterval,
    burstSize,
    vel: vel || [0, 1.5, 0],
    grav,
    drag,
    size0,
    size1,
    life,
    color0,
    color1,
    alpha,
    enabled,
    acc: 0,
    cellIndex: -1,
  };
}

/**
 * Standard factory for decorative particle zones (e.g. pollen, snow, flurries, sand drift).
 * @param {object} opts
 * @returns {object} normalized decorative zone record
 */
export function createDecorativeZone({
  id = "",
  kind = "pollen", // "pollen" | "snowFlurries" | "sandDrift" | "cinders" | "marshFlies"
  x = 0,
  y = 2.0,
  z = 0,
  r = 64, // zone radius, meters
  count = 16,
  density = 1.0,
  drift = [0.2, -0.1, 0.2],
  color0 = 0xddeebb,
  color1 = 0xaaccaa,
  size = 0.15,
  life = 4.0,
  enabled = true,
} = {}) {
  return {
    id,
    kind,
    x, y, z, r,
    count,
    density,
    drift,
    color0,
    color1,
    size,
    life,
    enabled,
    acc: 0,
    coveringCells: [],
  };
}

/**
 * Standard factory for terrain auxiliary mesh registration.
 * @param {object} opts
 * @returns {object} normalized auxiliary mesh record
 */
export function createTerrainAuxiliaryMesh({
  id = "",
  mesh = null,
  x = 0,
  z = 0,
  r = 0,
  cellIndex = -1,
  hideWhenDormant = true,
  castShadow = false,
  receiveShadow = true,
  enabled = true,
} = {}) {
  return {
    id,
    mesh,
    x, z, r,
    cellIndex,
    hideWhenDormant,
    castShadow,
    receiveShadow,
    enabled,
  };
}

/**
 * Standard factory for distant scenery layers (e.g. horizon tree comb ribbons, mountain cards).
 * @param {object} opts
 * @returns {object} normalized scenery layer record
 */
export function createDistantSceneryLayer({
  id = "",
  object = null,
  x = 0,
  z = 0,
  r = 500,
  cellIndex = -1,
  lods = null, // array of LOD objects or detail tiers
  enabled = true,
} = {}) {
  return {
    id,
    object,
    x, z, r,
    cellIndex,
    lods,
    activeLod: 0,
    enabled,
  };
}

/**
 * World-cell ambient FX and auxiliary mesh manager.
 * @param {object} [opts]
 * @param {object} [opts.cells] CellLifecycle instance (creates a default 8x8 grid if omitted)
 * @param {number} [opts.seed] PRNG seed for deterministic decorative variations
 */
export function createAmbientFxSystem(opts = {}) {
  const cells = opts.cells ?? createCellLifecycle();
  const rng = mulberry32(opts.seed ?? 0x4f1a8c);

  const emitters = [];
  const decorativeZones = [];
  const auxiliaryMeshes = [];
  const sceneryLayers = [];

  let version = 0;
  let updateCount = 0;

  // Telemetry scratch (reused to avoid allocation in hot loops)
  const stats = {
    totalEmitters: 0,
    activeEmitters: 0,
    visibleEmitters: 0,
    dormantEmitters: 0,
    skippedEmitters: 0,
    particlesEmitted: 0,
    totalAuxMeshes: 0,
    visibleAuxMeshes: 0,
    dormantAuxMeshes: 0,
    totalDecorativeZones: 0,
    activeDecorativeZones: 0,
    cpuTicksSaved: 0,
    gpuDrawsSaved: 0,
    version: 0,
  };

  /** Register an ambient emitter (dust, smoke, chimney, fire, sparks). */
  function registerEmitter(emitter) {
    const rec = emitter.interval !== undefined ? emitter : createAmbientEmitter(emitter);
    rec.cellIndex = cells.indexAt(rec.x, rec.z);
    emitters.push(rec);
    cells.registerContent([rec], "ambientEmitter");
    version++;
    return rec;
  }

  /** Register a decorative particle zone (pollen, blowing snow, dust haze, insects). */
  function registerDecorativeZone(zone) {
    const rec = zone.coveringCells ? zone : createDecorativeZone(zone);
    const loX = Math.max(0, Math.floor((rec.x - rec.r - cells.originM) / cells.sizeM));
    const hiX = Math.min(cells.gridN - 1, Math.floor((rec.x + rec.r - cells.originM) / cells.sizeM));
    const loZ = Math.max(0, Math.floor((rec.z - rec.r - cells.originM) / cells.sizeM));
    const hiZ = Math.min(cells.gridN - 1, Math.floor((rec.z + rec.r - cells.originM) / cells.sizeM));
    rec.coveringCells.length = 0;
    for (let cz = loZ; cz <= hiZ; cz++) {
      for (let cx = loX; cx <= hiX; cx++) {
        rec.coveringCells.push(cz * cells.gridN + cx);
      }
    }
    decorativeZones.push(rec);
    cells.registerContent([rec], "decorativeZone");
    version++;
    return rec;
  }

  /** Register a terrain auxiliary mesh (ground decals, ditch water, road markings). */
  function registerAuxiliaryMesh(auxMesh) {
    const rec = auxMesh.hideWhenDormant !== undefined
      ? auxMesh
      : createTerrainAuxiliaryMesh(auxMesh);
    if (rec.cellIndex < 0) {
      rec.cellIndex = cells.indexAt(rec.x, rec.z);
    }
    auxiliaryMeshes.push(rec);
    cells.registerContent([rec], "auxiliaryMesh");
    version++;
    return rec;
  }

  /** Register a distant scenery layer (horizon treeline, backdrop billboard cards). */
  function registerSceneryLayer(sceneryLayer) {
    const rec = sceneryLayer.activeLod !== undefined
      ? sceneryLayer
      : createDistantSceneryLayer(sceneryLayer);
    if (rec.cellIndex < 0) {
      rec.cellIndex = cells.indexAt(rec.x, rec.z);
    }
    sceneryLayers.push(rec);
    cells.registerContent([rec], "sceneryLayer");
    version++;
    return rec;
  }

  /** Main per-frame update with spatial cell gating. */
  function update(dt, cameraPos = null, fxSystem = null) {
    updateCount++;
    stats.totalEmitters = emitters.length;
    stats.activeEmitters = 0;
    stats.visibleEmitters = 0;
    stats.dormantEmitters = 0;
    stats.skippedEmitters = 0;
    stats.particlesEmitted = 0;
    stats.totalAuxMeshes = auxiliaryMeshes.length;
    stats.visibleAuxMeshes = 0;
    stats.dormantAuxMeshes = 0;
    stats.totalDecorativeZones = decorativeZones.length;
    stats.activeDecorativeZones = 0;

    let cpuTicksSavedThisFrame = 0;
    let gpuDrawsSavedThisFrame = 0;

    // 1. Process Ambient Emitters with Cell Lifecycle Gating
    for (let i = 0; i < emitters.length; i++) {
      const em = emitters[i];
      if (!em.enabled) {
        stats.skippedEmitters++;
        continue;
      }
      const ci = em.cellIndex >= 0 ? em.cellIndex : (em.cellIndex = cells.indexAt(em.x, em.z));
      const cellState = ci >= 0 ? cells.states[ci] : CELL_STATES.DORMANT;

      if (!CELL_AMBIENT_FX[cellState]) {
        stats.skippedEmitters++;
        if (cellState === CELL_STATES.DORMANT) stats.dormantEmitters++;
        cpuTicksSavedThisFrame++;
        continue;
      }

      const cadenceScale = CELL_AMBIENT_SCALE[cellState];
      if (cellState === CELL_STATES.ACTIVE) {
        stats.activeEmitters++;
      } else {
        stats.visibleEmitters++;
      }

      em.acc += dt * cadenceScale;
      while (em.acc >= em.interval) {
        em.acc -= em.interval;
        stats.particlesEmitted += em.burstSize;
        if (fxSystem && typeof fxSystem.emit === "function") {
          const vx = typeof em.vel === "function" ? em.vel(0) : em.vel[0];
          const vy = typeof em.vel === "function" ? em.vel(1) : em.vel[1];
          const vz = typeof em.vel === "function" ? em.vel(2) : em.vel[2];
          const poolName = (em.kind === "chimney" || em.kind === "ash") ? "smoke" : em.kind;
          fxSystem.emit(poolName, {
            origin: [em.x, em.y, em.z],
            vel: [vx, vy, vz],
            col0: em.color0,
            col1: em.color1,
            size0: em.size0,
            size1: em.size1,
            life: em.life,
            drag: em.drag,
            grav: em.grav,
            alpha: em.alpha,
          });
        }
      }
    }

    // 2. Process Decorative Particle Zones with Cell Lifecycle Gating
    for (let i = 0; i < decorativeZones.length; i++) {
      const zone = decorativeZones[i];
      if (!zone.enabled) continue;

      let highestState = CELL_STATES.DORMANT;
      for (let j = 0; j < zone.coveringCells.length; j++) {
        const cState = cells.states[zone.coveringCells[j]];
        if (cState < highestState) highestState = cState;
        if (highestState === CELL_STATES.ACTIVE) break;
      }

      if (!CELL_AMBIENT_FX[highestState]) {
        cpuTicksSavedThisFrame += zone.count;
        continue;
      }

      stats.activeDecorativeZones++;
      const cadenceScale = CELL_AMBIENT_SCALE[highestState];
      zone.acc += dt * cadenceScale;
      if (fxSystem && typeof fxSystem.emit === "function" && zone.acc >= 1.0) {
        zone.acc -= 1.0;
        const poolName = zone.kind === "snowFlurries" ? "debris"
          : (zone.kind === "sandDrift" ? "dust" : "sparks");
        stats.particlesEmitted++;
        const angle = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * zone.r;
        fxSystem.emit(poolName, {
          origin: [zone.x + Math.cos(angle) * rad, zone.y + (rng() - 0.5) * 2, zone.z + Math.sin(angle) * rad],
          vel: [zone.drift[0] + (rng() - 0.5) * 0.2, zone.drift[1], zone.drift[2] + (rng() - 0.5) * 0.2],
          col0: zone.color0,
          col1: zone.color1,
          size0: zone.size,
          size1: zone.size * 1.5,
          life: zone.life,
        });
      }
    }

    // 3. Process Terrain Auxiliary Meshes (hide in DORMANT cells to save GPU draws)
    for (let i = 0; i < auxiliaryMeshes.length; i++) {
      const aux = auxiliaryMeshes[i];
      const ci = aux.cellIndex >= 0 ? aux.cellIndex : (aux.cellIndex = cells.indexAt(aux.x, aux.z));
      const cellState = ci >= 0 ? cells.states[ci] : CELL_STATES.DORMANT;
      const isVisible = aux.enabled && (aux.hideWhenDormant ? CELL_AUXILIARY_VISIBLE[cellState] : true);

      if (isVisible) {
        stats.visibleAuxMeshes++;
        if (aux.mesh) {
          aux.mesh.visible = true;
          if (aux.mesh.castShadow !== undefined && aux.castShadow) {
            aux.mesh.castShadow = CELL_SHADOW[cellState];
          }
        }
      } else {
        stats.dormantAuxMeshes++;
        gpuDrawsSavedThisFrame++;
        if (aux.mesh) {
          aux.mesh.visible = false;
        }
      }
    }

    // 4. Process Distant Scenery Layers (LOD / visibility gating)
    for (let i = 0; i < sceneryLayers.length; i++) {
      const scenery = sceneryLayers[i];
      if (!scenery.enabled) continue;
      const ci = scenery.cellIndex >= 0 ? scenery.cellIndex : (scenery.cellIndex = cells.indexAt(scenery.x, scenery.z));
      const cellState = ci >= 0 ? cells.states[ci] : CELL_STATES.DISTANT;
      const targetLod = CELL_SCENERY_LOD[cellState];
      if (scenery.activeLod !== targetLod) {
        scenery.activeLod = targetLod;
        if (scenery.object && scenery.lods && scenery.lods[targetLod]) {
          if (scenery.object.geometry && scenery.lods[targetLod].geometry) {
            scenery.object.geometry = scenery.lods[targetLod].geometry;
          }
        }
      }
    }

    stats.cpuTicksSaved += cpuTicksSavedThisFrame;
    stats.gpuDrawsSaved += gpuDrawsSavedThisFrame;
    stats.version = version;
    return stats;
  }

  /** Reset state for match restarts / rematches. */
  function reset() {
    for (let i = 0; i < emitters.length; i++) emitters[i].acc = 0;
    for (let i = 0; i < decorativeZones.length; i++) decorativeZones[i].acc = 0;
    for (let i = 0; i < auxiliaryMeshes.length; i++) {
      if (auxiliaryMeshes[i].mesh) auxiliaryMeshes[i].mesh.visible = true;
    }
    stats.particlesEmitted = 0;
    stats.cpuTicksSaved = 0;
    stats.gpuDrawsSaved = 0;
    version++;
  }

  function getStats() {
    return { ...stats };
  }

  return {
    cells,
    emitters,
    decorativeZones,
    auxiliaryMeshes,
    sceneryLayers,
    get version() { return version; },
    get updateCount() { return updateCount; },
    registerEmitter,
    registerDecorativeZone,
    registerAuxiliaryMesh,
    registerSceneryLayer,
    update,
    reset,
    getStats,
  };
}
