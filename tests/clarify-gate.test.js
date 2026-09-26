// EXECUTABLE CHANGE — testcanfail-tests-clarify-gate-test-js
// Mutation report (2026-08-26):
// - Each of MUTATING_CALLS, READ_ONLY_CALLS, MALFORMED_RECORDS, and
//   MUTATION_CLASSIFIER_CASES was replaced with [] in a temporary mutation.
//   Before this change the suite stayed GREEN with respectively "0 absence red
//   cases", "0 read-only green controls", "0 malformed-record red cases", and
//   only 16 checks. After this change each cardinality assertion went RED with
//   "Expected values to be strictly equal: 0 !== 12" (then 10, 9, and 22).
// - SAME-CODE EXPECTATION: changing FALLBACK_SESSION_ID in a temporary product
//   mutation to "mutated-fallback" produced RED output beginning "The input did
//   not match the regular expression /unknown-session/". The unit expectations
//   now also use that independent literal rather than the exported product value.
// - RESTORE: tools/clarify-gate-hook.js was restored byte-for-byte; the final run
//   was GREEN: "clarify-gate tests passed (69 checks; 12 absence red cases first,
//   10 read-only green controls, 9 malformed-record red cases".
// Census: NOT-FOUND exit-status/truthy-only evidence (statuses are paired with
// subject stderr or decision-log evidence); NOT-FOUND swallowed test failure
// (the only catches are cleanup); NOT-FOUND mock of the subject; NOT-FOUND skip
// or platform precondition guard. Preconditions unmet: none.

'use strict';

// Contract tests for tools/clarify-gate-hook.js -- the configurable mechanical
// clarify-before-work gate.
//
// Same discipline as tests/standing-orders-hook-dirty-tree.test.js: every
// process-level assertion is checked by EXIT CODE read directly off
// spawnSync's own `status` field, never through a shell pipe (STANDING-
// ORDERS.md Class SYNC, rule 2), and every red case is paired with a
// same-shape green control in the same run so a harness that cannot tell
// them apart fails loudly here.
//
// THE ABSENCE CASE IS TESTED FIRST, deliberately: absence-as-consent is this
// codebase's recurring defect, and the whole point of this gate is that a
// missing record, a missing config, and a malformed record all REFUSE. The
// hook never executes the command under test -- it only reads the tool-call
// JSON from stdin and decides allow/block; the only real filesystem work in
// this suite happens inside its own throwaway scratch directory.
//
// Isolation: the hook's test-only overrides (NODE_ENV=test +
// CLARIFY_GATE_TEST_CONFIG_FILE / CLARIFY_GATE_TEST_STATE_DIR) must resolve
// inside <repo>/scratch, mirroring STANDING_ORDERS_HOOK_TEST_AUTH_DIR, so
// this suite never touches the real config/clarify-gate.json or the real
// state/clarify/ records of live sessions. The hook's log file is the real
// logs/clarify-gate-hook.log, exactly as the standing-orders suites append
// to the real hook log.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'tools', 'clarify-gate-hook.js');
const LOG_FILE = path.join(ROOT, 'logs', 'clarify-gate-hook.log');
const SCRATCH = path.join(ROOT, 'scratch', `clarify-gate-test-${process.pid}`);
const STATE_DIR = path.join(SCRATCH, 'state-clarify');
const CONFIG_FILE = path.join(SCRATCH, 'clarify-gate.json');
const ABSENT_CONFIG_FILE = path.join(SCRATCH, 'no-such-clarify-gate.json');
const SESSION = 'test-session-neutral';
const RECORD_FILE = path.join(STATE_DIR, `${SESSION}.json`);

const startedAt = Date.now();
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

fs.mkdirSync(STATE_DIR, { recursive: true });

function runHook(payload, envOverrides = {}) {
  return runRawHook(JSON.stringify(payload), envOverrides);
}

function runRawHook(input, envOverrides = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CLARIFY_GATE_TEST_CONFIG_FILE: CONFIG_FILE,
      CLARIFY_GATE_TEST_STATE_DIR: STATE_DIR,
      ...envOverrides
    }
  });
  assert.equal(result.error, undefined, `hook process failed to spawn: ${result.error}`);
  assert.equal(typeof result.status, 'number', 'spawnSync must report a real numeric exit code, never one read through a pipe');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

check('RED (indeterminate): malformed or incomplete stdin is refused, never collapsed into an allow', () => {
  for (const input of ['', '{not json', 'null', '{}', '{"tool_name":"Bash"}']) {
    const result = runRawHook(input);
    assert.equal(result.status, 2, `indeterminate input must refuse: ${JSON.stringify(input)}; stderr=${result.stderr}`);
    assert.match(result.stderr, /could not establish a safe decision/);
  }
});

check('RED (indeterminate): an internal evaluation failure is refused, never collapsed into an allow', () => {
  const result = runHook(bash('git commit -m "x"'), {
    CLARIFY_GATE_TEST_CONFIG_FILE: path.join(ROOT, 'outside-scratch.json')
  });
  assert.equal(result.status, 2, `evaluation failure must refuse: stderr=${result.stderr}`);
  assert.match(result.stderr, /could not establish a safe decision \(evaluate:/);
});

function toolCall(toolName, toolInput, sessionId = SESSION) {
  return { tool_name: toolName, tool_input: toolInput, cwd: ROOT, session_id: sessionId };
}

function bash(command) { return toolCall('Bash', { command }); }
function powershell(command) { return toolCall('PowerShell', { command }); }

function setConfig(value) {
  fs.writeFileSync(CONFIG_FILE, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
function clearConfig() {
  try { fs.rmSync(CONFIG_FILE, { force: true }); } catch { /* best effort */ }
}
function writeRecord(value) {
  fs.writeFileSync(RECORD_FILE, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
function clearRecord() {
  try { fs.rmSync(RECORD_FILE, { force: true }); } catch { /* best effort */ }
}
function readLogText() {
  return fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
}

const VALID_RECORD = {
  directiveQuoted: 'Confirm how ambiguous work should be interpreted before changing files.',
  interpretation: 'Build a mechanical PreToolUse gate that blocks mutating work until this session records its interpretation of the directive.',
  ambiguityCheck: 'no-ambiguity-stated'
};

const MUTATING_CALLS = [
  ['native Write', toolCall('Write', { file_path: path.join(ROOT, 'somewhere', 'out.txt'), content: 'x' })],
  ['native Edit', toolCall('Edit', { file_path: path.join(ROOT, 'tools', 'ledger-query.js'), old_string: 'a', new_string: 'b' })],
  ['native NotebookEdit', toolCall('NotebookEdit', { notebook_path: path.join(ROOT, 'nb.ipynb') })],
  ['git commit', bash('git commit -m "wip"')],
  ['git push', bash('git push origin main')],
  ['rm -rf', bash('rm -rf build')],
  ['del', powershell('del C:\\somewhere\\file.txt')],
  ['npm install', bash('npm install left-pad')],
  ['redirect write', bash('echo hello > out.txt')],
  ['append redirect', bash('node tools/ledger-query.js open >> reports/tmp.md')],
  ['Set-Content', powershell('Set-Content -Path notes.txt -Value "x"')],
  ['sed in place', bash('sed -i "s/a/b/" file.js')]
];
assert.equal(MUTATING_CALLS.length, 12, 'mutation coverage must not pass vacuously');

const READ_ONLY_CALLS = [
  ['ls', bash('ls -la')],
  ['cat', bash('cat README.md')],
  ['git status', bash('git status')],
  ['git log', bash('git log --oneline -5')],
  ['git diff', bash('git diff HEAD~1')],
  ['grep', bash('grep -n "clarify" tools/clarify-gate-hook.js')],
  ['node --version', bash('node --version')],
  ['redirect to /dev/null', bash('node tools/agent-preflight.js > /dev/null 2>&1')],
  ['powershell null redirect', powershell('git status 2>$null')],
  ['Get-Content', powershell('Get-Content logs/clarify-gate-hook.log -Tail 5')]
];
assert.equal(READ_ONLY_CALLS.length, 10, 'read-only coverage must not pass vacuously');

// ---------------------------------------------------------------------------
// 1. ABSENCE FIRST: no record, gate enabled => every mutating shape REFUSED.
// ---------------------------------------------------------------------------

setConfig({ enabled: true });
clearRecord();

for (const [label, payload] of MUTATING_CALLS) {
  check(`RED (absence): ${label} with NO interpretation record is REFUSED (exit 2)`, () => {
    const result = runHook(payload);
    assert.equal(result.status, 2, `${label} must be refused: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /CLARIFY-GATE:/);
    assert.match(result.stderr, /No interpretation record exists/);
    assert.match(result.stderr, /directiveQuoted/);
    assert.match(result.stderr, /ambiguityCheck/);
    assert.ok(result.stderr.includes(RECORD_FILE), 'the refusal must name the exact record path (the remedy must be concrete)');
  });
}

check('RED (absence): a payload with NO session_id at all is still refused, against the fallback record name', () => {
  const payload = { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, cwd: ROOT };
  const result = runHook(payload);
  assert.equal(result.status, 2, `missing session_id must not become consent: stderr=${result.stderr}`);
  assert.match(result.stderr, /unknown-session/);
});

// ---------------------------------------------------------------------------
// 2. GREEN CONTROL, same absent-record state: investigation always passes.
// ---------------------------------------------------------------------------

for (const [label, payload] of READ_ONLY_CALLS) {
  check(`GREEN (same absence): read-only ${label} passes (exit 0)`, () => {
    const result = runHook(payload);
    assert.equal(result.status, 0, `${label} must pass with no record: stderr=${result.stderr}`);
    assert.equal(result.stderr, '', 'a read-only allow must be silent to the model');
  });
}

check('GREEN: a non-gated tool (Read) passes untouched', () => {
  const result = runHook(toolCall('Read', { file_path: path.join(ROOT, 'README.md') }));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

// ---------------------------------------------------------------------------
// 3. THE REMEDY IS NEVER BLOCKED: writing the record itself passes the gate,
//    natively and via shell, while the record is still absent.
// ---------------------------------------------------------------------------

check('REMEDY: native Write of the interpretation record itself is allowed while no record exists', () => {
  clearRecord();
  const result = runHook(toolCall('Write', { file_path: RECORD_FILE, content: JSON.stringify(VALID_RECORD) }));
  assert.equal(result.status, 0, `the gate must not deadlock its own remedy: stderr=${result.stderr}`);
});

check('REMEDY: a shell command writing the interpretation record is allowed while no record exists', () => {
  clearRecord();
  const command = `Set-Content -Path "${RECORD_FILE}" -Value '{"directiveQuoted":"..."}'`;
  const result = runHook(powershell(command));
  assert.equal(result.status, 0, `shell remedy must pass: stderr=${result.stderr}`);
});

check('paired RED/GREEN: same Write tool, record path allowed, any other path refused, in one breath', () => {
  clearRecord();
  const green = runHook(toolCall('Write', { file_path: RECORD_FILE, content: '{}' }));
  const red = runHook(toolCall('Write', { file_path: path.join(ROOT, 'reports', 'out.md'), content: 'x' }));
  assert.equal(green.status, 0, `remedy write must pass: stderr=${green.stderr}`);
  assert.equal(red.status, 2, 'a non-remedy write in the same state must still be refused');
});

// ---------------------------------------------------------------------------
// 4. RECORD WRITTEN => allowed. Both ambiguityCheck values, proven.
// ---------------------------------------------------------------------------

check('GREEN: a valid "no-ambiguity-stated" record unlocks mutating work', () => {
  writeRecord(VALID_RECORD);
  for (const [label, payload] of MUTATING_CALLS) {
    const result = runHook(payload);
    assert.equal(result.status, 0, `${label} must be allowed with a valid record: stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
  }
});

check('GREEN: a valid "question-asked" record (with its question) unlocks mutating work', () => {
  writeRecord({
    directiveQuoted: 'make the dashboard better',
    interpretation: 'Improve the Requests tab layout only.',
    ambiguityCheck: 'question-asked',
    question: 'Do you mean visual layout, data freshness, or both?'
  });
  const result = runHook(bash('git commit -m "requests tab layout"'));
  assert.equal(result.status, 0, `question-asked record must unlock: stderr=${result.stderr}`);
});

// ---------------------------------------------------------------------------
// 5. MALFORMED / EMPTY RECORDS ARE INVALID => refused. Each red case names
//    the problem; the valid twin of each shape passed in section 4.
// ---------------------------------------------------------------------------

const MALFORMED_RECORDS = [
  ['empty file', ''],
  ['not JSON', 'this is not json'],
  ['JSON array', '[]'],
  ['empty object', '{}'],
  ['empty directiveQuoted', { directiveQuoted: '   ', interpretation: 'x', ambiguityCheck: 'no-ambiguity-stated' }],
  ['missing interpretation', { directiveQuoted: 'do the thing', ambiguityCheck: 'no-ambiguity-stated' }],
  ['bad ambiguityCheck value', { directiveQuoted: 'do the thing', interpretation: 'x', ambiguityCheck: 'probably-fine' }],
  ['question-asked without question', { directiveQuoted: 'do the thing', interpretation: 'x', ambiguityCheck: 'question-asked' }],
  ['question-asked with blank question', { directiveQuoted: 'do the thing', interpretation: 'x', ambiguityCheck: 'question-asked', question: '  ' }]
];
assert.equal(MALFORMED_RECORDS.length, 9, 'malformed-record coverage must not pass vacuously');

for (const [label, record] of MALFORMED_RECORDS) {
  check(`RED (malformed): ${label} => refused (exit 2), named as INVALID`, () => {
    writeRecord(record);
    const result = runHook(bash('git commit -m "x"'));
    assert.equal(result.status, 2, `${label} must not count as consent: stderr=${result.stderr}`);
    assert.match(result.stderr, /INVALID/);
    assert.match(result.stderr, /not consent/);
  });
}

// ---------------------------------------------------------------------------
// 6. CONFIG: absence of the file or the field = GATE ON. Disabled = allowed
//    but honestly logged as withheld, never silent.
// ---------------------------------------------------------------------------

check('RED: config file ABSENT => gate is ON, mutating call with no record refused', () => {
  clearRecord();
  const result = runHook(bash('git commit -m "x"'), { CLARIFY_GATE_TEST_CONFIG_FILE: ABSENT_CONFIG_FILE });
  assert.equal(result.status, 2, `config absence must mean gate ON: stderr=${result.stderr}`);
  assert.match(result.stderr, /CLARIFY-GATE:/);
});

check('RED: config present but MISSING the enabled field => gate ON', () => {
  clearRecord();
  setConfig({ _comment: 'no enabled field here' });
  const result = runHook(bash('rm -rf build'));
  assert.equal(result.status, 2, `missing enabled field must mean gate ON: stderr=${result.stderr}`);
});

check('RED: config with a NON-BOOLEAN enabled ("yes") => gate ON', () => {
  clearRecord();
  setConfig({ enabled: 'yes' });
  const result = runHook(bash('rm -rf build'));
  assert.equal(result.status, 2, 'a truthy-but-not-boolean enabled must not count');
});

check('RED: malformed config JSON => gate ON', () => {
  clearRecord();
  setConfig('{not json');
  const result = runHook(bash('git commit -m "x"'));
  assert.equal(result.status, 2, 'a malformed config must fail closed');
});

check('WITHHELD: enabled:false => the same refused call now passes, and the log says so', () => {
  clearRecord();
  // Direction 1: refused while enabled.
  setConfig({ enabled: true });
  const refused = runHook(bash('git commit -m "x"'));
  assert.equal(refused.status, 2, 'must be refused before the disabled direction is proven');

  // Direction 2: enabled:false lets it through, logged as withheld.
  setConfig({ enabled: false });
  const beforeLog = readLogText();
  const allowed = runHook(bash('git commit -m "x"'));
  assert.equal(allowed.status, 0, `enabled:false must allow: stderr=${allowed.stderr}`);
  assert.equal(allowed.stderr, '', 'a withheld allow must not also refuse');
  const appended = readLogText().slice(beforeLog.length);
  const loggedLine = appended.split('\n').find(line => line.includes('allow-withheld-disabled'));
  assert.ok(loggedLine, `disabled must be logged, never silent; appended tail was: ${appended}`);
  const parsed = JSON.parse(loggedLine);
  assert.equal(parsed.rule, 'CLARIFY-GATE');
  assert.equal(parsed.decision, 'allow-withheld-disabled');
  assert.match(parsed.note, /DISABLED by config/);
});

// ---------------------------------------------------------------------------
// 7. DECISION LOGGING: a refusal and an allow both append exactly one line.
// ---------------------------------------------------------------------------

check('LOG: a refusal appends one CLARIFY-GATE line with the block decision', () => {
  clearRecord();
  setConfig({ enabled: true });
  const beforeLog = readLogText();
  const result = runHook(bash('git commit -m "log-proof"'));
  assert.equal(result.status, 2);
  const appended = readLogText().slice(beforeLog.length).split('\n').filter(Boolean);
  const lines = appended.map(line => JSON.parse(line)).filter(entry => entry.rule === 'CLARIFY-GATE');
  assert.equal(lines.length, 1, `exactly one decision line per call; got: ${appended.join(' | ')}`);
  assert.equal(lines[0].decision, 'block-no-record');
  assert.equal(lines[0].sessionId, SESSION);
});

check('LOG: a valid-record allow appends one line too', () => {
  writeRecord(VALID_RECORD);
  const beforeLog = readLogText();
  const result = runHook(bash('git commit -m "log-proof-2"'));
  assert.equal(result.status, 0);
  const appended = readLogText().slice(beforeLog.length).split('\n').filter(Boolean);
  const lines = appended.map(line => JSON.parse(line)).filter(entry => entry.rule === 'CLARIFY-GATE');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'allow-valid-record');
});

// ---------------------------------------------------------------------------
// 8. Unit-level: exported matchers and validators, no subprocess needed.
// ---------------------------------------------------------------------------

const hook = require('../tools/clarify-gate-hook.js');

const MUTATION_CLASSIFIER_CASES = [
  ['git commit -m "x"', true],
  ['git push', true],
  ['git status', false],
  ['git log --oneline', false],
  ['git diff', false],
  ['rm -rf node_modules', true],
  ['mkdir new-dir', true],
  ['npm install left-pad', true],
  ['npm test', false],
  ['echo hi > file.txt', true],
  ['echo hi > /dev/null', false],
  ['node x.js 2>&1', false],
  ['node x.js 2>$null', false],
  ['Set-Content -Path a -Value b', true],
  ['Get-Content a', false],
  ['ls -la', false],
  ['cat README.md', false],
  ['node --version', false],
  ['grep -rn foo .', false],
  ['sed -i "s/a/b/" f.js', true],
  ['node tools/mcp-call.js --input x.json', false],
  ['', false]
];
assert.equal(MUTATION_CLASSIFIER_CASES.length, 22, 'classifier coverage must not pass vacuously');

for (const [command, expected] of MUTATION_CLASSIFIER_CASES) {
  check(`unit: classifyShellMutation(${JSON.stringify(command)}).mutating === ${expected}`, () => {
    assert.equal(hook.classifyShellMutation(command).mutating, expected, command);
  });
}

check('unit: validateRecordObject accepts the two valid shapes and rejects the empty object', () => {
  assert.equal(hook.validateRecordObject(VALID_RECORD).length, 0);
  assert.equal(hook.validateRecordObject({
    directiveQuoted: 'q', interpretation: 'i', ambiguityCheck: 'question-asked', question: 'which one?'
  }).length, 0);
  assert.ok(hook.validateRecordObject({}).length >= 3, 'an empty object must accumulate every missing-field problem');
  assert.ok(hook.validateRecordObject(null).length >= 1);
  assert.ok(hook.validateRecordObject([]).length >= 1);
});

check('unit: sessionIdFrom refuses a path-traversal session id', () => {
  assert.equal(hook.sessionIdFrom({ session_id: '../../etc/passwd' }), 'unknown-session');
  assert.equal(hook.sessionIdFrom({ session_id: 'ok-session-01' }), 'ok-session-01');
  assert.equal(hook.sessionIdFrom({}), 'unknown-session');
});

check('neutrality: numeric-looking session ids carry no authority or shared state', () => {
  setConfig({ enabled: true });
  const firstId = 'R700';
  const secondId = 'R701';
  const firstRecord = path.join(STATE_DIR, `${firstId}.json`);
  fs.writeFileSync(firstRecord, JSON.stringify(VALID_RECORD), 'utf8');
  const first = runHook(toolCall('Write', { file_path: path.join(ROOT, 'reports', 'first.md') }, firstId));
  const second = runHook(toolCall('Write', { file_path: path.join(ROOT, 'reports', 'second.md') }, secondId));
  assert.equal(first.status, 0, 'the session with current recorded state is allowed');
  assert.equal(second.status, 2, 'a different numeric-looking id has no inherited authority');
});

// --- cleanup: this suite's own scratch dir only. ---
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

const durationMs = Date.now() - startedAt;
console.log(`clarify-gate tests passed (${checks} checks; ${MUTATING_CALLS.length} absence red cases first, ${READ_ONLY_CALLS.length} read-only green controls, ${MALFORMED_RECORDS.length} malformed-record red cases, remedy proven unblocked both natively and via shell, config absence fail-closed, enabled:false proven withheld-and-logged) in ${durationMs}ms`);
