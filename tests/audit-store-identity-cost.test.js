'use strict';

// THE STORE IDENTITY IS TAKEN EIGHT TIMES PER RECORD. IT MAY NOT BE EXPENSIVE.
//
// _storeIdentity() resolves the ledger's real path, and _verificationFingerprint()
// takes a store identity every time it runs: to verify, to compare the state
// before a decision against the state after it, and to advance the verification
// cache. One audit record reaches it roughly eight times, and a consequential
// tool call records twice.
//
// fs.realpathSync is a JavaScript walk that lstat()s every component of the
// path; fs.realpathSync.native asks the operating system once. MEASURED
// 2026-09-03 on the owner's machine against the live ledger path: 0.62 ms
// against 0.12 ms, returning the identical string -- about 4.4 ms per record
// for nothing.
//
// This pins the cheap resolver, and pins the two properties that make it a
// cost change and not a behaviour change: the identity it produces is the same
// one, and a filesystem that cannot answer still fails closed. The
// could-not-look case itself lives in tests/kernel.audit/audit-store.js, which
// injects its fault by replacing fs.realpathSync outright -- which is why the
// resolver is read at call time rather than captured when this module loads.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuditStore } = require('../src/lib/audit-store');

function fixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-identity-${label}-`));
  return { directory, file: path.join(directory, 'audit.sqlite3') };
}

function cleanup(test) {
  fs.rmSync(test.directory, { recursive: true, force: true });
}

const external = witness => ({ version: 1, cacheable: true, witness });

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('resolving the ledger identity uses the native resolver, not the component walk', () => {
  const test = fixture('native');
  const store = createAuditStore({ file: test.file });
  const realJs = fs.realpathSync;
  const realNative = fs.realpathSync.native;
  let jsCalls = 0;
  let nativeCalls = 0;
  try {
    const countingJs = (...args) => { jsCalls += 1; return realJs(...args); };
    countingJs.native = (...args) => { nativeCalls += 1; return realNative(...args); };
    fs.realpathSync = countingJs;

    // Distinct witnesses so each call is a genuine fingerprint computation and
    // not a cache hit that never reaches the identity at all.
    for (let i = 0; i < 4; i += 1) {
      assert.equal(store.verifyWithEvents({ external: external(`w${i}`) }).verification.valid, true);
    }
  } finally {
    fs.realpathSync = realJs;
    store.close();
  }
  try {
    assert.ok(nativeCalls > 0,
      'the identity must be resolved through fs.realpathSync.native');
    assert.equal(jsCalls, 0,
      `the JavaScript component walk must not be used at all; it ran ${jsCalls} times`);
  } finally { cleanup(test); }
});

check('the two resolvers name the same file, and the identity is stable', () => {
  const test = fixture('same');
  const store = createAuditStore({ file: test.file });
  try {
    // The STRINGS may differ: on Windows the component walk leaves an 8.3
    // short name in place (%TEMP% under this account resolves through
    // TOOLSE~2) and the native call expands it. What must hold is that they
    // name the same file, because that is the thing the identity witnesses.
    const walked = fs.statSync(fs.realpathSync(test.file));
    const native = fs.statSync(fs.realpathSync.native(test.file));
    assert.equal(native.ino, walked.ino, 'both resolvers must reach the same inode');
    assert.equal(native.dev, walked.dev, 'on the same device');

    // And the identity must be stable call to call, or the verification cache
    // could never hit -- which is how a resolver that answered inconsistently
    // would show up here rather than as silent extra cost.
    assert.equal(store.verifyWithEvents({ external: external('a') }).verification.valid, true);
    assert.equal(store.verifyWithEvents({ external: external('a') }).verification.valid, true);
    assert.equal(store.verificationCacheStatus().cacheHits, 1,
      'an identity that changed between two identical calls would break the cache outright');
  } finally { store.close(); cleanup(test); }
});

check('a resolver that cannot answer still fails closed', () => {
  const test = fixture('closed');
  const store = createAuditStore({ file: test.file });
  const realJs = fs.realpathSync;
  const realNative = fs.realpathSync.native;
  try {
    assert.equal(store.verifyWithEvents({ external: external('control') }).verification.valid, true,
      'control: the identity is inspectable before the fault is injected');
    const failing = () => { const error = new Error('file table is busy'); error.code = 'EMFILE'; throw error; };
    failing.native = failing;
    fs.realpathSync = failing;
    assert.throws(() => store.verifyWithEvents({ external: external('after') }), error =>
      error && error.code === 'AUDIT_STORE_IDENTITY_UNAVAILABLE'
        && error.details && error.details.systemCode === 'EMFILE',
      'a resource failure must refuse, not guess an identity');
    assert.equal(store.verificationCacheStatus().cached, false,
      'and it must drop any trust it had already latched');
  } finally {
    fs.realpathSync = realJs;
    fs.realpathSync.native = realNative;
    store.close();
    cleanup(test);
  }
});

assert.ok(checks.length >= 3, 'expected every store-identity cost case to be registered');

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-store-identity-cost: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
