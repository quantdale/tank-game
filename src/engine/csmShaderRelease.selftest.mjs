// csmShaderRelease.selftest.mjs — W2-F leak fix coverage.
//
// three's CSM.setupMaterial pins every shadow-patched material in a
// session-long `shaders` Map (strong refs: material + onBeforeCompile closure
// + shader uniforms) and only CSM.dispose() clears entries, which never runs
// mid-session. Per-instance materials — every tank visual rebuilds its whole
// material set per battle — must be released at dispose time or the registry
// retains them until page unload (measured ~16 MB/battle soak growth).
//
// Covers releaseCsmShaderMaterial's contract without constructing a real CSM
// (duck-typed {shaders: Map}), matching how lighting.js calls it.
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

const { releaseCsmShaderMaterial } = await import('./lighting.js');

function makeRegisteredMaterial() {
  const mat = {
    isMaterial: true,
    defines: { USE_CSM: 1, CSM_CASCADES: '0,1,2,3', CSM_FADE: '' },
    onBeforeCompile: () => {},
    needsUpdate: false,
  };
  const shaders = new Map();
  shaders.set(mat, null); // setupMaterial pre-compilation entry
  return { mat, shaders };
}

{
  // 1. registered material: released, scrubbed, idempotent
  const { mat, shaders } = makeRegisteredMaterial();
  assert.equal(releaseCsmShaderMaterial({ shaders }, mat), true,
    'release must report removal of a registered material');
  assert.equal(shaders.size, 0, 'registry must drop the entry');
  assert.equal(mat.onBeforeCompile, undefined, 'wrapped hook belongs to the registry entry');
  assert.equal(mat.defines.USE_CSM, undefined, 'USE_CSM define must be stripped');
  assert.equal(mat.defines.CSM_CASCADES, undefined, 'CSM_CASCADES define must be stripped');
  assert.equal(mat.defines.CSM_FADE, undefined, 'CSM_FADE define must be stripped');
  assert.equal(mat.needsUpdate, true, 'needsUpdate flags any stale cached program');
}

{
  // 2. live-entry variant (onBeforeCompile already ran): same teardown
  const { mat, shaders } = makeRegisteredMaterial();
  shaders.set(mat, { uniforms: {} }); // post-compile entry shape
  assert.equal(releaseCsmShaderMaterial({ shaders }, mat), true);
  assert.equal(shaders.has(mat), false);
}

{
  // 3. never-registered / already-released materials are a no-op
  const { mat, shaders } = makeRegisteredMaterial();
  assert.equal(releaseCsmShaderMaterial({ shaders }, { isMaterial: true }), false,
    'unregistered material must not be touched');
  assert.equal(releaseCsmShaderMaterial({ shaders }, mat), true);
  assert.equal(releaseCsmShaderMaterial({ shaders }, mat), false,
    'double release must be a no-op (idempotent)');
}

{
  // 4. hostile inputs stay quiet
  const shaders = new Map();
  assert.equal(releaseCsmShaderMaterial(null, null), false);
  assert.equal(releaseCsmShaderMaterial({}, null), false);
  assert.equal(releaseCsmShaderMaterial({ shaders }, null), false);
  assert.equal(releaseCsmShaderMaterial({ shaders }, 'box'), false,
    'non-object materials must be ignored');
  assert.equal(shaders.size, 0);
}

{
  // 5. live shared material NOT passed by its owner keeps working — the
  // contract is that only owners release; the helper itself must not mutate
  // anything beyond the removed entry.
  const keep = { isMaterial: true, defines: { USE_CSM: 1 }, onBeforeCompile: () => {}, needsUpdate: false };
  const dead = { isMaterial: true, defines: { USE_CSM: 1 }, onBeforeCompile: () => {}, needsUpdate: false };
  const shaders = new Map([[keep, null], [dead, null]]);
  releaseCsmShaderMaterial({ shaders }, dead);
  assert.deepEqual([...shaders.keys()], [keep], 'only the released entry disappears');
  assert.equal(keep.onBeforeCompile instanceof Function, true,
    'surviving registration must stay intact');
}

console.log('csmShaderRelease.selftest: CSM shader-registry release contract passed');
