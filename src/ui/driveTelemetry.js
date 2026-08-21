function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

const CADENCE_EPSILON_S = 1e-6;

/** Keep fixed-step HUD cadences from slipping a whole frame on float error. */
export function isDriveSampleDue(nowS, lastS, intervalS) {
  return lastS < 0 || nowS - lastS >= intervalS - CADENCE_EPSILON_S;
}

/**
 * Fill the reusable bottom-left mobility readout model without allocating.
 * Runtime speed is m/s; presentation values use the familiar km/h contract.
 */
export function fillDriveTelemetry(out, state, spec) {
  const speedKmhSigned = finite(state?.speed) * 3.6;
  const speedKmhExact = Math.min(999, Math.abs(speedKmhSigned));
  const speedKmh = Math.round(speedKmhExact);
  const direction = speedKmhSigned > 0.5 ? 'FWD' : speedKmhSigned < -0.5 ? 'REV' : 'HOLD';
  const forwardLimit = Math.max(0, finite(spec?.topSpeedKmh));
  const reverseLimit = Math.max(0, finite(spec?.reverseSpeedKmh, forwardLimit * 0.2));
  const limitKmh = direction === 'REV' ? reverseLimit : forwardLimit;
  // Keep the label integer-valued, but drive the analog presentation from the
  // unrounded speed. Quantizing the needle to whole km/h made a retained 10 Hz
  // readout look visibly sticky even when the simulation itself was smooth.
  const speedRatio = limitKmh > 0 ? Math.min(1, speedKmhExact / limitKmh) : 0;

  out.speedKmh = speedKmh;
  out.direction = direction;
  out.limitKmh = Math.round(limitKmh);
  out.speedRatio = speedRatio;
  out.sweepDeg = speedRatio * 270;
  out.sweepLength = speedRatio * 75;
  out.needleDeg = -135 + out.sweepDeg;
  return out;
}

/**
 * Battle-clock label gate: returns the M:SS string only when the DISPLAYED
 * second changed since the last accepted sample, else null. The HUD calls it
 * once per frame and skips the DOM write entirely on the null path — the old
 * inline fmtTimer rebuilt (and compared) the label string every frame.
 * Non-finite/negative remainders clamp to 0:00, matching the old fmtTimer.
 */
export function battleClockLabel(cell, remainingS) {
  const sec = remainingS > 0 ? Math.floor(remainingS) : 0;
  if (cell.sec === sec) return null;
  cell.sec = sec;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
