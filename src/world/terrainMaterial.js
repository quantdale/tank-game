// src/world/terrainMaterial.js — public API facade for the frequency-separated
// PBR terrain ground material. The implementation lives in ./terrain.js (the
// splat shader, painted biome layers, mask/noise bakes, and material binder);
// this module re-exports the stable surface other modules should import, so
// terrain internals can be refactored without touching consumers.
//
// Contract: every name here MUST exist as an export of ./terrain.js with the
// same binding — terrainMaterial.selftest.mjs enforces the parity at test time.
export {
  SPLAT_COMMON_FRAG,        // shared splat-compute GLSL (albedo/rough/normal globals)
  SPLAT_NORMAL_FRAG,        // splat normal-blend GLSL hook
  createSplatMaterial,      // biome splat material binder (engineCtx, layout, cfg, mapId)
  sampleSplatNoise,         // CPU twin of the shader noise fields (vegetation correlation)
  splatFields,              // baked Float32 noise fields behind sampleSplatNoise
  applyTone,                // per-biome albedo tone helper
  makeGrassLayer,           // Verdant turf sheet (blades + macro clumps)
  makeDirtLayer,            // soil/clod/pebble sheet
  makeSandstoneLayer,       // Desert stratified cliff sheet
  makeSeaLayer,             // Coastal open-water sheet (foam streaks)
  makeIceLayer,             // Winter lake-ice sheet (drifts, roughness in alpha)
  makeGroundLayer,          // generic ground fallback by kind
  makeMaskTexture,          // road/rut/marsh/village control mask
  makeShaderNoiseTexture,   // RG noise bake shared with the splat shader
} from './terrain.js';
