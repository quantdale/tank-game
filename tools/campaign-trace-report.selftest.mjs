#!/usr/bin/env node
// campaign-trace-report.selftest.mjs — regression coverage for the pure-node
// trace analyzer (SA-02 Trustworthy GPU A/B Profiling). Spawns the CLI as a
// child process against deterministic synthetic traces and asserts on exit
// codes, report text, JSON structure, hand-computed percentiles, A/B diff
// statuses, GPU pass-attribution extraction, legacy-schema tolerance, and
// byte-identical determinism across runs.
//
// The tool itself stays untouched: fixtures are written to a throwaway temp
// directory and every invocation is `node tools/campaign-trace-report.mjs …`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'campaign-trace-report.mjs');

const FULL_SCHEMA = [
  'tMs', 'gapMs', 'dtMs', 'simS', 'preBattleS', 'phase', 'flags',
  'renderFrame', 'calls', 'triangles', 'programs', 'heapMB',
  'throttle', 'steer', 'fire',
  'geoMem', 'texMem', 'rtCount', 'texMB', 'casters', 'vegInst', 'chunks', 'cells',
];

function row(schema, values) {
  const out = schema.map(() => 0);
  for (const [k, v] of Object.entries(values)) {
    const i = schema.indexOf(k);
    if (i >= 0) out[i] = v;
  }
  return out;
}

function makeTrace({ schema = FULL_SCHEMA, phase = 'battle', gaps = [], calls = [], tris = [], programs = [], extraTrace = {}, topExtra = {} }) {
  const n = gaps.length;
  return {
    version: 1,
    sessionId: 'selftest-session',
    startedAt: '2026-08-21T00:00:00.000Z',
    environment: { gpu: { renderer: 'SelfTest GL' }, dpr: 1, mode: 'development' },
    stats: { frames: n },
    frameSchema: schema,
    frames: gaps.map((gapMs, i) => row(schema, {
      tMs: i * 16.7, gapMs,
      phase,
      renderFrame: i,
      calls: calls[i % calls.length] ?? 0,
      triangles: tris[i % tris.length] ?? 0,
      programs: programs[i % programs.length] ?? 0,
      heapMB: 100,
      cells: 3,
    })),
    events: [],
    ...extraTrace,
    ...topExtra,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-report-selftest-'));
let failures = 0;
function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
}
function write(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

try {
  // --- usage refusal ----------------------------------------------------------
  {
    const r = run([]);
    assert.equal(r.status, 2, 'no input file exits 2');
    assert.match(r.stderr, /usage:/);
  }

  // --- trace without frame rows is rejected -----------------------------------
  {
    const p = write('empty.json', { version: 1, trace: {} });
    const r = run([p]);
    assert.equal(r.status, 2, 'empty trace exits 2');
    assert.match(r.stderr, /no frame rows/);
  }

  // --- text report: windows, ranking, anomalies --------------------------------
  {
    // gaps sorted: [8, 8, 16, 17, 33] → p50 = idx 2 = 16, p95 = idx 4 = 33.
    const p = write('basic.json', makeTrace({
      gaps: [16, 17, 33, 8, 8],
      calls: [500],
      tris: [900_000],
      programs: [10, 10, 12, 12, 12],
      extraTrace: {
        events: [{ kind: 'anomaly', phase: 'battle', name: 'frame:spike' }, { kind: 'anomaly', phase: 'battle', name: 'frame:spike' }],
      },
    }));
    const r = run([p]);
    assert.equal(r.status, 0, `text report exits 0: ${r.stderr}`);
    assert.match(r.stdout, /# campaign trace report/);
    assert.match(r.stdout, /## window: battle \(5 frames\)/);
    assert.match(r.stdout, /gap p50\/p95\/p99\/max: 16 \/ 33 \/ 33 \/ 33 ms/);
    assert.match(r.stdout, /\(~62\.5 fps at p50\)/);
    assert.match(r.stdout, /programs max 12, births 1/);
    assert.match(r.stdout, /\[\d+\] frame-pacing/);
    assert.match(r.stdout, /anomalies by phase\/name/);
    assert.match(r.stdout, /battle\/frame:spike: 2/);
  }

  // --- JSON structure + deterministic byte-for-byte output ---------------------
  {
    const p = write('json.json', makeTrace({
      gaps: [16, 17, 33, 8, 8],
      calls: [200],
      tris: [300_000],
      programs: [5],
    }));
    const a = run([p, '--json']);
    assert.equal(a.status, 0);
    const b = run([p, '--json']);
    assert.equal(a.stdout, b.stdout, 'report is deterministic across runs');

    const rep = JSON.parse(a.stdout);
    assert.equal(rep.sessionId, 'selftest-session');
    assert.deepEqual(rep.environment.gpu, { renderer: 'SelfTest GL' });
    assert.equal(rep.windows.length, 1);
    const w = rep.windows[0];
    assert.equal(w.phase, 'battle');
    assert.equal(w.frames, 5);
    assert.equal(w.gapP50, 16);
    assert.equal(w.gapP95, 33);
    assert.equal(w.fpsAtP50, 62.5);
    assert.ok(w.ranking.some((s) => s.name === 'frame-pacing'), 'pacing signal ranked');
    assert.ok(w.ranking.every((s) => typeof s.severity === 'number' && s.severity > 0));
  }

  // --- A/B comparison statuses --------------------------------------------------
  {
    // Baseline: healthy-ish pacing, exported by a build whose frameSchema
    // predates the texMB column (mirrors the 970ef9e3 waypoint). Current:
    // better gaps (IMPROVED), more draw calls (REGRESSION), near-identical
    // triangles (PARITY within 3%), and texMBMax absent on the baseline side
    // (UNKNOWN instead of a crash or a fake 0-vs-0 parity).
    const base = write('ab-base.json', makeTrace({
      schema: FULL_SCHEMA.filter((c) => c !== 'texMB'),
      gaps: [15, 16, 16, 17, 18],
      calls: [400],
      tris: [1_000_000],
      programs: [7],
    }));
    const curr = write('ab-curr.json', makeTrace({
      gaps: [8, 9, 9, 10, 11],
      calls: [800],
      tris: [1_010_000],
      programs: [7],
    }));
    const r = run([curr, `--compare=${base}`, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.comparison.baselineFile, base);
    assert.equal(rep.comparison.baselineSessionId, 'selftest-session');
    const diffs = Object.fromEntries(
      rep.comparison.windows[0].diffs.map((d) => [d.name, d]),
    );
    assert.equal(diffs.gapP50.status, 'IMPROVED');
    assert.ok(diffs.gapP50.delta < 0);
    assert.equal(diffs.callsP95.status, 'REGRESSION');
    assert.ok(diffs.callsP95.delta > 0);
    assert.equal(diffs.trisP95.status, 'PARITY');
    assert.equal(diffs.trisP95.pctChange, 1);
    // Missing baseline metric degrades to UNKNOWN instead of crashing.
    assert.equal(diffs.texMBMax.status, 'UNKNOWN');
  }

  // --- GPU pass attribution: raw segments are folded into a breakdown ----------
  {
    const segs = [
      { seq: 1, pass: 'shadows', key: 'csm0', w: 2048, h: 2048, calls: 40, triangles: 90_000, renders: 1, gpuMs: 1.5 },
      { seq: 2, pass: 'opaque', key: 'hdr', w: 1920, h: 1080, calls: 300, triangles: 1_200_000, renders: 1, gpuMs: 4.5 },
      { seq: 3, pass: 'bloom', key: 'bloom0', w: 960, h: 540, calls: 10, triangles: 20, renders: 1, gpuMs: null },
    ];
    const p = write('gpu.json', makeTrace({
      gaps: [16, 16, 16],
      extraTrace: { gpuTimer: segs },
    }));
    const r = run([p, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.ok(Array.isArray(rep.gpuBreakdown));
    const byPass = Object.fromEntries(rep.gpuBreakdown.map((g) => [g.pass, g]));
    assert.equal(byPass.shadows.totalGpuMs, 1.5);
    assert.equal(byPass.opaque.totalGpuMs, 4.5);
    assert.equal(byPass.bloom.gpuSamples, 0, 'unresolved query contributes no GPU ms');
    assert.equal(byPass.bloom.segments, 1);
    assert.ok(byPass.opaque.gpuSharePct > byPass.shadows.gpuSharePct, 'share follows GPU time');
    assert.ok(Math.abs(byPass.shadows.gpuSharePct + byPass.opaque.gpuSharePct - 100) < 0.01);

    // Text table renders the attribution block.
    const t = run([p]);
    assert.match(t.stdout, /GPU Pass Attribution Breakdown/);
    assert.match(t.stdout, /TOTAL GPU TIME: 6\.000 ms/);

    // An explicit gpuBreakdown export wins over re-folding raw segments.
    const p2 = write('gpu2.json', makeTrace({
      gaps: [16],
      extraTrace: {
        gpuTimer: segs,
        gpuBreakdown: [{ pass: 'grade', segments: 2, gpuSamples: 2, totalGpuMs: 0.5, avgGpuMs: 0.25, gpuSharePct: 100 }],
      },
    }));
    const r2 = run([p2, '--json']);
    const rep2 = JSON.parse(r2.stdout);
    assert.equal(rep2.gpuBreakdown.length, 1);
    assert.equal(rep2.gpuBreakdown[0].pass, 'grade');
  }

  // --- legacy 15-column schema still analyzes ----------------------------------
  {
    const legacySchema = FULL_SCHEMA.slice(0, 15);
    const p = write('legacy.json', makeTrace({
      schema: legacySchema,
      gaps: [16, 17, 40],
      calls: [900],
      tris: [2_000_000],
      programs: [3, 3, 9],
    }));
    const r = run([p, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.windows[0].programBirths, 1, 'birth detected on legacy rows');
    assert.equal(rep.windows[0].vegInstP95, null, 'absent columns stay null, not 0');
    assert.equal(rep.gpuBreakdown, null, 'no GPU data without gpuTimer payload');
  }

  console.log('campaign-trace-report selftest: pass');
} catch (err) {
  failures = 1;
  console.error('campaign-trace-report selftest: FAIL');
  console.error(err?.stack || err);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures);
