#!/usr/bin/env node
// tools/memory-soak.mjs — W2-F memory soak (Campaign 3, spec §13).
//
// Drives a real headed browser through repeated garage -> battle -> garage
// lifecycle cycles, cycling maps (verdant/desert/urban/winter) and switching
// the selected vehicle between battles. After boot and after every stage it
// samples the leak-sensitive counters:
//
//   - JS heap (performance.memory)
//   - renderer.info.memory.{geometries,textures} + info.programs.length
//   - full scene audit via src/engine/resourceLifetime.js auditSceneResources
//     (objects/geometries/materials/textures/renderTargets/shadowMaps/lights)
//   - world/pedestal cache residency (__DEBUG.worldCacheIds/pedestalCacheIds)
//   - listener-proxy counts: an EventTarget.addEventListener/removeEventListener
//     proxy installed BEFORE page scripts records adds/removes per target class,
//     giving approximate live-listener counts (real listeners cannot be
//     enumerated from JS; duplicates re-added count twice — trend signal only)
//
// Growth model: on desktop `residentLimits.worldScenes === Infinity`, so every
// distinct visited map stays cached BY DESIGN for instant map switches. First
// visits therefore legitimately grow geometry/texture counts (cache warming);
// only cycles that REVISIT already-cached maps reveal true leaks. The default
// schedule runs 6 cycles over 4 maps so cycles 5-6 are pure revisits; the
// verdict is computed from revisit-cycle deltas only.
//
// Evidence: .qa-dev/memory-soak-report.json. Exits 0 stable/green, 1 growth or
// assertion failures, 2 harness failure.
//
// Usage:
//   node tools/memory-soak.mjs [--cycles=6] [--maps=verdant,desert,urban,winter]
//        [--vehicles=m1a2,t90m,tiger1,m4a3e8] [--combat-seconds=12]
//        [--alloc-sample] [--out=.qa-dev/memory-soak-report.json]
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const CYCLES = Math.max(1, Number(arg("cycles", "6")));
const MAPS = arg("maps", "verdant,desert,urban,winter")
  .split(",")
  .map((s) => s.trim());
const VEHICLES = arg("vehicles", "m1a2,t90m,tiger1,m4a3e8")
  .split(",")
  .map((s) => s.trim());
const COMBAT_SECONDS = Number(arg("combat-seconds", "12"));
const OUT = resolve(arg("out", ".qa-dev/memory-soak-report.json"));
const ALLOC_SAMPLE = hasFlag("alloc-sample"); // CDP HeapProfiler sampling across all cycles
// W04a phase-2 protocol additions:
// --pin-roster=id1,id2,... pins every battle roster (kills composition
// variance so revisit-cycle deltas read true retention, not spec mix).
const PIN_ROSTER = arg("pin-roster", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// --mute suspends the AudioContext during combat legs (cycles 1..N/2 when
// paired runs are requested via --mute-split): isolates H2 audio retention.
const MUTE_AUDIO = hasFlag("mute");
const MUTE_SPLIT = hasFlag("mute-split"); // cycles 1..ceil(n/2) muted, rest unmuted

// Console-error classes already triaged as environmental on this host
// (campaign doc issue #4); favicon noise filtered by bootgate too.
const ENVIRONMENTAL_CONSOLE_RE = /ERR_CONNECTION_TIMED_OUT|net::ERR_|favicon/i;
const BATTLE_OPEN_TIMEOUT_MS = 420000; // campaign doc issue #2/B9: >=420 s budgets

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];
const pageErrors = [];
let server = null;
let browser = null;

// Installed before any page script runs: count add/removeEventListener calls.
// Approximate active counts per target class (window/document/body/canvas/
// constructor name). Re-adding an identical listener double-counts; this is a
// trend detector, not an exact census.
const LISTENER_PROBE_SOURCE = `
(() => {
  const probe = { adds: 0, removes: 0 };
  const counts = new Map();
  const tagOf = (t) => {
    try {
      if (t === window) return 'window';
      if (t === document) return 'document';
      if (t === document.documentElement) return 'html';
      if (t === document.body) return 'body';
      const n = t && t.constructor && t.constructor.name;
      return n || String(t);
    } catch (_) { return 'unknown'; }
  };
  const keyOf = (t, type) => tagOf(t) + '::' + type;
  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, opts) {
    try { probe.adds++; const k = keyOf(this, String(type)); counts.set(k, (counts.get(k) || 0) + 1); } catch (_) {}
    return origAdd.call(this, type, handler, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, handler, opts) {
    try {
      probe.removes++; const k = keyOf(this, String(type));
      const c = (counts.get(k) || 0) - 1;
      if (c <= 0) counts.delete(k); else counts.set(k, c);
    } catch (_) {}
    return origRemove.call(this, type, handler, opts);
  };
  window.__LISTENER_PROBE = {
    ...probe,
    snapshot() {
      let total = 0; const byTarget = {}; const byTypeTop = [];
      const byType = new Map();
      for (const [k, c] of counts) {
        total += c;
        const [tgt, type] = k.split('::');
        byTarget[tgt] = (byTarget[tgt] || 0) + c;
        byType.set(type, (byType.get(type) || 0) + c);
      }
      for (const [type, c] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        byTypeTop.push({ type, count: c });
      }
      return { adds: probe.adds, removes: probe.removes, approxActive: total, byTarget, byTypeTop };
    },
})();
`;

// Installed before any page script runs: track AudioBufferSourceNode (and
// AudioContext) lifecycles so per-battle voice retention (W04a hypothesis H2)
// is measurable directly instead of inferred from heap slopes alone.
const AUDIO_PROBE_SOURCE = `
(() => {
  const probe = { started: 0, stopped: 0, contexts: [] };
  const OrigSource = window.AudioBufferSourceNode;
  const origStart = OrigSource.prototype.start;
  const origStop = OrigSource.prototype.stop;
  const live = new Set();
  OrigSource.prototype.start = function (...a) {
    try { probe.started++; live.add(this); } catch (_) {}
    return origStart.apply(this, a);
  };
  OrigSource.prototype.stop = function (...a) {
    try { probe.stopped++; live.delete(this); } catch (_) {}
    return origStop.apply(this, a);
  };
  const OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (OrigCtx) {
    const origCtor = OrigCtx.prototype.constructor;
    window.AudioContext = function (...a) {
      const ctx = new origCtor(...a);
      try { probe.contexts.push(ctx); } catch (_) {}
      return ctx;
    };
    window.AudioContext.prototype = origCtor.prototype;
  }
  window.__AUDIO_PROBE = {
    get started() { return probe.started; },
    get stopped() { return probe.stopped; },
    approxLive() { return live.size; },
    contexts: () => probe.contexts.slice(),
    suspendAll() { for (const c of probe.contexts) { try { c.suspend(); } catch (_) {} } },
    resumeAll() { for (const c of probe.contexts) { try { c.resume(); } catch (_) {} } },
  };
})();
`;

async function samplePage(page, label, phase, { perChild = false } = {}) {
  return await page.evaluate(
    async ({ label, phase, perChild }) => {
      const D = window.__DEBUG;
      const R = D.renderer;
      // Force GC when the host allows it (--js-flags=--expose-gc): removes the
      // GC sawtooth from heap comparisons so growth reads are apples-to-apples.
      try {
        if (typeof window.gc === "function") {
          window.gc();
          window.gc();
        }
      } catch (_) {}
      let childBreakdown = null;
      const { auditSceneResources } = await import(
        "/src/engine/resourceLifetime.js"
      );
      let sceneAudit = null;
      try {
        // Same auditor the engine uses for disposal decisions; traverses the LIVE
        // scene including hidden cached battlefield groups + shadow-map lights.
        sceneAudit = auditSceneResources(D.scene);
        delete sceneAudit.rawSets;
      } catch (err) {
        sceneAudit = { error: String(err).slice(0, 160) };
      }
      if (perChild && D.scene?.children) {
        // Attribution: which top-level subtree owns the resources. Top-level
        // children are few (garage rig, cached battlefield groups, pedestal,
        // fx roots, lighting); a full audit per child is cheap at this width.
        childBreakdown = D.scene.children.map((child) => {
          const a = auditSceneResources(child);
          return {
            name: child.name || child.constructor.name,
            visible: child.visible,
            objects: a.objects,
            geometries: a.geometries,
            materials: a.materials,
            textures: a.textures,
            renderTargets: a.renderTargets,
            shadowMaps: a.shadowMaps,
          };
        });
      }
      const pm = performance.memory
        ? {
            usedMB:
              Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) /
              10,
            totalMB:
              Math.round((performance.memory.totalJSHeapSize / 1048576) * 10) /
              10,
            limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
          }
        : null;
      return {
        label,
        phase,
        tsIso: new Date().toISOString(),
        heap: pm,
        domNodes: document.getElementsByTagName("*").length,
        renderMemory: {
          geometries: R.info.memory.geometries,
          textures: R.info.memory.textures,
          programs: R.info.programs ? R.info.programs.length : null,
        },
        sceneAudit,
        childBreakdown,
        caches: {
          worldCacheIds: D.worldCacheIds,
          pedestalCacheCount: D.pedestalCacheIds.length,
          pedestalCacheIds: D.pedestalCacheIds,
          lastWorldRelease: D.lastWorldRelease,
          worldPrefetch: window.__WORLD_PREFETCH || null,
        },
        listeners: window.__LISTENER_PROBE
          ? window.__LISTENER_PROBE.snapshot()
          : null,
        audio: window.__AUDIO_PROBE
          ? {
              started: window.__AUDIO_PROBE.started,
              stopped: window.__AUDIO_PROBE.stopped,
              approxLive: window.__AUDIO_PROBE.approxLive(),
              contexts: window.__AUDIO_PROBE.contexts().length,
              suspended: (() => {
                try {
                  return window.__AUDIO_PROBE.contexts().map((c) => c.state);
                } catch (_) {
                  return null;
                }
              })(),
            }
          : null,
        csmShaders: (() => {
          try {
            return D.lighting?.csm?.shaders?.size ?? null;
          } catch (_) {
            return null;
          }
        })(),
      };
    },
    { label, phase, perChild },
  );
}

// Verdict from cycle-end (garage) samples only. A metric is GROWING when its
// revisit-cycle deltas (cycles after every listed map was seen once) exceed a
// small tolerance; everything else is STABLE (warm-cache steady state).
function classifyGrowth(cycleEndSamples, mapCount) {
  const warmStartIdx = Math.min(mapCount, cycleEndSamples.length - 1); // first sample index where all maps have been cached at least once
  const metrics = [
    "heap.usedMB",
    "renderMemory.geometries",
    "renderMemory.textures",
    "renderMemory.programs",
    "sceneAudit.objects",
    "sceneAudit.geometries",
    "sceneAudit.materials",
    "sceneAudit.textures",
    "sceneAudit.renderTargets",
    "sceneAudit.shadowMaps",
    "listeners.approxActive",
  ];
  const get = (s, path) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), s);
  const tolerances = {
    "heap.usedMB": 15,
    "renderMemory.geometries": 3,
    "renderMemory.textures": 3,
    "renderMemory.programs": 2,
    "sceneAudit.objects": 60,
    "sceneAudit.geometries": 3,
    "sceneAudit.materials": 3,
    "sceneAudit.textures": 3,
    "sceneAudit.renderTargets": 1,
    "sceneAudit.shadowMaps": 1,
    "listeners.approxActive": 8,
  };
  const results = {};
  const growing = [];
  const revisitDeltaCount = cycleEndSamples.length - (warmStartIdx + 1);
  for (const metric of metrics) {
    const values = cycleEndSamples.map((s) => get(s, metric));
    const deltas = [];
    for (let i = warmStartIdx + 1; i < values.length; i++) {
      deltas.push(Math.round((values[i] - values[i - 1]) * 100) / 100);
    }
    const netWarm =
      values.length > warmStartIdx + 1
        ? Math.round((values[values.length - 1] - values[warmStartIdx]) * 100) /
          100
        : null;
    const tol = tolerances[metric];
    const isGrowing = netWarm !== null && netWarm > tol;
    if (isGrowing) growing.push(metric);
    results[metric] = {
      values,
      revisitDeltas: deltas,
      netWarmDelta: netWarm,
      tolerance: tol,
      growing: isGrowing,
    };
  }
  // Fewer than 2 revisit deltas cannot separate trend from GC/chunked-work
  // noise — say so instead of returning a false STABLE.
  const verdict =
    revisitDeltaCount < 2
      ? "INCONCLUSIVE"
      : growing.length
        ? "GROWTH"
        : "STABLE";
  return {
    warmStartCycleIndex: warmStartIdx,
    revisitDeltaCount,
    perMetric: results,
    growingMetrics: growing,
    verdict,
  };
}

try {
  // OWN server in the assigned 5700-5799 band (WinNAT reserves 7185-7284).
  const port = 5700 + Math.floor(Math.random() * 100);
  server = await createServer({
    root: process.cwd(),
    logLevel: "error",
    server: {
      port,
      strictPort: false,
      hmr: false,
      watch: { ignored: ["**/*"] },
    },
  });
  await server.listen();
  const resolvedPort = server.config.server.port;

  browser = await puppeteer.launch({
    headless: false, // HEADED per mission: headless SwiftShader distorts GPU counters (~1.4x slower)
    protocolTimeout: 480000,
    args: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-position=40,40",
      "--window-size=1380,860",
      "--no-first-run",
      // Expose window.gc() in the page so samples can collect before measuring.
      "--js-flags=--expose-gc",
    ],
  });
  const page = await browser.newPage();
  let cdp = null;
  if (ALLOC_SAMPLE) {
    // Sampled allocation profile across the whole soak: who allocates the
    // bytes each battle cycle (retention is judged from the heap series;
    // this names the allocating call sites for follow-up).
    cdp = await page.target().createCDPSession();
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
  }
  await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(LISTENER_PROBE_SOURCE);
  await page.evaluateOnNewDocument(AUDIO_PROBE_SOURCE);
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400));
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));

  const url = `http://localhost:${resolvedPort}/?nosplash=1&tier=desktop&gfxreset=1`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

  // ---- boot -> garage baseline --------------------------------------------
  await page.waitForFunction("window.__GAME_READY === true", {
    timeout: 240000,
    polling: 250,
  });
  const baseline = await samplePage(page, "bootGarage", "garage");
  console.log(
    `[memory-soak] ready in ${Date.now() - t0}ms; heap=${baseline.heap?.usedMB}MB gpuGeo=${baseline.renderMemory.geometries} gpuTex=${baseline.renderMemory.textures} progs=${baseline.renderMemory.programs} listeners~${baseline.listeners?.approxActive}`,
  );

  const battleSamples = [];
  const cycleEndSamples = [];
  const cycleRecords = [];

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const mapId = MAPS[(cycle - 1) % MAPS.length];
    const vehicle = VEHICLES[(cycle - 1) % VEHICLES.length];
    const rec = {
      cycle,
      mapId,
      vehicle,
      startedAtIso: new Date().toISOString(),
    };

    // vehicle switch between battles (garage selection drives pedestal rebuild)
    await page.evaluate((v) => window.__DEBUG.selectGarageTank(v), vehicle);
    await sleep(400); // selection propagation

    // W04a H2 isolation: mute half the run (--mute-split) or the whole run
    // (--mute) by suspending every live AudioContext before the battle leg.
    const mutedLeg =
      MUTE_AUDIO && (!MUTE_SPLIT || cycle <= Math.ceil(CYCLES / 2));
    if (MUTE_AUDIO) {
      await page.evaluate((suspend) => {
        if (window.__AUDIO_PROBE)
          suspend
            ? window.__AUDIO_PROBE.suspendAll()
            : window.__AUDIO_PROBE.resumeAll();
      }, mutedLeg);
    }

    // ---- garage -> battle ---------------------------------------------------
    const entryT = Date.now();
    await page.evaluate(
      async ({ v, m, pin }) => {
        if (pin && pin.length) window.__DEBUG.flags.forceRoster = pin;
        await window.__DEBUG.beginSoloBattle({ specId: v, mapId: m });
      },
      { v: vehicle, m: mapId, pin: PIN_ROSTER },
    );
    await page.waitForFunction(
      'window.__DEBUG.game.phase === "battle" && window.__DEBUG.game.preBattleS <= 0',
      { timeout: BATTLE_OPEN_TIMEOUT_MS, polling: 500 },
    );
    rec.entryMs = Date.now() - entryT;
    rec.mapOk = await page.evaluate(
      (m) => window.__DEBUG.game.mapId === m,
      mapId,
    );
    rec.roster = await page.evaluate(() => window.__DEBUG.game.tanks.length);

    // ---- combat exercise (shells downrange exercise fx/decal pools) ----------
    const combat = await page.evaluate(async (secs) => {
      const d = window.__DEBUG;
      let aimed = null;
      for (let attempt = 0; attempt < 6 && !aimed; attempt++) {
        aimed = d.aimAtNearest();
        if (!aimed) d.fastForward(3);
      }
      const shellsBefore = d.playerShellLog.length;
      if (aimed) {
        d.flags.forceFire = true;
        d.fastForward(secs);
        d.flags.forceFire = false;
      }
      return {
        aimed: !!aimed,
        terminalEvents: d.playerShellLog.length - shellsBefore,
      };
    }, COMBAT_SECONDS);
    rec.combatAimed = combat.aimed;
    rec.shellTerminalEvents = combat.terminalEvents;
    battleSamples.push(await samplePage(page, `battle#${cycle}`, "battle"));

    // ---- battle -> garage ----------------------------------------------------
    const exitT = Date.now();
    await page.evaluate(() => {
      window.__DEBUG.leaveBattleToGarage();
    });
    await page.waitForFunction('window.__DEBUG.game.phase === "garage"', {
      timeout: 180000,
      polling: 250,
    });
    await sleep(4000); // chunked garage reveal + deferred dispose work settles
    rec.exitMs = Date.now() - exitT;
    rec.wallMs = Date.now() - entryT;
    const endSample = await samplePage(page, `cycleEnd#${cycle}`, "garage", {
      perChild: true,
    });
    cycleEndSamples.push(endSample);
    cycleRecords.push(rec);
    console.log(
      `[memory-soak] cycle ${cycle}/${CYCLES} ${vehicle}@${mapId} ok=${rec.mapOk} entry=${Math.round(rec.entryMs / 1000)}s exit=${Math.round(rec.exitMs / 1000)}s heap=${endSample.heap?.usedMB}MB gpuGeo=${endSample.renderMemory.geometries} gpuTex=${endSample.renderMemory.textures} progs=${endSample.renderMemory.programs} sceneObj=${endSample.sceneAudit.objects} rts=${endSample.sceneAudit.renderTargets} listeners~${endSample.listeners?.approxActive}`,
    );
  }

  const classification = classifyGrowth(cycleEndSamples, MAPS.length);
  for (const metric of classification.growingMetrics) {
    console.warn(
      `[memory-soak] GROWING: ${metric} netWarm=${classification.perMetric[metric].netWarmDelta} (tol ${classification.perMetric[metric].tolerance})`,
    );
  }

  // Per-cycle heap slope shape: tapering deltas => bounded cache warming
  // (roster/spec coverage saturating); flat deltas => unbounded per-battle leak.
  const heapSeries = cycleEndSamples.map((s) => s.heap?.usedMB ?? null);
  const heapDeltas = heapSeries
    .slice(1)
    .map((v, i) =>
      v != null && heapSeries[i] != null
        ? Math.round((v - heapSeries[i]) * 10) / 10
        : null,
    );
  const warmDeltas = heapDeltas.slice(MAPS.length); // revisit-window per-cycle deltas
  const firstHalf = warmDeltas
    .slice(0, Math.ceil(warmDeltas.length / 2))
    .filter((v) => v != null);
  const secondHalf = warmDeltas
    .slice(Math.ceil(warmDeltas.length / 2))
    .filter((v) => v != null);
  const avg = (a) =>
    a.length
      ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10
      : null;
  const slopeShape = {
    heapCycleEndMB: heapSeries,
    heapPerCycleDeltaMB: heapDeltas,
    warmAvgFirstHalfMB: avg(firstHalf),
    warmAvgSecondHalfMB: avg(secondHalf),
    interpretation:
      warmDeltas.length >= 4 &&
      avg(firstHalf) != null &&
      avg(secondHalf) != null
        ? avg(secondHalf) <= Math.max(2, avg(firstHalf) / 3)
          ? "TAPERING (bounded warming)"
          : Math.abs(avg(secondHalf) - avg(firstHalf)) <= 4
            ? "LINEAR (unbounded leak)"
            : "IRREGULAR"
        : "insufficient revisit deltas",
  };
  if (slopeShape.interpretation !== "insufficient revisit deltas") {
    console.log(
      `[memory-soak] heap slope: firstHalf=${slopeShape.warmAvgFirstHalfMB}MB/cycle secondHalf=${slopeShape.warmAvgSecondHalfMB}MB/cycle -> ${slopeShape.interpretation}`,
    );
  }

  let allocProfileSummary = null;
  if (cdp) {
    try {
      const prof = await cdp.send("HeapProfiler.stopSampling");
      const outProf = OUT.replace(/\.json$/, ".heapprofile");
      writeFileSync(outProf, JSON.stringify(prof.profile));
      // Top self-size call sites (collapsed to head samples).
      const heads = new Map();
      const visit = (node, depth = 0) => {
        if (!node) return;
        if (node.selfSize > 0) {
          const key = `${node.callFrame.functionName || "(anon)"} @ ${(node.callFrame.url || "").replace(/^.*\//, "")}:${node.callFrame.lineNumber}`;
          heads.set(key, (heads.get(key) || 0) + node.selfSize);
        }
        if (depth < 14)
          for (const c of node.children || []) visit(c, depth + 1);
      };
      visit(prof.profile.head);
      allocProfileSummary = [...heads]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24)
        .map(([site, selfBytes]) => ({
          site,
          selfKB: Math.round(selfBytes / 1024),
        }));
      console.log(`[memory-soak] top allocation sites (selfKB):`);
      for (const a of allocProfileSummary.slice(0, 8))
        console.log(`   ${String(a.selfKB).padStart(8)} KB  ${a.site}`);
    } catch (err) {
      allocProfileSummary = { error: String(err).slice(0, 160) };
    }
  }

  const report = {
    version: 1,
    tool: "tools/memory-soak.mjs",
    generatedAt: new Date().toISOString(),
    mode: "headed",
    cyclesRequested: CYCLES,
    cyclesCompleted: cycleRecords.length,
    mapSchedule: MAPS,
    vehicleSchedule: VEHICLES,
    combatSeconds: COMBAT_SECONDS,
    url,
    wallMs: Date.now() - t0,
    baseline,
    battles: battleSamples,
    cycleEnds: cycleEndSamples,
    cycleRecords,
    growthClassification: classification,
    slopeShape,
    allocProfileSummary,
    consoleErrorsAll: consoleErrors,
    consoleErrorsUnexpected: consoleErrors.filter(
      (e) => !ENVIRONMENTAL_CONSOLE_RE.test(e),
    ),
    pageErrors,
    notes:
      "Desktop design keeps every visited battlefield cached (worldScenes=Infinity): first visits grow GPU counts by design; verdict uses revisit cycles only.",
  };
  mkdirSync(".qa-dev", { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  const green =
    classification.verdict === "STABLE" &&
    report.pageErrors.length === 0 &&
    report.consoleErrorsUnexpected.length === 0 &&
    cycleRecords.every((r) => r.mapOk);
  console.log(
    `\n[memory-soak] ${green ? "SOAK STABLE/GREEN" : "SOAK FLAGGED"} — verdict=${classification.verdict}, ${cycleRecords.length}/${CYCLES} cycles, report: ${OUT}`,
  );
  process.exit(green ? 0 : 1);
} catch (err) {
  try {
    mkdirSync(".qa-dev", { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          version: 1,
          tool: "tools/memory-soak.mjs",
          generatedAt: new Date().toISOString(),
          crashed: true,
          crashMessage: String(err).slice(0, 500),
          consoleErrorsAll: consoleErrors,
          pageErrors,
        },
        null,
        1,
      ),
    );
  } catch (_) {
    /* best-effort evidence */
  }
  console.error(`[memory-soak] CRASHED: ${String(err).slice(0, 300)}`);
  process.exit(2);
} finally {
  try {
    if (browser) await browser.close();
  } catch (_) {}
  try {
    if (server) await server.close();
  } catch (_) {}
}
