# Asset pipelines — offline texture and geometry optimization

This document consolidates the four offline asset pipelines and their runtime
consumers: the shared PNG codec, the KTX2/Basis Universal texture pipeline,
packed ORM consolidation, and Meshopt geometry compression. It is the
operational companion to [TANK-ASSET-PIPELINE.md](TANK-ASSET-PIPELINE.md),
which owns the generated *vehicle* asset contract. Playable vehicles are
procedural first-party runtime builds; nothing in this document changes that.
These pipelines apply to static world/prop/FX textures and static GLB assets.

Historical design evidence lives in
[GRAPHICS-PERF-CAMPAIGN-2026-08-21.md](GRAPHICS-PERF-CAMPAIGN-2026-08-21.md)
and [GRAPHICS-PERF-CAMPAIGN-2-2026-08-21.md](GRAPHICS-PERF-CAMPAIGN-2-2026-08-21.md)
(§10 KTX2, SA-05 ORM). This page states current usage, not campaign history.

## Shared contracts

All four pipelines follow the same rules:

- **Deterministic output.** Encoders are seeded/fixed; content-hash caches key
  artifacts by input bytes, so re-running a bake without source changes writes
  nothing new. Never use wall-clock time or `Math.random()` in these tools.
- **Fail closed, never synthesize.** If pixels cannot really be decoded (for
  example JPEG without the optional decoder), the tool skips with a warning
  instead of fabricating texels.
- **Attribution.** Retiring or replacing any shipped source file is recorded in
  [ATTRIBUTION.md](ATTRIBUTION.md); run `npm run attribution:check`.
- **Public-build boundary.** Quarantined comparison assets stay out of public
  artifacts; `tools/strip-nc-assets.mjs` (run by every public build) fails
  closed if a registered playable references a stripped path. The Basis
  transcoder under `public/basis/` is not touched by the strip step.
- **Test wiring.** Each tool has a `*.selftest.mjs` wired into `npm test`; see
  [QA-COVERAGE.md](QA-COVERAGE.md) for the guard that enforces this.

## Shared PNG codec — tools/campaign-png.mjs

A dependency-free deterministic PNG decoder/encoder sufficient for the repo's
own bake outputs (8-bit, non-interlaced). Reads color types 0/2/3/4/6; writes
RGBA (type 6) and gray+alpha (type 4, used to re-encode alpha-only FX particle
atlases so browsers decode back to identical RGBA bytes). The duplicate-texture
audit uses its pixel hashing. It exists so the optimizer tools below need no
image-library dependency chain.

## KTX2 / Basis Universal textures

Offline tool:

    node tools/campaign-optimize-ktx2.mjs [--dir=public/textures] [--write] [--force] [--benchmark]

or via npm:

    npm run textures:ktx2            # --write against public/textures
    npm run textures:ktx2:selftest

What it does:

1. Discovers and classifies textures (albedo sRGB; normal maps, ORM/data
   linear; VFX atlases detected separately).
2. Emits deterministic KTX2 containers via ktx-parse with proper Data Format
   Descriptors and `COT_*` key/value metadata.
3. Generates mipmaps per class: gamma-correct downsampling for sRGB albedos,
   renormalizing filtering for normal maps, linear box filtering for data
   maps, alpha-preserving for particle atlases (`generateMipmaps=false`
   downstream because mips are pre-baked).
4. Caches by content hash; reports VRAM/transfer analytics; writes
   `ktx2-manifest.json` for runtime queries.

JPEG policy: decoding requires the optional `jpeg-js` devDependency. Without
it, JPEG sources are skipped with a one-time warning — the tool never emits
pixels that mismatch their source.

Runtime consumer: `src/engine/ktx2Pipeline.js` provides a singleton
`KTX2Loader` (worker pool plus the `/basis/` transcoder shipped under
`public/basis/`), GPU support detection gating, transparent `.ktx2 → .jpg/.png`
fallback (alpha-preserving PNG for FX atlases), strict sRGB/Linear/NoColorSpace
color-space resolution including filename inference, in-flight dedup, caching,
and dispose. Status: the pipeline is fully selftested but remains opt-in — no
production module calls `getGlobalKtx2Pipeline()` yet, and current containers
are uncompressed RGBA8 (`KHR_SUPERCOMPRESSION_NONE`). True Basis ETC1S/UASTC
encoding needs an external encoder dependency not present in-repo, which is
why `textures:ktx2` is not part of routine bakes.

## Packed ORM consolidation

Offline tool:

    node tools/campaign-pack-orm.mjs [--dir=public/textures] [--write]
                                     [--format=png|jpg|auto] [--quality=90]

or via npm:

    npm run textures:orm            # audit/dry-run
    npm run textures:orm:bake       # --write
    npm run textures:orm:selftest

Packs separate Ambient Occlusion, Roughness, and Metallic maps into one
standard glTF ORM texture (R = AO, G = roughness, B = metallic, A = 255).
Sources may be PNG or JPEG (magic-byte sniffed; JPEG decodes through the same
optional `jpeg-js` dependency as above). `--format=auto` picks the smaller of
lossless PNG versus q90 JPEG per set and names the output accordingly.

Current baked state: all live PBR sets use packed ORM; the consolidation
replaced separate AO+Roughness files (net ~8 MB disk/download reduction,
fewer GPU mask textures, sampler slots, and one fewer canvas-composite
readback per composite).

Runtime consumer: `src/world/sourcedTextures.js` prefers the packed ORM via
`composeAlbedoFromOrm` (one shared-scratch readback per composite) and falls
back silently to separate maps when packed files are absent. Composite-cache
keys are prefixed `orm|` or `sep|` so the two paths can never cross-
contaminate cached canvases.

## Meshopt geometry compression

Offline tool:

    node tools/campaign-meshopt.mjs [--dir=public/models] [--file=path/to.glb]
        [--write] [--force] [--manifest=public/models/meshopt-manifest.json]

Per GLB: parse the container, vertex-cache optimize every indexed TRIANGLES
primitive (`MeshoptEncoder.reorderMesh`) and compact unreferenced vertices,
then re-encode index/attribute segments with `EXT_meshopt_compression`
(modes TRIANGLES/INDICES/ATTRIBUTES, filter NONE — lossless). Non-geometry
accessors (animations, skins, instancing) and image bufferViews pass through
verbatim; dead bufferViews are dropped. Accessors that cannot satisfy codec
constraints fall back to verbatim uncompressed segments, so a file is never
corrupted by this tool. Per-primitive byte deltas and aggregate savings are
reported; a manifest supports cache skips.

Runtime consumer: `src/engine/meshoptGlbLoader.js` wires three's GLTFLoader to
the bundled `MeshoptDecoder`. Compressed and uncompressed GLBs load through
the exact same path — callers never branch on compression. The loader module
is Node-safe (geometry-only parsing needs no DOM/WebGL); codec behavior is
covered by the tool selftest, which exercises the same extension contract.

## Verification quick reference

| Pipeline | Tool | Selftests | Runtime module |
| --- | --- | --- | --- |
| PNG codec | `tools/campaign-png.mjs` | `tools/campaign-png.selftest.mjs` | n/a (tool-only) |
| KTX2/Basis | `npm run textures:ktx2` | `tools/campaign-optimize-ktx2.selftest.mjs`, `src/engine/ktx2Pipeline.selftest.mjs` | `src/engine/ktx2Pipeline.js` |
| Packed ORM | `npm run textures:orm(:bake)` | `tools/campaign-pack-orm.selftest.mjs` (+ `sourcedTextures` suite) | `src/world/sourcedTextures.js` |
| Meshopt | `node tools/campaign-meshopt.mjs` | `tools/campaign-meshopt.selftest.mjs` (tool + codec constraints) | `src/engine/meshoptGlbLoader.js` |

All suites run inside `npm test`; the chain guard keeps them wired.
