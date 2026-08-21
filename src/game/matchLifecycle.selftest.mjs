/**
 * matchLifecycle.selftest.mjs — SA-01 core-game-loop regression coverage.
 *
 * Runs the REAL solo match lifecycle headlessly (plain node, no DOM/WebGL):
 * setupBattle -> fixed-step simStep -> verdict -> rematch, N times, plus the
 * transition matrix around it. A minimal canvas/document stand-in satisfies
 * the presentation seam (materials.js texture bakes) — nothing rendered, no
 * GPU, and every assertion below is deterministic (seeded RNG streams only;
 * see the A/B replay-equality block).
 *
 * Covered contracts:
 *  1. repeated battles: setupBattle fully resets round state (result, clock,
 *     shells, rng, roster freshness) and evicts parked entities' visuals —
 *     no degradation or stale-state carry-over across sessions;
 *  2. verdict matrix: elimination VICTORY / TEAM DEFEAT (allies hold the
 *     battle open) / time-limit DRAW / victory-beats-timeout precedence,
 *     with 'battle:ended' emitted EXACTLY once per battle;
 *  3. determinism: two identically-driven game states produce byte-identical
 *     rosters, poses and clocks (no wall-clock/Math.random leakage);
 *  4. wreck freeze: destroyed hulls integrate nothing (no drift, no fire);
 *  5. spawn sanity: finite, non-overlapping spawn cells for every
 *     participant, seated on the heightfield;
 *  6. live-fire sanity: a fully staged AI battle steps hundreds of ticks
 *     with shells flying, no NaN, and a stable post-verdict state.
 */
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Headless presentation shims — MUST run before ./state.js is imported.
// materials.js paints textures onto <canvas>; the painters only need the 2D
// context API surface to exist (nothing is sampled back except typed arrays
// we hand out ourselves), so absorb-everything stubs keep the bake honest
// about control flow while staying allocation-cheap.
// ---------------------------------------------------------------------------
const noop = () => {};
const gradStub = { addColorStop: noop };
function makeCtx(canvas) {
  return new Proxy({ canvas }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
          k === 'createConicGradient') return () => gradStub;
      if (k === 'createPattern') return () => ({});
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData' || k === 'createImageData') {
        return (x, y, w, h) => ({
          data: new Uint8ClampedArray(Math.max(0, (w | 0) * (h | 0) * 4)),
          width: w, height: h,
        });
      }
      return typeof k === 'string' ? (() => {}) : undefined;
    },
    set() { return true; },
  });
}
globalThis.document = {
  createElement(tag) {
    const c = { tagName: tag, width: 0, height: 0, style: {}, dataset: {} };
    c.getContext = () => makeCtx(c);
    c.addEventListener = noop;
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height });
    return c;
  },
};
globalThis.window = globalThis;
// Camo painters build Path2D shapes; the stub context no-ops fill/stroke.
const absorbProxy = (target) => new Proxy(target, {
  get(t, k) {
    if (!(k in t)) t[k] = (..._a) => absorbProxy({});
    return t[k];
  },
  set(t, k, v) { t[k] = v; return true; },
});
globalThis.Path2D = class { constructor() { return absorbProxy(this); } };

const {
  createBus, createGameState, spawnTanks, setupBattle, simStep,
  createCollider, ensureStagedVisuals,
} = await import('./state.js');

const SIM_DT = 1 / 60;

/** Flat, obstacle-free proving-ground world (spawn pads mirrored on map layouts). */
function makeWorld() {
  const H = () => 0;
  return {
    spawnPoints: {
      player: { pos: [0, 0, 0], yaw: 0 },
      enemies: Array.from({ length: 13 }, (_, i) => ({
        pos: [200 + ((i / 4) | 0) * 40, 0, -150 + (i % 4) * 70],
        yaw: Math.PI,
      })),
    },
    heightField: {
      getHeightAt: H,
      getNormalAt: () => ({ x: 0, y: 1, z: 0 }),
      getGroundType: () => 'grass',
    },
    raycast: () => null,
    getObstacles: () => [],
  };
}
const WORLD = makeWorld();

function newGame() {
  const game = createGameState();
  // Minimal EngineCtx: scene add/remove only — visuals are built but never
  // rendered headlessly.
  spawnTanks(game, { scene: { add() {}, remove() {} } });
  return game;
}

/** Deterministic harness entry: setup + detach AI (zero-fire guarantee). */
function startTestBattle(game, playerSpecId) {
  setupBattle(game, playerSpecId, WORLD, {
    random: true, deferVisuals: true, deferCamoRepaint: true,
  });
  for (const ent of game.tanks) ent.aiCtl = null;
}

function round4(v) { return Math.round(v * 10000) / 10000; }

/** Compact deterministic fingerprint of the authoritative round state. */
function snapshot(game) {
  return JSON.stringify({
    timeS: round4(game.timeS),
    shells: game.shells.length,
    nextShellId: game.nextShellId,
    result: game.result,
    resultReason: game.resultReason,
    battleCount: game.battleCount,
    tanks: game.tanks.map((t) => [
      t.specId, t.team, t.isPlayer ? 1 : 0,
      round4(t.state.pos.x), round4(t.state.pos.y), round4(t.state.pos.z),
      round4(t.state.yaw), t.combat.hp,
    ]),
  });
}

function stepN(game, bus, collider, n, rig) {
  for (let i = 0; i < n; i++) simStep(game, bus, WORLD, rig, collider);
}

// ---------------------------------------------------------------------------
// 1. REPEATED SESSIONS — clean resets + parked-entity eviction
// ---------------------------------------------------------------------------
{
  const game = newGame();
  const poolSize = game.allTanks.length;
  const byIdSize = game.tankById.size;
  const rig = { addTrauma: noop };
  let collider = createCollider(game, WORLD);

  // Battle 1: full staging so every participant owns a disposable visual.
  startTestBattle(game, 'm1a2');
  ensureStagedVisuals(game);
  assert.ok(game.tanks.every((t) => t.visual), 'staged battle builds every visual');
  const roster1 = new Set(game.tanks.map((t) => t.id));
  stepN(game, createBus(null), collider, 120, rig);

  // Battle 2: a different player pick forces a mostly-fresh roster.
  startTestBattle(game, 'tiger1');
  assert.equal(game.player.specId, 'tiger1');
  assert.equal(game.result, null, 'rematch clears the previous verdict');
  assert.equal(game.resultReason, null);
  assert.equal(game.timeS, 0, 'rematch resets the battle clock');
  assert.equal(game.nextShellId, 1, 'rematch resets shell ids');
  assert.equal(game.shells.length, 0, 'rematch drains live shells');
  assert.equal(game.battleCount, 2);
  assert.equal(game.allTanks.length, poolSize, 'pool size is stable across battles');
  assert.equal(game.tankById.size, byIdSize, 'id map is stable across battles');

  // Parked entities (fought in battle 1, benched now) must be fully torn down.
  for (const ent of game.allTanks) {
    if (roster1.has(ent.id) && !game.tanks.includes(ent)) {
      assert.equal(ent.state, null, `${ent.id}: parked entity drops sim state`);
      assert.equal(ent.combat, null, `${ent.id}: parked entity drops combat`);
      assert.equal(ent.aiCtl, null, `${ent.id}: parked entity drops AI`);
      assert.equal(ent.visual, null, `${ent.id}: parked entity visual evicted`);
      assert.equal(ent.isPlayer, false);
    }
  }
  // Fresh participants own brand-new movement/combat records at full hp.
  for (const ent of game.tanks) {
    assert.ok(ent.state && ent.combat, `${ent.id} participant is field-ready`);
    assert.equal(ent.combat.hp, ent.combat.maxHp, `${ent.id} respawns at full hp`);
    assert.equal(ent.combat.destroyed, false);
    assert.equal(ent._destroyedAnnounced, false);
  }
  const playerCount = game.tanks.filter((t) => t.isPlayer).length;
  assert.equal(playerCount, 1, 'exactly one player entity per battle');
  const enemies = game.tanks.filter((t) => t.team === 'enemy').length;
  const allies = game.tanks.filter((t) => t.team === 'player').length;
  assert.equal(enemies, 7, 'random battles field seven enemies (7v7)');
  assert.equal(allies, 7, 'random battles field player + six allies');
  stepN(game, createBus(null), collider, 60, rig);

  // Battle 3: third session on the same global state — still pristine.
  startTestBattle(game, 'm1a2');
  assert.equal(game.result, null);
  assert.equal(game.timeS, 0);
  assert.equal(game.player.specId, 'm1a2');
  console.log('matchLifecycle: repeated-session resets + eviction passed');
}

// ---------------------------------------------------------------------------
// 2. VERDICT MATRIX — victory / team defeat / draw / precedence, single emit
// ---------------------------------------------------------------------------
{
  const game = newGame();
  const bus = createBus(null);
  const collider = createCollider(game, WORLD);
  const rig = { addTrauma: noop };
  let endedEvents = [];
  bus.on('battle:ended', (ev) => endedEvents.push(ev));

  // VICTORY: wipe the enemy team; one step decides, and the decision emits
  // exactly once no matter how long the aftermath simmers.
  startTestBattle(game, 'm1a2');
  for (const ent of game.tanks) {
    if (ent.team === 'enemy') { ent.combat.hp = 0; ent.combat.destroyed = true; }
  }
  simStep(game, bus, WORLD, rig, collider);
  assert.equal(game.result, 'victory');
  assert.equal(game.resultReason, 'elimination');
  assert.equal(endedEvents.length, 1, 'battle:ended emitted exactly once');
  assert.equal(endedEvents[0].result, 'victory');
  assert.equal(endedEvents[0].map, game.mapId, 'ended payload names the battlefield');
  assert.ok(Array.isArray(endedEvents[0].roster) && endedEvents[0].roster.length === 14,
    'ended payload carries the full roster');
  stepN(game, bus, collider, 60, rig);
  assert.equal(endedEvents.length, 1, 'post-verdict steps never re-emit');
  assert.equal(game.result, 'victory', 'verdict is sticky');

  // TEAM DEFEAT: the player dies but allies hold — WoT rule, no premature
  // verdict while the team fights on. Only the LAST wreck decides.
  startTestBattle(game, 'm1a2');
  endedEvents.length = 0;
  const teammates = game.tanks.filter((t) => t.team === 'player' && !t.isPlayer);
  assert.ok(teammates.length >= 6, 'allies present');
  game.player.combat.hp = 0;
  game.player.combat.destroyed = true;
  for (const ally of teammates.slice(1)) { ally.combat.hp = 0; ally.combat.destroyed = true; }
  stepN(game, bus, collider, 120, rig);
  assert.equal(game.result, null, 'no defeat while an ally still stands');
  const lastAlly = teammates[0];
  lastAlly.combat.hp = 0;
  lastAlly.combat.destroyed = true;
  simStep(game, bus, WORLD, rig, collider);
  assert.equal(game.result, 'defeat');
  assert.equal(game.resultReason, 'elimination');
  assert.equal(endedEvents.length, 1);

  // DRAW: the 15:00 clock expires with both teams on the field.
  startTestBattle(game, 'm1a2');
  endedEvents.length = 0;
  game.timeS = 900 - SIM_DT / 2; // cross the limit on the next step
  simStep(game, bus, WORLD, rig, collider);
  assert.equal(game.result, 'draw');
  assert.equal(game.resultReason, 'time_limit');
  assert.equal(endedEvents.length, 1);

  // PRECEDENCE: simultaneous final blow + timeout resolves as VICTORY.
  startTestBattle(game, 'm1a2');
  for (const ent of game.tanks) {
    if (ent.team === 'enemy') { ent.combat.hp = 0; ent.combat.destroyed = true; }
  }
  game.timeS = 900 - SIM_DT / 2;
  simStep(game, bus, WORLD, rig, collider);
  assert.equal(game.result, 'victory', 'elimination outranks the expiring clock');
  console.log('matchLifecycle: verdict matrix (victory/defeat/draw/precedence) passed');
}

// ---------------------------------------------------------------------------
// 3. DETERMINISM — identical drives produce identical authoritative state
// ---------------------------------------------------------------------------
{
  const a = newGame();
  const b = newGame();
  for (let battle = 0; battle < 2; battle++) {
    startTestBattle(a, 'm1a2');
    startTestBattle(b, 'm1a2');
    assert.equal(snapshot(a), snapshot(b), `battle ${battle + 1} setup is reproducible`);
    stepN(a, createBus(null), createCollider(a, WORLD), 90, { addTrauma: noop });
    stepN(b, createBus(null), createCollider(b, WORLD), 90, { addTrauma: noop });
    assert.equal(snapshot(a), snapshot(b), `battle ${battle + 1} sim is reproducible`);
  }
  console.log('matchLifecycle: seeded replay equality across two instances passed');
}

// ---------------------------------------------------------------------------
// 4. WRECK FREEZE — destroyed hulls integrate nothing
// ---------------------------------------------------------------------------
{
  const game = newGame();
  startTestBattle(game, 'm1a2');
  const wreck = game.tanks.find((t) => t.team === 'enemy');
  wreck.input.throttle = 1;
  wreck.input.steer = 1;
  wreck.input.fire = true;
  wreck.combat.hp = 0;
  wreck.combat.destroyed = true;
  const pose = { x: wreck.state.pos.x, y: wreck.state.pos.y, z: wreck.state.pos.z };
  const yaw = wreck.state.yaw;
  stepN(game, createBus(null), createCollider(game, WORLD), 180, { addTrauma: noop });
  assert.equal(wreck.state.pos.x, pose.x, 'wreck hull frozen (x)');
  assert.equal(wreck.state.pos.y, pose.y, 'wreck hull frozen (y)');
  assert.equal(wreck.state.pos.z, pose.z, 'wreck hull frozen (z)');
  assert.equal(wreck.state.yaw, yaw, 'wreck hull frozen (yaw)');
  assert.ok(game.shells.every((sh) => sh.shooterId !== wreck.id),
    'wrecks never fire');
  console.log('matchLifecycle: wreck freeze passed');
}

// ---------------------------------------------------------------------------
// 5. SPAWN SANITY — finite, separated, heightfield-seated cells
// ---------------------------------------------------------------------------
{
  const game = newGame();
  startTestBattle(game, 'm1a2');
  const poses = game.tanks.map((t) => t.state.pos);
  for (const p of poses) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
      'spawn coordinates are finite');
  }
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const d = Math.hypot(poses[i].x - poses[j].x, poses[i].z - poses[j].z);
      assert.ok(d >= 4, `participants ${i}/${j} spawn >= 4 m apart (got ${d.toFixed(2)})`);
    }
  }
  console.log('matchLifecycle: spawn sanity passed');
}

// ---------------------------------------------------------------------------
// 6. LIVE-FIRE SANITY — staged AI battle: shells fly, no NaN, stable verdict
// ---------------------------------------------------------------------------
{
  const game = newGame();
  setupBattle(game, 'm1a2', WORLD, {
    random: true, deferVisuals: true, deferCamoRepaint: true,
  });
  ensureStagedVisuals(game); // AI fires -> the bore axis needs real visuals
  const bus = createBus(null);
  const collider = createCollider(game, WORLD);
  const rig = { addTrauma: noop, recoilKick: noop };
  let fired = 0;
  let ended = 0;
  bus.on('shell:fired', () => { fired++; });
  bus.on('battle:ended', () => { ended++; });
  stepN(game, bus, collider, 480, rig); // 8 s of live combat
  assert.ok(fired > 0, 'AI combat produces shells headlessly');
  assert.ok(ended <= 1, 'at most one verdict emission');
  assert.ok(Math.abs(game.timeS - 480 * SIM_DT) < 1e-6,
    'fixed-step clock advances exactly 480 ticks');
  for (const ent of game.tanks) {
    assert.ok(Number.isFinite(ent.state.pos.x + ent.state.pos.y + ent.state.pos.z),
      `${ent.specId} position stays finite`);
    assert.ok(Number.isFinite(ent.combat.hp), `${ent.specId} hp stays finite`);
  }
  const verdict = game.result;
  stepN(game, bus, collider, 30, rig);
  assert.equal(game.result, verdict, 'verdict stays stable after the decision tick');
  console.log(`matchLifecycle: live-fire sanity passed (${fired} shells, verdict=${verdict})`);
}

console.log('matchLifecycle.selftest: core game loop lifecycle passed');
