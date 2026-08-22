// Lazy fleet group 2 of 4 — eastern moderns and recovered slavic variants
// (T-90/T-72/T-80 lines, russia residue, soviet heavies, ukraine, poland).
// Loaded ONLY through src/vehicles/fleetFactory.js's dynamic import boundary.
//
// The RUSSIA_PROFILES composite below is the historical key-order shim from
// ../profiledProcedurals.js (pure-refactor law) with ONE deliberate deviation:
// `type59` is dropped here. In the eager union it was assigned twice — once
// from CHINA_PROFILES.type59 at the Russia position, then re-assigned by the
// later `...CHINA_PROFILES` spread to the SAME object — so letting group 4's
// china pack register it yields the identical builder without a cross-group
// import.
import { T90_PROFILES } from '../profiles/t90.js';
import { RUSSIA_PROFILES as RUSSIA_RESIDUE_PROFILES } from '../profiles/russia.js';
import { T72_PROFILES } from '../profiles/t72.js';
import { T80_PROFILES } from '../profiles/t80.js';
import { SOVIET_HEAVY_PROFILES } from '../profiles/soviet-heavy.js';
import { UKRAINE_PROFILES } from '../profiles/ukraine.js';
import { POLAND_PROFILES } from '../profiles/poland.js';

const RUSSIA_PROFILES = {
  t90a: T90_PROFILES.t90a,
  t90: T90_PROFILES.t90,
  t90ms: T90_PROFILES.t90ms,
  t90a_burlak: T90_PROFILES.t90a_burlak,
  t62mv1: RUSSIA_RESIDUE_PROFILES.t62mv1,
  t64bv1: RUSSIA_RESIDUE_PROFILES.t64bv1,
  pt91m: T90_PROFILES.pt91m,
  t72b_1987: T72_PROFILES.t72b_1987,
  t72b3m: T72_PROFILES.t72b3m,
  t72bu: T72_PROFILES.t72bu,
  t90sm: T90_PROFILES.t90sm,
  t90a_vladimir: T90_PROFILES.t90a_vladimir,
  t80: T80_PROFILES.t80,
  t80b: T80_PROFILES.t80b,
  t80bv: T80_PROFILES.t80bv,
  t90m: T90_PROFILES.t90m,
  t54: RUSSIA_RESIDUE_PROFILES.t54,
  t44: RUSSIA_RESIDUE_PROFILES.t44,
  // type59: see header — registered by group 4 (china), same profile row.
  t84: T80_PROFILES.t84,
};

export const GROUP_PROFILES = {
  ...SOVIET_HEAVY_PROFILES,
  ...RUSSIA_PROFILES,
  ...UKRAINE_PROFILES,
  ...POLAND_PROFILES,
};
