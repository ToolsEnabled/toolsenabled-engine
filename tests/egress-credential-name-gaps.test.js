'use strict';

// FOUR CREDENTIAL-SHAPED FILENAMES THAT NOTHING REFUSED.
//
// Worker 14 wrote this file as RED-ONLY EVIDENCE (engine commit 648b953c, on
// test/containment-name-gaps-d9b44f96-20260907) comparing the live lineage
// against the sibling unmerged commit a099930, which had independently fixed
// the same defect with a different, non-overlapping set of credential-name
// rules. In that form it printed four RED lines and exited 1 ON PURPOSE: it
// was proof a gap existed, not a guard that it stays closed.
//
// This is the port. The same four cases, now asserted the other way round:
// each of the four names must be REFUSED, and the file fails if any of them is
// let through again. The four "collide" rows from the same delta report
// (extensionless credentials/secrets, the id_rsa family, and stem-agnostic
// .pem/.jks/.kdbx/.ppk) are NOT ported and NOT asserted here in either
// direction -- they need a shape change to the mandatory-extension rule rather
// than a stem, that change widens refusals for every caller of preflight(),
// and it remains an owner decision. Asserting they stay allowed would be worse
// than leaving them alone: it would make the eventual owner decision arrive as
// a failing test.
//
// Both sinks are covered, because they are two different boundaries for the
// same class of file and egress-preflight.js's own comment says it mirrors the
// other one:
//   * preflight() in src/lib/egress-preflight.js -- the entry point
//     tool-registry.js's assertEgressPreflight() calls before every
//     outward-write tool, checked on the FILENAME alone.
//   * resolveHostPath() in src/lib/providers/host-control.js -- the containment
//     check every host.read_file / host.write_file / host.list_dir call passes
//     through, checked on the PATH.
//
// The negative controls at the bottom are not decoration. A rule that refuses
// every filename would satisfy every assertion above them and destroy the
// surface; they are what makes the refusals above mean something.
//
//   node tests\run-isolated.js tests/egress-credential-name-gaps.test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { preflight } = require('../src/lib/egress-preflight');
const { resolveHostPath, HOME } = require('../src/lib/providers/host-control');

// The four CLEAN-ADD rows. Each `why` is the shape a099930's own rule named.
const PORTED = [
  { label: 'password/passwd/passphrase stem', filePath: 'password.json' },
  { label: 'passphrase, the same stem group', filePath: 'passphrase.yaml' },
  { label: '*_key completion (access_key, not *_token)', filePath: 'access_key.json' },
  { label: 'refresh_key, the same completion', filePath: 'refresh-key.json' },
  { label: 'private_key / service_account stem', filePath: 'service_account.json' },
  { label: 'private_key, the same stem group', filePath: 'private_key.pem' },
  { label: 'keystore/kdbx/wallet stem', filePath: 'wallet.json' },
  { label: 'keystore, the same stem group', filePath: 'keystore.json' }
];

// Names that must STILL be sendable and still readable. If a widened rule
// starts refusing these, the fix has quietly turned a targeted refusal into a
// blanket one and taken the surface with it.
const ORDINARY = [
  'notes.json',
  'report.yaml',
  'passenger-manifest.json',
  'keyboard-layout.json',
  'walletbuilder.json',
  'accessibility.json',
  'service.json',
  'index.json'
];

test('the four ported credential names are refused before they leave the machine', () => {
  for (const { label, filePath } of PORTED) {
    const result = preflight({ filePath });
    assert.equal(result.allowed, false,
      `${label}: preflight let ${filePath} through -- summary was ${JSON.stringify(result.summary)}`);
    assert.ok(result.findings.some(finding => finding.code === 'CREDENTIAL_SHAPED_NAME'),
      `${label}: ${filePath} was refused, but not as a credential-shaped name: ${JSON.stringify(result.findings)}`);
  }
});

/* host-control.js's COMMON_CREDENTIAL_STORE_PATTERN carries a NARROWER
   extension list than egress-preflight.js's: it has no pem/key/p12/pfx. That
   difference is pre-existing and was deliberately left alone by this port,
   which adds stems only -- widening that list is a shape change, and a shape
   change to this pattern changes what host.read_file and host.list_dir refuse
   for every caller. So `private_key.pem` is covered on the egress side above
   and is knowingly NOT covered here; see the report for it named as a
   remaining owner decision rather than quietly closed. */
const PORTED_FOR_HOST = PORTED.filter(({ filePath }) => !filePath.endsWith('.pem'));

test('the four ported credential names are refused by host containment too', () => {
  for (const { label, filePath } of PORTED_FOR_HOST) {
    // Relative to the owner profile root, which is what resolveHostPath
    // anchors on; no file needs to exist for the name check to run.
    const candidate = path.join('c2-credential-name-probe', filePath);
    assert.throws(() => resolveHostPath(candidate), error => {
      assert.equal(error.code, 'HOST_PATH_FORBIDDEN',
        `${label}: ${filePath} was refused by host containment, but for the wrong reason (${error.code})`);
      return true;
    }, `${label}: host containment allowed ${filePath}`);
  }
});

test('ordinary filenames are still allowed by both sinks', () => {
  /* The negative control for both tests above. Several of these are deliberate
     near-misses -- "passenger", "keyboard", "walletbuilder", "accessibility",
     "service" -- because a stem added without a boundary check would swallow
     them, and a rule that refuses ordinary work is not a safer rule, it is a
     broken surface that someone will then be tempted to switch off. */
  for (const filePath of ORDINARY) {
    const result = preflight({ filePath });
    assert.equal(result.allowed, true,
      `${filePath} is an ordinary artifact and must still be sendable; findings: ${JSON.stringify(result.findings)}`);

    const candidate = path.join('c2-credential-name-probe', filePath);
    assert.equal(path.isAbsolute(resolveHostPath(candidate)), true,
      `${filePath} is an ordinary artifact and must still resolve under ${path.basename(HOME)}`);
  }
});
