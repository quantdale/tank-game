// Sliced streaming twins of terrain.js's private chunk builders. terrain.js
// builds a chunk's fine grid (~9.8k height samples) and its LOD geometry in
// one synchronous gulp inside updateLOD — a multi-millisecond stall in live
// combat frames. This module decomposes the exact same construction into
// per-row steps so a scheduler can spend a bounded time slice per frame and
// finish the job over several frames instead.
//
// FAITHFUL-TWIN CONTRACT: the loops below mirror terrain.js's buildFineGrid /
// buildChunkGeometry line for line (same sample coords, same normal formula,
// same skirt/index layout), so a sliced build is byte-identical to the
// monolithic one. If terrain.js's builders change, change these together —
// the scheduler selftest pins vertex heights against getHeightAt to catch
// drift. Pure Node-runnable except for the final THREE.BufferGeometry wrap.

import * as THREE from 'three';

// Pinned to terrain.js's chunk constants (CHUNKS/CHUNK_SIZE/LOD_SEGS/
// FINE_SEGS/SKIRT_DROP). Keep in sync — see the faithful-twin note above.
export const TERRAIN_CHUNKS = 8;
export const TERRAIN_CHUNK_SIZE = 1024 / TERRAIN_CHUNKS;
export const TERRAIN_LOD_SEGS = [96, 48, 24];
export const TERRAIN_FINE_SEGS = 96; // must equal TERRAIN_LOD_SEGS[0]
export const TERRAIN_SKIRT_DROP = 6.5;

/**
 * Row-sliced twin of terrain.js's buildFineGrid: one step() bakes one row of
 * the (FINE_SEGS+3)^2 height grid, ~99 height samples, so the ~6 ms bake is
 * spread across ~99 budgeted slices instead of landing in a single frame.
 */
export function createFineGridBaker(heightField, cx0, cz0) {
  const stepF = TERRAIN_CHUNK_SIZE / TERRAIN_FINE_SEGS;
  const pn = TERRAIN_FINE_SEGS + 3; // +1 vertex row, +2 padding rows
  const hgrid = new Float64Array(pn * pn);
  let row = 0;
  return {
    rows: pn,
    step() {
      const gz = row++;
      for (let gx = 0; gx < pn; gx++) {
        hgrid[gz * pn + gx] =
          heightField.getHeightAt(cx0 + (gx - 1) * stepF, cz0 + (gz - 1) * stepF);
      }
    },
    result() { return { hgrid, pn, stepF }; },
  };
}

/**
 * Row-sliced twin of terrain.js's buildChunkGeometry. The height-independent
 * index buffer is filled once at creation; each step() fills one vertex row
 * (positions + central-difference normals) exactly as the monolithic loop
 * does; finish() adds the outward-down skirt and wraps a BufferGeometry.
 * Callers must fully bake `fine` before stepping when it is provided — the
 * normal sampling reads neighbouring fine rows.
 */
export function createChunkGeometryBuilder(heightField, cx0, cz0, segs, fine) {
  const n = segs + 1, step = TERRAIN_CHUNK_SIZE / segs;
  const stride = TERRAIN_FINE_SEGS / segs;
  const hgrid = fine ? fine.hgrid : null;
  const pn = fine ? fine.pn : 0;
  const stepF = fine ? fine.stepF : TERRAIN_CHUNK_SIZE / TERRAIN_FINE_SEGS;
  const perim = 4 * segs;
  const vcount = n * n + perim;
  const pos = new Float32Array(vcount * 3);
  const nrm = new Float32Array(vcount * 3);
  const inv2e = 1 / (2 * stepF);
  // perimeter vertex indices in ring order (S, E, N, W edges) — pure topology
  const ring = [];
  for (let gx = 0; gx < segs; gx++) ring.push(gx);                       // z=min, x asc
  for (let gz = 0; gz < segs; gz++) ring.push(gz * n + (n - 1));         // x=max, z asc
  for (let gx = segs; gx > 0; gx--) ring.push((n - 1) * n + gx);         // z=max, x desc
  for (let gz = segs; gz > 0; gz--) ring.push(gz * n);                   // x=min, z desc
  const idx = new Uint32Array(segs * segs * 6 + perim * 6);
  let ii = 0;
  for (let gz = 0; gz < segs; gz++) for (let gx = 0; gx < segs; gx++) {
    const a = gz * n + gx, b = a + 1, c = a + n, d = c + 1;
    idx[ii++] = a; idx[ii++] = c; idx[ii++] = b;
    idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
  }
  for (let k = 0; k < perim; k++) {
    const t0 = ring[k], t1 = ring[(k + 1) % perim];
    const s0 = n * n + k, s1 = n * n + ((k + 1) % perim);
    idx[ii++] = t0; idx[ii++] = s0; idx[ii++] = t1;
    idx[ii++] = t1; idx[ii++] = s0; idx[ii++] = s1;
  }
  let row = 0;
  return {
    rows: n,
    step() {
      const gz = row++;
      for (let gx = 0; gx < n; gx++) {
        const wx = cx0 + gx * step, wz = cz0 + gz * step;
        const fi = hgrid ? (gz * stride + 1) * pn + (gx * stride + 1) : 0;
        const h = hgrid ? hgrid[fi] : heightField.getHeightAt(wx, wz);
        pos[(gz * n + gx) * 3] = wx;
        pos[(gz * n + gx) * 3 + 1] = h;
        pos[(gz * n + gx) * 3 + 2] = wz;
        const hl = hgrid ? hgrid[fi - 1] : heightField.getHeightAt(wx - stepF, wz);
        const hr = hgrid ? hgrid[fi + 1] : heightField.getHeightAt(wx + stepF, wz);
        const hd = hgrid ? hgrid[fi - pn] : heightField.getHeightAt(wx, wz - stepF);
        const hu = hgrid ? hgrid[fi + pn] : heightField.getHeightAt(wx, wz + stepF);
        const nx = (hl - hr) * inv2e, nz = (hd - hu) * inv2e;
        const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        const vi = (gz * n + gx) * 3;
        nrm[vi] = nx * il; nrm[vi + 1] = il; nrm[vi + 2] = nz * il;
      }
    },
    finish() {
      // content_breadth r3 skirt: normals point OUTWARD-DOWN so a crack-
      // revealed skirt shades as a dark seam, not sunlit flat ground (see
      // terrain.js for the full artifact history).
      const ccx = cx0 + TERRAIN_CHUNK_SIZE / 2, ccz = cz0 + TERRAIN_CHUNK_SIZE / 2;
      for (let k = 0; k < perim; k++) {
        const src = ring[k], dst = n * n + k;
        pos[dst * 3] = pos[src * 3];
        pos[dst * 3 + 1] = pos[src * 3 + 1] - TERRAIN_SKIRT_DROP;
        pos[dst * 3 + 2] = pos[src * 3 + 2];
        let ox = pos[src * 3] - ccx, oz = pos[src * 3 + 2] - ccz;
        const ol = Math.hypot(ox, oz) || 1;
        ox /= ol; oz /= ol;
        // outward + strong down bias: crack-revealed skirts read as shaded seams
        const oy = -0.55, oil = 1 / Math.hypot(ox, oy, oz);
        nrm[dst * 3] = ox * oil; nrm[dst * 3 + 1] = oy * oil; nrm[dst * 3 + 2] = oz * oil;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      return geo;
    },
  };
}
