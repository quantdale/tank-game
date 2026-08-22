// Browser fleet factory facade (W2-H lazy-fleet split).
//
// Mirrors tankFactory.js exactly — same spec-pack evaluation order, same
// roster sealing, same canonical builder packs and fittings — except the
// PROFILED builder families load LAZILY: the eager graph keeps only the core,
// canonical packs, fittings, and the spec registrations, while the four heavy
// profile-family groups (~1.9 MB minified combined) arrive through dynamic
// import chunks. Node consumers (selftests, tools) keep importing
// tankFactory.js, which stays fully eager; the two facades must never be
// co-loaded in one process (each seals the core once).
//
// Loading contract:
//  - ensureFullFleet() resolves once every family group is registered. It
//    self-starts at module evaluation in a browser so the chunks download in
//    parallel with the rest of boot instead of blocking it the way the old
//    monolithic static import did.
//  - Every runtime createTank call site whose spec id may resolve to a
//    lazily-registered family awaits ensureFullFleet() first (garage dressing,
//    pedestal switches, battle entry, network bridge rosters, studio/gallery).
//    A call that skips the gate still fails LOUDLY (unknown-builder error),
//    never silently mis-builds.

import { configureTankFactory, registerProfiledBuilders } from './tankFactoryCore.js';
import { MODERN3_BUILDERS } from './modern3.js';
import { FRANCE_BUILDERS } from './france.js';
import { MODERN2_BUILDERS } from './modern2.js';
import { MODERN1_BUILDERS } from './modern1.js';
import { CHALLENGER_BUILDERS } from './profiles/challenger.js';
// MISC_PROFILES must stay EAGER (W2-H regression r1): profiles/misc.js
// registers the `type74` SPEC at module evaluation, and the eager japan.js
// spec pack derives stb1/type90a/type10b from it during its own evaluation.
// The old eager facade got this ordering via profiledProcedurals.js; dropping
// it broke boot with "Japanese family donor missing: type74". Its builders
// are therefore registered below alongside the core, not via a lazy group.
import { MISC_PROFILES } from './profiles/misc.js';
import { FITTINGS } from './profiles/kit.js';

// These modules register specs at evaluation time. Keep donor waves ahead of
// their derivatives so every clone observes a complete source record.
import './variants.js';
import './userdrops.js';
import './userdrops2.js';
import './userdrops3.js';
import './userdrops4.js';
import './userdrops5.js';
import './userdrops6.js';
import './ukraine.js';
import './china.js';
import './sweden.js';
import './poland.js';
import './korea.js';
import './japan.js';
import './germany.js';
import './afvFamily.js';

import {
  ALL_TANK_IDS,
  DEVELOPMENT_TANK_IDS,
  PRODUCTION_TANK_IDS,
  RUNTIME_TANK_IDS,
  SAVED_TANK_IDS,
  VISIBLE_TANK_IDS,
  finalizeFirstPartyRoster,
} from './specs.js';
import { applyNativeFamilyOrder } from './fleetOrder.js';

finalizeFirstPartyRoster();
for (const ids of [
  ALL_TANK_IDS,
  DEVELOPMENT_TANK_IDS,
  SAVED_TANK_IDS,
  PRODUCTION_TANK_IDS,
  VISIBLE_TANK_IDS,
  RUNTIME_TANK_IDS,
]) applyNativeFamilyOrder(ids);
configureTankFactory({
  canonicalBuilderPacks: [
    ['modern1', MODERN1_BUILDERS],
    ['challenger', CHALLENGER_BUILDERS],
    ['modern2', MODERN2_BUILDERS],
    ['modern3', MODERN3_BUILDERS],
    ['france', FRANCE_BUILDERS],
  ],
  fittings: FITTINGS,
});

export { KIT, createTank } from './tankFactoryCore.js';
export { registerProfiledBuilders };

// --- eager misc-family builders + lazy family groups ------------------------

import { buildDonorVariant, buildProfile } from './profiles/kit.js';

// Same per-row builder mapping as profiledProcedurals.js's PROFILED_BUILDERS.
function toBuilders(profiles) {
  return Object.fromEntries(Object.entries(profiles)
    .map(([id, profile]) => [id, (P) => profile.build
      ? profile.build(P, profile)
      : profile.base
      ? buildDonorVariant(P, profile)
      : buildProfile(P, profile)]));
}

// Misc family rides the eager graph (see import note above) — its spec
// registration side effect is boot-order load-bearing for japan.js.
registerProfiledBuilders(toBuilders(MISC_PROFILES));

const FLEET_GROUPS = [
  // [chunkNameHint, loader] — group composition + byte accounting lives in
  // src/vehicles/fleet/*.js headers.
  ['fleet-nato', () => import('./fleet/g1Nato.js')],
  ['fleet-east', () => import('./fleet/g2East.js')],
  ['fleet-us-misc', () => import('./fleet/g3UsMisc.js')],
  ['fleet-casemate-asia', () => import('./fleet/g4CasemateAsia.js')],
];

let fullFleetPromise = null;

/**
 * Resolve when every lazy family group is registered and all playable specs
 * can build. Idempotent; safe to await from any number of call sites.
 * @returns {Promise<void>}
 */
export function ensureFullFleet() {
  if (!fullFleetPromise) {
    fullFleetPromise = Promise.all(FLEET_GROUPS.map(([, load]) => load()))
      .then((mods) => {
        for (const mod of mods) registerProfiledBuilders(toBuilders(mod.GROUP_PROFILES));
      })
      .then(() => undefined);
  }
  return fullFleetPromise;
}

// Browser sessions start pulling the fleet chunks immediately so the bytes
// overlap the rest of boot (three.js init, garage stage, DOM) rather than
// serializing ahead of them. Node imports stay inert.
if (typeof window !== 'undefined') ensureFullFleet();
