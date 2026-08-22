import { Vector3 } from "three";
import { getSpec } from "../vehicles/specs.js";
import { createTankState, updateTank, SIM_DT } from "../sim/movement.js";
import { botFriendlyFireRisk, createAI, mulberry32 } from "./ai.js";

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}`);
  }
}

const hf = {
  getHeightAt: () => 0,
  getNormalAt: () => ({ x: 0, y: 1, z: 0 }),
  getGroundType: () => "firm",
};

function entity(id, specId, team, x, z, yaw = 0) {
  const spec = getSpec(specId);
  const state = createTankState(spec, new Vector3(x, 0, z), yaw);
  return {
    id,
    specId,
    spec,
    team,
    state,
    combat: {
      hp: 1000,
      maxHp: 1000,
      destroyed: false,
      reload: { t: 0, totalS: spec.gun.reloadS },
      shellSlot: 0,
      modules: {},
    },
    input: {
      throttle: 0,
      steer: 0,
      brake: false,
      fire: false,
      aimPoint: new Vector3(),
      shellSlot: 0,
    },
    aiCtl: null,
  };
}

function controller(bot, enemies, allies, seed = 41) {
  const ctl = createAI(bot, {
    difficulty: "normal",
    rng: mulberry32(seed),
    deps: {
      heightField: hf,
      raycast: () => null,
      getEnemies: () => enemies,
      getAllies: () => allies,
      getObstacles: () => [],
      spotting: { isSpotted: () => true },
    },
  });
  bot.aiCtl = ctl;
  return ctl;
}

function tick(ctl, bot, seconds, onTick = null) {
  let fired = false;
  let t = 0;
  const steps = Math.ceil(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    t += SIM_DT;
    ctl.update(SIM_DT, t);
    if (bot.input.fire) fired = true;
    if (onTick) onTick(i, t);
    // Exercise the actual gun/turret lay while pinning hull translation so
    // each scenario isolates its decision contract.
    bot.input.throttle = 0;
    bot.input.steer = 0;
    bot.input.brake = false;
    updateTank(bot, hf, SIM_DT);
  }
  return fired;
}

console.log("[1] symmetric friendly-fire geometry");
{
  const shooter = entity("s", "tiger1", "player", 0, 0);
  const ally = entity("a", "m4a3e8", "player", 0, 70);
  const enemy = entity("e", "m4a3e8", "enemy", 0, 150);
  const ap = new Vector3(0, 1.5, 150);
  const apShell = shooter.spec.gun.shells[0];
  const heShell = { ...apShell, type: "HE", caliberMm: 120 };
  ok(
    botFriendlyFireRisk(shooter, ap, apShell, [ally, enemy])?.kind ===
      "corridor",
    "living teammate blocks the direct shell corridor",
  );
  ally.state.pos.x = 18;
  ok(
    botFriendlyFireRisk(shooter, ap, apShell, [ally, enemy]) === null,
    "teammate outside the corridor permits the shot",
  );
  ally.state.pos.set(7, 0, 150);
  ok(
    botFriendlyFireRisk(shooter, ap, heShell, [ally, enemy])?.kind === "blast",
    "HE blast safety protects a teammate beside the target",
  );
  ally.team = "enemy";
  ok(
    botFriendlyFireRisk(shooter, ap, apShell, [ally]) === null,
    "opponents are never mistaken for friendlies",
  );
  ally.team = "player";
  ally.combat.destroyed = true;
  ally.state.pos.set(0, 0, 70);
  ok(
    botFriendlyFireRisk(shooter, ap, apShell, [ally]) === null,
    "destroyed teammates remain physical cover but do not veto fire",
  );
}

console.log("[2] moving-friendly prediction");
{
  const shooter = entity("s", "tiger1", "enemy", 0, 0);
  const crossing = entity("crossing", "m4a3e8", "enemy", -12, 80, Math.PI / 2);
  crossing.state.speed = 16;
  const slowShell = { ...shooter.spec.gun.shells[0], velocityMps: 100 };
  const risk = botFriendlyFireRisk(shooter, new Vector3(0, 1, 160), slowShell, [
    crossing,
  ]);
  ok(
    risk?.allyId === "crossing",
    "predicts a teammate crossing before shell arrival",
  );
}

console.log("[3] trigger hold and firing-lane response");
{
  const bot = entity("bot", "tiger1", "player", 0, 0);
  const ally = entity("ally", "m4a3e8", "player", 0, 35);
  const target = entity("target", "m4a3e8", "enemy", 0, 80);
  const ctl = controller(bot, [target], [ally]);
  const firedBlocked = tick(ctl, bot, 3);
  const blocked = ctl.debugInfo();
  ok(!firedBlocked, "bot never fires through the player-team corridor");
  ok(blocked.friendlyBlockCount >= 1, "blocked trigger is recorded");
  ok(
    blocked.friendlyLaneMoves >= 1,
    "persistent block schedules a lateral firing lane",
  );
  ally.state.pos.x = 25;
  const firedClear = tick(ctl, bot, 2);
  ok(firedClear, "bot resumes fire after the friendly clears the lane");
}

console.log("[4] distributed target scoring");
{
  const bot = entity("bot", "tiger1", "player", 0, 0);
  const a = entity("a", "m4a3e8", "enemy", -40, 80);
  const b = entity("b", "m4a3e8", "enemy", 40, 80);
  const wing = entity("wing", "m4a3e8", "player", 20, 0);
  wing.aiCtl = { targetId: "b" };
  const ctl = controller(bot, [a, b], [wing]);
  tick(ctl, bot, 0.5);
  ok(
    ctl.targetId === "a",
    "covers an unfocused lane instead of dog-piling one target",
  );
}

console.log("[5] deployment contact discipline");
{
  const bot = entity("bot", "tiger1", "player", 0, 0);
  const distant = entity("distant", "m4a3e8", "enemy", 0, 170);
  const ctl = controller(bot, [distant], []);
  ok(
    !tick(ctl, bot, 10),
    "does not turn a normal deployment sightline into an opening spawn shot",
  );
  distant.state.pos.z = 70;
  ok(tick(ctl, bot, 4), "responds to a danger-close contact during deployment");
}

console.log("[6] role-aware survival is team invariant");
function survival(team, enemyTeam) {
  const bot = entity(`bot-${team}`, "m4a3e8", team, 0, 0);
  bot.combat.hp = 400;
  const support = entity(`support-${team}`, "tiger1", team, 0, -80);
  const target = entity(`target-${enemyTeam}`, "tiger1", enemyTeam, 0, 80);
  const ctl = controller(bot, [target], [support], 19);
  tick(ctl, bot, 1);
  return ctl.debugInfo();
}
{
  const allied = survival("player", "enemy");
  const hostile = survival("enemy", "player");
  ok(
    allied.fallingBack && hostile.fallingBack,
    "low-health allied and enemy flankers both disengage toward support",
  );
  ok(
    allied.role === hostile.role && allied.hpFrac === hostile.hpFrac,
    "both teams use the same role and survival thresholds",
  );
}

console.log("[7] fire corridor follows the live bore (W06b)");
{
  const { createAuthoritativeMatch } = await import(
    "../sim/authoritativeMatch.js"
  );

  // Unit view of the divergence: the aimPoint corridor is clear while the
  // live-bore corridor sweeps an ally. tryFire used to check only the former.
  const shooter = entity("s1", "m1a2", "alpha", 0, -50);
  const ally = entity("a1", "m1a2", "alpha", 26, -14);
  const shellSpec = getSpec("m1a2").gun.shells[0];
  ok(
    botFriendlyFireRisk(shooter, new Vector3(0, 0, 50), shellSpec, [ally]) ===
      null,
    "aimPoint corridor alone is clear (divergence setup)",
  );
  const boreYaw = Math.atan2(26, 36);
  const boreAim = new Vector3(
    shooter.state.pos.x + Math.sin(boreYaw) * 100,
    0,
    shooter.state.pos.z + Math.cos(boreYaw) * 100,
  );
  ok(
    botFriendlyFireRisk(shooter, boreAim, shellSpec, [ally])?.kind ===
      "corridor",
    "live-bore corridor catches the ally",
  );

  // Wiring: authoritative tryFire must run that rule on the LAUNCH ray. A bot
  // with its aim settled on a clear target but its bore still traversing must
  // not release a shell down the ally's throat.
  const match = createAuthoritativeMatch({
    mapId: "verdant",
    seed: 7,
    countdownS: 0,
    players: [
      {
        id: "s1",
        specId: "m1a2",
        team: "alpha",
        bot: true,
        spawn: { x: 0, z: -50, yaw: 0 },
      },
      {
        id: "a1",
        specId: "m1a2",
        team: "alpha",
        bot: true,
        spawn: { x: 26, z: -14, yaw: 0 },
      },
      {
        id: "e1",
        specId: "m1a2",
        team: "bravo",
        bot: true,
        spawn: { x: 0, z: 50, yaw: Math.PI },
      },
    ],
  });
  match.onMatchReady();
  const gunner = match.entityById.get("s1");
  gunner.aiCtl.update = () => {
    // Pin the traverse mid-flight: lay request points at the enemy straight
    // ahead while the bore still crosses the ally's corridor.
    gunner.state.turretYaw = boreYaw;
    gunner.input.fire = true;
    gunner.input.aimPoint.set(0, 0, 50);
  };
  let firedShells = 0;
  for (let i = 0; i < 5; i++) {
    match.step({ dt: SIM_DT, inputs: new Map() });
    const snap = match.snapshot({
      tick: i,
      serverTimeMs: i * 16,
      viewerId: "s1",
      ackInputSeq: 0,
    });
    firedShells += snap.shells.length;
  }
  ok(
    firedShells === 0,
    "tryFire blocks when the LIVE bore corridor sweeps an ally",
  );
}

if (failures) {
  console.error(`ai.selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log("ai.selftest: all shared-combat checks passed");
