'use strict';

// D3b, THE READ-VS-EGRESS ASYMMETRY. host.read_file's gate
// (isCredentialProtectedPath in src/lib/providers/host-control.js) is the OR of
// EXCLUDED_PATH_PATTERNS, COMMON_CREDENTIAL_STORE_PATTERN and
// isProtectedEnvironmentPath. Neither of the first two carries pem/key/p12/pfx,
// and COMMON_CREDENTIAL_STORE_PATTERN is PATH-shaped: it matches credential
// DIRECTORIES and a few conventional basenames, not credential-shaped file
// names sitting in an ordinary folder.
//
// Measured at base 80f08ecb before any edit, comparing the two sinks' name
// patterns directly:
//
//   NAME                     EGRESS-blocks READGATE-blocks
//   private_key.pem          false         false
//   password.pem             false         false
//   access_key.p12           false         false
//   service_account.pfx      false         false
//   keystore.p12             false         false
//   wallet.key               false         false
//
// So at THIS base private_key.pem is refused by neither sink. (The sibling
// unmerged commit 92a70fcf closes the egress half for these stems and says in
// its own message that it deliberately does not widen host-control's narrower
// extension list -- which is where the read-vs-egress asymmetry comes from once
// it lands. It is not on this base, so here the file is simply readable.)
//
// This asserts BEHAVIOUR through the real exported readFile() against real files
// in an ordinary folder inside the owner profile, never against a regex. A
// better pattern spelling passes; only a readable credential-shaped file fails.
//
// R1191: "The cut must carefully make sure my private info does not make it out
// period."
//
// NO CREDENTIAL VALUE APPEARS HERE. Every fixture's CONTENT is the literal
// string below; only the NAME is credential-shaped, because the name is the
// entire subject of the gate under test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hostControl = require('../src/lib/providers/host-control.js');
const { HOME, readFile } = hostControl;

// Not a credential. The gate under test reads the NAME; these bytes exist only
// so a file that is NOT refused can be proven actually readable.
const FIXTURE_CONTENT = 'not-a-credential: fixture bytes for the host-control name gate';

// readFile() records an audit admission before it reads. Inject it: a gate test
// must not write rows into the live signed ledger, and a ledger that was
// momentarily unavailable would otherwise look like a refusal and turn this
// whole file into a false GREEN.
const NO_AUDIT = { requireRecordAsync: async () => undefined };

// The four CLEAN stem groups, each crossed with the pem/key/p12/pfx tail that
// egress already carries and this gate did not.
const MUST_BE_REFUSED = Object.freeze([
  // password / passwd / passphrase
  'password.pem', 'passwd.key', 'passphrase.p12', '.password.json',
  // (access|refresh|bearer) + key/token -- the *_key half
  'access_key.p12', 'refresh_token.pem', 'bearer-key.pfx',
  // private_key / service_account
  'private_key.pem', 'service_account.pfx', 'private-key.key',
  // keystore / kdbx / wallet
  'keystore.p12', 'wallet.key', 'kdbx.pem'
]);

// Near-misses. A blanket refusal is not a safer refusal: each of these is an
// ordinary file a person or a tool legitimately reads, and each shares a prefix
// with a stem above. If the gate swallows these, the fix is wrong.
const MUST_STAY_READABLE = Object.freeze([
  'walletbuilder.pem', 'walletbuilder.json',
  'passenger.pem', 'passenger.json',
  'keyboard.pem', 'keyboard.json',
  'accessibility.pem', 'accessibility.json',
  'service.pem', 'service.json',
  'notes.txt', 'report.pem'
]);

let checks = 0;
const checkAsync = async (label, fn) => {
  try { await fn(); }
  catch (error) {
    error.message = `[${label}] ${error.message}`;
    throw error;
  }
  checks += 1;
};

// readFile validates synchronously but resolves asynchronously, so a refusal can
// arrive either as a synchronous throw or as a rejection. Collapse both.
async function readOutcome(target) {
  try {
    const result = await readFile({ path: target }, NO_AUDIT);
    return { ok: true, content: result.content };
  } catch (error) {
    return { ok: false, error };
  }
}

async function main() {
  // An ORDINARY folder inside the owner profile tree: not .ssh, not vault, not
  // a state directory, nothing any existing EXCLUDED_PATH_PATTERNS entry
  // catches on the directory alone. That is the point: the refusal has to come
  // from the file's NAME.
  const folder = fs.mkdtempSync(path.join(HOME, 'ordinary-folder-'));
  try {
    await checkAsync('premise: an ordinary file in this folder is readable', async () => {
      // Guard the premise rather than assume it. If this folder were itself
      // credential-protected, or admission were refusing, every "refused"
      // below would be vacuously true and this file would be a false GREEN.
      const canary = path.join(folder, 'plain-canary.txt');
      fs.writeFileSync(canary, FIXTURE_CONTENT);
      const outcome = await readOutcome(canary);
      assert.ok(outcome.ok,
        `the folder itself must be ordinary, or every refusal below is vacuous; got ${outcome.error && outcome.error.code}`);
      assert.ok(outcome.content.includes('not-a-credential'), 'the canary must read back its own bytes');
    });

    await checkAsync('credential-shaped names with the pem/key/p12/pfx tail are refused by host.read_file', async () => {
      for (const name of MUST_BE_REFUSED) {
        const target = path.join(folder, name);
        fs.writeFileSync(target, FIXTURE_CONTENT);
        const outcome = await readOutcome(target);
        assert.equal(outcome.ok, false, `${name}: must NOT be readable through host.read_file`);
        // It must be refused BY THE CREDENTIAL FENCE, not incidentally by
        // ENOENT, size or containment -- which would pass for the wrong reason.
        assert.equal(outcome.error.code, 'HOST_PATH_FORBIDDEN',
          `${name}: must be refused by the credential fence; got ${outcome.error.code}`);
      }
    });

    await checkAsync('near-miss ordinary names stay readable -- a blanket refusal is not a safer refusal', async () => {
      for (const name of MUST_STAY_READABLE) {
        const target = path.join(folder, name);
        fs.writeFileSync(target, FIXTURE_CONTENT);
        const outcome = await readOutcome(target);
        assert.ok(outcome.ok,
          `${name}: an ordinary file must stay readable; it was refused with ${outcome.error && outcome.error.code}`);
      }
    });

    await checkAsync('the gate reads the NAME, not the folder', async () => {
      // COMMON_CREDENTIAL_STORE_PATTERN is path-shaped, so a name-shaped gap
      // could be masked by a directory that happens to match. Nest one level
      // deeper under a differently-named ordinary folder and re-measure.
      const nested = fs.mkdtempSync(path.join(folder, 'project-'));
      const plain = path.join(nested, 'readme.txt');
      fs.writeFileSync(plain, FIXTURE_CONTENT);
      assert.ok((await readOutcome(plain)).ok, 'premise: the nested folder must itself be ordinary');

      const target = path.join(nested, 'private_key.pem');
      fs.writeFileSync(target, FIXTURE_CONTENT);
      const outcome = await readOutcome(target);
      assert.equal(outcome.ok, false, 'private_key.pem must not be readable from a nested ordinary folder either');
      assert.equal(outcome.error.code, 'HOST_PATH_FORBIDDEN',
        `nested private_key.pem must be refused by the credential fence; got ${outcome.error.code}`);
    });

    await checkAsync('the near-miss controls are not credential-shaped at the egress sink either', () => {
      // Parity is the point of the port, so measure it rather than read it off
      // the diff. This asserts nothing about the three COLLIDE groups, which
      // stay deliberately unported at BOTH sinks.
      const egress = require('../src/lib/egress-preflight.js');
      for (const name of MUST_STAY_READABLE) {
        assert.equal(egress.CREDENTIAL_NAME_PATTERN.test(name), false,
          `${name}: near-miss control must not be credential-shaped at the egress sink either`);
      }
    });

    console.log(`Host-control credential name gate tests passed (${checks} checks; `
      + `${MUST_BE_REFUSED.length} refused, ${MUST_STAY_READABLE.length} near-miss controls readable).`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
