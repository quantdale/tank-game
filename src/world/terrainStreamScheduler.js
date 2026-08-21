// Budgeted terrain streaming scheduler. terrain.js's updateLOD used to build
// a picked chunk job synchronously — a fine-grid bake (~9.8k height samples,
// ~6 ms) plus geometry assembly landing whole inside one live combat frame.
// This scheduler drives the SAME job choices (terrainLodPolicy) over the SAME
// sliced builders (terrainStreamSlices) under a per-update millisecond budget:
// heavy construction is spread across frames and can never spill past the
// budget by more than one slice.
//
// Scheduling changes WHEN bytes are built, never WHAT: job selection is pure
// policy, builders are deterministic, and no wall-clock value enters the
// simulation. The clock is injectable so Node selftests are fully
// deterministic. DOM-free; chunk records are plain objects shaped like
// terrain.js's internal ones ({mesh, lods, fine, level, cx, cz, cx0, cz0}).

import {
  chooseTerrainLodBuild,
  planTerrainLodEvictions,
  terrainLodForDistance,
} from './terrainLodPolicy.js';
import {
  createChunkGeometryBuilder,
  createFineGridBaker,
  TERRAIN_LOD_SEGS,
} from './terrainStreamSlices.js';
import { CELL_STATES, CELL_AUXILIARY_VISIBLE } from './cellLifecycle.js';

const defaultClock = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

/**
 * Camera velocity from consecutive positions, m/s, into a reused {vx, vz}.
 * @returns {{vx:number, vz:number}}
 */
export function estimateCameraMotion(prevX, prevZ, x, z, dt, out = { vx: 0, vz: 0 }) {
  const invDt = dt > 1e-4 ? 1 / dt : 0;
  out.vx = (x - prevX) * invDt;
  out.vz = (z - prevZ) * invDt;
  return out;
}

/**
 * Create a streaming scheduler over a chunk record array.
 *
 * @param {object} opts
 * @param {Array} opts.chunks chunk records (terrain.js shape, mutated in place)
 * @param {object} opts.heightField HeightField from createHeightField
 * @param {?object} [opts.cells] CellLifecycle instance (optional spatial lifecycle)
 * @param {?Array} [opts.auxiliaryMeshes] terrain auxiliary mesh records to govern
 * @param {?function(number, number)} [opts.clock] monotonic ms source
 * @param {number} [opts.budgetMs] per-update spend for background jobs
 * @param {number} [opts.urgentBudgetMs] cap when visible detail is missing
 * @param {number} [opts.retentionInterval] updates between retention sweeps
 * @param {number} [opts.maxEvictionsPerSweep] geometry releases per sweep
 * @param {?function(object, number, object, number, number)} [opts.onComplete]
 *   (chunk, level, geometry, camX, camZ); default wires terrain.js-style swap
 * @param {?function(object, number, object)} [opts.onDispose]
 *   (chunk, level, geometry) — owner disposes GPU buffers here
 * @param {?object} [opts.statsTarget] receives streamedGeometryCount increments
 */
export function createTerrainStreamScheduler({
  chunks,
  heightField,
  cells = null,
  auxiliaryMeshes = null,
  clock = defaultClock,
  budgetMs = 1.25,
  urgentBudgetMs = 3,
  retentionInterval = 64,
  maxEvictionsPerSweep = 1,
  onComplete = null,
  onDispose = null,
  statsTarget = null,
} = {}) {
  const list = chunks;
  const auxList = auxiliaryMeshes || [];
  const pick = { index: -1, level: -1, distanceM: 0, urgent: false };
  const evictionPlan = [];
  let activeJob = null;     // job currently consuming budget
  let suspendedJob = null;  // preempted non-urgent job (single shelf slot)
  let updateCount = 0;

  // Reused per-update telemetry — the caller must read it before the next
  // update() (no per-frame allocation in the established hot loop).
  const stats = {
    picked: false, urgent: false, completed: false,
    slices: 0, msUsed: 0, msUsedMax: 0, overBudget: 0,
    suspended: 0, resumed: 0, evicted: 0,
    dormantSkips: 0, auxiliaryMeshesCulled: 0,
    jobsCompleted: 0, evictions: 0,
  };

  function initJob(job) {
    const c = list[job.index];
    // Mirror terrain.js: only sub-far levels need the shared fine grid, and a
    // grid already baked for a neighbouring level is reused, never rebuilt.
    job.needsFine = job.level < 2 && !c.fine;
    if (job.needsFine) {
      job.baker = createFineGridBaker(heightField, c.cx0, c.cz0);
      job.fineRow = 0;
      job.phase = 0;
    } else {
      // No bake needed (far LOD, or the fine grid is already cached):
      // start straight in the geometry phase.
      job.baker = null;
      enterGeometryPhase(job);
    }
    job.geoRow = 0;
    job.stepsTotal = (job.baker ? job.baker.rows : 0)
      + (TERRAIN_LOD_SEGS[job.level] + 1) + 1;
  }

  function enterGeometryPhase(job) {
    const c = list[job.index];
    if (job.baker) {
      c.fine = job.baker.result();
      job.baker = null;
    }
    job.builder = createChunkGeometryBuilder(
      heightField, c.cx0, c.cz0, TERRAIN_LOD_SEGS[job.level], c.fine,
    );
    job.phase = 1;
  }

  function stepOnce(job) {
    if (job.phase === 0) {
      job.baker.step();
      if (++job.fineRow >= job.baker.rows) enterGeometryPhase(job);
    } else if (job.phase === 1) {
      job.builder.step();
      if (++job.geoRow >= job.builder.rows) job.phase = 2;
    } else {
      finishJob(job);
    }
  }

  function finishJob(job) {
    const c = list[job.index];
    const geo = job.builder.finish();
    c.lods[job.level] = geo;
    if (c.lods.every(Boolean)) c.fine = null;
    stats.jobsCompleted++;
    if (statsTarget) statsTarget.streamedGeometryCount =
      (statsTarget.streamedGeometryCount || 0) + 1;
    if (onComplete) onComplete(c, job.level, geo, job.camX, job.camZ);
    else if (c.mesh) {
      // terrain.js's post-build swap: take the new detail immediately when it
      // is the level this chunk should be showing at the current distance.
      const d = Math.hypot(job.camX - c.cx, job.camZ - c.cz);
      const want = terrainLodForDistance(d, c.level);
      if (want === job.level) {
        c.level = want;
        c.mesh.geometry = c.lods[want];
      }
    }
    job.phase = 3;
  }

  function sweepRetention(camX, camZ) {
    planTerrainLodEvictions(list, camX, camZ, null, evictionPlan);
    if (cells && evictionPlan.length > 1) {
      // Prioritize releasing cached geometry from DORMANT/DISTANT cells first
      evictionPlan.sort((a, b) => {
        const ca = list[a.index], cb = list[b.index];
        const sa = ca ? cells.states[ca.cx !== undefined ? cells.indexAt(ca.cx, ca.cz) : a.index] : 0;
        const sb = cb ? cells.states[cb.cx !== undefined ? cells.indexAt(cb.cx, cb.cz) : b.index] : 0;
        if (sa !== sb) return sb - sa; // higher state (DORMANT=4) evicted first
        return b.distanceM - a.distanceM;
      });
    }
    let disposed = 0;
    for (let i = 0; i < evictionPlan.length; i++) {
      const cand = evictionPlan[i];
      const c = list[cand.index];
      // The plan is fresh within this call, but guard anyway against a chunk
      // whose state moved since planning (single-threaded, cheap check).
      if (c.level === cand.level || !c.lods[cand.level]) continue;
      const geo = c.lods[cand.level];
      c.lods[cand.level] = null;
      if (onDispose) onDispose(c, cand.level, geo);
      if (++disposed >= maxEvictionsPerSweep) break;
    }
    stats.evictions += disposed;
    return disposed;
  }

  /**
   * Run one bounded streaming update. Safe to call every rendered frame;
   * idle frames cost one policy scan (~64 hypots).
   * @param {number} camX camera world x
   * @param {number} camZ camera world z
   * @param {?{vx:number,vz:number}} [motion] camera velocity m/s
   */
  function update(camX, camZ, motion = null) {
    updateCount++;
    stats.picked = false; stats.urgent = false; stats.completed = false;
    stats.slices = 0; stats.msUsed = 0; stats.evicted = 0;
    stats.dormantSkips = 0; stats.auxiliaryMeshesCulled = 0;

    if (updateCount % retentionInterval === 0) {
      stats.evicted = sweepRetention(camX, camZ);
    }

    // Cell-lifecycle auxiliary mesh visibility sweep
    if (auxList.length > 0 && cells) {
      for (let i = 0; i < auxList.length; i++) {
        const aux = auxList[i];
        const ci = aux.cellIndex >= 0 ? aux.cellIndex : (aux.cellIndex = cells.indexAt(aux.x, aux.z));
        const cState = ci >= 0 ? cells.states[ci] : CELL_STATES.DORMANT;
        const vis = CELL_AUXILIARY_VISIBLE[cState];
        if (aux.mesh) {
          aux.mesh.visible = vis && (aux.enabled !== false);
        }
        if (!vis) stats.auxiliaryMeshesCulled++;
      }
    }

    // Preempt background work the moment visible detail goes missing
    // elsewhere: a hole/stale chunk outranks any prefetch. The suspended job
    // keeps its partial buffers and resumes where it stopped.
    if (activeJob && !activeJob.urgent) {
      const probe = chooseTerrainLodBuild(list, camX, camZ, pick, motion);
      if (probe && probe.urgent
        && (probe.index !== activeJob.index || probe.level !== activeJob.level)) {
        suspendedJob = activeJob;
        stats.suspended++;
        activeJob = makePicked(probe, camX, camZ);
      }
    }
    if (!activeJob) {
      if (suspendedJob) {
        // Resume only once nothing more urgent is pending; discard the shelf
        // if the job became moot (level arrived through another path).
        const probe = chooseTerrainLodBuild(list, camX, camZ, pick, motion);
        const c = list[suspendedJob.index];
        if (!c || c.lods[suspendedJob.level]) {
          suspendedJob = null;
        } else if (!probe || probe.urgent
          || (probe.index === suspendedJob.index && probe.level === suspendedJob.level)) {
          activeJob = suspendedJob;
          suspendedJob = null;
          stats.resumed++;
        }
      }
      if (!activeJob) {
        const job = chooseTerrainLodBuild(list, camX, camZ, pick, motion);
        if (!job) return stats;
        // When cell lifecycle is provided, skip background prefetch in DORMANT cells
        if (cells && !job.urgent) {
          const c = list[job.index];
          const ci = c && c.cx !== undefined ? cells.indexAt(c.cx, c.cz) : job.index;
          if (ci >= 0 && cells.states[ci] === CELL_STATES.DORMANT) {
            stats.dormantSkips++;
            return stats;
          }
        }
        activeJob = makePicked(job, camX, camZ);
      }
    }
    stats.picked = true;
    stats.urgent = activeJob.urgent;
    activeJob.camX = camX;
    activeJob.camZ = camZ;

    const startedAt = clock();
    const budget = activeJob.urgent ? urgentBudgetMs : budgetMs;
    // Step cap guards clocks that advance slower than real work (injected
    // test clocks): the budget stays the primary limiter on live hardware.
    const maxSteps = 4096;
    while (activeJob) {
      if (!activeJob.stepsTotal) initJob(activeJob);
      stepOnce(activeJob);
      stats.slices++;
      if (activeJob.phase === 3) {
        stats.completed = true;
        activeJob = null;
        break;
      }
      if (stats.slices >= maxSteps || clock() - startedAt >= budget) break;
    }
    const spent = clock() - startedAt;
    stats.msUsed = spent;
    if (spent > stats.msUsedMax) stats.msUsedMax = spent;
    if (spent > budget + budget * 0.5) stats.overBudget++;
    return stats;
  }

  function makePicked(picked, camX, camZ) {
    return {
      index: picked.index, level: picked.level, urgent: picked.urgent,
      camX, camZ, phase: 0, baker: null, builder: null,
      needsFine: false, fineRow: 0, geoRow: 0, stepsTotal: 0,
    };
  }

  return { update, stats };
}
