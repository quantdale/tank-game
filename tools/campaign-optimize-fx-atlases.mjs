// campaign-optimize-fx-atlases.mjs — W11 asset-compression campaign migration.
//
// The particle atlases in public/fx/ are alpha-only payloads (RGB is constant
// white by construction, see src/fx/particles.js makeFlipbookTextureSteps /
// makeJetTexture / makeFlashTexture), but canvas toDataURL() encodes them as
// full RGBA PNGs. Re-encoding as color-type 4 (grayscale+alpha) strips two
// constant channels: ~40% fewer bytes on disk and over the wire, while every
// browser decodes back to the exact same RGBA pixels the runtime samples.
//
// Safety contract: an atlas is only rewritten after decode(re-encoded) is
// verified byte-equal to decode(original). Atlases that are not grayscale
// (a future painter adds RGB content) are passed through untouched.
//
// Usage:
//   node tools/campaign-optimize-fx-atlases.mjs [--dir=public/fx] [--write]
// Without --write this is a dry run reporting achievable savings.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './campaign-png.mjs';

/**
 * Re-encode one atlas PNG as grayscale+alpha when (and only when) its pixels
 * are pure gray. Never returns unverified bytes.
 * @param {Buffer} buf original PNG bytes
 * @returns {{ buffer: Buffer, mode: 'grayalpha'|'passthrough', reason?: string }}
 */
export function optimizeAtlasPng(buf) {
  const img = decodePng(buf);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) {
      return { buffer: buf, mode: 'passthrough', reason: 'not-alpha-only' };
    }
  }
  const encoded = encodePng(img, { colorType: 'grayalpha' });
  const roundTrip = decodePng(encoded);
  if (!Buffer.from(roundTrip.data).equals(Buffer.from(d))) {
    return { buffer: buf, mode: 'passthrough', reason: 'round-trip mismatch' };
  }
  return { buffer: encoded, mode: 'grayalpha' };
}

/** Optimize every particles-*.png under `dir`; writes only with write=true. */
export function optimizeFxAtlasDir(dir, { write = false } = {}) {
  const results = [];
  let before = 0, after = 0;
  for (const name of readdirSync(dir)) {
    if (!/^particles-.*\.png$/.test(name)) continue;
    const p = join(dir, name);
    const orig = readFileSync(p);
    const opt = optimizeAtlasPng(orig);
    if (opt.mode === 'grayalpha' && write && opt.buffer.length < orig.length) {
      writeFileSync(p, opt.buffer);
    }
    const finalBytes = write ? Math.min(orig.length, opt.buffer.length) : orig.length;
    before += orig.length;
    after += finalBytes;
    results.push({
      name,
      before: orig.length,
      optimizedBytes: opt.buffer.length,
      mode: opt.mode,
      reason: opt.reason || null,
      written: write && opt.mode === 'grayalpha' && opt.buffer.length < orig.length,
    });
    console.log(`[fx-opt] ${name.padEnd(22)} ${String(orig.length).padStart(7)} -> ${String(opt.buffer.length).padStart(7)} bytes  ${opt.mode}${opt.reason ? ' (' + opt.reason + ')' : ''}${write && opt.mode === 'grayalpha' && opt.buffer.length < orig.length ? '  [written]' : ''}`);
  }
  console.log(`[fx-opt] ${write ? 'written' : 'dry run'}: ${before} -> ${after} bytes (${Math.round((1 - after / before) * 100)}% off)`);
  return { results, before, after };
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));
  optimizeFxAtlasDir(join(process.cwd(), String(args.dir || 'public/fx')), { write: !!args.write });
}
