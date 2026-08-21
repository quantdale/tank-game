import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// W11 asset compression: the atlases are re-encoded as grayscale+alpha PNGs
// (color type 4) by tools/campaign-optimize-fx-atlases.mjs — pixel-identical
// to the seeded bake, ~40% fewer bytes. Hashes below pin that re-encoded form.
const expected = {
  smoke: [512, 512, '2d37e0fed45aaa061c5b669e8037030e314a4516d645f40d3d8c117edc568dac'],
  fire: [1024, 1024, '028dc1a5599d32e04d0320ba4794d0b9b032067a7689d7046b2e90fbbdd878b5'],
  prop: [768, 768, '179789135ceeef1a89886023041b09f9b81eabb12b6f72a57827a70a341e8627'],
  dust: [512, 512, '2a70de365f80a32feba07972a7784ce9b3bba9b969c70d931fd46e731d3608b9'],
  flash: [128, 128, '264ed3252eb32537393b53b351132f5ef5293c26be8673ff864586798822f5be'],
  jet: [256, 96, '372f759df4cd83e14b2a0888f26627da91c44cbc86cbe69d7f04f3510c3452f8'],
};

for (const [name, [width, height, sha256]] of Object.entries(expected)) {
  const png = await readFile(new URL(`../../public/fx/particles-${name}.png`, import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
    `${name}: committed atlas is a PNG`);
  assert.equal(png.readUInt32BE(16), width, `${name}: deterministic atlas width`);
  assert.equal(png.readUInt32BE(20), height, `${name}: deterministic atlas height`);
  assert.ok(png.length > 1000, `${name}: atlas is not an empty placeholder`);
  assert.equal(createHash('sha256').update(png).digest('hex'), sha256,
    `${name}: committed atlas matches the seeded first-party bake`);
}

console.log('particleTextureAssets.selftest: six deterministic prebuilt atlases passed');
