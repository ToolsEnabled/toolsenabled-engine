// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-secrets-vault-write-visibility-js):
// - EMPTY ITERATION: strengthened the vault-directory leak check to prove that
//   it inspected at least one file, and strengthened the access-log field
//   allowlist check to prove that it inspected at least one log line.
// - MUTATION/RED RUN: NOT RUN. The required `powershell.exe` product runtime is
//   absent in this Linux container, so the unmodified baseline is already red:
//   "FAIL set-stdin logs the FIRST write of a key, and says nothing was
//   replaced: set-stdin failed: spawnSync powershell.exe ENOENT". This names
//   the unmet precondition rather than claiming mutation evidence that this
//   platform cannot produce. No product file was modified.
// - RESTORED/GREEN RUN: NOT RUN for the same named precondition.
// - EXIT-STATUS-ONLY: NOT-FOUND. Successful statuses are followed by assertions
//   on product log output; the refused status is likewise followed by an exact
//   assertion on the newly written product log line.
// - SWALLOWED FAILURE / OPTIONAL CHAIN: NOT-FOUND in assertions. The JSON parse
//   fallback remains observable as an unexpected field, and log truncation's
//   missing-file case is an intentional setup condition.
// - MOCK OF SUBJECT: NOT-FOUND.
// - SKIP / PRECONDITION GUARD: NOT-FOUND.
// - EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND.

'use strict';

// THE OTHER HALF OF THE ACCESS LOG: WRITES.
//
// tests/secrets/payment-card-vault-safety.js proves that every action which
// READS, OPENS or DESTROYS a vault record leaves an access-log line. This file
// is the measurement of the opposite direction, and it exists because the
// posture was inverted: 'get', 'list', 'exists', 'present', 'verify' and 'del'
// all left a line, and the verbs that REPLACE a record left nothing at all.
//
// Why that ordering is backwards. A read of a secret is recoverable -- the
// owner still has the record, and the log says who looked. An overwrite is
// not: the previous bytes are gone, and before this change nothing anywhere
// recorded that they had ever been swapped. `secrets.ps1 set-stdin
// payment_card_default` could replace the owner's real card with any value at
// all and leave the vault looking exactly as legitimate as before, while
// merely LOOKING at the same record was audited. So the invisible action was
// the destructive one.
//
// WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT.
//   * every mutating action writes a line naming the action and the key
//   * that line carries `replaced`, so an OVERWRITE of an existing record is
//     distinguishable from a first write of a new key -- the single fact that
//     makes a silent swap visible after the event
//   * the line is written even when the mutation is later REFUSED
//     (set-monotonic-stdin moving backward), because a refused attempt to fork
//     the audit anchor is the case most worth having on record
//   * no spelling of the value ever appears in the log. The needle here is the
//     PUBLISHED STRIPE TEST PAN and nothing else -- it is not a card, it
//     authorises nothing, and it exists so the leak hunt has a known needle.
//     No real card number may ever be written into this file.
//
// The vault under test is the ISOLATED scratch vault: tests/lib/isolated-
// environment points TOOLSENABLED_VAULT_PATH at a temp file and tools/
// secrets.ps1 reads that variable first. Nothing here touches, reads, decrypts
// or deletes the real vault, and no check in this file asks whether the real
// `payment_card_default` exists.

require('../lib/isolated-environment').activate('vault-write-visibility');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SECRETS_SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'secrets.ps1');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;
const VAULT_DIR = path.dirname(VAULT_FILE);
const ACCESS_LOG = `${VAULT_FILE}.access.log`;

// Published Stripe test PAN. See the header: this is the needle, not a card.
const TEST_PAN = '4242424242424242';
const CARD_KEY = 'payment_card_default';
const PLAIN_KEY = 'write_visibility_probe';

const NEEDLES = [
  { label: 'digits', bytes: Buffer.from(TEST_PAN, 'utf8') },
  { label: 'digits-utf16le', bytes: Buffer.from(TEST_PAN, 'utf16le') },
  { label: 'spaced', bytes: Buffer.from('4242 4242 4242 4242', 'utf8') },
  { label: 'hyphenated', bytes: Buffer.from('4242-4242-4242-4242', 'utf8') }
];

let passed = 0;
const failures = [];
function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

// Quiet-desktop rule (STANDING-ORDERS LOCAL-WORK rule 3): every powershell
// spawn here is windowsHide + shell:false, so no console ever flashes.
// ELECTRON_RUN_AS_NODE is stripped for the same reason every other harness in
// this tree strips it: it is set in this environment and silently changes what
// a child process is.
function vault(args, options = {}) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SECRETS_SCRIPT, ...args
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: environment
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    spawnError: result.error ? result.error.message : null
  };
}

function accessLogLines() {
  if (!fs.existsSync(ACCESS_LOG)) return [];
  return fs.readFileSync(ACCESS_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { unparsable: true, raw: line }; }
  });
}

function truncateAccessLog() {
  try { fs.writeFileSync(ACCESS_LOG, ''); } catch { /* not yet created */ }
}

/** The lines this action wrote about this key since the log was last cleared. */
function linesFor(action, key) {
  return accessLogLines().filter(line => line.action === action && line.key === key);
}

function needleHits(buffer) {
  return NEEDLES.filter(needle => buffer.includes(needle.bytes)).map(needle => needle.label);
}

/* ---------------------------------------------------------------------------
   1. THE VERB THE OWNER NAMED: set-stdin.
   --------------------------------------------------------------------------- */

check('set-stdin logs the FIRST write of a key, and says nothing was replaced', () => {
  truncateAccessLog();
  const result = vault(['set-stdin', PLAIN_KEY], { input: 'first-value' });
  assert.equal(result.status, 0, `set-stdin failed: ${result.stderr || result.spawnError}`);
  const lines = linesFor('set-stdin', PLAIN_KEY);
  assert.equal(lines.length, 1, `expected exactly one set-stdin line, got ${lines.length}`);
  assert.equal(lines[0].replaced, false, 'a first write must record replaced:false');
  assert.equal(typeof lines[0].ts, 'string', 'the line must carry a timestamp');
  assert.equal(typeof lines[0].pid, 'number', 'the line must carry the writing process id');
});

check('set-stdin OVER an existing record records replaced:true', () => {
  truncateAccessLog();
  const result = vault(['set-stdin', PLAIN_KEY], { input: 'second-value' });
  assert.equal(result.status, 0, `set-stdin failed: ${result.stderr || result.spawnError}`);
  const lines = linesFor('set-stdin', PLAIN_KEY);
  assert.equal(lines.length, 1, `expected exactly one set-stdin line, got ${lines.length}`);
  assert.equal(lines[0].replaced, true,
    'an overwrite recorded as replaced:false is the silent overwrite this check exists to catch');
});

/* THE CASE THE OWNER DESCRIBED, WORD FOR WORD: the card record replaced through
   the generic write verb. `payment_card_default` is on $VaultOracleDenylist, so
   it cannot be READ back through 'get' -- which is exactly why a silent write
   was so hard to notice. The value written here is a test PAN inside a record
   shaped like the real one; nothing decrypts it and nothing reads it back. */
check('replacing the CARD record through set-stdin is no longer silent', () => {
  vault(['set-stdin', CARD_KEY], { input: JSON.stringify({ version: 2, cardNumber: TEST_PAN }) });
  truncateAccessLog();
  const result = vault(['set-stdin', CARD_KEY], { input: JSON.stringify({ version: 2, cardNumber: TEST_PAN }) });
  assert.equal(result.status, 0, `set-stdin failed: ${result.stderr || result.spawnError}`);
  const lines = linesFor('set-stdin', CARD_KEY);
  assert.equal(lines.length, 1, 'the card record was overwritten with no access-log line');
  assert.equal(lines[0].replaced, true, 'the overwrite of an existing card must record replaced:true');
});

/* ---------------------------------------------------------------------------
   2. EVERY OTHER MUTATION, SO THE NEXT ONE CANNOT BE THE SILENT ONE.
   --------------------------------------------------------------------------- */

check('set-pair-stdin logs one line per key, not one per call', () => {
  truncateAccessLog();
  const payload = JSON.stringify({
    first: { key: 'write_visibility_pair_a', value: 'a' },
    second: { key: 'write_visibility_pair_b', value: 'b' }
  });
  const result = vault(['set-pair-stdin'], { input: payload });
  assert.equal(result.status, 0, `set-pair-stdin failed: ${result.stderr || result.spawnError}`);
  assert.equal(linesFor('set-pair-stdin', 'write_visibility_pair_a').length, 1, 'no line for the first key');
  assert.equal(linesFor('set-pair-stdin', 'write_visibility_pair_b').length, 1, 'no line for the second key');
});

check('set-triple-stdin logs all three keys', () => {
  truncateAccessLog();
  const payload = JSON.stringify({
    first: { key: 'write_visibility_triple_a', value: 'a' },
    second: { key: 'write_visibility_triple_b', value: 'b' },
    third: { key: 'write_visibility_triple_c', value: 'c' }
  });
  const result = vault(['set-triple-stdin'], { input: payload });
  assert.equal(result.status, 0, `set-triple-stdin failed: ${result.stderr || result.spawnError}`);
  for (const suffix of ['a', 'b', 'c']) {
    assert.equal(linesFor('set-triple-stdin', `write_visibility_triple_${suffix}`).length, 1,
      `no line for write_visibility_triple_${suffix}`);
  }
});

check('get-or-create-stdin distinguishes the create it did from the read it did', () => {
  truncateAccessLog();
  const created = vault(['get-or-create-stdin', 'write_visibility_goc'], { input: 'candidate-one' });
  assert.equal(created.status, 0, `get-or-create-stdin failed: ${created.stderr || created.spawnError}`);
  const createLines = linesFor('get-or-create-stdin', 'write_visibility_goc');
  assert.equal(createLines.length, 1, 'the create branch left no line');
  assert.equal(createLines[0].present, false, 'the create branch must record present:false');
  assert.equal(createLines[0].replaced, false, 'the create branch must record replaced:false');

  truncateAccessLog();
  const read = vault(['get-or-create-stdin', 'write_visibility_goc'], { input: 'candidate-two' });
  assert.equal(read.status, 0, `get-or-create-stdin failed: ${read.stderr || read.spawnError}`);
  const readLines = linesFor('get-or-create-stdin', 'write_visibility_goc');
  assert.equal(readLines.length, 1, 'the read branch left no line -- it decrypts and returns a secret');
  assert.equal(readLines[0].present, true, 'the read branch must record present:true');
  assert.ok(!('replaced' in readLines[0]),
    'the read branch must not carry `replaced`, or it is indistinguishable from a create');
});

check('set-monotonic-stdin logs a REFUSED advance, not only an accepted one', () => {
  const key = 'write_visibility_anchor';
  const at = (sequence) => JSON.stringify({ sequence, head: `h${sequence}` });
  const ahead = vault(['set-monotonic-stdin', key, '-Sequence', '2'], { input: at(2) });
  assert.equal(ahead.status, 0, `set-monotonic-stdin failed: ${ahead.stderr || ahead.spawnError}`);

  truncateAccessLog();
  const backward = vault(['set-monotonic-stdin', key, '-Sequence', '1'], { input: at(1) });
  assert.notEqual(backward.status, 0, 'moving the anchor backward must still be refused');
  const lines = linesFor('set-monotonic-stdin', key);
  assert.equal(lines.length, 1, 'a refused anchor move left no trace -- the case most worth recording');
  assert.equal(lines[0].replaced, true, 'the refused move was against an existing anchor');
});

/* ---------------------------------------------------------------------------
   3. THE LOG MUST NOT BECOME THE LEAK.
   --------------------------------------------------------------------------- */

check('no spelling of the value reaches the access log', () => {
  const hits = needleHits(fs.readFileSync(ACCESS_LOG));
  assert.deepEqual(hits, [], `access log leaked the value as: ${hits.join(', ')}`);
});

check('no spelling of the value reaches any other file in the vault directory', () => {
  const leaked = [];
  let inspected = 0;
  for (const entry of fs.readdirSync(VAULT_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    inspected += 1;
    const full = path.join(VAULT_DIR, entry.name);
    // The vault file itself holds DPAPI ciphertext; a hit THERE would mean the
    // record was stored in the clear, which is the same defect by another name.
    const hits = needleHits(fs.readFileSync(full));
    if (hits.length) leaked.push(`${entry.name} (${hits.join(', ')})`);
  }
  assert.ok(inspected > 0, 'plaintext leak check did not inspect any vault-directory files');
  assert.deepEqual(leaked, [], `plaintext value found in: ${leaked.join('; ')}`);
});

check('a write line carries no value, length, hash or preview field', () => {
  // An allowlist, not a denylist: a future field that describes the VALUE must
  // fail this check by default rather than pass because nobody thought to ban
  // its name.
  const allowed = new Set(['ts', 'pid', 'action', 'key', 'resultCount', 'denied', 'present', 'replaced', 'unreadable']);
  const unexpected = new Set();
  const lines = accessLogLines();
  assert.ok(lines.length > 0, 'field allowlist check did not inspect any access-log lines');
  for (const line of lines) {
    for (const field of Object.keys(line)) if (!allowed.has(field)) unexpected.add(field);
  }
  assert.deepEqual([...unexpected], [], `unexpected access-log fields: ${[...unexpected].join(', ')}`);
});

console.log(`\nvault-write-visibility: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
