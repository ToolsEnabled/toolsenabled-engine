/*
 * Mutation: removed `...previous,` from the module's `record` object.
 * Landed: yes; the edited module no longer copied existing registry fields.
 * Result: RED; this file exited 1 when `$comment` became undefined.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MAX_NAME_LENGTH, addAccount } = require('../../../src/lib/multi-account/registry-write.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-write-firsttest2-'));
const registryPath = path.join(root, 'config', 'accounts.json');
const homesRoot = path.join(root, 'homes');

try {
  assert.equal(MAX_NAME_LENGTH, 64);

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, `${JSON.stringify({
    $comment: 'preserve fields the writer does not interpret',
    accounts: [{
      name: 'existing',
      provider: 'codex',
      profileDir: path.join(homesRoot, 'existing'),
      priority: 7,
      role: 'primary'
    }]
  }, null, 2)}\n`);

  const added = addAccount({
    name: '  new account  ',
    provider: 'codex',
    configPath: registryPath,
    homesRoot,
    randomUUID: () => 'fixed-test-id',
    pid: 123,
    // Synthetic pid, paired with a non-default isAlive: this is the documented
    // compatibility seam in agent-digest/lock.js's identityContext() ("Existing
    // tests/callers which deliberately inject synthetic PIDs retain their
    // legacy liveness seam"). Without it, addAccount()'s default lockIsAlive
    // (the real pidAlive) sends this fake pid through EXACT identity
    // verification, which shells out to look up a real process 123 and throws
    // AGENT_DIGEST_PROCESS_IDENTITY_UNVERIFIED -- not a registry defect, a
    // fixture gap against a lock module that gained exact-identity checking
    // after this test was written.
    lockIsAlive: () => false
  });

  assert.deepEqual(added, {
    name: 'new account',
    provider: 'codex',
    home: path.join(homesRoot, 'new account'),
    homeEnv: 'CODEX_HOME',
    // addAccount() always says expectEmail back, explicit null when none was
    // asked for -- "so a caller can show whether the identity check is on for
    // this entry ... Null is 'no check was asked for', never 'the check
    // failed to record'" (registry-write.js). Only the WRITTEN record omits
    // the field when absent; this in-memory return value is a different
    // contract, deliberately.
    expectEmail: null,
    // The app made this home, so removing the account later may destroy it.
    homeCreatedByApp: true,
    registryPath
  });
  assert.equal(Object.isFrozen(added), true);
  assert.deepEqual(fs.readdirSync(added.home), []);

  const written = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(written.$comment, 'preserve fields the writer does not interpret');
  // 1.0.50: the switching priority is retired, so it is dropped on save; every
  // field the writer does not interpret (role here) is kept.
  assert.deepEqual(written.accounts[0], {
    name: 'existing',
    provider: 'codex',
    profileDir: path.join(homesRoot, 'existing'),
    role: 'primary'
  });
  assert.deepEqual(written.accounts[1], {
    name: 'new account',
    provider: 'codex',
    profileDir: path.join(homesRoot, 'new account'),
    homeCreatedByApp: true
  });

  process.stdout.write('ok - addAccount preserves existing data and writes no retired switching priority\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
