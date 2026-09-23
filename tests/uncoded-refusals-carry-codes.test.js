// EXECUTABLE CHANGE
//
// CAN-FAIL REPORT (2026-08-26)
// Suspect: the TERRAFORM_CLI_MISSING assertion was behind a live-CLI guard;
// when terraform was installed, the assertion never executed. The test now
// loads the provider against a deterministic unavailable-command boundary and
// always exercises the product refusal.
// Mutation: in src/lib/providers/infrastructure.js, temporarily changed the
// generated missing-CLI code suffix from `_CLI_MISSING` to `_CLI_OTHER`.
// RED: "FAIL: an absent terraform CLI refuses with TERRAFORM_CLI_MISSING
//   Expected values to be strictly equal:
//   + actual - expected
//   + 'TERRAFORM_CLI_OTHER'
//   - 'TERRAFORM_CLI_MISSING'".
// Restoration: src/lib/providers/infrastructure.js was restored byte-for-byte;
// `node tests/uncoded-refusals-carry-codes.test.js` returned "all checks passed".
// NOT-FOUND: empty loop/forEach assertion collections; exit-status or truthy-
// return-only assertions; swallowed failures via try/catch or optional chains;
// assertions against a mock of the behavior under test; expected values
// computed by the same product code. Preconditions not met: none.

'use strict';

// THE NINE REFUSALS THAT SPOKE ONLY PROSE, MEASURED 2026-08-19.
//
// The 272-tool sweep found nine tool rows whose refusal carried a perfectly
// human sentence and NO machine code: ocr.read (no Windows OCR language pack),
// gcloud.account_inspect (unknown Google account), terraform.validate
// (terraform not installed), extension.validate and extension.package
// (manifest.json absent), gmail.list / calendar.list / drive.find (no Google
// account registered), billing.webhook_verify (unparseable Stripe signature
// header) -- plus, at Guided, the screen.read_capture/ocr.read captures-fence
// refusal. A model cannot branch on a sentence, and item 1's taxonomy cannot
// classify what has no code, so every one of these read as an unnamed failure.
//
// This suite pins the throw sites: each refusal keeps its sentence and now
// carries its named code, following each module's own sibling convention
// (error.code set at the throw, as cli-provider-gateway.js and
// provider-safety.safeError already do). The codes are composed from
// condition phrases the taxonomy ladder understands, so
// tests/error-taxonomy-refusal-rescue.test.js proves their classification and
// this file proves the sites emit them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Scratch state root BEFORE the first require, so nothing reads or writes the
// real installation's state (the 2026-08-16 76-entry leak rule).
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'uncoded-refusals-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const desktop = require('../src/lib/desktop');
const googleAccounts = require('../src/lib/google-accounts');
const billing = require('../src/lib/providers/billing');
const extension = require('../src/lib/providers/extension');

// Keep the availability boundary deterministic without changing PATH, command
// resolution, or spawning a real terraform process. The stand-in is only for
// the environmental command-presence query; requireCommand remains the real
// product behavior under test.
const runtimePath = require.resolve('../src/lib/runtime');
const infrastructurePath = require.resolve('../src/lib/providers/infrastructure');
const runtime = require(runtimePath);
const originalCommandExists = runtime.commandExists;
let infrastructure;
try {
  runtime.commandExists = command => command === 'terraform' ? false : originalCommandExists(command);
  delete require.cache[infrastructurePath];
  infrastructure = require(infrastructurePath);
} finally {
  runtime.commandExists = originalCommandExists;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); }
  catch (error) {
    failures += 1;
    console.error(`  FAIL: ${label}\n    ${error.message}`);
  }
}

function thrown(fn) {
  try { fn(); }
  catch (error) { return error; }
  return null;
}

console.log('uncoded refusals now carry their named codes');

// --- the captures fence (guided screen.read_capture / ocr.read) -------------
check('a path outside the captures directory refuses with CAPTURE_PATH_INVALID', () => {
  const error = thrown(() => desktop.ocrRead({ path: path.resolve(__dirname, '..', 'README.md') }));
  assert.ok(error, 'the fence must refuse');
  assert.equal(error.code, 'CAPTURE_PATH_INVALID');
  assert.match(error.message, /captures directory|image file/);
});

check('an empty capture path refuses with CAPTURE_PATH_INVALID', () => {
  const error = thrown(() => desktop.ocrRead({ path: '' }));
  assert.ok(error, 'the fence must refuse');
  assert.equal(error.code, 'CAPTURE_PATH_INVALID');
});

// --- ocr.read with no Windows OCR language pack ------------------------------
check('the helper\'s no-OCR-language refusal is translated to OCR_LANGUAGE_PACK_MISSING', () => {
  // The captures fence runs first, so stage a real file inside the captures
  // directory of the scratch state root, then inject the helper failure the
  // sweep measured -- the fixed sentence tools/desktop.ps1 line ~653 throws.
  const capturesDir = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'captures');
  fs.mkdirSync(capturesDir, { recursive: true });
  const staged = path.join(capturesDir, 'probe.png');
  fs.writeFileSync(staged, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const error = thrown(() => desktop.ocrRead({ path: staged }, {
    invoke: () => { throw new Error('Windows OCR is unavailable because no OCR language is installed for this profile.'); }
  }));
  assert.ok(error, 'the injected helper failure must surface');
  assert.equal(error.code, 'OCR_LANGUAGE_PACK_MISSING');
  assert.match(error.message, /no OCR language is installed/);
});

check('an unrelated helper failure keeps its own shape (no blanket translation)', () => {
  const capturesDir = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'captures');
  const staged = path.join(capturesDir, 'probe.png');
  const error = thrown(() => desktop.ocrRead({ path: staged }, {
    invoke: () => { throw new Error('desktop ocr failed for another reason'); }
  }));
  assert.ok(error);
  assert.notEqual(error.code, 'OCR_LANGUAGE_PACK_MISSING');
});

// --- the Google account registry (gmail/calendar/drive + gcloud) -------------
check('an empty registry with no selector refuses with GOOGLE_ACCOUNT_NOT_CONFIGURED', () => {
  const error = thrown(() => googleAccounts.resolve());
  assert.ok(error, 'no accounts are registered on the scratch root, so resolve must refuse');
  assert.equal(error.code, 'GOOGLE_ACCOUNT_NOT_CONFIGURED');
  assert.match(error.message, /No Google accounts are registered/);
});

check('an unknown selector refuses with GOOGLE_ACCOUNT_NOT_FOUND', () => {
  const error = thrown(() => googleAccounts.resolve('sweep-probe@example.com'));
  assert.ok(error);
  assert.equal(error.code, 'GOOGLE_ACCOUNT_NOT_FOUND');
  assert.match(error.message, /Unknown Google account/);
});

// --- the Stripe webhook signature header -------------------------------------
check('an unparseable Stripe signature header refuses with BILLING_WEBHOOK_SIGNATURE_INVALID', () => {
  const error = thrown(() => billing.webhookVerify(
    { payload: '{}', signatureHeader: 't=1,v1=00', vaultKey: 'stripe_webhook_secret' },
    { now: () => 1000, getSecret: () => 'whsec_test', record: () => {} }
  ));
  assert.ok(error);
  assert.equal(error.code, 'BILLING_WEBHOOK_SIGNATURE_INVALID');
});

check('a well-formed header with a wrong signature refuses with BILLING_WEBHOOK_SIGNATURE_INVALID', () => {
  const error = thrown(() => billing.webhookVerify(
    { payload: '{}', signatureHeader: `t=1,v1=${'0'.repeat(64)}`, vaultKey: 'stripe_webhook_secret' },
    { now: () => 1000, getSecret: () => 'whsec_test', record: () => {} }
  ));
  assert.ok(error);
  assert.equal(error.code, 'BILLING_WEBHOOK_SIGNATURE_INVALID');
});

check('a stale Stripe webhook timestamp refuses with BILLING_WEBHOOK_TIMESTAMP_INVALID', () => {
  const error = thrown(() => billing.webhookVerify(
    { payload: '{}', signatureHeader: `t=1,v1=${'0'.repeat(64)}`, vaultKey: 'stripe_webhook_secret', toleranceSeconds: 5 },
    { now: () => 10_000_000_000_000, getSecret: () => 'whsec_test', record: () => {} }
  ));
  assert.ok(error);
  assert.equal(error.code, 'BILLING_WEBHOOK_TIMESTAMP_INVALID');
});

// --- the extension manifest ---------------------------------------------------
check('a directory without manifest.json refuses with EXTENSION_MANIFEST_NOT_FOUND', () => {
  const empty = path.join(SCRATCH, 'no-manifest-here');
  fs.mkdirSync(empty, { recursive: true });
  const error = thrown(() => extension.validation({ cwd: empty }));
  assert.ok(error);
  assert.equal(error.code, 'EXTENSION_MANIFEST_NOT_FOUND');
  assert.match(error.message, /manifest\.json was not found/);
});

// --- the infrastructure CLIs --------------------------------------------------
// gcloud shares the identical requireCommand site, so one driven refusal
// covers the class; no gcloud call is attempted, because with a live
// authenticated gcloud even a "probe" of a mutating entry point would act on
// the real cloud account.
check('an absent terraform CLI refuses with TERRAFORM_CLI_MISSING', () => {
  const error = thrown(() => infrastructure.terraformValidate({ cwd: SCRATCH }));
  assert.ok(error, 'the deterministic unavailable-command boundary must refuse');
  assert.match(error.message, /terraform is unavailable\. Install it/);
  assert.equal(error.code, 'TERRAFORM_CLI_MISSING');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
