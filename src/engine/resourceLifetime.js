/**
 * GPU-resident resource budgets, deterministic scene disposal, and runtime leak tracking.
 *
 * Phones need lifetime limits in addition to smaller individual textures.
 * A hidden Object3D still owns every WebGL buffer/texture it has uploaded, so
 * merely setting `visible = false` does not protect the browser from reclaiming
 * the context after several map or showroom switches.
 *
 * Provides resource lifetime tracking, deterministic disposal, and leak auditing
 * across application lifecycle phases (Boot -> Garage -> Battle -> Garage -> Battle -> Map Switch -> Battle -> Studio -> Garage -> Battle).
 */
import * as THREE from 'three';

const LIMITS = Object.freeze({
  desktop: Object.freeze({ pedestalVisuals: 6, worldScenes: Infinity }),
  mobile: Object.freeze({ pedestalVisuals: 2, worldScenes: 1 }),
});

/** @returns {{pedestalVisuals:number, worldScenes:number}} */
export function residentResourceLimits(tier) {
  return LIMITS[tier === 'mobile' ? 'mobile' : 'desktop'];
}

export function collectMaterialTextures(material, out) {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value?.isTexture) out.add(value);
    else if (value?.isWebGLRenderTarget && value?.texture) out.add(value.texture);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (item?.isTexture) out.add(item);
        else if (item?.isWebGLRenderTarget && item?.texture) out.add(item.texture);
      }
    }
  }
  for (const uniform of Object.values(material.uniforms || {})) {
    const value = uniform?.value;
    if (value?.isTexture) out.add(value);
    else if (value?.isWebGLRenderTarget && value?.texture) out.add(value.texture);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (item?.isTexture) out.add(item);
        else if (item?.isWebGLRenderTarget && item?.texture) out.add(item.texture);
      }
    } else if (value && typeof value === 'object' && !value.isVector2 && !value.isVector3 && !value.isVector4 && !value.isMatrix3 && !value.isMatrix4 && !value.isColor) {
      for (const nested of Object.values(value)) {
        if (nested?.isTexture) out.add(nested);
        else if (nested?.isWebGLRenderTarget && nested?.texture) out.add(nested.texture);
      }
    }
  }
}

export function collectObjectResources(object, bag) {
  if (object.geometry) bag.geometries.add(object.geometry);
  const materials = Array.isArray(object.material)
    ? object.material : (object.material ? [object.material] : []);
  for (const material of materials) {
    bag.materials.add(material);
    collectMaterialTextures(material, bag.textures);
  }
  if (object.skeleton?.boneTexture) bag.textures.add(object.skeleton.boneTexture);
  // Shadow maps are GPU render targets hung OFF the light, not children — a
  // traverse alone never sees them, so an evicted subtree's light would keep
  // its depth/VSM target resident until the context dies.
  if (object.isLight && object.shadow) {
    if (object.shadow.map) {
      if (bag.renderTargets) bag.renderTargets.add(object.shadow.map);
      if (bag.shadowMaps) bag.shadowMaps.add(object.shadow.map);
      bag.textures.add(object.shadow.map);
      if (object.shadow.map.texture) bag.textures.add(object.shadow.map.texture);
    }
    if (object.shadow.mapPass) {
      if (bag.renderTargets) bag.renderTargets.add(object.shadow.mapPass);
      if (bag.shadowMaps) bag.shadowMaps.add(object.shadow.mapPass);
      bag.textures.add(object.shadow.mapPass);
      if (object.shadow.mapPass.texture) bag.textures.add(object.shadow.mapPass.texture);
    }
  }
  if (object.userData?.renderTarget && bag.renderTargets) {
    bag.renderTargets.add(object.userData.renderTarget);
  }
}

export function collectTreeResources(root, bag) {
  if (!root?.traverse) return;
  root.traverse((object) => collectObjectResources(object, bag));
}

/**
 * Detach a scene subtree and release resources not referenced by preserved
 * roots. Shared materials/textures used by the active world or garage remain
 * live; disposed Three resources may still be lazily re-uploaded if a module
 * cache later reuses their JS object.
 *
 * @param {import('three').Object3D} root
 * @param {{preserveRoots?: import('three').Object3D[], onDispose?: (type: string, res: any) => void}} [opts]
 * @returns {{objects:number, geometries:number, materials:number, textures:number, renderTargets:number, shadowMaps:number}}
 */
export function disposeObject3DResources(root, { preserveRoots = [], onDispose = null } = {}) {
  const keep = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
    renderTargets: new Set(),
    shadowMaps: new Set(),
  };
  for (const preserveRoot of preserveRoots) collectTreeResources(preserveRoot, keep);

  const owned = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
    renderTargets: new Set(),
    shadowMaps: new Set(),
  };
  let objects = 0;
  if (root?.traverse) {
    root.traverse((object) => {
      objects += 1;
      collectObjectResources(object, owned);
      // Batched/instanced meshes may own private GPU textures that are not
      // reachable through `material` (matrices, visibility, morph data).
      if ((object.isBatchedMesh || object.isInstancedMesh) && typeof object.dispose === 'function') {
        object.dispose();
        onDispose?.('instancedOrBatched', object);
      }
    });
  }

  root?.removeFromParent?.();
  let geometries = 0;
  for (const geometry of owned.geometries) {
    if (keep.geometries.has(geometry)) continue;
    geometry.dispose?.();
    onDispose?.('geometry', geometry);
    geometries += 1;
  }
  let materials = 0;
  for (const material of owned.materials) {
    if (keep.materials.has(material)) continue;
    material.dispose?.();
    onDispose?.('material', material);
    materials += 1;
  }
  let textures = 0;
  for (const texture of owned.textures) {
    if (keep.textures.has(texture)) continue;
    texture.dispose?.();
    onDispose?.('texture', texture);
    textures += 1;
  }
  let renderTargets = 0;
  for (const rt of owned.renderTargets) {
    if (keep.renderTargets.has(rt)) continue;
    if (!owned.textures.has(rt)) rt.dispose?.();
    onDispose?.('renderTarget', rt);
    renderTargets += 1;
  }
  let shadowMaps = 0;
  for (const sm of owned.shadowMaps) {
    if (keep.shadowMaps.has(sm)) continue;
    onDispose?.('shadowMap', sm);
    shadowMaps += 1;
  }

  return { objects, geometries, materials, textures, renderTargets, shadowMaps };
}

/**
 * Traverses an Object3D hierarchy and returns full catalog of attached GPU resources.
 */
export function auditSceneResources(root) {
  const catalog = {
    objects: 0,
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
    renderTargets: new Set(),
    shadowMaps: new Set(),
    instancedOrBatched: new Set(),
    lights: new Set(),
  };

  if (root?.traverse) {
    root.traverse((object) => {
      catalog.objects++;
      collectObjectResources(object, catalog);
      if (object.isLight) catalog.lights.add(object);
      if (object.isBatchedMesh || object.isInstancedMesh) catalog.instancedOrBatched.add(object);
    });
  }

  return {
    objects: catalog.objects,
    geometries: catalog.geometries.size,
    materials: catalog.materials.size,
    textures: catalog.textures.size,
    renderTargets: catalog.renderTargets.size,
    shadowMaps: catalog.shadowMaps.size,
    instancedOrBatched: catalog.instancedOrBatched.size,
    lights: catalog.lights.size,
    rawSets: catalog,
  };
}

/**
 * Creates a ResourceLifetimeTracker instance for monitoring, tracking, and auditing
 * GPU resources, DOM event listeners, timers/intervals, and web workers across lifecycles.
 */
export function createResourceTracker(options = {}) {
  const activeResources = {
    textures: new Set(),
    geometries: new Set(),
    materials: new Set(),
    renderTargets: new Set(),
    shadowMaps: new Set(),
    eventListeners: new Set(),
    timers: new Set(),
    workers: new Set(),
  };

  const cumulativeCounts = {
    allocatedTextures: 0,
    disposedTextures: 0,
    allocatedGeometries: 0,
    disposedGeometries: 0,
    allocatedMaterials: 0,
    disposedMaterials: 0,
    allocatedRenderTargets: 0,
    disposedRenderTargets: 0,
    allocatedShadowMaps: 0,
    disposedShadowMaps: 0,
    registeredListeners: 0,
    unregisteredListeners: 0,
    createdTimers: 0,
    clearedTimers: 0,
    spawnedWorkers: 0,
    terminatedWorkers: 0,
  };

  const scopeRegistrations = new Map();

  function getOrCreateScopeBag(scope) {
    if (!scope) return null;
    let bag = scopeRegistrations.get(scope);
    if (!bag) {
      bag = { eventListeners: new Set(), timers: new Set(), workers: new Set() };
      scopeRegistrations.set(scope, bag);
    }
    return bag;
  }

  function trackTexture(tex, meta = {}) {
    if (!tex) return tex;
    if (!activeResources.textures.has(tex)) {
      activeResources.textures.add(tex);
      cumulativeCounts.allocatedTextures++;
      const onDispose = () => {
        if (activeResources.textures.has(tex)) {
          activeResources.textures.delete(tex);
          cumulativeCounts.disposedTextures++;
        }
        tex.removeEventListener?.('dispose', onDispose);
      };
      tex.addEventListener?.('dispose', onDispose);
    }
    return tex;
  }

  function trackGeometry(geo, meta = {}) {
    if (!geo) return geo;
    if (!activeResources.geometries.has(geo)) {
      activeResources.geometries.add(geo);
      cumulativeCounts.allocatedGeometries++;
      const onDispose = () => {
        if (activeResources.geometries.has(geo)) {
          activeResources.geometries.delete(geo);
          cumulativeCounts.disposedGeometries++;
        }
        geo.removeEventListener?.('dispose', onDispose);
      };
      geo.addEventListener?.('dispose', onDispose);
    }
    return geo;
  }

  function trackMaterial(mat, meta = {}) {
    if (!mat) return mat;
    if (!activeResources.materials.has(mat)) {
      activeResources.materials.add(mat);
      cumulativeCounts.allocatedMaterials++;
      const onDispose = () => {
        if (activeResources.materials.has(mat)) {
          activeResources.materials.delete(mat);
          cumulativeCounts.disposedMaterials++;
        }
        mat.removeEventListener?.('dispose', onDispose);
      };
      mat.addEventListener?.('dispose', onDispose);
    }
    return mat;
  }

  function trackRenderTarget(rt, meta = {}) {
    if (!rt) return rt;
    if (!activeResources.renderTargets.has(rt)) {
      activeResources.renderTargets.add(rt);
      cumulativeCounts.allocatedRenderTargets++;
      const onDispose = () => {
        if (activeResources.renderTargets.has(rt)) {
          activeResources.renderTargets.delete(rt);
          cumulativeCounts.disposedRenderTargets++;
        }
        rt.removeEventListener?.('dispose', onDispose);
      };
      rt.addEventListener?.('dispose', onDispose);
      if (rt.texture) trackTexture(rt.texture, meta);
    }
    return rt;
  }

  function trackShadowMap(sm, meta = {}) {
    if (!sm) return sm;
    trackRenderTarget(sm, meta);
    if (!activeResources.shadowMaps.has(sm)) {
      activeResources.shadowMaps.add(sm);
      cumulativeCounts.allocatedShadowMaps++;
      const onDispose = () => {
        if (activeResources.shadowMaps.has(sm)) {
          activeResources.shadowMaps.delete(sm);
          cumulativeCounts.disposedShadowMaps++;
        }
        sm.removeEventListener?.('dispose', onDispose);
      };
      sm.addEventListener?.('dispose', onDispose);
    }
    return sm;
  }

  function trackEventListener(target, type, handler, options = null, scope = null) {
    if (!target || !type || !handler) return () => {};
    const record = { target, type, handler, options, scope };
    activeResources.eventListeners.add(record);
    cumulativeCounts.registeredListeners++;
    if (scope) {
      getOrCreateScopeBag(scope)?.eventListeners.add(record);
    }
    target.addEventListener?.(type, handler, options);

    let removed = false;
    const unbind = () => {
      if (removed) return;
      removed = true;
      target.removeEventListener?.(type, handler, options);
      if (activeResources.eventListeners.has(record)) {
        activeResources.eventListeners.delete(record);
        cumulativeCounts.unregisteredListeners++;
      }
      if (scope) {
        getOrCreateScopeBag(scope)?.eventListeners.delete(record);
      }
    };
    return unbind;
  }

  function trackTimeout(fn, delay = 0, scope = null) {
    let id = null;
    const record = { kind: 'timeout', id: null, scope, cleared: false };
    activeResources.timers.add(record);
    cumulativeCounts.createdTimers++;
    if (scope) getOrCreateScopeBag(scope)?.timers.add(record);

    id = setTimeout(() => {
      if (activeResources.timers.has(record)) {
        activeResources.timers.delete(record);
        if (scope) getOrCreateScopeBag(scope)?.timers.delete(record);
      }
      fn();
    }, delay);
    record.id = id;

    const clear = () => {
      if (record.cleared) return;
      record.cleared = true;
      clearTimeout(id);
      if (activeResources.timers.has(record)) {
        activeResources.timers.delete(record);
        cumulativeCounts.clearedTimers++;
        if (scope) getOrCreateScopeBag(scope)?.timers.delete(record);
      }
    };
    return { id, clear };
  }

  function trackInterval(fn, delay = 0, scope = null) {
    let id = null;
    const record = { kind: 'interval', id: null, scope, cleared: false };
    activeResources.timers.add(record);
    cumulativeCounts.createdTimers++;
    if (scope) getOrCreateScopeBag(scope)?.timers.add(record);

    id = setInterval(fn, delay);
    record.id = id;

    const clear = () => {
      if (record.cleared) return;
      record.cleared = true;
      clearInterval(id);
      if (activeResources.timers.has(record)) {
        activeResources.timers.delete(record);
        cumulativeCounts.clearedTimers++;
        if (scope) getOrCreateScopeBag(scope)?.timers.delete(record);
      }
    };
    return { id, clear };
  }

  function trackAnimationFrame(fn, scope = null) {
    let id = null;
    const record = { kind: 'rAF', id: null, scope, cleared: false };
    activeResources.timers.add(record);
    cumulativeCounts.createdTimers++;
    if (scope) getOrCreateScopeBag(scope)?.timers.add(record);

    const isBrowser = typeof requestAnimationFrame === 'function';
    const reqFn = isBrowser ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    const cancelFn = isBrowser ? cancelAnimationFrame : clearTimeout;

    id = reqFn((t) => {
      if (activeResources.timers.has(record)) {
        activeResources.timers.delete(record);
        if (scope) getOrCreateScopeBag(scope)?.timers.delete(record);
      }
      fn(t);
    });
    record.id = id;

    const clear = () => {
      if (record.cleared) return;
      record.cleared = true;
      cancelFn(id);
      if (activeResources.timers.has(record)) {
        activeResources.timers.delete(record);
        cumulativeCounts.clearedTimers++;
        if (scope) getOrCreateScopeBag(scope)?.timers.delete(record);
      }
    };
    return { id, clear };
  }

  function trackWorker(worker, scope = null) {
    if (!worker) return worker;
    const record = { worker, scope, terminated: false };
    activeResources.workers.add(record);
    cumulativeCounts.spawnedWorkers++;
    if (scope) getOrCreateScopeBag(scope)?.workers.add(record);

    const originalTerminate = worker.terminate?.bind(worker);
    if (originalTerminate) {
      worker.terminate = () => {
        if (!record.terminated) {
          record.terminated = true;
          activeResources.workers.delete(record);
          cumulativeCounts.terminatedWorkers++;
          if (scope) getOrCreateScopeBag(scope)?.workers.delete(record);
        }
        return originalTerminate();
      };
    }
    return worker;
  }

  function clearScope(scope) {
    if (!scope) return { listenersCleared: 0, timersCleared: 0, workersTerminated: 0 };
    const bag = scopeRegistrations.get(scope);
    if (!bag) return { listenersCleared: 0, timersCleared: 0, workersTerminated: 0 };

    let listenersCleared = 0;
    for (const record of [...bag.eventListeners]) {
      record.target.removeEventListener?.(record.type, record.handler, record.options);
      activeResources.eventListeners.delete(record);
      cumulativeCounts.unregisteredListeners++;
      listenersCleared++;
    }
    bag.eventListeners.clear();

    let timersCleared = 0;
    for (const record of [...bag.timers]) {
      if (record.kind === 'timeout') clearTimeout(record.id);
      else if (record.kind === 'interval') clearInterval(record.id);
      else if (record.kind === 'rAF') {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(record.id);
        else clearTimeout(record.id);
      }
      activeResources.timers.delete(record);
      cumulativeCounts.clearedTimers++;
      timersCleared++;
    }
    bag.timers.clear();

    let workersTerminated = 0;
    for (const record of [...bag.workers]) {
      if (!record.terminated) {
        record.terminated = true;
        record.worker?.terminate?.();
        activeResources.workers.delete(record);
        cumulativeCounts.terminatedWorkers++;
        workersTerminated++;
      }
    }
    bag.workers.clear();
    scopeRegistrations.delete(scope);

    return { listenersCleared, timersCleared, workersTerminated };
  }

  function takeSnapshot(name = 'snapshot') {
    return {
      name,
      timestamp: Date.now(),
      counts: {
        textures: activeResources.textures.size,
        geometries: activeResources.geometries.size,
        materials: activeResources.materials.size,
        renderTargets: activeResources.renderTargets.size,
        shadowMaps: activeResources.shadowMaps.size,
        eventListeners: activeResources.eventListeners.size,
        timers: activeResources.timers.size,
        workers: activeResources.workers.size,
      },
      cumulative: { ...cumulativeCounts },
    };
  }

  function compareSnapshots(before, after) {
    const diff = {
      textures: after.counts.textures - before.counts.textures,
      geometries: after.counts.geometries - before.counts.geometries,
      materials: after.counts.materials - before.counts.materials,
      renderTargets: after.counts.renderTargets - before.counts.renderTargets,
      shadowMaps: after.counts.shadowMaps - before.counts.shadowMaps,
      eventListeners: after.counts.eventListeners - before.counts.eventListeners,
      timers: after.counts.timers - before.counts.timers,
      workers: after.counts.workers - before.counts.workers,
    };
    const leaked = Object.values(diff).some((val) => val > 0);
    return {
      before: before.name,
      after: after.name,
      leaked,
      diff,
    };
  }

  function auditScopeLeaks(scopeName, beforeSnapshot, afterSnapshot) {
    const comparison = compareSnapshots(beforeSnapshot, afterSnapshot);
    return {
      scope: scopeName,
      passed: !comparison.leaked,
      leaked: comparison.leaked,
      diff: comparison.diff,
      details: comparison,
    };
  }

  function reset() {
    activeResources.textures.clear();
    activeResources.geometries.clear();
    activeResources.materials.clear();
    activeResources.renderTargets.clear();
    activeResources.shadowMaps.clear();
    activeResources.eventListeners.clear();
    activeResources.timers.clear();
    activeResources.workers.clear();
    scopeRegistrations.clear();
  }

  return {
    trackTexture,
    trackGeometry,
    trackMaterial,
    trackRenderTarget,
    trackShadowMap,
    trackEventListener,
    trackTimeout,
    trackInterval,
    trackAnimationFrame,
    trackWorker,
    clearScope,
    takeSnapshot,
    compareSnapshots,
    auditScopeLeaks,
    getCounts: () => ({
      textures: activeResources.textures.size,
      geometries: activeResources.geometries.size,
      materials: activeResources.materials.size,
      renderTargets: activeResources.renderTargets.size,
      shadowMaps: activeResources.shadowMaps.size,
      eventListeners: activeResources.eventListeners.size,
      timers: activeResources.timers.size,
      workers: activeResources.workers.size,
    }),
    getCumulative: () => ({ ...cumulativeCounts }),
    reset,
  };
}
