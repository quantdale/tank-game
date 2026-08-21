import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  disposeObject3DResources,
  residentResourceLimits,
} from './resourceLifetime.js';

assert.deepEqual(residentResourceLimits('mobile'), {
  pedestalVisuals: 2,
  worldScenes: 1,
});
assert.equal(residentResourceLimits('desktop').pedestalVisuals, 6);
assert.equal(residentResourceLimits('desktop').worldScenes, Infinity);

const sharedTexture = new THREE.Texture();
const retiredTexture = new THREE.Texture();
const retiredGeometry = new THREE.BufferGeometry();
const retiredMaterial = new THREE.MeshStandardMaterial({ map: sharedTexture });
retiredMaterial.normalMap = retiredTexture;
const retired = new THREE.Group();
retired.add(new THREE.Mesh(retiredGeometry, retiredMaterial));
const parent = new THREE.Scene();
parent.add(retired);

const live = new THREE.Group();
live.add(new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshStandardMaterial({ map: sharedTexture }),
));

let geometryDisposals = 0;
let materialDisposals = 0;
let sharedTextureDisposals = 0;
let retiredTextureDisposals = 0;
retiredGeometry.addEventListener('dispose', () => { geometryDisposals += 1; });
retiredMaterial.addEventListener('dispose', () => { materialDisposals += 1; });
sharedTexture.addEventListener('dispose', () => { sharedTextureDisposals += 1; });
retiredTexture.addEventListener('dispose', () => { retiredTextureDisposals += 1; });

const released = disposeObject3DResources(retired, { preserveRoots: [live] });
assert.equal(retired.parent, null, 'retired subtree must detach from the live scene');
assert.equal(geometryDisposals, 1, 'retired geometry must release its GPU buffer');
assert.equal(materialDisposals, 1, 'retired material must release its program state');
assert.equal(retiredTextureDisposals, 1, 'unshared retired texture must be released');
assert.equal(sharedTextureDisposals, 0, 'texture used by a preserved root must stay resident');
assert.deepEqual(released, { objects: 2, geometries: 1, materials: 1, textures: 1 });

// Shadow maps hang off lights OUTSIDE the material/geometry graph — an
// evicted subtree must release them, but keep them while a preserved root
// shares the same light.
const shadowMap = { disposed: 0, dispose() { this.disposed += 1; } };
const shadowMapPass = { disposed: 0, dispose() { this.disposed += 1; } };
const lamp = new THREE.Object3D();
lamp.isLight = true;
lamp.shadow = { map: shadowMap, mapPass: shadowMapPass };
const litGroup = new THREE.Group();
litGroup.add(lamp);
litGroup.add(new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshStandardMaterial({ map: sharedTexture }),
));
parent.add(litGroup);

disposeObject3DResources(litGroup, { preserveRoots: [live] });
assert.equal(shadowMap.disposed, 1, 'an evicted light must release its shadow map');
assert.equal(shadowMapPass.disposed, 1, 'an evicted light must release its VSM target');

const keptShadowMap = { disposed: 0, dispose() { this.disposed += 1; } };
const liveLamp = new THREE.Object3D();
liveLamp.isLight = true;
liveLamp.shadow = { map: keptShadowMap };
live.add(liveLamp);
const retiredLamp = new THREE.Object3D();
retiredLamp.isLight = true;
retiredLamp.shadow = { map: keptShadowMap };
const retiredGroup = new THREE.Group();
retiredGroup.add(retiredLamp);
retiredGroup.add(new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshStandardMaterial(),
));
parent.add(retiredGroup);

disposeObject3DResources(retiredGroup, { preserveRoots: [live] });
assert.equal(keptShadowMap.disposed, 0,
  'a shadow map shared with a preserved root must stay resident');

console.log('resourceLifetime self-test passed');
