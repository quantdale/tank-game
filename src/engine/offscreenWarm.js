/**
 * offscreenWarm.js — real scene renders for shader/texture warm-up without
 * ever presenting the warm frame on the game canvas.
 *
 * renderer.compile() does not exercise every draw-time path, so combat still
 * needs a few real renders before play. Those renders intentionally use a
 * small target to keep the fragment bill low; keeping that target offscreen
 * also guarantees a long first-use compile cannot expose its partial frame.
 */
import * as THREE from 'three';

/**
 * Create a reusable quarter-resolution scene warmer.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {number} [scale]
 * @returns {() => void}
 */
export function createOffscreenSceneWarmer(renderer, scene, camera, scale = 0.25) {
  const size = new THREE.Vector2();
  let target = null;

  function warmSceneOffscreen() {
    renderer.getDrawingBufferSize(size);
    const width = Math.max(8, Math.floor(size.x * scale));
    const height = Math.max(8, Math.floor(size.y * scale));

    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      target.texture.name = 'CombatWarm.color';
    } else if (target.width !== width || target.height !== height) {
      target.setSize(width, height);
    }
    target.viewport.set(0, 0, width, height);
    target.scissor.set(0, 0, width, height);
    target.scissorTest = false;

    const priorTarget = renderer.getRenderTarget();
    const priorFace = renderer.getActiveCubeFace ? renderer.getActiveCubeFace() : 0;
    const priorMip = renderer.getActiveMipmapLevel ? renderer.getActiveMipmapLevel() : 0;
    try {
      // WebGLRenderer takes viewport/scissor directly from the render target.
      // Do not call renderer.setViewport here: that mutates the default
      // framebuffer viewport and recreates the first-battle quarter-frame bug.
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(priorTarget, priorFace, priorMip);
    }
  }

  warmSceneOffscreen.dispose = function dispose() {
    if (target) {
      target.dispose?.();
      target = null;
    }
  };

  warmSceneOffscreen.getTarget = function getTarget() {
    return target;
  };

  return warmSceneOffscreen;
}

/**
 * B14 (fx first-use staging): compile every child of an effects group while
 * it is INVISIBLE to presented frames, so the GPU program/texture first-use
 * cost lands inside this explicit call instead of in the next rendered
 * frame's rAF wait. Particle pools start mesh.visible=false (an empty pool
 * must not cost a draw submission every frame) and flip visible on the first
 * claim(); renderer.compile() traverses visible objects only, so without this
 * sweep every family's first link+upload used to land in ONE presented frame
 * behind the loader (measured fxMuzzleWait 0.7 s quiet → 21.8 s contended).
 *
 * Programs and textures persist across a visibility toggle, so the first live
 * emit after this sweep is a cache hit. Visibility and the camera layer mask
 * are restored exactly; nothing is presented and no draw is submitted.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D} group effects root whose children are the pools
 * @param {THREE.Camera} camera layers mask is saved/restored around the sweep
 * @param {THREE.Scene} scene owning scene passed through to renderer.compile
 * @returns {number} count of children submitted for compilation
 */
export function compileParticleFamilies(renderer, group, camera, scene) {
  if (!group || !Array.isArray(group.children)) return 0;
  const priorMask = camera.layers.mask;
  // Pools may sit on non-default layers (late-FX layer 30); a full mask makes
  // the traversal deterministic regardless of the caller's current mask.
  camera.layers.mask = 0xffffffff;
  let compiled = 0;
  try {
    for (const child of group.children) {
      if (!child || child.isLight || child.isCamera) continue;
      const priorVisible = child.visible;
      child.visible = true;
      try {
        renderer.compile(child, camera, scene);
        compiled++;
      } catch (_) {
        /* warm-only: leave the program to its normal lazy path */
      } finally {
        child.visible = priorVisible;
      }
    }
  } finally {
    camera.layers.mask = priorMask;
  }
  return compiled;
}
