// Development-only per-pass GPU timer + render-pass segmenter (campaign W1/W2).
//
// EXT_disjoint_timer_query_webgl2 FEASIBILITY (investigated, implemented here
// behind an EXPLICIT flag — never on by default, never in production):
// - Chrome/Edge desktop expose the extension on WebGL2; Firefox ships it
//   DISABLED by default (timer-query results were judged a timing-attack
//   side channel); Safari does not expose it at all. So support MUST be
//   feature-detected, never assumed.
// - The GPU runs asynchronously: a TIME_ELAPSED query started now resolves
//   many frames later. Results are therefore polled lazily and a bounded
//   pool of outstanding queries caps driver-side queueing; when the pool is
//   exhausted the pass keeps its CPU-side counters but gets no GPU ms.
// - gl.GPU_DISJOINT_EXT indicates the GPU timestamp domain broke (driver
//   reset, power event). Every pending result is discarded when that fires —
//   a "huge" disjoint-corrupted sample must never enter a ranking.
// - Overhead: ~2 driver calls per pass (~10/frame here). Small, but some
//   drivers serialize around query begin/end, so the timer is enabled ONLY
//   via an explicit opt-in (?gputrace=1 or window.__GPU_TIMER.enable()),
//   mirroring how DEV-PERF-TRACE treats software-rasterizer-sensitive probes.
// - PASS SEGMENTATION does not need the extension at all: bracketing
//   renderer.render calls by render-target switches attributes each pass's
//   renderer.info delta (draw calls, triangles) to its target. With the
//   EffectComposer chain (post.js: sceneAA → aerial → gtao → lateFx → bloom
//   → grade → smaa → upscaler) plus CSM shadow maps, target dims and tags
//   identify passes (cascade-sized square segments = shadow rasters; screen-sized =
//   final AA/upscale). That CPU attribution works everywhere including
//   SwiftShader; the extension only adds true GPU milliseconds on top.
//
// This module monkey-patches NOTHING until enable() is called, restores every
// wrapped method on dispose(), and lives exclusively under src/dev/ — the
// production bundle never imports it (main.js imports src/dev only behind
// import.meta.env.DEV).

const SCREEN_KEY = '|screen';

export const CANONICAL_PASSES = Object.freeze([
  'shadows',
  'opaque',
  'transparent',
  'gtao',
  'lateFx',
  'bloom',
  'grade',
  'smaa',
  'fsr',
  'resolve',
  'aerial',
  'other',
]);

/**
 * Normalizes an arbitrary pass tag or label to a canonical pass name.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizePassName(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes('shadow') || s.includes('csm') || s.includes('cascade')) return 'shadows';
  if (s.includes('gtao') || s.includes('ao') || s.includes('ambientocclusion')) return 'gtao';
  if (s.includes('late') || s.includes('softpart') || s.includes('latefx')) return 'lateFx';
  if (s.includes('bloom') || s.includes('unrealbloom') || s.includes('glow')) return 'bloom';
  if (s.includes('grade') || s.includes('tonemap') || s.includes('outputgrade') || s.includes('aces')) return 'grade';
  if (s.includes('smaa')) return 'smaa';
  if (s.includes('fsr') || s.includes('easu') || s.includes('rcas') || s.includes('upscale')) return 'fsr';
  if (s.includes('aerial') || s.includes('haze')) return 'aerial';
  if (s.includes('resolve') || s.includes('copy') || s.includes('blit')) return 'resolve';
  if (s.includes('transparent') || s.includes('alpha')) return 'transparent';
  if (s.includes('opaque') || s.includes('scene') || s.includes('main')) return 'opaque';
  return raw;
}

/**
 * Heuristically infer pass category from target metadata, dims, and render context.
 * @param {object} targetInfo
 * @param {string|null} currentPassContext
 * @returns {string}
 */
export function classifyPass(targetInfo, currentPassContext = null) {
  if (currentPassContext) {
    const norm = normalizePassName(currentPassContext);
    if (norm) return norm;
  }
  if (!targetInfo) return 'opaque';

  const key = String(targetInfo.key || '').toLowerCase();
  const name = String(targetInfo.name || '').toLowerCase();
  const tag = `${key} ${name}`;

  if (targetInfo.isShadow || tag.includes('shadow') || tag.includes('cascade') || tag.includes('csm')) {
    return 'shadows';
  }
  // Square targets with depth or typical cascade sizes without screen flag
  if (!targetInfo.screen && targetInfo.w > 0 && targetInfo.w === targetInfo.h &&
      [512, 768, 1024, 1536, 2048, 4096].includes(targetInfo.w) &&
      (targetInfo.hasDepth || tag.includes('shadow') || tag.includes('depth'))) {
    return 'shadows';
  }
  if (tag.includes('gtao') || tag.includes('pd_') || tag.includes('ao')) return 'gtao';
  if (tag.includes('late') || tag.includes('latefx') || tag.includes('soft')) return 'lateFx';
  if (tag.includes('bloom') || tag.includes('horizontal') || tag.includes('vertical')) return 'bloom';
  if (tag.includes('grade') || tag.includes('output')) return 'grade';
  if (tag.includes('smaa') || tag.includes('edge') || tag.includes('weight')) return 'smaa';
  if (tag.includes('fsr') || tag.includes('rcas') || tag.includes('easu') || tag.includes('upscale')) return 'fsr';
  if (tag.includes('aerial') || tag.includes('haze')) return 'aerial';
  if (tag.includes('copy') || tag.includes('resolve')) return 'resolve';

  if (targetInfo.screen) {
    // Final draw to default framebuffer
    return 'resolve';
  }
  return 'opaque';
}

function pct(sortedValues, q) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * q))];
}

/**
 * Create the pass timer. Inert until `enable()` succeeds.
 *
 * @param {object} renderer THREE.WebGLRenderer-like object (getContext,
 *   setRenderTarget, render, info)
 * @param {object} [options]
 * @param {() => number} [options.now] injectable clock
 * @param {number} [options.maxPending] outstanding GPU query cap (default 64)
 * @param {number} [options.segmentRing] retained segment records (default 1024)
 * @returns {object} timer facade
 */
export function createGpuPassTimer(renderer, options = {}) {
  const now = options.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const maxPending = options.maxPending ?? 64;
  const ringCap = options.segmentRing ?? 1024;

  const state = {
    enabled: false, supported: false, reason: 'not enabled',
    ext: null, gl: null,
    freeQueries: [], pending: [], // { q, seg }
    segments: [], nextSeq: 1, droppedSegments: 0, disjointEvents: 0,
    openSeg: null, lastTargetKey: null, lastTargetDims: null,
    installed: false, origRender: null, origSetTarget: null,
    queriesCreated: 0,
    currentPassContext: null,
    frameIndex: 0,
  };

  function targetInfo(target) {
    if (!target) return { key: SCREEN_KEY, name: 'screen', w: 0, h: 0, screen: true, isShadow: false, hasDepth: false };
    const isShadow = !!(target.isShadowMap || target._isShadow || target.isDepthRenderTarget ||
      (target.depthTexture && !target.texture));
    const hasDepth = !!(target.depthBuffer || target.depthTexture || isShadow);
    return {
      key: target.uuid || target.name || `t${state.segments.length}`,
      name: target.name || '',
      w: target.width || 0, h: target.height || 0, screen: false,
      isShadow, hasDepth,
    };
  }

  function openSegment(t) {
    const pass = classifyPass(t, state.currentPassContext);
    state.openSeg = {
      seq: state.nextSeq++, pass, key: t.key, name: t.name || '',
      w: t.w, h: t.h, screen: t.screen,
      calls: 0, triangles: 0, renders: 0, openedAt: now(),
      gpuMs: null, q: null, frame: state.frameIndex,
    };
  }

  function closeSegment() {
    const seg = state.openSeg;
    if (!seg) return;
    state.openSeg = null;
    if (seg.renders === 0 && seg.calls === 0 && !seg.q) return; // empty bracket
    if (seg.q) state.pending.push({ q: seg.q, seg });
    state.segments.push(seg);
    if (state.segments.length > ringCap) {
      state.segments.shift();
      state.droppedSegments++;
    }
  }

  /** Close the open segment and open one for the given target. */
  function rollover(t) {
    closeSegment();
    openSegment(t);
    state.lastTargetKey = t.key;
  }

  function wrappedSetRenderTarget(...args) {
    const t = targetInfo(args[0]);
    state.lastTargetKey = t.key;
    state.lastTargetDims = t;
    return state.origSetTarget.apply(renderer, args);
  }

  function wrappedRender(...args) {
    const t = state.lastTargetDims || targetInfo(null);
    if (!state.openSeg || state.openSeg.key !== t.key || (state.currentPassContext && state.openSeg.pass !== normalizePassName(state.currentPassContext))) {
      rollover(t);
    }
    const seg = state.openSeg;
    let q = null;
    if (!seg.q && state.gl && state.ext && state.freeQueries.length + state.pending.length < maxPending) {
      try {
        q = state.freeQueries.length ? state.freeQueries.pop() : state.gl.createQuery();
        state.gl.beginQuery(state.ext.TIME_ELAPSED_EXT, q);
        state.queriesCreated++;
      } catch (_) { q = null; }
    }
    try {
      return state.origRender.apply(renderer, args);
    } finally {
      if (q) {
        try { state.gl.endQuery(state.ext.TIME_ELAPSED_EXT); } catch (_) { /* keep CPU data */ }
        seg.q = q;
      }
      const info = renderer.info?.render;
      seg.calls += info?.calls || 0;
      seg.triangles += info?.triangles || 0;
      seg.renders++;
      if (info?.frame != null) state.frameIndex = info.frame;
    }
  }

  /**
   * Install wrappers + start GPU timing. Safe to call repeatedly; returns
   * false (with .reason) when the extension is required but unavailable.
   * @param {{ requireGpu?: boolean }} [opts] requireGpu=true fails instead of
   *   degrading to CPU-only attribution.
   */
  function enable(opts = {}) {
    if (state.enabled) return true;
    try {
      const gl = renderer.getContext?.();
      if (!gl) { state.reason = 'no GL context'; return false; }
      state.gl = gl;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      state.ext = ext;
      if (!ext) {
        state.supported = false;
        state.reason = 'EXT_disjoint_timer_query_webgl2 unavailable';
        if (opts.requireGpu) return false;
      } else {
        state.supported = true;
        state.reason = '';
      }
    } catch (e) {
      state.reason = `context probe failed: ${e?.message || e}`;
      if (opts.requireGpu) return false;
    }
    if (!state.installed) {
      state.origRender = renderer.render;
      state.origSetTarget = renderer.setRenderTarget;
      renderer.render = wrappedRender;
      renderer.setRenderTarget = wrappedSetRenderTarget;
      state.installed = true;
    }
    state.enabled = true;
    return true;
  }

  /** Unwrap everything; retained resolved segments stay readable. */
  function disable() {
    if (state.installed) {
      renderer.render = state.origRender;
      renderer.setRenderTarget = state.origSetTarget;
      state.installed = false;
    }
    if (state.openSeg) { state.openSeg.q = null; closeSegment(); }
    for (const p of state.pending) {
      try { state.gl?.deleteQuery(p.q); } catch (_) { /* context gone */ }
    }
    for (const q of state.freeQueries) {
      try { state.gl?.deleteQuery(q); } catch (_) {}
    }
    state.pending.length = 0;
    state.freeQueries.length = 0;
    state.enabled = false;
  }

  /**
   * Poll finished GPU queries into their segments. Call at low cadence
   * (snapshot/export time), not per frame.
   * @returns {{ resolved: number, disjoint: boolean }}
   */
  function poll() {
    if (!state.gl || !state.ext) return { resolved: 0, disjoint: false };
    let disjoint = false;
    let resolved = 0;
    try {
      disjoint = !!state.gl.getParameter(state.ext.GPU_DISJOINT_EXT);
    } catch (_) { return { resolved: 0, disjoint: false }; }
    if (disjoint) {
      state.disjointEvents++;
      for (const p of state.pending) {
        p.seg.gpuMs = null;
        try { state.gl.deleteQuery(p.q); } catch (_) { /* gone */ }
      }
      state.pending.length = 0;
      return { resolved: 0, disjoint: true };
    }
    let keep = 0;
    for (let i = 0; i < state.pending.length; i++) {
      const p = state.pending[i];
      let avail = false;
      let ns = 0;
      try {
        avail = !!state.gl.getQueryParameter(p.q, state.gl.QUERY_RESULT_AVAILABLE);
        if (avail) ns = state.gl.getQueryParameter(p.q, state.gl.QUERY_RESULT);
      } catch (_) { avail = false; }
      if (avail) {
        p.seg.gpuMs = ns / 1e6;
        state.freeQueries.push(p.q);
        resolved++;
      } else {
        state.pending[keep++] = p;
      }
    }
    state.pending.length = keep;
    return { resolved, disjoint: false };
  }

  /**
   * Set the active pass label context.
   * @param {string|null} passName
   */
  function setPass(passName) {
    const norm = normalizePassName(passName);
    if (state.currentPassContext !== norm) {
      state.currentPassContext = norm;
      if (state.openSeg && state.openSeg.pass !== norm) {
        closeSegment();
      }
    }
  }

  function clearPass() {
    state.currentPassContext = null;
  }

  function bracketPass(passName, fn) {
    const prev = state.currentPassContext;
    setPass(passName);
    try {
      return fn();
    } finally {
      setPass(prev);
    }
  }

  /**
   * Snapshot of recent pass segments, oldest first.
   */
  function results() {
    poll();
    const out = state.segments.map((s) => ({
      seq: s.seq, pass: s.pass || 'opaque', key: s.key, name: s.name,
      w: s.w, h: s.h, screen: s.screen,
      calls: s.calls, triangles: s.triangles, renders: s.renders,
      gpuMs: s.gpuMs == null ? null : +s.gpuMs.toFixed(4),
      open: false,
    }));
    const seg = state.openSeg;
    if (seg) {
      out.push({
        seq: seg.seq, pass: seg.pass || 'opaque', key: seg.key, name: seg.name,
        w: seg.w, h: seg.h, screen: seg.screen,
        calls: seg.calls, triangles: seg.triangles, renders: seg.renders,
        gpuMs: null, open: true,
      });
    }
    return out;
  }

  /**
   * Aggregated per-pass timing, call and triangle breakdown.
   * Grouped by canonical pass names (shadows, opaque, transparent, GTAO, late FX, bloom, grade, SMAA, FSR, resolve).
   * @returns {Array<object>} array of per-pass breakdown statistics
   */
  function breakdown() {
    poll();
    const groups = new Map();
    let totalAllGpuMs = 0;

    for (const seg of state.segments) {
      const pass = seg.pass || 'opaque';
      let entry = groups.get(pass);
      if (!entry) {
        entry = { pass, segments: 0, gpuSamples: 0, totalGpuMs: 0, gpuMsList: [], callsList: [], trisList: [], totalCalls: 0, totalTriangles: 0 };
        groups.set(pass, entry);
      }
      entry.segments++;
      entry.totalCalls += seg.calls;
      entry.totalTriangles += seg.triangles;
      entry.callsList.push(seg.calls);
      entry.trisList.push(seg.triangles);
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

    const passOrder = new Map(CANONICAL_PASSES.map((name, i) => [name, i]));
    return result.sort((a, b) => {
      const ordA = passOrder.has(a.pass) ? passOrder.get(a.pass) : 999;
      const ordB = passOrder.has(b.pass) ? passOrder.get(b.pass) : 999;
      if (ordA !== ordB) return ordA - ordB;
      return b.totalGpuMs - a.totalGpuMs;
    });
  }

  /**
   * Complete summary of GPU profiling session.
   */
  function summary() {
    poll();
    const bd = breakdown();
    const totalGpuMs = bd.reduce((sum, p) => sum + (p.totalGpuMs || 0), 0);
    const passesMap = Object.fromEntries(bd.map((p) => [p.pass, p]));

    return {
      enabled: state.enabled,
      supported: state.supported,
      reason: state.reason,
      totalSegments: state.segments.length,
      droppedSegments: state.droppedSegments,
      disjointEvents: state.disjointEvents,
      queriesCreated: state.queriesCreated,
      totalGpuMs: +totalGpuMs.toFixed(4),
      passes: passesMap,
      breakdown: bd,
    };
  }

  function clear() {
    state.segments.length = 0;
    state.droppedSegments = 0;
    state.disjointEvents = 0;
    state.nextSeq = 1;
    state.openSeg = null;
    state.lastTargetKey = null;
    state.lastTargetDims = null;
  }

  return {
    enable, disable, poll, results, breakdown, summary, clear,
    setPass, clearPass, bracketPass,
    get enabled() { return state.enabled; },
    get supported() { return state.supported; },
    get reason() { return state.reason; },
    get stats() {
      return {
        enabled: state.enabled, supported: state.supported, reason: state.reason,
        segments: state.segments.length, droppedSegments: state.droppedSegments,
        pendingQueries: state.pending.length, queriesCreated: state.queriesCreated,
        disjointEvents: state.disjointEvents,
      };
    },
  };
}
