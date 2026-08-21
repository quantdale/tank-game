// src/world/propCellPools.js — SA-06 static-prop cell-local BatchedMesh pools.
//
// The static prop buckets (building/wall/dressing geometry authored in world
// space) used to merge into ONE mesh per material family covering the whole
// map: a single bounding volume frustum culling can never reject, so every
// village/wall fragment rendered in full on every main + shadow pass.
//
// This module groups each bucket's geometries into 128 m world cells (the
// same partition as cellLifecycle.js, terrain chunks and vegetation chunks)
// and hands back either:
//   - a plain THREE.Mesh when the bucket occupies exactly one cell (byte-for-
//     byte the old whole-map merge — zero added overhead), or
//   - one THREE.BatchedMesh per material holding one merged geometry per
//     cell: still ONE draw call per material family, but the renderer's
//     per-object frustum culling now rejects whole off-screen cells inside
//     that draw call (BatchedMesh perObjectFrustumCulled; without the
//     WEBGL_multi_draw extension three r185 falls back to sequential
//     per-range draws, so the representation is safe everywhere).
//
// planPropCells is pure grouping logic, Node-verifiable without WebGL;
// buildCellPool only touches THREE classes that construct headlessly.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Cell edge shared with the world-cell lifecycle grid (cellLifecycle.js). */
export const PROP_CELL_M = 128;

const _box = new THREE.Box3();
const _center = new THREE.Vector3();

/**
 * Group world-space geometries into cells by bounding-box center.
 * Deterministic: cells emit in ascending (cz, cx) order and geometries keep
 * their input order inside a cell, so identical bucket contents always plan
 * identically (props placement is seeded).
 * @param {THREE.BufferGeometry[]} geos world-space geometries
 * @param {number} [cellSizeM] cell edge in meters
 * @returns {{cells: Array<{cx:number, cz:number, key:string,
 *   geos:THREE.BufferGeometry[]}>, cellSizeM:number}}
 */
export function planPropCells(geos, cellSizeM = PROP_CELL_M) {
  const byKey = new Map();
  for (let i = 0; i < geos.length; i++) {
    const geo = geos[i];
    geo.computeBoundingBox(); // recomputes from positions; authors translate freely
    _box.copy(geo.boundingBox).getCenter(_center);
    const cx = Math.floor(_center.x / cellSizeM);
    const cz = Math.floor(_center.z / cellSizeM);
    const key = cx + ',' + cz;
    let cell = byKey.get(key);
    if (!cell) {
      cell = { cx, cz, key, geos: [] };
      byKey.set(key, cell);
    }
    cell.geos.push(geo);
  }
  const cells = [...byKey.values()].sort((a, b) => (a.cz - b.cz) || (a.cx - b.cx));
  return { cells, cellSizeM };
}

/**
 * Pool one material bucket's static geometry into its cell-local render
 * object. Single-cell buckets return a plain merged Mesh (the previous
 * behavior); multi-cell buckets return one BatchedMesh with one identity-
 * matrix instance per cell-merged geometry range.
 * @param {THREE.BufferGeometry[]} bucketGeos world-space geometries (non-empty)
 * @param {THREE.Material} material shared bucket material
 * @param {{name?: string, cellSizeM?: number}} [opts]
 * @returns {{object: THREE.Mesh|THREE.BatchedMesh, kind: 'mesh'|'batched',
 *   cells: Array<object>}}
 */
export function buildCellPool(bucketGeos, material, opts = {}) {
  const { cells } = planPropCells(bucketGeos, opts.cellSizeM);
  // Same normalization contract as the previous whole-map merge:
  // mergeGeometries requires uniform indexing (ExtrudeGeometry is
  // non-indexed), and BatchedMesh additionally requires every entry to share
  // one attribute layout — toNonIndexed on everything satisfies both.
  const cellGeos = cells.map((cell) => mergeGeometries(
    cell.geos.map((g) => (g.index ? g.toNonIndexed() : g)), false));
  const name = opts.name || 'props-pool';
  if (cellGeos.length === 1) {
    const mesh = new THREE.Mesh(cellGeos[0], material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return { object: mesh, kind: 'mesh', cells };
  }
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of cellGeos) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : 0;
  }
  const batch = new THREE.BatchedMesh(
    cellGeos.length, vertexCount, Math.max(indexCount, 1), material);
  batch.name = name;
  batch.castShadow = true;
  batch.receiveShadow = true;
  batch.matrixAutoUpdate = false;
  batch.sortObjects = false; // opaque static world — skip the per-frame depth sort
  // Vertices are authored in world space, so every instance rides an identity
  // matrix; addInstance seeds exactly that.
  for (const g of cellGeos) batch.addInstance(batch.addGeometry(g));
  batch.computeBoundingSphere();
  return { object: batch, kind: 'batched', cells };
}
