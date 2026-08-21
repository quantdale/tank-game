// campaign-png.mjs — W11 asset-compression campaign helper: a dependency-free
// deterministic PNG decoder/encoder sufficient for the repo's own bake outputs
// (8-bit, non-interlaced). The duplicate audit uses decode() to hash decoded
// pixels; the FX-atlas migration uses encodeGrayAlpha() to re-encode the
// alpha-only particle atlases as color-type 4 (grayscale+alpha), which every
// browser decodes back to the exact same RGBA bytes.
//
// Supported on read: color types 0 (gray), 2 (RGB), 3 (palette+PLTE/tRNS),
// 4 (gray+alpha), 6 (RGBA); bit depth 8; interlace 0 only.
// Written formats: RGBA (type 6) and gray+alpha (type 4).

import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PAETH = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode a PNG into straight (non-premultiplied) RGBA8.
 * @param {Buffer} buf
 * @returns {{ width:number, height:number, data:Uint8Array }} data = RGBA, w*h*4
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, colorType = -1, bitDepth = -1, interlace = -1;
  const idat = [];
  let plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  const chansIn = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!chansIn) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * chansIn;
  if (raw.length < (stride + 1) * height) throw new Error('truncated pixel stream');
  // unfilter into `lines` (per-channel-sample bytes, no filter prefixes)
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const rx = raw[src + x];
      const a = x >= chansIn ? lines[row + x - chansIn] : 0;
      const b = y > 0 ? lines[row - stride + x] : 0;
      const c = x >= chansIn && y > 0 ? lines[row - stride + x - chansIn] : 0;
      let v;
      if (f === 0) v = rx;
      else if (f === 1) v = rx + a;
      else if (f === 2) v = rx + b;
      else if (f === 3) v = rx + ((a + b) >> 1);
      else v = rx + PAETH(a, b, c);
      lines[row + x] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * chansIn, o = i * 4;
    if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = lines[s]; out[o + 3] = 255; }
    else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = lines[s]; out[o + 3] = lines[s + 1]; }
    else if (colorType === 3) {
      const pi = lines[s] * 3;
      out[o] = plte[pi]; out[o + 1] = plte[pi + 1]; out[o + 2] = plte[pi + 2];
      out[o + 3] = trns && lines[s] < trns.length ? trns[lines[s]] : 255;
    } else {
      out[o] = lines[s]; out[o + 1] = lines[s + 1]; out[o + 2] = lines[s + 2];
      out[o + 3] = chansIn === 4 ? lines[s + 3] : 255;
    }
  }
  return { width, height, data: out };
}

/** Minimum-sum-of-absolute-differences filter heuristic (PNG spec §9). */
function pickFilter(row, prev, bpp) {
  let best = 0, bestScore = Infinity, bestBuf = null;
  const n = row.length;
  const trial = Buffer.alloc(n);
  for (let f = 0; f < 5; f++) {
    let score = 0;
    for (let x = 0; x < n; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v;
      if (f === 0) v = row[x];
      else if (f === 1) v = row[x] - a;
      else if (f === 2) v = row[x] - b;
      else if (f === 3) v = row[x] - ((a + b) >> 1);
      else v = row[x] - PAETH(a, b, c);
      v &= 0xff;
      trial[x] = v;
      score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) { bestScore = score; best = f; bestBuf = Buffer.from(trial); }
  }
  return { filter: best, data: bestBuf };
}

// Inverse of the PNG row filters: rebuild the reconstructed scanline from the
// stored filtered bytes. The NEXT row's Up/Average/Paeth predictors must see
// these reconstructed bytes, never the filtered ones (spec §6).
function reconstructRow(filter, data, prev, bpp) {
  const out = Buffer.alloc(data.length);
  for (let x = 0; x < data.length; x++) {
    const a = x >= bpp ? out[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = x >= bpp && prev ? prev[x - bpp] : 0;
    let v;
    if (filter === 0) v = data[x];
    else if (filter === 1) v = data[x] + a;
    else if (filter === 2) v = data[x] + b;
    else if (filter === 3) v = data[x] + ((a + b) >> 1);
    else v = data[x] + PAETH(a, b, c);
    out[x] = v & 0xff;
  }
  return out;
}

function encodeRaw(width, height, chans, rgba) {
  const stride = width * chans;
  const raw = Buffer.alloc((stride + 1) * height);
  const row = Buffer.alloc(stride);
  let prev = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (chans === 2) { row[x * 2] = rgba[y * width * 4 + x * 4]; row[x * 2 + 1] = rgba[y * width * 4 + x * 4 + 3]; }
      else { for (let c = 0; c < 4; c++) row[x * 4 + c] = rgba[y * width * 4 + x * 4 + c]; }
    }
    const { filter, data } = pickFilter(row, prev, chans);
    raw[y * (stride + 1)] = filter;
    data.copy(raw, y * (stride + 1) + 1);
    prev = reconstructRow(filter, data, prev, chans);
  }
  return raw;
}

/**
 * Encode RGBA8 pixels as a PNG. Throws if colorType 'grayalpha' is requested
 * but any pixel has r != g or g != b (the payload would not survive).
 * @param {{ width:number, height:number, data:Uint8Array }} img
 * @param {{ colorType?:'rgba'|'grayalpha', level?:number }} [opts]
 * @returns {Buffer}
 */
export function encodePng(img, { colorType = 'rgba', level = 9 } = {}) {
  const chans = colorType === 'grayalpha' ? 2 : 4;
  if (colorType === 'grayalpha') {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) throw new Error('grayalpha: non-gray RGB at pixel ' + (i >> 2));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;              // bit depth
  ihdr[9] = chans === 2 ? 4 : 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(encodeRaw(img.width, img.height, chans, img.data), { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** FNV-1a over a byte view — stable content hash for audit grouping. */
export function fnv1a(buf) {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
