import assert from 'node:assert/strict';
import { createGpuPassTimer } from './gpuTimer.js';

/**
 * Minimal WebGL2 + EXT_disjoint_timer_query_webgl2 stub. Queries resolve to a
 * fixed duration once endQuery ran; `disjoint` simulates a broken timestamp
 * domain; `available` gates QUERY_RESULT_AVAILABLE.
 */
function makeGl({ supported = true, available = true } = {}) {
  const gl = {
    _next: 1,
    _ended: new Map(),
    createQuery() { return { id: this._next++ }; },
    deleteQuery(q) { this._deleted = (this._deleted || 0) + 1; },
    beginQuery() {},
    endQuery(_type, ...rest) {
      // three-style signature guard: our timer calls endQuery(type) only.
      void rest;
    },
    getParameter(pname) {
      if (pname === 'DISJOINT') return gl.disjoint;
      throw new Error('unstubbed pname');
    },
    getQueryParameter(q, pname) {
      if (pname === 'AVAILABLE') return available && gl._ended.has(q.id);
      if (pname === 'RESULT') return 2_500_000; // 2.5 ms in ns
      throw new Error('unstubbed query pname');
    },
  };
  gl.QUERY_RESULT_AVAILABLE = 'AVAILABLE';
  gl.QUERY_RESULT = 'RESULT';
  gl.disjoint = false;
  if (supported) {
    gl.ext = {
      TIME_ELAPSED_EXT: 'TIME_ELAPSED',
      GPU_DISJOINT_EXT: 'DISJOINT',
    };
    gl.getExtension = (name) => (name === 'EXT_disjoint_timer_query_webgl2' ? gl.ext : null);
  } else {
    gl.getExtension = () => null;
  }
  return gl;
}

/** Renderer stub whose render() mimics three: reset info, then "draw". */
function makeRenderer(gl) {
  const targets = [];
  const renderer = {
    info: { render: { frame: 0, calls: 0, triangles: 0 } },
    getContext: () => gl,
    setRenderTarget(target) { renderer.current = target; },
    render() {
      renderer.info.render.frame++;
      renderer.info.render.calls = renderer.nextCalls || 1;
      renderer.info.render.triangles = renderer.nextTris || 100;
    },
  };
  for (let i = 0; i < 4; i++) {
    targets.push({ uuid: `rt-${i}`, width: 1024, height: 1024 });
  }
  renderer.targets = targets;
  return renderer;
}

// --- CPU-only attribution works without the extension -------------------------
{
  const gl = makeGl({ supported: false });
  const renderer = makeRenderer(gl);
  const timer = createGpuPassTimer(renderer);
  assert.equal(timer.enable(), true, 'degrades to CPU-only attribution');
  assert.equal(timer.supported, false);
  assert.match(timer.reason, /unavailable/);

  const [shadow, sceneRt] = renderer.targets;
  // Pass 1: shadow cascade raster (2048² would be typical; dims are recorded
  // verbatim from the target).
  shadow.width = 2048; shadow.height = 2048;
  renderer.setRenderTarget(shadow);
  renderer.nextCalls = 40; renderer.nextTris = 90_000;
  renderer.render();
  // Pass 2: main scene into the composer target.
  renderer.setRenderTarget(sceneRt);
  renderer.nextCalls = 300; renderer.nextTris = 1_200_000;
  renderer.render();
  // Pass 3: final pass straight to the canvas.
  renderer.setRenderTarget(null);
  renderer.nextCalls = 6; renderer.nextTris = 5_000;
  renderer.render();

  const segs = timer.results();
  assert.equal(segs.length, 3, 'one segment per render-target switch');
  assert.equal(segs[0].w, 2048);
  assert.equal(segs[0].calls, 40);
  assert.equal(segs[0].triangles, 90_000);
  assert.equal(segs[1].key, 'rt-1');
  assert.equal(segs[1].calls, 300);
  assert.equal(segs[2].screen, true, 'null target is the screen pass');
  assert.ok(segs.every((s) => s.gpuMs === null), 'no GPU ms without the extension');

  timer.disable();
  assert.equal(renderer.render.name, 'render', 'originals restored by disable()');
}

// --- GPU queries resolve through poll(); disjoint discards --------------------
{
  const gl = makeGl({});
  const renderer = makeRenderer(gl);
  const timer = createGpuPassTimer(renderer);
  assert.equal(timer.enable(), true);
  assert.equal(timer.supported, true);

  const [rtA, rtB] = renderer.targets;
  renderer.setRenderTarget(rtA);
  renderer.nextCalls = 10;
  renderer.render();
  renderer.setRenderTarget(rtB);
  renderer.nextCalls = 20;
  renderer.render();

  let segs = timer.results();
  assert.equal(segs.length, 2, 'closed segment + trailing in-progress segment');
  assert.equal(segs[0].gpuMs, null, 'not yet resolved on first poll');
  assert.equal(segs[1].open, true, 'current pass reported as in-progress');
  assert.equal(timer.stats.pendingQueries, 1);

  gl._ended.set(1, true); // first query finished on the GPU timeline
  segs = timer.results();
  assert.equal(segs[0].gpuMs, 2.5, 'resolved ns → ms');
  assert.equal(segs[1].gpuMs, null);
  assert.equal(timer.stats.pendingQueries, 0);

  gl.disjoint = true; // timestamp domain broke — PENDING results are garbage
  segs = timer.results();
  assert.equal(segs[0].gpuMs, 2.5, 'already-resolved history stays valid');
  assert.ok(segs.slice(1).every((s) => s.gpuMs === null), 'unresolved work gets no number');
  assert.equal(timer.stats.disjointEvents, 1);
  assert.equal(timer.stats.pendingQueries, 0);
}

// --- explicit-off default and pool cap ----------------------------------------
{
  const gl = makeGl({});
  const renderer = makeRenderer(gl);
  const timer = createGpuPassTimer(renderer, { maxPending: 1 });
  assert.equal(timer.enabled, false, 'inert until enable()');
  assert.equal(renderer.render.name, 'render', 'no wrapping before enable()');
  timer.enable();
  const [a, b, c] = renderer.targets;
  for (const rt of [a, b, c]) {
    renderer.setRenderTarget(rt);
    renderer.render();
  }
  const stats = timer.stats;
  assert.ok(stats.queriesCreated <= 1, `pool cap respected (${stats.queriesCreated})`);
  assert.equal(stats.segments, 2, 'closed segments keep CPU counters when pool is full');
  const segs = timer.results();
  assert.equal(segs.length, 3, 'plus the trailing in-progress segment');
  assert.equal(segs[2].open, true);
}
// --- requireGpu refuses to install CPU-only when the extension is missing -----
{
  const gl = makeGl({ supported: false });
  const renderer = makeRenderer(gl);
  const timer = createGpuPassTimer(renderer);
  assert.equal(timer.enable({ requireGpu: true }), false);
  assert.equal(timer.enabled, false);
  assert.equal(renderer.render.name, 'render', 'nothing wrapped on refusal');
}

console.log('gpuTimer selftest: pass');
