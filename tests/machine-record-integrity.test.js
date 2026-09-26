// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-machine-record-integrity-test-js):
// - STRENGTHENED: the fail-closed test's catch previously accepted every read
//   failure. Mutation: changed the tamper refusal code in machine-record.js from
//   SETUP_MACHINE_RECORD_TAMPERED to MUTANT_UNRELATED_READ_FAILURE. Before this
//   assertion the focused mutant run stayed green: "ok 1 - a tampered record
//   leaves the caller with the narrowest surface, not the widest". After the
//   assertion it went red: "Expected values to be strictly equal:" followed by
//   "+ actual - expected", "+ 'MUTANT_UNRELATED_READ_FAILURE'", and
//   "- 'SETUP_MACHINE_RECORD_TAMPERED'".
// - NOT-FOUND (empty iteration): the only generated cases iterate a non-empty
//   in-file literal; no assertion depends on a product-supplied collection
//   having an element.
// - NOT-FOUND (exit/truthy-only evidence): this file spawns no process and
//   makes no exit-status assertion.
// - NOT-FOUND (mock of subject): the injected reader test supplies only input
//   text; every asserted machine-record operation remains the real subject.
// - NOT-FOUND (skip/platform guard): this file contains no skip or precondition
//   guard.
// - NOT-FOUND (same-code expected value): expected verdicts, refusal codes,
//   tiers, and filesystem effects are literal independent expectations. The
//   policy surface comparison is additionally pinned by the literal host.exec
//   exclusion and the named unrestricted-spawn refusal.
// - RESTORED: machine-record.js was restored byte-for-byte (SHA-256
//   1decb56b86923f98a1cc390a350f74c569af89b59c38765c8eff323185b88a59).
//   The complete restored-file run was green: "# pass 16" and "# fail 0".
// - PRECONDITION: the default Node v20.20.2 lacks node:sqlite, so mutation and
//   confirmation runs used the installed Node v22.22.2 required by package.json.

'use strict';

// THE RECORDED PERMISSION LEVEL MUST NOT BE A ONE-TOKEN EDIT.
//
// Measured on the packaged payload before this existed: rewriting `"tier":
// "guided"` to `"tier": "unrestricted"` in %LOCALAPPDATA%\ToolsEnabled\machine.json
// took the resolved tool surface from 102 of 262 to 262 of 262 and flipped
// assertUnrestrictedSpawn from refused to allowed. validateMachineRecord
// accepted the rewrite, because it checked shape and nothing else.
//
// These tests pin the mechanism AND its stated limits. The limits matter as
// much as the mechanism: this is tamper EVIDENCE on a zero-UAC install, so the
// forgery case and the downgrade case are asserted to behave as documented
// rather than left for a reader to assume they are prevented.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const machineRecord = require('../src/lib/setup/machine-record');
const permissionTierPolicy = require('../src/lib/permission-tier-policy');

function withInstall(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-record-integrity-'));
  const servicesRoot = path.join(root, 'ToolsEnabled');
  fs.mkdirSync(servicesRoot, { recursive: true });
  try {
    return run({
      servicesRoot,
      recordFile: machineRecord.machineRecordPath(servicesRoot),
      keyFile: machineRecord.machineRecordKeyPath(servicesRoot),
      build: (tier = 'guided') => machineRecord.buildMachineRecord({
        tier,
        installRoot: path.join(root, 'Programs', 'toolsenabled'),
        servicesRoot,
        nodePath: process.execPath,
        workspaceRoots: [path.join(root, 'Workspace')]
      })
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readRaw(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeRaw(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

test('a written record is sealed, and reads back', () => {
  withInstall(({ servicesRoot, recordFile, keyFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    assert.ok(fs.existsSync(keyFile), 'writing a record creates the installation key');

    const onDisk = readRaw(recordFile);
    assert.equal(typeof onDisk.integrity, 'object');
    assert.match(onDisk.integrity.mac, /^[0-9a-f]{64}$/);

    assert.deepEqual(
      machineRecord.verifyMachineRecordIntegrity(onDisk, { servicesRoot }),
      { ok: true, state: 'sealed', reason: null }
    );
    assert.equal(machineRecord.readMachineRecord({ servicesRoot }).tier, 'guided');
  });
});

// THE DEFECT ITSELF. This is the exact edit that escalated before.
test('editing the tier is detected and refused by name', () => {
  withInstall(({ servicesRoot, recordFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });

    const tampered = readRaw(recordFile);
    tampered.tier = 'unrestricted';
    writeRaw(recordFile, tampered);

    const verdict = machineRecord.verifyMachineRecordIntegrity(tampered, { servicesRoot });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.state, 'tampered');

    assert.throws(
      () => machineRecord.readMachineRecord({ servicesRoot }),
      error => error.code === 'SETUP_MACHINE_RECORD_TAMPERED'
    );
  });
});

// The MAC covers the whole record, so a field added later is covered without
// anyone remembering to add it to a list.
for (const [label, mutate] of [
  ['workspaceRoots', record => { record.workspaceRoots = ['C:\\']; }],
  ['nodePath', record => { record.nodePath = 'C:\\attacker\\node.exe'; }],
  ['installRoot', record => { record.installRoot = 'C:\\attacker'; }],
  ['machine.label', record => { record.machine.label = 'other'; }],
  ['a key added after the fact', record => { record.somethingNew = true; }]
]) {
  test(`editing ${label} is detected`, () => {
    withInstall(({ servicesRoot, recordFile, build }) => {
      machineRecord.writeMachineRecord(build('standard'), { servicesRoot });
      const tampered = readRaw(recordFile);
      mutate(tampered);
      writeRaw(recordFile, tampered);
      assert.equal(machineRecord.verifyMachineRecordIntegrity(tampered, { servicesRoot }).state, 'tampered');
    });
  });
}

test('stripping the seal while the key remains is tampering, not a legacy record', () => {
  withInstall(({ servicesRoot, recordFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    const stripped = readRaw(recordFile);
    delete stripped.integrity;
    stripped.tier = 'unrestricted';
    writeRaw(recordFile, stripped);

    assert.throws(
      () => machineRecord.readMachineRecord({ servicesRoot }),
      error => error.code === 'SETUP_MACHINE_RECORD_TAMPERED'
    );
  });
});

test('truncating the key file does not re-open the adoption path', () => {
  withInstall(({ servicesRoot, recordFile, keyFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    fs.writeFileSync(keyFile, '', 'utf8');
    const widened = readRaw(recordFile);
    widened.tier = 'unrestricted';
    writeRaw(recordFile, widened);

    assert.throws(
      () => machineRecord.readMachineRecord({ servicesRoot }),
      error => error.code === 'SETUP_MACHINE_RECORD_TAMPERED'
    );
  });
});

test('a key from a different installation does not verify', () => {
  withInstall(({ servicesRoot, recordFile, keyFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`, 'utf8');
    assert.equal(machineRecord.verifyMachineRecordIntegrity(readRaw(recordFile), { servicesRoot }).state, 'tampered');
  });
});

// FAIL CLOSED IS THE WHOLE POINT: a broken seal must NARROW the surface, and
// this asserts it against the real policy rather than trusting the refusal.
test('a tampered record leaves the caller with the narrowest surface, not the widest', () => {
  withInstall(({ servicesRoot, recordFile, build }) => {
    const registry = require('../src/lib/tool-registry').registeredTools();
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });

    const widened = readRaw(recordFile);
    widened.tier = 'unrestricted';
    writeRaw(recordFile, widened);

    // Exactly what every consumer does: read, and fall closed on a throw.
    let session;
    let readError;
    try {
      const record = machineRecord.readMachineRecord({ servicesRoot });
      session = permissionTierPolicy.installTierSessionFromRecord(record);
    } catch (error) {
      readError = error;
      session = permissionTierPolicy.installTierSession('guided');
    }

    assert.equal(readError?.code, 'SETUP_MACHINE_RECORD_TAMPERED');
    const surface = permissionTierPolicy.allowedToolNames(registry, session);
    const full = permissionTierPolicy.installTierToolNames(registry, 'unrestricted');
    assert.ok(surface.length < full.length, 'the forged tier must not resolve to the full surface');
    assert.ok(!surface.includes('host.exec'), 'a forged record must not gain host.exec');
    assert.throws(
      () => permissionTierPolicy.assertUnrestrictedSpawn(session),
      error => error.code === 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED'
    );
  });
});

// --- the documented limits, asserted so they cannot be quietly assumed away ---

test('an install predating this mechanism is adopted rather than refused', () => {
  withInstall(({ servicesRoot, recordFile, keyFile, build }) => {
    writeRaw(recordFile, build('standard'));       // legacy shape: no integrity
    assert.equal(fs.existsSync(keyFile), false);

    const record = machineRecord.readMachineRecord({ servicesRoot });
    assert.equal(record.tier, 'standard', 'a legacy install keeps working');
    assert.ok(fs.existsSync(keyFile), 'first read starts the evidence');
    assert.ok(readRaw(recordFile).integrity, 'and seals the record in place');

    // Now sealed, the same edit is caught.
    const widened = readRaw(recordFile);
    widened.tier = 'unrestricted';
    writeRaw(recordFile, widened);
    assert.throws(
      () => machineRecord.readMachineRecord({ servicesRoot }),
      error => error.code === 'SETUP_MACHINE_RECORD_TAMPERED'
    );
  });
});

test('DOCUMENTED LIMIT: deleting both the key and the seal downgrades to adoption', () => {
  // Asserted, not hidden. This is the residual an attacker who knows the
  // mechanism can reach on a zero-UAC install, and the module comment says so.
  // If someone later believes this is prevented, this test tells them it is not.
  withInstall(({ servicesRoot, recordFile, keyFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    fs.rmSync(keyFile);
    const widened = readRaw(recordFile);
    delete widened.integrity;
    widened.tier = 'unrestricted';
    writeRaw(recordFile, widened);

    assert.equal(machineRecord.readMachineRecord({ servicesRoot }).tier, 'unrestricted');
  });
});

test('DOCUMENTED LIMIT: a same-user forgery verifies', () => {
  // The key is readable by the user, so a forged MAC is computable. Stated in
  // the module and asserted here so the mechanism is never over-read as proof.
  withInstall(({ servicesRoot, recordFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    const forged = machineRecord.sealMachineRecord({ ...readRaw(recordFile), tier: 'unrestricted' }, { servicesRoot });
    writeRaw(recordFile, forged);
    assert.equal(machineRecord.readMachineRecord({ servicesRoot }).tier, 'unrestricted');
  });
});

test('adoption never writes through an injected reader', () => {
  // The existing suites validate fabricated text against fabricated paths. That
  // must not create keys in directories nobody asked us to touch.
  withInstall(({ servicesRoot, keyFile, build }) => {
    const text = `${JSON.stringify(build('guided'), null, 2)}\n`;
    const record = machineRecord.readMachineRecord({ servicesRoot, readFile: () => text });
    assert.equal(record.tier, 'guided');
    assert.equal(fs.existsSync(keyFile), false);
  });
});

test('key order and re-serialisation do not break a seal', () => {
  withInstall(({ servicesRoot, recordFile, build }) => {
    machineRecord.writeMachineRecord(build('guided'), { servicesRoot });
    const onDisk = readRaw(recordFile);
    const reordered = Object.keys(onDisk).sort().reverse()
      .reduce((accumulator, key) => { accumulator[key] = onDisk[key]; return accumulator; }, {});
    assert.equal(machineRecord.verifyMachineRecordIntegrity(reordered, { servicesRoot }).ok, true);
  });
});
