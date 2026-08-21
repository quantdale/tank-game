#!/usr/bin/env node
// tools/release-gate.mjs — SA-14 release gate runner for the selftest suite.
//
// WHY: `npm test` is three hand-maintained `&&` strings. They run serially,
// stop at the first failure with no per-file timings, and historically
// accumulated unwired strays (8 tracked selftests never ran entering
// Campaign 3; see tools/selftestChainGuard.selftest.mjs, which now makes
// that impossible). This runner executes every tracked *.selftest.mjs from
// DISCOVERY (not a copied list), reports per-file pass/fail + wall time,
// tags each file with a game-domain bucket, writes a JSON evidence report,
// and exits non-zero if anything failed — the one-command release gate.
//
// Default execution is SEQUENTIAL to exactly match today's chain semantics
// (several server/net selftests bind ports; parallel runs would race them).
// Opt into parallelism with --concurrency=N at your own risk.
//
// Usage:
//   node tools/release-gate.mjs                     # full gate (all tracked selftests)
//   node tools/release-gate.mjs --filter=sim/       # subset by substring
//   node tools/release-gate.mjs --chain=test        # mirror one npm chain's order
//   node tools/release-gate.mjs --concurrency=8     # parallel (port-binding risk)
//   node tools/release-gate.mjs --with-journey      # append the headed player-journey E2E
//   node tools/release-gate.mjs --report=out.json   # JSON evidence path
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const arg = (name, fallback) => {
  // accept both `--name=value` and `--name value`
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const filter = arg('filter', null);
const chainMirror = arg('chain', null);
const concurrency = Math.max(1, Number(arg('concurrency', '1')));
const withJourney = hasFlag('with-journey');
const reportPath = arg('report', '.qa-dev/release-gate-report.json');

const norm = (p) => p.split('\\').join('/');
const t0 = Date.now();

// --- discovery ------------------------------------------------------------
// Gate scope = union of (a) every git-tracked *.selftest.mjs and (b) every
// *.selftest.mjs referenced by the npm pretest/test/posttest chains. Tracked
// alone would let UNTRACKED worker output (normal mid-campaign, before the
// LEAD commits) silently escape the gate; wired-alone would miss strays.
let trackedRaw = '';
try {
  trackedRaw = execSync('git ls-files "*.selftest.mjs"', { encoding: 'utf8' });
} catch (err) {
  console.error(`[release-gate] git ls-files failed (run from repo root): ${err.message}`);
  process.exit(2);
}
const pkgAll = JSON.parse(readFileSync('./package.json', 'utf8'));
const wiredAll = [];
for (const key of ['pretest', 'test', 'posttest']) {
  for (const step of (pkgAll.scripts[key] || '').split('&&')) {
    const m = step.trim().match(/^node (\S+\.selftest\.mjs)$/);
    if (m) wiredAll.push(norm(m[1]));
  }
}
const discovered = [...new Set([
  ...trackedRaw.split('\n').filter(Boolean).map(norm),
  ...wiredAll,
])].sort();

let files = discovered.filter((f) => existsOnDisk(f));
for (const f of discovered) {
  if (!existsOnDisk(f)) console.error(`[release-gate] WARNING wired/tracked but missing on disk, skipping: ${f}`);
}
if (chainMirror) {
  const steps = (pkgAll.scripts[chainMirror] || '').split('&&')
    .map((s) => s.trim().match(/^node (\S+\.selftest\.mjs)$/)?.[1])
    .filter(Boolean).map(norm);
  const known = new Set(files);
  files = steps.filter((f) => known.has(f));
}
if (filter) files = files.filter((f) => f.includes(filter));
if (files.length === 0) {
  console.error('[release-gate] no selftests matched — refusing to pass an empty gate');
  process.exit(2);
}

function existsOnDisk(p) {
  return existsSync(p);
}

// --- domain tagging (coverage reporting) ----------------------------------
const DOMAIN_RULES = [
  ['boot/loaders', /(^|\/)(loadingScreens|publicNav|publicCopy)/],
  ['garage/UI', /(^|\/)ui\//],
  ['battle-entry/lifecycle', /matchLifecycle|preBattleCountdown|matchmaking|authoritativeMatch|killcamGhostPolicy|presentationPose/],
  ['gameplay-sim', /(^|\/)(sim|game)\//],
  ['vehicles/fleet', /vehicles\/|gallery\//],
  ['maps/world/cells', /(^|\/)world\//],
  ['net/server', /^net\/|^server\//],
  ['engine/render', /engine\/|dev\/|fx\/|experiments\//],
  ['audio', /(^|\/)audio\//],
  ['presentation', /(^|\/)presentation\//],
  ['build/tools', /^tools\//],
];
const domainOf = (f) => (DOMAIN_RULES.find(([, re]) => re.test(f)) || ['other'])[0];

// --- executor --------------------------------------------------------------
const OUT_TAIL_BYTES = 4000;
function tail(buf) {
  const s = buf.join('');
  return s.length > OUT_TAIL_BYTES ? `…${s.slice(-OUT_TAIL_BYTES)}` : s;
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], { cwd: process.cwd() });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d.toString()));
    child.stderr.on('data', (d) => err.push(d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ file, ok: false, ms: Date.now() - started, timedOut: true, outTail: tail(out), errTail: tail([...err, '\n[release-gate] killed after timeout']) });
    }, TEST_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, ms: Date.now() - started, timedOut: false, code, outTail: tail(out), errTail: tail(err) });
    });
  });
}

const TEST_TIMEOUT_MS = Math.max(10_000, Number(arg('timeout-ms', '300000')));

console.log(`[release-gate] ${files.length} selftest(s), concurrency=${concurrency}, filter=${filter || '-'}${chainMirror ? `, chain=${chainMirror}` : ''}${withJourney ? ', +journey' : ''}`);
const queue = [...files];
const results = [];
let done = 0;
const liveLine = () => `\r[release-gate] ${done}/${files.length} done`;

async function worker() {
  while (queue.length) {
    const file = queue.shift();
    const r = await runOne(file);
    r.domain = domainOf(r.file);
    results.push(r);
    done++;
    const label = `${r.ok ? 'ok  ' : 'FAIL'} ${r.file} (${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ', TIMEOUT' : ''})`;
    if (!r.ok) console.log(`\n[release-gate] ${label}`);
    else if (process.stdout.isTTY) process.stdout.write(`${liveLine()} ${label.slice(4)}          `);
    else console.log(`[release-gate] ${label}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
if (process.stdout.isTTY) process.stdout.write('\n');

// --- optional E2E journey leg ---------------------------------------------
if (withJourney) {
  console.log('[release-gate] running player-journey E2E (headed Chrome)…');
  const j = await runOne('tools/player-journey-probe.mjs');
  j.domain = 'e2e/journey';
  j.file = 'tools/player-journey-probe.mjs';
  results.push(j);
  if (!j.ok) console.log(`[release-gate] FAIL ${j.file} (${(j.ms / 1000).toFixed(1)}s)`);
}

// --- report ----------------------------------------------------------------
const failures = results.filter((r) => !r.ok);
const byDomain = {};
for (const r of results) {
  (byDomain[r.domain] ??= { total: 0, failed: 0, ms: 0 });
  byDomain[r.domain].total++;
  byDomain[r.domain].failed += r.ok ? 0 : 1;
  byDomain[r.domain].ms += r.ms;
}
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  totalFiles: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  wallMs: Date.now() - t0,
  concurrency,
  filter,
  byDomain,
  failures: failures.map((r) => ({ file: r.file, code: r.code, timedOut: r.timedOut, ms: r.ms, stderrTail: r.errTail, stdoutTail: r.outTail })),
  results: results.map((r) => ({ file: r.file, ok: r.ok, ms: r.ms, domain: r.domain, timedOut: r.timedOut })),
};
try {
  mkdirSync('.qa-dev', { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 1));
} catch (err) {
  console.error(`[release-gate] could not write report: ${err.message}`);
}

console.log('\n================ RELEASE GATE SUMMARY ================');
for (const d of Object.keys(byDomain).sort()) {
  const s = byDomain[d];
  const mark = s.failed ? 'FAIL' : 'ok';
  console.log(`  ${mark.padEnd(4)} ${d.padEnd(24)} ${s.total - s.failed}/${s.total} passed  ${(s.ms / 1000).toFixed(1)}s`);
}
console.log(`  ${failures.length ? 'FAIL' : 'ok  '} ${'TOTAL'.padEnd(24)} ${results.length - failures.length}/${results.length} passed  ${((Date.now() - t0) / 1000).toFixed(1)}s wall`);
console.log(`  report: ${reportPath} | cpus=${os.cpus().length}`);

if (failures.length) {
  console.error(`\n[release-gate] ${failures.length} FAILURE(S):`);
  for (const f of failures) {
    console.error(`\n--- FAIL ${f.file}${f.timedOut ? ' (TIMEOUT)' : ` (exit ${f.code})`} ---`);
    if (f.errTail.trim()) console.error(f.errTail);
    if (f.outTail.trim()) console.error(f.outTail);
  }
  process.exit(1);
}
console.log('[release-gate] GATE GREEN');
