'use strict';

require('./lib/isolated-environment').activate('repo-sync-status');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_STATE_BYTES,
  readRepoSyncStatus
} = require('../src/lib/repo-sync-status');

const NOW = Date.parse('2026-08-07T00:10:00.000Z');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-status-'));
let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function validState(overrides = {}) {
  return {
    generatedAt: '2026-08-07T00:05:00.000Z',
    schemaVersion: 1,
    action: 'in-sync',
    ok: true,
    detail: 'origin/main counts are 0/0 and advertised-ref containment is verified',
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirtyPathCount: 0,
    dirtyPaths: [],
    dirtyPathsTruncated: false,
    containment: {
      status: 'verified',
      networkVerified: true,
      checkedRemotes: ['origin'],
      code: null,
      summary: 'nothing stranded across every advertised ref'
    },
    countsAreContainmentProof: false,
    ...overrides
  };
}

function writeState(name, value, { raw = false } = {}) {
  const stateFile = path.join(tempRoot, name);
  fs.writeFileSync(stateFile, raw ? value : JSON.stringify(value), 'utf8');
  return stateFile;
}

function assertRefusal(result, reason) {
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, reason);
  assert.equal(result.contentTrust, 'untrusted');
  assert.equal(result.grantsAuthority, false);
  assert.equal(result.branch, null, 'refused content must not be projected');
  assert.equal(result.lastAction, null, 'refused actions must not be projected');
}

function withoutProcessEffects(fn) {
  const originals = new Map();
  for (const method of ['execFileSync', 'execSync', 'spawn', 'spawnSync']) {
    originals.set(method, childProcess[method]);
    childProcess[method] = () => { throw new Error(`reader attempted to ${method}`); };
  }
  try {
    return fn();
  } finally {
    for (const [method, original] of originals) childProcess[method] = original;
  }
}

try {
  check('invalid reader options refuse before touching the filesystem', () => {
    let filesystemCalls = 0;
    const fsImpl = new Proxy({}, {
      get() {
        filesystemCalls += 1;
        throw new Error('filesystem must not be touched');
      }
    });
    const result = withoutProcessEffects(() => readRepoSyncStatus({
      stateFile: 'ignored.json', nowMs: -1, fsImpl
    }));
    assertRefusal(result, 'READER_OPTIONS_INVALID');
    assert.equal(filesystemCalls, 0);
    assert.equal(result.containment.code, 'STATE_UNAVAILABLE');
  });

  check('every bounded state field refusal is driven through the reader', () => {
    const invalidStates = [
      ['STATE_SHAPE_INVALID', null],
      ['STATE_GENERATED_AT_INVALID', validState({ generatedAt: '' })],
      ['STATE_ACTION_INVALID', validState({ action: '' })],
      ['STATE_DETAIL_INVALID', validState({ detail: '' })],
      ['STATE_BRANCH_INVALID', validState({ branch: '' })],
      ['STATE_COUNTS_INVALID', validState({ ahead: -1 })],
      ['STATE_DIRTY_PATHS_INVALID', validState({ dirtyPathCount: 0, dirtyPaths: ['unaccounted'] })],
      ['STATE_CONTAINMENT_INVALID', validState({ containment: { status: 'verified', networkVerified: false, checkedRemotes: [], code: null, summary: 'contradiction' } })],
      ['STATE_CONTAINMENT_CLAIM_INVALID', validState({ countsAreContainmentProof: true })],
      ['STATE_ACTION_RESULT_MISMATCH', validState({ action: 'in-sync', ok: false })]
    ];

    for (const [reason, state] of invalidStates) {
      let reads = 0;
      let writes = 0;
      const fsImpl = {
        statSync() { return { size: Buffer.byteLength(JSON.stringify(state)), mtimeMs: NOW - 1000 }; },
        readFileSync() { reads += 1; return JSON.stringify(state); },
        writeFileSync() { writes += 1; throw new Error('reader attempted to write'); }
      };
      const result = withoutProcessEffects(() => readRepoSyncStatus({
        stateFile: `${reason}.json`, nowMs: NOW, fsImpl
      }));
      assertRefusal(result, reason);
      assert.equal(reads, 1, `${reason} must be reached by parsing the injected record`);
      assert.equal(writes, 0, `${reason} must remain read-only`);
      assert.equal(result.containment.code, 'STATE_UNAVAILABLE');
    }
  });

  check('canonical-shape but impossible timestamps reach the time refusal', () => {
    let writes = 0;
    const state = validState({ generatedAt: '2026-08-07T00:05:00Z' });
    const encoded = JSON.stringify(state);
    const result = withoutProcessEffects(() => readRepoSyncStatus({
      stateFile: 'noncanonical-time.json',
      nowMs: NOW,
      fsImpl: {
        statSync() { return { size: Buffer.byteLength(encoded), mtimeMs: NOW - 1000 }; },
        readFileSync() { return encoded; },
        writeFileSync() { writes += 1; }
      }
    }));
    assertRefusal(result, 'STATE_TIME_INVALID');
    assert.equal(result.generatedAt, null, 'an invalid body timestamp must not escape as provenance');
    assert.equal(writes, 0);
  });

  check('missing state is UNKNOWN with a typed reason', () => {
    const result = readRepoSyncStatus({ stateFile: path.join(tempRoot, 'missing.json'), nowMs: NOW });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'STATE_MISSING');
    assert.equal(result.lastAction, null);
  });

  check('a filesystem access failure is unreadable rather than missing', () => {
    const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const result = readRepoSyncStatus({
      stateFile: path.join(tempRoot, 'not-measured.json'),
      nowMs: NOW,
      fsImpl: {
        // Node's existsSync() returns false rather than exposing this failure.
        existsSync: () => false,
        statSync: () => { throw accessError; }
      }
    });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'STATE_UNREADABLE');
    assert.equal(result.detail, 'permission denied');
  });

  // THE ABSENCE CASE. A record with NO schemaVersion is a legacy record from
  // before R1162 added containment, not a record whose version this build
  // dislikes, and it must not be read as version 1 either. All three of those
  // outcomes used to be the same bare UNKNOWN, which is how a state file that
  // had simply not been rewritten for a week read as a live writer defect.
  check('a record with no schemaVersion is refused as legacy, not as a wrong version', () => {
    const legacy = validState({ generatedAt: '2026-08-01T00:00:00.000Z' });
    delete legacy.schemaVersion;
    delete legacy.dirtyPathCount;
    delete legacy.dirtyPaths;
    delete legacy.dirtyPathsTruncated;
    delete legacy.containment;
    delete legacy.countsAreContainmentProof;
    const stateFile = writeState('legacy-no-schema.json', legacy);
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'STATE_SCHEMA_MISSING');
    // The one fact that survives refusal: when it was written.
    assert.equal(result.generatedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(result.ageMs, NOW - Date.parse('2026-08-01T00:00:00.000Z'));
    assert.ok(result.detail.includes('predates'), 'detail must name the legacy condition');
    // ...and nothing the record CLAIMED survives it.
    assert.equal(result.branch, null);
    assert.equal(result.lastAction, null);
    assert.equal(result.actionOk, null);
    assert.equal(result.contentTrust, 'untrusted');
    assert.equal(result.grantsAuthority, false);
    assert.equal(result.containment.status, 'unknown');
  });

  check('an explicitly null schemaVersion is absence, not a version', () => {
    const stateFile = writeState('null-schema.json', validState({ schemaVersion: null }));
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.reason, 'STATE_SCHEMA_MISSING');
    assert.equal(result.status, 'UNKNOWN');
  });

  check('a schemaVersion this build does not know stays UNSUPPORTED', () => {
    const stateFile = writeState('future-schema.json', validState({ schemaVersion: 2 }));
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.reason, 'STATE_SCHEMA_UNSUPPORTED');
    assert.equal(result.status, 'UNKNOWN');
  });

  check('a refused record never reports an uncanonical or future generatedAt as a time', () => {
    const futureFile = writeState('future-stamp.json', { schemaVersion: 1, generatedAt: '2099-01-01T00:00:00.000Z' });
    const future = readRepoSyncStatus({ stateFile: futureFile, nowMs: NOW });
    assert.equal(future.generatedAt, null, 'a future stamp must not be reported');
    assert.equal(future.ageMs, null);
    assert.ok(Number.isSafeInteger(future.fileWrittenAtMs), 'the filesystem mtime still stands');

    const junkFile = writeState('junk-stamp.json', { schemaVersion: 1, generatedAt: 'yesterday-ish' });
    const junk = readRepoSyncStatus({ stateFile: junkFile, nowMs: NOW });
    assert.equal(junk.generatedAt, null, 'an uncanonical stamp must not be reported');
    assert.equal(junk.ageMs, null);
  });

  check('malformed state is UNKNOWN rather than in sync', () => {
    const stateFile = writeState('malformed.json', '{not-json', { raw: true });
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'STATE_MALFORMED');
  });

  check('oversize state is UNKNOWN without parsing it', () => {
    const stateFile = writeState('oversize.json', 'x'.repeat(MAX_STATE_BYTES + 1), { raw: true });
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'STATE_SIZE_INVALID');
  });

  check('stale state is STALE while retaining bounded diagnostics', () => {
    const stateFile = writeState('stale.json', validState({ generatedAt: '2026-08-06T23:00:00.000Z' }));
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW, maxAgeMs: 15 * 60 * 1000 });
    assert.equal(result.status, 'STALE');
    assert.equal(result.reason, 'STATE_STALE');
    assert.equal(result.branch, 'main');
    assert.equal(result.lastAction, 'in-sync');
    assert.equal(result.countsAreContainmentProof, false);
  });

  check('fresh successful state is SYNCED and exposes required fields', () => {
    const stateFile = writeState('fresh.json', validState());
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.status, 'SYNCED');
    assert.equal(result.reason, null);
    assert.equal(result.branch, 'main');
    assert.equal(result.ahead, 0);
    assert.equal(result.behind, 0);
    assert.equal(result.lastAction, 'in-sync');
    assert.equal(result.generatedAt, '2026-08-07T00:05:00.000Z');
    assert.equal(result.ageMs, 5 * 60 * 1000);
    assert.equal(result.containment.status, 'verified');
    assert.equal(Object.isFrozen(result), true);
  });

  check('fresh failed reconciliation is FAILED with dirty and divergence truth', () => {
    const stateFile = writeState('failed.json', validState({
      action: 'diverged-main',
      ok: false,
      detail: 'local main diverged (ahead 2, behind 3)',
      ahead: 2,
      behind: 3,
      dirtyPathCount: 1,
      dirtyPaths: ['scratch/untracked.txt'],
      containment: {
        status: 'stranded',
        networkVerified: true,
        checkedRemotes: ['origin'],
        code: 'SINGLE_COPY_WORK_PRESENT',
        summary: 'stranded work found'
      }
    }));
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.reason, 'LAST_ACTION_FAILED');
    assert.equal(result.lastAction, 'diverged-main');
    assert.deepEqual(result.dirtyPaths, ['scratch/untracked.txt']);
  });

  check('success without network containment is rejected as UNKNOWN', () => {
    const stateFile = writeState('false-success.json', validState({
      containment: {
        status: 'unknown',
        networkVerified: false,
        checkedRemotes: [],
        code: 'CONTAINMENT_NOT_NETWORK_VERIFIED',
        summary: 'offline result'
      }
    }));
    const result = readRepoSyncStatus({ stateFile, nowMs: NOW });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'STATE_SUCCESS_WITHOUT_CONTAINMENT');
  });

  check('system status consumes the reader and never invokes Git', () => {
    const stateFile = writeState('system-status.json', validState());
    const originalExecFileSync = childProcess.execFileSync;
    const originalSpawnSync = childProcess.spawnSync;
    let gitCalls = 0;
    childProcess.execFileSync = function guardedExecFileSync(file, ...args) {
      if (path.basename(String(file)).toLowerCase().replace(/\.exe$/, '') === 'git') gitCalls += 1;
      return originalExecFileSync.call(this, file, ...args);
    };
    childProcess.spawnSync = function guardedSpawnSync(file, ...args) {
      if (path.basename(String(file)).toLowerCase().replace(/\.exe$/, '') === 'git') gitCalls += 1;
      return originalSpawnSync.call(this, file, ...args);
    };
    try {
      const system = require('../src/lib/system-status');
      const result = system.status({
        mcpToolSurface: { state: 'test' },
        repoSync: { stateFile, nowMs: NOW }
      });
      assert.equal(result.repoSync.status, 'SYNCED');
      assert.equal(result.repoSync.lastAction, 'in-sync');
      assert.equal(gitCalls, 0);
    } finally {
      childProcess.execFileSync = originalExecFileSync;
      childProcess.spawnSync = originalSpawnSync;
    }
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`Repo-sync status reader tests passed (${passed} checks).`);
