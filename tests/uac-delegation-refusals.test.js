'use strict';

const assert = require('node:assert/strict');

const uac = require('../src/lib/uac-delegation');

const OWNER = 'TESTDOMAIN\\owner';
const TOKEN = Buffer.alloc(32, 7);

function captureCode(fn, expected) {
  let error;
  assert.throws(fn, candidate => {
    error = candidate;
    return candidate && candidate.code === expected;
  });
  assert.equal(error.name, 'UacDelegationError');
  return error;
}

function oneOperationAllowlist() {
  return uac.parseAllowlist({
    schemaVersion: 1,
    operations: [{
      id: 'allowed-operation',
      steps: [{ exec: 'schtasks.exe', args: ['/Run', '/TN', 'Fixed Task'] }]
    }]
  }, { ownerPrincipal: OWNER });
}

(() => {
  const effects = [];
  const unavailableFs = {
    readFileSync(file, encoding) {
      effects.push({ kind: 'read', file, encoding });
      const error = new Error('injected access denial');
      error.code = 'EACCES';
      throw error;
    },
    writeFileSync() { effects.push({ kind: 'write' }); },
    renameSync() { effects.push({ kind: 'rename' }); },
    mkdirSync() { effects.push({ kind: 'mkdir' }); }
  };

  const error = captureCode(() => uac.loadAllowlist({
    allowlistFile: '/injected/unreadable-allowlist.json',
    fs: unavailableFs,
    ownerPrincipal: OWNER
  }), 'UAC_ALLOWLIST_UNAVAILABLE');

  assert.match(error.message, /could not be read: injected access denial/);
  assert.deepEqual(effects, [{
    kind: 'read', file: '/injected/unreadable-allowlist.json', encoding: 'utf8'
  }], 'an unavailable allowlist must cause no file write or process effect');
  console.log('OK: an injected allowlist read failure throws UAC_ALLOWLIST_UNAVAILABLE without writing or spawning');
})();

(() => {
  const allowlist = oneOperationAllowlist();

  const invalid = captureCode(
    () => uac.resolveOperation(allowlist, '../not-an-id'),
    'UAC_NOT_ALLOWED'
  );
  assert.match(invalid.message, /not a valid identifier/);

  const absent = captureCode(
    () => uac.resolveOperation(allowlist, 'valid-but-absent'),
    'UAC_NOT_ALLOWED'
  );
  assert.match(absent.message, /is not in the allowlist/);
  assert.deepEqual(absent.details, { operationId: 'valid-but-absent' });

  const auditEvents = [];
  let runs = 0;
  const result = uac.handleRequest({ suppliedToken: TOKEN, operationId: 'valid-but-absent' }, {
    expectedToken: TOKEN,
    allowlist,
    killSwitch: { status: () => ({ active: false }) },
    audit: {
      requireRecord(action, target, details) { auditEvents.push({ action, target, details }); },
      record() { assert.fail('a refusal must not write an outcome audit'); }
    },
    runOperation() { runs += 1; return { ok: true, steps: [] }; }
  });

  assert.deepEqual(result, {
    decision: 'refuse', reason: 'not-allowlisted', operationId: 'valid-but-absent'
  });
  assert.equal(runs, 0, 'a non-allowlisted operation must not be run or spawned');
  assert.equal(auditEvents.length, 1, 'the required refusal decision is the only write');
  assert.deepEqual(auditEvents[0].details, {
    schemaVersion: 1, decision: 'refuse', reason: 'not-allowlisted', tokenPresented: true
  });
  console.log('OK: invalid and absent operations throw UAC_NOT_ALLOWED; the driven request refuses without execution');
})();
