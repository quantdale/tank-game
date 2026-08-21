import assert from 'node:assert/strict';
import { DEFAULT_BINDINGS, migrateShiftFreeLookBindings, padDriveAxes } from './input.js';

assert.equal(DEFAULT_BINDINGS.sniperToggle, null,
  'sniper mode has no default keyboard binding');
assert.equal(DEFAULT_BINDINGS.freeLook, 'ShiftLeft',
  'left Shift is the dedicated hold-to-free-look modifier');

const legacyPrimary = { sniperToggle: 'ShiftLeft', freeLook: 'AltLeft' };
const legacySecondary = {};
assert.equal(migrateShiftFreeLookBindings(legacyPrimary, legacySecondary), true);
assert.deepEqual(legacyPrimary, { sniperToggle: null, freeLook: 'ShiftLeft' },
  'legacy defaults migrate Shift away from aiming and onto free look');
assert.equal(legacySecondary.freeLook, 'AltLeft',
  'the old Alt shortcut remains available as a secondary free-look key');

const customPrimary = { sniperToggle: 'KeyV', freeLook: 'KeyX' };
assert.equal(migrateShiftFreeLookBindings(customPrimary, {}), false);
assert.deepEqual(customPrimary, { sniperToggle: 'KeyV', freeLook: 'KeyX' },
  'intentional custom bindings are preserved');

console.log('input.selftest: Shift free-look defaults and legacy migration passed');

// --- SA-02 analog gamepad drive axes: sign contract -------------------------
// Stick UP (ly < 0) => +throttle; stick RIGHT (lx > 0) => −steer, matching
// main.js's key routing (D = negative steer; movement.js steering-sign note).
const out = { throttle: 0, steer: 0 };
assert.equal(padDriveAxes(0, -1, out), true, 'full up stick claims driving');
assert.equal(out.throttle, 1, 'stick up is full forward throttle');
assert.ok(Math.abs(out.steer) === 0, 'pure vertical input has no steer component');
padDriveAxes(1, 0, out);
assert.ok(Math.abs(out.throttle) === 0, 'pure horizontal input has no throttle component');
assert.ok(out.steer < -0.9, 'stick right is negative steer (screen-right turn)');
padDriveAxes(-0.5, -0.5, out);
assert.ok(out.throttle > 0.05 && out.steer > 0.05,
  'up-left diagonal: forward throttle with positive (screen-left) steer');
assert.equal(padDriveAxes(0.2, 0.2, out), false,
  'deflection under the move threshold never claims driving from the keys');
assert.equal(padDriveAxes(0.34, 0, out), false, 'just under the 0.35 threshold');
assert.equal(padDriveAxes(0.36, 0, out), true, 'just over the 0.35 threshold owns driving');
assert.deepEqual([out.throttle, out.steer].map(Math.abs).every((v) => v <= 1), true,
  'curved axes stay within -1..1');
