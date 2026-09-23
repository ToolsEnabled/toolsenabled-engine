'use strict';

// Black-box contract tests for tools/check-owner-attribution.js. Keep these
// assertions at the process boundary: callers depend on its three documented
// exit codes, not on its internal implementation.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_GUARD = path.join(ROOT, 'tools', 'check-owner-attribution.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'check-owner-attribution-'));
const guard = path.join(sandbox, 'tools', 'check-owner-attribution.js');
const ledger = path.join(sandbox, 'reports', 'OWNER-REQUEST-LEDGER.json');
const exceptions = path.join(sandbox, 'config', 'owner-attribution-exceptions.json');

fs.mkdirSync(path.dirname(guard), { recursive: true });
fs.mkdirSync(path.dirname(ledger), { recursive: true });
fs.mkdirSync(path.dirname(exceptions), { recursive: true });
fs.copyFileSync(SOURCE_GUARD, guard);

function resetEvidence() {
  fs.writeFileSync(ledger, JSON.stringify({ requests: [
    { id: 'R1', provenance: 'OWNER-STATED', verbatim: 'A sufficiently long direct quotation.' },
  ] }));
  fs.writeFileSync(exceptions, JSON.stringify({ exceptions: [] }));
}

function fixture(name, value) {
  const file = path.join(sandbox, 'fixtures', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
  return file;
}

function run(...args) {
  const result = spawnSync(process.execPath, [guard, ...args], { encoding: 'utf8' });
  return {
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

let failures = 0;
function check(name, body) {
  resetEvidence();
  try {
    body();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${name}\n     ${error.stack || error}\n`);
  }
}

// One concrete value for every named refusal category. Removing any entry from
// CLAIM_PATTERNS makes its row turn green (exit 0) and this test turn red.
const refusalValues = [
  ['his own <thing>', 'The spending cap is his own limit.'],
  ['HIS setting/value/choice', 'This is HIS setting.'],
  ['the owner decided/chose/set', 'The owner chose the limit.'],
  ['he decided/chose/set', 'He selected the limit.'],
  ['per the owner', 'Per the owner, the limit applies.'],
  ['owner-ratified', 'This is an owner-ratified limit.'],
  ['you asked/wanted (second person to the owner)', 'You requested the limit.'],
  ['owner directive/instruction', 'This owner instruction establishes the limit.'],
];

for (const [claim, value] of refusalValues) {
  check(`exit 1 refuses unsourced ${claim}`, () => {
    const result = run(fixture(`${claim.replace(/[^a-z0-9]+/gi, '-')}.md`, `${value}\n`));
    assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /UNSOURCED ATTRIBUTION/);
    assert.match(result.stdout, new RegExp(`\\[${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  });
}

check('exit 0 accepts a clean file', () => {
  const result = run(fixture('clean.md', 'The product default is 100.\n'));
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Clean:/);
});

check('exit 0 accepts a refusal-shaped claim with verified evidence', () => {
  const result = run(fixture('cited.md', 'R1: The owner approved the documented value.\n'));
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
});

check('exit 2 refuses requested paths that do not exist', () => {
  const result = run(path.join(sandbox, 'absent'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /none of the requested paths exist/);
});

check('exit 2 refuses a directory containing zero scannable files', () => {
  const directory = path.join(sandbox, 'empty');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'ignored.bin'), 'not scanned');
  const result = run(directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /scanned 0 files/);
});

check('exit 2 refuses an unreadable owner-request ledger', () => {
  fs.writeFileSync(ledger, '{');
  const result = run(fixture('ledger-error.md', 'Neutral text.\n'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /owner request ledger exists but is unreadable/);
});

check('exit 2 refuses an unreadable exceptions file', () => {
  fs.writeFileSync(exceptions, '{');
  const result = run(fixture('exceptions-error.md', 'Neutral text.\n'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /attribution exceptions file exists but is unreadable/);
});

check('exit 2 refuses an exception without the owner quote', () => {
  fs.writeFileSync(exceptions, JSON.stringify({ exceptions: [{ id: 'approved-but-unsourced' }] }));
  const result = run(fixture('missing-quote.md', 'Neutral text.\n'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /has no "quote"/);
});

fs.rmSync(sandbox, { recursive: true, force: true });

if (failures) {
  process.stdout.write(`\n${failures} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nall ${refusalValues.length} refusal categories and exit codes 0, 1, and 2 are pinned\n`);
}
