// Lazy fleet group 1 of 4 — western moderns (UK / Challenger rows / Leopard /
// Italy / Sweden). Loaded ONLY through src/vehicles/fleetFactory.js's dynamic
// import boundary; never from the boot graph. Exports the same profile-row
// objects the eager union in ../profiledProcedurals.js spreads, so the
// fleetLazy selftest can assert per-id identity between the two loading paths.
//
// Byte accounting (W2-H): this group is ~1.4 MB of original source that the
// old monolithic tankFactory chunk forced onto every first load.
import { UK_PROFILES } from '../profiles/uk.js';
import { CHALLENGER_PROFILES } from '../profiles/challenger.js';
import { LEOPARD_PROFILES } from '../profiles/leopard.js';
import { ITALY_PROFILES } from '../profiles/italy.js';
import { SWEDEN_PROFILES } from '../profiles/sweden.js';

export const GROUP_PROFILES = {
  ...UK_PROFILES,
  ...CHALLENGER_PROFILES,
  ...LEOPARD_PROFILES,
  ...ITALY_PROFILES,
  ...SWEDEN_PROFILES,
};

