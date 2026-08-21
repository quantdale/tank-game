// Terrain streaming benchmark. Default (no args): browser probe through vite +
// puppeteer measuring eager vs streamed opening builds. `--node`: pure-Node
// scheduling benchmark comparing the legacy synchronous one-job-every-4th-
// update build against the budgeted terrainStreamScheduler along the same
// camera drive — no browser, runs headless in CI-style checks:
//
//   node tools/terrain-stream-benchmark.mjs --node

if (process.argv.includes('--node')) {
  await runNodeBenchmark();
} else {
  await runBrowserBenchmark();
}

async function runBrowserBenchmark() {
  const puppeteer = (await import('puppeteer')).default;
  const { createServer } = await import('vite');

  const server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5910, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 5910;
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/tools/terrain-stream-benchmark.html`, {
      waitUntil: 'domcontentloaded', timeout: 120000,
    });
    await page.waitForFunction('window.__TERRAIN_STREAM_BENCH', { timeout: 120000 });
    const report = await page.evaluate(() => window.__TERRAIN_STREAM_BENCH);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Pure-Node scheduling benchmark (--node)
// ---------------------------------------------------------------------------

async function runNodeBenchmark() {
  const [
    { getMapConfig },
    { createHeightField },
    { createFineGridBaker, createChunkGeometryBuilder, TERRAIN_LOD_SEGS },
    { createTerrainStreamScheduler, estimateCameraMotion },
    {
      chooseTerrainLodBuild,
      initialTerrainLods,
      terrainLodForDistance,
      TERRAIN_LOD_DIST,
    },
  ] = await Promise.all([
    import('../src/world/maps/index.js'),
    import('../src/world/terrain.js'),
    import('../src/world/terrainStreamSlices.js'),
    import('../src/world/terrainStreamScheduler.js'),
    import('../src/world/terrainLodPolicy.js'),
  ]);

  const config = getMapConfig('verdant');
  const heightField = createHeightField(1337, config);
  const spawn = heightField._layout.spawns.player;
  const CHUNKS = 8, CHUNK_SIZE = 1024 / 8;

  // Boot state twin of terrain.js's streamFarLods opening: every chunk gets
  // exactly its deployment-visible level; sub-far levels keep their fine grid.
  function createBootChunks() {
    const chunks = [];
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const cx0 = -512 + cx * CHUNK_SIZE, cz0 = -512 + cz * CHUNK_SIZE;
        const ccx = cx0 + CHUNK_SIZE / 2, ccz = cz0 + CHUNK_SIZE / 2;
        const [level] = initialTerrainLods(Math.hypot(spawn.x - ccx, spawn.z - ccz));
        let fine = null;
        if (level < 2) {
          fine = drainFineGrid(cx0, cz0);
        }
        const geo = drainGeometry(cx0, cz0, TERRAIN_LOD_SEGS[level], fine);
        const lods = [null, null, null];
        lods[level] = geo;
        chunks.push({
          mesh: { geometry: geo }, lods, fine,
          level, cx: ccx, cz: ccz, cx0, cz0,
        });
      }
    }
    return chunks;
  }

  function drainFineGrid(cx0, cz0) {
    const baker = createFineGridBaker(heightField, cx0, cz0);
    for (let r = 0; r < baker.rows; r++) baker.step();
    return baker.result();
  }

  function drainGeometry(cx0, cz0, segs, fine) {
    const builder = createChunkGeometryBuilder(heightField, cx0, cz0, segs, fine);
    for (let r = 0; r < builder.rows; r++) builder.step();
    return builder.finish();
  }

  // terrain.js's every-frame LOD swap pass (with its hysteresis), mirrored so
  // displayed levels track the camera and the retention sweep sees real state.
  function swapLods(chunks, camX, camZ) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const want = terrainLodForDistance(
        Math.hypot(camX - c.cx, camZ - c.cz), c.level);
      if (want !== c.level && c.lods[want]) {
        c.level = want;
        c.mesh.geometry = c.lods[want];
      }
    }
  }

  // Legacy profile: terrain.js's cadence — every 4th update picks one job and
  // builds it WHOLE inside that update (the combat-frame stall being measured).
  function runLegacyProfile(chunks) {
    const job = { index: -1, level: -1, distanceM: 0, urgent: false };
    const frameMs = [];
    let jobs = 0, totalMs = 0;
    for (let i = 0; i <= 180; i++) {
      const t = i / 180;
      const camX = 2 + 35 * t, camZ = -95 + 430 * t;
      for (let frame = 0; frame < 4; frame++) {
        swapLods(chunks, camX, camZ);
        let ms = 0;
        if ((frameMs.length & 3) === 0) {
          const picked = chooseTerrainLodBuild(chunks, camX, camZ, job);
          if (picked) {
            const startedAt = performance.now();
            const c = chunks[picked.index];
            if (!c.fine && picked.level < 2) c.fine = drainFineGrid(c.cx0, c.cz0);
            c.lods[picked.level] = drainGeometry(c.cx0, c.cz0,
              TERRAIN_LOD_SEGS[picked.level], c.fine);
            if (c.lods.every(Boolean)) c.fine = null;
            jobs++;
            const want = terrainLodForDistance(
              Math.hypot(camX - c.cx, camZ - c.cz), c.level);
            if (want === picked.level) {
              c.level = want;
              c.mesh.geometry = c.lods[want];
            }
            ms = performance.now() - startedAt;
            totalMs += ms;
          }
        }
        frameMs.push(ms);
      }
    }
    return { frameMs, jobs, totalMs };
  }

  // Budgeted profile: scheduler.update every frame under a millisecond cap.
  function runBudgetedProfile(chunks) {
    const scheduler = createTerrainStreamScheduler({ chunks, heightField });
    const motion = estimateCameraMotion(0, 0, 0, 0, 1 / 60);
    const frameMs = [];
    let prevX = 2, prevZ = -95;
    for (let i = 0; i <= 180; i++) {
      const t = i / 180;
      const camX = 2 + 35 * t, camZ = -95 + 430 * t;
      estimateCameraMotion(prevX, prevZ, camX, camZ, 4 / 60, motion);
      prevX = camX; prevZ = camZ;
      for (let frame = 0; frame < 4; frame++) {
        swapLods(chunks, camX, camZ);
        const startedAt = performance.now();
        scheduler.update(camX, camZ, motion);
        frameMs.push(performance.now() - startedAt);
      }
    }
    return {
      frameMs, jobs: scheduler.stats.jobsCompleted,
      totalMs: frameMs.reduce((a, b) => a + b, 0),
      overBudget: scheduler.stats.overBudget,
      suspended: scheduler.stats.suspended,
      resumed: scheduler.stats.resumed,
      evicted: scheduler.stats.evictions,
    };
  }

  function summarize(frameMs) {
    const sorted = [...frameMs].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, (sorted.length * q) | 0)];
    return {
      maxMs: round(sorted[sorted.length - 1]),
      p95Ms: round(pick(0.95)),
      medianMs: round(pick(0.5)),
    };
  }

  function presenceTally(chunks) {
    const tally = { l0: 0, l1: 0, l2: 0 };
    for (const c of chunks) {
      if (c.lods[0]) tally.l0++;
      if (c.lods[1]) tally.l1++;
      if (c.lods[2]) tally.l2++;
    }
    return tally;
  }

  function round(v) { return Math.round(v * 1000) / 1000; }

  // Warm-up pass (JIT) on a throwaway state, then one measured run each —
  // matching the browser entry's alternate-order warm-up discipline.
  const warmLegacy = createBootChunks();
  runLegacyProfile(warmLegacy);
  const warmBudgeted = createBootChunks();
  runBudgetedProfile(warmBudgeted);

  const legacyChunks = createBootChunks();
  const legacy = runLegacyProfile(legacyChunks);
  const budgetedChunks = createBootChunks();
  const budgeted = runBudgetedProfile(budgetedChunks);

  const report = {
    mode: 'node',
    map: 'verdant',
    seed: 1337,
    path: { from: [2, -95], to: [37, 335], steps: 181, framesPerStep: 4 },
    budgets: { backgroundMs: 1.25, urgentMs: 3 },
    legacy: {
      ...summarize(legacy.frameMs),
      buildUpdateTotalMs: round(legacy.totalMs),
      jobs: legacy.jobs,
      finalPresent: presenceTally(legacyChunks),
    },
    budgeted: {
      ...summarize(budgeted.frameMs),
      buildUpdateTotalMs: round(budgeted.totalMs),
      jobs: budgeted.jobs,
      finalPresent: presenceTally(budgetedChunks),
      overBudgetUpdates: budgeted.overBudget,
      suspended: budgeted.suspended,
      resumed: budgeted.resumed,
      evicted: budgeted.evicted,
    },
    worstUpdateReductionPct: Math.round(
      (1 - summarize(budgeted.frameMs).maxMs / Math.max(1e-9, summarize(legacy.frameMs).maxMs)) * 1000,
    ) / 10,
  };
  globalThis.__TERRAIN_STREAM_NODE_BENCH = report;
  console.log(JSON.stringify(report, null, 2));
}
