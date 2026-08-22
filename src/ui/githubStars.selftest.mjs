import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

// Contract (campaign W2-D / blocker B5): one GitHub request per page load,
// success or failure. Boot screen and garage both mount star nodes; before the
// fix a failed boot-time request re-fired from the garage mount, producing the
// paired 403s seen in every capture once api.github.com rate-limited the host.

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'githubStars.js');

async function freshModule(tag) {
  // The module keeps request state in module scope, so each case gets its own
  // copy at a distinct path (fresh instance) without touching the real DOM or
  // network. githubStars.js is dependency-free, so the copy stands alone.
  const dir = await mkdtemp(join(tmpdir(), `cot-stars-${tag}-`));
  const file = join(dir, 'githubStars.js');
  await writeFile(file, await import('node:fs/promises').then((m) => m.readFile(SOURCE, 'utf8')));
  return import(pathToFileURL(file).href);
}

function fakeRoot() {
  const control = {
    dataset: {},
    ariaLabel: 'Claude of Tanks on GitHub',
    getAttribute: () => 'Claude of Tanks on GitHub',
    setAttribute(_k, v) { this.ariaLabel = v; },
  };
  const root = {
    textContent: 'Stars',
    // Mirrors the registered element: starNodes holds the [data-github-stars]
    // node itself, and render walks from that node up to the repository link.
    closest: () => control,
    matches: (sel) => sel === '[data-github-stars]',
    querySelectorAll: () => [],
  };
  return { root, control };
}

{
  // Failure (rate-limit 403): later mounts must reuse the settled attempt
  // instead of issuing a second doomed request.
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return { ok: false, status: 403 }; };
  const { mountGitHubStars } = await freshModule('fail');
  const first = await mountGitHubStars(fakeRoot().root);
  const second = await mountGitHubStars(fakeRoot());
  assert.equal(first, null, 'failed lookup resolves to null');
  assert.equal(second, null, 'retry-free failure result');
  assert.equal(fetchCalls, 1, `exactly one fetch after failed attempt (got ${fetchCalls})`);
}

{
  // Success: count renders into registered nodes and repeated mounts stay on
  // the single shared request.
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => ({ stargazers_count: 1234 }) };
  };
  const { mountGitHubStars, formatGitHubStarCount } = await freshModule('ok');
  const { root, control } = fakeRoot();
  const first = await mountGitHubStars(root);
  const second = await mountGitHubStars(root);
  assert.equal(first, 1234);
  assert.equal(second, 1234, 'repeat mount reuses shared request');
  assert.equal(fetchCalls, 1, `exactly one fetch on success (got ${fetchCalls})`);
  assert.equal(root.textContent, formatGitHubStarCount(1234), 'star count rendered');
  assert.match(control.ariaLabel, /1,234 stars$/, 'accessible label carries the full count');
}

console.log('github stars single-request selftest passed');
