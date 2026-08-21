#!/usr/bin/env node
// campaign-trace-report.mjs — pure-node analyzer for __DEV_TRACE and dev-perf-probe JSON exports
// (campaign W1/W2). Turns a flight-recorder snapshot (perf:dev output, or
// `__DEV_TRACE.download()`) into per-phase frame/render statistics, GPU pass attribution,
// A/B baseline comparison, and a deterministic bottleneck ranking.
//
// No browser, no dependencies:
//
//   node tools/campaign-trace-report.mjs .qa-dev/normal.json
//   node tools/campaign-trace-report.mjs trace.json --window=battle --json
//   node tools/campaign-trace-report.mjs trace.json --compare=docs/perf-campaign-2026-08-21-baseline.json
//
// Exit code 0 whenever the file parses; ranking severity is advisory.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const file = positional[0] || null;
const asJson = args.includes('--json');
const windowArg = (args.find((a) => a.startsWith('--window=')) || '').split('=')[1] || null;
const compareArg = (args.find((a) => a.startsWith('--compare=')) || '').split('=')[1] || positional[1] || null;

if (!file) {
  console.error('usage: node tools/campaign-trace-report.mjs <trace.json> [--compare=<baseline.json>] [--window=<phase>] [--json]');
  process.exit(2);
}

function loadTrace(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const traceObj = raw.trace && raw.trace.frameSchema ? raw.trace : raw;
  const schema = traceObj.frameSchema || [];
  const frames = traceObj.frames || [];
  const events = traceObj.events || [];
  const gpuTimer = raw.gpuTimer || traceObj.gpuTimer || raw.natural?.gpuTimer || null;
  const gpuBreakdown = raw.gpuBreakdown || traceObj.gpuBreakdown || raw.natural?.gpuBreakdown || null;
  return {
    raw,
    trace: traceObj,
    schema,
    frames,
    events,
    sessionId: traceObj.sessionId || raw.sessionId,
    startedAt: traceObj.startedAt || raw.startedAt,
    environment: traceObj.environment || raw.environment,
    stats: traceObj.stats || raw.stats || raw.natural?.stats,
    gpuTimer,
    gpuBreakdown,
  };
}

const current = loadTrace(file);
if (!current.schema.length || !current.frames.length) {
  console.error(`trace at ${file} has no frame rows — was it exported from __DEV_TRACE or dev-perf-probe?`);
  process.exit(2);
}

const col = Object.fromEntries(current.schema.map((name, i) => [name, i]));
const has = (name) => name in col;
const num = (row, name) => (has(name) ? row[col[name]] : 0);

function pct(sortedValues, q) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * q))];
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Per-phase window over frame rows; phase '' means all. */
function windowRows(frames, colMap, phase) {
  return frames.filter((r) => !phase || r[colMap.phase] === phase);
}

function summarize(rows, colMap) {
  const hasCol = (name) => name in colMap;
  const rowNum = (row, name) => (hasCol(name) ? row[colMap[name]] : 0);

  const gaps = rows.map((r) => rowNum(r, 'gapMs')).sort((a, b) => a - b);
  const calls = rows.map((r) => rowNum(r, 'calls')).sort((a, b) => a - b);
  const tris = rows.map((r) => rowNum(r, 'triangles')).sort((a, b) => a - b);
  const veg = hasCol('vegInst') ? rows.map((r) => r[colMap.vegInst]).sort((a, b) => a - b) : [];
  const texMB = hasCol('texMB') ? rows.map((r) => r[colMap.texMB]).sort((a, b) => a - b) : [];
  const casters = hasCol('casters') ? rows.map((r) => r[colMap.casters]).sort((a, b) => a - b) : [];
  const chunks = hasCol('chunks') ? rows.map((r) => r[colMap.chunks]).sort((a, b) => a - b) : [];
  const cells = hasCol('cells') ? rows.map((r) => r[colMap.cells]).sort((a, b) => a - b) : [];

  let programBirths = 0;
  let birthGapMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const p = rowNum(rows[i], 'programs');
    if (p > rowNum(rows[i - 1], 'programs')) {
      programBirths++;
      if (rowNum(rows[i], 'gapMs') > 50) birthGapMs += rowNum(rows[i], 'gapMs');
    }
  }

  let heapSlopeMbPerMin = 0;
  let gcDrops = 0;
  if (rows.length >= 2 && hasCol('heapMB')) {
    const h0 = rowNum(rows[0], 'heapMB');
    const h1 = rowNum(rows[rows.length - 1], 'heapMB');
    const t0 = rowNum(rows[0], 'tMs');
    const t1 = rowNum(rows[rows.length - 1], 'tMs');
    heapSlopeMbPerMin = t1 > t0 ? ((h1 - h0) / (t1 - t0)) * 60000 : 0;
    let peak = rowNum(rows[0], 'heapMB');
    for (let i = 1; i < rows.length; i++) {
      const h = rowNum(rows[i], 'heapMB');
      if (h > peak) peak = h;
      else if (peak - h > 15) { gcDrops++; peak = h; }
    }
  }
  const spikes = gaps.filter((g) => g >= 50 && g < 250).length;
  const freezes = gaps.filter((g) => g >= 250).length;

  return {
    frames: rows.length,
    gapP50: +pct(gaps, 0.5).toFixed(3),
    gapP95: +pct(gaps, 0.95).toFixed(3),
    gapP99: +pct(gaps, 0.99).toFixed(3),
    maxGapMs: +Math.max(...gaps, 0).toFixed(3),
    avgGapMs: +avg(gaps).toFixed(3),
    fpsAtP50: +(1000 / Math.max(pct(gaps, 0.5), 1e-6)).toFixed(1),
    spikes,
    freezes,
    callsP50: pct(calls, 0.5),
    callsP95: pct(calls, 0.95),
    callsP99: pct(calls, 0.99),
    callsMax: calls.length ? Math.max(...calls) : 0,
    callsAvg: +avg(calls).toFixed(1),
    trisP50: pct(tris, 0.5),
    trisP95: pct(tris, 0.95),
    trisP99: pct(tris, 0.99),
    trisMax: tris.length ? Math.max(...tris) : 0,
    trisAvg: +avg(tris).toFixed(0),
    programsMax: rows.reduce((m, r) => Math.max(m, rowNum(r, 'programs')), 0),
    programBirths,
    birthGapMs: +birthGapMs.toFixed(1),
    heapSlopeMbPerMin: +heapSlopeMbPerMin.toFixed(2),
    gcDrops,
    geoMemMax: hasCol('geoMem') ? rows.reduce((m, r) => Math.max(m, r[colMap.geoMem]), 0) : null,
    texMemMax: hasCol('texMem') ? rows.reduce((m, r) => Math.max(m, r[colMap.texMem]), 0) : null,
    rtCountMax: hasCol('rtCount') ? rows.reduce((m, r) => Math.max(m, r[colMap.rtCount]), 0) : null,
    texMBP50: texMB.length ? +pct(texMB, 0.5).toFixed(1) : null,
    texMBMax: texMB.length ? +pct(texMB, 1).toFixed(1) : null,
    castersP50: casters.length ? pct(casters, 0.5) : null,
    castersP95: casters.length ? pct(casters, 0.95) : null,
    castersMax: casters.length ? Math.max(...casters) : null,
    vegInstP50: veg.length ? pct(veg, 0.5) : null,
    vegInstP95: veg.length ? pct(veg, 0.95) : null,
    vegInstMax: veg.length ? Math.max(...veg) : null,
    chunksP50: chunks.length ? pct(chunks, 0.5) : null,
    cellsP50: cells.length ? pct(cells, 0.5) : null,
  };
}

function extractGpuBreakdown(traceData) {
  if (traceData.gpuBreakdown && Array.isArray(traceData.gpuBreakdown) && traceData.gpuBreakdown.length > 0) {
    return traceData.gpuBreakdown;
  }
  if (traceData.gpuTimer && Array.isArray(traceData.gpuTimer)) {
    const groups = new Map();
    let totalAllGpuMs = 0;
    for (const seg of traceData.gpuTimer) {
      const pass = seg.pass || 'opaque';
      let entry = groups.get(pass);
      if (!entry) {
        entry = { pass, segments: 0, gpuSamples: 0, totalGpuMs: 0, gpuMsList: [], callsList: [], trisList: [], totalCalls: 0, totalTriangles: 0 };
        groups.set(pass, entry);
      }
      entry.segments++;
      entry.totalCalls += seg.calls || 0;
      entry.totalTriangles += seg.triangles || 0;
      entry.callsList.push(seg.calls || 0);
      entry.trisList.push(seg.triangles || 0);
      if (seg.gpuMs != null && Number.isFinite(seg.gpuMs)) {
        entry.gpuSamples++;
        entry.totalGpuMs += seg.gpuMs;
        entry.gpuMsList.push(seg.gpuMs);
        totalAllGpuMs += seg.gpuMs;
      }
    }
    const result = [];
    for (const [pass, g] of groups.entries()) {
      g.gpuMsList.sort((a, b) => a - b);
      g.callsList.sort((a, b) => a - b);
      g.trisList.sort((a, b) => a - b);
      const avgGpuMs = g.gpuSamples > 0 ? +(g.totalGpuMs / g.gpuSamples).toFixed(4) : null;
      const p50GpuMs = g.gpuSamples > 0 ? +pct(g.gpuMsList, 0.5).toFixed(4) : null;
      const p95GpuMs = g.gpuSamples > 0 ? +pct(g.gpuMsList, 0.95).toFixed(4) : null;
      const p99GpuMs = g.gpuSamples > 0 ? +pct(g.gpuMsList, 0.99).toFixed(4) : null;
      const maxGpuMs = g.gpuSamples > 0 ? +Math.max(...g.gpuMsList).toFixed(4) : null;
      const avgCalls = g.segments > 0 ? +(g.totalCalls / g.segments).toFixed(1) : 0;
      const avgTriangles = g.segments > 0 ? +(g.totalTriangles / g.segments).toFixed(0) : 0;
      const gpuSharePct = totalAllGpuMs > 0 && g.totalGpuMs > 0 ? +((g.totalGpuMs / totalAllGpuMs) * 100).toFixed(2) : 0;
      result.push({
        pass,
        segments: g.segments,
        gpuSamples: g.gpuSamples,
        totalGpuMs: +g.totalGpuMs.toFixed(4),
        avgGpuMs,
        p50GpuMs,
        p95GpuMs,
        p99GpuMs,
        maxGpuMs,
        worstGpuMs: maxGpuMs,
        totalCalls: g.totalCalls,
        avgCalls,
        callsP50: pct(g.callsList, 0.5),
        callsP95: pct(g.callsList, 0.95),
        totalTriangles: g.totalTriangles,
        avgTriangles,
        trisP50: pct(g.trisList, 0.5),
        trisP95: pct(g.trisList, 0.95),
        gpuSharePct,
      });
    }
    return result;
  }
  return null;
}

// Anomaly attribution by phase straight from the event ring.
const anomalyByPhase = Object.create(null);
for (const e of current.events) {
  if (e.kind !== 'anomaly' && e.kind !== 'error') continue;
  const key = `${e.phase || 'unknown'}/${e.name}`;
  anomalyByPhase[key] = (anomalyByPhase[key] || 0) + 1;
}

const phases = [...new Set(current.frames.map((r) => r[col.phase]))];
const windows = windowArg ? [windowArg] : phases;
const summaries = windows.map((phase) => ({ phase, ...summarize(windowRows(current.frames, col, phase), col) }));
const gpuBreakdown = extractGpuBreakdown(current);

/**
 * Deterministic bottleneck ranking.
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

// Optional A/B baseline comparison
let comparison = null;
if (compareArg) {
  try {
    const base = loadTrace(compareArg);
    const baseCol = Object.fromEntries(base.schema.map((name, i) => [name, i]));
    const baseWindows = windows.map((phase) => ({
      phase,
      ...summarize(windowRows(base.frames, baseCol, phase), baseCol),
    }));

    comparison = {
      baselineFile: compareArg,
      baselineSessionId: base.sessionId,
      windows: summaries.map((currWin) => {
        const baseWin = baseWindows.find((w) => w.phase === currWin.phase) || {};
        const metrics = [
          { name: 'gapP50', label: 'Frame gap p50 (ms)', base: baseWin.gapP50, curr: currWin.gapP50, lowerIsBetter: true },
          { name: 'gapP95', label: 'Frame gap p95 (ms)', base: baseWin.gapP95, curr: currWin.gapP95, lowerIsBetter: true },
          { name: 'gapP99', label: 'Frame gap p99 (ms)', base: baseWin.gapP99, curr: currWin.gapP99, lowerIsBetter: true },
          { name: 'maxGapMs', label: 'Max frame gap (ms)', base: baseWin.maxGapMs, curr: currWin.maxGapMs, lowerIsBetter: true },
          { name: 'fpsAtP50', label: 'FPS at p50', base: baseWin.fpsAtP50, curr: currWin.fpsAtP50, lowerIsBetter: false },
          { name: 'callsP95', label: 'Draw calls p95', base: baseWin.callsP95, curr: currWin.callsP95, lowerIsBetter: true },
          { name: 'trisP95', label: 'Triangles p95', base: baseWin.trisP95, curr: currWin.trisP95, lowerIsBetter: true },
          { name: 'vegInstP95', label: 'Vegetation instances p95', base: baseWin.vegInstP95, curr: currWin.vegInstP95, lowerIsBetter: true },
          { name: 'texMBMax', label: 'Texture footprint max (MB)', base: baseWin.texMBMax, curr: currWin.texMBMax, lowerIsBetter: true },
          { name: 'programBirths', label: 'Shader program births', base: baseWin.programBirths, curr: currWin.programBirths, lowerIsBetter: true },
          { name: 'heapSlope', label: 'Heap slope (MB/min)', base: baseWin.heapSlopeMbPerMin, curr: currWin.heapSlopeMbPerMin, lowerIsBetter: true },
        ];

        const diffs = metrics.map((m) => {
          const b = m.base;
          const c = m.curr;
          let delta = null, pctChange = null, status = 'UNKNOWN';
          if (b != null && c != null && Number.isFinite(b) && Number.isFinite(c)) {
            delta = +(c - b).toFixed(3);
            pctChange = b !== 0 ? +((delta / b) * 100).toFixed(1) : 0;
            if (Math.abs(pctChange) <= 3.0 || delta === 0) {
              status = 'PARITY';
            } else if ((m.lowerIsBetter && delta < 0) || (!m.lowerIsBetter && delta > 0)) {
              status = 'IMPROVED';
            } else {
              status = 'REGRESSION';
            }
          }
          return { name: m.name, label: m.label, baseline: b, current: c, delta, pctChange, status };
        });

        return { phase: currWin.phase, diffs };
      }),
    };
  } catch (err) {
    console.error(`warning: could not load comparison baseline at ${compareArg}: ${err.message}`);
  }
}

const report = {
  file,
  sessionId: current.sessionId,
  startedAt: current.startedAt,
  environment: current.environment ? { gpu: current.environment.gpu, dpr: current.environment.dpr, mode: current.environment.mode } : null,
  stats: current.stats || null,
  anomalyByPhase,
  gpuBreakdown,
  windows: summaries.map((s) => ({ ...s, ranking: rank(s) })),
  comparison,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# campaign trace report — ${file}`);
  if (report.environment?.gpu) console.log(`gpu: ${report.environment.gpu.renderer || report.environment.gpu} mode=${report.environment.mode ?? '?'}`);

  for (const w of report.windows) {
    console.log(`\n## window: ${w.phase} (${w.frames} frames)`);
    console.log(`  gap p50/p95/p99/max: ${w.gapP50} / ${w.gapP95} / ${w.gapP99} / ${w.maxGapMs} ms  (~${w.fpsAtP50} fps at p50)`);
    console.log(`  whole-frame calls p50/p95/p99/max: ${w.callsP50} / ${w.callsP95} / ${w.callsP99} / ${w.callsMax}   avg: ${w.callsAvg}`);
    console.log(`  whole-frame triangles p50/p95/max: ${w.trisP50} / ${w.trisP95} / ${w.trisMax}   avg: ${w.trisAvg}`);
    console.log(`  programs max ${w.programsMax}, births ${w.programBirths} (${w.birthGapMs} ms hitched)`);
    console.log(`  heap slope ${w.heapSlopeMbPerMin} MB/min, gc drops ${w.gcDrops}`);
    if (w.vegInstP95 != null || w.castersP50 != null || w.chunksP50 != null) {
      console.log(`  casters p50/p95: ${w.castersP50}/${w.castersP95}, vegInst p50/p95: ${w.vegInstP50}/${w.vegInstP95}, chunks p50: ${w.chunksP50}, texMB p50/max: ${w.texMBP50}/${w.texMBMax}`);
    }
    if (w.cellsP50 != null) {
      console.log(`  active/visible cells p50: ${w.cellsP50}`);
    }
    console.log('  ranking:');
    for (const sig of w.ranking) console.log(`    - [${sig.severity}] ${sig.name}: ${sig.evidence}`);
    if (!w.ranking.length) console.log('    - (no signal above threshold)');
  }

  if (report.gpuBreakdown && report.gpuBreakdown.length) {
    console.log('\n## GPU Pass Attribution Breakdown (?gputrace=1)');
    console.log('Pass             Samples   Avg (ms)   p50 (ms)   p95 (ms)   Max (ms)   Calls (avg)   Tris (avg)   GPU %');
    console.log('-------------------------------------------------------------------------------------------------------');
    let totalGpu = 0;
    for (const p of report.gpuBreakdown) {
      totalGpu += p.totalGpuMs || 0;
      const passName = (p.pass || 'opaque').padEnd(16);
      const samples = String(p.gpuSamples || p.segments || 0).padStart(7);
      const avgMs = p.avgGpuMs != null ? p.avgGpuMs.toFixed(3).padStart(10) : '      -   ';
      const p50Ms = p.p50GpuMs != null ? p.p50GpuMs.toFixed(3).padStart(10) : '      -   ';
      const p95Ms = p.p95GpuMs != null ? p.p95GpuMs.toFixed(3).padStart(10) : '      -   ';
      const maxMs = p.maxGpuMs != null ? p.maxGpuMs.toFixed(3).padStart(10) : '      -   ';
      const calls = String(p.avgCalls || p.totalCalls || 0).padStart(13);
      const tris = String(p.avgTriangles || p.totalTriangles || 0).padStart(12);
      const share = p.gpuSharePct != null ? `${p.gpuSharePct.toFixed(1)}%`.padStart(7) : '     -%';
      console.log(`${passName}${samples}${avgMs}${p50Ms}${p95Ms}${maxMs}${calls}${tris}${share}`);
    }
    console.log('-------------------------------------------------------------------------------------------------------');
    console.log(`TOTAL GPU TIME: ${totalGpu.toFixed(3)} ms`);
  }

  if (report.comparison) {
    console.log(`\n## A/B Comparison against Baseline: ${report.comparison.baselineFile}`);
    for (const win of report.comparison.windows) {
      console.log(`\n### Window: ${win.phase}`);
      console.log('Metric                              Baseline      Current        Delta     % Change   Status');
      console.log('-----------------------------------------------------------------------------------------------');
      for (const d of win.diffs) {
        if (d.baseline == null && d.current == null) continue;
        const label = d.label.padEnd(35);
        const baseStr = d.baseline != null ? String(d.baseline).padStart(12) : '           -';
        const currStr = d.current != null ? String(d.current).padStart(12) : '           -';
        const deltaStr = d.delta != null ? (d.delta > 0 ? `+${d.delta}` : String(d.delta)).padStart(12) : '           -';
        const pctStr = d.pctChange != null ? `${d.pctChange > 0 ? '+' : ''}${d.pctChange}%`.padStart(12) : '           -';
        const statusStr = d.status.padStart(11);
        console.log(`${label}${baseStr}${currStr}${deltaStr}${pctStr}${statusStr}`);
      }
    }
  }

  const anom = Object.entries(report.anomalyByPhase).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (anom.length) {
    console.log('\n## anomalies by phase/name');
    for (const [k, v] of anom) console.log(`  ${k}: ${v}`);
  }
}

