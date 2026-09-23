#!/usr/bin/env node
/*
 * Mutation check: persisted note reload is guarded by this file.
 * Exact mutation: replaced `{ note: value.note }` with `{}` in parseRecord.
 * Mutation landed: yes (the edited source text was confirmed before the run).
 * Result: RED; the isolated test exited 1 at the note search assertion.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DurableMemoryFileError,
  createDurableMemoryFile,
  resolveServicesRoot
} = require('../src/lib/durable-memory-file');
const {
  AgentConfinementRefusal,
  assertAccountProfilePath,
  installationProfileRoot,
  windowsInstalledProfileRootOf
} = require('../src/lib/account-profile-boundary');
const { accountRegistryPath } = require('../src/lib/multi-account/registry-location');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const directory = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'durable-memory-file-test-'));
const file = path.join(directory, 'memory.json');
const timestamps = ['2026-08-27T01:02:03.000Z', '2026-08-27T01:02:04.000Z'];

function recordingFileSystem(overrides = {}) {
  const calls = [];
  const wrapped = {};
  for (const method of ['readFileSync', 'mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync']) {
    wrapped[method] = (...args) => {
      calls.push(method);
      if (Object.prototype.hasOwnProperty.call(overrides, method)) return overrides[method](...args);
      return fs[method](...args);
    };
  }
  return { calls, fileSystem: wrapped };
}

function assertRefusal(action, code, message) {
  assert.throws(action, error => error instanceof DurableMemoryFileError && error.code === code, message);
}

try {
  const syntheticUser = homedir => () => ({ homedir });
  const globalNode = 'C:\\agent-apps\\node-v22.19.0\\node.exe';
  assert.equal(
    installationProfileRoot({
      platform: 'win32',
      moduleDirectory: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\toolsenabled\\resources\\capability\\src\\lib',
      executablePath: globalNode,
      userInfo: syntheticUser('c:/users/alice/')
    }).toLowerCase(),
    'c:\\users\\alice',
    'a conventional per-user installation must bind to the matching operating-system principal'
  );
  assert.equal(
    installationProfileRoot({
      platform: 'win32',
      moduleDirectory: 'D:\\Profiles\\Alice\\AppData\\Local\\Programs\\toolsenabled\\resources\\capability\\src\\lib',
      executablePath: globalNode,
      userInfo: syntheticUser('D:\\Profiles\\Alice')
    }),
    'D:\\Profiles\\Alice',
    'a redirected per-user installation must derive its owner before using the launch token'
  );
  assert.equal(
    installationProfileRoot({
      platform: 'win32',
      moduleDirectory: '\\\\?\\D:\\Profiles\\Alice\\AppData\\Local\\Programs\\toolsenabled\\resources\\capability\\src\\lib',
      executablePath: globalNode,
      userInfo: syntheticUser('\\\\localhost\\D$\\Profiles\\Alice')
    }).toLowerCase(),
    'd:\\profiles\\alice',
    'equivalent extended and local-admin-share aliases must bind to the same redirected owner'
  );
  assert.throws(
    () => installationProfileRoot({
      platform: 'win32',
      moduleDirectory: 'D:\\Profiles\\Alice\\AppData\\Local\\Programs\\toolsenabled\\resources\\capability\\src\\lib',
      executablePath: globalNode,
      userInfo: syntheticUser('C:\\Users\\Bob')
    }),
    error => error instanceof AgentConfinementRefusal
      && error.code === 'AGENT_CONFINEMENT_WRONG_PRINCIPAL',
    'a redirected installation started by the wrong principal must fail closed'
  );
  assert.equal(
    installationProfileRoot({
      platform: 'win32',
      moduleDirectory: 'C:\\Users\\Alice\\src\\engine\\src\\lib',
      executablePath: globalNode,
      userInfo: syntheticUser('C:\\Users\\Alice')
    }),
    'C:\\Users\\Alice',
    'a source or scratch payload inside the current account may use that account'
  );
  for (const [label, moduleDirectory, homedir, expectedCode] of [
    ['source payload under another token', 'C:\\Users\\Alice\\src\\engine\\src\\lib', 'C:\\Users\\Bob', 'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE'],
    ['unbound Program Files payload', 'C:\\Program Files\\ToolsEnabled\\resources\\capability\\src\\lib', 'C:\\Users\\Alice', 'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE'],
    ['unbound build payload', 'D:\\Builds\\toolsenabled\\src\\lib', 'C:\\Users\\Alice', 'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE']
  ]) {
    assert.throws(
      () => installationProfileRoot({
        platform: 'win32', moduleDirectory, executablePath: globalNode, userInfo: syntheticUser(homedir)
      }),
      error => error instanceof AgentConfinementRefusal && error.code === expectedCode,
      `${label} must fail closed without adopting the launch token`
    );
  }
  assert.throws(
    () => installationProfileRoot({
      platform: 'win32',
      moduleDirectory: 'C:\\Program Files\\ToolsEnabled\\resources\\capability\\src\\lib',
      executablePath: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\nodejs\\node.exe',
      userInfo: syntheticUser('C:\\Users\\Alice')
    }),
    error => error instanceof AgentConfinementRefusal
      && error.code === 'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
    'a user-installed node executable must not establish ownership for an unbound module tree'
  );
  assert.equal(
    windowsInstalledProfileRootOf(
      'D:\\Profiles\\Alice\\AppData\\Local\\Programs\\toolsenabled\\..\\..\\..\\..\\..\\Bob\\AppData\\Local\\Programs\\toolsenabled\\app.exe'
    ),
    'D:\\Profiles\\Bob',
    'parent-segment escapes must be normalized before the installed owner is derived'
  );

  assert.equal(
    resolveServicesRoot({
      env: {
        TOOLSENABLED_STATE_ROOT: path.join(directory, 'ToolsEnabled Test', 'capability'),
        XDG_DATA_HOME: path.join(directory, 'data'),
        LOCALAPPDATA: path.join(directory, 'wrong-ambient-account')
      },
      platform: 'linux'
    }),
    path.join(directory, 'wrong-ambient-account', 'ToolsEnabled Test'),
    'the shipped non-Windows contract must honor an explicitly supplied LOCALAPPDATA location'
  );
  assert.equal(
    resolveServicesRoot({
      env: {
        TOOLSENABLED_STATE_ROOT: path.join(directory, 'ToolsEnabled Test', 'capability'),
        XDG_DATA_HOME: path.join(directory, 'data')
      },
      platform: 'linux'
    }),
    path.join(directory, 'data', 'ToolsEnabled Test'),
    'the non-Windows fallback must combine XDG data home with the selected product identity'
  );

  if (process.platform === 'win32') {
    const localAppData = path.join(directory, 'local-app-data');
    const casePreservedRoot = path.join(directory, 'ToolsEnabled Case Probe');
    fs.mkdirSync(path.join(casePreservedRoot, 'capability'), { recursive: true });
    const differentlyCasedStateRoot = path.join(
      path.dirname(casePreservedRoot),
      path.basename(casePreservedRoot).toLowerCase(),
      'capability'
    );
    assert.equal(
      resolveServicesRoot({
        env: { TOOLSENABLED_STATE_ROOT: differentlyCasedStateRoot, LOCALAPPDATA: localAppData }
      }).toLowerCase(),
      path.join(localAppData, path.basename(casePreservedRoot)).toLowerCase(),
      'Windows must keep service state under owner-fenced LOCALAPPDATA while preserving selected product identity'
    );
  }

  const firstProcess = createDurableMemoryFile({
    file,
    clock: () => timestamps.shift(),
    randomUUID: () => 'first-write'
  });
  const created = firstProcess.setMemory({
    namespace: 'roles',
    key: 'incident-lead',
    value: { permissions: ['triage'] },
    expectedRevision: 0,
    note: 'Coordinates production recovery',
    tags: ['operations', 'urgent']
  });

  assert.deepEqual(created, {
    entry: {
      namespace: 'roles',
      key: 'incident-lead',
      value: { permissions: ['triage'] },
      revision: 1,
      updatedAt: '2026-08-27T01:02:03.000Z'
    },
    created: true,
    replayed: false
  }, 'a create should return the stored value and its first revision');

  const secondProcess = createDurableMemoryFile({ file });
  assert.deepEqual(
    secondProcess.searchMemory({ namespace: 'roles', query: 'production' }),
    [created.entry],
    'a note must remain searchable after a fresh store reloads the file'
  );
  assert.deepEqual(
    secondProcess.searchMemory({ namespace: 'roles', query: 'URGENT' }),
    [created.entry],
    'tags must remain searchable case-insensitively after reload'
  );
  assert.deepEqual(secondProcess.getMemory({ namespace: 'roles', key: 'incident-lead' }), created.entry,
    'a fresh store should read the persisted entry');

  assert.throws(
    () => secondProcess.setMemory({
      namespace: 'roles',
      key: 'incident-lead',
      value: { permissions: [] },
      expectedRevision: 0
    }),
    error => error instanceof DurableMemoryFileError &&
      error.code === 'MEMORY_REVISION_CONFLICT' &&
      error.details.actualRevision === 1,
    'a stale expected revision should be rejected with conflict details'
  );

  assert.equal(secondProcess.deleteMemory({ namespace: 'roles', key: 'incident-lead' }), true,
    'deleting an existing entry should report a change');
  const thirdProcess = createDurableMemoryFile({ file });
  assert.equal(thirdProcess.getMemory({ namespace: 'roles', key: 'incident-lead' }), null,
    'the deletion should survive another fresh store reload');
  assert.equal(thirdProcess.deleteMemory({ namespace: 'roles', key: 'incident-lead' }), false,
    'deleting a missing entry should report no change');

  const damagedFile = path.join(directory, 'damaged.json');
  fs.writeFileSync(damagedFile, '{not JSON');
  const damagedFs = recordingFileSystem();
  const damagedStore = createDurableMemoryFile({ file: damagedFile, fileSystem: damagedFs.fileSystem });
  assertRefusal(
    () => damagedStore.setMemory({ namespace: 'roles', key: 'replacement', value: true }),
    'DURABLE_MEMORY_DAMAGED',
    'a malformed record must refuse rather than being overwritten'
  );
  assert.deepEqual(damagedFs.calls, ['readFileSync'], 'a damaged-record refusal must perform no filesystem mutation');
  assert.equal(fs.readFileSync(damagedFile, 'utf8'), '{not JSON', 'the damaged bytes must remain untouched');

  const fullFile = path.join(directory, 'full.json');
  const fullEntries = {};
  for (let index = 0; index < 256; index += 1) {
    const key = `key-${index}`;
    fullEntries[`roles\u0000${key}`] = {
      namespace: 'roles', key, value: index, revision: 1, updatedAt: '2026-08-27T00:00:00.000Z'
    };
  }
  fs.writeFileSync(fullFile, JSON.stringify({ schemaVersion: 1, entries: fullEntries }));
  const fullFs = recordingFileSystem();
  const fullStore = createDurableMemoryFile({ file: fullFile, fileSystem: fullFs.fileSystem });
  assertRefusal(
    () => fullStore.setMemory({ namespace: 'roles', key: 'one-too-many', value: true }),
    'DURABLE_MEMORY_FULL',
    'a new entry beyond the entry limit must be refused'
  );
  assert.deepEqual(fullFs.calls, ['readFileSync'], 'a full-store refusal must perform no filesystem mutation');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(fullFile, 'utf8')).entries).length, 256,
    'the refused entry must not be persisted');

  const tooLargeFile = path.join(directory, 'too-large.json');
  const tooLargeFs = recordingFileSystem();
  const tooLargeStore = createDurableMemoryFile({ file: tooLargeFile, fileSystem: tooLargeFs.fileSystem });
  assertRefusal(
    () => tooLargeStore.setMemory({ namespace: 'roles', key: 'oversized', value: 'x'.repeat(1024 * 1024) }),
    'DURABLE_MEMORY_TOO_LARGE',
    'a serialized record beyond the byte limit must be refused'
  );
  assert.deepEqual(tooLargeFs.calls, ['readFileSync'], 'an oversized refusal must happen before creating any file or directory');
  assert.equal(fs.existsSync(tooLargeFile), false, 'an oversized record must leave no target file');

  const failedFile = path.join(directory, 'write-failed.json');
  const failedFs = recordingFileSystem({
    openSync() {
      const error = new Error('injected open failure');
      error.code = 'EACCES';
      throw error;
    },
    unlinkSync() {
      const error = new Error('nothing was created');
      error.code = 'ENOENT';
      throw error;
    }
  });
  const failedStore = createDurableMemoryFile({
    file: failedFile,
    fileSystem: failedFs.fileSystem,
    randomUUID: () => 'failed-write'
  });
  assertRefusal(
    () => failedStore.setMemory({ namespace: 'roles', key: 'unwritable', value: true }),
    'DURABLE_MEMORY_WRITE_FAILED',
    'an injected filesystem failure must become a stable write refusal'
  );
  assert.deepEqual(failedFs.calls, ['readFileSync', 'mkdirSync', 'openSync', 'unlinkSync'],
    'a failed open must not write, sync, close, or rename anything');
  assert.equal(fs.existsSync(failedFile), false, 'a failed write must leave no target file');

  let homedirCalls = 0;
  assertRefusal(
    () => resolveServicesRoot({
      env: { TOOLSENABLED_STATE_ROOT: path.join(directory, 'ToolsEnabled Test', 'capability') },
      platform: 'win32',
      homedir() { homedirCalls += 1; return directory; }
    }),
    'SERVICE_ROOT_UNAVAILABLE',
    'Windows must refuse when LOCALAPPDATA cannot identify an absolute service root'
  );
  assert.equal(homedirCalls, 0, 'the Windows refusal must not fall back to or probe an ambient home directory');

  if (process.platform === 'win32') {
    const validLocalAppData = path.join(directory, 'valid-local-app-data');
    assertRefusal(
      () => resolveServicesRoot({
        env: {
          TOOLSENABLED_STATE_ROOT: 'C:\\Users\\fixture-user\\ToolsEnabled\\capability',
          LOCALAPPDATA: validLocalAppData
        }
      }),
      'SERVICE_ACCOUNT_BOUNDARY_REFUSED',
      'a durable service root cannot be redirected into another Windows profile'
    );

    let hostileFilesystemProbes = 0;
    let configuredStateRootCalls = 0;
    const noProbeFileSystem = {
      lstatSync() { hostileFilesystemProbes += 1; throw new Error('unexpected lstat'); },
      realpathSync() { hostileFilesystemProbes += 1; throw new Error('unexpected realpath'); }
    };
    const wrongPrincipalBoundary = {
      installationProfileRoot() {
        return installationProfileRoot({
          platform: 'win32',
          moduleDirectory: 'D:\\Profiles\\Alice\\AppData\\Local\\Programs\\toolsenabled\\resources\\capability\\src\\lib',
          executablePath: globalNode,
          userInfo: syntheticUser('C:\\Users\\Bob')
        });
      },
      assertAccountProfilePath() {
        hostileFilesystemProbes += 1;
        throw new Error('wrong-principal path must never be inspected');
      }
    };
    assertRefusal(
      () => resolveServicesRoot({
        env: {
          TOOLSENABLED_STATE_ROOT: 'C:\\Users\\Bob\\AppData\\Roaming\\ToolsEnabled\\capability',
          LOCALAPPDATA: 'C:\\Users\\Bob\\AppData\\Local'
        },
        platform: 'win32',
        accountBoundary: wrongPrincipalBoundary,
        configuredStateRootImpl() { configuredStateRootCalls += 1; return null; },
        fileSystem: noProbeFileSystem
      }),
      'SERVICE_ACCOUNT_BOUNDARY_REFUSED',
      'a wrong-principal redirected installation must be refused before any account path is inspected'
    );
    assert.equal(hostileFilesystemProbes, 0, 'a wrong-principal refusal must make zero filesystem probes');
    assert.equal(configuredStateRootCalls, 0, 'a wrong-principal refusal must precede configured-state-root resolution');

    hostileFilesystemProbes = 0;
    configuredStateRootCalls = 0;
    const unboundInstallationBoundary = {
      installationProfileRoot() {
        return installationProfileRoot({
          platform: 'win32',
          moduleDirectory: 'C:\\Program Files\\ToolsEnabled\\resources\\capability\\src\\lib',
          executablePath: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\nodejs\\node.exe',
          userInfo: syntheticUser('C:\\Users\\Alice')
        });
      },
      assertAccountProfilePath() {
        hostileFilesystemProbes += 1;
        throw new Error('unbound-installation path must never be inspected');
      }
    };
    assertRefusal(
      () => resolveServicesRoot({
        env: {
          TOOLSENABLED_STATE_ROOT: 'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled\\capability',
          LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local'
        },
        platform: 'win32',
        accountBoundary: unboundInstallationBoundary,
        configuredStateRootImpl() { configuredStateRootCalls += 1; return null; },
        fileSystem: noProbeFileSystem
      }),
      'SERVICE_ACCOUNT_BOUNDARY_REFUSED',
      'an unbound Program Files installation must be refused before any account path is inspected'
    );
    assert.equal(hostileFilesystemProbes, 0, 'an unbound-installation refusal must make zero filesystem probes');
    assert.equal(configuredStateRootCalls, 0, 'an unbound-installation refusal must precede state-root resolution');

    const syntheticOwner = 'C:\\Users\\Alice';
    const lexicalBoundary = {
      installationProfileRoot() { return syntheticOwner; },
      assertAccountProfilePath(value, options) {
        return assertAccountProfilePath(value, { ...options, fileSystem: noProbeFileSystem });
      }
    };
    for (const [label, localAppData, expectedCode] of [
      ['relative LOCALAPPDATA', 'AppData\\Local', 'SERVICE_ROOT_UNAVAILABLE'],
      ['foreign LOCALAPPDATA', 'C:\\Users\\Bob\\AppData\\Local', 'SERVICE_ACCOUNT_BOUNDARY_REFUSED'],
      ['escaped LOCALAPPDATA', 'C:\\Users\\Alice\\AppData\\Local\\..\\..\\..\\Bob\\AppData\\Local', 'SERVICE_ACCOUNT_BOUNDARY_REFUSED'],
      ['unsupported remote admin-share LOCALAPPDATA', '\\\\remote-host\\C$\\Users\\Alice\\AppData\\Local', 'SERVICE_ACCOUNT_BOUNDARY_REFUSED']
    ]) {
      hostileFilesystemProbes = 0;
      configuredStateRootCalls = 0;
      assertRefusal(
        () => resolveServicesRoot({
          env: {
            TOOLSENABLED_STATE_ROOT: 'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled\\capability',
            LOCALAPPDATA: localAppData
          },
          platform: 'win32',
          accountBoundary: lexicalBoundary,
          configuredStateRootImpl() {
            configuredStateRootCalls += 1;
            return 'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled\\capability';
          },
          fileSystem: noProbeFileSystem
        }),
        expectedCode,
        `${label} must be refused lexically`
      );
      assert.equal(hostileFilesystemProbes, 0, `${label} must make zero filesystem probes`);
      assert.equal(configuredStateRootCalls, 0, `${label} must be refused before state-root probing`);
    }

    let allowedFilesystemProbes = 0;
    function syntheticRealpath(value) { allowedFilesystemProbes += 1; return value; }
    syntheticRealpath.native = syntheticRealpath;
    const aliasFileSystem = {
      lstatSync(value) {
        if (String(value).endsWith('.toolsenabled-local-profile.json')) throw Object.assign(new Error('absent fixture marker'), { code: 'ENOENT' });
        allowedFilesystemProbes += 1;
        return { isSymbolicLink() { return false; } };
      },
      realpathSync: syntheticRealpath
    };
    const aliasBoundary = {
      installationProfileRoot() { return syntheticOwner; },
      assertAccountProfilePath(value, options) {
        return assertAccountProfilePath(value, { ...options, fileSystem: aliasFileSystem });
      }
    };
    for (const localAppDataAlias of [
      '\\\\localhost\\C$\\Users\\Alice\\AppData\\Local',
      '\\\\?\\C:\\Users\\Alice\\AppData\\Local'
    ]) {
      allowedFilesystemProbes = 0;
      assert.equal(
        resolveServicesRoot({
          env: {
            TOOLSENABLED_STATE_ROOT: 'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled Test\\capability',
            LOCALAPPDATA: localAppDataAlias
          },
          platform: 'win32',
          accountBoundary: aliasBoundary,
          configuredStateRootImpl() {
            return 'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled Test\\capability';
          },
          fileSystem: aliasFileSystem
        }),
        'C:\\Users\\Alice\\AppData\\Local\\ToolsEnabled Test',
        'equivalent owner LOCALAPPDATA aliases must resolve to one canonical service root'
      );
      assert.ok(allowedFilesystemProbes > 0, 'an allowed owner path must still receive reparse/canonical checks');
    }

    assert.equal(
      accountRegistryPath({
        resolveStateRootImpl() {
          return { root: 'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled\\capability', reason: 'configured' };
        }
      }),
      'C:\\Users\\Alice\\AppData\\Roaming\\ToolsEnabled\\capability\\config\\accounts.json',
      'the account registry must remain under the selected state root rather than moving with service state'
    );
  }

  console.log('durable-memory-file behavior tests passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
