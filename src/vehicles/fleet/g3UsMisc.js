// Lazy fleet group 3 of 4 — US lines (Abrams / Patton). Loaded ONLY through
// src/vehicles/fleetFactory.js's dynamic import boundary.
//
// W2-H regression r1: the misc family used to live here but is EAGER in
// fleetFactory.js — profiles/misc.js registers the `type74` spec at module
// evaluation, which the eager japan.js spec pack consumes at ITS evaluation;
// a lazy misc broke boot with "Japanese family donor missing: type74".
// (abrams rows additionally ride the eager graph anyway via modern2.js's
// buildM1A1BareHull import.)
import { ABRAMS_PROFILES } from '../profiles/abrams.js';
import { PATTON_PROFILES } from '../profiles/patton.js';

export const GROUP_PROFILES = {
  ...ABRAMS_PROFILES,
  ...PATTON_PROFILES,
};
