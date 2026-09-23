// EXECUTABLE CHANGE
// Report: testcanfail-tests-backup-duty-test-js
// SUSPECT: the four loops below used exported product collections as their
// iterables. Mutating all four collections to Object.freeze([]) left the
// original test GREEN: "passed 7". The independent inventory assertions below
// make those loops execute and preserve evidence for every promised exclusion.
//
// MUTATION: EXCLUDED_PATH_SEGMENTS -> Object.freeze([]).
// RED: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n+ []\n- [ 'credentials', ... ]" (exit 1).
// MUTATION: EXCLUDED_FILE_NAMES -> Object.freeze([]).
// RED: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n+ []\n- [ '.env', ... ]" (exit 1).
// MUTATION: EXCLUDED_EXTENSIONS -> Object.freeze([]).
// RED: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n+ []\n- [ '.key', '.kdbx', '.p12', '.pem', '.pfx' ]" (exit 1).
// MUTATION: SENSITIVE_CONTENT_MARKERS -> Object.freeze([]).
// RED: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n+ []\n- [ 'credential', 'password', 'passphrase', 'private key', 'authorization' ]" (exit 1).
// RESTORE: src/lib/backup-duty.js was restored byte-for-byte (SHA-256
// ce46062f18108bd2a27cfb8ed568be11e310458e2be652551a3f0fa656d06d75).
// GREEN: "passed 7".
// NOT-FOUND (2): no exit-status-only or truthy-return assertion.
// NOT-FOUND (3): no try/catch or optional chain swallows an expected failure.
// NOT-FOUND (4): no mock of the backup-duty subject.
// NOT-FOUND (5): no skip or platform precondition guard.
// NOT-FOUND (6): no expected value computed by the product code under test.
// UNMET PRECONDITIONS: none.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const duty = require('../src/lib/backup-duty.js');

let passed = 0;
let temporaryRoot = null;

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function write(root, relativePath, contents = 'safe fixture') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
}

function snapshotName(day, sequence = '010203') {
  return `snapshot-202608${String(day).padStart(2, '0')}T${sequence}Z`;
}

function sourceRoot(name) {
  const root = path.join(temporaryRoot, name, 'source');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function destinationRoot(name) {
  const root = path.join(temporaryRoot, name, 'destination');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function snapshotArtifactPaths(destination, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, name, 'manifest.json'), 'utf8'));
  return manifest.artifacts.map(artifact => artifact.path);
}

function run() {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-duty-test-'));
  process.stdout.write('backup-duty\n');

  try {
    check('is default-off and cannot register a scheduled task or write a backup', () => {
      const destination = destinationRoot('default-off');
      const runtimeRepository = path.join(temporaryRoot, 'runtime-repository');
      const resolvedDestination = duty.resolveManagedBackupDestination({ repoRoot: runtimeRepository });
      const dutySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'backup-duty.js'), 'utf8');
      const normalizedDutySource = dutySource.replace(/\//g, path.sep).toLowerCase();
      const personalPathPrefix = ['c:', 'users'].join(path.sep);

      assert.equal(resolvedDestination, path.join(runtimeRepository, 'state', 'backups'));
      assert.equal(duty.resolveManagedBackupDestination({
        repoRoot: runtimeRepository,
        stateRoot: path.join(temporaryRoot, 'outside-state')
      }), null);
      assert.equal(normalizedDutySource.includes(personalPathPrefix), false);
      assert.deepEqual(duty.BACKUP_DUTY_POLICY.destination, {
        kind: 'repository-state',
        stateDirectory: 'state',
        backupDirectory: 'backups',
        resolvedAtRuntime: true
      });
      const status = duty.runBackupDuty();
      assert.deepEqual(status, {
        schemaVersion: 1,
        kind: 'backup-duty',
        status: 'inactive',
        mode: 'default-off',
        writes: 0,
        scheduledTaskRegistered: false,
        productionActivation: 'owner-required'
      });
      assert.deepEqual(fs.readdirSync(destination), []);
      assert.equal(duty.writeTestOnlyBackup({ destinationRoot: destination }).status, 'refused');
    });

    check('includes only the deterministic, allowlisted source set', () => {
      const source = sourceRoot('inclusions');
      const destination = destinationRoot('inclusions');
      write(source, 'README.md', 'ordinary documentation');
      write(source, 'src/app.js', 'module.exports = true;');
      write(source, 'assets/image.png', 'not an allowlisted extension');
      const result = duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: snapshotName(1) });
      assert.equal(result.status, 'written');
      assert.equal(result.artifactCount, 2);
      assert.deepEqual(snapshotArtifactPaths(destination, snapshotName(1)), ['README.md', 'src/app.js']);
      assert.equal(result.integrity, 'verified');
    });

    check('proves every credential, vault, browser-profile, and session exclusion is not backed up', () => {
      const source = sourceRoot('exclusions');
      const destination = destinationRoot('exclusions');
      write(source, 'README.md', 'ordinary documentation');

      assert.deepEqual(duty.EXCLUDED_PATH_SEGMENTS, [
        'credentials',
        'secrets',
        'vault',
        'vaults',
        'profiles',
        'browser-profile',
        'chrome',
        'edge',
        'firefox',
        'sessions',
        'session-state',
        '.session'
      ]);
      assert.deepEqual(duty.EXCLUDED_FILE_NAMES, [
        '.env',
        '.env.local',
        'credentials.json',
        'secrets.json',
        'cookies',
        'login data',
        'local state',
        'web data',
        'session.json',
        'session-state.json'
      ]);
      assert.deepEqual(duty.EXCLUDED_EXTENSIONS, ['.key', '.kdbx', '.p12', '.pem', '.pfx']);
      assert.deepEqual(duty.SENSITIVE_CONTENT_MARKERS, [
        'credential',
        'password',
        'passphrase',
        'private key',
        'authorization'
      ]);

      for (const segment of duty.EXCLUDED_PATH_SEGMENTS) {
        const relativePath = `${segment}/safe.txt`;
        write(source, relativePath);
        assert.equal(duty.isExcludedRelativePath(relativePath), true, `segment ${segment}`);
      }
      for (const fileName of duty.EXCLUDED_FILE_NAMES) {
        const relativePath = `safe/${fileName}`;
        write(source, relativePath);
        assert.equal(duty.isExcludedRelativePath(relativePath), true, `file ${fileName}`);
      }
      for (const extension of duty.EXCLUDED_EXTENSIONS) {
        const relativePath = `safe/material${extension}`;
        write(source, relativePath);
        assert.equal(duty.isExcludedRelativePath(relativePath), true, `extension ${extension}`);
      }
      for (const marker of duty.SENSITIVE_CONTENT_MARKERS) {
        write(source, `safe/marked-${marker.replace(/\s+/g, '-')}.txt`, `contains ${marker} material`);
      }

      const result = duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: snapshotName(2) });
      assert.equal(result.status, 'written');
      assert.deepEqual(snapshotArtifactPaths(destination, snapshotName(2)), ['README.md']);
    });

    check('retention prunes only the oldest test snapshots after each verified write', () => {
      const source = sourceRoot('retention');
      const destination = destinationRoot('retention');
      write(source, 'README.md', 'ordinary documentation');
      for (const day of [3, 4, 5]) {
        const result = duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: snapshotName(day), maxSnapshots: 2 });
        assert.equal(result.status, 'written');
      }
      const retained = fs.readdirSync(destination).filter(name => name.startsWith('snapshot-')).sort();
      assert.deepEqual(retained, [snapshotName(4), snapshotName(5)]);
      assert.equal(fs.existsSync(path.join(destination, snapshotName(3))), false);
    });

    check('does not turn a busy-machine inspection failure into absent or corrupt', () => {
      const source = sourceRoot('inspection-unavailable');
      const destination = destinationRoot('inspection-unavailable');
      const name = snapshotName(6);
      write(source, 'README.md', 'ordinary documentation');
      assert.equal(duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: name }).status, 'written');

      // CONTROL: the established successful result remains repeatable; the
      // transient result below must not be cached or latched over it.
      assert.equal(duty.verifyWrittenBackup(destination, name).status, 'verified');
      const originalLstatSync = fs.lstatSync;
      for (const causeCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
        fs.lstatSync = function busyLstatSync() {
          const error = new Error('machine could not answer');
          error.code = causeCode;
          throw error;
        };
        try {
          assert.deepEqual(duty.verifyWrittenBackup(destination, name), {
            status: 'inspection-unavailable',
            verified: false,
            code: 'BACKUP_INSPECTION_UNAVAILABLE',
            causeCode,
            message: 'Backup inspection could not complete; this does not claim that the backup is absent.'
          });
        } finally {
          fs.lstatSync = originalLstatSync;
        }
      }
      assert.equal(duty.verifyWrittenBackup(destination, name).status, 'verified');
    });

    check('retention refuses a relative escape or symlinked snapshot before deleting anything', () => {
      const source = sourceRoot('retention-containment');
      const destination = destinationRoot('retention-containment');
      const escapedDestination = path.join(path.dirname(destination), 'escaped-destination');
      const externalTarget = path.join(temporaryRoot, 'external-retention-target');
      write(source, 'README.md', 'ordinary documentation');
      fs.mkdirSync(escapedDestination, { recursive: true });
      fs.mkdirSync(path.join(escapedDestination, snapshotName(8)), { recursive: true });
      write(escapedDestination, `${snapshotName(8)}/keep.md`, 'must remain');

      assert.equal(duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: snapshotName(10), maxSnapshots: 7 }).status, 'written');
      assert.equal(duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: snapshotName(11), maxSnapshots: 7 }).status, 'written');
      assert.deepEqual(duty.pruneTestOnlyRetention({
        destinationRoot: path.join(destination, '..', 'escaped-destination'),
        managedDestinationRoot: destination,
        maxSnapshots: 1
      }), { status: 'refused', removed: 0 });
      assert.equal(fs.existsSync(path.join(escapedDestination, snapshotName(8), 'keep.md')), true);

      fs.mkdirSync(externalTarget, { recursive: true });
      write(externalTarget, 'keep.md', 'must remain');
      const linkedSnapshot = path.join(destination, snapshotName(9));
      fs.symlinkSync(externalTarget, linkedSnapshot, 'junction');
      assert.equal(fs.lstatSync(linkedSnapshot).isSymbolicLink(), true);
      assert.deepEqual(duty.pruneTestOnlyRetention({
        destinationRoot: destination,
        managedDestinationRoot: destination,
        maxSnapshots: 1
      }), { status: 'refused', removed: 0 });
      assert.equal(fs.existsSync(path.join(destination, snapshotName(10))), true);
      assert.equal(fs.existsSync(path.join(destination, snapshotName(11))), true);
      assert.equal(fs.existsSync(path.join(externalTarget, 'keep.md')), true);
    });

    check('integrity verification catches a corrupted written artifact', () => {
      const source = sourceRoot('integrity');
      const destination = destinationRoot('integrity');
      write(source, 'README.md', 'ordinary documentation');
      const name = snapshotName(6);
      assert.equal(duty.writeTestOnlyBackup({ testOnly: true, sourceRoot: source, destinationRoot: destination, snapshotName: name }).status, 'written');
      fs.writeFileSync(path.join(destination, name, 'README.md'), 'changed fixture', 'utf8');
      assert.deepEqual(duty.verifyWrittenBackup(destination, name), { status: 'integrity-failed', verified: false });
    });

    check('test-only fixture writes refuse any source or destination outside the temporary directory', () => {
      const source = sourceRoot('outside-refusal');
      write(source, 'README.md', 'ordinary documentation');
      const result = duty.writeTestOnlyBackup({
        testOnly: true,
        sourceRoot: source,
        destinationRoot: path.resolve(process.cwd(), 'not-a-test-backup-destination'),
        snapshotName: snapshotName(7)
      });
      assert.deepEqual(result, { status: 'refused', written: false });
      assert.deepEqual(duty.writeTestOnlyBackup({
        testOnly: true,
        sourceRoot: source,
        destinationRoot: destinationRoot('traversal-refusal'),
        snapshotName: `../${snapshotName(7)}`
      }), { status: 'refused', written: false });
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  process.stdout.write(`passed ${passed}\n`);
}

run();
