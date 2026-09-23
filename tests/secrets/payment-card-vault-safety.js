// EXECUTABLE CHANGE
'use strict';

// WHAT A STORED CARD IS ACTUALLY PROTECTED BY -- measured, not asserted in prose.
//
// The product offers the owner a place to put a real payment card
// (`payment_card_default`). Four promises are made about that record, in the
// capture dialog's own words and in the MCP tool descriptions: it is encrypted
// only in the local DPAPI vault, its details never return to an agent, MCP
// response, log or report, and reads of it are visible to the owner afterwards.
// This suite is the measurement of those four claims, and it is deliberately
// adversarial: several checks below exist because they FAILED when first
// written.
//
// THE VALUE USED HERE IS A PUBLISHED STRIPE TEST PAN (4242...) AND NOTHING
// ELSE. It is not a card, it authorises nothing, and it exists in this file so
// that the leak hunts below have a known needle to search for. No real card
// number, expiry or CVC may ever be written into this file, a fixture, a log,
// or a report -- if a check here ever needs a real one, the check is wrong.
//
// The vault under test is the ISOLATED scratch vault: tests/lib/isolated-
// environment points TOOLSENABLED_VAULT_PATH at a temp file and tools/
// secrets.ps1 reads that variable first. Nothing here touches, reads, decrypts
// or deletes the real vault.

require('../lib/isolated-environment').activate('payment-card-vault-safety');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SECRETS_SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'secrets.ps1');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;
const VAULT_DIR = path.dirname(VAULT_FILE);
const ACCESS_LOG = `${VAULT_FILE}.access.log`;
const CARD_KEY = 'payment_card_default';
const DECOY_KEY = 'not_a_denylisted_key';

// Published Stripe test PAN. See the header: this is the needle, not a card.
const TEST_PAN = '4242424242424242';
// A version 3 record shaped exactly like the one tools/secrets.ps1's payment-
// card dialog builds, so the leak hunts search for what the product really
// stores. There is no security-code field: the code is never asked for and
// never stored (owner ruling Q-O4; PCI DSS 3.2), and
// tests/secrets/payment-card-security-code-never-stored.js is the fence that
// keeps it out of the dialog, the payload and the vault.
const CARD_RECORD = JSON.stringify({
  version: 3,
  cardholder: { givenName: 'Test', familyName: 'Owner' },
  cardholderName: 'Test Owner',
  cardNumber: TEST_PAN,
  expMonth: 12,
  expYear: 2099,
  postalCode: 'SW1A 1AA'
});

// Every spelling of the needle that could survive a naive serialiser: grouped,
// hyphenated, and UTF-16LE (how .NET holds a string in memory and how a
// PowerShell process writes a Unicode file).
const NEEDLES = [
  { label: 'digits', bytes: Buffer.from(TEST_PAN, 'utf8') },
  { label: 'digits-utf16le', bytes: Buffer.from(TEST_PAN, 'utf16le') },
  { label: 'spaced', bytes: Buffer.from('4242 4242 4242 4242', 'utf8') },
  { label: 'hyphenated', bytes: Buffer.from('4242-4242-4242-4242', 'utf8') }
];

let passed = 0;
const failures = [];
const pendingChecks = [];
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

function asyncCheck(name, fn) {
  pendingChecks.push(async () => {
    const started = Date.now();
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name} (${Date.now() - started}ms)`);
    } catch (error) {
      failures.push({ name, error });
      console.log(`FAIL ${name}: ${error && error.message}`);
    }
  });
}

// Quiet-desktop rule (STANDING-ORDERS LOCAL-WORK rule 3): every powershell
// spawn here is windowsHide + shell:false, so no console ever flashes.
function vault(args, options = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SECRETS_SCRIPT, ...args
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
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

// Search a byte buffer for every spelling of the needle. Returns the labels
// that hit -- never the surrounding bytes, so a failure message can never
// become the leak it is reporting.
function needleHits(buffer) {
  return NEEDLES.filter(needle => buffer.includes(needle.bytes)).map(needle => needle.label);
}

function walkFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Setup: store the synthetic card record the way the product stores one.
// ---------------------------------------------------------------------------

const stored = vault(['set-stdin', CARD_KEY], { input: CARD_RECORD });
assert.equal(stored.status, 0, `setup: could not store the synthetic card record (${stored.stderr || stored.spawnError})`);
vault(['set-stdin', DECOY_KEY], { input: CARD_RECORD });

// ---------------------------------------------------------------------------
// 1. ENCRYPTED AT REST, AND NOT MERELY "IN A FILE AGENTS DO NOT READ".
// ---------------------------------------------------------------------------

check('vault file holds no plaintext PAN in any spelling', () => {
  const hits = needleHits(fs.readFileSync(VAULT_FILE));
  assert.deepEqual(hits, [], `plaintext PAN found in the vault file as: ${hits.join(', ')}`);
});

check('the stored record is a DPAPI blob, not an encoding of the plaintext', () => {
  const record = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'))[CARD_KEY];
  assert.equal(typeof record, 'string');
  // ConvertFrom-SecureString emits DPAPI ciphertext as an even-length hex
  // string. Base64 or the plaintext itself would both fail this.
  assert.match(record, /^[0-9a-fA-F]{256,}$/, 'stored record is not a DPAPI hex blob');
  assert.equal(record.length % 2, 0);
  // A hex-decoded blob must not contain the needle either -- that is what
  // catches "encrypted" implementations that merely hex-encode.
  const hits = needleHits(Buffer.from(record, 'hex'));
  assert.deepEqual(hits, [], `PAN recoverable from the stored blob as: ${hits.join(', ')}`);
});

check('nothing anywhere in the vault directory holds the PAN', () => {
  const offenders = [];
  for (const file of walkFiles(VAULT_DIR)) {
    const hits = needleHits(fs.readFileSync(file));
    if (hits.length) offenders.push(`${path.basename(file)}:${hits.join('+')}`);
  }
  assert.deepEqual(offenders, [], `plaintext PAN on disk in: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 2. THE DENYLIST: the record is never RETURNED, and the refusal is logged.
// ---------------------------------------------------------------------------

check('generic get refuses the card key', () => {
  truncateAccessLog();
  const result = vault(['get', CARD_KEY]);
  assert.notEqual(result.status, 0, 'get returned the card record');
  assert.equal(result.stdout, '', 'get wrote something to stdout for a denylisted key');
  assert.match(result.stderr, /ACCESS_DENIED_ORACLE_SCOPE/);
});

check('the refusal message itself carries no PAN', () => {
  const result = vault(['get', CARD_KEY]);
  const hits = needleHits(Buffer.from(result.stdout + result.stderr, 'utf8'));
  assert.deepEqual(hits, [], `refusal output leaked the PAN as: ${hits.join(', ')}`);
});

check('the denied read is access-logged', () => {
  truncateAccessLog();
  vault(['get', CARD_KEY]);
  const entries = accessLogLines();
  const denial = entries.find(entry => entry.action === 'get' && entry.key === CARD_KEY && entry.denied === true);
  assert.ok(denial, 'no denied-get line in the access log');
  assert.ok(Number.isInteger(denial.pid) && typeof denial.ts === 'string');
});

check('list does not even enumerate the card key', () => {
  const result = vault(['list']);
  assert.equal(result.status, 0);
  const keys = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.ok(!keys.includes(CARD_KEY), 'list enumerated the denylisted card key');
  assert.ok(keys.includes(DECOY_KEY), 'list is broken: it omitted a non-denylisted key too');
});

check('the whole access log never contains the PAN', () => {
  const hits = needleHits(fs.readFileSync(ACCESS_LOG));
  assert.deepEqual(hits, [], `access log leaked the PAN as: ${hits.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 3. TRYING TO MAKE IT LEAK THROUGH A DIAGNOSTIC OR A CRASH.
// ---------------------------------------------------------------------------

check('a corrupted record cannot leak the plaintext through a decrypt error', () => {
  // Decrypt failure is the classic disclosure seam: the error record for a
  // failed unprotect can carry the argument it failed on. Corrupt the DECOY
  // (get on the card key is denied before it decrypts, so the card key cannot
  // reach this path at all) and read the resulting diagnostic.
  const data = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  const original = data[DECOY_KEY];
  data[DECOY_KEY] = original.slice(0, -8) + 'deadbeef';
  fs.writeFileSync(VAULT_FILE, `${JSON.stringify(data, null, 2)}\n`);
  try {
    const result = vault(['get', DECOY_KEY]);
    assert.notEqual(result.status, 0, 'a corrupted record decrypted successfully');
    const hits = needleHits(Buffer.from(result.stdout + result.stderr, 'utf8'));
    assert.deepEqual(hits, [], `decrypt-failure diagnostic leaked the PAN as: ${hits.join(', ')}`);
  } finally {
    data[DECOY_KEY] = original;
    fs.writeFileSync(VAULT_FILE, `${JSON.stringify(data, null, 2)}\n`);
  }
});

check('a malformed vault cannot leak record bytes through a parse error', () => {
  const original = fs.readFileSync(VAULT_FILE, 'utf8');
  fs.writeFileSync(VAULT_FILE, `${original.trimEnd()}{{ not json`);
  try {
    const result = vault(['present', CARD_KEY]);
    // Unreadable is the only honest answer, and it must not be "absent".
    assert.equal(result.status, 4, `a malformed vault answered ${result.status}, not UNREADABLE(4)`);
    const hits = needleHits(Buffer.from(result.stdout + result.stderr, 'utf8'));
    assert.deepEqual(hits, [], `parse-error diagnostic leaked the PAN as: ${hits.join(', ')}`);
  } finally {
    fs.writeFileSync(VAULT_FILE, original);
  }
});

check('the capture refusal for an unsupported key carries no card material', () => {
  const runtime = require('../../src/lib/runtime');
  assert.throws(() => runtime.capturePaymentCard('payment_card_other'), error => {
    assert.equal(error.code, 'PAYMENT_METHOD_CAPTURE_UNSUPPORTED');
    const hits = needleHits(Buffer.from(`${error.message}${error.stack || ''}`, 'utf8'));
    assert.deepEqual(hits, [], 'a refusal message carried the PAN');
    return true;
  });
});

// ---------------------------------------------------------------------------
// 4. EVERY READ OF THE RECORD IS VISIBLE TO THE OWNER AFTERWARDS.
//
// This is the promise that was NOT being kept when this suite was written.
// `present` and `get` log. `exists` answered the same presence question for the
// same denylisted key and logged nothing, and `verify` actually DECRYPTED the
// card record -- proving to a caller that this desktop's DPAPI can open it --
// and logged nothing either. Both are same-user reachable, which is exactly the
// case the access log exists for: same-user access cannot be prevented, so it
// is made visible instead. Silence is the defect.
// ---------------------------------------------------------------------------

check('present is access-logged with the answer it gave', () => {
  truncateAccessLog();
  const result = vault(['present', CARD_KEY]);
  assert.equal(result.status, 0);
  const entry = accessLogLines().find(line => line.action === 'present' && line.key === CARD_KEY);
  assert.ok(entry, 'no present line in the access log');
  assert.equal(entry.present, true);
});

check('exists is access-logged for a denylisted key', () => {
  truncateAccessLog();
  const result = vault(['exists', CARD_KEY]);
  assert.equal(result.status, 0, 'exists did not find the planted record');
  const entry = accessLogLines().find(line => line.action === 'exists' && line.key === CARD_KEY);
  assert.ok(entry, 'exists answered the presence question for the card key and logged nothing');
  assert.equal(entry.present, true);
});

check('verify is access-logged: decrypting the card record is a read', () => {
  truncateAccessLog();
  const result = vault(['verify', CARD_KEY]);
  assert.equal(result.status, 0, 'verify could not decrypt the planted record');
  const entry = accessLogLines().find(line => line.action === 'verify' && line.key === CARD_KEY);
  assert.ok(entry, 'verify decrypted the card record and logged nothing');
});

check('verify emits no plaintext, length, or ciphertext', () => {
  const result = vault(['verify', CARD_KEY]);
  assert.equal(result.stdout, '', 'verify wrote to stdout');
  const hits = needleHits(Buffer.from(result.stdout + result.stderr, 'utf8'));
  assert.deepEqual(hits, [], `verify leaked the PAN as: ${hits.join(', ')}`);
});

check('deleting the card record is access-logged', () => {
  truncateAccessLog();
  const result = vault(['del', CARD_KEY]);
  assert.equal(result.status, 0);
  const entry = accessLogLines().find(line => line.action === 'del' && line.key === CARD_KEY);
  assert.ok(entry, 'the card record was deleted with no access-log line');
  const hits = needleHits(Buffer.from(result.stdout + result.stderr, 'utf8'));
  assert.deepEqual(hits, [], 'the delete confirmation leaked the PAN');
});

check('after deletion presence is a definite absent, not unknown', () => {
  const result = vault(['present', CARD_KEY]);
  assert.equal(result.status, 3, `expected ABSENT(3), got ${result.status}`);
});

// ---------------------------------------------------------------------------
// 5. THE AUDIT LEDGER NEVER SEES CARD MATERIAL.
// ---------------------------------------------------------------------------

asyncCheck('the isolated audit trail holds no PAN after a card-status call', async () => {
  const { executeTool, getTool } = require('../../src/lib/tool-registry');
  const statusTool = getTool('payment_method.card_status');
  assert.ok(statusTool, 'payment_method.card_status is not registered');

  // Materialise every configured sink before the call.  The emergency sink is
  // normally absent and, when no earlier audited call has run, the ordinary
  // sinks can be absent too.  Filtering on existsSync after the call therefore
  // allowed this check's loop to execute zero times.  Opening in append mode
  // preserves any audit evidence already written by the preceding checks.
  const auditPaths = [
    process.env.TOOLSENABLED_AUDIT_JSONL_PATH,
    process.env.TOOLSENABLED_AUDIT_TEXT_PATH,
    process.env.TOOLSENABLED_AUDIT_EMERGENCY_PATH
  ];
  for (const auditPath of auditPaths) {
    assert.equal(typeof auditPath, 'string', 'an isolated audit sink path is not configured');
    fs.closeSync(fs.openSync(auditPath, 'a'));
  }

  const answer = await executeTool('payment_method.card_status', {}, {
    permissionSession: { origin: 'local', tier: 'full' }
  });
  assert.equal(answer.exposed, false);
  assert.ok(!('value' in answer) && !('record' in answer) && !('cardNumber' in answer));
  const serialised = Buffer.from(JSON.stringify(answer), 'utf8');
  assert.deepEqual(needleHits(serialised), [], 'card_status result carried card material');

  // Dispatch reconciles an empty emergency spool into the canonical ledger and
  // removes it. Re-materialise it so all three unchanged leak assertions read
  // a sink; append mode preserves any evidence that remains after dispatch.
  for (const auditPath of auditPaths) fs.closeSync(fs.openSync(auditPath, 'a'));

  for (const auditPath of auditPaths) {
    const hits = needleHits(fs.readFileSync(auditPath));
    assert.deepEqual(hits, [], `audit sink ${path.basename(auditPath)} leaked the PAN as: ${hits.join(', ')}`);
  }
});

check('no tool in the registry can return the card record', () => {
  const { TOOL_REGISTRY } = require('../../src/lib/tool-registry');
  const cardTools = TOOL_REGISTRY.filter(tool => /payment_method\./.test(tool.name));
  assert.ok(cardTools.length >= 2, 'expected the register and status tools');
  for (const tool of cardTools) {
    assert.ok(!/card_(get|read|reveal|value)/.test(tool.name), `a card-returning tool exists: ${tool.name}`);
  }
});

// ---------------------------------------------------------------------------
// 6. THE WINDOW THE OWNER ACTUALLY READS BEFORE HE TYPES A CARD NUMBER.
//
// Two disclosures have to be ON THE WINDOW, not in a doc: who can decrypt the
// record afterwards, and the fact that nothing in the product reads it yet. A
// promise the owner cannot see is not a promise, and a promise that is painted
// off the bottom edge of a fixed-size dialog is worse -- this file's own
// comments record a previous DPI regression that cut the Save button's label to
// "Save payment m". So the copy is measured at the real font and width, and the
// declared label heights must actually hold it.
//
// tools/secrets.ps1 defines Invoke-PaymentCardPrompt TWICE. PowerShell keeps
// the LAST definition (verified: `function F {'FIRST'}; function F {'SECOND'}; F`
// prints SECOND), so the earlier one is dead and these checks deliberately read
// the last block only -- asserting against the dead copy would prove nothing
// about the window the owner sees.
// ---------------------------------------------------------------------------

const SECRETS_SOURCE = fs.readFileSync(SECRETS_SCRIPT, 'utf8');
const CARD_PROMPT_DEFINITIONS = SECRETS_SOURCE.split(/^function Invoke-PaymentCardPrompt\b/m);
// [0] is everything before the first definition; the live one is the last slice.
const LIVE_CARD_PROMPT = CARD_PROMPT_DEFINITIONS[CARD_PROMPT_DEFINITIONS.length - 1];

function declared(pattern) {
  const match = LIVE_CARD_PROMPT.match(pattern);
  assert.ok(match, `the live card dialog no longer declares ${pattern}`);
  return match;
}

// Measure a string the way Windows will lay it out, off-screen, in one hidden
// process. No window is created and nothing is shown.
function measuredHeights(strings) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$f = New-Object System.Drawing.Font('Segoe UI', 9.75)",
    '$flags = [System.Windows.Forms.TextFormatFlags]::WordBreak',
    '$out = @()',
    "foreach ($name in ($env:M_NAMES -split '\\|')) {",
    '  $text = [Environment]::GetEnvironmentVariable("M_TEXT_$name")',
    '  $size = [System.Windows.Forms.TextRenderer]::MeasureText($text, $f, (New-Object System.Drawing.Size(572, 4000)), $flags)',
    '  $out += ("{0}={1}" -f $name, $size.Height)',
    '}',
    "Write-Output ($out -join ';')"
  ].join('\n');
  const env = { ...process.env, M_NAMES: Object.keys(strings).join('|'), ELECTRON_RUN_AS_NODE: undefined };
  for (const [name, text] of Object.entries(strings)) env[`M_TEXT_${name}`] = text;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, shell: false, env });
  const parsed = {};
  for (const pair of (result.stdout || '').trim().split(';')) {
    const [name, height] = pair.split('=');
    if (name) parsed[name] = Number(height);
  }
  return parsed;
}

check('the live card dialog names who can decrypt the record', () => {
  const text = declared(/\$description\.Text = "([^"]+)"/)[1];
  assert.match(text, /Windows DPAPI/, 'the dialog no longer says how the record is sealed');
  assert.match(text, /stored only in the local vault file on this computer/, 'the dialog no longer says where the record lives');
  assert.match(text, /Any program running under your Windows sign-in can ask Windows to open it/,
    'the dialog does not tell the owner who can decrypt his card');
  assert.match(text, /never returned to an agent, an MCP response, a log or a report/);
});

check('the live card dialog says nothing reads the record yet', () => {
  const text = declared(/\$note\.Text = '([^']+)'/)[1];
  assert.match(text, /Nothing in ToolsEnabled reads this record yet/,
    'the dialog collects a card number while implying a purchase will follow');
  assert.match(text, /does not enable a purchase on its own/);
});

check('both disclosures fit the labels that hold them', () => {
  // The description interpolates $DisplayName and one of two pre-fill
  // sentences; measure the LONGER pre-fill branch with a realistic label.
  const rawDescription = declared(/\$description\.Text = "([^"]+)"/)[1];
  const prefill = ' No private identity profile is stored yet, so enter the name exactly as it appears on the card.';
  const description = rawDescription
    .replace('$DisplayName', 'default payment card')
    .replace('$prefillSentence', prefill);
  const note = declared(/\$note\.Text = '([^']+)'/)[1];
  const descriptionHeight = Number(declared(/\$description\.Size = New-Object System\.Drawing\.Size 572, (\d+)/)[1]);
  const noteHeight = Number(declared(/\$note\.Size = New-Object System\.Drawing\.Size 572, (\d+)/)[1]);

  const measured = measuredHeights({ description, note });
  assert.ok(Number.isFinite(measured.description) && measured.description > 0, 'description could not be measured');
  assert.ok(Number.isFinite(measured.note) && measured.note > 0, 'note could not be measured');
  assert.ok(descriptionHeight >= measured.description,
    `description label is ${descriptionHeight}px but the copy needs ${measured.description}px -- it would be clipped`);
  assert.ok(noteHeight >= measured.note,
    `note label is ${noteHeight}px but the copy needs ${measured.note}px -- it would be clipped`);
});

check('no control in the card dialog falls off the bottom of the window', () => {
  const clientHeight = Number(declared(/\$form\.ClientSize = New-Object System\.Drawing\.Size 620, (\d+)/)[1]);
  const bottoms = [];
  // Explicit Location/Size pairs.
  const locationRe = /\$(\w+)\.Location = New-Object System\.Drawing\.Point \d+, (\d+)/g;
  const sizes = new Map();
  const sizeRe = /\$(\w+)\.Size = New-Object System\.Drawing\.Size \d+, (\d+)/g;
  let match;
  while ((match = sizeRe.exec(LIVE_CARD_PROMPT)) !== null) sizes.set(match[1], Number(match[2]));
  while ((match = locationRe.exec(LIVE_CARD_PROMPT)) !== null) {
    if (match[1] === 'header' || match[1] === 'rule') continue; // header-relative children
    bottoms.push({ name: match[1], bottom: Number(match[2]) + (sizes.get(match[1]) || 34) });
  }
  // Field rows: `& $field 'Label' X Y W $masked` places a label at Y and a
  // 23px-tall text box at Y+21.
  const fieldRe = /& \$field '[^']+' \d+ (\d+) \d+ \$(?:true|false)/g;
  while ((match = fieldRe.exec(LIVE_CARD_PROMPT)) !== null) {
    bottoms.push({ name: 'field-row', bottom: Number(match[1]) + 21 + 23 });
  }
  assert.ok(bottoms.length >= 8, `only found ${bottoms.length} controls; the layout scrape is broken`);
  const overflow = bottoms.filter(entry => entry.bottom > clientHeight);
  assert.deepEqual(overflow.map(entry => `${entry.name}@${entry.bottom}`), [],
    `controls fall outside the ${clientHeight}px window`);
});

// ---------------------------------------------------------------------------

(async () => {
  for (const pendingCheck of pendingChecks) await pendingCheck();
  console.log(`\npayment-card vault safety: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.message}`);
    process.exitCode = 1;
  }
})();
