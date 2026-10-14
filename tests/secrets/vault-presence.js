// NOTHING FOUND — test-can-fail audit, 2026-08-26.
//
// Mutation evidence:
// - Removing `payment_card_default` from `$VaultOracleDenylist` made B1 RED:
//   "FAIL B1 ...: the payment card must stay on the denylist".
// The product mutation was restored byte-for-byte before this report was
// committed (`git diff -- tools/secrets.ps1 src/lib/vault-presence.js` is empty).
//
// Shape census:
// - EMPTY ITERATION: NOT-FOUND. Array-derived assertions either assert a found
//   item first (B1/A5) or contain direct membership assertions outside a loop
//   (B3); there is no assertion-bearing loop/forEach.
// - EXIT STATUS / TRUTHY RETURN WITHOUT OWN OUTPUT: NOT-FOUND. Exact status
//   assertions cover the `present` protocol. B2's non-zero assertion is not its
//   discriminator: the required `ACCESS_DENIED_ORACLE_SCOPE` stderr is asserted
//   separately, alongside the no-secret-output assertion.
// - SWALLOWED FAILURE: NOT-FOUND. `check` records caught failures and sets a
//   failing process exit code; `runSecrets` preserves status/stdout/stderr for
//   assertions. There is no optional-chain assertion path.
// - MOCK OF SUBJECT: NOT-FOUND. The suite invokes the real script, presence
//   module, and registry handler against an isolated on-disk vault.
// - SILENT SKIP / PRECONDITION GUARD: NOT-FOUND. There are no skips or platform
//   guards; missing prerequisites fail assertions rather than making a no-op.
// - SAME-CODE EXPECTED VALUE: NOT-FOUND. Expectations are literal protocol
//   values, independently planted vault fixtures, and explicit key names.
//
// Unmet preconditions in this audit container: `powershell.exe` is absent and
// the host is not Windows, so script status assertions and Windows-only module
// paths cannot be mutation-probed here. The full restored run is RED (13
// failures). Node.js v24 was selected so `node:sqlite` itself was available.
// The observed restored-run footer was:
// "vault-presence: 3 passed, 13 failed".

'use strict';

// PRESENCE WITHOUT DISCLOSURE, and the third answer nobody remembers to keep.
//
// What is under test is the seam that made the product lie about the owner's
// money. `payment_method.card_status` answered `present: false` while a
// 1260-byte `payment_card_default` record sat in the vault, because it asked
// `secretExists()`, which answers by FETCHING -- and that key is on
// tools/secrets.ps1's $VaultOracleDenylist precisely so the fetch is refused.
// A refusal caught by `catch { return false }` reads exactly like "no card".
//
// So this suite pins three things at once, and they pull against each other:
//   1. the denylist still refuses to RETURN either protected record (the
//      shipped promise the capture dialogs make is about content, and weakening
//      it would be the wrong fix for this bug);
//   2. the new `present` action answers the presence question anyway, without
//      reading content, and writes an access-log line while doing it;
//   3. an UNREADABLE vault is neither true nor false. This is the one a
//      refactor deletes: `present === false` is such a natural default that the
//      "could not tell" branch collapses into it silently, and the owner's
//      screen then says "no card on file" because of a permissions error.
//
// The vault exercised here is the ISOLATED one -- tests/lib/isolated-environment
// points TOOLSENABLED_VAULT_PATH at a scratch file, and tools/secrets.ps1 reads
// that variable first. Nothing in this file touches the real vault, decrypts
// anything, or holds a card value; the "records" planted below are the string
// 'synthetic-not-a-card'.

require('../lib/isolated-environment').activate('vault-presence');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { executeTool } = require('../../src/lib/tool-registry');

const presenceModulePath = require.resolve('../../src/lib/vault-presence');
const CARD_KEY = 'payment_card_default';
const IDENTITY_KEY = 'owner_legal_identity_v1';
const SECRETS_SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'secrets.ps1');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;
const ACCESS_LOG = `${VAULT_FILE}.access.log`;

let passed = 0;
const failures = [];
const queuedChecks = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

function queueCheck(name, fn) {
  queuedChecks.push({ name, fn });
}

async function runQueuedChecks() {
  for (const { name, fn } of queuedChecks) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.log(`FAIL ${name}: ${error && error.message}`);
    }
  }
}

function freshPresence() {
  delete require.cache[presenceModulePath];
  return require('../../src/lib/vault-presence');
}

function writeVault(contents) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  fs.writeFileSync(VAULT_FILE, contents, 'utf8');
}

function removeVault() {
  fs.rmSync(VAULT_FILE, { force: true });
}

function runSecrets(action, key) {
  try {
    const stdout = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SECRETS_SCRIPT, action, key
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    return { status: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (error) {
    return {
      status: Number.isInteger(error.status) ? error.status : null,
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : ''
    };
  }
}

// ---------------------------------------------------------------------------
// SECTION A  The PowerShell verb itself, run for real against a scratch vault.
// ---------------------------------------------------------------------------

check('A1 a planted record answers PRESENT (exit 0) and prints nothing', () => {
  writeVault(JSON.stringify({ [CARD_KEY]: 'synthetic-not-a-card' }));
  const result = runSecrets('present', CARD_KEY);
  assert.equal(result.status, 0, 'a record that is on file must exit 0');
  assert.equal(result.stdout.trim(), '', 'the presence verb must print nothing at all');
});

// THE MUTATION PROOF the handoff asks for first: prove the absence case before
// believing the presence case. A verb that always answered "present" would pass
// A1 and fail here.
check('A2 with the record REMOVED the same verb answers ABSENT (exit 3)', () => {
  writeVault(JSON.stringify({ unrelated_probe_key: 'synthetic' }));
  const result = runSecrets('present', CARD_KEY);
  assert.equal(result.status, 3, 'a vault read with no such record must exit 3, not 0');
  assert.equal(result.stdout.trim(), '', 'the presence verb must print nothing at all');
});

check('A3 a vault that EXISTS and cannot be parsed is UNREADABLE (exit 4), not absent', () => {
  writeVault('{ this is not json');
  const result = runSecrets('present', CARD_KEY);
  assert.equal(result.status, 4, 'an unreadable vault must not answer with the absent code');
  assert.notEqual(result.status, 3, 'an unreadable vault reported as absent renders as "no card on file"');
});

check('A4 no vault store at all is its own code (exit 5)', () => {
  removeVault();
  const result = runSecrets('present', CARD_KEY);
  assert.equal(result.status, 5, 'a computer with no vault must be distinguishable from a vault with no record');
});

check('A5 the presence verb writes an access-log line and it carries no value', () => {
  fs.rmSync(ACCESS_LOG, { force: true });
  writeVault(JSON.stringify({ [CARD_KEY]: 'synthetic-not-a-card' }));
  runSecrets('present', CARD_KEY);
  assert.ok(fs.existsSync(ACCESS_LOG), 'the presence question must not be silent');
  const lines = fs.readFileSync(ACCESS_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.action, 'present');
  assert.equal(entry.key, CARD_KEY);
  assert.equal(entry.present, true, 'the log records what the caller was told, not only that it asked');
  assert.ok(!('value' in entry), 'the access log must never carry a vault value');
  assert.ok(!fs.readFileSync(ACCESS_LOG, 'utf8').includes('synthetic-not-a-card'), 'the record itself must not reach the log');
});

// ---------------------------------------------------------------------------
// SECTION B  The denylist is NOT the thing that got weakened.
// ---------------------------------------------------------------------------

check('B1 the two protected keys are still on the oracle denylist', () => {
  const source = fs.readFileSync(SECRETS_SCRIPT, 'utf8');
  const line = source.split(/\r?\n/).find(text => text.includes('$VaultOracleDenylist = @('));
  assert.ok(line, 'the denylist declaration must still exist');
  assert.ok(line.includes(`'${CARD_KEY}'`), 'the payment card must stay on the denylist');
  assert.ok(line.includes(`'${IDENTITY_KEY}'`), 'the legal identity record must stay on the denylist');
});

check('B2 a planted card record is STILL refused by the generic get', () => {
  writeVault(JSON.stringify({ [CARD_KEY]: 'synthetic-not-a-card' }));
  const result = runSecrets('get', CARD_KEY);
  assert.notEqual(result.status, 0, 'get must still refuse the protected record');
  assert.ok(!result.stdout.includes('synthetic-not-a-card'), 'get must not return the record');
  assert.ok(/ACCESS_DENIED_ORACLE_SCOPE/.test(result.stderr), 'the refusal must still be the oracle-scope refusal');
});

check('B3 a planted card record is STILL omitted from list', () => {
  writeVault(JSON.stringify({ [CARD_KEY]: 'synthetic-not-a-card', unrelated_probe_key: 'synthetic' }));
  const result = runSecrets('list', 'unused');
  assert.equal(result.status, 0);
  const keys = result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  assert.ok(keys.includes('unrelated_probe_key'), 'ordinary keys still enumerate');
  assert.ok(!keys.includes(CARD_KEY), 'the protected record must stay out of enumeration');
});

// ---------------------------------------------------------------------------
// SECTION C  The JavaScript mapping. Exit codes in, a tri-state out.
// ---------------------------------------------------------------------------

check('C1 the module reports a real planted record as present', () => {
  writeVault(JSON.stringify({ [CARD_KEY]: 'synthetic-not-a-card' }));
  const answer = freshPresence().vaultRecordPresence(CARD_KEY);
  assert.equal(answer.present, true);
  assert.equal(answer.readable, true);
  assert.ok(!JSON.stringify(answer).includes('synthetic-not-a-card'), 'nothing about the record may cross this boundary');
});

check('C2 the module reports a removed record as absent', () => {
  writeVault(JSON.stringify({ unrelated_probe_key: 'synthetic' }));
  const answer = freshPresence().vaultRecordPresence(CARD_KEY);
  assert.equal(answer.present, false);
  assert.equal(answer.readable, true);
});

// The branch a refactor deletes. `present` must be null -- not false -- so that
// every caller has to decide what to say instead of defaulting to "no card".
check('C3 an unreadable vault is present:null and readable:false, never present:false', () => {
  writeVault('{ this is not json');
  const answer = freshPresence().vaultRecordPresence(CARD_KEY);
  assert.equal(answer.readable, false, 'the caller must be told the vault could not be read');
  assert.equal(answer.present, null, 'an unreadable vault must not answer the presence question at all');
  assert.notEqual(answer.present, false, 'present:false here is the product claiming he has no card because of a read error');
});

check('C4 an unstartable check is unreadable, not absent', () => {
  const presence = freshPresence();
  const answer = presence.vaultRecordPresence('not a valid key!!');
  assert.equal(answer.readable, false);
  assert.equal(answer.present, null);
});

check('C5 no vault store answers absent, and says which kind of absent', () => {
  removeVault();
  const answer = freshPresence().vaultRecordPresence(CARD_KEY);
  assert.equal(answer.present, false);
  assert.equal(answer.readable, true);
  assert.equal(answer.code, 'VAULT_STORE_ABSENT');
});

// ---------------------------------------------------------------------------
// SECTION D  The tool the owner actually reads.
// ---------------------------------------------------------------------------

// The definition is read once. Its handler asks the vault on every call, so
// re-reading the registry between scenarios would only re-pay the module load
// and would prove nothing extra.
function cardStatusDefinition() {
  const { TOOL_REGISTRY } = require('../../src/lib/tool-registry');
  assert.ok(Array.isArray(TOOL_REGISTRY), 'the tool registry must expose its definitions as a list');
  const definition = TOOL_REGISTRY.find(entry => entry && entry.name === 'payment_method.card_status');
  assert.ok(definition, 'payment_method.card_status must still exist');
  return definition;
}

queueCheck('D1 card_status reports a planted record as present', async () => {
  writeVault(JSON.stringify({ [CARD_KEY]: 'synthetic-not-a-card' }));
  cardStatusDefinition();
  const result = await executeTool('payment_method.card_status', {}, {
    permissionSession: { origin: 'local', tier: 'full' }
  });
  assert.equal(result.present, true, 'the tool must see a record the vault holds');
  assert.equal(result.checked, true);
  assert.equal(result.exposed, false);
  assert.ok(!JSON.stringify(result).includes('synthetic-not-a-card'), 'the tool must never carry the record');
});

queueCheck('D2 card_status reports a removed record as absent', async () => {
  writeVault(JSON.stringify({ unrelated_probe_key: 'synthetic' }));
  cardStatusDefinition();
  const result = await executeTool('payment_method.card_status', {}, {
    permissionSession: { origin: 'local', tier: 'full' }
  });
  assert.equal(result.present, false);
  assert.equal(result.checked, true);
});

queueCheck('D3 card_status never renders an unreadable vault as "no card on file"', async () => {
  writeVault('{ this is not json');
  cardStatusDefinition();
  const result = await executeTool('payment_method.card_status', {}, {
    permissionSession: { origin: 'local', tier: 'full' }
  });
  assert.equal(result.checked, false, 'the tool must say it could not check');
  assert.notEqual(result.present, false, 'an unreadable vault must not read as "no card"');
  assert.equal(result.present, null);
  assert.equal(result.status, 'VAULT_UNREADABLE');
});

void (async () => {
  await runQueuedChecks();

  removeVault();
  fs.rmSync(ACCESS_LOG, { force: true });

  console.log(`\nvault-presence: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.stack}`);
    process.exitCode = 1;
  }
})();
