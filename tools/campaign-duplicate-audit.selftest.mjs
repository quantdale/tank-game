// Selftest for tools/campaign-duplicate-audit.mjs — plants a synthetic asset
// tree (duplicate textures, duplicate baked geometry, duplicate GLB POSITION
// accessors, a PBR set with separable AO+roughness) and asserts the report
// finds exactly what was planted. Read-only against the real repo.
// Run: node tools/campaign-duplicate-audit.selftest.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAudit, scanGlb } from './campaign-duplicate-audit.mjs';
import { encodePng } from './campaign-png.mjs';

const root = mkdtempSync(join(tmpdir(), 'dup-audit-'));
try {
  // --- textures: one PNG duplicated under two names + two byte-identical JPGs
  const gray = (w, h, v) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
    return { width: w, height: h, data };
  };
  const pngA = encodePng(gray(8, 8, 200), { colorType: 'grayalpha' });
  // same pixels, different encoding path — pixel hash must still match
  const pngARgb = encodePng(gray(8, 8, 200), { colorType: 'rgba' });
  const pngB = encodePng(gray(8, 8, 100), { colorType: 'grayalpha' });
  mkdirSync(join(root, 'public', 'fx'), { recursive: true });
  writeFileSync(join(root, 'public', 'fx', 'a.png'), pngA);
  writeFileSync(join(root, 'public', 'fx', 'a-copy.png'), pngARgb);
  writeFileSync(join(root, 'public', 'fx', 'b.png'), pngB);
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  writeFileSync(join(root, 'public', 'fx', 'x.jpg'), jpgBytes);
  writeFileSync(join(root, 'public', 'fx', 'x-copy.jpg'), jpgBytes);

  // --- baked prop models JSON: two identical entries + one distinct
  const geo = { positions: [0.1, 0.2, 0.3], normals: [0, 1, 0], colors: [1, 1, 1], indices: [0, 0, 0], tris: 1 };
  mkdirSync(join(root, 'src', 'world'), { recursive: true });
  writeFileSync(join(root, 'src', 'world', 'props-models.json'), JSON.stringify({
    rock_a: geo,
    rock_b: { positions: [0.1, 0.2, 0.3], normals: [0, 1, 0], colors: [1, 1, 1], indices: [0, 0, 0], tris: 1 },
    crate: { positions: [9, 9, 9], normals: [0, 1, 0], colors: [1, 1, 1], indices: [0, 0, 0], tris: 1 },
  }));

  // --- GLBs: two files sharing the same POSITION bytes, one different
  const glbWithPositions = (positions) => {
    const posData = Buffer.from(Float32Array.from(positions).buffer);
    const idxData = Buffer.from(Uint16Array.from([0, 1, 2]).buffer);
    const binChunks = [];
    let offset = 0;
    const bvPos = { bufferView: 0, byteOffset: offset, componentType: 5126, count: positions.length / 3, type: 'VEC3' };
    binChunks.push(posData); offset += posData.length;
    const bvIdx = { bufferView: 1, byteOffset: offset, componentType: 5123, count: 3, type: 'SCALAR' };
    binChunks.push(idxData); offset += idxData.length;
    const json = {
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_meshopt_compression'], // recorded by inventory
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [bvPos, bvIdx],
      bufferViews: [
        { buffer: 0, byteOffset: bvPos.byteOffset, byteLength: posData.length },
        { buffer: 0, byteOffset: bvIdx.byteOffset, byteLength: idxData.length },
      ],
      buffers: [{ byteLength: offset }],
    };
    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    const binBuf = Buffer.concat(binChunks);
    // spec: JSON chunk pads with 0x20, BIN chunk with 0x00
    const padJson = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), 0x20)]) : b);
    const padBin = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + padJson(jsonBuf).length + 8 + padBin(binBuf).length, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(padJson(jsonBuf).length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(padBin(binBuf).length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, padJson(jsonBuf), binHeader, padBin(binBuf)]);
  };
  mkdirSync(join(root, 'public', 'models', 'props'), { recursive: true });
  const sharedPositions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  writeFileSync(join(root, 'public', 'models', 'props', 'one.glb'), glbWithPositions(sharedPositions));
  writeFileSync(join(root, 'public', 'models', 'props', 'two.glb'), glbWithPositions(sharedPositions));
  writeFileSync(join(root, 'public', 'models', 'props', 'three.glb'),
    glbWithPositions([5, 5, 5, 6, 5, 5, 5, 6, 5]));

  // --- PBR set with separable AO+roughness
  mkdirSync(join(root, 'public', 'textures', 'terrain'), { recursive: true });
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'Dirt01_1K-JPG_Color.jpg'), Buffer.from([1]));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'Dirt01_1K-JPG_AmbientOcclusion.jpg'), Buffer.from([2, 2]));
  writeFileSync(join(root, 'public', 'textures', 'terrain', 'Dirt01_1K-JPG_Roughness.jpg'), Buffer.from([3, 3, 3]));

  const report = runAudit(root);

  // texture duplication: a.png == a-copy.png by PIXELS despite different bytes
  const pxGroup = report.textures.duplicateGroups.find((g) => g.method === 'pixels');
  assert.ok(pxGroup, 'pixel-duplicate group must be found');
  assert.deepEqual(pxGroup.files.sort(), ['public/fx/a-copy.png', 'public/fx/a.png']);
  // waste = every copy after the first listed file (a-copy.png kept)
  assert.equal(pxGroup.wastedBytes, pngA.length, 'wasted bytes counted from the second copy');
  // distinct PNG must NOT be grouped
  assert.ok(!pxGroup.files.includes('public/fx/b.png'), 'non-duplicate stays ungrouped');
  // jpg byte-hash group
  const byteGroup = report.textures.duplicateGroups.find((g) => g.method === 'bytes');
  assert.ok(byteGroup && byteGroup.files.length === 2, 'byte-identical jpgs grouped');

  // baked geometry duplication
  assert.equal(report.geometry.propsModels.models.length, 3);
  assert.equal(report.geometry.propsModels.duplicateGroups.length, 1, 'rock_a/rock_b share geometry');
  assert.deepEqual(report.geometry.propsModels.duplicateGroups[0].names.sort(), ['rock_a', 'rock_b']);

  // GLB duplicate POSITION detection + extension inventory
  assert.equal(report.geometry.glbs.scanned, 3);
  assert.equal(report.geometry.glbs.compressedWith.join(','), 'EXT_meshopt_compression',
    'extensionsUsed recorded read-only');
  assert.equal(report.geometry.glbs.duplicateGroups.length, 1, 'one/two.glb share POSITION bytes');
  assert.deepEqual(report.geometry.glbs.duplicateGroups[0].files.sort(),
    ['public/models/props/one.glb', 'public/models/props/two.glb']);
  assert.equal(report.geometry.glbs.inventory.every((g) => g.tris === 1), true, 'tri count from index accessor');

  // packed-ORM opportunity
  const dirt = report.packedOrm.find((s) => s.set.endsWith('Dirt01'));
  assert.ok(dirt, 'Dirt01 set detected');
  assert.equal(dirt.ormPackableBytes, 5, 'AO+roughness bytes counted as packable');
  assert.ok(dirt.note.includes('composeAlbedo'), 'note points at the runtime recomposition site');

  console.log('campaign-duplicate-audit.selftest: all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// scanGlb rejects non-GLB input without throwing
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'glb-bad-'));
  try {
    const bad = join(dir, 'bad.glb');
    writeFileSync(bad, Buffer.from('not a glb file at all'));
    const res = scanGlb(bad, dir);
    assert.equal(res.ok, false);
    assert.match(res.error, /not a GLB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
