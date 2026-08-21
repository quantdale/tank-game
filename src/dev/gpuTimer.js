// Development-only per-pass GPU timer + render-pass segmenter (campaign W1).
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
//   → grade → smaa → upscaler) plus CSM shadow maps, target dims identify
//   passes (cascade-sized square segments = shadow rasters; screen-sized =
//   final AA/upscale). That CPU attribution works everywhere including
//   SwiftShader; the extension only adds true GPU milliseconds on top.
//
// This module monkey-patches NOTHING until enable() is called, restores every
// wrapped method on dispose(), and lives exclusively under src/dev/ — the
// production bundle never imports it (main.js imports src/dev only behind
// import.meta.env.DEV).

const SCREEN_KEY = '|screen';

/**
 * Create the pass timer. Inert until `enable()` succeeds.
 *
 * @param {object} renderer THREE.WebGLRenderer-like object (getContext,
 *   setRenderTarget, render, info)
 * @param {object} [options]
 * @param {() => number} [options.now] injectable clock
 * @param {number} [options.maxPending] outstanding GPU query cap (default 64)
 * @param {number} [options.segmentRing] retained segment records (default 512)
 * @returns {object} timer facade
 */
export function createGpuPassTimer(renderer, options = {}) {
  const now = options.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const maxPending = options.maxPending ?? 64;
  const ringCap = options.segmentRing ?? 512;

  const state = {
    enabled: false, supported: false, reason: 'not enabled',
    ext: null, gl: null,
    freeQueries: [], pending: [], // { q, seg }
    segments: [], nextSeq: 1, droppedSegments: 0, disjointEvents: 0,
    openSeg: null, lastTargetKey: null, lastTargetDims: null,
    installed: false, origRender: null, origSetTarget: null,
    queriesCreated: 0,
  };

  function targetInfo(target) {
    if (!target) return { key: SCREEN_KEY, w: 0, h: 0, screen: true };
    return {
      key: target.uuid || `t${state.segments.length}`,
      w: target.width || 0, h: target.height || 0, screen: false,
    };
  }

  function openSegment(t) {
    state.openSeg = {
      seq: state.nextSeq++, key: t.key, w: t.w, h: t.h, screen: t.screen,
      calls: 0, triangles: 0, renders: 0, openedAt: now(),
      gpuMs: null, q: null,
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
    // Record what the NEXT render() will draw into; the segment actually
    // opens inside wrappedRender so probe renders that never call render()
    // do not leave empty segments behind.
    state.lastTargetKey = t.key;
    state.lastTargetDims = t;
    return state.origSetTarget.apply(renderer, args);
  }

  function wrappedRender(...args) {
    const t = state.lastTargetDims || targetInfo(null);
    if (!state.openSeg || state.openSeg.key !== t.key) rollover(t);
    const seg = state.openSeg;
    let q = null;
    // One query per segment: the first render brackets the whole segment.
    // A later render into the same target must not overwrite a live query
    // (that would orphan it un-polled and undeleted).
    if (!seg.q && state.gl && state.ext && state.freeQueries.length + state.pending.length < maxPending) {
      try {
        q = state.gl.createQuery();
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
      // three resets info at the START of each render (autoReset), so the
      // post-render snapshot is exactly THIS pass's contribution.
      const info = renderer.info?.render;
      seg.calls += info?.calls || 0;
      seg.triangles += info?.triangles || 0;
      seg.renders++;
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
    state.pending.length = 0;
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
      // Timestamp domain broke: every outstanding duration is garbage.
      state.disjointEvents++;
      for (const p of state.pending) {
        p.seg.gpuMs = null;
        try { state.gl.deleteQuery(p.q); } catch (_) { /* gone */ }
        state.freeQueries.push(p.q);
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
   * Snapshot of recent pass segments, oldest first. The currently open
   * segment (if any) trails as an in-progress record (`open: true`) so a
   * probe can read the live pass without waiting for a target switch.
   * Allocates freely — this is an export-time diagnostic path, never a hot
   * loop.
   */
  function results() {
    poll();
    const out = state.segments.map((s) => ({
      seq: s.seq, key: s.key, w: s.w, h: s.h, screen: s.screen,
      calls: s.calls, triangles: s.triangles, renders: s.renders,
      gpuMs: s.gpuMs == null ? null : +s.gpuMs.toFixed(4),
      open: false,
    }));
    const seg = state.openSeg;
    if (seg) {
      out.push({
        seq: seg.seq, key: seg.key, w: seg.w, h: seg.h, screen: seg.screen,
        calls: seg.calls, triangles: seg.triangles, renders: seg.renders,
        gpuMs: null, open: true,
      });
    }
    return out;
  }

  return {
    enable, disable, poll, results,
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
