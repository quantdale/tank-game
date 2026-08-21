import assert from 'node:assert/strict';
import { battleClockLabel, fillDriveTelemetry, isDriveSampleDue } from './driveTelemetry.js';

const out = {};
fillDriveTelemetry(out, { speed: 10 }, { topSpeedKmh: 60, reverseSpeedKmh: 18 });
assert.deepEqual(out, {
  speedKmh: 36,
  direction: 'FWD',
  limitKmh: 60,
  speedRatio: 0.6,
  sweepDeg: 162,
  sweepLength: 45,
  needleDeg: 27,
});

fillDriveTelemetry(out, { speed: -5 }, { topSpeedKmh: 70, reverseSpeedKmh: 20 });
assert.equal(out.speedKmh, 18);
assert.equal(out.direction, 'REV');
assert.equal(out.limitKmh, 20);
assert.equal(out.speedRatio, 0.9);
assert.equal(out.sweepDeg, 243);
assert.equal(out.sweepLength, 67.5);
assert.equal(out.needleDeg, 108);

fillDriveTelemetry(out, { speed: 0 }, { topSpeedKmh: 50 });
assert.equal(out.direction, 'HOLD');
assert.equal(out.limitKmh, 50);
assert.equal(out.sweepDeg, 0);
assert.equal(out.sweepLength, 0);
assert.equal(out.needleDeg, -135);

fillDriveTelemetry(out, { speed: 10.1 }, { topSpeedKmh: 60 });
assert.equal(out.speedKmh, 36);
assert.ok(out.sweepDeg > 163 && out.sweepDeg < 164,
  'analog sweep should retain sub-km/h motion instead of stepping with the label');

assert.equal(isDriveSampleDue(1 / 60, 0, 1 / 30), false);
assert.equal(isDriveSampleDue(2 / 60, 0, 1 / 30), true,
  '30 Hz needle cadence should land every two 60 Hz simulation ticks');
assert.equal(isDriveSampleDue(3 / 60, 0, 1 / 20), true,
  '20 Hz arc cadence should land every three 60 Hz simulation ticks');
assert.equal(isDriveSampleDue(6 / 60, 0, 0.1), true,
  '10 Hz text cadence should not slip a frame due to floating-point error');

// Battle-clock label gate: the HUD writes the timer only when the displayed
// second flips — sub-second frames must return null (skip the DOM write).
const clock = { sec: -1 };
assert.equal(battleClockLabel(clock, 900), '15:00', 'first sample always emits the label');
assert.equal(battleClockLabel(clock, 899.98), '14:59',
  'crossing an integer boundary re-emits immediately');
assert.equal(battleClockLabel(clock, 899.97), null,
  'sub-second remainders inside the same second skip the write');
assert.equal(battleClockLabel(clock, 899.01), null);
assert.equal(battleClockLabel(clock, 898.99), '14:58');
assert.equal(battleClockLabel(clock, -5), '0:00',
  'expired clock clamps to zero like the old fmtTimer');
assert.equal(battleClockLabel(clock, NaN), null,
  'non-finite remainders clamp to the same 0:00 cell instead of rendering NaN:NaN');
assert.equal(battleClockLabel(clock, 120), '2:00',
  'a fresh battle clock (timeS reset) re-emits after the clamp');

console.log('driveTelemetry.selftest: circular speedometer sweep and directional limits passed');
