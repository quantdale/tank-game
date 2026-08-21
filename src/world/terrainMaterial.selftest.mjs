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

console.log('terrainMaterial selftest: goldens, aCavity LOD parity, CPU twin,'
  + ` GLSL contract (${uniforms.length} uniforms wired) passed`);
