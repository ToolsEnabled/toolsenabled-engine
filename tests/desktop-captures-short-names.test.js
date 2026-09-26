'use strict';
/* AN 8.3 SHORT NAME IS THE SAME CAPTURES DIRECTORY, SPELLED SHORTER.
 *
 * src/lib/desktop.js's resolveCaptureInput() compared the caller's path
 * against rootPath('captures') LEXICALLY (path.relative / path.dirname on
 * plain strings). rootPath('captures') resolves TOOLSENABLED_STATE_ROOT
 * through account-profile-boundary.js, which -- since
 * tests/account-fence-short-names.test.js -- canonicalizes an 8.3 short name
 * to its long form. A caller's own path built from that same environment
 * variable (the shell sets it under the account's %TEMP%; this test's own
 * os.tmpdir() reproduces the identical alias) is not: it stayed the short
 * spelling. Two spellings of the identical directory then compared as
 * unequal text.
 *
 * MEASURED, capability/logs/actions.jsonl: agent_comms and workstation.status
 * traffic on this installation shows %TEMP% and TOOLSENABLED_STATE_ROOT
 * resolving through this same short form; tests/uncoded-refusals-carry-codes
 * .test.js's OCR case reproduced it directly -- staging a real file inside
 * the real captures directory and reading it back was refused
 * "path must identify a file inside the ToolsEnabled captures directory.",
 * an untrue fault, since the path named exactly that file. The refusal never
 * reached tools/desktop.ps1 or the OCR_LANGUAGE_PACK_MISSING translation
 * that test exists to pin; the fence itself was the wrong answer.
 *
 * THE HALF THAT MATTERS MORE, and half of this file: canonicalizing must not
 * turn the fence into a rubber stamp. A path that is really outside the
 * captures directory, or really nested inside it, must still be refused --
 * mirroring account-fence-short-names.test.js's own "what must still be
 * refused" half for the sibling account-boundary bug.
 *
 * This file never enumerates or touches another profile; every path below is
 * created fresh under this process's own scratch temp directory.
 *
 *   node --test tests/desktop-captures-short-names.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Scratch state root BEFORE the first product require, so nothing reads or
// writes the real installation's state (the 2026-08-16 76-entry leak rule).
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-captures-short-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const desktop = require('../src/lib/desktop');
const runtime = require('../src/lib/runtime');

test('desktop worker keeps the caller responsive during blocking capture work and preserves refusals', async () => {
  const fixture = path.join(SCRATCH, 'blocking-desktop-worker.cjs');
  fs.writeFileSync(fixture, `const {parentPort}=require('node:worker_threads'); let sequence=0;
parentPort.on('message', m=>{ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,350);
if(m.args.refuse)parentPort.postMessage({id:m.id,error:{code:'DESKTOP_CLEANUP_FAILED',message:'fixture cleanup refused',actionOutcome:'may_have_completed'}});
else parentPort.postMessage({id:m.id,result:{sequence:++sequence}}); });\n`);
  const client = desktop.createDesktopWorkerClient({ workerFile: fixture });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    const results = await Promise.all([client.run('screenCaptureWindow'), client.run('screenCaptureWindow')]);
    assert.deepEqual(results, [{ sequence: 1 }, { sequence: 2 }]);
    assert.ok(ticks >= 10, 'the UI thread must tick throughout the real worker blocking spans');
    await assert.rejects(client.run('screenCaptureWindow', { refuse: true }),
      error => error.code === 'DESKTOP_CLEANUP_FAILED' && error.actionOutcome === 'may_have_completed');
    await assert.rejects(client.run('windowClose'), error => error.code === 'DESKTOP_WORKER_OPERATION_INVALID');
  } finally { clearInterval(timer); await client.close(); }
});

test('the real desktop worker retains the capture path fence before any helper can run', async () => {
  const client = desktop.createDesktopWorkerClient();
  try {
    await assert.rejects(client.run('readCapture', { path: path.join(SCRATCH, 'outside.png') }),
      error => error.code === 'CAPTURE_PATH_INVALID');
  } finally { await client.close(); }
});

const onWindows = process.platform === 'win32';

// The RAW spelling: built directly from the environment variable string, the
// way a caller assembling its own path -- or the test that first caught this
// -- would. The PRODUCT's own spelling: rootPath('captures'), which is what
// resolveCaptureInput compares against.
const rawCapturesDir = onWindows ? path.join(process.env.TOOLSENABLED_STATE_ROOT, 'captures') : null;
const productCapturesDir = onWindows ? runtime.rootPath('captures') : null;

/* The precondition this file rests on: the two spellings really do disagree
 * as text on this host. If a future Windows or harness stops handing out an
 * 8.3 alias under %TEMP%, this file is not wrong -- it is simply no longer
 * exercising the bug (the same honest precondition
 * tests/account-fence-short-names.test.js checks for the sibling defect). */
const reproducesShortName = onWindows
  && path.resolve(rawCapturesDir).toLowerCase() !== path.resolve(productCapturesDir).toLowerCase();

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function stagePng(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(target, PNG_BYTES);
  return target;
}

test('a capture named through the short-name spelling of the captures directory is read, not refused',
  { skip: !reproducesShortName }, () => {
    const staged = stagePng(rawCapturesDir, 'short-name-probe.png');
    let sawInvoke = false;
    const result = desktop.ocrRead({ path: staged }, {
      invoke: () => {
        sawInvoke = true;
        return { stdout: JSON.stringify({ text: 'hello from ocr', language: 'en-US' }) };
      }
    });
    assert.ok(sawInvoke, 'a genuinely contained file must reach the OCR helper, not stop at the fence');
    assert.equal(result.text, 'hello from ocr');
    assert.equal(result.language, 'en-US');
    assert.equal(path.resolve(result.path), path.resolve(staged), 'the returned path still identifies the file the caller named');
  });

test('the OCR helper\'s own refusal still reaches the caller through the short-name spelling',
  { skip: !reproducesShortName }, () => {
    // The same fence, the OTHER refusal: proves the fix repairs the fence
    // itself rather than only the one scenario
    // tests/uncoded-refusals-carry-codes.test.js happens to exercise.
    const staged = stagePng(rawCapturesDir, 'short-name-probe-2.png');
    assert.throws(() => desktop.ocrRead({ path: staged }, {
      invoke: () => { throw new Error('Windows OCR is unavailable because no OCR language is installed for this profile.'); }
    }), error => {
      assert.equal(error.code, 'OCR_LANGUAGE_PACK_MISSING');
      assert.match(error.message, /no OCR language is installed/);
      return true;
    });
  });

test('a path genuinely outside the captures directory is still refused', { skip: !onWindows }, () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-captures-outside-'));
  const staged = stagePng(outsideDir, 'elsewhere.png');
  assert.throws(
    () => desktop.ocrRead({ path: staged }, { invoke: () => { throw new Error('must not be reached'); } }),
    error => error.code === 'CAPTURE_PATH_INVALID'
      && /inside the ToolsEnabled captures directory/.test(error.message),
    'canonicalizing the comparison must not admit a file that is really elsewhere',
  );
});

test('a capture nested in a subdirectory is still refused as not a direct child',
  { skip: !reproducesShortName }, () => {
    // The direct-child guard -- desktop.js's own comment: "otherwise a caller
    // could use the OCR helper as an arbitrary local-image reader by planting
    // a reparse point under captures/" -- is the OTHER check this fix moved
    // onto the canonical form. Prove it still refuses a nested file, addressed
    // through the very same short-name spelling the top-level file above is
    // now correctly accepted through.
    const staged = stagePng(path.join(rawCapturesDir, 'nested'), 'nested-probe.png');
    assert.throws(
      () => desktop.ocrRead({ path: staged }, { invoke: () => { throw new Error('must not be reached'); } }),
      error => error.code === 'CAPTURE_PATH_INVALID' && /direct capture file/.test(error.message),
      'a nested file must still be refused once the comparison is canonical',
    );
  });
