'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const workstation = require('../src/lib/providers/workstation');

function refusal(code, action) {
  assert.throws(action, error => error instanceof workstation.WorkstationError && error.code === code);
}

// These calls exercise exported module behavior directly. The scratch directory
// is also a tripwire: refusals that happen before mutation must leave it exactly
// as the fixture created it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-refusals-'));
const transactionRoot = `C:\\workstation-refusals-${process.pid}-${Date.now()}`;
const transactionDirectory = path.resolve(transactionRoot);
try {
  const marker = path.join(scratch, 'marker');
  fs.writeFileSync(marker, 'unchanged', 'utf8');
  const pristine = () => assert.deepEqual(fs.readdirSync(scratch).sort(), ['marker']);

  refusal('WORKSTATION_HOST_INVALID', () => workstation.registeredRoot('not-a-registered-host.invalid'));
  pristine();

  if (process.platform !== 'win32') {
    // Public workstation operations must name the unavailable OS backend,
    // before interpreting POSIX paths as unsafe Windows drives or starting a CLI.
    for (const action of [workstation.status, workstation.installCursor,
      workstation.syncCursorExtensions, workstation.configureAgentClients, workstation.launchCursor]) {
      refusal('WORKSTATION_PLATFORM_UNSUPPORTED', () => action());
      pristine();
    }
  }

  const project = path.resolve(scratch, 'project');
  const duplicateProject = `[projects.'${project}']\ntrust_level = "trusted"\n\n`
    + `[projects.'${project.toUpperCase()}']\ntrust_level = "trusted"\n`;
  refusal('WORKSTATION_CODEX_PROJECT_DUPLICATE', () =>
    workstation.mergeCodexProjectTrust(duplicateProject, project));
  pristine();

  const incompleteBlock = `keep = "yes"\n${workstation.MANAGED_BLOCK_START}\n`;
  refusal('WORKSTATION_CODEX_CONFIG_INVALID', () =>
    workstation.mergeCodexConfig(incompleteBlock, {}, { localRoot: project }));
  pristine();

  fs.mkdirSync(transactionDirectory);
  const transactionMarker = path.join(transactionRoot, 'marker');
  fs.writeFileSync(path.resolve(transactionMarker), 'unchanged', 'utf8');
  refusal('WORKSTATION_CONFIG_INVALID', () => workstation.applyConfigTransaction([], () => true));
  refusal('WORKSTATION_CONFIG_INVALID', () => workstation.applyConfigTransaction([
    { file: transactionMarker, content: 'changed', allowedRoot: transactionRoot },
    { file: transactionMarker, content: 'changed again', allowedRoot: transactionRoot }
  ], () => true));
  assert.equal(fs.readFileSync(path.resolve(transactionMarker), 'utf8'), 'unchanged');
  pristine();

  const oversizedInput = path.join(transactionRoot, 'oversized');
  const oversized = path.resolve(oversizedInput);
  fs.writeFileSync(oversized, 'original', 'utf8');
  fs.truncateSync(oversized, workstation.MAX_CONFIG_SNAPSHOT_BYTES + 1);
  const originalSize = fs.statSync(oversized).size;
  refusal('WORKSTATION_CONFIG_TOO_LARGE', () => workstation.applyConfigTransaction([
    { file: oversizedInput, content: 'changed', allowedRoot: transactionRoot }
  ], () => true));
  assert.equal(fs.statSync(oversized).size, originalSize);
  assert.equal(fs.readFileSync(oversized, 'utf8').slice(0, 8), 'original');

  const absentState = path.join(scratch, 'absent-state.vscdb');
  refusal('WORKSTATION_CURSOR_STATE_NOT_READY', () => workstation.configureCursorState(absentState));
  assert.equal(fs.existsSync(absentState), false);

  assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(transactionDirectory, { recursive: true, force: true });
}

console.log('Workstation refusal contracts passed.');

if (process.platform !== 'win32') {
  assert.rejects(workstation.initializeCursorState(),
    error => error instanceof workstation.WorkstationError && error.code === 'WORKSTATION_PLATFORM_UNSUPPORTED')
    .catch(error => { console.error(error); process.exitCode = 1; });
}
