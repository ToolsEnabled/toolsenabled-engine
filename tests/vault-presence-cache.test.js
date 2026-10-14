'use strict';

// A DEFINITE PRESENCE ANSWER MAY BE REMEMBERED. AN UNCERTAIN ONE MAY NOT.
//
// vaultRecordPresence() spawns a full powershell.exe per call -- measured
// ~600-770 ms on the owner's machine. google-accounts.oauthKeysFor() asks twice
// per call (client id, client secret) and list() asks once per registered
// account, so one Google tool call or one system.status poll paid several of
// them back to back for an answer that could not have changed in between.
//
// The cache is keyed on the vault file's CONTENT digest, which is the same
// evidence readAnchor() already relies on for the protected head: a record
// cannot change without the file changing, because every write re-encrypts the
// whole file. What these cases pin is the asymmetry, because this module's
// entire reason for existing (see its header) is that failing to look is never
// an answer about the record:
//
//   * PRESENT and ABSENT are definite, and may be reused while the bytes hold.
//   * UNREADABLE, NO_STORE and platform-unsupported are "I could not tell".
//     Caching one would turn a transient failure into a durable claim.
//   * A digest that cannot be computed is UNKNOWN, not "unchanged" -- it must
//     disable the cache in both directions rather than serve a remembered answer.

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const presencePath = path.resolve(__dirname, '..', 'src', 'lib', 'vault-presence.js');
const runtimePath = path.resolve(__dirname, '..', 'src', 'lib', 'runtime.js');

let probes = 0;
let nextExit = 0;          // 0 PRESENT, 3 ABSENT, 4 UNREADABLE, 5 NO_STORE
let digest = 'a'.repeat(64);

const realLoad = Module._load;
Module._load = function mockPresenceDependencies(request, parent, isMain) {
  const from = parent && parent.filename;
  if (request === 'node:child_process' && from === presencePath) {
    return {
      ...realLoad(request, parent, isMain),
      execFileSync() {
        probes += 1;
        if (nextExit === 0) return '';
        throw Object.assign(new Error(`exit ${nextExit}`), { status: nextExit });
      }
    };
  }
  // vault-presence reads the digest through a LAZY require of ./runtime, so this
  // intercept has to answer for both the top-level rootPath destructure and the
  // per-call digest read.
  if ((request === './runtime' || request === runtimePath) && from === presencePath) {
    const real = realLoad(request, parent, isMain);
    return { ...real, vaultContentDigest: () => digest };
  }
  return realLoad(request, parent, isMain);
};

delete require.cache[presencePath];
const presence = require(presencePath);
// The mock stays installed for the whole run ON PURPOSE. vault-presence reads
// the digest through a LAZY require('./runtime') at CALL time, so restoring the
// real loader here would hand every check the real vault's digest -- which the
// running app rewrites every few seconds, silently invalidating the cache under
// the test and making it look like the cache does not work.

const { vaultRecordPresence, resetVaultPresenceCache } = presence;
const KEY = 'toolsenabled_probe_key_v1';

function fresh({ exit = 0, vaultDigest = 'a'.repeat(64) } = {}) {
  resetVaultPresenceCache();
  probes = 0;
  nextExit = exit;
  digest = vaultDigest;
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('a PRESENT answer is reused while the vault bytes are unchanged', () => {
  fresh({ exit: 0 });
  const first = vaultRecordPresence(KEY);
  assert.equal(first.present, true);
  assert.equal(probes, 1, 'the first look must really probe');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(vaultRecordPresence(KEY).present, true, 'the reused answer must be the same one');
  }
  assert.equal(probes, 1, `five repeats must not spawn again; saw ${probes}`);
});

check('an ABSENT answer is definite too, and is also reused', () => {
  fresh({ exit: 3 });
  assert.equal(vaultRecordPresence(KEY).present, false);
  assert.equal(vaultRecordPresence(KEY).present, false);
  assert.equal(probes, 1, 'a measured absence is an answer, not a failure to look');
});

check('a changed vault digest drops what was remembered', () => {
  fresh({ exit: 0 });
  assert.equal(vaultRecordPresence(KEY).present, true);
  assert.equal(probes, 1);
  digest = 'b'.repeat(64);           // the vault was rewritten
  nextExit = 3;                      // and the record is gone
  assert.equal(vaultRecordPresence(KEY).present, false,
    'a rewritten vault must never be answered from the previous bytes');
  assert.equal(probes, 2);
});

check('UNREADABLE is never remembered', () => {
  fresh({ exit: 4 });
  vaultRecordPresence(KEY);
  vaultRecordPresence(KEY);
  vaultRecordPresence(KEY);
  assert.equal(probes, 3,
    'could-not-tell must re-probe every time; caching it would turn a transient failure into a durable claim');
});

check('NO_STORE is never remembered', () => {
  fresh({ exit: 5 });
  vaultRecordPresence(KEY);
  vaultRecordPresence(KEY);
  assert.equal(probes, 2, 'no store yet is not an answer about this record');
});

check('an uncomputable digest disables the cache in both directions', () => {
  fresh({ exit: 0, vaultDigest: null });
  assert.equal(vaultRecordPresence(KEY).present, true);
  assert.equal(vaultRecordPresence(KEY).present, true);
  assert.equal(probes, 2,
    'a digest that could not be computed is unknown, never unchanged -- it must not serve or fill the cache');
});

check('a malformed digest is treated as uncomputable, not as a key', () => {
  fresh({ exit: 0, vaultDigest: 'not-a-sha256' });
  vaultRecordPresence(KEY);
  vaultRecordPresence(KEY);
  assert.equal(probes, 2, 'only a real 64-hex digest may key the cache');
});

check('keys do not share an answer', () => {
  fresh({ exit: 0 });
  assert.equal(vaultRecordPresence(KEY).present, true);
  nextExit = 3;
  assert.equal(vaultRecordPresence('toolsenabled_other_key_v1').present, false,
    'a second key must be probed on its own, not answered from the first');
  assert.equal(probes, 2);
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\nvault-presence-cache: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

Module._load = realLoad;
