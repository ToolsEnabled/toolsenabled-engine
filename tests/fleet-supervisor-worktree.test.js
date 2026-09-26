'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const worktree = require('../src/lib/fleet-supervisor/worktree');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-supervisor-worktree-'));

try {
  const repoRoot = path.join(fixtureRoot, 'ToolsEnabled');
  const lanePath = path.join(fixtureRoot, 'ToolsEnabled-fleet-lane-review.1');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(lanePath);

  assert.equal(
    worktree.worktreePathFor('review.1', repoRoot),
    lanePath,
    'lane ids map to fleet-namespaced siblings of the repository'
  );
  assert.throws(
    () => worktree.worktreePathFor('../review', repoRoot),
    error => error instanceof worktree.WorktreeRefused &&
      error.code === 'FLEET_WORKTREE_REFUSED' &&
      error.reason === 'lane id is not a safe single path segment',
    'path-traversing lane ids are refused'
  );

  const marker = {
    kind: 'toolsenabled-fleet-lane',
    ownerToken: worktree.OWNER_TOKEN,
    repoRoot,
    laneId: 'review.1'
  };
  fs.writeFileSync(
    path.join(lanePath, worktree.MARKER_FILE),
    `${JSON.stringify(marker)}\n`,
    'utf8'
  );

  assert.deepEqual(
    worktree.reapable(lanePath, { repoRoot }),
    { ok: true, reason: null },
    'a correctly located lane with the module ownership marker is reapable'
  );

  // A busy machine must not turn an inconclusive metadata/marker read into the
  // definite claims "target does not exist" or "no ownership marker found".
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    const lstatBusy = { ...fs, lstatSync() { throw failure; } };
    assert.throws(
      () => worktree.assertReapable(lanePath, { repoRoot, fsImpl: lstatBusy }),
      error => error instanceof worktree.WorktreeIndeterminate &&
        error.code === 'FLEET_WORKTREE_INDETERMINATE' &&
        error.message.includes('does NOT claim'),
      `${code} reading target metadata is explicitly indeterminate`
    );

    const markerBusy = {
      ...fs,
      readFileSync(file, encoding) {
        if (file.endsWith(worktree.MARKER_FILE)) throw failure;
        return fs.readFileSync(file, encoding);
      }
    };
    assert.throws(
      () => worktree.assertReapable(lanePath, { repoRoot, fsImpl: markerBusy }),
      error => error instanceof worktree.WorktreeIndeterminate &&
        error.code === 'FLEET_WORKTREE_INDETERMINATE' &&
        error.message.includes('does NOT claim'),
      `${code} reading the marker is explicitly indeterminate`
    );
  }

  // CONTROL: genuine ENOENT keeps its old definite answer. A successful read
  // immediately after injected failures also proves uncertainty is not latched.
  const absent = Object.assign(new Error('injected ENOENT'), { code: 'ENOENT' });
  assert.throws(
    () => worktree.assertReapable(lanePath, { repoRoot, fsImpl: { ...fs, lstatSync() { throw absent; } } }),
    error => error instanceof worktree.WorktreeRefused &&
      error.code === 'FLEET_WORKTREE_REFUSED' && error.reason === 'target does not exist',
    'ENOENT remains the definite absent result'
  );
  assert.deepEqual(
    worktree.reapable(lanePath, { repoRoot }),
    { ok: true, reason: null },
    'an indeterminate read is not cached or latched'
  );

  marker.ownerToken = 'some-other-owner';
  fs.writeFileSync(
    path.join(lanePath, worktree.MARKER_FILE),
    `${JSON.stringify(marker)}\n`,
    'utf8'
  );
  assert.deepEqual(
    worktree.reapable(lanePath, { repoRoot }),
    { ok: false, reason: 'ownership marker token does not match' },
    'a fleet-shaped directory owned by somebody else is not reapable'
  );

  assert.deepEqual(
    worktree.reapable(repoRoot, { repoRoot }),
    { ok: false, reason: 'target is the repository root' },
    'the repository itself is never reapable'
  );

  process.stdout.write('PASS fleet-supervisor worktree namespace and ownership gates\n');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
