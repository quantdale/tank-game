import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { texSize } from '../engine/quality.js';

// ---------------------------------------------------------------------------
// WA6 selftest for src/world/sourcedTextures.js — map-load CPU on the sourced
// CC0 PBR composites. Two contracts are pinned here:
//
// 1. BYTE-GOLDEN: the optimized composer produces exactly the bytes the
//    pre-WA6 implementation produced (reference kept verbatim below), across
//    every option path (AO multiply, roughness packing, tint clamp, desat,
//    lift, missing-layer fallbacks).
// 2. RECOMPOSITION SHORT-CIRCUIT: revisiting a map (rematch / rotation /
//    garage round-trip) swaps already-composed canvases with ZERO pixel work;
//    an LRU bound evicts the oldest composites; normal canvases are shared
//    per set across every map.
//
// Unlike the recording stubs in props.selftest.mjs, this file installs a real
// RGBA raster shim: drawImage blits carry actual pixels, getImageData returns
// copies, putImageData writes back — faithful for the 1:1 operations the
// module performs (sources and targets are always square and same-sized).
// Every context operation is counted so pass reductions are measured, not
// estimated.
// ---------------------------------------------------------------------------
const OPS = { drawImage: 0, getImageData: 0, putImageData: 0 };
const CONTEXTS = [];

function resetOps() {
  OPS.drawImage = 0;
  OPS.getImageData = 0;
  OPS.putImageData = 0;
}

class RasterContext {
  constructor(canvas, attrs) {
    this.canvas = canvas;
    this.attrs = attrs || null;
    this.buf = null;
    this.bufW = 0;
    this.bufH = 0;
    CONTEXTS.push(this);
  }
  _ensure() {
    const w = this.canvas.width, h = this.canvas.height;
    if (!this.buf || this.bufW !== w || this.bufH !== h) {
      // spec: canvases start transparent black; resizing clears
      this.buf = new Uint8ClampedArray(w * h * 4);
      this.bufW = w;
      this.bufH = h;
    }
  }
  drawImage(src, dx, dy, dw, dh) {
    OPS.drawImage++;
    const sp = rasterOf(src);
    assert.equal(dx, 0, 'shim supports 1:1 blits only');
    assert.equal(dy, 0, 'shim supports 1:1 blits only');
    assert.equal(dw, sp.canvas.width, 'shim supports 1:1 blits only');
    assert.equal(dh, sp.canvas.height, 'shim supports 1:1 blits only');
    this._ensure();
    sp._ensure();
    this.buf.set(sp.buf);
  }
  getImageData(x, y, w, h) {
    OPS.getImageData++;
    assert.equal(x, 0, 'shim reads full canvases only');
    assert.equal(y, 0, 'shim reads full canvases only');
    assert.equal(w, this.canvas.width, 'shim reads full canvases only');
    assert.equal(h, this.canvas.height, 'shim reads full canvases only');
    this._ensure();
    return { data: new Uint8ClampedArray(this.buf), width: w, height: h };
  }
  putImageData(px, x, y) {
    OPS.putImageData++;
    assert.equal(x, 0, 'shim writes full canvases only');
    assert.equal(y, 0, 'shim writes full canvases only');
    this._ensure();
    this.buf.set(px.data);
  }
}

function rasterOf(src) {
  const c = src._rasterCanvas || src; // FakeImage delegates to its backing canvas
  assert.ok(c && c._ctx, 'drawImage source must be a shim raster');
  return c._ctx;
}

class RasterCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this._ctx = null;
    this._raster = true;
  }
  getContext(_type, attrs) {
    if (!this._ctx) this._ctx = new RasterContext(this, attrs);
    return this._ctx;
  }
}

const IMAGE_SOURCES = new Map();

class FakeImage {
  constructor() {
    this._rasterCanvas = null;
    this.onload = null;
    this.onerror = null;
  }
  get width() { return this._rasterCanvas ? this._rasterCanvas.width : 0; }
  get height() { return this._rasterCanvas ? this._rasterCanvas.height : 0; }
  set src(url) {
    queueMicrotask(() => {
      const c = IMAGE_SOURCES.get(url);
      if (!c) {
        if (this.onerror) this.onerror();
        return;
      }
      this._rasterCanvas = c;
      if (this.onload) this.onload();
    });
  }
}

globalThis.document = {
  createElement(tag) { return tag === 'canvas' ? new RasterCanvas() : {}; },
};
globalThis.Image = FakeImage;

const { composeAlbedo, applySourcedTerrain, applySourcedBuildings } =
  await import('./sourcedTextures.js');

// ---------------------------------------------------------------------------
// Synthetic sourced sets — deterministic 256² patterns standing in for the
// committed ambientCG / Poly Haven JPGs (all 48 files exist under
// public/textures, so production loads always carry color+normal+roughness+AO).
// Patterns include 0/255 extremes so clamps, the alpha floor, and desat/lift
// mixing are exercised on every run.
// ---------------------------------------------------------------------------
const SET_SIZE = 256;

function fnv(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function patternCanvas(kind, seed) {
  const c = new RasterCanvas();
  c.width = c.height = SET_SIZE;
  const ctx = c.getContext('2d');
  const data = new Uint8ClampedArray(SET_SIZE * SET_SIZE * 4);
  for (let y = 0; y < SET_SIZE; y++) {
    for (let x = 0; x < SET_SIZE; x++) {
      const i = (y * SET_SIZE + x) * 4;
      let r, g, b;
      if (kind === 'color') {
        r = (x * 17 + seed) & 255;
        g = (y * 31 + (seed >> 3)) & 255;
        b = ((x ^ y) * 53 + (seed >> 6)) & 255;
      } else if (kind === 'ao') {
        // stripes of true 0 (full-dark multiply) against near-255
        const v = ((x + y * 3 + (seed >> 2)) % 8) < 2
          ? 0
          : 255 - ((x * 7 + (seed >> 5)) % 64);
        r = g = b = v;
      } else if (kind === 'rough') {
        r = g = b = (x * 11 + y * 5 + (seed >> 4)) & 255;
      } else {
        r = (x * 13 + seed) & 255;
        g = (y * 7 + (seed >> 2)) & 255;
        b = ((x + y) * 29 + (seed >> 5)) & 255;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData({ data, width: SET_SIZE, height: SET_SIZE }, 0, 0);
  return c;
}

// mirrors the URL tables in sourcedTextures.js (drift trips the no-warning
// assertion below loudly)
const TT = '/textures/terrain';
const TB = '/textures/buildings';
const acg = (dir, base) => ({
  color: `${dir}/${base}_1K-JPG_Color.jpg`,
  normal: `${dir}/${base}_1K-JPG_NormalGL.jpg`,
  rough: `${dir}/${base}_1K-JPG_Roughness.jpg`,
  ao: `${dir}/${base}_1K-JPG_AmbientOcclusion.jpg`,
});
const ph = (dir, base) => ({
  color: `${dir}/${base}_diff_1k.jpg`,
  normal: `${dir}/${base}_nor_gl_1k.jpg`,
  rough: `${dir}/${base}_rough_1k.jpg`,
  ao: `${dir}/${base}_ao_1k.jpg`,
});
const SETS = {
  grass: acg(TT, 'Grass004'),
  dryGrass: ph(TT, 'withered_grass'),
  dirt: acg(TT, 'Ground071'),
  sand: acg(TT, 'Ground093C'),
  snow: acg(TT, 'Snow010A'),
  rock: acg(TT, 'Rock058'),
  rockWarm: acg(TT, 'Rock063'),
  cobble: acg(TT, 'PavingStones046'),
  plaster: acg(TB, 'Plaster007'),
  roof: acg(TB, 'RoofingTiles012A'),
  wood: acg(TB, 'Planks023A'),
  brick: acg(TB, 'Bricks097'),
};
for (const set of Object.values(SETS)) {
  for (const [slot, url] of Object.entries(set)) {
    const kind = slot === 'color' || slot === 'ao' || slot === 'rough' ? slot : 'normal';
    IMAGE_SOURCES.set(url, patternCanvas(kind, fnv(url)));
  }
}

// ---------------------------------------------------------------------------
// Reference composer — the pre-WA6 implementation kept verbatim (fresh canvas
// + context per decoded layer). It defines the byte-golden outputs, and its
// shim operation counts define the "before" cost of a load.
// ---------------------------------------------------------------------------
function refComposeAlbedo(color, ao, rough, { roughInAlpha = false, roughMul = 1, tint = null, desat = 0, lift = 0 } = {}) {
  const s = Math.min(color.width, texSize(1024));
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.drawImage(color, 0, 0, s, s);
  const px = ctx.getImageData(0, 0, s, s);
  const d = px.data;
  let aod = null, rgd = null;
  if (ao) {
    const c2 = document.createElement('canvas');
    c2.width = c2.height = s;
    const x2 = c2.getContext('2d');
    x2.drawImage(ao, 0, 0, s, s);
    aod = x2.getImageData(0, 0, s, s).data;
  }
  if (rough) {
    const c3 = document.createElement('canvas');
    c3.width = c3.height = s;
    const x3 = c3.getContext('2d');
    x3.drawImage(rough, 0, 0, s, s);
    rgd = x3.getImageData(0, 0, s, s).data;
  }
  const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
  for (let i = 0; i < d.length; i += 4) {
    const a = aod ? aod[i] / 255 : 1;
    let r = d[i] * a * tr, g = d[i + 1] * a * tg, b = d[i + 2] * a * tb;
    if (desat > 0) {
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r += (lum - r) * desat; g += (lum - g) * desat; b += (lum - b) * desat;
    }
    if (lift > 0) { r += lift * 255; g += lift * 255; b += lift * 255; }
    d[i] = Math.min(255, r);
    d[i + 1] = Math.min(255, g);
    d[i + 2] = Math.min(255, b);
    d[i + 3] = roughInAlpha
      ? Math.max(8, Math.min(255, (rgd ? rgd[i] : 230) * roughMul))
      : 255;
  }
  ctx.putImageData(px, 0, 0);
  return c;
}

function canvasBytes(c) {
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}

function assertBytesEqual(a, b, label) {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const p = i >> 2;
      assert.fail(`${label}: byte ${i} (pixel ${p % SET_SIZE},${Math.floor(p / SET_SIZE)} ch${i & 3}) ${a[i]} != ${b[i]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Byte-golden matrix — every option path against the reference composer.
// ---------------------------------------------------------------------------
const gColor = IMAGE_SOURCES.get(SETS.grass.color);
const gAo = IMAGE_SOURCES.get(SETS.grass.ao);
const gRough = IMAGE_SOURCES.get(SETS.grass.rough);
const CASES = [
  ['props defaults', gColor, gAo, gRough, {}],
  ['terrain plain', gColor, gAo, gRough, { roughInAlpha: true }],
  ['terrain roughMul', gColor, gAo, gRough, { roughInAlpha: true, roughMul: 1.25 }],
  ['terrain alpha floor', gColor, gAo, gRough, { roughInAlpha: true, roughMul: 0.04 }],
  ['terrain alpha clamp', gColor, gAo, gRough, { roughInAlpha: true, roughMul: 1.5 }],
  ['tint', gColor, gAo, gRough, { tint: [0.82, 0.80, 0.76] }],
  ['tint clamp high', gColor, gAo, gRough, { tint: [1.52, 1.55, 1.62] }],
  ['tint dark', gColor, gAo, gRough, { tint: [0.43, 0.40, 0.34] }],
  ['desat only', gColor, gAo, gRough, { desat: 0.62 }],
  ['lift only', gColor, gAo, gRough, { lift: 0.11 }],
  ['winter roof grade', gColor, gAo, gRough, { tint: [0.96, 1.02, 1.14], desat: 0.62, lift: 0.10 }],
  ['full terrain entry', gColor, gAo, gRough, { roughInAlpha: true, roughMul: 1.3, tint: [0.74, 0.73, 0.72] }],
  ['ao missing', gColor, null, gRough, { roughInAlpha: true, roughMul: 1.2 }],
  ['rough missing', gColor, gAo, null, { roughInAlpha: true, roughMul: 1.2 }],
  ['both missing', gColor, null, null, { roughInAlpha: true, roughMul: 1.2 }],
  ['untinted props', gColor, gAo, gRough, {}],
];
for (const [label, cc, ca, cr, opts] of CASES) {
  const got = composeAlbedo(cc, ca, cr, { ...opts });
  const want = refComposeAlbedo(cc, ca, cr, opts);
  assertBytesEqual(canvasBytes(got), canvasBytes(want), `golden ${label}`);
}
// determinism: the same inputs compose to the same bytes twice
{
  const a = composeAlbedo(gColor, gAo, gRough, { roughInAlpha: true, roughMul: 1.3, tint: [0.84, 0.78, 0.70] });
  const b = composeAlbedo(gColor, gAo, gRough, { roughInAlpha: true, roughMul: 1.3, tint: [0.84, 0.78, 0.70] });
  assertBytesEqual(canvasBytes(a), canvasBytes(b), 'compose determinism');
}
console.log(`[wa6] golden matrix: ${CASES.length} option paths byte-identical to reference`);

// ---------------------------------------------------------------------------
// E2E harness — drive the public swap hooks over all sixteen battlefields.
// ---------------------------------------------------------------------------
const MAP_IDS = [
  'verdant', 'desert', 'winter', 'urban', 'coastal', 'autumn', 'steppe',
  'railyard', 'frontier', 'fjord', 'delta', 'badlands', 'monsoon', 'alpine',
  'caldera', 'foundry',
];
// mirrors TERRAIN_PLAN/BUILDING_TINTS routing (M stays procedural everywhere;
// desert/badlands rock stays procedural; urban keeps its procedural roof;
// stone routes to brick only on the four industrial/town maps)
const TERRAIN_SKIPPED = (mapId, key) =>
  key === 'M' || ((mapId === 'desert' || mapId === 'badlands') && key === 'R');
const INDUSTRIAL = ['urban', 'railyard', 'foundry', 'caldera'];
const BUILDING_SKIPPED = (mapId, bucket) =>
  (bucket === 'roof' && mapId === 'urban') ||
  (bucket === 'stone' && !INDUSTRIAL.includes(mapId));

function stubTex() {
  return { disposed: 0, image: null, needsUpdate: false, dispose() { this.disposed++; } };
}
function terrainLayers() {
  const out = {};
  for (const k of ['G', 'D', 'R', 'M']) out[k] = { albedo: stubTex(), normal: stubTex() };
  return out;
}
function buildingSets() {
  const out = {};
  for (const k of ['plaster', 'roof', 'wood', 'stone']) out[k] = { albedo: stubTex(), normal: stubTex() };
  return out;
}
const drain = () => new Promise((r) => setTimeout(r, 0));

async function driveMap(mapId, layers, sets) {
  applySourcedTerrain(mapId, layers, {});
  applySourcedBuildings(sets, mapId);
  await drain();
}

function sampleAlpha(canvas) {
  const d = canvasBytes(canvas);
  const out = [];
  for (let i = 3; i < d.length; i += 4 * 997) out.push(d[i]);
  return out;
}

const record = {}; // mapId -> first-pass { layers, sets } (canvas references)
function checkSwaps(mapId, layers, sets) {
  record[mapId] = { layers, sets };
  for (const k of ['G', 'D', 'R', 'M']) {
    const t = layers[k];
    if (TERRAIN_SKIPPED(mapId, k)) {
      assert.equal(t.albedo.image, null, `${mapId}/${k} albedo stays procedural`);
      continue;
    }
    assert.ok(t.albedo.image, `${mapId}/${k} albedo swapped`);
    assert.ok(t.albedo.disposed >= 1, `${mapId}/${k} old texture disposed on swap`);
    assert.equal(t.albedo.image.width, SET_SIZE, `${mapId}/${k} compose size`);
    for (const v of sampleAlpha(t.albedo.image)) {
      assert.ok(v >= 8, `${mapId}/${k} packs roughness into alpha (floor 8)`);
    }
    assert.ok(t.normal.image, `${mapId}/${k} normal swapped`);
  }
  for (const b of ['plaster', 'roof', 'wood', 'stone']) {
    const t = sets[b];
    if (BUILDING_SKIPPED(mapId, b)) {
      assert.equal(t.albedo.image, null, `${mapId}/${b} stays procedural`);
      continue;
    }
    assert.ok(t.albedo.image, `${mapId}/${b} albedo swapped`);
    for (const v of sampleAlpha(t.albedo.image)) {
      assert.equal(v, 255, `${mapId}/${b} props stay opaque`);
    }
  }
}

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

try {
  // ------------------------------------------------------------------
  // 2. Hot rematch: fresh verdant load, then an immediate revisit must
  //    perform ZERO pixel work and reuse the SAME canvas objects.
  // ------------------------------------------------------------------
  resetOps();
  const vLayers = terrainLayers();
  const vSets = buildingSets();
  await driveMap('verdant', vLayers, vSets);
  const freshHot = { ...OPS };
  checkSwaps('verdant', vLayers, vSets);
  assert.ok(freshHot.putImageData > 0, 'fresh load composites');

  resetOps();
  const vLayers2 = terrainLayers();
  const vSets2 = buildingSets();
  await driveMap('verdant', vLayers2, vSets2);
  const revisitHot = { ...OPS };
  assert.equal(revisitHot.drawImage, 0, 'rematch: zero drawImage');
  assert.equal(revisitHot.getImageData, 0, 'rematch: zero readbacks');
  assert.equal(revisitHot.putImageData, 0, 'rematch: zero recompositions');
  for (const k of ['G', 'D']) {
    assert.equal(vLayers2[k].albedo.image, vLayers[k].albedo.image, `rematch ${k} albedo identity`);
    assert.equal(vLayers2[k].normal.image, vLayers[k].normal.image, `rematch ${k} normal identity`);
  }
  console.log(`[wa6] hot rematch surface ops: fresh=${JSON.stringify(freshHot)} revisit=${JSON.stringify(revisitHot)}`);

  // ------------------------------------------------------------------
  // 3. Full campaign sweep — the other fifteen battlefields.
  // ------------------------------------------------------------------
  resetOps();
  for (const mapId of MAP_IDS.slice(1)) {
    const layers = terrainLayers();
    const sets = buildingSets();
    await driveMap(mapId, layers, sets);
    checkSwaps(mapId, layers, sets);
  }
  const freshSweep = { ...OPS };

  // cross-map sharing: normals are per-set forever (uncapped, bounded by SETS)
  assert.equal(record.urban.layers.G.normal.image, record.verdant.layers.G.normal.image,
    'grass normal canvas shared across maps');
  // identical (set, opts) pairs resolve to identical bytes even after LRU
  // eviction forced a recomposition (winter G and alpine G are both plain snow)
  assertBytesEqual(
    canvasBytes(record.alpine.layers.G.albedo.image),
    canvasBytes(record.winter.layers.G.albedo.image),
    'snow composite determinism across maps',
  );
  // desert's two sand layers carry different tints -> different composites
  assert.notEqual(record.desert.layers.G.albedo.image, record.desert.layers.D.albedo.image,
    'same set with different tints stays distinct');
  {
    const g = canvasBytes(record.desert.layers.G.albedo.image);
    const d = canvasBytes(record.desert.layers.D.albedo.image);
    assert.notDeepEqual(Array.from(g.slice(0, 4096)), Array.from(d.slice(0, 4096)),
      'desert sand tints produce different bytes');
  }

  // ------------------------------------------------------------------
  // 4. LRU precision: enough later-map composites evict verdant; a then-
  //    stale map recomposes once and is resident again immediately after.
  // ------------------------------------------------------------------
  for (const m of ['railyard', 'caldera', 'foundry', 'urban']) {
    await driveMap(m, terrainLayers(), buildingSets());
  }
  resetOps();
  await driveMap('verdant', terrainLayers(), buildingSets());
  assert.ok(OPS.getImageData > 0, 'evicted composite recomposes on demand');
  resetOps();
  await driveMap('verdant', terrainLayers(), buildingSets());
  assert.equal(OPS.getImageData, 0, 'recomposed composite is resident again');

  // ------------------------------------------------------------------
  // 5. Cold-session replay cost: revisit ALL sixteen maps (fresh stubs) and
  //    compare against what the pre-WA6 code would have repeated. Bytes must
  //    match the first pass digest-for-digest.
  // ------------------------------------------------------------------
  function sessionDigest() {
    const h = createHash('sha256');
    for (const mapId of MAP_IDS) {
      const { layers, sets } = record[mapId];
      for (const k of ['G', 'D', 'R', 'M']) {
        if (TERRAIN_SKIPPED(mapId, k)) continue;
        h.update(canvasBytes(layers[k].albedo.image));
        h.update(canvasBytes(layers[k].normal.image));
      }
      for (const b of ['plaster', 'roof', 'wood', 'stone']) {
        if (BUILDING_SKIPPED(mapId, b)) continue;
        h.update(canvasBytes(sets[b].albedo.image));
        h.update(canvasBytes(sets[b].normal.image));
      }
    }
    return h.digest('hex');
  }
  const freshDigest = sessionDigest();

  resetOps();
  for (const mapId of MAP_IDS) {
    await driveMap(mapId, terrainLayers(), buildingSets());
  }
  const revisitSweep = { ...OPS };
  assert.equal(sessionDigest(), freshDigest, 'revisit renders byte-identical world textures');
  assert.ok(revisitSweep.putImageData <= freshHot.putImageData + freshSweep.putImageData,
    'LRU reuse never increases recomposition work');

  // ------------------------------------------------------------------
  // 6. Readback contract (PERFORMANCE.md "Canvas readback"): exactly one
  //    willReadFrequently context exists — the shared AO/roughness scratch.
  // ------------------------------------------------------------------
  const flagged = CONTEXTS.filter((c) => c.attrs && c.attrs.willReadFrequently);
  assert.equal(flagged.length, 1, 'exactly one readback-optimized context (shared scratch)');

  // ------------------------------------------------------------------
  // Measurement summary (putImageData === composite count: exactly one
  // write-back per compose; each compose also runs the single pixel loop).
  // ------------------------------------------------------------------
  const freshTotal = {
    drawImage: freshHot.drawImage + freshSweep.drawImage,
    getImageData: freshHot.getImageData + freshSweep.getImageData,
    putImageData: freshHot.putImageData + freshSweep.putImageData,
  };
  const pct = (x, y) => (y === 0 ? '0' : `${Math.round((1 - x / y) * 100)}%`);
  console.log('[wa6] fresh 16-map sweep (cold session): '
    + `composites=${freshTotal.putImageData} surfaceOps=${freshTotal.drawImage + freshTotal.getImageData + freshTotal.putImageData}`);
  console.log('[wa6] revisit 16-map sweep (warm session): '
    + `composites=${revisitSweep.putImageData} surfaceOps=${revisitSweep.drawImage + revisitSweep.getImageData + revisitSweep.putImageData}`);
  console.log(`[wa6] warm-revisit composite reduction vs cold: ${pct(revisitSweep.putImageData, freshTotal.putImageData)}`);
  console.log('[wa6] pre-WA6 code repeats the cold-sweep cost on EVERY load; '
    + `two-load session total: old=${2 * (freshTotal.drawImage + freshTotal.getImageData + freshTotal.putImageData)} `
    + `new=${freshTotal.drawImage + freshTotal.getImageData + freshTotal.putImageData + revisitSweep.drawImage + revisitSweep.getImageData + revisitSweep.putImageData}`);
} finally {
  console.warn = origWarn;
}

assert.equal(warnings.length, 0, `unexpected sourced-texture warnings: ${warnings.join(' | ')}`);
console.log('sourcedTextures.selftest: PASS');
