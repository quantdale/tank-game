#!/usr/bin/env node
// campaign-trace-report.mjs — pure-node analyzer for __DEV_TRACE JSON exports
// (campaign W1). Turns a flight-recorder snapshot (perf:dev output, or
// `__DEV_TRACE.download()`) into per-phase frame/render statistics and a
// deterministic bottleneck ranking built from the recorder's counters.
//
// No browser, no dependencies:
//
//   node tools/campaign-trace-report.mjs .qa-dev/normal.json
//   node tools/campaign-trace-report.mjs trace.json --window=battle --json
//
// Exit code 0 whenever the file parses; ranking severity is advisory, gates
// stay in dev-perf-probe.mjs.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const windowArg = (args.find((a) => a.startsWith('--window=')) || '').split('=')[1] || null;

if (!file) {
  console.error('usage: node tools/campaign-trace-report.mjs <trace.json> [--window=<phase>] [--json]');
  process.exit(2);
}

const trace = JSON.parse(readFileSync(file, 'utf8'));
const schema = trace.frameSchema || [];
const frames = trace.frames || [];
const events = trace.events || [];
if (!schema.length || !frames.length) {
  console.error('trace has no frame rows — was it exported from __DEV_TRACE?');
  process.exit(2);
}
const col = Object.fromEntries(schema.map((name, i) => [name, i]));
const has = (name) => name in col;
const num = (row, name) => (has(name) ? row[col[name]] : 0);

function pct(sortedValues, q) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * q))];
}

/** Per-phase window over frame rows; phase '' means all. */
function windowRows(phase) {
  return frames.filter((r) => !phase || r[col.phase] === phase);
}

function summarize(rows) {
  const gaps = rows.map((r) => num(r, 'gapMs')).sort((a, b) => a - b);
  const calls = rows.map((r) => num(r, 'calls')).sort((a, b) => a - b);
  const tris = rows.map((r) => num(r, 'triangles')).sort((a, b) => a - b);
  const veg = has('vegInst') ? rows.map((r) => r[col.vegInst]).sort((a, b) => a - b) : [];
  const texMB = has('texMB') ? rows.map((r) => r[col.texMB]).sort((a, b) => a - b) : [];
  let programBirths = 0;
  let birthGapMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const p = num(rows[i], 'programs');
    if (p > num(rows[i - 1], 'programs')) {
      programBirths++;
      if (num(rows[i], 'gapMs') > 50) birthGapMs += num(rows[i], 'gapMs');
    }
  }
  // Heap slope via first/last of a least-squares-free endpoints check plus a
  // simple sawtooth counter (drop after local max = likely major GC).
  let heapSlopeMbPerMin = 0;
  let gcDrops = 0;
  if (rows.length >= 2 && has('heapMB')) {
    const h0 = num(rows[0], 'heapMB');
    const h1 = num(rows[rows.length - 1], 'heapMB');
    const t0 = num(rows[0], 'tMs');
    const t1 = num(rows[rows.length - 1], 'tMs');
    heapSlopeMbPerMin = t1 > t0 ? ((h1 - h0) / (t1 - t0)) * 60000 : 0;
    let peak = num(rows[0], 'heapMB');
    for (let i = 1; i < rows.length; i++) {
      const h = num(rows[i], 'heapMB');
      if (h > peak) peak = h;
      else if (peak - h > 15) { gcDrops++; peak = h; }
    }
  }
  const spikes = gaps.filter((g) => g >= 50 && g < 250).length;
  const freezes = gaps.filter((g) => g >= 250).length;
  return {
    frames: rows.length,
    gapP50: +pct(gaps, .5).toFixed(3),
    gapP95: +pct(gaps, .95).toFixed(3),
    gapP99: +pct(gaps, .99).toFixed(3),
    maxGapMs: +Math.max(...gaps, 0).toFixed(3),
    fpsAtP50: +(1000 / Math.max(pct(gaps, .5), 1e-6)).toFixed(1),
    spikes, freezes,
    callsP50: pct(calls, .5), callsP95: pct(calls, .95),
    trisP50: pct(tris, .5), trisP95: pct(tris, .95),
    programsMax: rows.reduce((m, r) => Math.max(m, num(r, 'programs')), 0),
    programBirths, birthGapMs: +birthGapMs.toFixed(1),
    heapSlopeMbPerMin: +heapSlopeMbPerMin.toFixed(2), gcDrops,
    geoMemMax: has('geoMem') ? rows.reduce((m, r) => Math.max(m, r[col.geoMem]), 0) : null,
    texMemMax: has('texMem') ? rows.reduce((m, r) => Math.max(m, r[col.texMem]), 0) : null,
    texMBP50: texMB.length ? +pct(texMB, .5).toFixed(1) : null,
    texMBMax: texMB.length ? +pct(texMB, 1).toFixed(1) : null,
    castersP50: has('casters') ? pct(rows.map((r) => r[col.casters]).sort((a, b) => a - b), .5) : null,
    vegInstP95: veg.length ? pct(veg, .95) : null,
    chunksP50: has('chunks') ? pct(rows.map((r) => r[col.chunks]).sort((a, b) => a - b), .5) : null,
  };
}

// Anomaly attribution by phase straight from the event ring.
const anomalyByPhase = Object.create(null);
for (const e of events) {
  if (e.kind !== 'anomaly' && e.kind !== 'error') continue;
  const key = `${e.phase || 'unknown'}/${e.name}`;
  anomalyByPhase[key] = (anomalyByPhase[key] || 0) + 1;
}

const phases = [...new Set(frames.map((r) => r[col.phase]))];
const windows = windowArg ? [windowArg] : phases;
const summaries = windows.map((phase) => ({ phase, ...summarize(windowRows(phase)) }));

/**
 * Deterministic bottleneck ranking. Each signal carries an evidence string
 * and a 0-100 severity; higher wins, ties break alphabetically. Thresholds
 * are heuristics for THIS title's budget (>=60 median / >=45 p5 at 1080p).
 */
function rank(s) {
  const signals = [];
  if (s.gapP95 > 16.7) {
    signals.push({
      name: 'frame-pacing', severity: Math.min(100, Math.round(s.gapP95 * 3)),
      evidence: `gap p95 ${s.gapP95} ms vs 16.7 ms budget (${s.spikes} spikes / ${s.freezes} freezes)`,
    });
  }
  if (s.callsP95 > 1000) {
    signals.push({
      name: 'draw-call-pressure', severity: Math.min(90, Math.round(s.callsP95 / 40)),
      evidence: `whole-frame draw calls p95 ${s.callsP95} — batch/instance candidates`,
    });
  }
  if (s.trisP95 > 4_000_000) {
    signals.push({
      name: 'vertex-throughput', severity: Math.min(85, Math.round(s.trisP95 / 200_000)),
      evidence: `triangles p95 ${(s.trisP95 / 1e6).toFixed(1)} M/frame`,
    });
  }
  if (s.programBirths > 0) {
    signals.push({
      name: 'shader-compilation', severity: Math.min(80, 20 + s.programBirths * 5),
      evidence: `${s.programBirths} program births, ${s.birthGapMs} ms of >50 ms gaps on birth frames`,
    });
  }
  if (s.gcDrops > 2 || Math.abs(s.heapSlopeMbPerMin) > 10) {
    signals.push({
      name: 'gc-pressure', severity: Math.min(75, s.gcDrops * 8 + Math.round(Math.abs(s.heapSlopeMbPerMin))),
      evidence: `${s.gcDrops} large heap drops, slope ${s.heapSlopeMbPerMin} MB/min`,
    });
  }
  if (s.vegInstP95 != null && s.vegInstP95 > 20000) {
    signals.push({
      name: 'vegetation-instances', severity: Math.min(60, Math.round(s.vegInstP95 / 2000)),
      evidence: `visible vegetation instances p95 ${s.vegInstP95}`,
    });
  }
  if (s.texMemMax != null && s.texMemMax > 1200) {
    signals.push({
      name: 'texture-memory', severity: Math.min(55, Math.round(s.texMemMax / 40)),
      evidence: `${s.texMemMax} live GPU textures (est. ${s.texMBMax} MB) — mobile OOM band`,
    });
  }
  return signals.sort((a, b) => b.severity - a.severity || a.name.localeCompare(b.name));
}

const report = {
  file, sessionId: trace.sessionId, startedAt: trace.startedAt,
  environment: trace.environment ? { gpu: trace.environment.gpu, dpr: trace.environment.dpr, mode: trace.environment.mode } : null,
  stats: trace.stats || null,
  anomalyByPhase,
  windows: summaries.map((s) => ({ ...s, ranking: rank(s) })),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# campaign trace report — ${file}`);
  if (report.environment?.gpu) console.log(`gpu: ${report.environment.gpu.renderer || report.environment.gpu} mode=${report.environment.mode ?? '?'}`);
  for (const w of report.windows) {
    console.log(`\n## window: ${w.phase} (${w.frames} frames)`);
    console.log(`  gap p50/p95/p99/max: ${w.gapP50} / ${w.gapP95} / ${w.gapP99} / ${w.maxGapMs} ms  (~${w.fpsAtP50} fps at p50)`);
    console.log(`  whole-frame calls p50/p95: ${w.callsP50}/${w.callsP95}   triangles p50/p95: ${w.trisP50}/${w.trisP95}`);
    console.log(`  programs max ${w.programsMax}, births ${w.programBirths} (${w.birthGapMs} ms hitched)`);
    console.log(`  heap slope ${w.heapSlopeMbPerMin} MB/min, gc drops ${w.gcDrops}`);
    if (w.vegInstP95 != null) {
      console.log(`  casters p50 ${w.castersP50}, vegInst p95 ${w.vegInstP95}, chunks p50 ${w.chunksP50}, texMB p50/max ${w.texMBP50}/${w.texMBMax}`);
    }
    console.log('  ranking:');
    for (const sig of w.ranking) console.log(`    - [${sig.severity}] ${sig.name}: ${sig.evidence}`);
    if (!w.ranking.length) console.log('    - (no signal above threshold)');
  }
  const anom = Object.entries(report.anomalyByPhase).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (anom.length) {
    console.log('\n## anomalies by phase/name');
    for (const [k, v] of anom) console.log(`  ${k}: ${v}`);
  }
}
