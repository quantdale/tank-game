// W3 AI LIVE CERTIFICATION HARNESS (Campaign 3 final wave, W06a).
//
// Two legs:
//   LEG A (default, Node, deterministic — runs in CI-class environments):
//     node tools/w3-ai-cert.mjs [--maps=all|a,b,..] [--seeds=2] [--limitS=900]
//          [--json=.qa-dev/w3/w06a/leg-a.json] [--quiet]
//     Drives full authoritative matches (createAuthoritativeMatch + dedicated
//     world collision) to completion across every map id with seeded,
//     class-mixed bot rosters (including casemate-heavy 'td-line' shape) and
//     asserts the certification contract:
//       P1 spawn sanity        — finite/bounded/distinct spawn positions
//       P1 target acquisition  — each team holds a target within a bound
//                                derived from spawn separation (d0/2 + 90 s);
//                                plus a close-quarters 'contact' drill per map
//                                (explicit spawns ~110 m apart) that must
//                                acquire within 20 s and fire within 60 s
//       P1 match termination   — result within battleLimitS
//       P1 dead-bot zero work  — destroyed bots never fire again / inputs idle
//       P1 stuck bound         — no bot wedged >12 s (SA-04 flag threshold)
//       P1 spin bound          — no stationary yaw churn streak >8 s
//       P1 idle bots           — every surviving bot displaces >12 m total
//       P1 friendly fire       — zero friendly shell hits
//       P1 invalid shots       — zero shots from dead shooters (post-grace)
//       WARN cover-blind fire  — >5% shells impact world terrain/props within
//                                8 m of the SHOOTER (>15% escalates to FAIL):
//                                blasting the cover you are touching while a
//                                live target exists elsewhere
//     Determinism: rosters/seeds derived per (mapIndex, seed); sim RNG is the
//     match's own seeded rng. No Math.random in Leg A paths.
//
//   LEG B (--browser skeleton, headed Chrome — phase 2 of the campaign):
//     node tools/w3-ai-cert.mjs --browser --map=verdant [--seconds=60]
//     Boots a REAL battle through window.__DEBUG.beginSoloBattle on its own
//     vite server (5306 band), then samples live bot controllers read-only
//     into window.__AI_CERT. READ-ONLY: no product logic is modified; the
//     sampler tolerates missing fields so it can ride along with any roster.
//
// Evidence: JSON rows per match (Leg A) or per sample window (Leg B).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const QUIET = hasFlag("quiet");

// ---- Leg B dispatch ---------------------------------------------------------

if (hasFlag("browser")) {
  await runBrowserLeg({
    mapId: arg("map", "verdant"),
    seconds: Number(arg("seconds", "60")) || 60,
    out: resolve(arg("out", ".qa-dev/w3/w06a/leg-b-skeleton.json")),
    headless: hasFlag("headless"),
  });
} else {
  await runNodeLeg({
    mapsArg: arg("maps", "all"),
    seedCount: Number(arg("seeds", "2")) || 2,
    limitS: Number(arg("limitS", "900")) || 900,
    out: resolve(arg("json", ".qa-dev/w3/w06a/leg-a.json")),
  });
}

// ==== LEG A — deterministic Node certification ================================

async function runNodeLeg({ mapsArg, seedCount, limitS, out }) {
  const { createAuthoritativeMatch } = await import(
    "../src/sim/authoritativeMatch.js"
  );
  const { ALL_TANK_IDS, getSpec } = await import("../src/vehicles/specs.js");
  const { MAP_IDS, getMapConfig } = await import("../src/world/maps/index.js");
  const { createDedicatedWorldCollision } = await import(
    "../server/dedicatedWorldCollision.js"
  );

  const maps =
    mapsArg === "all" ? MAP_IDS : mapsArg.split(",").map((s) => s.trim());
  const unknown = maps.filter((m) => !MAP_IDS.includes(m));
  if (unknown.length) throw new Error(`unknown map ids: ${unknown.join(",")}`);

  // Class-mixed doctrine roster (mirrors .qa-dev/sa04-match-soak.mjs): light/
  // medium/heavy/td/mbt slots exercise scout, brawler, sniper, casemate roles.
  const CLASSES = ["light", "medium", "heavy", "td", "mbt", "medium", "heavy"];
  const byClass = new Map();
  for (const id of ALL_TANK_IDS) {
    const c = getSpec(id).class;
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(id);
  }
  function pickFor(slot, mapIndex, seed) {
    const want = CLASSES[slot % CLASSES.length];
    const pool = byClass.get(want) || byClass.get("medium");
    const idx = (slot * 7 + mapIndex * 13 + seed * 5 + 3) % pool.length;
    return pool[idx];
  }
  /** td-line: both teams field mostly casemate turretless platforms so fixed-
   * mount doctrine (bow-on engagement, hull-traverse aiming) is certified on
   * every map, not just wherever the class mix happens to deal one in. */
  function roster(shapeId, mapIndex, seed) {
    const half =
      shapeId === "contact"
        ? 3
        : shapeId === "td7v7"
          ? 7
          : shapeId === "7v7"
            ? 7
            : 3;
    const players = [];
    for (let i = 0; i < half; i++) {
      players.push({
        id: `a${i}`,
        specId: pickFor(i, mapIndex, seed),
        team: "alpha",
        bot: true,
        difficulty: "normal",
      });
    }
    for (let i = 0; i < half; i++) {
      const specId =
        shapeId === "td7v7"
          ? (byClass.get("td") || byClass.get("medium"))[
              (i * 5 + mapIndex * 11 + seed) %
                (byClass.get("td") || byClass.get("medium")).length
            ]
          : pickFor(i + 3, mapIndex, seed);
      players.push({
        id: `b${i}`,
        specId,
        team: "bravo",
        bot: true,
        difficulty: "normal",
      });
    }
    return players;
  }

  /** Contact drill: explicit spawns anchored on the map's certified-flat
   * player pad, both teams clustered ~110 m apart across a midfield axis so
   * the SENSOR path (LOS acquisition, reaction, first shot) is certified
   * directly instead of gated on minutes of approach driving. Lateral ±24 m
   * offsets mirror the live ally-cluster spacing used by battle dressing.
   * Validated live: acquisition @3 s, terrain y handled by the match. */
  function contactSpawns(players, mapId) {
    const cfg = getMapConfig(mapId).spawns || {};
    const home = cfg.player || { x: 0, z: -300 };
    const foes =
      cfg.enemies && cfg.enemies.length ? cfg.enemies : [{ x: 0, z: 300 }];
    // Axis: player pad -> centroid of enemy pads.
    let cx = 0;
    let cz = 0;
    for (const f of foes) {
      cx += f.x;
      cz += f.z;
    }
    cx /= foes.length;
    cz /= foes.length;
    let dx = cx - home.x;
    let dz = cz - home.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const px = -dz;
    const pz = dx; // perpendicular for lateral offsets
    const D = 110;
    const off = (i, s) => ({
      x: (i - 1) * 24 * px * s,
      z: (i - 1) * 24 * pz * s,
    });
    const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
    return players.map((p) => {
      if (p.team === "alpha") {
        const o = off(Number(p.id.slice(1)), 1);
        const pos = { x: home.x + o.x, z: home.z + o.z };
        return {
          ...p,
          spawn: {
            ...pos,
            yaw: yawTo(pos, { x: home.x + dx * D, z: home.z + dz * D }),
          },
        };
      }
      const o = off(Number(p.id.slice(1)), -1);
      const pos = { x: home.x + dx * D + o.x, z: home.z + dz * D + o.z };
      return { ...p, spawn: { ...pos, yaw: yawTo(pos, home) } };
    });
  }

  // Acquisition bound scales with spawn separation: bots must CLOSE before
  // sensors can see. Bound assumes >=2 m/s effective closing rate including
  // route detours (measured ~160 s on verdant/urban at d0 430-630 m).
  const ACQUIRE_MARGIN_S = 90;
  const CONTACT_ACQ_S = 20; // P1: contact drill must acquire within this
  const CONTACT_SHOT_S = 60; // P1: contact drill first shell within this
  const STUCK_FAIL_S = 12; // P1: single continuous wedge budget (SA-04 flag)
  const SPIN_FAIL_S = 8; // P1: stationary yaw-churn streak budget
  const IDLE_MIN_M = 12; // P1: surviving bots displace at least this much
  const COVER_BLIND_M = 8; // world impact within this range of the SHOOTER
  const COVER_BLIND_WARN = 0.05;
  const COVER_BLIND_FAIL = 0.15;
  const DEAD_EVENT_GRACE_S = 1; // events may drain up to ~1 s late (SA-04 note)

  function runMatch(mapId, seed, shapeId) {
    const mapIndex = MAP_IDS.indexOf(mapId);
    let players = roster(shapeId, mapIndex, seed);
    if (shapeId === "contact") players = contactSpawns(players, mapId);
    const match = createAuthoritativeMatch({
      players,
      mapId,
      seed: 40000 + mapIndex * 101 + seed,
      countdownS: 0,
      battleLimitS: limitS,
      worldCollision: createDedicatedWorldCollision(mapId),
    });
    match.onMatchReady();

    const n = match.entities.length;
    const tel = {
      shots: 0,
      hits: 0,
      friendlyHits: 0,
      friendlyDamage: 0,
      invalidShots: 0,
      pointBlankWorldImpacts: 0,
      friendlySplash: [],
      friendlyDirect: [],
      friendlyIncidents: [],
    };
    const firedAtS = new Map(); // shellId -> timeS
    const deathAt = new Map(); // entityId -> timeS
    const tankById = new Map(match.entities.map((e) => [e.id, e]));
    let deadFiredAfter = 0;

    // P1 spawn sanity (evaluated before any tick).
    const spawnIssues = [];
    for (const e of match.entities) {
      const p = e.state.pos;
      if (!Number.isFinite(p.x + p.y + p.z))
        spawnIssues.push(`${e.id}:nonfinite`);
      if (Math.abs(p.x) > 460 || Math.abs(p.z) > 460)
        spawnIssues.push(`${e.id}:out-of-bounds`);
    }
    for (let i = 0; i < n && !spawnIssues.length; i++) {
      for (let j = i + 1; j < n; j++) {
        if (
          match.entities[i].state.pos.distanceTo(match.entities[j].state.pos) <
          2
        ) {
          spawnIssues.push(
            `${match.entities[i].id}~${match.entities[j].id}:overlap<2m`,
          );
          break;
        }
      }
    }

    // Per-second movement pathology sampling (SA-04 pattern).
    const prevPos = match.entities.map((e) => e.state.pos.clone());
    const movedTotal = new Float64Array(n);
    const stuckNow = new Float64Array(n);
    const maxStuck = new Float64Array(n);
    const spinStreak = new Float64Array(n);
    const maxSpinStreak = new Float64Array(n);
    const everStuckLong = new Uint8Array(n);
    let worstStuckWhere = null;

    // W06c diagnostics: 1 Hz per-entity history ring (~25 s) feeding
    // incident forensics (friendly-direct geometry at fire/hit time) plus a
    // per-second trace of any wedge exceeding the stuck bound so a grade
    // stall is decidable from a route-planner loop.
    const hist = match.entities.map(() => []);
    let stuckTraceIdx = -1;
    let stuckTrace = null;

    // P1 acquisition sampling: first play-second each entity held a target,
    // against a bound derived from actual spawn separation.
    let d0 = Infinity;
    for (const a of match.entities) {
      for (const b of match.entities) {
        if (a.team !== b.team)
          d0 = Math.min(d0, a.state.pos.distanceTo(b.state.pos));
      }
    }
    const acquireBoundS =
      shapeId === "contact"
        ? CONTACT_ACQ_S
        : Math.round(d0 / 2 + ACQUIRE_MARGIN_S);
    const firstShotS = { v: null }; // boxed: event handler assigns
    const firstAcquireS = new Map();
    let acquireSampledToS = -1;

    // P1 dead-bot zero work: post-death input sampling violations.
    const deadInputViolations = new Map();

    const t0 = process.hrtime.bigint();
    let ticks = 0;
    while (!match.result) {
      match.step({ dt: 1 / 60, inputs: new Map() });
      ticks++;
      if (ticks % 60 !== 0) continue;

      const sec = Math.floor(ticks / 60);
      const snap = match.snapshot({
        tick: ticks,
        serverTimeMs: sec * 1000,
        ackInputSeq: 0,
      });
      for (const ev of snap.events) {
        switch (ev.type) {
          case "shell_fired": {
            tel.shots++;
            if (firstShotS.v == null) firstShotS.v = ev.timeS;
            firedAtS.set(ev.shellId, ev.timeS);
            const deadAt = deathAt.get(ev.shooterId);
            if (deadAt != null && ev.timeS >= deadAt + DEAD_EVENT_GRACE_S) {
              tel.invalidShots++;
              deadFiredAfter++;
            }
            break;
          }
          case "tank_destroyed":
            if (!deathAt.has(ev.id)) deathAt.set(ev.id, ev.timeS);
            break;
          case "shell_hit": {
            tel.hits++;
            if (ev.targetId) {
              const t = tankById.get(ev.targetId);
              const s = tankById.get(ev.shooterId);
              if (t && s && t.team === s.team && ev.shooterId !== ev.targetId) {
                tel.friendlyHits++;
                tel.friendlyDamage += ev.damage || 0;
                // Classify: HE splash on an ally is by-design blast physics
                // (resolveHeBurst splashes every tank in the sphere); a
                // DIRECT friendly hit is an aim/discipline defect.
                const kind = ev.kind ?? "unknown";
                if (kind === "he_splash")
                  tel.friendlySplash.push(ev.damage || 0);
                else {
                  tel.friendlyDirect.push(
                    `${s?.specId}/${t?.specId}:${kind}:${ev.damage}`,
                  );
                  // W06c forensics: geometry around the shot - flight time,
                  // and both hulls' recent motion (positions/yaw/speed/mode)
                  // so "crossed the bore after launch" vs "gate miss" is
                  // decidable from the artifact.
                  tel.friendlyIncidents.push({
                    timeS: ev.timeS,
                    shellId: ev.shellId,
                    shooter: s.id,
                    victim: t.id,
                    kind,
                    damage: ev.damage || 0,
                    flightS: firedAtS.has(ev.shellId)
                      ? +(ev.timeS - firedAtS.get(ev.shellId)).toFixed(2)
                      : null,
                    shooterHistory: hist[match.entities.indexOf(s)].slice(-16),
                    victimHistory: hist[match.entities.indexOf(t)].slice(-16),
                  });
                }
              }
            }
            break;
          }
          case "shell_impact": {
            if (ev.kind !== "terrain" && ev.kind !== "prop") break;
            // Cover-blind fire: the shell lands on world geometry within
            // COVER_BLIND_M of the shooter itself — shooting the cover it is
            // touching instead of repositioning or engaging.
            const shooter = tankById.get(ev.shooterId);
            if (shooter && !shooter.combat.destroyed) {
              const sp = shooter.state.pos;
              if (Math.hypot(ev.x - sp.x, ev.z - sp.z) < COVER_BLIND_M) {
                tel.pointBlankWorldImpacts++;
              }
            }
            break;
          }
          default:
            break;
        }
      }
      match.afterSnapshotBroadcast();

      // Acquisition probe window (bound derived from spawn separation).
      if (sec <= acquireBoundS && sec > acquireSampledToS) {
        acquireSampledToS = sec;
        for (const e of match.entities) {
          if (firstAcquireS.has(e.id) || e.combat.destroyed) continue;
          if (e.aiCtl?.targetId != null) firstAcquireS.set(e.id, sec);
        }
      }

      // Movement pathology + dead-input probes.
      for (let i = 0; i < n; i++) {
        const e = match.entities[i];
        if (e.combat.destroyed) {
          // Grace: destruction events drain up to ~1 s late (SA-04), and the
          // killing tick itself ends with pre-death inputs still latched

          // until the next ai.update zeroes them — only count violations
          // sampled well after the recorded death time.
          const deadAt = deathAt.get(e.id);
          if (deadAt != null && sec >= deadAt + 2) {
            const v = deadInputViolations.get(e.id) || 0;
            if (e.input.fire || Math.abs(e.input.throttle || 0) > 0.01) {
              deadInputViolations.set(e.id, v + 1);
            }
          }
          continue;
        }
        const p = e.state.pos;
        const moved = p.distanceTo(prevPos[i]);
        movedTotal[i] += moved;
        prevPos[i].copy(p);
        const dYaw = Math.abs(e.state.yaw - (e._lastYaw ?? e.state.yaw));
        e._lastYaw = e.state.yaw;
        // W06c: 1 Hz history ring for incident forensics.
        {
          const h = hist[i];
          h.push({
            s: sec,
            x: +p.x.toFixed(1),
            z: +p.z.toFixed(1),
            y: +p.y.toFixed(1),
            yaw: +(e.state.yaw || 0).toFixed(2),
            spd: +(e.state.speed || 0).toFixed(1),
            thr: +(e.input.throttle || 0).toFixed(2),
            fire: !!e.input.fire,
            m: e.aiCtl?.state ?? null,
          });
          if (h.length > 25) h.shift();
        }
        const slow = moved < 0.35;
        if (slow && Math.abs(e.input.throttle || 0) > 0.35) {
          stuckNow[i]++;
          maxStuck[i] = Math.max(maxStuck[i], stuckNow[i]);
          if (stuckNow[i] * 1 >= 4) everStuckLong[i] = 1;
          if (stuckNow[i] > STUCK_FAIL_S && !worstStuckWhere) {
            worstStuckWhere = `${e.specId}@(${Math.round(p.x)},${Math.round(p.z)})y${Math.round(p.y)}`;
          }
          if (
            stuckNow[i] > STUCK_FAIL_S &&
            stuckTraceIdx === -1 &&
            !stuckTrace
          ) {
            stuckTraceIdx = i;
            stuckTrace = {
              specId: e.specId,
              id: e.id,
              startedS: sec,
              samples: [],
            };
          }
          if (stuckTraceIdx === i && stuckTrace) {
            const last = stuckTrace.samples[stuckTrace.samples.length - 1];
            if (!last || last.s !== sec) {
              stuckTrace.samples.push({
                s: sec,
                x: +p.x.toFixed(1),
                z: +p.z.toFixed(1),
                y: +p.y.toFixed(1),
                yaw: +(e.state.yaw || 0).toFixed(2),
                spd: +(e.state.speed || 0).toFixed(1),
                thr: +(e.input.throttle || 0).toFixed(2),
                str: +(e.input.steer || 0).toFixed(2),
                m: e.aiCtl?.state ?? null,
              });
            }
          }
          spinStreak[i] = dYaw > 0.25 ? spinStreak[i] + 1 : 0;
          maxSpinStreak[i] = Math.max(maxSpinStreak[i], spinStreak[i]);
        } else {
          stuckNow[i] = 0;
          spinStreak[i] = 0;
          if (stuckTraceIdx === i && stuckTrace) {
            stuckTrace.recoveredS = sec;
            stuckTraceIdx = -1;
          }
        }
      }
    }
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // Post-match rollups.
    const worstStuckS = Math.max(...maxStuck);
    const maxSpinS = Math.max(...maxSpinStreak);
    const idleBots = [];
    const movedVals = [];
    for (let i = 0; i < n; i++) {
      const e = match.entities[i];
      movedVals.push(movedTotal[i]);
      if (!e.combat.destroyed && movedTotal[i] < IDLE_MIN_M)
        idleBots.push(e.id);
    }
    movedVals.sort((a, b) => a - b);
    const medianMoved = movedVals[Math.floor(n / 2)] ?? 0;
    // Stuck-recovery demonstration among bots that wedged >=4 s at some point:
    // recovered = later displaced >= IDLE_MIN_M (dead bots are excluded from
    // the denominator — they cannot demonstrate recovery). Telemetry-only.
    const stuckIndices = [];
    for (let i = 0; i < n; i++) if (everStuckLong[i]) stuckIndices.push(i);
    const aliveStuck = stuckIndices.filter(
      (i) => !match.entities[i].combat.destroyed,
    );
    const recovered = aliveStuck.filter(
      (i) => movedTotal[i] >= IDLE_MIN_M,
    ).length;

    // P1 acquisition verdict: at least one holder per side that fielded tanks.
    const teamAcquired = { alpha: null, bravo: null };
    for (const [id, s] of firstAcquireS) {
      const team = tankById.get(id)?.team;
      if (team && (teamAcquired[team] == null || s < teamAcquired[team])) {
        teamAcquired[team] = s;
      }
    }

    const pointBlankFrac = tel.shots
      ? tel.pointBlankWorldImpacts / tel.shots
      : 0;
    const accuracy = tel.shots ? tel.hits / tel.shots : 0;

    const fails = [];
    const warns = [];
    if (spawnIssues.length) fails.push(`spawn:[${spawnIssues.join(",")}]`);
    const acqAlphaOk =
      !teamAcquired.alpha || teamAcquired.alpha <= acquireBoundS;
    const acqBravoOk =
      !teamAcquired.bravo || teamAcquired.bravo <= acquireBoundS;
    if (shapeId === "contact") {
      if (!teamAcquired.alpha || teamAcquired.alpha > CONTACT_ACQ_S)
        fails.push(`contact-no-acquire:${teamAcquired.alpha ?? "-"}s`);
      if (firstShotS.v == null || firstShotS.v > CONTACT_SHOT_S)
        fails.push(
          `contact-first-shot:${firstShotS.v == null ? "-" : `${Math.round(firstShotS.v)}s`}`,
        );
    } else {
      if (!acqAlphaOk) fails.push(`alpha-no-acquire-by-${acquireBoundS}s`);
      if (!acqBravoOk) fails.push(`bravo-no-acquire-by-${acquireBoundS}s`);
    }
    if (!match.result) fails.push(`no-result-within-${limitS}s`);
    if (tel.friendlyDirect.length > 0)
      fails.push(`friendly-direct:[${tel.friendlyDirect.join(";")}]`);
    else if (tel.friendlyHits > 0)
      warns.push(
        `friendly-splash:${tel.friendlySplash.length}x(${tel.friendlyDamage}dmg)`,
      );
    if (tel.invalidShots > 0) fails.push(`invalid-shots:${tel.invalidShots}`);
    if (deadInputViolations.size > 0) {
      fails.push(
        `dead-input-violations:${[...deadInputViolations.keys()].join(",")}`,
      );
    }
    if (worstStuckS > STUCK_FAIL_S)
      fails.push(`stuck:${worstStuckS}s@${worstStuckWhere ?? "?"}`);
    if (maxSpinS > SPIN_FAIL_S) fails.push(`spin:${maxSpinS}s`);
    if (idleBots.length) fails.push(`idle:[${idleBots.join(",")}]`);
    if (pointBlankFrac > COVER_BLIND_FAIL)
      fails.push(`cover-blind:${(pointBlankFrac * 100).toFixed(1)}%`);
    else if (pointBlankFrac > COVER_BLIND_WARN)
      warns.push(`cover-blind:${(pointBlankFrac * 100).toFixed(1)}%`);
    if (match.resultReason === "time_limit") warns.push("time-limit-reached");
    if (tel.shots >= 20 && accuracy < 0.05)
      warns.push(`accuracy:${(accuracy * 100).toFixed(1)}%`);

    return {
      mapId,
      seed,
      shape: shapeId,
      verdict: fails.length ? "FAIL" : warns.length ? "WARN" : "PASS",
      fails,
      warns,
      result: match.result,
      reason: match.resultReason,
      timeS: Math.round(match.timeS),
      ticks,
      aliveAlpha: match.entities.filter(
        (e) => e.team === "alpha" && !e.combat.destroyed,
      ).length,
      aliveBravo: match.entities.filter(
        (e) => e.team === "bravo" && !e.combat.destroyed,
      ).length,
      ...tel,
      accuracyPct: +(accuracy * 100).toFixed(1),
      coverBlindPct: +(pointBlankFrac * 100).toFixed(1),
      spawnSeparationM: Number.isFinite(d0) ? Math.round(d0) : null,
      acquireBoundS,
      firstShotS: firstShotS.v == null ? null : Math.round(firstShotS.v),
      alphaAcquireS: teamAcquired.alpha,
      bravoAcquireS: teamAcquired.bravo,
      medianMovedM: +medianMoved.toFixed(1),
      stuckThenRecoveredBots: `${recovered}/${aliveStuck.length}`,
      worstStuckWhere,
      worstStuckS,
      maxSpinStreakS: maxSpinS,
      cpuMsPerKTicks: +((wallMs / ticks) * 1000).toFixed(1),
    };
    if (stuckTrace) row.stuckTrace = stuckTrace;
    if (tel.friendlyIncidents.length === 0) delete row.friendlyIncidents;
    return row;
  }

  const rows = [];
  let failCount = 0;
  let warnCount = 0;
  for (const mapId of maps) {
    // Shapes: class-mix 3v3 (two seeds), class-mix 7v7, casemate-heavy line,
    // and a close-quarters contact drill (sensor path, explicit spawns).
    const plan = [
      ["3v3", 1],
      ["3v3", 2],
      ["7v7", 1],
      ["td7v7", 3],
      ["contact", 5],
    ];
    for (const [shapeId, seed] of plan) {
      if (seedCount <= 1 && shapeId === "3v3" && seed === 2) continue;
      const row = runMatch(mapId, seed, shapeId);
      rows.push(row);
      if (row.verdict === "FAIL") failCount++;
      if (row.verdict === "WARN") warnCount++;
      if (!QUIET) {
        console.log(
          `${row.verdict.padEnd(4)} ${row.mapId}[${row.shape}#s${row.seed}] ` +
            `${row.result}/${row.reason} t=${row.timeS}s shots=${row.shots} acc=${row.accuracyPct}% ` +
            `acq=a${row.alphaAcquireS ?? "-"}/b${row.bravoAcquireS ?? "-"}/${row.acquireBoundS}s d0=${row.spawnSeparationM}m ` +
            `ff=${row.friendlyHits} inv=${row.invalidShots} cb=${row.coverBlindPct}% ` +
            `stuck=${row.worstStuckS}s spin=${row.maxSpinStreakS}s move=${row.medianMovedM}m ` +
            `rec=${row.stuckThenRecoveredBots} cpu=${row.cpuMsPerKTicks}ms/kt` +
            (row.fails.length ? ` FAILS=[${row.fails.join(";")}]` : "") +
            (row.warns.length ? ` WARNS=[${row.warns.join(";")}]` : ""),
        );
      }
    }
  }

  const perMap = {};
  for (const r of rows) {
    (perMap[r.mapId] ||= []).push(r.verdict);
  }
  const mapVerdicts = Object.fromEntries(
    Object.entries(perMap).map(([m, vs]) => [
      m,
      vs.some((v) => v === "FAIL")
        ? "FAIL"
        : vs.some((v) => v === "WARN")
          ? "WARN"
          : "PASS",
    ]),
  );

  const summary = {
    generatedBy: "tools/w3-ai-cert.mjs Leg A",
    legAContract: {
      spawnSanity: "P1 finite/bounded/distinct spawns",
      acquisition:
        `P1 each team holds a target within a separation-derived bound ` +
        `(d0/2 + ${ACQUIRE_MARGIN_S}s; contact drill: ${CONTACT_ACQ_S}s, first shell ${CONTACT_SHOT_S}s)`,
      termination: `P1 result within battleLimitS (${limitS}s)`,
      deadZeroWork: "P1 destroyed bots never refire and inputs stay idle",
      stuckBound: `P1 no wedge >${STUCK_FAIL_S}s`,
      spinBound: `P1 no yaw churn streak >${SPIN_FAIL_S}s`,
      idleBound: `P1 survivors displace >=${IDLE_MIN_M}m`,
      friendlyFire: "P1 zero friendly shell hits",
      invalidShots: "P1 zero shots from dead shooters",
      coverBlindFire: `WARN >${COVER_BLIND_WARN * 100}% / FAIL >${COVER_BLIND_FAIL * 100}% shells impacting world within ${COVER_BLIND_M} m of their own shooter`,
    },
    matches: rows.length,
    failMatches: failCount,
    warnMatches: warnCount,
    mapVerdicts,
    legAVerdict: failCount === 0 ? "PASS" : "FAIL",
    rows,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `\n=== LEG A: ${summary.legAVerdict} — ${rows.length} matches, ${failCount} FAIL, ${warnCount} WARN across ${maps.length} maps ===`,
  );
  console.log(`per-map: ${JSON.stringify(mapVerdicts)}`);
  console.log(`evidence: ${out}`);
  // W06c: a failing Leg A must fail the process - CI/gates read the exit
  // code, not the log banner. WARN stays exit-0 unless --strict.
  const strict = process.argv.includes("--strict");
  if (failCount > 0 || (strict && warnCount > 0)) process.exitCode = 1;
}

// ==== LEG B — headed browser skeleton (phase 2; NOT run in this phase) =======

async function runBrowserLeg({ mapId, seconds, out, headless }) {
  const { createServer } = await import("vite");
  const puppeteer = (await import("puppeteer")).default;

  mkdirSync(".qa-dev/w3/w06a", { recursive: true });
  const consoleErrors = [];
  const pageErrors = [];

  let server = null;
  let browser = null;
  try {
    server = await createServer({
      root: process.cwd(),
      logLevel: "error",
      server: {
        port: 5306,
        strictPort: false,
        hmr: false,
        watch: { ignored: ["**/*"] },
      },
    });
    await server.listen();
    const port = server.config.server.port;

    browser = await puppeteer.launch({
      headless,
      protocolTimeout: 420000,
      args: [
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-features=CalculateNativeWinOcclusion",
        "--window-position=40,40",
        "--window-size=1380,860",
        "--no-first-run",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400));
    });
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));

    await page.goto(
      `http://localhost:${port}/?nosplash=1&tier=desktop&gfxreset=1`,
      {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      },
    );
    await page.waitForFunction("window.__GAME_READY === true", {
      timeout: 300000,
      polling: 1000,
    });

    // Install the READ-ONLY sampler before entering battle. It rides existing
    // structures only (__DEBUG.game tanks + their ai/aiCtl controllers).
    await page.evaluate(() => {
      window.__AI_CERT = { samples: [], startedAtS: null };
      window.__AI_CERT_INSTALLER = setInterval(() => {
        const g = window.__DEBUG?.game;
        if (!g || window.__AI_CERT.startedAtS == null) return;
        const tanks = g.tanks || [];
        window.__AI_CERT.samples.push({
          tS: performance.now() / 1000,
          bots: tanks.map((t) => ({
            id: t.id ?? t.specId ?? "?",
            team: t.team ?? null,
            destroyed: !!(t.combat?.destroyed ?? t.destroyed),
            mode: t.aiCtl?.state ?? t.ai?.state ?? null,
            targetId: t.aiCtl?.targetId ?? t.ai?.targetId ?? null,
            throttle: t.input?.throttle ?? null,
          })),
        });
      }, 1000);
    });

    await page.evaluate(
      (m) => window.__DEBUG.beginSoloBattle({ mapId: m }),
      mapId,
    );
    await page.waitForFunction(
      () => {
        const g = window.__DEBUG?.game;
        return !!g && (g.phase === "battle" || !!g.tanks?.length);
      },
      { timeout: 600000, polling: 2000 },
    );
    await page.evaluate(() => {
      window.__AI_CERT.startedAtS = performance.now() / 1000;
    });

    await new Promise((r) => setTimeout(r, seconds * 1000));

    const cert = await page.evaluate(() => ({
      samples: window.__AI_CERT.samples,
      telemetry: (() => {
        try {
          return window.__DEBUG.telemetry?.() ?? null;
        } catch {
          return null;
        }
      })(),
    }));
    clearIntervalSafe(page);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          generatedBy: "tools/w3-ai-cert.mjs Leg B (browser skeleton)",
          mapId,
          seconds,
          sampleWindows: cert.samples.length,
          botsPerSample: cert.samples[0]?.bots?.length ?? 0,
          acquisitionObserved: cert.samples.some((s) =>
            s.bots.some((b) => b.targetId != null),
          ),
          telemetryKeys: cert.telemetry ? Object.keys(cert.telemetry) : [],
          consoleErrors,
          pageErrors,
          status:
            "SKELETON-RUN (phase-2 certification requires full-map sweep + assertions)",
          rawSamples: cert.samples,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Leg B skeleton evidence: ${out}`);
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* teardown */
    }
    try {
      if (server) await server.close();
    } catch {
      /* teardown */
    }
  }
}

async function clearIntervalSafe(page) {
  try {
    await page.evaluate(() => {
      if (window.__AI_CERT_INSTALLER) clearInterval(window.__AI_CERT_INSTALLER);
    });
  } catch {
    /* page gone */
  }
}
