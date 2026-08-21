import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
// W11 asset compression: bake outputs are alpha-only sprite sheets, so the raw
// canvas RGBA PNGs are re-encoded as grayscale+alpha (~40% smaller) before
// they touch disk. optimizeAtlasPng verifies a pixel-exact round trip and
// passes through any atlas that ever stops being grayscale.
import { optimizeAtlasPng } from './campaign-optimize-fx-atlases.mjs';

const server = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5900, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const address = server.httpServer.address();
const port = typeof address === 'object' && address ? address.port : 5173;
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/tools/fx-texture-bake.html`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction(
    'window.__FX_TEXTURE_BAKE && window.__FX_TEXTURE_METRICS',
    { timeout: 120000 },
  );
  const { atlases, metrics } = await page.evaluate(() => ({
    atlases: window.__FX_TEXTURE_BAKE,
    metrics: window.__FX_TEXTURE_METRICS,
  }));
  const outDir = join(process.cwd(), 'public', 'fx');
  await mkdir(outDir, { recursive: true });
  for (const [name, atlas] of Object.entries(atlases)) {
    const raw = Buffer.from(atlas.png.slice(atlas.png.indexOf(',') + 1), 'base64');
    const opt = optimizeAtlasPng(raw);
    await writeFile(join(outDir, `particles-${name}.png`), opt.buffer);
    console.log(`${name.padEnd(5)} ${atlas.width}x${atlas.height} ${raw.length} -> ${opt.buffer.length} bytes${opt.mode === 'grayalpha' ? ' (gray+alpha)' : ''}`);
  }
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  await browser.close();
  await server.close();
}
