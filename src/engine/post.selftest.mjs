import assert from 'node:assert/strict';
import { FsrUpscalePass } from './post.js';
import { PRESETS } from './quality.js';
import { aoSampleCount } from './renderScalePolicy.js';

// Node-runnable coverage for the post chain's pure routing logic. The GL
// passes themselves need a WebGL context (the lead's browser probes own
// that); here we pin the display-tail source wiring and the AO sample
// policy against the preset ladder.

function fakeRenderer() {
  const calls = [];
  let target = null;
  return {
    calls,
    setRenderTarget(t) {
      target = t;
      calls.push({ kind: 'target', target: t && t.texture ? t.texture.name : null });
    },
    // FullScreenQuad.render hands its internal mesh straight to
    // renderer.render(mesh, orthoCamera).
    render(mesh, _camera) {
      const material = mesh.material;
      calls.push({
        kind: 'draw',
        material: material && material.name,
        tDiffuse: material && material.uniforms.tDiffuse
          ? material.uniforms.tDiffuse.value : null,
        target: target && target.texture ? target.texture.name : null,
      });
    },
  };
}

function rt(name, w, h) {
  return {
    texture: { name },
    width: w,
    height: h,
    setSize() {},
  };
}

{
  // Display-tail redirect, no enlargement: RCAS must read the EXTERNAL
  // source (the 8-bit SMAA output), not the composer read buffer.
  const pass = new FsrUpscalePass();
  pass.setOutputSize(800, 600);
  const smaaOut = rt('PostTail.smaa', 800, 600);
  const writeBuffer = rt('composer.write', 800, 600);
  pass.externalSource = smaaOut;
  const renderer = fakeRenderer();
  pass.render(renderer, writeBuffer, rt('composer.read', 800, 600));
  const draws = renderer.calls.filter((c) => c.kind === 'draw');
  assert.equal(renderer.calls[0].target, 'composer.write');
  assert.equal(draws.length, 1,
    'no EASU intermediate when the source already matches the output size');
  assert.equal(draws[0].material, 'FSR1.RCAS');
  assert.equal(draws[0].tDiffuse, smaaOut.texture,
    'RCAS reads the redirected SMAA output');
}

{
  // Enlargement path: EASU runs into the intermediate first, then RCAS
  // samples the intermediate at output texel size with scaled sharpness.
  const pass = new FsrUpscalePass();
  pass.setOutputSize(800, 600);
  pass.externalSource = rt('PostTail.smaa', 400, 300);
  const renderer = fakeRenderer();
  pass.render(renderer, rt('composer.write', 800, 600), rt('composer.read', 400, 300));
  const draws = renderer.calls.filter((c) => c.kind === 'draw');
  assert.deepEqual(draws.map((c) => c.material), ['FSR1.EASU', 'FSR1.RCAS']);
  assert.equal(draws[0].tDiffuse.name, 'PostTail.smaa');
  assert.equal(draws[1].target, 'composer.write');
  assert.equal(draws[1].tDiffuse.name, 'FSR1.EASU',
    'RCAS consumes the EASU intermediate');
  assert.ok(Math.abs(
    pass.rcasMaterial.uniforms.uTexelDelta.value.x - 1 / 800) < 1e-9,
    'RCAS texel delta follows the OUTPUT resolution');
  assert.equal(pass.rcasMaterial.uniforms.uSharpness.value, 0.4,
    'a 2x reconstruction receives the capped sharpness');
}

{
  // Legacy path: no external source falls back to the composer read buffer.
  const pass = new FsrUpscalePass();
  pass.setOutputSize(800, 600);
  const renderer = fakeRenderer();
  pass.render(renderer, rt('composer.write', 800, 600), rt('composer.read', 800, 600));
  const draws = renderer.calls.filter((c) => c.kind === 'draw');
  assert.equal(draws.at(-1).tDiffuse.name, 'composer.read');
}

{
  // AO sample policy must track the preset ladder: full-res AO (ultra)
  // keeps the 16-tap inspection profile; temporally accumulated presets
  // run eight fresh taps; disabled AO reports the same profile.
  for (const [name, p] of Object.entries(PRESETS)) {
    const expected = (p.aoScale || 0) >= 0.99 ? 16 : 8;
    assert.equal(aoSampleCount(p.aoScale), expected,
      `${name} preset AO sample profile`);
  }
}

console.log('post self-test passed');
