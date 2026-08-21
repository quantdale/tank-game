import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// W10 material pipeline: headless DOM/canvas shims installed BEFORE
// materials.js loads so the shared-library paths (track bake, decal bake, and
// a full createTankMaterials run at the 'low' tier) execute in pure Node.
// The stubs only keep the painters running — no assertion depends on pixel
// truth, only on object identity, refcounts and bounded resource counts.
// ---------------------------------------------------------------------------
class StubPath2D {
  moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {}
}
class StubImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4); }
}
class StubCanvas {
  constructor() { this._w = 0; this._h = 0; this._store = null; this._ctx = null; }
  get width() { return this._w; }
  set width(v) { this._w = v; this._store = new Uint8ClampedArray(v * Math.max(1, this._h) * 4); }
  get height() { return this._h; }
  set height(v) { this._h = v; this._store = new Uint8ClampedArray(Math.max(1, this._w) * v * 4); }
  getContext() {
    if (!this._ctx) {
      const canvas = this;
      this._ctx = {
        canvas,
        fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
        globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
        font: '', textAlign: 'left', textBaseline: 'alphabetic',
        save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
        beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        arc() {}, rect() {}, fill() {}, stroke() {},
        fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {}, strokeText() {},
        setLineDash() {}, isPointInPath() { return false; }, drawImage() {},
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        createImageData(w, h) { return new StubImageData(w, h); },
        getImageData(x, y, w, h) { return new StubImageData(w, h); },
        putImageData() {},
      };
    }
    return this._ctx;
  }
  // snapshotBake's canvasToBlob try/catch treats a throw as "no encoder"
  toBlob() { throw new Error('no toBlob in Node'); }
}
globalThis.document = { createElement: () => new StubCanvas() };
globalThis.Path2D = StubPath2D;

const {
  SURFACE_LIBRARY,
  createTankMaterials,
  isMaterialTextureQualityUpgrade,
  materialTextureDimensions,
  normalizeMaterialTextureQuality,
  trackLibraryStats,
} = await import('./materials.js');
const { texSize } = await import('../engine/quality.js');
const THREE = await import('three');
const { ALL_TANK_IDS, getSpec } = await import('./specs.js');

assert.deepEqual(materialTextureDimensions('low'), { albedo: 256, map: 128 });
assert.deepEqual(materialTextureDimensions('ai'), { albedo: 512, map: 256 });
assert.deepEqual(materialTextureDimensions('preview'), { albedo: 1024, map: 512 });
assert.deepEqual(materialTextureDimensions('high'), { albedo: 2048, map: 1024 });
assert.equal(normalizeMaterialTextureQuality('unknown'), 'high');

assert.equal(isMaterialTextureQualityUpgrade('low', 'ai'), true);
assert.equal(isMaterialTextureQualityUpgrade('ai', 'preview'), true);
assert.equal(isMaterialTextureQualityUpgrade('preview', 'high'), true);
assert.equal(isMaterialTextureQualityUpgrade('high', 'preview'), false);
assert.equal(isMaterialTextureQualityUpgrade('preview', 'preview'), false);

// ---------------------------------------------------------------------------
// W10: surface response library — frozen, complete, byte-stable reference
// values for the fixed-response roles consumed by createTankMaterials.
// ---------------------------------------------------------------------------
assert.equal(Object.isFrozen(SURFACE_LIBRARY), true, 'surface library must be frozen');
for (const role of ['rubber', 'gearShadow', 'opticGlass', 'gunmetal', 'trackSteel',
  'spareTrackSteel', 'wood', 'canvasCloth']) {
  const r = SURFACE_LIBRARY[role];
  assert.ok(r && typeof r.color === 'number' && typeof r.roughness === 'number'
    && typeof r.metalness === 'number', `${role} response complete`);
}
assert.deepEqual(SURFACE_LIBRARY.rubber, { color: 0x292a28, roughness: 0.96, metalness: 0.0 });
assert.deepEqual(SURFACE_LIBRARY.gearShadow, { color: 0x0b0c0a, roughness: 0.98, metalness: 0.0 });
// SA-10 hero art ceiling: coated gun optics sharpened (roughness 0.12 -> 0.07).
assert.deepEqual(SURFACE_LIBRARY.opticGlass, { color: 0x2a3540, roughness: 0.07, metalness: 0.85 });
assert.deepEqual(SURFACE_LIBRARY.gunmetal,
  { color: 0x36342f, roughness: 0.9, metalness: 0.18, envMapIntensity: 0.22 });
assert.deepEqual(SURFACE_LIBRARY.trackSteel,
  { color: 0x353634, roughness: 0.95, metalness: 0.08, envMapIntensity: 0.08 });
assert.deepEqual(SURFACE_LIBRARY.spareTrackSteel,
  { color: 0x353634, roughness: 0.94, metalness: 0.08, envMapIntensity: 0.06 });

// ---------------------------------------------------------------------------
// W10: shared track-band steel library + per-spec texture sharing. Two live
// instances of one spec must share the TEX_CACHE entry AND the exact track
// canvas; the whole fleet draws from <= 4 variants per tier size.
// ---------------------------------------------------------------------------
const engineCtx = { anisotropy: 4 };
const specA = getSpec(ALL_TANK_IDS[0]);
const specB = getSpec(ALL_TANK_IDS.find((id) => id !== specA.id));
const matsA1 = createTankMaterials(specA, engineCtx, 4000, 'low');
const matsA2 = createTankMaterials(specA, engineCtx, 4000, 'low');
assert.equal(matsA1.hull.map, matsA2.hull.map, 'same-spec instances share the baked albedo texture');
assert.equal(matsA1.trackTexL.image, matsA2.trackTexL.image, 'same-spec instances share the track canvas');
assert.notEqual(matsA1.trackTexL, matsA2.trackTexL, 'track scroll textures stay per-instance (offset animation)');
matsA2.dispose();

const matsB1 = createTankMaterials(specB, engineCtx, 4000, 'low');
assert.ok([matsB1.trackTexL.image, matsB1.trackTexR.image].every(
  (img) => img && typeof img.width === 'number'), 'track library canvases are real size-carrying canvases');
for (const s of trackLibraryStats()) {
  assert.equal(s.size, texSize(512), 'track library bakes through the central texSize lever');
  assert.ok(s.variants >= 1 && s.variants <= 4, `track variants capped per size (${s.variants})`);
}

// ---------------------------------------------------------------------------
// W10: decal library — fixed drawings dedupe across specs, numbers follow
// their text, and dispose() releases exactly the holder's own refcounts.
// ---------------------------------------------------------------------------
const sootShared = matsA1.decal('hull', 'soot');
assert.equal(matsB1.decal('hull', 'soot'), sootShared, 'fixed drawings share across vehicles');
assert.equal(matsB1.decal('turret', 'crossgrey'), matsA1.decal('turret', 'crossgrey'),
  'each fixed drawing kind is its own shared material');
const numA = matsA1.decal('number', '11');
const numB = matsB1.decal('number', '22');
assert.notEqual(numA, numB, 'different number texts are different decals');
assert.equal(matsB1.decal('number', '11'), numA, 'same number text shares across vehicles');
assert.notEqual(matsB1.decal('insignia', ''), sootShared, 'kinds never collide');

matsA1.dispose();
assert.equal(matsB1.decal('hull', 'soot'), sootShared,
  'surviving instance still holds the shared decal after another instance disposes');
matsB1.dispose();
const matsA3 = createTankMaterials(specA, engineCtx, 4000, 'low');
assert.notEqual(matsA3.decal('hull', 'soot'), sootShared,
  'last release evicts the cache entry (fresh bake on next acquire)');

// ---------------------------------------------------------------------------
// W10: shader-variant census — the vehicle material set stays a small bounded
// family of program feature signatures, and aligned roles keep sharing one.
// ---------------------------------------------------------------------------
const sig = (m) => JSON.stringify({
  phys: m.isMeshPhysicalMaterial === true,
  map: !!m.map, normalMap: !!m.normalMap, roughnessMap: !!m.roughnessMap,
  bumpMap: !!m.bumpMap, emissiveMap: !!m.emissiveMap, vertexColors: !!m.vertexColors,
  clearcoat: (m.clearcoat || 0) > 0, transparent: !!m.transparent,
});
const census = ['hull', 'barrel', 'wheels', 'wheelsRecessed', 'detail', 'dark', 'rubber',
  'shadow', 'glass', 'canvasCloth', 'wood', 'burnt', 'trackL', 'trackR'].map((k) => sig(matsA3[k]));
assert.ok(new Set(census).size <= 12,
  `vehicle program signature census bounded (${new Set(census).size})`);
assert.equal(sig(matsA3.wheels), sig(matsA3.wheelsRecessed), 'wheel paint roles share one program signature');
assert.equal(sig(matsA3.wheels), sig(matsA3.detail), 'fittings share the wheel program signature');
assert.equal(sig(matsA3.dark), sig(matsA3.trackLink), 'gunmetal and track steel share one program signature');
assert.equal(sig(matsA3.dark), sig(matsA3.spareTrack), 'spare track steel shares the gunmetal signature');
assert.ok(matsA3.hull.isMeshPhysicalMaterial && matsA3.hull.clearcoat > 0, 'hull keeps its physical paint response');
matsA3.dispose();

await import('./factoryCamo.selftest.mjs');

console.log('materialQuality.selftest: tiers, surface library, track/decal sharing, refcounts, and variant census passed');
