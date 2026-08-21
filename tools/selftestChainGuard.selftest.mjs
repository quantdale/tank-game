// tools/selftestChainGuard.selftest.mjs — SA-14 release-gate invariant.
//
// The npm pretest/test/posttest chains were hand-maintained `&&` strings:
// any new *.selftest.mjs someone forgot to wire silently never ran in CI.
// Eight such strays existed entering Campaign 3 (all green individually,
// none executed by `npm test`). This guard closes that hole permanently:
// every *.selftest.mjs TRACKED in git must appear in at least one of the
// three chains, or be listed in EXEMPT with a reason. A stray file now
// fails the gate instead of silently not testing anything.
//
// Node-runnable, no DOM, no network. Exits non-zero with an actionable
// message listing exactly what to wire where.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const norm = (p) => p.split('\\').join('/');

// Files deliberately not in any chain, with the reason. Keep this list
// SHORT and honest — every entry is a test that `npm test` will not run.
// Empty as of Campaign 3 Wave 1: everything tracked is wired.
const EXEMPT = new Map([
  // 'some/file.selftest.mjs': 'reason it cannot run in the shared chain',
]);

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const chainFiles = [];
for (const key of ['pretest', 'test', 'posttest']) {
  const script = pkg.scripts[key] || '';
  for (const step of script.split('&&')) {
    const m = step.trim().match(/^node (\S+\.selftest\.mjs)$/);
    if (m) chainFiles.push(norm(m[1]));
  }
}
if (chainFiles.length === 0) {
  throw new Error('package.json chains contain no `node <*.selftest.mjs>` steps — chain parsing broke');
}

const wired = new Set(chainFiles);
const dupes = chainFiles.filter((f, i) => chainFiles.indexOf(f) !== i);

let trackedRaw = '';
try {
  trackedRaw = execSync('git ls-files "*.selftest.mjs"', { encoding: 'utf8' });
} catch (err) {
  throw new Error(`git ls-files failed (run this selftest from the repo root): ${err.message}`);
}
const tracked = trackedRaw.split('\n').filter(Boolean).map(norm);

const missing = tracked.filter((f) => !wired.has(f) && !EXEMPT.has(f));
// Wired-but-untracked is NORMAL mid-campaign (the LEAD commits worker output
// after integration) — informational only. The hard gate invariant is
// one-directional: everything TRACKED must be wired, so nothing can silently
// stop running once committed.
const phantom = [...wired].filter((f) => !tracked.includes(f));
const exemptStale = [...EXEMPT.keys()].filter((f) => tracked.includes(f) === false);

const problems = [];
if (missing.length) {
  problems.push(
    `${missing.length} tracked selftest(s) are wired into NO npm test chain and therefore never run:\n` +
    missing.map((f) => `  - ${f}`).join('\n') +
    `\n  Fix: add \`node ${missing[0]}\` to package.json "test" (owner: QA/E2E worker), or justify an EXEMPT entry in tools/selftestChainGuard.selftest.mjs.`,
  );
}
if (phantom.length) {
  console.log(`[selftestChainGuard] note: ${phantom.length} chain step(s) reference selftests not yet tracked in git (uncommitted worker output — fine until commit):`);
  for (const f of phantom) console.log(`  ~ ${f}`);
}
if (exemptStale.length) {
  problems.push(
    `EXEMPT entries that no longer match any tracked file (prune them):\n` +
    exemptStale.map((f) => `  - ${f}`).join('\n'),
  );
}

if (dupes.length) {
  // Not a gate failure today (several profile tests intentionally sit in both
  // pretest and test) — surface as visibility only.
  console.log(`[selftestChainGuard] note: ${dupes.length} duplicate chain entr${dupes.length === 1 ? 'y' : 'ies'} (allowed, informational):`);
  for (const d of [...new Set(dupes)]) console.log(`  ~ ${d}`);
}

console.log(`[selftestChainGuard] tracked=${tracked.length} wiredSteps=${chainFiles.length} distinctWired=${wired.size} exempt=${EXEMPT.size}`);

if (problems.length) {
  console.error('[selftestChainGuard] FAIL');
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('selftestChainGuard selftest: PASS');
