// Lazy fleet group 4 of 4 — casemates, Merkava line, WW2 metal, AFV family
// line, and the Asian/nation residue packs (china/japan/korea/germany). Owns
// `type59` (see group 2's header) and NOT `strv103` (see below). Loaded ONLY
// through src/vehicles/fleetFactory.js's dynamic import boundary.
import { WW2_PROFILES } from '../profiles/ww2.js';
import { CASEMATE_PROFILES } from '../profiles/casemate.js';
import { MERKAVA_PROFILES } from '../profiles/merkava.js';
import { AFV_FAMILY_PROFILES } from '../profiles/afvFamily.js';
import { CHINA_PROFILES } from '../profiles/china.js';
import { KOREA_PROFILES } from '../profiles/korea.js';
import { JAPAN_PROFILES } from '../profiles/japan.js';
import { GERMANY_PROFILES } from '../profiles/germany.js';

// strv103 is authored in BOTH casemate (buildStrv103 donor machinery) and
// sweden; the eager union's last-write-wins spread makes SWEDEN's row the
// effective one. Sweden lives in group 1, so the casemate claimant is
// excluded here to keep exactly-one-owner semantics regardless of which
// dynamic chunk resolves first (fleetLazy selftest pins this).
const { strv103: _casemateStrv103ShadowedRow, ...CASEMATE_ACTIVE_PROFILES } = CASEMATE_PROFILES;

export const GROUP_PROFILES = {
  ...CASEMATE_ACTIVE_PROFILES,
  ...WW2_PROFILES,
  ...MERKAVA_PROFILES,
  ...AFV_FAMILY_PROFILES,
  ...CHINA_PROFILES,
  ...KOREA_PROFILES,
  ...JAPAN_PROFILES,
  ...GERMANY_PROFILES,
};
