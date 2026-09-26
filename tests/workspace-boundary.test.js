/* Mutation check (2026-08-27):
 * In src/lib/workspace-boundary.js, replaced `return !segments.includes('..');`
 * with `return true;` in containedBy.
 * The edit landed: yes.
 * This test file went red: yes (the sibling-prefix assertion failed).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const boundary = require('../src/lib/workspace-boundary');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-boundary-test-'));
const workspace = path.join(sandbox, 'workspace');
const sibling = path.join(sandbox, 'workspace-escape');
const outside = path.join(sandbox, 'outside');

fs.mkdirSync(workspace);
fs.mkdirSync(sibling);
fs.mkdirSync(outside);
fs.mkdirSync(path.join(workspace, 'existing'));
/* Creating a symlink on Windows needs Developer Mode or an elevated shell. A test
   that dies on EPERM here is measuring the MACHINE, not the product -- so the one
   assertion that needs a symlink is gated below and announces a SKIP BY NAME.
   A named skip is not a pass; every other check in this file still runs. */
let outboundSymlink = true;
let outboundSymlinkReason = '';
try {
  fs.symlinkSync(outside, path.join(workspace, 'outbound-link'), 'dir');
} catch (err) {
  outboundSymlink = false;
  outboundSymlinkReason = err && err.code ? err.code : String(err);
}

try {
  assert.equal(boundary.assertShapeAllowed(path.join(workspace, 'file.txt'), 'output'),
    path.join(workspace, 'file.txt'));
  assert.throws(
    () => boundary.assertShapeAllowed('', 'output'),
    error => error instanceof boundary.WorkspaceBoundaryRefusal
      && error.code === 'WORKSPACE_PATH_UNREADABLE'
      && error.details.label === 'output'
  );
  assert.throws(
    () => boundary.assertShapeAllowed('bad\0path', 'input'),
    error => error instanceof boundary.WorkspaceBoundaryRefusal
      && error.code === 'WORKSPACE_PATH_UNREADABLE'
  );

  const futureFile = path.join(workspace, 'existing', 'not-created', 'result.txt');
  assert.equal(boundary.realResolve(futureFile, 'output'), futureFile,
    'a future write target is resolved through its nearest existing ancestor');

  assert.equal(boundary.containedBy(workspace, workspace), true);
  assert.equal(boundary.containedBy(workspace, path.join(workspace, 'child')), true);
  assert.equal(boundary.containedBy(workspace, sibling), false,
    'a path with the workspace name as a string prefix is not contained');

  const roots = boundary.resolveRoots([workspace]);
  assert.deepEqual(roots, [fs.realpathSync.native(workspace)]);
  assert.equal(Object.isFrozen(roots), true, 'resolved roots cannot be changed after validation');
  assert.throws(
    () => boundary.resolveRoots([]),
    error => error instanceof boundary.WorkspaceBoundaryRefusal
      && error.code === 'WORKSPACE_ROOTS_ABSENT'
  );
  assert.throws(
    () => boundary.resolveRoots([path.join(sandbox, 'missing-root')]),
    error => error instanceof boundary.WorkspaceBoundaryRefusal
      && error.code === 'WORKSPACE_ROOTS_UNREADABLE'
  );

  assert.equal(boundary.isInsideRoots(futureFile, [workspace]), true);
  assert.equal(boundary.isInsideRoots(path.join(workspace, '..', 'outside'), [workspace]), false,
    'parent traversal is judged after normalization');
  assert.equal(boundary.isInsideRoots(sibling, [workspace]), false,
    'sibling prefix collisions stay outside the workspace');
  if (outboundSymlink) {
    assert.equal(boundary.isInsideRoots(path.join(workspace, 'outbound-link', 'secret.txt'), [workspace]), false,
      'a not-yet-created target beneath an outbound symlink is judged at its real destination');
  } else {
    console.log('SKIP (NOT counted as a pass): a not-yet-created target beneath an outbound '
      + 'symlink is judged at its real destination -- this machine refused to create the '
      + 'symlink (' + outboundSymlinkReason + '). On Windows that needs Developer Mode or an '
      + 'elevated shell. The behaviour is UNMEASURED here, not verified.');
  }

  assert.equal(boundary.assertInsideRoots(futureFile, [workspace], {
    label: 'outputPath', tool: 'extension.package'
  }), true);
  assert.throws(
    () => boundary.assertInsideRoots(sibling, [workspace], {
      label: 'outputPath', tool: 'extension.package'
    }),
    error => error instanceof boundary.WorkspaceBoundaryRefusal
      && error.code === 'WORKSPACE_BOUNDARY_REFUSED'
      && error.details.label === 'outputPath'
      && error.details.tool === 'extension.package'
      && error.message.includes('extension.package')
      && !error.message.includes(sandbox)
  );

  console.log('workspace-boundary behaviour tests passed');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
