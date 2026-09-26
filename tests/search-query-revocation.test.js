'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./lib/isolated-environment').activate('search-query-revocation');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'search-query-revocation-'));
process.env.TOOLSENABLED_SEARCH_DB = path.join(scratch, 'index.sqlite');
const registry = require('../src/lib/tool-registry');
const audit = require('../src/lib/audit');
const originalRoots = registry.confinedWorkspaceRoots;
const originalRecord = audit.record;
// Exercise real search/SQLite and filesystem containment; audit persistence is
// outside this fixture and must not require a Windows signing key on Linux.
audit.record = () => {};
let grants = [];
registry.confinedWorkspaceRoots = () => grants;
const search = require('../src/lib/search');
test.after(() => {
  search.close();
  registry.confinedWorkspaceRoots = originalRoots;
  audit.record = originalRecord;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('unscoped search excludes revoked workspaces while preserving current matches', async () => {
  const revoked = path.join(scratch, 'revoked');
  const allowed = path.join(scratch, 'allowed');
  fs.mkdirSync(revoked);
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(revoked, 'note.md'), 'orchid sunlight former workspace synthetic material');
  fs.writeFileSync(path.join(allowed, 'note.md'), 'orchid sunlight current workspace synthetic material');
  grants = [revoked, allowed];
  await search.indexPath({ root: revoked, embedder: 'lexical' });
  await search.indexPath({ root: allowed, embedder: 'lexical' });
  const before = await search.query({ query: 'orchid sunlight', k: 10 });
  assert.equal(before.matches.length, 2);
  grants = [allowed];
  await assert.rejects(search.query({ query: 'orchid sunlight', root: revoked }), { code: 'SEARCH_ROOT_OUTSIDE_ROOT' });
  const after = await search.query({ query: 'orchid sunlight', k: 10 });
  assert.deepEqual(after.matches.map(row => row.path), [path.join(allowed, 'note.md')]);
  grants = [];
  const none = await search.query({ query: 'orchid sunlight', k: 10 });
  assert.deepEqual(none.matches, []);
});

test('cached text cannot bypass a file path redirected outside a still-granted root', async () => {
  const root = path.join(scratch, 'redirected-file');
  fs.mkdirSync(root);
  const subdir = path.join(root, 'subdir');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(subdir);
  fs.mkdirSync(outside);
  const removed = path.join(subdir, 'removed.md');
  const retained = path.join(root, 'retained.md');
  fs.writeFileSync(removed, 'orchid sunlight removed synthetic document');
  fs.writeFileSync(retained, 'orchid sunlight retained synthetic document');
  grants = [root];
  await search.indexPath({ root, embedder: 'lexical' });
  assert.equal((await search.query({ query: 'orchid sunlight', root, k: 10 })).matches.length, 2);
  fs.renameSync(subdir, path.join(root, 'saved-subdir'));
  fs.writeFileSync(path.join(outside, 'removed.md'), 'outside content must not be opened');
  fs.symlinkSync(outside, subdir, 'junction');
  for (const scope of [{}, { root }]) {
    const result = await search.query({ query: 'orchid sunlight', k: 10, ...scope });
    assert.deepEqual(result.matches.map(row => row.path), [retained]);
  }
});

test('workspace revocation during embedding prevents both scoped and unscoped disclosure', async () => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  const { DatabaseSync } = require('node:sqlite');
  const root = path.join(scratch, 'awaited-query');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'note.md'), 'synthetic content under a revocable grant');
  grants = [root];
  await search.indexPath({ root, embedder: 'lexical' });
  const db = new DatabaseSync(process.env.TOOLSENABLED_SEARCH_DB);
  try { db.prepare('UPDATE chunks SET embedder = ? WHERE root = ?').run('ollama:test-fixture', root); }
  finally { db.close(); }
  const originalRequest = http.request;
  try {
    for (const scope of [{ root }, {}]) {
      grants = [root];
      let finish;
      http.request = (_options, callback) => {
        const request = new EventEmitter();
        request.write = () => {};
        request.end = () => {
          finish = () => {
            const response = new EventEmitter();
            response.statusCode = 200;
            callback(response);
            response.emit('data', JSON.stringify({ embedding: Array(256).fill(1) }));
            response.emit('end');
          };
        };
        return request;
      };
      const pending = search.query({ query: 'synthetic content', ...scope });
      assert.equal(typeof finish, 'function', 'the real query reached its embedding await');
      grants = [];
      finish();
      assert.deepEqual((await pending).matches, []);
    }
  } finally { http.request = originalRequest; }
});
