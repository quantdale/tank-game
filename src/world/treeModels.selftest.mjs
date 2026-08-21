// src/world/treeModels.selftest.mjs — headless regression coverage for the
// SA-12 vegetation variation tables consumed by vegetation.js.
// Run: node src/world/treeModels.selftest.mjs
// vegetation.js itself needs a browser canvas, so the art tables live in the
// pure-data treeModels.js module and are validated here (see module contract).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OAK_SHAPES, PALM_VAR, BIRCH_VAR, PINE_VAR, GRASS_TUFTS,
  validateTreeModels,
} from './treeModels.js';

let passed = 0;
function ok(cond, label) {
  if (!cond) {
    console.error(`treeModels.selftest: FAIL — ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok - ${label}`);
}

// 1. Module integrity contract (frozen tables, finite positive fields).
const problems = validateTreeModels();
ok(problems.length === 0, `validateTreeModels reports no problems (${problems.length})`);
for (const p of problems) console.error(`  problem: ${p}`);

// 2. Table shapes pinned — builders index these by k % length.
ok(OAK_SHAPES.length === 3, 'OAK_SHAPES has 3 crown silhouettes');
ok(PALM_VAR.length === 3, 'PALM_VAR has 3 stature variants');
ok(BIRCH_VAR.length === 3, 'BIRCH_VAR has 3 proportion variants');
ok(PINE_VAR.length === 3, 'PINE_VAR has 3 conifer statures');
ok(GRASS_TUFTS.length === 2, 'GRASS_TUFTS has exactly 2 tuft profiles');

// 3. Legacy-default pins. PINE_VAR[0] and both grass profiles must keep the
// pre-SA-12 proportions bit-identical: vegetation.js builds variant k=0 with
// empty-vr semantics equal to these numbers, and the grass loop derives tuft
// geometry directly from the table.
const pine0 = PINE_VAR[0];
ok(pine0.h0 === 5.9 && pine0.hr === 0.6, 'PINE_VAR[0] pins legacy trunk h0/hr (5.9/0.6)');
ok(pine0.topY === 6.4 && pine0.rMul === 1, 'PINE_VAR[0] pins legacy crown topY/rMul (6.4/1)');
ok(GRASS_TUFTS[0].w === 0.92 && GRASS_TUFTS[0].h === 0.74, 'GRASS_TUFTS[0] pins lush tuft 0.92x0.74');
ok(GRASS_TUFTS[1].w === 1.14 && GRASS_TUFTS[1].h === 0.58, 'GRASS_TUFTS[1] pins turf tuft 1.14x0.58');

// 4. Cross-field sanity: the three pine statures must genuinely differ so
// stands stop reading as clones (spire taller+narrower, skirt shorter+wider).
const [legacy, spire, skirt] = PINE_VAR;
ok(spire.topY > legacy.topY && spire.rMul < legacy.rMul, 'PINE spire is taller and narrower than legacy');
ok(skirt.topY < legacy.topY && skirt.rMul > legacy.rMul, 'PINE skirt is shorter and wider than legacy');
ok(BIRCH_VAR[2].h0 > BIRCH_VAR[1].h0 && BIRCH_VAR[1].h0 > BIRCH_VAR[0].h0, 'BIRCH heights ascend young->classic->old');
ok(OAK_SHAPES[1].ry > OAK_SHAPES[0].ry && OAK_SHAPES[2].rx > OAK_SHAPES[0].rx, 'OAK columnar is taller, spreading is wider than classic');

// 5. Immutability: runtime mutation must not be possible (tables are shared
// module state read at every battle build). Strict-mode assignment to a
// frozen object throws; accept either the throw or a silently-ignored write.
const mutationRejected = (fn) => {
  try { fn(); return true; } catch { return true; }
};
ok(mutationRejected(() => { PINE_VAR[0].topY = 99; }) && PINE_VAR[0].topY === 6.4,
  'PINE_VAR entries are frozen against mutation');
ok(mutationRejected(() => { GRASS_TUFTS.push({ w: 1, h: 1 }); }) && GRASS_TUFTS.length === 2,
  'GRASS_TUFTS table is frozen against push');

// 6. Wiring guard: vegetation.js must consume this module and must not carry
// its own inline copies of the tables (which would silently drift).
const vegSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vegetation.js'), 'utf8');
ok(vegSrc.includes("from './treeModels.js'"), 'vegetation.js imports ./treeModels.js');
ok(!/\bconst\s+OAK_SHAPES\b/.test(vegSrc), 'vegetation.js no longer defines a local OAK_SHAPES');
ok(!/\bconst\s+PALM_VAR\b/.test(vegSrc), 'vegetation.js no longer defines a local PALM_VAR');
ok(!/\bconst\s+BIRCH_VAR\b/.test(vegSrc), 'vegetation.js no longer defines a local BIRCH_VAR');
ok(/PINE_VAR\[k % PINE_VAR\.length\]/.test(vegSrc), 'vegetation.js selects pine near/far variants from PINE_VAR');
ok(/GRASS_TUFTS\[gv\]/.test(vegSrc), 'vegetation.js derives grass tufts from GRASS_TUFTS');

console.log(`treeModels.selftest: variation tables, legacy pins, cross-field sanity, immutability, and vegetation.js wiring passed (${passed} assertions)`);
