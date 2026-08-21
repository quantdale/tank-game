import assert from 'node:assert/strict';
import { createOffscreenSceneWarmer } from './offscreenWarm.js';

function fakeRenderer({ throwOnRender = false } = {}) {
  const prior = { name: 'prior-target' };
  const calls = [];
  let current = prior;
  // Mutable so tests can simulate a window/render-scale change between warms.
  const bufferSize = { x: 2000, y: 1000 };
  // Expected per-render target dims; tests mutate alongside bufferSize.
  const expect = { width: 500, height: 250 };
  return {
    prior,
    calls,
    bufferSize,
    expect,
    getDrawingBufferSize(out) { return out.set(bufferSize.x, bufferSize.y); },
    getRenderTarget() { return current; },
    getActiveCubeFace() { return 3; },
    getActiveMipmapLevel() { return 2; },
    setViewport() { assert.fail('warm-up must not mutate the canvas viewport'); },
    setRenderTarget(target, face = 0, mip = 0) {
      current = target;
      calls.push({ kind: 'target', target, face, mip });
    },
    render(scene, camera) {
      assert.notEqual(current, null, 'warm-up rendered to the default framebuffer');
      assert.notEqual(current, prior, 'warm-up rendered into the caller target');
      assert.equal(current.width, expect.width);
      assert.equal(current.height, expect.height);
      calls.push({ kind: 'render', scene, camera, target: current });
      if (throwOnRender) throw new Error('synthetic render failure');
    },
  };
}

{
  const renderer = fakeRenderer();
  const scene = { name: 'scene' };
  const camera = { name: 'camera' };
  const warm = createOffscreenSceneWarmer(renderer, scene, camera);
  warm();

  assert.equal(renderer.calls[0].kind, 'target');
  assert.equal(renderer.calls[1].kind, 'render');
  assert.deepEqual(renderer.calls.at(-1), {
    kind: 'target', target: renderer.prior, face: 3, mip: 2,
  });
}

{
  const renderer = fakeRenderer({ throwOnRender: true });
  const warm = createOffscreenSceneWarmer(renderer, {}, {});
  assert.throws(() => warm(), /synthetic render failure/);
  assert.deepEqual(renderer.calls.at(-1), {
    kind: 'target', target: renderer.prior, face: 3, mip: 2,
  }, 'the caller render target must be restored after a failed warm-up');
}

{
  const renderer = fakeRenderer();
  const warm = createOffscreenSceneWarmer(renderer, {}, {});
  assert.equal(warm.getTarget(), null, 'initial target must be null before first warm call');
  warm();
  const target = warm.getTarget();
  assert.notEqual(target, null, 'target must be created on first warm call');
  let disposed = false;
  target.dispose = () => { disposed = true; };
  warm.dispose();
  assert.equal(disposed, true, 'dispose must call target.dispose()');
  assert.equal(warm.getTarget(), null, 'target reference must be null after dispose');
}

{
  // A window/render-scale change between warm calls (real battle-open case:
  // the entry warm straddles a resize) must resize the EXISTING target, not
  // allocate a second one and orphan the first.
  const renderer = fakeRenderer();
  const warm = createOffscreenSceneWarmer(renderer, {}, {});
  warm();
  const first = warm.getTarget();
  renderer.bufferSize.x = 1000;
  renderer.bufferSize.y = 500;
  renderer.expect.width = 250;
  renderer.expect.height = 125;
  warm();
  assert.equal(warm.getTarget(), first, 'resize must reuse the existing target');
  assert.equal(first.width, 250, 'target width must track the new drawing buffer');
  assert.equal(first.height, 125, 'target height must track the new drawing buffer');
  // dispose is idempotent: a second call after release must be a safe no-op.
  warm.dispose();
  warm.dispose();
  assert.equal(warm.getTarget(), null);
}

{
  // Custom scale is honored, and sub-8px results clamp to the 8px floor so a
  // degenerate buffer size can never produce an invalid (0-wide) target.
  const renderer = fakeRenderer();
  const half = createOffscreenSceneWarmer(renderer, {}, {}, 0.5);
  renderer.expect.width = 1000;
  renderer.expect.height = 500;
  half();
  assert.equal(half.getTarget().width, 1000);
  assert.equal(half.getTarget().height, 500);
  const clamped = createOffscreenSceneWarmer(renderer, {}, {}, 0.004);
  renderer.expect.width = 8;
  renderer.expect.height = 8;
  clamped(); // 2000*0.004 = 8 ok, but 1000*0.004 = 4 -> both clamp to 8
  assert.equal(clamped.getTarget().width, 8);
  assert.equal(clamped.getTarget().height, 8);
}

console.log('offscreenWarm self-test passed');
