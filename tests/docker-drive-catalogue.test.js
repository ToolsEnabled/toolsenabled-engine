#!/usr/bin/env node
'use strict';

// THE CATALOGUE IS A PROMISE, AND THIS IS THE GATE THAT KEEPS IT.
//
// tools/docker-drive.js publishes a list of what can and cannot be driven in a
// container. The list is only worth anything if two things stay true of every
// future edit to it:
//
//   1. EVERY entry carries a reason -- including the ones that CAN be driven.
//      A reason attached only to the failures is a list that rots: the day
//      someone flips an entry to drivable, the sentence explaining the
//      judgement disappears with it, and the next reader has to re-derive it.
//
//   2. An entry marked NOT drivable cannot be run by accident. The reason it
//      is not drivable is usually that running it would produce a NUMBER --
//      a container's cold-start latency, a vault probe that refuses -- and a
//      number that looks like a measurement is more dangerous than no
//      measurement at all.
//
// EVERY ASSERTION BELOW CALLS THE PUBLISHED SURFACE WITH VALUES. None of them
// reads tools/docker-drive.js as text, so a better implementation of the same
// promise still passes. None of them needs a Docker daemon: the refusal paths
// under test are reached before any daemon probe, which is itself part of the
// contract -- refusing a catalogued-impossible drive must not depend on
// whether Docker happens to be up.

const assert = require('node:assert/strict');
const drive = require('../tools/docker-drive.js');

let checks = 0;
const failures = [];

function check(name, run) {
  checks += 1;
  try {
    run();
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : error}`);
  }
}

check('the catalogue is non-empty and every id is unique', () => {
  assert.ok(Array.isArray(drive.DRIVES), 'DRIVES must be an array');
  assert.ok(drive.DRIVES.length > 0, 'the catalogue must not be empty');
  const ids = drive.DRIVES.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate drive ids: ${ids.join(', ')}`);
});

check('every entry names itself and its reason, drivable or not', () => {
  for (const entry of drive.DRIVES) {
    assert.equal(typeof entry.id, 'string', 'a drive must have a string id');
    assert.ok(entry.id.trim().length > 0, 'a drive id must not be blank');
    assert.equal(typeof entry.summary, 'string', `${entry.id}: summary must be a string`);
    assert.ok(entry.summary.trim().length > 0, `${entry.id}: summary must not be blank`);
    assert.equal(typeof entry.drivable, 'boolean', `${entry.id}: drivable must be an explicit boolean`);
    assert.equal(typeof entry.reason, 'string', `${entry.id}: reason must be a string`);
    // A reason short enough to be a label is not a reason. The threshold is
    // deliberately low -- it catches "n/a", "windows", "TODO", which is the
    // failure mode this is here for, and does not try to grade prose.
    assert.ok(entry.reason.trim().length >= 40,
      `${entry.id}: reason must actually explain the judgement, got ${JSON.stringify(entry.reason)}`);
  }
});

check('a drivable entry is runnable and a non-drivable entry has nothing to run', () => {
  for (const entry of drive.DRIVES) {
    if (entry.drivable) {
      const runnable = Array.isArray(entry.command) || entry.kind === 'surface';
      assert.ok(runnable, `${entry.id}: a drivable entry needs a command array or a known kind`);
      if (Array.isArray(entry.command)) {
        assert.ok(entry.command.length > 0, `${entry.id}: command must not be empty`);
        assert.ok(entry.command.every(part => typeof part === 'string' && part.length > 0),
          `${entry.id}: every command element must be a non-empty string`);
      }
      assert.equal(typeof entry.evidence, 'string', `${entry.id}: a drivable entry must name its evidence file`);
      assert.ok(entry.evidence.trim().length > 0, `${entry.id}: evidence filename must not be blank`);
    } else {
      assert.equal(entry.command, undefined,
        `${entry.id}: an entry marked not drivable must carry no command, or something will eventually run it`);
      assert.equal(entry.kind, undefined,
        `${entry.id}: an entry marked not drivable must carry no runnable kind`);
    }
  }
});

check('runDrive refuses a catalogued-impossible drive by name, and repeats the reason', () => {
  const blocked = drive.DRIVES.filter(entry => !entry.drivable);
  assert.ok(blocked.length > 0, 'the catalogue must record at least one thing a container cannot drive');
  for (const entry of blocked) {
    let raised = null;
    try {
      drive.runDrive(entry.id, { surfaces: ['docker'] });
    } catch (error) {
      raised = error;
    }
    assert.ok(raised, `${entry.id}: runDrive returned instead of refusing`);
    assert.ok(raised instanceof drive.DriveRefusal, `${entry.id}: refusal must be a DriveRefusal, got ${raised.name}`);
    assert.equal(raised.code, 'DRIVE_NOT_DRIVABLE_IN_CONTAINER', `${entry.id}: refusal code`);
    // The reason travels WITH the refusal. A caller that sees only a code has
    // to come back and read the catalogue to learn anything.
    assert.ok(raised.message.includes(entry.reason),
      `${entry.id}: the refusal must carry the catalogued reason, not just a code`);
  }
});

check('runDrive refuses an id the catalogue does not contain', () => {
  let raised = null;
  try {
    drive.runDrive('a-drive-that-was-never-catalogued', { surfaces: ['docker'] });
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, 'an unknown drive id must be refused');
  assert.equal(raised.code, 'DRIVE_UNKNOWN');
  // "unknown id" and "known but impossible" are different answers and must not
  // collapse into one code.
  assert.notEqual(raised.code, 'DRIVE_NOT_DRIVABLE_IN_CONTAINER');
});

check('the source tree is mounted read-only and the evidence sink is not', () => {
  const args = drive.mountArguments('/some/evidence/target');
  const mounts = args.filter((_, index) => args[index - 1] === '--mount');
  assert.ok(mounts.length >= 2, `expected at least two mounts, got ${JSON.stringify(args)}`);

  const source = mounts.find(mount => mount.includes('target=/src'));
  assert.ok(source, `no /src mount in ${JSON.stringify(mounts)}`);
  // THE ONE THAT MATTERS. Nine lanes hold uncommitted work in the checkout
  // this binds. If the readonly flag is ever dropped, a drive gains the
  // ability to write into somebody's only copy of their work, and nothing else
  // in this repository would notice.
  assert.ok(source.split(',').includes('readonly'),
    `the source bind must be read-only, got ${JSON.stringify(source)}`);

  const evidence = mounts.find(mount => mount.includes('target=/evidence'));
  assert.ok(evidence, `no /evidence mount in ${JSON.stringify(mounts)}`);
  assert.ok(!evidence.split(',').includes('readonly'),
    'the evidence sink must be writable or a drive cannot record what it saw');
});

check('the vault is catalogued as a product limit, not a harness gap', () => {
  // This entry exists because the distinction is the whole finding: 22 files
  // fail on Linux because src/lib/vault-platform.js pins the vault to win32,
  // and no container change can move that number. If someone ever flips this
  // to drivable without porting the vault, the drive would start reporting
  // refusals as results.
  const vault = drive.driveById('vault');
  assert.ok(vault, 'the catalogue must account for the vault');
  assert.equal(vault.drivable, false, 'the vault is not drivable on Linux while the product pins it to win32');
  assert.ok(vault.reason.includes('win32'),
    'the vault reason must name the platform the product actually supports');
});

if (failures.length) {
  process.stderr.write(`${failures.length} of ${checks} checks failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docker drive catalogue: ${checks} checks passed; `
    + `${drive.DRIVES.filter(entry => entry.drivable).length} drivable, `
    + `${drive.DRIVES.filter(entry => !entry.drivable).length} not drivable, every entry reasoned.\n`);
}
