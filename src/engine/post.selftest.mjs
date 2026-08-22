import assert from "node:assert/strict";
import * as THREE from "three";
import {
  FsrUpscalePass,
  LateFxPass,
  SceneAAPass,
  TAAPass,
  sceneResolveCopyEliminated,
  setComposerDepthAttachments,
} from "./post.js";
import { PRESETS } from "./quality.js";
import { aoSampleCount } from "./renderScalePolicy.js";

// Node-runnable coverage for the post chain's pure routing logic. The GL
// passes themselves need a WebGL context (the lead's browser probes own
// that); here we pin the display-tail source wiring, the AO sample policy
// against the preset ladder, and the WA8 scene resolve-copy elimination
// policy/routing (policy purity, direct vs stock SceneAAPass routing, composer
// buffer depth parity, LateFx active-depth sourcing).

function fakeRenderer() {
  const calls = [];
  let target = null;
  return {
    calls,
    setRenderTarget(t) {
      target = t;
      calls.push({
        kind: "target",
        target: t && t.texture ? t.texture.name : null,
      });
    },
    // FullScreenQuad.render hands its internal mesh straight to
    // renderer.render(mesh, orthoCamera).
    render(mesh, _camera) {
      const material = mesh.material;
      calls.push({
        kind: "draw",
        material: material && material.name,
        tDiffuse:
          material && material.uniforms.tDiffuse
            ? material.uniforms.tDiffuse.value
            : null,
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
  const smaaOut = rt("PostTail.smaa", 800, 600);
  const writeBuffer = rt("composer.write", 800, 600);
  pass.externalSource = smaaOut;
  const renderer = fakeRenderer();
  pass.render(renderer, writeBuffer, rt("composer.read", 800, 600));
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.equal(renderer.calls[0].target, "composer.write");
  assert.equal(
    draws.length,
    1,
    "no EASU intermediate when the source already matches the output size",
  );
  assert.equal(draws[0].material, "FSR1.RCAS");
  assert.equal(
    draws[0].tDiffuse,
    smaaOut.texture,
    "RCAS reads the redirected SMAA output",
  );
}

{
  // Enlargement path: EASU runs into the intermediate first, then RCAS
  // samples the intermediate at output texel size with scaled sharpness.
  const pass = new FsrUpscalePass();
  pass.setOutputSize(800, 600);
  pass.externalSource = rt("PostTail.smaa", 400, 300);
  const renderer = fakeRenderer();
  pass.render(
    renderer,
    rt("composer.write", 800, 600),
    rt("composer.read", 400, 300),
  );
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.deepEqual(
    draws.map((c) => c.material),
    ["FSR1.EASU", "FSR1.RCAS"],
  );
  assert.equal(draws[0].tDiffuse.name, "PostTail.smaa");
  assert.equal(draws[1].target, "composer.write");
  assert.equal(
    draws[1].tDiffuse.name,
    "FSR1.EASU",
    "RCAS consumes the EASU intermediate",
  );
  assert.ok(
    Math.abs(pass.rcasMaterial.uniforms.uTexelDelta.value.x - 1 / 800) < 1e-9,
    "RCAS texel delta follows the OUTPUT resolution",
  );
  assert.equal(
    pass.rcasMaterial.uniforms.uSharpness.value,
    0.4,
    "a 2x reconstruction receives the capped sharpness",
  );
}

{
  // Legacy path: no external source falls back to the composer read buffer.
  const pass = new FsrUpscalePass();
  pass.setOutputSize(800, 600);
  const renderer = fakeRenderer();
  pass.render(
    renderer,
    rt("composer.write", 800, 600),
    rt("composer.read", 800, 600),
  );
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.equal(draws.at(-1).tDiffuse.name, "composer.read");
}

{
  // AO sample policy must track the preset ladder: full-res AO (ultra)
  // keeps the 16-tap inspection profile; temporally accumulated presets
  // run eight fresh taps; disabled AO reports the same profile.
  for (const [name, p] of Object.entries(PRESETS)) {
    const expected = (p.aoScale || 0) >= 0.99 ? 16 : 8;
    assert.equal(
      aoSampleCount(p.aoScale),
      expected,
      `${name} preset AO sample profile`,
    );
  }
}

// --- WA8 scene resolve-copy elimination -------------------------------------

// Fake renderer for the scene/late-FX passes: FullScreenQuad.render hands its
// internal mesh to renderer.render(mesh, orthoCamera) while a RenderPass
// hands the real Scene — distinguish them via .isScene.
function passRenderer() {
  const calls = [];
  let target = null;
  const nameOf = (t) => (t && t.texture ? t.texture.name : null);
  return {
    calls,
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    setRenderTarget(t) {
      target = t;
      calls.push({ kind: "target", target: nameOf(t) });
    },
    clear() {
      calls.push({ kind: "clear", target: nameOf(target) });
    },
    initRenderTarget(t) {
      calls.push({ kind: "init", target: nameOf(t) });
    },
    copyTextureToTexture(src, dst) {
      calls.push({ kind: "copyDepth", src, dst });
    },
    render(arg0, _arg1) {
      if (arg0 && arg0.isScene) {
        calls.push({ kind: "scene", target: nameOf(target) });
        return;
      }
      calls.push({
        kind: "draw",
        material: arg0.material && arg0.material.name,
        tDiffuse:
          arg0.material && arg0.material.uniforms.tDiffuse
            ? arg0.material.uniforms.tDiffuse.value
            : null,
        target: nameOf(target),
      });
    },
  };
}

function depthRt(name, w = 64, h = 32) {
  return {
    texture: { name },
    depthTexture: { name: `${name}.depth` },
    width: w,
    height: h,
    setSize() {},
  };
}

{
  // Policy purity: the resolve copy is redundant ONLY at zero MSAA and only
  // when the QA bisect hook does not force the stock path.
  assert.equal(
    sceneResolveCopyEliminated(0, false),
    true,
    "zero-MSAA eliminates the resolve copy",
  );
  assert.equal(
    sceneResolveCopyEliminated(2, false),
    false,
    "2x MSAA keeps the stock multisample path",
  );
  assert.equal(
    sceneResolveCopyEliminated(4, false),
    false,
    "4x MSAA keeps the stock multisample path",
  );
  assert.equal(
    sceneResolveCopyEliminated(0, true),
    false,
    "the __SCENE_RESOLVE_COPY bisect hook forces the stock path",
  );
  for (const [name, p] of Object.entries(PRESETS)) {
    const samples = p.msaaSamples || 0;
    assert.equal(
      sceneResolveCopyEliminated(samples, false),
      samples === 0,
      `${name} preset resolve-copy policy`,
    );
  }
}

{
  // Direct routing (msaaSamples === 0): the scene rasterizes straight into
  // the composer read buffer, no fullscreen copy draw runs, and the frame's
  // depth is published BEFORE any downstream consumer could run.
  const sceneTarget = depthRt("SceneAAPass.color");
  const pass = new SceneAAPass(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
    sceneTarget,
  );
  pass.directResolve = true;
  const published = [];
  pass.onSceneRendered = (d) => published.push(d);
  const readBuffer = depthRt("composer.read");
  const renderer = passRenderer();
  pass.render(renderer, depthRt("composer.write"), readBuffer);
  const scenes = renderer.calls.filter((c) => c.kind === "scene");
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.equal(scenes.length, 1, "direct mode renders the scene exactly once");
  assert.equal(
    scenes[0].target,
    "composer.read",
    "the scene rasterizes into the composer read buffer",
  );
  assert.equal(draws.length, 0, "direct mode performs no resolve-copy draw");
  assert.equal(published.length, 1, "depth published once per frame");
  assert.equal(
    published[0],
    readBuffer.depthTexture,
    "the published depth is the buffer the scene was rendered into",
  );
  assert.equal(renderer.autoClear, true, "renderer autoClear restored");
}

{
  // Stock routing (MSAA > 0): unchanged behavior — own target, one copy draw
  // reading sceneTarget, hook reports sceneTarget's depth.
  const sceneTarget = depthRt("SceneAAPass.color");
  const pass = new SceneAAPass(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
    sceneTarget,
  );
  const published = [];
  pass.onSceneRendered = (d) => published.push(d);
  const readBuffer = depthRt("composer.read");
  const renderer = passRenderer();
  pass.render(renderer, depthRt("composer.write"), readBuffer);
  const scenes = renderer.calls.filter((c) => c.kind === "scene");
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.equal(scenes.length, 1);
  assert.equal(
    scenes[0].target,
    "SceneAAPass.color",
    "stock mode renders into its own multisampled target",
  );
  assert.deepEqual(
    draws.map((c) => c.material),
    ["SceneAAPass.Copy"],
  );
  assert.equal(
    draws[0].tDiffuse,
    sceneTarget.texture,
    "the resolve copy reads the scene target",
  );
  assert.equal(
    draws[0].target,
    "composer.read",
    "the resolve copy lands in the composer read buffer",
  );
  assert.deepEqual(
    published,
    [sceneTarget.depthTexture],
    "stock mode publishes the scene target depth",
  );
}

{
  // Buffer parity helper: each ping-pong buffer gets its OWN DepthTexture
  // (a shared attachment would be a sampling feedback loop on every sibling
  // draw), depthBuffer follows the texture (setupRenderTarget only wires
  // depth when it is true), attach/detach are idempotent.
  const rt1 = new THREE.WebGLRenderTarget(64, 32, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const rt2 = rt1.clone();
  setComposerDepthAttachments([rt1, rt2], true);
  for (const rt of [rt1, rt2]) {
    assert.ok(
      rt.depthTexture instanceof THREE.DepthTexture,
      "direct mode attaches a DepthTexture",
    );
    assert.equal(
      rt.depthBuffer,
      true,
      "depthBuffer follows the attached texture",
    );
    assert.equal(rt.depthTexture.image.width, 64);
    assert.equal(rt.depthTexture.image.height, 32);
  }
  assert.notEqual(
    rt1.depthTexture,
    rt2.depthTexture,
    "each buffer owns its depth attachment",
  );
  const keep1 = rt1.depthTexture;
  const keep2 = rt2.depthTexture;
  setComposerDepthAttachments([rt1, rt2], true);
  assert.equal(rt1.depthTexture, keep1, "re-apply keeps existing attachments");
  assert.equal(rt2.depthTexture, keep2);
  setComposerDepthAttachments([rt1, rt2], false);
  for (const rt of [rt1, rt2]) {
    assert.equal(
      rt.depthTexture,
      null,
      "stock mode detaches the depth texture",
    );
    assert.equal(
      rt.depthBuffer,
      false,
      "stock mode restores depthless buffers",
    );
  }
  setComposerDepthAttachments([rt1, rt2], false); // idempotent detach
  rt1.dispose();
  rt2.dispose();
}

{
  // LateFx depth sourcing: the pass copies and publishes whichever depth the
  // scene pass published this frame (composer-buffer depth in direct mode),
  // not hardcoded sceneTarget state; direct mode also skips the sceneTarget
  // warm-up allocation.
  const sceneTarget = depthRt("SceneAAPass.color");
  const lateTarget = depthRt("SceneAAPass.lateColor");
  const softState = {
    isActive: () => true,
    uSceneDepth: { value: null },
    uSoftViewport: { value: new THREE.Vector2() },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 4000 },
  };
  const lateFx = new LateFxPass(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
    sceneTarget,
    lateTarget,
    softState,
  );
  assert.equal(
    lateFx.sceneDepthTexture,
    sceneTarget.depthTexture,
    "pre-first-frame default is the stock depth source",
  );
  const activeDepth = { name: "composer.read.depth" };
  lateFx.sceneDepthTexture = activeDepth; // what the repointer would do
  lateFx.skipSceneTargetWarmup = true;
  const renderer = passRenderer();
  lateFx.render(renderer, depthRt("composer.write"), depthRt("composer.read"));
  const inits = renderer.calls
    .filter((c) => c.kind === "init")
    .map((c) => c.target);
  assert.ok(
    !inits.includes("SceneAAPass.color"),
    "direct mode never allocates the unused scene target",
  );
  assert.ok(
    inits.includes("SceneAAPass.lateColor"),
    "the late-FX composite target is still warmed",
  );
  const depthCopies = renderer.calls.filter((c) => c.kind === "copyDepth");
  assert.equal(depthCopies.length, 1, "one soft-depth copy per active frame");
  assert.equal(
    depthCopies[0].src,
    activeDepth,
    "the depth copy reads the ACTIVE scene depth",
  );
  assert.equal(depthCopies[0].dst, lateTarget.depthTexture);
  assert.equal(
    softState.uSceneDepth.value,
    activeDepth,
    "soft particles sample the ACTIVE scene depth",
  );
  assert.equal(lateFx.needsSwap, true, "an active late-FX frame swaps");
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.equal(
    draws.at(-1).tDiffuse,
    lateTarget.texture,
    "the composite copy hands the FX frame back to the chain",
  );

  // Stock warm-up behavior is preserved when the flag is unset.
  const lateFxStock = new LateFxPass(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
    sceneTarget,
    lateTarget,
    null,
  );
  const stockRenderer = passRenderer();
  lateFxStock.prepare(stockRenderer);
  const stockInits = stockRenderer.calls
    .filter((c) => c.kind === "init")
    .map((c) => c.target);
  assert.ok(
    stockInits.includes("SceneAAPass.color"),
    "stock mode still warms the scene target",
  );
  assert.ok(stockInits.includes("SceneAAPass.lateColor"));
}

{
  // TAAPass routing & lifecycle test:
  // - Default disabled state (zero overhead when off)
  // - Enabling routes ping-pong accumulation draw
  // - forceConverge resets seed timestamp
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
  const taa = new TAAPass(camera);
  assert.equal(
    taa.enabled,
    false,
    "TAA must be default OFF behind feature gate",
  );
  assert.equal(taa.blendK, 0.1);

  taa.setSize(800, 600);
  assert.equal(taa.historyTarget1.width, 800);
  assert.equal(taa.historyTarget1.height, 600);
  assert.ok(Math.abs(taa.material.uniforms.uTexel.value.x - 1 / 800) < 1e-9);

  // Disabled render: no draw calls
  const renderer = passRenderer();
  taa.render(renderer, depthRt("composer.write"), depthRt("composer.read"));
  assert.equal(renderer.calls.length, 0, "disabled TAA pass performs no draws");

  // Enabled render: renders into history and write buffer
  taa.enabled = true;
  taa.sceneDepthTexture = { name: "SceneAAPass.depth" };
  taa.render(renderer, depthRt("composer.write"), depthRt("composer.read"));
  const draws = renderer.calls.filter((c) => c.kind === "draw");
  assert.ok(draws.length >= 1, "enabled TAA pass performs accumulation draw");

  // forceConverge reset
  taa.forceConverge();
  assert.equal(taa.lastMs, -1e9, "forceConverge resets seed timestamp");
  taa.dispose();
}

{
  // SceneAAPass camera jitter test:
  // - When taaEnabled is false: camera projection matrix is untouched
  // - When taaEnabled is true: projection matrix is jittered during render,
  //   cleanly unjittered after render, and advances jitterIndex
  const sceneTarget = depthRt("SceneAAPass.color");
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
  camera.updateProjectionMatrix();
  const initialProj8 = camera.projectionMatrix.elements[8];
  const initialProj9 = camera.projectionMatrix.elements[9];

  const pass = new SceneAAPass(new THREE.Scene(), camera, sceneTarget);
  pass.directResolve = true;
  pass.onSceneRendered = () => {};
  const renderer = passRenderer();

  // 1. Off state (default)
  pass.render(renderer, depthRt("composer.write"), depthRt("composer.read"));
  assert.equal(pass.jitterIndex, 0);
  assert.equal(camera.projectionMatrix.elements[8], initialProj8);
  assert.equal(camera.projectionMatrix.elements[9], initialProj9);

  // 2. On state
  pass.taaEnabled = true;
  pass.setSize(1920, 1080);
  pass.render(renderer, depthRt("composer.write"), depthRt("composer.read"));
  assert.equal(
    pass.jitterIndex,
    1,
    "jitterIndex advances after jittered render",
  );
  assert.ok(
    Math.abs(camera.projectionMatrix.elements[8] - initialProj8) < 1e-12,
    "projection matrix must be unjittered after scene pass completion",
  );
  assert.ok(
    Math.abs(camera.projectionMatrix.elements[9] - initialProj9) < 1e-12,
  );
}

console.log("post self-test passed");

// --- W02 cold-boot: settleProgramLinks contract -----------------------------
// Node-runnable with a fake renderer: pins the parallel-link window's
// fallback semantics (the boot post stage's first composer render must never
// regress when KHR_parallel_shader_compile is absent) and the poll/discover
// shape when it is present.
import { settleProgramLinks } from "./post.js";

function fakeGlLinkRenderer({ extension }) {
  const programs = [];
  let polls = 0;
  const gl = {
    getExtension(name) {
      if (name !== "KHR_parallel_shader_compile") return null;
      return extension
        ? { COMPLETION_STATUS_KHR: "COMPLETION_STATUS_KHR" }
        : null;
    },
    getProgramParameter(_program, query) {
      if (query !== "COMPLETION_STATUS_KHR")
        throw new Error("unexpected query");
      polls++;
      // every listed program reports linked after exactly 3 poll rounds
      return polls > 3;
    },
  };
  return {
    gl,
    getContext() {
      return gl;
    },
    info: { programs },
    addProgram(id, uniformsThrow = false) {
      programs.push({
        program: { id },
        getUniforms() {
          if (uniformsThrow) throw new Error("discovery must tolerate this");
          return { id };
        },
      });
    },
  };
}

{
  // 1. Without the extension: immediate legacy fallback — zero rounds, zero
  // breathing, and NO discovery (today's behavior; the real render owns it).
  const r = fakeGlLinkRenderer({ extension: false });
  r.addProgram(1);
  const out = await settleProgramLinks(r, async () => {});
  assert.equal(out.parallel, false, "no-extension must not claim parallel");
  assert.equal(out.rounds, 0);
  assert.equal(
    out.discovered,
    0,
    "fallback leaves discovery to the real render",
  );
}

{
  // 2. With the extension: breathes one frame per round until the batch
  // reports complete, then discovers every program exactly once each.
  const r = fakeGlLinkRenderer({ extension: true });
  r.addProgram(1);
  r.addProgram(2);
  let breathes = 0;
  const out = await settleProgramLinks(r, async () => {
    breathes++;
  });
  assert.equal(out.parallel, true, "extension present must use the window");
  assert.equal(out.rounds, 3, "one frame per poll round until complete");
  assert.equal(breathes, 3, "breathe called once per round");
  assert.equal(out.discovered, 2, "deferred discovery covers every program");
}

{
  // 3. A throwing getUniforms must not escape warm-only discovery.
  const r = fakeGlLinkRenderer({ extension: true });
  r.addProgram(1, true);
  r.addProgram(2, false);
  const out = await settleProgramLinks(r, null); // null breathe: still safe
  assert.equal(out.discovered >= 0, true);
}

{
  // 4. Missing/invalid breathe callback: immediate return, legacy path.
  const r = fakeGlLinkRenderer({ extension: true });
  r.addProgram(1);
  const out = await settleProgramLinks(r, undefined);
  assert.equal(out.parallel, false);
  assert.equal(out.ms >= 0, true);
}
