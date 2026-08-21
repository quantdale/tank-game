/**
 * GPU-resident resource budgets and deterministic scene disposal.
 *
 * Phones need lifetime limits in addition to smaller individual textures.
 * A hidden Object3D still owns every WebGL buffer/texture it has uploaded, so
 * merely setting `visible = false` does not protect the browser from reclaiming
 * the context after several map or showroom switches.
 */

const LIMITS = Object.freeze({
  desktop: Object.freeze({ pedestalVisuals: 6, worldScenes: Infinity }),
  mobile: Object.freeze({ pedestalVisuals: 2, worldScenes: 1 }),
});

/** @returns {{pedestalVisuals:number, worldScenes:number}} */
export function residentResourceLimits(tier) {
  return LIMITS[tier === 'mobile' ? 'mobile' : 'desktop'];
}

function collectMaterialTextures(material, out) {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value?.isTexture) out.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (item?.isTexture) out.add(item);
    }
  }
  for (const uniform of Object.values(material.uniforms || {})) {
    const value = uniform?.value;
    if (value?.isTexture) out.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (item?.isTexture) out.add(item);
    }
  }
}

function collectTreeResources(root, bag) {
  if (!root?.traverse) return;
  root.traverse((object) => collectObjectResources(object, bag));
}

function collectObjectResources(object, bag) {
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
    if (object.shadow.map) bag.textures.add(object.shadow.map);
    if (object.shadow.mapPass) bag.textures.add(object.shadow.mapPass);
  }
}

/**
 * Detach a scene subtree and release resources not referenced by preserved
 * roots. Shared materials/textures used by the active world or garage remain
 * live; disposed Three resources may still be lazily re-uploaded if a module
 * cache later reuses their JS object.
 *
 * @param {import('three').Object3D} root
 * @param {{preserveRoots?: import('three').Object3D[]}} [opts]
 * @returns {{objects:number, geometries:number, materials:number, textures:number}}
 */
export function disposeObject3DResources(root, { preserveRoots = [] } = {}) {
  const keep = { geometries: new Set(), materials: new Set(), textures: new Set() };
  for (const preserveRoot of preserveRoots) collectTreeResources(preserveRoot, keep);

  const owned = { geometries: new Set(), materials: new Set(), textures: new Set() };
  let objects = 0;
  if (root?.traverse) {
    root.traverse((object) => {
      objects += 1;
      collectObjectResources(object, owned);
      // Batched/instanced meshes may own private GPU textures that are not
      // reachable through `material` (matrices, visibility, morph data).
      if ((object.isBatchedMesh || object.isInstancedMesh) && typeof object.dispose === 'function') {
        object.dispose();
      }
    });
  }

  root?.removeFromParent?.();
  let geometries = 0;
  for (const geometry of owned.geometries) {
    if (keep.geometries.has(geometry)) continue;
    geometry.dispose?.();
    geometries += 1;
  }
  let materials = 0;
  for (const material of owned.materials) {
    if (keep.materials.has(material)) continue;
    material.dispose?.();
    materials += 1;
  }
  let textures = 0;
  for (const texture of owned.textures) {
    if (keep.textures.has(texture)) continue;
    texture.dispose?.();
    textures += 1;
  }
  return { objects, geometries, materials, textures };
}
