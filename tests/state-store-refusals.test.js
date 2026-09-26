'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStateStore } = require('../src/lib/state-store');

function scratchStore(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `state-store-refusal-${name}-`));
  const file = path.join(directory, 'state.sqlite3');
  const store = createStateStore({ file });
  return { directory, file, store };
}

function expectCode(action, code) {
  assert.throws(action, error => {
    assert.equal(error.code, code);
    return true;
  });
}

// An unknown legacy approval token is a transactional refusal. It must not
// manufacture a grant, or consume/update any durable grant on the way out.
{
  const fixture = scratchStore('approval-not-found');
  try {
    expectCode(() => fixture.store.consumeApprovalGrant({
      action: 'host.exec',
      inputHash: 'a'.repeat(64),
      tokenHash: 'b'.repeat(64)
    }), 'APPROVAL_NOT_FOUND');
    const rows = fixture.store._read(db => db.prepare('SELECT * FROM approval_grants').all());
    assert.deepEqual(rows, []);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

const validRequest = {
  requestId: 'request-1234',
  taskId: 'task-1234',
  requestKind: 'tool',
  profileId: 'profile.test',
  profileVersion: 1,
  profileHash: 'c'.repeat(64),
  requestHash: 'd'.repeat(64),
  request: { tool: 'host.exec' },
  status: 'authorized'
};

// Request shape and size are rejected before a transaction is opened. Besides
// the typed code, pin that these refusals cannot even create the database.
{
  const fixture = scratchStore('request-invalid');
  try {
    expectCode(() => fixture.store.recordCapabilityProfileRequest({
      ...validRequest,
      requestKind: 'expansion'
    }), 'CAPABILITY_MANIFEST_REQUEST_INVALID');
    assert.equal(fs.existsSync(fixture.file), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

{
  const fixture = scratchStore('request-too-large');
  try {
    expectCode(() => fixture.store.recordCapabilityProfileRequest({
      ...validRequest,
      request: { payload: 'x'.repeat(33 * 1024) }
    }), 'CAPABILITY_MANIFEST_REQUEST_TOO_LARGE');
    assert.equal(fs.existsSync(fixture.file), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

process.stdout.write('state-store refusals: driven refusal checks passed\n');
