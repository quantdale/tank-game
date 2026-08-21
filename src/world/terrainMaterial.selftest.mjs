// terrainMaterial.selftest.mjs — matqual r1 guards for the splat material
// contract and the baked curvature-occlusion geometry, all pure-node (no DOM,
// no WebGL): heightfield determinism goldens, aCavity attribute correctness
// and cross-LOD consistency, the sampleSplatNoise CPU twin, and static checks
// of the injected GLSL (uniform wiring, reserved words, hook anchors).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildChunkGeometry,
  buildFineGrid,
  createHeightField,
  sampleSplatNoise,
} from './terrain.js';

// --- heightfield determinism: golden values captured before matqual r1 ------
const GOLDEN_HEIGHTS = [
  [0, 0, 3.303808004950023],
  [14, -78, 3.8604398782965883],
  [38, 332, -0.23975999653339386],
  [-190, -210, 3.143408169702565],
  [220, -140, -0.47472758232435996],
  [300, 300, 3.4769804585861994],
  [-400, 120, 7.948587560253703],
  [10, 40, 4.251785470903806],
  [240.4, -169.6, -0.5514583253437172],
  [-511, 510, 28.81488656742994],
];
const field = createHeightField(1337);
for (const [x, z, golden] of GOLDEN_HEIGHTS) {
  assert.ok(Math.abs(field.getHeightAt(x, z) - golden) < 1e-9,
    `heightfield drifted from its deterministic golden value at ${x},${z}`);
}
const fieldB = createHeightField(1337);
for (let i = 0; i < 16; i++) {
  const x = (i * 137.3) % 1024 - 512, z = (i * 331.7) % 1024 - 512;
  assert.equal(field.getHeightAt(x, z), fieldB.getHeightAt(x, z),
    `repeat heightfield builds must be bit-identical at ${x},${z}`);
}

// --- baked curvature occlusion (aCavity) ------------------------------------
// Synthetic pure height function: one gaussian PIT at the chunk center on a
// flat plain. buildFineGrid/buildChunkGeometry only need getHeightAt.
const pitField = {
  getHeightAt: (x, z) => -2 * Math.exp(-(x * x + z * z) / 20),
};
const CX0 = -64, CZ0 = -64; // classic CHUNK_SIZE=128 chunk origin
const fine = buildFineGrid(pitField, CX0, CZ0);
const lod0 = buildChunkGeometry(pitField, CX0, CZ0, 96, fine);
const lod2 = buildChunkGeometry(pitField, CX0, CZ0, 24, fine);

for (const [geo, segs] of [[lod0, 96], [lod2, 24]]) {
  const cavAttr = geo.getAttribute('aCavity');
  assert.ok(cavAttr, 'chunk geometry carries the aCavity attribute');
  assert.equal(cavAttr.count, geo.getAttribute('position').count,
    'aCavity covers every vertex including skirts');
  for (let i = 0; i < cavAttr.count; i++) {
    const v = cavAttr.getX(i);
    assert.ok(v >= 0.62 && v <= 1.06, `cavity clamped at vertex ${i}: ${v}`);
  }
}
// flat corner stays neutral (laplacian of a plane is zero)
{
  const cav = lod0.getAttribute('aCavity');
  const corner = 2 * 97 + 2; // vertex (2,2), world (-62,-62) — far from the pit
  assert.ok(Math.abs(cav.getX(corner) - 1) < 1e-6,
    'flat ground keeps neutral occlusion');
}
// pit center darkens; LOD0/LOD2 agree bit-for-bit at shared world coords
{
  const c0 = lod0.getAttribute('aCavity').getX(48 * 97 + 48); // world (0,0)
  const c2 = lod2.getAttribute('aCavity').getX(12 * 25 + 12); // world (0,0)
  assert.ok(c0 < 0.95, `pit center reads concave (${c0})`);
  assert.equal(c0, c2, 'all LODs shade identical concavity at shared verts');
}

// --- CPU twin of the splat noise fields (vegetation correlation) ------------
const snA = sampleSplatNoise(120, -40);
const snB = sampleSplatNoise(120, -40, {});
for (const key of ['n1', 'n2', 'mA']) {
  assert.ok(snA[key] >= 0 && snA[key] <= 1, `${key} stays normalized`);
  assert.equal(snA[key], snB[key], `${key} is stable across calls`);
}

// --- static GLSL contract checks (regression guards) ------------------------
const srcPath = fileURLToPath(new URL('./terrain.js', import.meta.url));
const text = readFileSync(srcPath, 'utf8');
const fragMatch = text.match(/const SPLAT_COMMON_FRAG = \/\* glsl \*\/`([\s\S]*?)`;/);
assert.ok(fragMatch, 'SPLAT_COMMON_FRAG template found');
const frag = fragMatch[1];
// "patch" is a reserved word in GLSL ES — a past bug shipped it as an
// identifier. Check code only (comments may mention it).
const fragCode = frag.replace(/\/\/.*$/mg, '');
assert.doesNotMatch(fragCode, /\bpatch\b/, 'no GLSL reserved word used as identifier');
// every declared uniform must be wired by createSplatMaterial
const uniforms = [...frag.matchAll(
  /\buniform\s+(?:float|vec[234]|mat[234]|sampler2D)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/g,
)].flatMap((m) => m[1].split(/\s*,\s*/));
assert.ok(uniforms.length >= 25, 'uniform scan found the expected set');
for (const name of uniforms) {
  assert.ok(text.includes(`shader.uniforms.${name} =`),
    `uniform ${name} declared in GLSL but never wired`);
}
// onBeforeCompile anchors the hook replaces — all must exist
for (const anchor of ['#include <common>', '#include <worldpos_vertex>',
  '#include <map_fragment>', '#include <roughnessmap_fragment>',
  '#include <normal_fragment_maps>']) {
  assert.ok(text.includes(anchor), `shader anchor missing: ${anchor}`);
}
// matqual r1 wiring: far-path frequency separation + cavity varying chain
assert.ok(text.includes('df > 0.995'), 'far-path early-out present in splatSamp');
assert.ok(frag.includes('varying float vCavity'), 'fragment declares vCavity');
assert.ok(text.includes('attribute float aCavity'), 'vertex declares aCavity');
assert.ok(text.includes('vCavity = aCavity'), 'vertex writes vCavity');
assert.ok(text.includes("setAttribute('aCavity'"), 'geometry binds aCavity');

// --- r8 anti-tiling machinery -------------------------------------------------
// The rotation-blend ground samplers are the anti-tiling core: a second sample
// of the same tile rotated ~42 deg / scaled x1.16, masked by the warped ~10-20 m
// noise patches (gTileMix). Dropping the normal counter-rotation re-lights every
// blended texel 42 deg off; dropping gTileMix wiring restores the periodic
// stipple rows / patchwork grid on snow and sand.
assert.ok(text.includes('const mat2 TILEROT = mat2(0.7431, 0.6691, -0.6691, 0.7431)'),
  'r8 TILEROT rotation matrix present');
assert.ok(text.includes('gTileMix = smoothstep('),
  'r8 gTileMix rotation-blend weight wired in splatCompute');
for (const sampler of ['vec4 groundSamp(sampler2D t, vec2 uv, float df, float mb) {',
  'vec4 groundNrm(sampler2D t, vec2 uv, float df, float mb) {']) {
  assert.ok(text.includes(sampler), `r8 anti-tiling sampler missing: ${sampler.slice(5, 15)}`);
}
assert.ok(text.includes(
    'sB.xy = vec2(0.7431 * nB.x + 0.6691 * nB.y, -0.6691 * nB.x + 0.7431 * nB.y) * 0.5 + 0.5;'),
  'r8 normal counter-rotation intact (blended normals stay world-aligned)');

// --- matqual r2 puddle/dampness response --------------------------------------
// Wet ground must be able to go GLOSSY: the damp blend wraps the dry max —
// mix(max(rough0, dryRough), wetTarget, dampness). Inside the max the 0.80-0.98
// texture-alpha roughness always won and the wet sheen was unreachable dead code.
assert.ok(frag.includes('float dampness'), 'dampness field declared');
assert.ok(frag.includes('* (1.0 - uSandMacro * 0.85)'),
  'dampness gated off desert macro sheets');
assert.ok(/gSplatRough\s*=\s*mix\(max\(rough0,\s*dryRough\),/.test(frag),
  'damp blend wraps the dry max so the wet gloss stays reachable');

// --- CPU twin <-> shader constant parity ---------------------------------------
// sampleSplatNoise is the documented CPU twin of splatCompute's warped fields;
// vegetation scatter correlates against it (grass thins where dirt shows). If
// either side's scale or offset drifts, grass and dirt de-correlate silently.
// Pin the shared constants on BOTH sides of the contract.
const TWIN_GLSL = [
  'uv * 0.0009 + vec2(0.53, 0.17)',   // domain warp sample coords
  '* 48.0',                            // warp amplitude
  'uvW * 0.0117',                      // n1 field scale
  'uvW * 0.0031 + vec2(0.41, 0.13)',   // n2 field scale+offset
  'uvW * 0.0121 + vec2(0.63, 0.29)',   // meadowA composite scale 1
  'uvW * 0.00779 + vec2(0.19, 0.71)',  // meadowA composite scale 2
];
for (const c of TWIN_GLSL) {
  assert.ok(frag.includes(c), `shader side of CPU-twin constant drifted: ${c}`);
}
const TWIN_JS = [
  'x * 0.0009 + 0.53', 'wr * 0.5 * 48', 'wx * 0.0117', 'wx * 0.0031 + 0.41',
  'wx * 0.0121 + 0.63', ') * 0.62', 'wx * 0.00779 + 0.19', ') * 0.38',
];
for (const c of TWIN_JS) {
  assert.ok(text.includes(c), `CPU twin constant drifted: ${c}`);
}

// --- facade contract: terrainMaterial.js re-exports must match terrain.js ---
// The facade is the public import surface; if terrain.js renames or drops one
// of these bindings every consumer breaks at parse time. Import both modules
// and require identical bindings (same reference, not just same name).
const facade = await import('./terrainMaterial.js');
const impl = await import('./terrain.js');
const facadeNames = Object.keys(facade);
assert.ok(facadeNames.length >= 14, 'facade exposes the full material API');
for (const name of facadeNames) {
  assert.ok(name in impl, `facade export ${name} missing from terrain.js`);
  assert.equal(facade[name], impl[name],
    `facade export ${name} drifted from its terrain.js binding`);
}

console.log('terrainMaterial selftest: goldens, aCavity LOD parity, CPU twin,'
  + ` GLSL contract (${uniforms.length} uniforms wired),`
  + ' anti-tiling + dampness + twin-parity guards,'
  + ` facade parity (${facadeNames.length} re-exports) passed`);
