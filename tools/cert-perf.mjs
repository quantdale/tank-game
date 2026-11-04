// tools/cert-perf.mjs — SA-11 performance certification harness (Campaign 3,
// promoted from the untracked .qa-dev/cert-perf.mjs so release evidence is
// reproducible from a clean checkout).
//
// Certifies a scene against the hard waypoint ff4708af on THIS host:
//
//   * boot: navigation -> __GAME_READY (+ __BOOT_TIMINGS)
//   * battle-open: the REAL player loading path (__DEBUG.beginBattleEntry) with
//     a live timeline plus the in-page __BATTLE_LOAD / __BATTLE_COUNTDOWN_WARM /
//     __VISUAL_LOAD_TIMINGS stage telemetry, so open time is ATTRIBUTED to
//     world build / roster bake / camo / terrain warm / combat warm / countdown.
//   * sustained window (default 45 s): rAF-gap p50/p95/p99/max + top stalls,
//     draw calls, triangles, shadow masks, shader-program births over time,
//     JS heap series + forced-GC retained-set delta.
//   * end census: renderer geometries/textures/programs, shadow RTs,
//     scene texture bytes, devTrace snapshot when available.
//
// CONTAMINATION GATE (Wave 3): a run is only an accepted certificate when it
// was clean WHILE IT RAN — not by explaining away bad numbers afterwards.
// Before accepting, the harness checks:
//   * system CPU busy-% (os.cpus()-time diff series; os.loadavg() is dead on
//     Windows) above --cpu-limit during the measurement window;
//   * PRESENTATION-GAP SIGNATURE: frame-delta clustering where single rAF gaps
//     reach >=10x the median delta, or >=3 gaps reach >=4x median. Healthy
//     vsync-real runs on this host top out near 4x median once (p99 ~33 ms vs
//     ~16.7 ms median); the documented co-tenant contamination showed max
//     ~9000 ms / p99 ~616 ms. Idle CPU + clustered dropped frames = the
//     GPU/presentation co-tenancy class that produced the bogus "30 FPS" cert.
// With --reject-contaminated=true (default) a contaminated run exits nonzero
// (code 2), stamps verdict.contaminated=true + reasons into the report JSON,
// and must be re-run on a quieter host. Pass --reject-contaminated=false ONLY
// to archive a diagnostic run — such reports are not certificates.
//
// Headless Chrome cannot complete battle-open on this host (campaign doc
// issue #2 — environmental renderer stall, identical at 970ef9e3), so the
// battle scene runs HEADED in a real visible window with backgrounding/
// occlusion throttling disabled. Garage (--scene garage) may run headless.
//
// Windows-host notes baked into this harness:
//   * os.loadavg() is always 0 on Windows — contention is measured by diffing
//     os.cpus() cumulative times into a real busy-% series instead.
//   * `ps` is crippled — foreign-process detection is a tasklist census of
//     chrome processes sampled over time (context + spike detection, not a gate).
//   * ports are picked below the WinNAT-reserved 7185-7284 block.
//
// Usage:
//   node tools/cert-perf.mjs --out=.qa-dev/cert-battle.json [--seconds 45]
//        [--map verdant] [--vehicle m1a2] [--roster kv2,jagdtiger,...|random]
//        [--scene battle|garage] [--headless] [--gputrace] [--label tag]
//        [--compare file.json] [--profile dir]
//        [--profile-policy cold|returning] [--reject-contaminated=true|false]
//        [--cpu-limit 85]
// PROFILE POLICY (--profile-policy): benchmarks must never mix player classes.
//   cold      — fresh throwaway Chrome temp profile (first-ever visit; pays
//               every shader/driver first-use). Default when no --profile given.
//   returning — persistent user-data dir reused across runs (GPU driver /
//               Chrome shader disk caches + IndexedDB derived assets warm).
//               Without an explicit --profile dir, uses
//               .qa-dev/profiles/<label|scene>. An explicit --profile implies
//               returning. The report always records which class ran.
// The legacy .qa-dev/cert-perf.mjs copy is DEPRECATED; tools/ is canonical.
import { createServer } from "vite";
import puppeteer from "puppeteer";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmdirSync,
  statSync,
  utimesSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Accepts BOTH --name value and --name=value forms (docs/examples use both).
const arg = (name, fallback) => {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const seconds = Number(arg("seconds", "45"));
const outFileArg = arg("out", ".qa-dev/cert-perf.json");
const mapId = arg("map", "verdant");
const vehicle = arg("vehicle", "m1a2");
const label = typeof arg("label", "") === "string" ? arg("label", "") : "";
const sceneMode = arg("scene", "battle");
const headed = sceneMode === "battle" ? true : !arg("headless", false);
const wantGpuTrace = !!arg("gputrace", false);
const compareFile =
  typeof arg("compare", "") === "string" ? arg("compare", "") : "";
const WORST_CASE_ROSTER = "kv2,jagdtiger,tiger2,object279,is7,t30,t95";
const rosterOpt = arg("roster", WORST_CASE_ROSTER);
const forceRoster =
  rosterOpt === "random"
    ? null
    : String(rosterOpt)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
// W2-A: pin the origin when measuring the derived-atlas disk cache —
// IndexedDB is per-origin, so a randomized port defeats cross-run reuse.
const forcePort = Number(arg("port", "0")) || null;

// --- Wave 3 gates -----------------------------------------------------------
// Reject contaminated runs BEFORE accepting them (default true).
const rejectContaminated = String(arg("reject-contaminated", true)) !== "false";
const CPU_BUSY_LIMIT = Number(arg("cpu-limit", "85")); // % system-wide busy

// Profile policy: never mix cold-player and returning-player numbers.
const explicitProfile = arg("profile", "");
let userDataDir = typeof explicitProfile === "string" ? explicitProfile : "";
let profilePolicy;
if (arg("profile-policy", "") === "cold") {
  profilePolicy = "cold";
  userDataDir = "";
} else if (arg("profile-policy", "") === "returning") {
  profilePolicy = "returning";
  if (!userDataDir) {
    userDataDir = resolve(
      repoRoot,
      ".qa-dev",
      "profiles",
      label || sceneMode || "cert",
    );
    mkdirSync(userDataDir, { recursive: true });
  }
} else {
  profilePolicy = userDataDir ? "returning-explicit" : "cold";
}
// Anchor relative default outputs to the repo, not the caller's cwd.
const outFile = resolve(
  outFileArg.includes("/") || outFileArg.includes("\\")
    ? outFileArg
    : resolve(repoRoot, outFileArg),
);

// ---------------------------------------------------------------------------
// GPU-harness serialization: same advisory lock as tools/perfprobe.mjs and the
// screenshot tools (/tmp/cot-shots.lock) so concurrent agent harnesses on this
// machine never share the GPU mid-certification. FIFO tickets, stale reclaim.
const LOCK_DIR = "/tmp/cot-shots.lock";
const QUEUE_DIR = "/tmp/cot-shots.queue";
const LOCK_STALE_MS = 5 * 60 * 1000;
const TICKET_STALE_MS = 60 * 60 * 1000;
let lockHeld = false;
function ticketPid(name) {
  const m = name.match(/-(\d+)\.t$/);
  return m ? parseInt(m[1], 10) : -1;
}
function ticketAlive(name) {
  const pid = ticketPid(name);
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function acquireLock(timeoutMs) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const myTicket = `${String(Date.now()).padStart(15, "0")}-${process.pid}.t`;
  writeFileSync(`${QUEUE_DIR}/${myTicket}`, String(process.pid));
  const t0 = Date.now();
  try {
    for (;;) {
      let head = null;
      let names = [];
      try {
        names = readdirSync(QUEUE_DIR)
          .filter((n) => n.endsWith(".t"))
          .sort();
      } catch {
        names = [myTicket];
      }
      for (const n of names) {
        if (n === myTicket) {
          head = head || n;
          break;
        }
        let stale = false;
        try {
          stale =
            Date.now() - statSync(`${QUEUE_DIR}/${n}`).mtimeMs >
            TICKET_STALE_MS;
        } catch {
          continue;
        }
        if (stale || !ticketAlive(n)) {
          try {
            unlinkSync(`${QUEUE_DIR}/${n}`);
          } catch {
            /* raced */
          }
          continue;
        }
        head = n;
        break;
      }
      if (head === myTicket) {
        try {
          mkdirSync(LOCK_DIR);
          lockHeld = true;
          return;
        } catch {
          /* held */
        }
        try {
          if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
            try {
              rmdirSync(LOCK_DIR);
            } catch (e) {
              if (e.code === "ENOTDIR") unlinkSync(LOCK_DIR);
              else throw e;
            }
            continue;
          }
        } catch {
          continue;
        }
      }
      if (Date.now() - t0 > timeoutMs)
        throw new Error("cot-shots lock timeout");
      await new Promise((r) => setTimeout(r, head === myTicket ? 300 : 1000));
    }
  } finally {
    try {
      unlinkSync(`${QUEUE_DIR}/${myTicket}`);
    } catch {
      /* fine */
    }
  }
}
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    rmdirSync(LOCK_DIR);
  } catch {
    /* fine */
  }
}
await acquireLock(15 * 60 * 1000);
process.on("exit", releaseLock);
const lockRefresher = setInterval(() => {
  try {
    const now = new Date();
    utimesSync(LOCK_DIR, now, now);
  } catch {
    /* fine */
  }
}, 60 * 1000);
lockRefresher.unref();

// ---------------------------------------------------------------------------
// Windows-aware machine contention sampling. os.loadavg() is dead weight here;
// diff os.cpus() times for a genuine busy-% series, and keep a tasklist census
// of chrome.exe processes across the run (co-tenant browser fleets were the
// documented source of the contaminated certificate — context + spikes).
function cpuSnapshot() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += busy + t.idle;
  }
  return { busy, total };
}
function chromeCensus() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', {
      encoding: "utf8",
    });
    return out.split("\n").filter((l) => l.trim().startsWith('"')).length;
  } catch {
    return -1;
  }
}
let prevCpu = cpuSnapshot();
let cpuBusyMax = 0;
const CORES = os.cpus().length;
const cpuSamples = [];
const chromeSeries = [];
let chromeProcsStart = -1;
const cpuSampler = setInterval(() => {
  const nowSnap = cpuSnapshot();
  const dB = nowSnap.busy - prevCpu.busy;
  const dT = nowSnap.total - prevCpu.total;
  prevCpu = nowSnap;
  if (dT > 0) {
    const pct = +((dB / dT) * 100).toFixed(1);
    cpuSamples.push(pct);
    cpuBusyMax = Math.max(cpuBusyMax, pct);
  }
}, 5000);
const chromeSampler = setInterval(() => {
  const n = chromeCensus();
  if (n >= 0) {
    chromeSeries.push({ tMs: Date.now() - runT0, processes: n });
    if (n > (machineStats.chromeProcessesMax ?? 0))
      machineStats.chromeProcessesMax = n;
  }
}, 15000);
chromeSampler.unref?.();
const machineStats = { chromeProcessesMax: 0 };

// Presentation-gap signature: clustered dropped frames while CPUs sit idle is
// the GPU/presentation co-tenancy fingerprint (doc §7 contamination postmortem).
function analyzeGaps(deltas) {
  if (!deltas || deltas.length < 30)
    return { detected: false, samples: deltas ? deltas.length : 0 };
  const sorted = [...deltas].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (!(med > 0)) return { detected: false, samples: deltas.length };
  let g4 = 0;
  let g10 = 0;
  let maxGap = 0;
  for (const d of deltas) {
    if (d >= 4 * med) g4++;
    if (d >= 10 * med) g10++;
    if (d > maxGap) maxGap = d;
  }
  return {
    detected: g10 >= 1 || g4 >= 3,
    samples: deltas.length,
    medianDeltaMs: +med.toFixed(2),
    gapsAt4xMedian: g4,
    gapsAt10xMedian: g10,
    maxGapMs: +maxGap.toFixed(1),
    rule: "detected when any gap >=10x median or >=3 gaps >=4x median (healthy vsync runs stay <=~2x p99, one <=4x outlier)",
  };
}

const runT0 = Date.now();
const port = forcePort || 5320 + Math.floor(Math.random() * 110); // below WinNAT 7185-7284
const server = await createServer({
  root: repoRoot,
  logLevel: "error",
  // strictPort: a busy pinned port must FAIL loudly, not fall forward - the
  // report's origin keys IndexedDB-derived caches and reused profiles; a
  // silently shifted port measures a different browser state (W01 finding).
  server: { port, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
});
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
console.error(
  `[cert] vite up at ${base} (${headed ? "headed" : "headless"}, scene=${sceneMode}, profile=${profilePolicy})`,
);

const launchArgs = [
  "--no-first-run",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--enable-precise-memory-info",
  "--js-flags=--expose-gc",
];
if (headed) {
  launchArgs.push(
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-position=40,40",
    "--window-size=1380,860",
  );
} else {
  launchArgs.push(
    "--use-gl=angle",
    "--enable-webgl",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  );
}
const browser = await puppeteer.launch({
  headless: !headed,
  protocolTimeout: 480000,
  userDataDir,
  args: launchArgs,
});
chromeProcsStart = chromeCensus();

const page = await browser.newPage();
await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon"))
    consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) =>
  consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`),
);

const url = `${base}/?nosplash=1&tier=desktop&gfxreset=1${wantGpuTrace ? "&gputrace=1" : ""}`;

let failed = false;
let rejected = false;
let report = null;
try {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction("window.__GAME_READY === true", {
    timeout: 240000,
    polling: 250,
  });
  const navToReadyMs = Date.now() - t0;
  const bootTimings = await page.evaluate(() => ({
    bootMs: window.__BOOT_MS || null,
    timings: window.__BOOT_TIMINGS || null,
  }));

  // --- battle entry (real player loading path) ------------------------------
  const timeline = [];
  let battleOpen = null;
  if (sceneMode === "battle") {
    await page.evaluate(
      (roster, spec, map) => {
        const D = window.__DEBUG;
        if (roster) D.flags.forceRoster = roster;
        D.flags.forceFire = true;
        D.beginBattleEntry(spec, map); // resolves when the loader hands over
        return true;
      },
      forceRoster,
      vehicle,
      mapId,
    );

    // Live timeline: phase + preBattleS transitions every 500 ms until combat.
    const entryT0 = Date.now();
    let sawFiniteCountdown = false;
    let countdownStartedAt = null;
    let openedAt = null;
    for (;;) {
      const row = await page
        .evaluate(() => {
          const g = window.__DEBUG.game;
          return {
            phase: g.phase,
            preBattleS: Number.isFinite(g.preBattleS)
              ? +Number(g.preBattleS).toFixed(2)
              : null,
            visualsBuilt: (g.tanks || []).filter((e) => e.visual).length,
            tanks: (g.tanks || []).length,
          };
        })
        .catch(() => ({ phase: "dead" }));
      const atMs = Date.now() - t0;
      const last = timeline[timeline.length - 1];
      if (
        !last ||
        last.phase !== row.phase ||
        last.preBattleS !== row.preBattleS ||
        last.visualsBuilt !== row.visualsBuilt
      ) {
        timeline.push({ tMs: atMs, ...row });
      }
      // preBattleS: null == Infinity (still behind the loader); finite == the
      // visible PRE_BATTLE_HOLD countdown is running; <= 0 == controls released
      if (
        row.phase === "battle" &&
        row.preBattleS !== null &&
        sawFiniteCountdown === false
      ) {
        sawFiniteCountdown = true;
        countdownStartedAt = atMs; // loader hidden, PRE_BATTLE_HOLD ticking
      }
      if (
        row.phase === "battle" &&
        row.preBattleS !== null &&
        row.preBattleS <= 0
      ) {
        openedAt = atMs; // controls released
        break;
      }
      if (Date.now() - entryT0 > 420000)
        throw new Error("battle-open timeout (420 s)");
      await new Promise((r) => setTimeout(r, 250));
    }
    const entryToOpenMs = Date.now() - entryT0;

    // Pull the in-page load telemetry written behind the loading screen.
    battleOpen = await page.evaluate(() => {
      const agg = {};
      for (const row of window.__VISUAL_LOAD_TIMINGS || []) {
        const key = `${row.specId}|${row.quality}`;
        const a = (agg[key] ||= {
          specId: row.specId,
          quality: row.quality,
          count: 0,
          prebakeMs: 0,
          buildMs: 0,
          uploadMs: 0,
          totalMs: 0,
        });
        a.count++;
        a.prebakeMs += row.prebakeMs || 0;
        a.buildMs += row.buildMs || 0;
        a.uploadMs += row.uploadMs || 0;
        a.totalMs += row.totalMs || 0;
      }
      return {
        battleLoad: window.__BATTLE_LOAD || null,
        countdownWarm: window.__BATTLE_COUNTDOWN_WARM || null,
        combatWarm: window.__COMBAT_WARM || null,
        studioWarm: window.__STUDIO_WARM || null,
        forwardWarmStats: window.__FORWARD_WARM_STATS || null, // W2-A: compile vs uniforms split
        burntDiskStats: window.__BURNT_DISK_STATS || null, // W2-A: derived-atlas disk cache counters
        worldLoad: window.__WORLD_LOAD || null,
        visualTimingsAgg: Object.values(agg).sort(
          (x, y) => y.totalMs - x.totalMs,
        ),
      };
    });
    battleOpen.entryToOpenMs = entryToOpenMs;
    battleOpen.countdownStartedAtMs = countdownStartedAt;
    battleOpen.openedAtMs = openedAt;
    battleOpen.navToOpenMs = openedAt;
  }

  // --- settle before sampling -----------------------------------------------
  if (sceneMode === "battle") {
    // Wait (bounded) for every roster entity to own a staged visual AND for
    // that to stay true 3 s — mirrors perfprobe's settled-stable policy.
    await page
      .waitForFunction(
        `(() => {
        const t = window.__DEBUG.game.tanks || [];
        const all = t.length > 0 && t.every((e) => !!e.visual);
        const key = all ? t.length : -1;
        if (!all) { window.__CERT_STABLE = null; return false; }
        if (!window.__CERT_STABLE || window.__CERT_STABLE.key !== key) {
          window.__CERT_STABLE = { key, at: performance.now() };
          return false;
        }
        return performance.now() - window.__CERT_STABLE.at > 3000;
      })()`,
        { timeout: 45000, polling: 250 },
      )
      .catch(() =>
        console.error(
          "[cert] staged visuals did not fully settle within 45 s — sampling anyway",
        ),
      );
  }
  await new Promise((r) => setTimeout(r, 4000));

  // Retained-set heap across the window (forced majors at both boundaries,
  // matching tools/perfprobe.mjs semantics): collect BEFORE the window opens.
  const retainedStart = await page.evaluate(() => {
    if (window.gc) {
      window.gc();
      window.gc();
    }
    return performance.memory ? performance.memory.usedJSHeapSize : -1;
  });

  // --- sustained sampling window --------------------------------------------
  await page.evaluate((sampleMs) => {
    const R = window.__DEBUG.renderer;
    R.info.autoReset = false;
    window.__CERT = {
      deltas: [],
      calls: [],
      tris: [],
      masks: [],
      heap: [],
      progs: [],
      done: false,
    };
    const P = window.__CERT;
    let last = -1;
    const t0p = performance.now();
    if (performance.memory) P.heap.push(performance.memory.usedJSHeapSize);
    const iv = setInterval(() => {
      if (performance.memory) P.heap.push(performance.memory.usedJSHeapSize);
      P.progs.push({
        tMs: Math.round(performance.now() - t0p),
        programs: R.info.programs.length,
      });
    }, 1000);
    function frame(now) {
      if (now - t0p > sampleMs) {
        clearInterval(iv);
        P.info = {
          geometries: R.info.memory.geometries,
          textures: R.info.memory.textures,
          programs: R.info.programs.length,
        };
        R.info.autoReset = true;
        P.done = true;
        return;
      }
      if (last >= 0) {
        P.deltas.push(now - last);
        P.calls.push(R.info.render.calls);
        P.tris.push(R.info.render.triangles);
        P.masks.push(window.__DEBUG.lighting.scheduledMask | 0);
      }
      R.info.reset();
      last = now;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, seconds * 1000);
  await page.waitForFunction("window.__CERT && window.__CERT.done === true", {
    timeout: (seconds + 60) * 1000,
  });

  // Retained-set heap at the window end (forced majors, post-GC floor).
  const retainedEnd = await page.evaluate(() => {
    if (window.gc) {
      window.gc();
      window.gc();
    }
    return performance.memory ? performance.memory.usedJSHeapSize : -1;
  });

  // --- end census -------------------------------------------------------------
  const census = await page.evaluate(async () => {
    const D = window.__DEBUG;
    const R = D.renderer;
    const seen = new Set();
    let bytes = 0;
    const addTex = (t) => {
      if (!t || seen.has(t.uuid)) return;
      seen.add(t.uuid);
      const img = t.image;
      let w = 0;
      let h = 0;
      if (img) {
        w = img.width || 0;
        h = img.height || 0;
      } else if (t.isDataTexture && t.source && t.source.data) {
        w = t.source.data.width || 0;
        h = t.source.data.height || 0;
      }
      if (!w || !h) return;
      bytes +=
        w *
        h *
        4 *
        (t.generateMipmaps ? 1.3333 : 1) *
        (t.isCubeTexture ? 6 : 1);
    };
    D.scene.traverse((o) => {
      const mats = Array.isArray(o.material)
        ? o.material
        : o.material
          ? [o.material]
          : [];
      for (const m of mats) {
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && v.isTexture) addTex(v);
        }
      }
    });
    if (D.scene.environment) addTex(D.scene.environment);
    if (D.scene.background && D.scene.background.isTexture)
      addTex(D.scene.background);
    let shadowRTCount = 0;
    let shadowRTMB = 0;
    try {
      const tele = D.lighting.getShadowTelemetry?.();
      for (const c of tele?.cascades || []) {
        if (!c.allocated || !c.allocatedSize) continue;
        shadowRTCount++;
        shadowRTMB += (c.allocatedSize * c.allocatedSize * 4) / 1048576;
      }
    } catch {
      /* lighting facade without telemetry */
    }
    let rtTotal = shadowRTCount + shadowRTMB * 0; // shadow cascades
    rtTotal = shadowRTCount + 4; // + standard post chain targets (renderProbes convention)
    const gpuTrace = window.__GPU_TIMER
      ? (() => {
          try {
            return window.__GPU_TIMER.results();
          } catch {
            return null;
          }
        })()
      : null;
    let traceSummary = null;
    try {
      const snap = D.devTrace?.snapshot?.();
      if (snap?.summary) traceSummary = snap.summary;
    } catch {
      /* flight recorder optional */
    }
    return {
      geometries: R.info.memory.geometries,
      textures: R.info.memory.textures,
      programs: R.info.programs.length,
      sceneTextureMB: +(bytes / 1048576).toFixed(1),
      uniqueTextures: seen.size,
      shadowRTCount,
      shadowRTMB: +shadowRTMB.toFixed(1),
      rtCount: rtTotal,
      quality: D.telemetry().quality,
      gpuPasses: gpuTrace,
      traceSummary,
    };
  });

  // --- assemble report ---------------------------------------------------------
  const perf = await page.evaluate(() => window.__CERT);

  const q = (arr, p) =>
    arr.length
      ? [...arr].sort((a, b) => a - b)[
          Math.min(arr.length - 1, Math.floor(p * arr.length))
        ]
      : null;
  const deltas = perf.deltas.slice().sort((a, b) => a - b);
  const fpsList = perf.deltas.map((d) => 1000 / Math.max(d, 0.5));

  clearInterval(cpuSampler);
  clearInterval(chromeSampler);
  clearInterval(lockRefresher);

  const gapAnalysis = analyzeGaps(perf.deltas);
  const worstStalls = perf.deltas
    .map((ms, i) => ({
      ms: +ms.toFixed(1),
      tMs: Math.round(
        i > 0 ? perf.deltas.slice(0, i).reduce((a, b) => a + b, 0) : 0,
      ),
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  const heap = perf.heap;
  const heapGrowthMBs =
    heap.length > 2
      ? (heap[heap.length - 1] - heap[0]) / (heap.length - 1) / 1048576
      : 0;
  let heapFloorGrowthMBs = 0;
  if (heap.length >= 6) {
    const third = Math.floor(heap.length / 3);
    const lo = Math.min(...heap.slice(0, third));
    const hi = Math.min(...heap.slice(-third));
    heapFloorGrowthMBs = (hi - lo) / (heap.length - third) / 1048576;
  }
  const progBirths =
    perf.progs.length > 1
      ? perf.progs[perf.progs.length - 1].programs - perf.progs[0].programs
      : 0;
  let progBiggestJump = 0;
  for (let i = 1; i < perf.progs.length; i++) {
    progBiggestJump = Math.max(
      progBiggestJump,
      perf.progs[i].programs - perf.progs[i - 1].programs,
    );
  }
  const shadowWork = Object.entries(
    perf.masks.reduce((groups, mask, index) => {
      const key = String(mask | 0);
      groups[key] ||= { calls: [], deltas: [] };
      groups[key].calls.push(perf.calls[index]);
      groups[key].deltas.push(perf.deltas[index]);
      return groups;
    }, {}),
  )
    .map(([mask, group]) => ({
      mask: +mask,
      frames: group.calls.length,
      drawCallsMedian: q(group.calls, 0.5),
      frameMsP99: +(q(group.deltas, 0.99) ?? 0).toFixed(2),
    }))
    .sort((a, b) => a.mask - b.mask);

  // --- contamination verdict ---------------------------------------------------
  const reasons = [];
  const classes = [];
  if (cpuBusyMax > CPU_BUSY_LIMIT) {
    reasons.push(
      `system CPU busy ${cpuBusyMax}% exceeded limit ${CPU_BUSY_LIMIT}% during measurement windows`,
    );
    classes.push("host-cpu");
  }
  if (gapAnalysis.detected) {
    reasons.push(
      `presentation-gap signature: ${gapAnalysis.gapsAt10xMedian} gap(s) >=10x median (${gapAnalysis.maxGapMs} ms max vs ${gapAnalysis.medianDeltaMs} ms median), ${gapAnalysis.gapsAt4xMedian} >=4x`,
    );
    classes.push("presentation");
  }
  const contended = cpuBusyMax > CPU_BUSY_LIMIT;
  const contaminated = reasons.length > 0;
  const verdict = {
    contaminated,
    contaminationClass: classes.join("+") || "clean",
    reasons,
    cpuBusyMaxPct: cpuBusyMax,
    cpuBusyLimitPct: CPU_BUSY_LIMIT,
    presentationGaps: gapAnalysis,
    rejected: contaminated && rejectContaminated,
    policy:
      "contaminated runs are environmental evidence, not certificates; re-run on a quiet host (--reject-contaminated=false archives diagnostics)",
  };

  report = {
    date: new Date().toISOString(),
    ...(label ? { label } : {}),
    waypointSha: "ff4708af",
    scene: sceneMode,
    mode: headed ? "headed" : "headless",
    profilePolicy,
    profileDir: userDataDir || null,
    map: sceneMode === "garage" ? mapId : mapId,
    vehicle: sceneMode === "battle" ? vehicle : null,
    roster: forceRoster ? `pinned:${forceRoster.join(",")}` : "random-seeded",
    viewport: { width: 1365, height: 768, deviceScaleFactor: 1 },
    sampleSeconds: seconds,
    frames: perf.deltas.length,
    navToReadyMs,
    bootTimings,
    ...(battleOpen
      ? {
          battleOpen,
          timeline,
        }
      : {}),
    fps: {
      median: +q(fpsList, 0.5).toFixed(1),
      p5: +q(fpsList, 0.05).toFixed(1),
      p1: +q(fpsList, 0.01).toFixed(1),
      mean: +(fpsList.reduce((a, b) => a + b, 0) / fpsList.length).toFixed(1),
    },
    frameMs: {
      median: +q(deltas, 0.5).toFixed(2),
      p95: +q(deltas, 0.95).toFixed(2),
      p99: +q(deltas, 0.99).toFixed(2),
      max: +deltas[deltas.length - 1].toFixed(2),
    },
    worstStalls,
    drawCalls: { median: q(perf.calls, 0.5), max: Math.max(...perf.calls) },
    triangles: { median: q(perf.tris, 0.5), max: Math.max(...perf.tris) },
    shadowWork,
    shaders: {
      programsStart: perf.progs[0]?.programs ?? null,
      programsEnd: perf.progs[perf.progs.length - 1]?.programs ?? null,
      birthsInWindow: progBirths,
      biggestSingleSecondJump: progBiggestJump,
      series: perf.progs,
    },
    census,
    heap: {
      startMB: heap.length ? +(heap[0] / 1048576).toFixed(1) : null,
      endMB: heap.length ? +(heap[heap.length - 1] / 1048576).toFixed(1) : null,
      growthMBperS: +heapGrowthMBs.toFixed(2),
      floorGrowthMBperS: +heapFloorGrowthMBs.toFixed(2),
      retainedPreGCMB:
        retainedStart > 0 ? +(retainedStart / 1048576).toFixed(1) : null,
      retainedPostGCMB:
        retainedEnd > 0 ? +(retainedEnd / 1048576).toFixed(1) : null,
      retainedGrowthMBperS:
        retainedStart > 0 && retainedEnd > 0
          ? +((retainedEnd - retainedStart) / seconds / 1048576).toFixed(2)
          : null,
      seriesMB: heap.map((b) => +(b / 1048576).toFixed(1)),
    },
    consoleErrors: consoleErrors.slice(0, 10),
    verdict,
    machine: {
      cores: CORES,
      platform: process.platform,
      cpuBusyMaxPct: cpuBusyMax,
      cpuBusySamples: cpuSamples,
      chromeProcessesStart: chromeProcsStart,
      chromeProcessesEnd: chromeCensus(),
      chromeProcessesMax: machineStats.chromeProcessesMax,
      chromeProcessesSeries: chromeSeries,
      contended,
      contentionNote:
        "Windows: os.loadavg() unavailable; contention = os.cpus()-diff busy-% series + chrome.exe tasklist series",
    },
  };

  if (compareFile) {
    try {
      const base2 = JSON.parse(readFileSync(resolve(compareFile), "utf8"));
      const rows = [];
      const cmp = (name, b, c, goodDown = true) => {
        if (b == null || c == null) return;
        const d = c - b;
        const good = goodDown ? d <= 0 : d >= 0;
        rows.push({
          metric: name,
          baseline: b,
          current: c,
          delta: +d.toFixed(2),
          better: good,
        });
      };
      cmp("navToReadyMs", base2.navToReadyMs, report.navToReadyMs);
      if (base2.battleOpen && report.battleOpen) {
        cmp(
          "battleOpen.navToOpenMs",
          base2.battleOpen.navToOpenMs,
          report.battleOpen.navToOpenMs,
        );
        cmp(
          "battleOpen.entryToOpenMs",
          base2.battleOpen.entryToOpenMs,
          report.battleOpen.entryToOpenMs,
        );
        cmp(
          "battleOpen.countdownStartedAtMs",
          base2.battleOpen.countdownStartedAtMs,
          report.battleOpen.countdownStartedAtMs,
        );
      }
      cmp("fps.median", base2.fps?.median, report.fps.median, false);
      cmp("fps.p5", base2.fps?.p5, report.fps.p5, false);
      cmp("fps.p1", base2.fps?.p1, report.fps.p1, false);
      cmp("fps.mean", base2.fps?.mean, report.fps.mean, false);
      cmp("frameMs.median", base2.frameMs?.median, report.frameMs.median);
      cmp("frameMs.p99", base2.frameMs?.p99, report.frameMs.p99);
      cmp("frameMs.max", base2.frameMs?.max, report.frameMs.max);
      cmp("drawCalls.median", base2.drawCalls?.median, report.drawCalls.median);
      cmp("drawCalls.max", base2.drawCalls?.max, report.drawCalls.max);
      cmp("triangles.median", base2.triangles?.median, report.triangles.median);
      cmp("triangles.max", base2.triangles?.max, report.triangles.max);
      cmp(
        "shaders.birthsInWindow",
        base2.shaders?.birthsInWindow,
        report.shaders.birthsInWindow,
      );
      cmp(
        "shaders.biggestSingleSecondJump",
        base2.shaders?.biggestSingleSecondJump,
        report.shaders.biggestSingleSecondJump,
      );
      cmp(
        "heap.retainedPostGCMB",
        base2.heap?.retainedPostGCMB,
        report.heap.retainedPostGCMB,
      );
      cmp(
        "heap.retainedGrowthMBperS",
        base2.heap?.retainedGrowthMBperS,
        report.heap.retainedGrowthMBperS,
      );
      cmp(
        "census.sceneTextureMB",
        base2.census?.sceneTextureMB,
        report.census.sceneTextureMB,
      );
      cmp("census.programs", base2.census?.programs, report.census.programs);
      cmp(
        "census.geometries",
        base2.census?.geometries,
        report.census.geometries,
      );
      cmp(
        "census.uniqueTextures",
        base2.census?.uniqueTextures,
        report.census.uniqueTextures,
      );
      const regressions = rows.filter((r) => !r.better).map((r) => r.metric);
      report.comparison = {
        against: compareFile,
        baselineProfilePolicy: base2.profilePolicy ?? "unrecorded(pre-w3)",
        rows,
        regressions,
      };
      console.error("[cert] comparison vs", compareFile);
      for (const r of rows) {
        console.error(
          `  ${r.metric.padEnd(34)} ${String(r.baseline).padStart(10)} -> ${String(r.current).padStart(10)}  ${r.better ? "BETTER" : "WORSE"}${r.better ? "" : "  <<<"}`,
        );
      }
      console.error(
        `[cert] regression metrics: ${regressions.length ? regressions.join(", ") : "(none)"}`,
      );
    } catch (e) {
      console.error(`[cert] comparison failed: ${e.message}`);
    }
  }

  writeFileSync(outFile, JSON.stringify(report, null, 1));
  console.error(`[cert] report -> ${outFile}`);
  console.error(
    `[cert] verdict: ${verdict.contaminationClass.toUpperCase()}${verdict.rejected ? " — RUN REJECTED (re-run on a quiet host)" : ""}`,
  );
  console.error(
    "[cert] headline:",
    JSON.stringify({
      navToReadyMs: report.navToReadyMs,
      battleOpenNavMs: report.battleOpen?.navToOpenMs ?? null,
      battleLoadStages: report.battleOpen?.battleLoad?.stages ?? null,
      warmStages: report.battleOpen?.countdownWarm?.stages ?? null,
      fpsMedian: report.fps.median,
      frameMsP99: report.frameMs.p99,
      frameMsMax: report.frameMs.max,
      drawCallsMax: report.drawCalls.max,
      trianglesMedian: report.triangles.median,
      contended,
      contaminated: verdict.contaminated,
    }),
  );
  if (verdict.rejected) rejected = true;
} catch (err) {
  failed = true;
  console.error("[cert] FAILED:", err.message);
  try {
    writeFileSync(
      outFile.replace(/\.json$/, ".failed.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          error: String(err),
          consoleErrors: consoleErrors.slice(0, 20),
        },
        null,
        1,
      ),
    );
  } catch {
    /* ignore */
  }
} finally {
  try {
    await browser.close();
  } catch {
    /* fine */
  }
  try {
    await server.close();
  } catch {
    /* fine */
  }
  clearInterval(cpuSampler);
  clearInterval(chromeSampler);
  releaseLock();
}
process.exit(failed ? 1 : rejected ? 2 : 0);
