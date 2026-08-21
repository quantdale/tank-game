#!/usr/bin/env node
// build-public.mjs — cross-platform PUBLIC release build (content_breadth r2 gate).
//
// Equivalent to the historical POSIX-only chain
//   VITE_PUBLIC_BUILD=1 vite build && node tools/strip-nc-assets.mjs
// but runnable from npm on every host shell: npm executes package scripts
// through cmd.exe on Windows, which cannot parse the `VAR=1` env-prefix form.
// This wrapper sets the env var in-process, spawns `vite build` through node
// (no PATH/.cmd lookup involved), then runs the strip-nc-assets postbuild guard,
// which fails closed if any registered playable still references a stripped
// NC/quarantine path.
//
// Usage:
//   npm run build              # public release artifact (same as build:public)
//   npm run build -- --force   # extra args are forwarded to `vite build`

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve a dependency's CLI entry (its "bin" target) without PATH lookups. */
function resolvePkgBin(pkgName) {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin[pkgName];
  if (!bin) throw new Error(`package ${pkgName} exposes no "bin" entry`);
  return path.join(path.dirname(pkgJsonPath), bin);
}

/** Spawn `node <script> [args...]` with inherited stdio; resolve on exit 0. */
function runNode(script, args, env) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', env });
    child.on('error', rejectP);
    child.on('exit', (code, signal) => {
      if (signal) rejectP(new Error(`terminated by ${signal}`));
      else if (code !== 0) rejectP(new Error(`exit code ${code}`));
      else resolveP();
    });
  });
}

async function main() {
  // PUBLIC build marker: import.meta.env.VITE_PUBLIC_BUILD inside src/ must be
  // truthy while vite transforms the graph, so it is set on the CHILD env
  // before the build starts. Local .env files stay ignored for this key.
  const viteEnv = { ...process.env, VITE_PUBLIC_BUILD: '1' };
  const viteArgs = ['build', ...process.argv.slice(2)];

  console.log('[build-public] step 1/2: vite build (VITE_PUBLIC_BUILD=1)');
  try {
    await runNode(resolvePkgBin('vite'), viteArgs, viteEnv);
  } catch (e) {
    console.error(`[build-public] FAIL: vite build (${e.message})`);
    process.exit(1);
  }

  console.log('[build-public] step 2/2: strip NC/quarantine assets from dist/');
  try {
    await runNode(path.join(ROOT, 'tools', 'strip-nc-assets.mjs'), [], process.env);
  } catch (e) {
    console.error(`[build-public] FAIL: strip-nc-assets (${e.message})`);
    process.exit(1);
  }
  console.log('[build-public] OK: public artifact ready in dist/.');
}

main().catch((e) => { console.error('[build-public] FAILED:', e); process.exit(1); });
