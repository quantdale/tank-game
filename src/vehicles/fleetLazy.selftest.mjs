// fleetLazy.selftest.mjs — W2-H lazy-fleet loading contract.
//
// The browser boots through src/vehicles/fleetFactory.js, which registers the
// profiled builder families via dynamic chunks instead of the eager static
// imports tankFactory.js uses. This test pins BOTH invariants of that split:
//
//  1. IDENTITY — every profile row reachable through the eager union
//     (profiledProcedurals.PROCEDURAL_PROFILES) is exposed by exactly one
//     lazy group with the SAME object identity (no drift, no lost family,
//     no duplicate registration across groups).
//  2. COMPLETENESS — after ensureFullFleet(), every visible playable id can
//     build a procedural visual through the LAZY facade (same sweep shape as
//     rosterSweep, but exercising the dynamic-import path).
//
// Runs on plain node (dynamic import works identically). Deterministic: no
// DOM/WebGL — visuals build with proceduralOnly + a null engine context.
import { PROCEDURAL_PROFILES } from './profiledProcedurals.js';
import { VISIBLE_TANK_IDS } from './specs.js';
import { createTank, ensureFullFleet } from './fleetFactory.js';
import { GROUP_PROFILES as g1 } from './fleet/g1Nato.js';
import { GROUP_PROFILES as g2 } from './fleet/g2East.js';
import { GROUP_PROFILES as g3 } from './fleet/g3UsMisc.js';
import { GROUP_PROFILES as g4 } from './fleet/g4CasemateAsia.js';

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

// --- 0. eval-order regression guard (W2-H r1) -------------------------------
//
// "Japanese family donor missing: type74" class: a family module whose
// MODULE EVALUATION mutates the spec registry (profiles/misc.js -> type74)
// silently becomes boot-order load-bearing for the eager spec packs. This
// file statically imports fleetFactory.js, so any registry gap throws right
// here — but cross-family EVAL dependencies *between* two lazy groups would
// not (this process imports all groups in fixed order). Probe each group in
// an isolated child process so any hidden eval-time coupling surfaces.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const group of ['g1Nato', 'g2East', 'g3UsMisc', 'g4CasemateAsia']) {
  const url = pathToFileURL(join(here, 'fleet', `${group}.js`)).href;
  try {
    execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `await import(${JSON.stringify(url)}); console.log("ok");`,
    ], { encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    fail(`isolated import of fleet/${group}.js threw (hidden eval-order dependency): ${(e.stderr || e.message).slice(0, 400)}`);
  }
}

// --- 1. group identity vs eager union ---------------------------------------

import { MISC_PROFILES } from './profiles/misc.js';

const seen = new Map(); // profile row object -> owner label
for (const [label, rows] of [['g1-nato', g1], ['g2-east', g2], ['g3-us-patton', g3],
  ['g4-casemate-asia', g4], ['eager-misc', MISC_PROFILES]]) {
  for (const [id, row] of Object.entries(rows)) {
    if (!row || typeof row !== 'object') fail(`${label}:${id} is not an object`);
    const prior = seen.get(row);
    if (prior) fail(`${label}:${id} duplicates a row already owned by ${prior}`);
    seen.set(row, `${label}:${id}`);
    if (PROCEDURAL_PROFILES[id] !== row) {
      fail(`${label}:${id} does not identity-match the eager union row`);
    }
  }
}
for (const id of Object.keys(PROCEDURAL_PROFILES)) {
  if (!seen.has(PROCEDURAL_PROFILES[id])) {
    fail(`eager-union id ${id} is not owned by any lazy group`);
  }
}

// --- 2. full-fleet completeness sweep ----------------------------------------

await ensureFullFleet();
const ids = [...VISIBLE_TANK_IDS];
let built = 0;
for (const id of ids) {
  let visual = null;
  try {
    // Same receipt-mode contract as rosterSweep.selftest.mjs: full procedural
    // construction on a null engine context, no DOM/WebGL texture work.
    visual = createTank(id, null, { proceduralOnly: true, geometryReceipt: true });
    if (!visual || !visual.root) throw new Error('no visual/root');
    built++;
  } catch (e) {
    fail(`lazy createTank(${id}) threw: ${e.message}`);
  } finally {
    if (visual) { try { visual.dispose(); } catch (_) { /* pooled */ } }
  }
}
console.log(`fleetLazy: ${built}/${ids.length} visible playables built through the lazy facade`);
if (built !== ids.length) fail('not every playable built');

if (failures) {
  console.error(`fleetLazy.selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`fleetLazy.selftest: PASS (${ids.length} playables, ${
  Object.keys(PROCEDURAL_PROFILES).length} profile rows identity-checked)`);
