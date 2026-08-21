import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PROP_CELL_M, planPropCells, buildCellPool } from './propCellPools.js';

// ---------------------------------------------------------------------------
// SA-06: static-prop cell-local pooling. Pure grouping logic plus headless
// BatchedMesh assembly (no renderer — three constructs BatchedMesh in Node).
// ---------------------------------------------------------------------------

function boxAt(x, z, w = 4, d = 4, h = 3) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, h / 2, z);
  return geo;
}

// 1. Grouping: geometries land in the cell of their bounding-box center;
// cells emit in ascending (cz, cx) order regardless of input order.
{
  const a = boxAt(10, 10); // cell (0, 0)
  const b = boxAt(300, -50); // cell (2, -1)
  const c = boxAt(-200, 640); // cell (-2, 5)
  const plan = planPropCells([c, a, b]);
  assert.equal(plan.cellSizeM, PROP_CELL_M, 'default cell edge is the lifecycle grid edge');
  assert.deepEqual(plan.cells.map((cell) => [cell.cx, cell.cz]),
    [[2, -1], [0, 0], [-2, 5]], 'cells sort by ascending (cz, cx) and carry each center');
  assert.deepEqual(plan.cells[0].geos, [b], 'geometry keeps its input order inside a cell');
}
console.log('propCellPools.selftest: grouping + deterministic cell order');

// 2. Repeated planning of the same bucket is byte-stable (seeded builds must
// always pool identically).
{
  const geos = Array.from({ length: 12 }, (_, i) => boxAt((i * 97) % 900 - 450, (i * 211) % 900 - 450));
  const planA = planPropCells(geos);
  const planB = planPropCells(geos);
  assert.deepEqual(
    planA.cells.map((cell) => [cell.key, cell.geos.length]),
    planB.cells.map((cell) => [cell.key, cell.geos.length]),
    'repeated plans are identical');
  const total = planA.cells.reduce((sum, cell) => sum + cell.geos.length, 0);
  assert.equal(total, geos.length, 'every geometry lands in exactly one cell');
}
console.log('propCellPools.selftest: repeated plans are stable and total-preserving');

// 3. Single-cell buckets stay plain merged Meshes (the old whole-map path).
{
  const geos = [boxAt(5, 5), boxAt(20, 30), boxAt(60, 90)];
  const material = new THREE.MeshStandardMaterial();
  const pool = buildCellPool(geos, material, { name: 'props-test' });
  assert.equal(pool.kind, 'mesh', 'one-cell bucket pools into a plain Mesh');
  assert.ok(pool.object.isMesh && !pool.object.isBatchedMesh, 'single-cell object is a Mesh');
  assert.equal(pool.object.name, 'props-test');
  assert.equal(pool.object.castShadow, true, 'mesh casts shadows like the old merge');
  assert.equal(pool.object.receiveShadow, true, 'mesh receives shadows');
  assert.equal(pool.object.matrixAutoUpdate, false, 'static world skips matrix updates');
  assert.ok(pool.object.geometry.attributes.position.count > 0, 'merged geometry has vertices');
}
console.log('propCellPools.selftest: single-cell buckets stay plain Meshes');

// 4. Multi-cell buckets become one BatchedMesh with one identity instance per
// cell, preserving world-space placement in its combined bounds.
{
  const near = boxAt(10, 10);
  const far = boxAt(500, 500);
  const material = new THREE.MeshStandardMaterial();
  const pool = buildCellPool([near, far], material, { name: 'props-spread' });
  assert.equal(pool.kind, 'batched', 'multi-cell bucket pools into a BatchedMesh');
  const batch = pool.object;
  assert.ok(batch.isBatchedMesh, 'object reports isBatchedMesh for renderer/probes');
  assert.equal(batch.instanceCount, 2, 'one instance per occupied cell');
  assert.equal(batch.maxInstanceCount, 2, 'instance capacity matches the cell count');
  assert.equal(batch.name, 'props-spread');
  assert.equal(batch.sortObjects, false, 'opaque static world skips per-frame depth sort');
  assert.equal(batch.castShadow, true, 'batch casts shadows');
  assert.equal(batch.receiveShadow, true, 'batch receives shadows');
  batch.computeBoundingSphere();
  const sphere = batch.boundingSphere;
  for (const [x, z] of [[10, 10], [500, 500]]) {
    const point = new THREE.Vector3(x, 1.5, z);
    assert.ok(sphere.containsPoint(point),
      `world-space placement survives pooling (${x}, ${z} inside batch bounds)`);
  }
  // identity instance matrices: vertices are authored world-space
  const m = new THREE.Matrix4();
  for (let i = 0; i < 2; i++) {
    batch.getMatrixAt(i, m);
    assert.ok(m.equals(new THREE.Matrix4()), `instance ${i} rides an identity matrix`);
  }
}
console.log('propCellPools.selftest: multi-cell buckets batch with identity instances');

// 5. Mixed indexed/non-indexed bucket content normalizes without throwing
// (ExtrudeGeometry is non-indexed; BoxGeometry is indexed — the exact mix the
// building buckets carry).
{
  const shape = new THREE.Shape();
  shape.moveTo(-1, 0);
  shape.lineTo(1, 0);
  shape.lineTo(0, 1);
  shape.closePath();
  const gable = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false });
  gable.translate(60, 0, 60); // merges into the first box's cell — mixed content per range
  const farGable = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false });
  farGable.translate(600, 0, 100);
  const pool = buildCellPool([boxAt(10, 10), gable, boxAt(700, 700), farGable],
    new THREE.MeshStandardMaterial(), { name: 'props-mixed' });
  assert.equal(pool.kind, 'batched', 'mixed indexing still batches across cells');
  assert.equal(pool.object.instanceCount, 3, 'each occupied cell becomes one range');
}
console.log('propCellPools.selftest: mixed indexed/non-indexed content normalizes');

console.log('propCellPools.selftest: grouping, stability, mesh/batched selection, '
  + 'world-space preservation, and mixed-index normalization passed');
