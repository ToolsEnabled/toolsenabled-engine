'use strict';

// Semantic search tests. Uses an isolated temp index DB (env override) and the
// dependency-free lexical embedder, so it needs no Ollama and does not touch the real
// index. Run with `npm run test:search`.

// The temp index DB below isolates TOOLSENABLED_SEARCH_DB but NOT the audit DB;
// these tests call executeTool, whose audit writes would otherwise reach the
// production ledger on a direct `node tests/search/search.js`.
require('../lib/isolated-environment').activate('search');

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Under the checkout root, not the system temp directory: search.index's
// `root` now refuses to resolve outside the ToolsEnabled root and every
// recorded workspace root (src/lib/code-file-containment.js), and a fixture
// directly under os.tmpdir() is a SIBLING of this worktree (which itself
// lives under Temp), not inside it.
const scratchBase = path.join(__dirname, '..', '..', 'tmp-search-test');
fs.mkdirSync(scratchBase, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(scratchBase, 'te-search-'));
process.env.TOOLSENABLED_SEARCH_DB = path.join(tmpDir, 'index.sqlite');

// The declared-skip-dirs contract. An installation names its own off-limits
// folders -- archived corpora, retired trees, anything explicit-access-only --
// through TOOLSENABLED_SEARCH_SKIP_DIRS, and the walk must refuse to descend
// into them BEFORE any file inside is scanned. Set here rather than mid-test
// because src/lib/search.js folds the variable into its skip set at load.
process.env.TOOLSENABLED_SEARCH_SKIP_DIRS = 'stale-corpus-archive,retired-tree,vendor-snapshot';

const { getTool, executeTool } = require('../helpers/dispatch');
const search = require('../../src/lib/search');

const corpus = path.join(tmpDir, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
fs.writeFileSync(path.join(corpus, 'plants.md'), '# Photosynthesis\nGreen plants use chloroplasts to convert sunlight, water, and carbon dioxide into glucose. Leaves capture light energy.');
fs.writeFileSync(path.join(corpus, 'finance.md'), '# Accounting\nThe quarterly revenue and invoice totals are reconciled on the balance sheet. Track accounts payable and receivable.');
fs.writeFileSync(path.join(corpus, 'infra.md'), '# Kubernetes\nContainer orchestration schedules pods across nodes. A deployment manages replicas and rolling updates.');
fs.writeFileSync(path.join(corpus, 'credentials.json'), '{"token":"this file name is always excluded"}');
fs.writeFileSync(path.join(corpus, 'private-notes.json'), '{"note":"sk_live_NOTAREALKEYFIXTURE"}');
for (const [directory, file] of [
  ['stale-corpus-archive', 'stale-plan.md'],
  [path.join('reports', 'retired-tree'), 'stale-desktop.md'],
  [path.join('reports', 'vendor-snapshot'), 'stale-vendor.md']
]) {
  const target = path.join(corpus, directory);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, file), 'Declared-skip corpus must not be indexed.');
}

(async () => {
  // Registry contract for the three new tools.
  assert.equal(getTool('search.index').effect, 'local-write');
  assert.equal(getTool('search.query').annotations.readOnlyHint, true);
  assert.equal(getTool('search.status').provider, null);

  // Index with the lexical embedder (no Ollama needed).
  const indexed = await executeTool('search.index', { root: corpus, embedder: 'lexical' });
  assert.equal(indexed.embedder, 'lexical');
  assert.ok(indexed.filesIndexed >= 3, `expected >=3 files indexed, got ${indexed.filesIndexed}`);
  assert.ok(indexed.chunksIndexed >= 3);
  assert.equal(indexed.filesSensitiveSkipped, 2);
  assert.equal(indexed.filesScanned, 5, 'declared skip directories must be skipped before file scanning');
  assert.equal(indexed.truncated, false);

  // Query should rank the topically-matching file first.
  const plants = await executeTool('search.query', { query: 'how do plants turn sunlight into energy with leaves', k: 3, root: corpus });
  assert.ok(plants.matches.length > 0, 'expected matches');
  assert.match(plants.matches[0].path, /plants\.md$/, `top hit should be plants.md, got ${plants.matches[0].path}`);

  const infra = await executeTool('search.query', { query: 'scheduling containers and pods across nodes', k: 3, root: corpus });
  assert.match(infra.matches[0].path, /infra\.md$/, `top hit should be infra.md, got ${infra.matches[0].path}`);

  // Incremental re-index skips unchanged files.
  const reindex = await executeTool('search.index', { root: corpus, embedder: 'lexical' });
  assert.ok(reindex.filesSkipped >= 3, `expected unchanged files skipped, got ${reindex.filesSkipped}`);
  assert.equal(reindex.filesIndexed, 0);

  // Editing a file re-indexes just that file.
  fs.writeFileSync(path.join(corpus, 'plants.md'), '# Photosynthesis\nUpdated: plants also perform cellular respiration at night.');
  const partial = await executeTool('search.index', { root: corpus, embedder: 'lexical' });
  assert.equal(partial.filesIndexed, 1, 'only the edited file should re-index');

  // Deleted files and files that become sensitive must not remain searchable.
  fs.rmSync(path.join(corpus, 'finance.md'));
  fs.writeFileSync(path.join(corpus, 'infra.md'), 'Bearer abcdefghijklmnopqrstuvwxyz0123456789');
  const pruned = await executeTool('search.index', { root: corpus, embedder: 'lexical' });
  assert.ok(pruned.filesRemoved >= 2, `expected stale/sensitive files to be removed, got ${pruned.filesRemoved}`);
  const afterPrune = await executeTool('search.query', { query: 'quarterly revenue Kubernetes containers', k: 10, root: corpus });
  assert.doesNotMatch(JSON.stringify(afterPrune), /finance\.md|infra\.md|sk_live_|Bearer /);

  // Status reflects the index.
  const status = await executeTool('search.status', {});
  assert.equal(status.files, 1);
  assert.ok(status.chunks >= 1);
  assert.ok(Array.isArray(status.embedders) && status.embedders.some(e => e.embedder === 'lexical'));

  // Empty query is rejected.
  await assert.rejects(executeTool('search.query', { query: '   ' }), /non-empty/);

  console.log('Semantic search tests passed (search.index, search.query, search.status).');
})()
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => {
    try { search.close(); } catch { /* preserve the original test outcome */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    try { fs.rmSync(scratchBase, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  });
